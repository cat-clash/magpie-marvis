// tests/account-isolation.test.mjs —— 按账号隔离的风控熔断 / 节奏闸（0.8.0）
//
// 要证明的核心事实：**一个账号被 4100404 拦住，不会让别的账号跟着停**。
//   · accountKeyOf / accountLabelOf：账号 → 桶 key / 脱敏标签（不落 openid 明文）
//   · getBreaker(bucket)：不同账号不同实例，失败计数 / 冷却 / 退避链互不影响
//   · 持久化 v2：单文件多桶，改 A 桶不动 B 桶；v1 扁平格式向后兼容进全局桶
//   · 共因闸：MARVIS_RISK_CONSENSUS 个不同账号接连被拦 → 判定通道级封锁，全局桶也开
//   · pacing 分桶：account 作用域下 A 号在等间隔时 B 号立刻放行；global 作用域共用一条轴
//   · loader 接线：pacingWait / getBreaker 收到的是当前账号的桶，不是全局单例
//
// 全部离线；假时钟 + 假随机；MARVIS_NATIVE_DIR 每用例指向全新临时目录。
// 跑法：node --test tests/account-isolation.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  createBreaker,
  getBreaker,
  accountKeyOf,
  accountLabelOf,
  riskScope,
  breakerBuckets,
  breakerStatePath,
  resetAllBreakers,
} from "../src/breaker.mjs"
import { createPacing, pacingScope } from "../src/pacing.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

// —— 环境隔离：宿主机可能带着真实 MARVIS_* 变量 ——
const ENV_KEYS = [
  "MARVIS_RISK_THRESHOLD",
  "MARVIS_RISK_COOLDOWN_MS",
  "MARVIS_RISK_SCOPE",
  "MARVIS_RISK_CONSENSUS",
  "MARVIS_RISK_WINDOW_MS",
  "MARVIS_MIN_REQUEST_INTERVAL_MS",
  "MARVIS_REQUEST_JITTER_MS",
  "MARVIS_PACING_SCOPE",
]
for (const key of ENV_KEYS) process.env[key] = ""
const rootDir = mkdtempSync(join(tmpdir(), "mmf-isolation-root-"))
process.env.MARVIS_NATIVE_DIR = rootDir

const ZERO_JITTER = () => 0.5 // jitter 恰好为 0，冷却值可精确断言

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function freshNativeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmf-isolation-"))
  process.env.MARVIS_NATIVE_DIR = dir
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 每个用例唯一桶名：getBreaker 是进程级 Map，跨用例复用同名桶会带进残留状态 */
let seq = 0
const uniq = (tag) => `${tag}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`

test("accountKeyOf：同一账号稳定同 key，不同账号不同 key，无凭据退化全局桶", () => {
  const a1 = accountKeyOf({ openid: "OF1C2D3E4A5B6C7D8" })
  const a2 = accountKeyOf({ openid: "OF1C2D3E4A5B6C7D8" })
  const b = accountKeyOf({ openid: "OF9999999999999ZZ" })
  assert.equal(a1, a2, "同 openid → 同桶")
  assert.notEqual(a1, b, "不同 openid → 不同桶")
  assert.equal(a1.length, 12, "短哈希 12 位")
  assert.ok(!a1.includes("OF1C2D3E"), "不落 openid 明文")
  assert.match(a1, /^[0-9a-f]{12}$/, "十六进制")
  assert.equal(accountKeyOf({}), "*", "无凭据 → 全局桶")
  assert.equal(accountKeyOf(null), "*")
  assert.equal(accountKeyOf({ uid: "u-1" }), accountKeyOf({ openid: "u-1" }), "uid 与 openid 同源")
})

test("accountLabelOf：脱敏成首 4 + 尾 4，短串原样，空值给可读文案", () => {
  assert.equal(accountLabelOf({ openid: "OF1C2D3E4A5B6C7D8" }), "OF1C…C7D8")
  assert.equal(accountLabelOf({ openid: "QQ·1" }), "QQ·1", "短串不截断")
  assert.equal(accountLabelOf({}), "未指定账号")
})

