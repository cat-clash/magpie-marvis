// tests/pacing.test.mjs —— 出站请求节奏闸
//
// 覆盖：
//   · 进程单例：惰性读 env，第一次调用定型后 env 改动不再生效
//   · env 默认 800 / 400；env 可覆盖；负数视为未设
//   · 显式参数优先于 env；显式 0 = 关闭对应部分
//   · 首次放行立即；间隔不足等待剩余时间；jitter ∈ [0, jitterMs]
//   · 双 0 完全直通
//   · 并发调用不互斥但启动间隔守恒（同一时间轴排队）
//
// 全部离线；假时钟 / 假随机 / 记录型假 sleep 注入；纯内存零 IO。
// 跑法：node --test tests/pacing.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { createPacing, pacingWait, pacingStatus } from "../src/pacing.mjs"

// —— 环境隔离：宿主机可能带着真实 MARVIS_* 变量 ——
for (const key of ["MARVIS_MIN_REQUEST_INTERVAL_MS", "MARVIS_REQUEST_JITTER_MS"]) {
  process.env[key] = ""
}

function fakeClock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** 记录型假 sleep：只记录等待时长，不推进时钟（各调用方独立睡眠，互不交接） */
function recordingSleep() {
  const sleeps = []
  return { sleeps, sleep: async (ms) => { sleeps.push(ms) } }
}

test("进程单例：惰性读 env，第一次调用定型后 env 改动不再生效", async () => {
  process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "50"
  process.env.MARVIS_REQUEST_JITTER_MS = "0"
  try {
    const st = pacingStatus() // 触发单例创建（此刻才读 env）
    assert.equal(st.minMs, 50)
    assert.equal(st.jitterMs, 0)
    assert.equal(st.lastDispatchAt, 0)
    assert.equal(st.nextFreeAt, 0)
    assert.equal(await pacingWait(), 0, "首次放行：无剩余 + 零抖动 → 立即")
    const after = pacingStatus()
    assert.ok(after.lastDispatchAt > 0, "记录了放行时刻")
    assert.equal(after.nextFreeAt - after.lastDispatchAt, 50)
    process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "9999"
    assert.equal(pacingStatus().minMs, 50, "已定型：env 改动不生效")
  } finally {
    process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = ""
    process.env.MARVIS_REQUEST_JITTER_MS = ""
  }
})

test("未传参读 env：默认 800 / 400；env 可覆盖；负数视为未设", () => {
  process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = ""
  process.env.MARVIS_REQUEST_JITTER_MS = ""
  const base = createPacing({ now: () => 0, random: () => 0 })
  assert.equal(base.pacingStatus().minMs, 800)
  assert.equal(base.pacingStatus().jitterMs, 400)

  process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "123"
  process.env.MARVIS_REQUEST_JITTER_MS = "45"
  try {
    const over = createPacing({ now: () => 0, random: () => 0 })
    assert.equal(over.pacingStatus().minMs, 123)
    assert.equal(over.pacingStatus().jitterMs, 45)
  } finally {
    process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = ""
    process.env.MARVIS_REQUEST_JITTER_MS = ""
  }

  process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "-7"
  try {
    const neg = createPacing({ now: () => 0, random: () => 0 })
    assert.equal(neg.pacingStatus().minMs, 800, "负数视为未设，回落默认")
  } finally {
    process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = ""
  }
})

test("显式参数优先于 env；minMs=0 时抖动独立生效", async () => {
  process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "500"
  process.env.MARVIS_REQUEST_JITTER_MS = "500"
  try {
    const clock = fakeClock(0)
    const { sleeps, sleep } = recordingSleep()
    const p = createPacing({ minMs: 0, jitterMs: 0, now: clock.now, random: () => 1, sleep })
    assert.equal(await p.pacingWait(), 0, "显式双 0 = 完全关闭（env 500 不生效）")
    assert.deepEqual(sleeps, [])
    assert.equal(p.pacingStatus().nextFreeAt, 0)

    const q = createPacing({ minMs: 0, jitterMs: 300, now: clock.now, random: () => 0.5, sleep })
    assert.equal(await q.pacingWait(), 150, "只关间隔闸：jitter 0.5×300")
  } finally {
    process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = ""
    process.env.MARVIS_REQUEST_JITTER_MS = ""
  }
})

