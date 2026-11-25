// tests/breaker.test.mjs —— 风控熔断器状态机（指数退避 + 半开 + 持久化 + 事件缓冲）
//
// 覆盖：
//   · 连续失败开闸、成功清零（旧语义兼容）
//   · 指数退避倍增与 8h 封顶、±10% jitter 界（假随机定死边界）
//   · 半开失败立即重开（退避翻倍）、半开成功关闭清零
//   · 持久化 roundtrip / 损坏 JSON / 未来时间戳（时钟偏移）/ 过期状态
//   · MARVIS_RISK_THRESHOLD / MARVIS_RISK_COOLDOWN_MS 环境变量覆盖（含 0 = 禁用）
//   · 风险事件流（open / probe-fail / reopen / close）与环形缓冲 ≤50
//
// 全部离线；假时钟/假随机注入；MARVIS_NATIVE_DIR 每用例指向全新临时目录，绝不写宿主真实目录。
// 跑法：node --test tests/breaker.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBreaker, riskBreaker, riskEvents } from "../src/breaker.mjs"

// —— 环境隔离：宿主机可能带着真实 MARVIS_* 变量在跑插件 ——
for (const key of ["MARVIS_RISK_THRESHOLD", "MARVIS_RISK_COOLDOWN_MS"]) {
  process.env[key] = ""
}
// 兜底：整个测试文件期间 MARVIS_NATIVE_DIR 至少指向临时目录（防真实目录被读写）
const rootDir = mkdtempSync(join(tmpdir(), "mmf-breaker-root-"))
process.env.MARVIS_NATIVE_DIR = rootDir

const ZERO_JITTER = () => 0.5 // random=0.5 → jitter 恰好为 0，冷却值可精确断言

/** 假时钟 */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