test("riskScope：默认 account；显式 global 才退回旧行为；未知值当 account", (t) => {
  delete process.env.MARVIS_RISK_SCOPE
  assert.equal(riskScope(), "account", "默认按账号隔离")
  process.env.MARVIS_RISK_SCOPE = "global"
  assert.equal(riskScope(), "global")
  process.env.MARVIS_RISK_SCOPE = "GLOBAL"
  assert.equal(riskScope(), "global", "大小写不敏感")
  process.env.MARVIS_RISK_SCOPE = "nonsense"
  assert.equal(riskScope(), "account", "未知值当 account（宁可隔离过度）")
  process.env.MARVIS_RISK_SCOPE = ""
  t.after(() => {
    process.env.MARVIS_RISK_SCOPE = ""
  })
})

test("核心：A 号熔断，B 号完全不受影响（同进程、同状态文件）", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const ka = uniq("acctA")
  const kb = uniq("acctB")
  const a = getBreaker(ka, "账号A")
  const b = getBreaker(kb, "账号B")

  a.record(false)
  a.record(false)
  assert.equal(a.open, false, "A 未达阈值")
  b.record(true) // B 成功过
  assert.equal(b.open, false)

  a.record(false) // A 达到默认阈值 5？不 —— 显式小阈值在下面；这里用默认 5 前先确认计数
  assert.equal(a.failures, 3, "A 自己记了 3 次")
  assert.equal(b.failures, 0, "B 的计数没被 A 污染")

  // 直接用一个低阈值实例把 A 打到开闸（同一 bucket 再用新实例会读盘，正好验证落盘隔离）
  const a2 = createBreaker({ bucket: ka, threshold: 3, cooldownMs: 60_000, now, random: ZERO_JITTER })
  a2.record(false)
  assert.equal(a2.open, true, "A 达到阈值开闸")
  assert.equal(b.open, false, "★ B 仍然可用 —— 这就是 0.8.0 的隔离")

  // B 继续正常请求，A 的冷却不影响它
  b.record(false)
  b.record(true)
  assert.equal(b.open, false, "B 一直可用")
})

test("持久化 v2：单文件多桶，A 开闸后 B 桶原样保留", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const ka = uniq("pA")
  const kb = uniq("pB")
  const a = createBreaker({ bucket: ka, label: "账号A", threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER })
  const b = createBreaker({ bucket: kb, label: "账号B", threshold: 5, cooldownMs: 60_000, now, random: ZERO_JITTER })
  b.record(false)
  b.record(false)
  a.record(false) // A 开闸（同时落盘）

  const raw = JSON.parse(readFileSync(breakerStatePath(), "utf8"))
  assert.equal(raw.version, 2, "状态文件升到 v2")
  assert.equal(raw.accounts[ka].failures, 1, "A 桶记 1 次")
  assert.equal(raw.accounts[ka].label, "账号A")
  assert.equal(raw.accounts[kb].failures, 2, "B 桶仍是 2 次，没被 A 的写盘覆盖")
  assert.ok(raw.accounts[ka].openedAt > 0, "A 桶有 openedAt")
  assert.equal(raw.accounts[kb].openedAt, 0, "B 桶没被开闸")

  // 新实例读盘：各读各的桶
  const a2 = createBreaker({ bucket: ka, threshold: 5, cooldownMs: 60_000, now, random: ZERO_JITTER })
  const b2 = createBreaker({ bucket: kb, threshold: 5, cooldownMs: 60_000, now, random: ZERO_JITTER })
  assert.equal(a2.open, true, "A 重启后仍在冷却")
  assert.equal(b2.open, false, "B 重启后照常可用")
})

