process.env.MARVIS_WS_MODE ||= "off"
// tests/refresh-proactive.test.mjs —— 主动续期（C 类）的契约与回归锁
//
// 目标：把续期从「等 401 再补」变成「提前续」，终结微信「每 2 小时必挂一次」。
// 口径（用户要求）：**30 天自动续期** —— 距到期 30 天内（默认 lead）就续，保持常新；
// 实际续期频率由节流阀（默认 1 小时/账号）决定，与 leadMs 无关。
//
// 这里锁四件事：
//   ① needsProactiveRefresh 的判据 —— 有 refresh token + 知道过期时间 + 剩余 < leadMs；
//      leadMs 默认 MARVIS_REFRESH_LEAD_MS（默认 30 天）；「不知道过期时间」(null) 必须
//      判 false，绝不能被当成「没过期」或「永远该刷」。
//   ② proactiveRefresh 的返回形状 —— 不触发 → null；成功 → { refreshed:true, auth:合并后新 auth }；
//      失败 → { refreshed:false, reason:"throttled"|"fatal"|"error" }，**绝不向宿主传播异常**。
//   ③ msUntilExpiry 对缺失/畸形 expires 的归一 —— 解析不了 → null。
//   ④ 节流 —— 同账号最小间隔（默认 1 小时，MARVIS_REFRESH_MIN_INTERVAL_MS=0 关闭），
//      防超短 TTL 刷新风暴；不同账号互不挡。
//
// 全部离线：needs/proactive 路径注入假 refreshFn，不联网、不需要凭据。

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { msUntilExpiry, WX_TTL_MS, DEFAULT_TTL_MS } from "../src/marvis/expiry.mjs"
import {
  needsProactiveRefresh,
  proactiveRefresh,
  resetProactiveThrottle,
  DEFAULT_LEAD_MS,
  DEFAULT_MIN_INTERVAL_MS,
} from "../src/hooks/proactive-refresh.mjs"

// 节流表是进程级单例 —— 用例之间必须重置，否则前一个用例记下的「上次续期时刻」
// 会让后一个用例直接拿到 throttled（这正是第一版测试互相踩脚的原因）。
beforeEach(() => resetProactiveThrottle())

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60_000