/** 每个用例（或用例内每个独立 breaker 实例）一个全新 MARVIS_NATIVE_DIR，用完即删 */
function freshNativeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmf-breaker-"))
  process.env.MARVIS_NATIVE_DIR = dir
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("连续失败达阈值开闸；不足阈值不开；成功清零（旧语义兼容）", (t) => {
  freshNativeDir(t)
  const { now } = fakeClock()
  const b = createBreaker({ threshold: 3, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.equal(b.open, false)
  b.record(false)
  b.record(false)
  assert.equal(b.open, false)
  assert.equal(b.failures, 2)
  b.record(false)
  assert.equal(b.open, true, "达到阈值熔断")
  assert.equal(b.failures, 3)
  assert.equal(b.retryAfterMs, 1_000, "首开冷却 = base")
  b.record(true) // 开闸状态下在途请求成功：关闭清零
  assert.equal(b.open, false)
  assert.equal(b.failures, 0)
  assert.equal(b.retryAfterMs, 0)
})

test("指数退避：base → 2×base → 4×base，逐轮翻倍", (t) => {
  freshNativeDir(t)
  const { now, advance } = fakeClock()
  const b = createBreaker({ threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER })
  b.record(false) // 首开：consecutiveOpens = 0 → 冷却 = base
  assert.equal(b.consecutiveOpens, 0)
  assert.equal(b.retryAfterMs, 60_000)
  advance(60_000) // 冷却到期 → 半开
  assert.equal(b.open, false, "冷却到期放行探测")
  b.record(false) // 探测失败 → 立即重开
  assert.equal(b.open, true, "半开一次失败立即重开，不重撞阈值")
  assert.equal(b.consecutiveOpens, 1)
  assert.equal(b.retryAfterMs, 120_000, "base * 2^1")
  advance(120_000)
  b.record(false)
  assert.equal(b.consecutiveOpens, 2)
  assert.equal(b.retryAfterMs, 240_000, "base * 2^2")
})

test("退避封顶 8h，封顶后不再增长", (t) => {
  freshNativeDir(t)
  const { now, advance } = fakeClock()
  const b = createBreaker({ threshold: 1, cooldownMs: 60_000, now, random: ZERO_JITTER })
  b.record(false)
  let guard = 0
  while (b.retryAfterMs < 8 * 60 * 60 * 1_000 && guard++ < 30) {
    advance(b.retryAfterMs) // 冷却到期 → 半开
    b.record(false) // 探测失败 → 重开、退避翻倍
  }
  assert.equal(b.retryAfterMs, 8 * 60 * 60 * 1_000, "封顶 8h")
  advance(8 * 60 * 60 * 1_000)
  b.record(false)
  assert.equal(b.retryAfterMs, 8 * 60 * 60 * 1_000, "封顶后不再翻倍")
})

test("jitter 界：random=0 → -10%，random=1 → +10%，封顶值同样 ±10%", (t) => {
  const { now } = fakeClock()
  freshNativeDir(t)
  const low = createBreaker({ threshold: 1, cooldownMs: 1_000, now, random: () => 0 })
  low.record(false)
  assert.equal(low.retryAfterMs, 900, "1000 × (1 - 0.1)")
  freshNativeDir(t)
  const high = createBreaker({ threshold: 1, cooldownMs: 1_000, now, random: () => 1 })
  high.record(false)
  assert.equal(high.retryAfterMs, 1_100, "1000 × (1 + 0.1)")
  freshNativeDir(t)
  const capped = createBreaker({ threshold: 1, cooldownMs: 100_000_000, now, random: () => 0.5 })
  capped.record(false)
  assert.equal(capped.retryAfterMs, 8 * 60 * 60 * 1_000, "指数部分封顶 8h（零 jitter）")
})

test("半开成功：关闭并清零 consecutiveOpens / failures，退避从头开始", (t) => {
  freshNativeDir(t)
  const { now, advance } = fakeClock()
  const b = createBreaker({ threshold: 2, cooldownMs: 1_000, now, random: ZERO_JITTER })
  b.record(false)
  b.record(false)
  assert.equal(b.open, true)
  advance(1_000)
  assert.equal(b.open, false, "半开放行")
  b.record(false)
  assert.equal(b.open, true)
  assert.equal(b.consecutiveOpens, 1)
  advance(2_000)
  assert.equal(b.open, false)
  b.record(true) // 探测成功 → 关闭清零
  assert.equal(b.open, false)
  assert.equal(b.consecutiveOpens, 0)
  assert.equal(b.failures, 0)
  // 再撞满阈值：全新一轮，冷却回到 base
  b.record(false)
  b.record(false)
  assert.equal(b.open, true)
  assert.equal(b.consecutiveOpens, 0)
  assert.equal(b.retryAfterMs, 1_000)
})

test("持久化 roundtrip：新实例恢复 openedAt / consecutiveOpens / failures 并继续倒数", (t) => {
  const dir = freshNativeDir(t)
  const { now, advance } = fakeClock()
  // 用账号桶：全局桶 "*" 的无 reason 冷却会被 0.8.1 自愈清掉（那是污染残留专用逻辑）
  const a = createBreaker({ bucket: "persist-a", threshold: 1, cooldownMs: 10_000, now, random: ZERO_JITTER })
  a.record(false) // 开闸：consec 0，冷却 10_000
  advance(10_000) // 到期 → 半开
  a.record(false) // 探测失败重开：consec 1，冷却 20_000
  advance(5_000) // 走到一半
  const disk = JSON.parse(readFileSync(join(dir, "breaker-state.json"), "utf8"))
  // 0.8.0：状态文件升为 v2 多桶格式
  assert.equal(disk.version, 2)
  const slot = disk.accounts["persist-a"]
  assert.equal(slot.consecutiveOpens, 1)
  assert.equal(slot.openedAt, 1_010_000)
  assert.equal(slot.failures, 2)
  // 新实例（同目录、同时钟）：恢复状态继续熔断
  const b = createBreaker({ bucket: "persist-a", threshold: 1, cooldownMs: 10_000, now, random: ZERO_JITTER })
  assert.equal(b.open, true, "新实例加载持久化状态仍熔断")
  assert.equal(b.consecutiveOpens, 1)
  assert.equal(b.failures, 2)
  assert.equal(b.retryAfterMs, 15_000, "20_000 - 已流逝 5_000")
  advance(15_000)
  assert.equal(b.open, false, "冷却到期 → 半开放行")
})

test("损坏 JSON 当无状态，后续照常工作", (t) => {
  const dir = freshNativeDir(t)
  writeFileSync(join(dir, "breaker-state.json"), "{oops 不是 json")
  const { now } = fakeClock()
  const b = createBreaker({ threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.equal(b.open, false)
  assert.equal(b.failures, 0)
  b.record(false)
  assert.equal(b.open, true, "按新状态正常开闸")
})

test("openedAt 在未来超过 5 分钟：时钟偏移，整个状态忽略；5 分钟内保留", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock(1_000_000)
  writeFileSync(
    join(dir, "breaker-state.json"),
    JSON.stringify({ version: 2, accounts: { "clock-skew-a": { consecutiveOpens: 2, openedAt: now() + 10 * 60_000, failures: 9 } } }),
  )
  // 用账号桶验证通用时钟逻辑：全局桶 "*" 的残留会被 0.8.1 自愈逻辑清掉（那是另一条测试线）
  const b = createBreaker({ bucket: "clock-skew-a", threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.equal(b.open, false, "未来时间戳忽略")
  assert.equal(b.failures, 9, "时钟偏移只丢弃冷却，失败计数保留")
  const dir2 = freshNativeDir(t)
  writeFileSync(
    join(dir2, "breaker-state.json"),
    JSON.stringify({ version: 2, accounts: { "clock-skew-b": { consecutiveOpens: 0, openedAt: now() + 4 * 60_000, failures: 1 } } }),
  )
  const b2 = createBreaker({ bucket: "clock-skew-b", threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.equal(b2.open, true, "偏移 4 分钟（≤5min）视为有效状态")
})

test("状态总年龄超过冷却上限（8h）视为已关闭", (t) => {
  const dir = freshNativeDir(t)
  const { now } = fakeClock(100_000_000) // 时钟起点要足够大，保证 openedAt 为正
  writeFileSync(
    join(dir, "breaker-state.json"),
    JSON.stringify({ version: 2, accounts: { "stale-age": { consecutiveOpens: 3, openedAt: now() - (8 * 60 * 60 * 1_000 + 1), failures: 5 } } }),
  )
  const b = createBreaker({ bucket: "stale-age", threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.equal(b.open, false)
  assert.equal(b.failures, 5, "过期只丢弃冷却，失败计数保留")
})

test("MARVIS_RISK_THRESHOLD / MARVIS_RISK_COOLDOWN_MS 环境变量覆盖", (t) => {
  freshNativeDir(t)
  process.env.MARVIS_RISK_THRESHOLD = "2"
  process.env.MARVIS_RISK_COOLDOWN_MS = "1234"
  t.after(() => {
    process.env.MARVIS_RISK_THRESHOLD = ""
    process.env.MARVIS_RISK_COOLDOWN_MS = ""
  })
  const { now } = fakeClock()
  const b = createBreaker({ now, random: ZERO_JITTER }) // 不传参 → env 生效
  b.record(false)
  assert.equal(b.open, false, "threshold=2：一次失败不熔断")
  b.record(false)
  assert.equal(b.open, true)
  assert.equal(b.retryAfterMs, 1_234, "cooldown=1234")
})

test("MARVIS_RISK_COOLDOWN_MS=0 禁用熔断（只保留诊断计数）", (t) => {
  freshNativeDir(t)
  process.env.MARVIS_RISK_COOLDOWN_MS = "0"
  t.after(() => {
    process.env.MARVIS_RISK_COOLDOWN_MS = ""
  })
  const { now } = fakeClock()
  const b = createBreaker({ threshold: 1, now, random: ZERO_JITTER })
  for (let i = 0; i < 10; i++) b.record(false)
  assert.equal(b.open, false, "永不开闸")
  assert.equal(b.retryAfterMs, 0)
  assert.equal(b.failures, 10)
  b.record(true)
  assert.equal(b.failures, 0)
})

test("旧签名兼容：不注入 now/random 也能工作（默认 Date.now / Math.random）", (t) => {
  freshNativeDir(t)
  const b = createBreaker({ threshold: 2, cooldownMs: 60_000 })
  b.record(false)
  b.record(false)
  assert.equal(b.open, true)
  assert.ok(b.retryAfterMs > 0 && b.retryAfterMs <= 60_000 * 1.1, "真实随机 jitter 也在 ±10% 内")
  b.record(true)
  assert.equal(b.open, false)
})

test("riskBreaker 单例导出形状兼容（open / retryAfterMs / failures / record / reset）", (t) => {
  freshNativeDir(t)
  assert.equal(typeof riskBreaker.record, "function")
  assert.equal(typeof riskBreaker.reset, "function")
  assert.equal(typeof riskBreaker.open, "boolean")
  assert.equal(typeof riskBreaker.retryAfterMs, "number")
  assert.equal(typeof riskBreaker.failures, "number")
})

test("风险事件流：open → probe-fail → reopen → close，环形缓冲 ≤50", (t) => {
  freshNativeDir(t)
  const { now, advance } = fakeClock()
  const b = createBreaker({ threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
  assert.deepEqual(b.events(), [])
  b.record(false) // open（冷却 1_000）
  advance(1_000)
  b.record(false) // 半开探测失败 → probe-fail + reopen（冷却 2_000）
  advance(2_000)
  b.record(true) // close
  const first = b.events()
  assert.deepEqual(first.map((e) => e.type), ["open", "probe-fail", "reopen", "close"])
  assert.equal(first[0].cooldownMs, 1_000)
  assert.equal(first[1].cooldownMs, 0, "probe-fail 是标记事件，自身不带冷却")
  assert.equal(first[2].cooldownMs, 2_000)
  assert.equal(first[3].cooldownMs, 0)
  assert.ok(first[0].at <= first[1].at && first[1].at <= first[2].at, "at 单调递增")
  // 再循环 60 轮开合 → 环形缓冲封在 50
  for (let i = 0; i < 60; i++) {
    b.record(false)
    advance(1_000)
    b.record(false)
    advance(2_000)
    b.record(true)
  }
  assert.equal(b.events().length, 50)
  assert.deepEqual(b.events(2).map((e) => e.type), ["reopen", "close"])
  assert.deepEqual(b.events(0), [], "limit ≤ 0 返回空")
})

test("riskEvents()：读取进程单例事件视图（与 riskBreaker.events 同源）", (t) => {
  freshNativeDir(t)
  riskBreaker.reset() // 首次访问：惰性加载（当前临时目录无状态）→ close 事件 + 落盘
  const all = riskEvents()
  assert.equal(all.length, 1)
  assert.equal(all[0].type, "close")
  assert.equal(all[0].cooldownMs, 0)
  assert.ok(Number.isFinite(all[0].at))
  assert.equal(riskEvents(1).length, 1)
})

// —— 收尾：删除兜底目录（node --test 每个文件独立进程，env 不影响其他文件）——
test("清理兜底临时目录", () => {
  rmSync(rootDir, { recursive: true, force: true })
  assert.ok(true)
})