test("v1 扁平格式迁移：计数保留进全局桶，但活跃冷却不继承（避免升级后全体被挡）", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock()
  writeFileSync(
    join(dir, "breaker-state.json"),
    JSON.stringify({ consecutiveOpens: 2, openedAt: now(), failures: 4 }),
  )
  const g = createBreaker({ bucket: "*", threshold: 5, cooldownMs: 60_000, now, random: ZERO_JITTER })
  assert.equal(g.failures, 4, "旧失败计数读进全局桶（诊断保留）")
  assert.equal(g.consecutiveOpens, 2, "旧退避次数也保留")
  assert.equal(g.open, false, "★ 旧 openedAt 不继承：不然升级后所有账号一起被挡，与 0.8.0 目标相反")

  // 下次状态变化落盘时写成 v2 多桶格式（loadState 只读不写，故先制造一次变化）
  g.record(false) // failures 4→5 达阈值 → 本次是合法的新开闸
  const raw = JSON.parse(readFileSync(join(dir, "breaker-state.json"), "utf8"))
  assert.equal(raw.version, 2, "已迁移成 v2 多桶格式")
  assert.equal(raw.accounts["*"].failures, 5)
  assert.ok(raw.accounts["*"].openedAt > 0, "新的开闸用当前时刻，不是旧的那一刻")

  const acct = createBreaker({ bucket: uniq("fresh"), threshold: 5, cooldownMs: 60_000, now, random: ZERO_JITTER })
  assert.equal(acct.failures, 0, "账号桶不受旧全局状态影响")
  assert.equal(acct.open, false)
})

// —— 0.8.1 自愈：全局桶残留 vs 真共因闸冷却 ——

test("全局桶残留（无 reason）被自愈：openedAt 清零，不再挡人（模拟用户真实污染文件）", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock()
  // 用户真实文件：0.8.0 首版把 v1 旧冷却写进 "*" 桶，无 reason
  writeFileSync(
    join(dir, "breaker-state.json"),
    JSON.stringify({
      version: 2,
      accounts: {
        "*": { consecutiveOpens: 0, openedAt: now() - 5 * 60_000, failures: 5 },
      },
    }),
  )
  const g = createBreaker({ bucket: "*", threshold: 5, cooldownMs: 1_800_000, now, random: ZERO_JITTER })
  assert.equal(g.open, false, "★ 残留冷却被清：升级后不会全体被挡")
  assert.equal(g.failures, 5, "失败计数保留（诊断用）")

  const rows = breakerBuckets(now())
  const slot = rows.find((r) => r.bucket === "*")
  assert.ok(slot)
  assert.equal(slot.retryAfterMs, 0, "CLI 也显示无冷却")
})

test("真共因闸冷却（带 reason=cross-account）保留：重启后仍挡所有账号", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock()
  writeFileSync(
    join(dir, "breaker-state.json"),
    JSON.stringify({
      version: 2,
      accounts: {
        "*": { consecutiveOpens: 1, openedAt: now() - 60_000, failures: 2, reason: "cross-account" },
      },
    }),
  )
  const g = createBreaker({ bucket: "*", threshold: 5, cooldownMs: 1_800_000, now, random: ZERO_JITTER })
  assert.equal(g.open, true, "★ 有 reason 的共因闸冷却保留")
  assert.ok(g.retryAfterMs > 0)
})

test("trip() 落盘带 reason：自检能区分它和残留", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock()
  const g = getBreaker("*", "跨账号共因")
  g.reset()
  g.trip("cross-account")
  const raw = JSON.parse(readFileSync(join(dir, "breaker-state.json"), "utf8"))
  assert.equal(raw.accounts["*"].reason, "cross-account", "trip 开闸落盘写 reason 标记")
  assert.ok(raw.accounts["*"].openedAt > 0)
})

test("通道级共因闸开着时：即使账号自己没被拦，loader 也必须挡住（读取全局桶 open）", (t) => {
  const src = readFileSync(join(HERE, "..", "src", "hooks", "loader.mjs"), "utf8")
  // 回归防护：0.8.0 首版只检查 breaker.open（账号桶），漏了全局桶 —— 通道级封锁时所有账号照常出网。
  assert.match(src, /channelBreaker = acctBucket === "\*" \? breaker : getBreaker\("\*", "跨账号共因"\)/,
    "必须取全局桶（共因闸开的那个）")
  assert.match(src, /\(breaker\.open \|\| channelBreaker\.open\)/, "两个桶任一开闸都要挡")
  assert.match(src, /channelWide/, "文案要区分账号级与通道级")
  assert.match(src, /通道级风控冷却中/, "通道级文案明确告知所有账号都停了")
})