test("首次放行立即；间隔不足时等待剩余时间", async () => {
  const clock = fakeClock(1_000)
  const { sleeps, sleep } = recordingSleep()
  const p = createPacing({ minMs: 100, jitterMs: 0, now: clock.now, random: () => 0.5, sleep })
  assert.equal(await p.pacingWait(), 0)
  assert.deepEqual(sleeps, [])
  clock.advance(10) // 距上次放行 10ms < 100ms
  assert.equal(await p.pacingWait(), 90, "等待剩余 90ms")
  assert.deepEqual(sleeps, [90])
  const st = p.pacingStatus()
  assert.equal(st.lastDispatchAt, 1_100) // 1010 + 90
  assert.equal(st.nextFreeAt, 1_200)
  clock.advance(500) // 早已超过 nextFreeAt
  assert.equal(await p.pacingWait(), 0, "间隔已够：立即放行")
})

test("jitter 界：random=0 → 0，random=1 → 满额 jitterMs", async () => {
  const clock = fakeClock(0)
  const { sleeps, sleep } = recordingSleep()
  const top = createPacing({ minMs: 0, jitterMs: 200, now: clock.now, random: () => 1, sleep })
  assert.equal(await top.pacingWait(), 200)
  assert.deepEqual(sleeps, [200])
  const bottom = createPacing({ minMs: 0, jitterMs: 200, now: clock.now, random: () => 0, sleep })
  assert.equal(await bottom.pacingWait(), 0)
  assert.deepEqual(sleeps, [200])
})

test("间隔与抖动叠加：wait = 剩余 + random() * jitterMs", async () => {
  const clock = fakeClock(1_000)
  const { sleeps, sleep } = recordingSleep()
  const p = createPacing({ minMs: 100, jitterMs: 200, now: clock.now, random: () => 0.25, sleep })
  assert.equal(await p.pacingWait(), 50, "首次：剩余 0 + 0.25×200；放行槽位 = 1050（含 jitter）")
  clock.advance(10)
  // 下一次最早放行 = 槽位 1050 + 100 = 1150；t=1010 → 剩余 140，加 jitter 50
  assert.equal(await p.pacingWait(), 190)
  assert.deepEqual(sleeps, [50, 190])
})

test("双 0 完全直通：不等待、不占时间轴", async () => {
  const clock = fakeClock(0)
  const { sleeps, sleep } = recordingSleep()
  const p = createPacing({ minMs: 0, jitterMs: 0, now: clock.now, random: () => 1, sleep })
  for (let i = 0; i < 5; i++) assert.equal(await p.pacingWait(), 0)
  assert.deepEqual(sleeps, [])
  const st = p.pacingStatus()
  assert.equal(st.nextFreeAt, 0)
  assert.equal(st.lastDispatchAt, 0)
})

test("并发调用不互斥但启动间隔守恒（同一时间轴排队）", async () => {
  const clock = fakeClock(0)
  const { sleeps, sleep } = recordingSleep()
  const p = createPacing({ minMs: 100, jitterMs: 0, now: clock.now, random: () => 0.5, sleep })
  // 同一 tick 内并发发起 4 个：同步占位 → 槽位 0 / 100 / 200 / 300
  const waits = await Promise.all([p.pacingWait(), p.pacingWait(), p.pacingWait(), p.pacingWait()])
  assert.deepEqual(waits, [0, 100, 200, 300], "各调用方睡到自己的槽位，启动间隔 ≥ minMs")
  assert.deepEqual(sleeps, [100, 200, 300], "第一个立即放行，其余各自等待")
  assert.equal(p.pacingStatus().lastDispatchAt, 300)
  assert.equal(p.pacingStatus().nextFreeAt, 400)
  // 时间轴延续：t=250，下一次最早放行 = 300 + 100 = 400 → 剩余 150
  clock.advance(250)
  assert.equal(await p.pacingWait(), 150)
})