/** 造一个账号对象 */
function account(over = {}) {
  return {
    access: "mv_OLD",
    refresh: "RT_OLD",
    expires: NOW + WX_TTL_MS,
    metadata: { openid: "OID", guid: "0".repeat(32), loginType: "2", nickname: "示例昵称" },
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────
// ③ msUntilExpiry：auth.expires 的归一
// ─────────────────────────────────────────────────────────────

test("msUntilExpiry：绝对毫秒 / 秒 / 数字串 / ISO / Date 各走各的分支", () => {
  // 13 位毫秒原样
  assert.equal(msUntilExpiry({ expires: NOW + 7_200_000 }, { now: NOW }), 7_200_000)
  // 10 位秒 × 1000
  const secNow = 1_796_545_945_000 - 7_200_000
  assert.equal(msUntilExpiry({ expires: 1_796_545_945 }, { now: secNow }), 7_200_000)
  // 数字串（13 位毫秒 / 10 位秒）
  assert.equal(msUntilExpiry({ expires: String(NOW + 7_200_000) }, { now: NOW }), 7_200_000)
  assert.equal(msUntilExpiry({ expires: "1796545945" }, { now: secNow }), 7_200_000)
  // ISO 串
  assert.equal(
    msUntilExpiry({ expires: new Date(NOW + 7_200_000).toISOString() }, { now: NOW }),
    7_200_000,
  )
  // Date 对象
  assert.equal(msUntilExpiry({ expires: new Date(NOW + 7_200_000) }, { now: NOW }), 7_200_000)
})

test("msUntilExpiry：缺失 / 0 / 畸形 / 负数一律 null（「不知道」≠「没过期」）", () => {
  assert.equal(msUntilExpiry({}, { now: NOW }), null, "没有 expires → null")
  assert.equal(msUntilExpiry({ expires: undefined }, { now: NOW }), null)
  assert.equal(msUntilExpiry({ expires: 0 }, { now: NOW }), null, "网关占位账号 expires:0 → null")
  assert.equal(msUntilExpiry({ expires: -1 }, { now: NOW }), null, "负数是畸形不是过期")
  assert.equal(msUntilExpiry({ expires: "not-a-date" }, { now: NOW }), null)
  assert.equal(msUntilExpiry({ expires: "" }, { now: NOW }), null)
  assert.equal(msUntilExpiry({ expires: NaN }, { now: NOW }), null)
  assert.equal(msUntilExpiry(undefined, { now: NOW }), null)
})

test("msUntilExpiry：已经过期返回负数剩余，不是 null", () => {
  // 过期 5 秒：能解析出到期点 → 返回 -5000（调用方据此判断「该用 refresh token 抢救」）
  assert.equal(msUntilExpiry({ expires: NOW - 5_000 }, { now: NOW }), -5_000)
})

// ─────────────────────────────────────────────────────────────
// ① needsProactiveRefresh：判据（30 天口径）
// ─────────────────────────────────────────────────────────────

test("needs：没有 refresh token 一律 false（再怎么到期也不续）", () => {
  assert.equal(needsProactiveRefresh(account({ refresh: "", expires: NOW + 10_000 }), { now: NOW }), false)
  assert.equal(needsProactiveRefresh(account({ refresh: undefined, expires: NOW + 10_000 }), { now: NOW }), false)
  assert.equal(needsProactiveRefresh({ access: "a", expires: NOW + 10_000 }, { now: NOW }), false)
})

test("needs：不知道过期时间一律 false（「未知」不能被当成「快到期」）", () => {
  // 网关占位账号 expires:0 —— 绝不能对它主动续期
  assert.equal(needsProactiveRefresh(account({ expires: 0 }), { now: NOW }), false)
  assert.equal(needsProactiveRefresh(account({ expires: undefined }), { now: NOW }), false)
  assert.equal(needsProactiveRefresh(account({ expires: "not-a-date" }), { now: NOW }), false)
})

test("needs：默认 30 天口径 —— 微信 2h / QQ 30 天 / 任何已登录账号都在窗口内", () => {
  // 微信刚续完还剩 1h50m：30 天 lead → 在窗口内，true（常新语义：每次节流放行都顺手续）
  assert.equal(needsProactiveRefresh(account({ expires: NOW + 110 * 60_000 }), { now: NOW }), true)
  // QQ 30 天 TTL（刚登录满血）：也 < 30 天 lead → true
  assert.equal(
    needsProactiveRefresh(account({ expires: NOW + DEFAULT_TTL_MS - 1 }), { now: NOW }),
    true,
  )
  // 恰好剩 31 天（超长 TTL 的假想账号）→ 窗口外，false
  assert.equal(needsProactiveRefresh(account({ expires: NOW + 31 * DAY_MS }), { now: NOW }), false)
  assert.equal(DEFAULT_LEAD_MS, 30 * DAY_MS, "默认提前量必须是 30 天")
})

test("needs：剩余 < leadMs → true；正好等于 → false（严格小于）", () => {
  const lead = 10 * 60_000
  // 剩 9 分 59 秒 → true
  assert.equal(
    needsProactiveRefresh(account({ expires: NOW + 9 * 60_000 + 59_000 }), { now: NOW, leadMs: lead }),
    true,
  )
  // 正好剩 10 分钟 → false（不提前占位，避免边界抖动反复触发）
  assert.equal(needsProactiveRefresh(account({ expires: NOW + lead }), { now: NOW, leadMs: lead }), false)
  // 已过期 → 剩余为负 → 必然 true（赶紧抢救）
  assert.equal(needsProactiveRefresh(account({ expires: NOW - 1 }), { now: NOW, leadMs: lead }), true)
})

test("needs：显式 leadMs=0 表示「只在已过期时才续」", () => {
  assert.equal(needsProactiveRefresh(account({ expires: NOW + 5_000 }), { now: NOW, leadMs: 0 }), false)
  assert.equal(needsProactiveRefresh(account({ expires: NOW - 1 }), { now: NOW, leadMs: 0 }), true)
})

test("needs：leadMs 默认读 MARVIS_REFRESH_LEAD_MS，非法值回退 30 天", () => {
  const saved = process.env.MARVIS_REFRESH_LEAD_MS
  try {
    // 环境变量给 1 分钟：剩 30 秒 → true，剩 90 秒 → false
    process.env.MARVIS_REFRESH_LEAD_MS = "60000"
    assert.equal(needsProactiveRefresh(account({ expires: NOW + 30_000 }), { now: NOW }), true)
    assert.equal(needsProactiveRefresh(account({ expires: NOW + 90_000 }), { now: NOW }), false)

    // 环境变量给非法值 → 回退 30 天：剩 29 天 → true
    process.env.MARVIS_REFRESH_LEAD_MS = "not-a-number"
    assert.equal(needsProactiveRefresh(account({ expires: NOW + 29 * DAY_MS }), { now: NOW }), true)
  } finally {
    if (saved === undefined) delete process.env.MARVIS_REFRESH_LEAD_MS
    else process.env.MARVIS_REFRESH_LEAD_MS = saved
  }
})

// ─────────────────────────────────────────────────────────────
// ② proactiveRefresh：返回形状与失败隔离
// ─────────────────────────────────────────────────────────────

test("proactive：不需要续 → null，且不调 refreshFn", async () => {
  let called = false
  const fake = () => {
    called = true
    return Promise.resolve({ access: "mv_NEW" })
  }
  const out = await proactiveRefresh(
    account({ expires: NOW + 31 * DAY_MS }),
    { id: "marvis" },
    { now: NOW, refreshFn: fake },
  )
  assert.equal(out, null)
  assert.equal(called, false, "不该续就不发请求")
})

test("proactive：需要续 → 调 refreshFn，返回 { refreshed:true, auth:合并后的新 auth }", async () => {
  let seen = null
  const fake = async (auth, provider) => {
    seen = { auth, provider }
    return {
      access: "mv_NEW",
      refresh: "RT_NEW",
      expires: NOW + WX_TTL_MS,
      metadata: { nickname: "新昵称" },
    }
  }
  const auth = account({ expires: NOW + 5 * 60_000 })
  const out = await proactiveRefresh(auth, { id: "marvis" }, { now: NOW, refreshFn: fake })

  assert.deepEqual(seen, { auth, provider: { id: "marvis" } }, "refreshFn 收到 (auth, provider)")
  assert.equal(out.refreshed, true)
  // 合并语义：新字段覆盖、旧字段保留（metadata 同样合并）
  assert.equal(out.auth.access, "mv_NEW")
  assert.equal(out.auth.refresh, "RT_NEW")
  assert.equal(out.auth.expires, NOW + WX_TTL_MS)
  assert.equal(out.auth.metadata.openid, "OID", "metadata 旧字段不能被丢掉")
  assert.equal(out.auth.metadata.guid, "0".repeat(32))
  assert.equal(out.auth.metadata.loginType, "2")
  assert.equal(out.auth.metadata.nickname, "新昵称")
})

test("proactive：refreshFn 抛 signIn:expired（FATAL_CODES 语境）→ 捕获为 { refreshed:false, reason:'fatal' }", async () => {
  const err = new Error("续期失败（code=-107）：session expired")
  err.signIn = "expired"
  const fake = async () => {
    throw err
  }
  const out = await proactiveRefresh(
    account({ expires: NOW + 5 * 60_000 }),
    { id: "marvis" },
    { now: NOW, refreshFn: fake },
  )
  // 不向宿主传播：返回归一形状，不抛
  assert.deepEqual(out, { refreshed: false, reason: "fatal" })
})

test("proactive：refreshFn 抛普通错误（网络等）→ 捕获为 { refreshed:false, reason:'error' }", async () => {
  const fake = async () => {
    throw new Error("续期请求发不出去：fetch failed")
  }
  const out = await proactiveRefresh(
    account({ expires: NOW + 5 * 60_000 }),
    { id: "marvis" },
    { now: NOW, refreshFn: fake },
  )
  assert.deepEqual(out, { refreshed: false, reason: "error" })
})

test("proactive：refreshFn 抛非 Error 值（非致命）→ 同样归一为 error，不炸出去", async () => {
  const fake = async () => {
    throw "字符串异常"
  }
  const out = await proactiveRefresh(
    account({ expires: NOW + 5 * 60_000 }),
    null,
    { now: NOW, refreshFn: fake },
  )
  assert.deepEqual(out, { refreshed: false, reason: "error" })
})

// ─────────────────────────────────────────────────────────────
// ④ 节流：30 天窗口下的实际续期节奏阀
// ─────────────────────────────────────────────────────────────

test("proactive：同账号最小间隔内第二次调用 → throttled，且**不调** refreshFn", async () => {
  let calls = 0
  const fake = async () => {
    calls += 1
    return { access: "mv_NEW", refresh: "RT_NEW", expires: NOW + WX_TTL_MS }
  }
  const auth = account({ expires: NOW + 60_000 })

  const first = await proactiveRefresh(auth, { id: "marvis" }, { now: NOW, refreshFn: fake })
  assert.equal(first.refreshed, true)
  assert.equal(calls, 1)

  // 30 分钟后再来一次（默认最小间隔 1 小时）→ 必须被挡住
  const second = await proactiveRefresh(auth, { id: "marvis" }, { now: NOW + 30 * 60_000, refreshFn: fake })
  assert.deepEqual(second, { refreshed: false, reason: "throttled" })
  assert.equal(calls, 1, "节流命中的那次绝不能真的去调续期")

  // 过了最小间隔 → 放行
  const third = await proactiveRefresh(auth, { id: "marvis" }, { now: NOW + 61 * 60_000, refreshFn: fake })
  assert.equal(third.refreshed, true)
  assert.equal(calls, 2)
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 60 * 60_000, "默认最小间隔必须是 1 小时")
})

test("proactive：MARVIS_REFRESH_MIN_INTERVAL_MS=0 关闭节流", async () => {
  const saved = process.env.MARVIS_REFRESH_MIN_INTERVAL_MS
  try {
    process.env.MARVIS_REFRESH_MIN_INTERVAL_MS = "0"
    let calls = 0
    const fake = async () => {
      calls += 1
      return { access: "mv_NEW", refresh: "RT_NEW", expires: NOW + WX_TTL_MS }
    }
    const auth = account({ expires: NOW + 60_000 })
    await proactiveRefresh(auth, null, { now: NOW, refreshFn: fake })
    await proactiveRefresh(auth, null, { now: NOW + 1_000, refreshFn: fake })
    assert.equal(calls, 2, "关掉节流后连续两次都要真的续")
  } finally {
    if (saved === undefined) delete process.env.MARVIS_REFRESH_MIN_INTERVAL_MS
    else process.env.MARVIS_REFRESH_MIN_INTERVAL_MS = saved
  }
})

test("proactive：失败也记节流时刻（失败后不立刻重试打爆上游）", async () => {
  let calls = 0
  const fake = async () => {
    calls += 1
    throw new Error("网络抖动")
  }
  const auth = account({ expires: NOW + 60_000 })
  const a = await proactiveRefresh(auth, null, { now: NOW, refreshFn: fake })
  assert.deepEqual(a, { refreshed: false, reason: "error" })
  // 紧接着再试 → 被节流挡住，不会再打一次上游
  const b = await proactiveRefresh(auth, null, { now: NOW + 5_000, refreshFn: fake })
  assert.deepEqual(b, { refreshed: false, reason: "throttled" })
  assert.equal(calls, 1)
})

test("proactive：不同账号各自计节流（同机多号不会互相挡）", async () => {
  let calls = 0
  const fake = async () => {
    calls += 1
    return { access: "mv_NEW", refresh: "RT_NEW", expires: NOW + WX_TTL_MS }
  }
  const a1 = account({ expires: NOW + 60_000, metadata: { openid: "OID_A" } })
  const a2 = account({ expires: NOW + 60_000, metadata: { openid: "OID_B" } })
  await proactiveRefresh(a1, null, { now: NOW, refreshFn: fake })
  const r = await proactiveRefresh(a2, null, { now: NOW, refreshFn: fake })
  assert.equal(r.refreshed, true, "另一个账号不该被前一个账号的节流挡住")
  assert.equal(calls, 2)
})