test("共因闸：两个不同账号接连被拦 → 判定通道级封锁，全局桶也开", (t) => {
  freshNativeDir(t)
  process.env.MARVIS_RISK_CONSENSUS = "2"
  const { now } = fakeClock()
  const g = getBreaker("*", "全局")
  g.reset()
  const opts = { threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }
  const a = getBreaker(uniq("cA"), "账号A", opts)
  const b = getBreaker(uniq("cB"), "账号B", opts)
  a.record(false)
  assert.equal(g.open, false, "只有一个账号时不开全局闸")
  b.record(false)
  assert.equal(g.open, true, "第二个账号也被拦 → 通道级封锁，全局停")
  assert.equal(a.open, true, "A 本身仍冷却")
  assert.equal(b.open, true, "B 本身仍冷却")
  process.env.MARVIS_RISK_CONSENSUS = ""
  t.after(() => {
    process.env.MARVIS_RISK_CONSENSUS = ""
  })
})

test("共因闸可关：MARVIS_RISK_CONSENSUS=0 时分桶就是纯隔离", (t) => {
  freshNativeDir(t)
  process.env.MARVIS_RISK_CONSENSUS = "0"
  const g = getBreaker("*", "全局")
  g.reset()
  const { now } = fakeClock()
  const opts = { threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }
  const a = getBreaker(uniq("zA"), "账号A", opts)
  const b = getBreaker(uniq("zB"), "账号B", opts)
  a.record(false)
  b.record(false)
  assert.equal(g.open, false, "共因闸关闭 → 全局桶永不被自动打开")
  assert.equal(a.open, true)
  assert.equal(b.open, true)
  process.env.MARVIS_RISK_CONSENSUS = ""
  t.after(() => {
    process.env.MARVIS_RISK_CONSENSUS = ""
  })
})

test("pacing 分桶：A 号在等间隔时 B 号立刻放行；同一账号内仍有最小间隔", async (t) => {
  delete process.env.MARVIS_PACING_SCOPE
  t.after(() => {
    process.env.MARVIS_PACING_SCOPE = ""
  })
  assert.equal(pacingScope(), "account", "默认按账号分时间轴")
  const { now } = fakeClock()
  const p = createPacing({ minMs: 1_000, jitterMs: 0, now, random: ZERO_JITTER, sleep: async () => {} })
  assert.equal(await p.pacingWait("A"), 0, "A 首次放行")
  assert.equal(await p.pacingWait("B"), 0, "★ B 不被 A 的间隔拖住")
  assert.equal(await p.pacingWait("A"), 1_000, "A 自己仍要等满最小间隔")
  assert.equal(await p.pacingWait("B"), 1_000, "B 也按自己的轴等")
  assert.equal(await p.pacingWait(""), 0, "无 key 落 \"*\" 桶，与 A/B 都无关")
})

test("pacing global 作用域：所有账号共用一条时间轴（旧行为，可开关）", async () => {
  const { now } = fakeClock()
  const p = createPacing({ minMs: 1_000, jitterMs: 0, now, random: ZERO_JITTER, sleep: async () => {}, scope: "global" })
  assert.equal(p.scope, "global")
  assert.equal(await p.pacingWait("A"), 0)
  assert.equal(await p.pacingWait("B"), 1_000, "global 下 B 要等 A 的间隔")
  assert.equal(await p.pacingWait("C"), 2_000, "第三个调用方排在 A、B 之后")
  const st = p.pacingStatus("A")
  assert.equal(st.scope, "global")
  assert.equal(st.key, "*", "global 只有 \"*\" 一条轴")
  assert.equal(st.activeKeys, 1)
})

test("pacing 无参调用向后兼容：仍是单条 \"*\" 时间轴（旧测试依赖这一点）", async () => {
  const { now } = fakeClock()
  const p = createPacing({ minMs: 200, jitterMs: 0, now, random: ZERO_JITTER, sleep: async () => {} })
  assert.equal(await p.pacingWait(), 0)
  assert.equal(await p.pacingWait(), 200, "无 key 的两次调用落在同一条轴")
  assert.equal(p.pacingStatus().activeKeys, 1)
})

test("breakerBuckets：列出所有桶并带脱敏 label + 剩余冷却", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const ka = uniq("bkA")
  const kb = uniq("bkB")
  createBreaker({ bucket: ka, label: "账号A", threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }).record(false)
  createBreaker({ bucket: kb, label: "账号B", threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }).record(false)
  const rows = breakerBuckets(now())
  const a = rows.find((r) => r.bucket === ka)
  const b = rows.find((r) => r.bucket === kb)
  assert.ok(a && b, "两个桶都在列表里")
  assert.equal(a.label, "账号A")
  assert.equal(b.label, "账号B")
  assert.equal(a.failures, 1)
  assert.ok(a.retryAfterMs > 0, "仍在冷却")
})

test("resetAllBreakers：一键解除全部桶", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const ka = uniq("rA")
  const kb = uniq("rB")
  const opts = { threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }
  const a = getBreaker(ka, "账号A", opts) // 进 pool：resetAllBreakers 才作用到同一实例
  const b = getBreaker(kb, "账号B", opts)
  a.record(false)
  b.record(false)
  assert.equal(a.open, true)
  assert.equal(b.open, true)
  resetAllBreakers()
  assert.equal(a.open, false, "A 解除")
  assert.equal(b.open, false, "B 解除")
})

test("loader 接线：用当前账号的桶，不是全局单例", () => {
  const src = readFileSync(join(HERE, "..", "src", "hooks", "loader.mjs"), "utf8")
  assert.match(src, /const acctBucket = riskScope\(\) === "global" \? "\*" : accountKeyOf\(creds\)/, "按账号算桶")
  assert.match(src, /const breaker = getBreaker\(acctBucket, acctLabel\)/, "取该账号的熔断器")
  assert.match(src, /await pacingWait\(acctBucket\)/, "节奏闸也带账号桶")
  assert.match(src, /breaker\.record\(false\)/, "失败记到该账号")
  assert.match(src, /breaker\.record\(true\)/, "成功清该账号")
  assert.doesNotMatch(src, /riskBreaker\.(open|failures|retryAfterMs|record)/, "loader 不再用进程单例")
  assert.match(src, /其他账号不受影响/, "报错文案说清隔离")
  assert.match(src, /breaker reset <账号>/, "文案指向 CLI 解封命令")
})

// —— CLI（scripts/breaker-cli.mjs，经 node scripts/cli.mjs breaker 调用）——

function runCli(t, argv, env = {}) {
  const r = spawnSync(process.execPath, [join(HERE, "..", "scripts", "cli.mjs"), ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  t.after(() => {})
  return { code: r.status, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") }
}

test("CLI breaker --help：列出 list / reset 与各环境开关", (t) => {
  const r = runCli(t, ["breaker", "--help"])
  assert.equal(r.code, 0)
  assert.match(r.out, /list \[--json\]/)
  assert.match(r.out, /reset <账号>/)
  assert.match(r.out, /MARVIS_RISK_SCOPE=account\|global/)
  assert.match(r.out, /MARVIS_RISK_CONSENSUS=2/)
})

test("CLI breaker list --json：空状态也给出 scope 与空账号列表", (t) => {
  freshNativeDir(t)
  const r = runCli(t, ["breaker", "list", "--json"])
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out)
  assert.equal(out.scope, "account")
  assert.ok(Array.isArray(out.accounts))
})

test("CLI breaker reset：没匹配到账号返回 1；--all 返回 0", (t) => {
  freshNativeDir(t)
  const miss = runCli(t, ["breaker", "reset", "不存在的账号"])
  assert.equal(miss.code, 1, "没匹配 → 退出码 1")
  assert.match(miss.err, /没找到匹配/)

  const all = runCli(t, ["breaker", "reset", "--all"])
  assert.equal(all.code, 0)
  assert.match(all.out, /已解除全部/)
})

test("CLI breaker：解除指定账号（按 label 子串命中）", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const key = uniq("cliA")
  createBreaker({ bucket: key, label: "账号CLI", threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER }).record(false)

  const list = runCli(t, ["breaker", "list", "--json"])
  const rows = JSON.parse(list.out).accounts
  const hit = rows.find((r) => r.bucket === key)
  assert.ok(hit, "列出该账号桶")
  assert.equal(hit.label, "账号CLI")

  const reset = runCli(t, ["breaker", "reset", "账号CLI"])
  assert.equal(reset.code, 0)
  assert.match(reset.out, new RegExp(`已解除「账号CLI」\\(${key}\\)`))
  const after = JSON.parse(runCli(t, ["breaker", "list", "--json"]).out).accounts.find((r) => r.bucket === key)
  assert.equal(after.retryAfterMs, 0, "解除后无剩余冷却")
})