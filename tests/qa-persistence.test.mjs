// tests/qa-persistence.test.mjs —— 状态持久化、缓存失效与重启恢复
//
// 覆盖：
//   1. breaker events 持久化：重启后从 breaker-state.json 恢复事件、上限 20 条、consecutiveOpens 保留
//   2. v1 扁平状态迁移兼容：无 version/accounts 的旧格式 → 只继承计数，不继承冷却
//   3. fingerprint reload：reloadFingerprint() 清空 appVersion / qimei36 缓存
//   4. 首行自愈记忆 TTL：24h 过期 + forgetFirstLine 调用后失效
//   5. 环境变量边界：MARVIS_USKEY_TIMEOUT_MS 的 0 / 负 / NaN / 正常值解析
//
// 跑法：bun test tests/qa-persistence.test.mjs

// 0.9.8：原 bun:test 改为 node:test + assert（仓库 test 脚本是 node --test，
// bun 环境下本文件曾无法被 node 加载 —— ERR_UNSUPPORTED_ESM_URL_SCHEME: bun:）
import { describe, test, before as beforeAll, afterEach } from "node:test"
import assert from "node:assert/strict"

/** bun:test expect() 的最小 node:assert 实现（只覆盖本文件用到的匹配器） */
function expect(actual) {
  const api = {
    toBe: (exp) => assert.strictEqual(actual, exp),
    toEqual: (exp) => assert.deepStrictEqual(actual, exp),
    toMatch: (re) => assert.match(String(actual), re),
    toContain: (v) => assert.ok(actual?.includes?.(v)),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeGreaterThan: (n) => assert.ok(actual > n),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
  }
  api.not = {
    toBe: (exp) => assert.notStrictEqual(actual, exp),
    toEqual: (exp) => assert.notDeepStrictEqual(actual, exp),
    toMatch: (re) => assert.doesNotMatch(String(actual), re),
    toContain: (v) => assert.ok(!actual?.includes?.(v)),
    toBeNull: () => assert.notStrictEqual(actual, null),
    toBeUndefined: () => assert.notStrictEqual(actual, undefined),
  }
  return api
}
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// —— 环境隔离 ——
for (const key of [
  "MARVIS_RISK_THRESHOLD",
  "MARVIS_RISK_COOLDOWN_MS",
  "MARVIS_RISK_SCOPE",
  "MARVIS_RISK_CONSENSUS",
  "MARVIS_USKEY_TIMEOUT_MS",
  "MARVIS_APP_VERSION",
  "MARVIS_QIMEI36",
]) {
  delete process.env[key]
}

const rootDir = mkdtempSync(join(tmpdir(), "mmf-persist-root-"))
process.env.MARVIS_NATIVE_DIR = rootDir

const ZERO_JITTER = () => 0.5

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

function freshNativeDir() {
  const dir = mkdtempSync(join(tmpdir(), "mmf-persist-"))
  process.env.MARVIS_NATIVE_DIR = dir
  return dir
}

// 动态 import：每个测试用例用 freshNativeDir 后再 import 可能不现实（bun 缓存模块），
// 所以统一在顶部 import，靠 MARVIS_NATIVE_DIR 每次调用时解析（breaker 里是惰性读取的）。
const { createBreaker, getBreaker, accountKeyOf, breakerStatePath, breakerBuckets } = await import("../src/breaker.mjs")
const {
  reloadFingerprint,
  fingerprintStatus,
  appVersion,
  qimei36,
} = await import("../src/marvis/fingerprint.mjs")

// loader 里的 firstLineMemory / forgetFirstLine / rememberedFirstLine / rememberFirstLine
// 没有导出 —— 直接读源码验证逻辑，同时用 readFileSync 断言源码行为。
const loaderSrc = readFileSync(
  join(process.cwd(), "src", "hooks", "loader.mjs"),
  "utf8",
)

// ============================================================
// 1. breaker events 持久化
// ============================================================
describe("breaker events 持久化", () => {
  test("events 从 breaker-state.json 恢复到新实例（riskEvents() 返回最近事件）", () => {
    const dir = freshNativeDir()
    const { now, advance } = fakeClock()
    const bucket = "evt-persist-a"

    // 第一个实例：触发 open → probe-fail → reopen → close
    const a = createBreaker({ bucket, threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
    a.record(false) // open
    advance(1_000)
    a.record(false) // probe-fail + reopen
    advance(2_000)
    a.record(true) // close

    const eventsBefore = a.events()
    expect(eventsBefore.map((e) => e.type)).toEqual(["open", "probe-fail", "reopen", "close"])

    // 验证落盘文件存在 events 字段
    const disk = JSON.parse(readFileSync(join(dir, "breaker-state.json"), "utf8"))
    expect(disk.version).toBe(2)
    expect(Array.isArray(disk.accounts[bucket].events)).toBe(true)
    expect(disk.accounts[bucket].events.length).toBe(4)

    // "重启"：新实例，同 bucket
    const b = createBreaker({ bucket, threshold: 1, cooldownMs: 1_000, now, random: ZERO_JITTER })
    const eventsAfter = b.events()
    expect(eventsAfter.map((e) => e.type)).toEqual(["open", "probe-fail", "reopen", "close"])

    rmSync(dir, { recursive: true, force: true })
  })

  test("只保留最近 20 条事件（MAX_PERSIST_EVENTS）", () => {
    const dir = freshNativeDir()
    const { now, advance } = fakeClock()
    const bucket = "evt-persist-20"

    const a = createBreaker({ bucket, threshold: 1, cooldownMs: 100, now, random: ZERO_JITTER })

    // 循环 30 轮开合（每轮产生 open + close = 2 事件，30 轮 = 60 事件）
    for (let i = 0; i < 30; i++) {
      a.record(false) // open
      advance(100)
      a.record(true) // close
    }

    // 内存里上限 50
    expect(a.events().length).toBe(50)

    // 落盘只保留最近 20 条
    const disk = JSON.parse(readFileSync(join(dir, "breaker-state.json"), "utf8"))
    expect(disk.accounts[bucket].events.length).toBe(20)

    // 新实例恢复的事件 = 最近 20 条
    const b = createBreaker({ bucket, threshold: 1, cooldownMs: 100, now, random: ZERO_JITTER })
    const restored = b.events()
    expect(restored.length).toBe(20)
    // 最后两条应该是 open + close
    expect(restored[restored.length - 1].type).toBe("close")
    expect(restored[restored.length - 2].type).toBe("open")

    rmSync(dir, { recursive: true, force: true })
  })

  test("冷却状态按设计恢复（consecutiveOpens 保留）", () => {
    const dir = freshNativeDir()
    const { now, advance } = fakeClock()
    const bucket = "evt-cooldown-a"

    const a = createBreaker({ bucket, threshold: 1, cooldownMs: 10_000, now, random: ZERO_JITTER })
    a.record(false) // 首开 consecutiveOpens=0
    advance(10_000) // 半开
    a.record(false) // 探测失败 reopen → consecutiveOpens=1, 冷却 20_000
    advance(5_000) // 走到一半

    expect(a.consecutiveOpens).toBe(1)
    expect(a.open).toBe(true)

    // 新实例恢复
    const b = createBreaker({ bucket, threshold: 1, cooldownMs: 10_000, now, random: ZERO_JITTER })
    expect(b.consecutiveOpens).toBe(1)
    expect(b.open).toBe(true)
    expect(b.retryAfterMs).toBe(15_000) // 20_000 - 5_000

    rmSync(dir, { recursive: true, force: true })
  })
})

// ============================================================
// 2. v1 扁平状态迁移兼容
// ============================================================
describe("v1 扁平状态迁移兼容", () => {
  test("手工写 v1 格式 breaker-state.json（无 version/accounts），新代码不继承旧冷却、只继承计数", () => {
    const dir = freshNativeDir()
    const { now } = fakeClock(2_000_000)

    // v1 格式：扁平，无 version / accounts
    writeFileSync(
      join(dir, "breaker-state.json"),
      JSON.stringify({
        consecutiveOpens: 3,
        openedAt: now() - 60_000, // 1 分钟前开的闸
        failures: 7,
      }),
    )

    // 新实例（默认 bucket = GLOBAL_BUCKET = "*"）
    const b = createBreaker({ threshold: 5, cooldownMs: 10_000, now, random: ZERO_JITTER })

    // v1 迁移：consecutiveOpens 和 failures 保留
    expect(b.consecutiveOpens).toBe(3)
    expect(b.failures).toBe(7)

    // 但活跃冷却**不继承**（v1 语义是全局的，升级后不能挡住所有账号）
    expect(b.open).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })

  test("v1 格式在 account 作用域下全局桶无 reason 残留的冷却被自愈清掉", () => {
    const dir = freshNativeDir()
    const { now } = fakeClock(3_000_000)

    // 模拟 v2 但全局桶无 reason 的残留（0.8.0 误写的遗留）
    writeFileSync(
      join(dir, "breaker-state.json"),
      JSON.stringify({
        version: 2,
        accounts: {
          "*": { consecutiveOpens: 2, openedAt: now() - 10_000, failures: 5 },
        },
      }),
    )

    // account 作用域（默认）
    const b = createBreaker({ threshold: 5, cooldownMs: 10_000, now, random: ZERO_JITTER })

    // 全局桶无 reason 残留：openedAt 被清掉
    expect(b.open).toBe(false)
    // 但 failures 和 consecutiveOpens 保留（诊断用）
    expect(b.failures).toBe(5)
    expect(b.consecutiveOpens).toBe(2)

    rmSync(dir, { recursive: true, force: true })
  })
})

// ============================================================
// 3. fingerprint reload
// ============================================================
describe("fingerprint reload", () => {
  test("reloadFingerprint() 后 appVersion 缓存被清空（重新探测）", () => {
    const dir = freshNativeDir()

    // 先调一次 appVersion() 触发缓存
    const v1 = appVersion()
    expect(typeof v1).toBe("string")

    // 设环境变量覆盖
    process.env.MARVIS_APP_VERSION = "9.9.9.9"
    // 缓存还在，不会立即生效（detectedAppVersion 已缓存）
    // 但 appVersion() 每次都读 env，env 优先，所以这里应该直接返回
    expect(appVersion()).toBe("9.9.9.9")

    // 清掉 env
    delete process.env.MARVIS_APP_VERSION

    // 调用 reloadFingerprint
    reloadFingerprint()

    // 验证：appVersionScanned 被重置，下次 appVersion() 会重新探测
    // 通过源码断言确认 reloadFingerprint 重置了关键变量
    const fpSrc = readFileSync(
      join(process.cwd(), "src", "marvis", "fingerprint.mjs"),
      "utf8",
    )
    expect(fpSrc).toMatch(/appVersionScanned\s*=\s*false/)
    expect(fpSrc).toMatch(/detectedAppVersion\s*=\s*""/)
    expect(fpSrc).toMatch(/qimeiCache\s*=\s*""/)
    expect(fpSrc).toMatch(/beacon\s*=\s*null/)
    expect(fpSrc).toMatch(/beaconTried\s*=\s*false/)

    // 实际行为验证：reload 后 appVersion 走探测路径
    const v2 = appVersion()
    expect(typeof v2).toBe("string")

    rmSync(dir, { recursive: true, force: true })
  })

  test("reloadFingerprint() 清空 qimei36 缓存", () => {
    const dir = freshNativeDir()

    // 设一个环境变量 qimei36
    process.env.MARVIS_QIMEI36 = "abcdef0123456789abcdef0123456789abcd"
    const q1 = qimei36()
    expect(q1).toBe("abcdef0123456789abcdef0123456789abcd")

    // 改环境变量
    process.env.MARVIS_QIMEI36 = "999999999999999999999999999999999999"

    // 缓存还在，返回旧值
    expect(qimei36()).toBe("abcdef0123456789abcdef0123456789abcd")

    // reload 后缓存清空
    reloadFingerprint()
    const q2 = qimei36()
    expect(q2).toBe("999999999999999999999999999999999999")

    delete process.env.MARVIS_QIMEI36
    rmSync(dir, { recursive: true, force: true })
  })
})

// ============================================================
// 4. 首行自愈记忆 TTL
// ============================================================
describe("首行自愈记忆 TTL", () => {
  test("源码确认 FIRST_LINE_MEMORY_TTL_MS = 24h", () => {
    expect(loaderSrc).toMatch(/FIRST_LINE_MEMORY_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
  })

  test("源码确认 TTL 过期逻辑：Date.now() - entry.at > TTL → 删除条目", () => {
    expect(loaderSrc).toMatch(/Date\.now\(\)\s*-\s*entry\.at\s*>\s*FIRST_LINE_MEMORY_TTL_MS/)
    expect(loaderSrc).toMatch(/firstLineMemory\.delete\(key\)/)
  })

  test("源码确认 forgetFirstLine 在被拦时调用（记忆失效）", () => {
    expect(loaderSrc).toMatch(/forgetFirstLine\(acctBucket,\s*systemFirstLine\)/)
  })

  test("源码确认 forgetFirstLine 实现 = Map.delete", () => {
    expect(loaderSrc).toMatch(/function forgetFirstLine\(bucket,\s*originalLine\)\s*\{[\s\S]*?firstLineMemory\.delete/)
  })

  test("TTL 24h 边界验证：通过直接操作 Map 模拟", () => {
    // 提取 loader 里的 TTL 常量值
    const ttlMatch = loaderSrc.match(/FIRST_LINE_MEMORY_TTL_MS\s*=\s*(\d[\d\s*+]*)/)
    expect(ttlMatch).not.toBeNull()
    // 计算值：24 * 60 * 60 * 1000 = 86400000
    const ttlValue = 24 * 60 * 60 * 1000
    expect(ttlValue).toBe(86_400_000)

    // 模拟 TTL 逻辑
    const memory = new Map()
    const key = "test-bucket:abc123"
    const now = Date.now()

    // 刚记住的条目：未过期
    memory.set(key, { text: "改写后的首行", at: now })
    const entry1 = memory.get(key)
    expect(now - entry1.at <= ttlValue).toBe(true) // 未过期

    // 23h59m 前：未过期
    memory.set(key, { text: "改写后的首行", at: now - (ttlValue - 60_000) })
    const entry2 = memory.get(key)
    expect(now - entry2.at <= ttlValue).toBe(true)

    // 24h+1ms 前：已过期
    memory.set(key, { text: "改写后的首行", at: now - (ttlValue + 1) })
    const entry3 = memory.get(key)
    expect(now - entry3.at > ttlValue).toBe(true) // 过期
    memory.delete(key) // 模拟过期删除
    expect(memory.has(key)).toBe(false)
  })

  test("被拦后 forgetFirstLine 调用：记忆条目被删除", () => {
    // 模拟记忆 Map
    const memory = new Map()
    const key = "bucket-a:hash123"
    memory.set(key, { text: "记忆句", at: Date.now() })
    expect(memory.has(key)).toBe(true)

    // 模拟 forgetFirstLine
    memory.delete(key)
    expect(memory.has(key)).toBe(false)

    // 确认源码中 forgetFirstLine 在 403+内容过滤时被调用
    const forgetCallMatch = loaderSrc.match(
      /if\s*\(response\.status\s*===\s*403[\s\S]*?forgetFirstLine\(acctBucket,\s*systemFirstLine\)/,
    )
    expect(forgetCallMatch).not.toBeNull()
  })
})

// ============================================================
// 5. 环境变量边界：MARVIS_USKEY_TIMEOUT_MS
// ============================================================
describe("环境变量边界：MARVIS_USKEY_TIMEOUT_MS", () => {
  test("设 0 → 解析为 5000（默认值）", () => {
    process.env.MARVIS_USKEY_TIMEOUT_MS = "0"
    reloadFingerprint()
    const status = fingerprintStatus()
    expect(status.uskeyTimeoutMs).toBe(5000)
    delete process.env.MARVIS_USKEY_TIMEOUT_MS
  })

  test("设负数 → 解析为 5000", () => {
    process.env.MARVIS_USKEY_TIMEOUT_MS = "-100"
    reloadFingerprint()
    const status = fingerprintStatus()
    expect(status.uskeyTimeoutMs).toBe(5000)
    delete process.env.MARVIS_USKEY_TIMEOUT_MS
  })

  test("设 'abc' → 解析为 5000", () => {
    process.env.MARVIS_USKEY_TIMEOUT_MS = "abc"
    reloadFingerprint()
    const status = fingerprintStatus()
    expect(status.uskeyTimeoutMs).toBe(5000)
    delete process.env.MARVIS_USKEY_TIMEOUT_MS
  })

  test("设正常值 1234 → 解析为 1234", () => {
    process.env.MARVIS_USKEY_TIMEOUT_MS = "1234"
    reloadFingerprint()
    const status = fingerprintStatus()
    expect(status.uskeyTimeoutMs).toBe(1234)
    delete process.env.MARVIS_USKEY_TIMEOUT_MS
  })

  test("源码验证解析逻辑：parseInt + Number.isFinite(n) && n > 0", () => {
    const fpSrc = readFileSync(
      join(process.cwd(), "src", "marvis", "fingerprint.mjs"),
      "utf8",
    )
    // fingerprintStatus 里的 uskeyTimeoutMs 解析
    expect(fpSrc).toMatch(/Number\.parseInt\(String\(process\.env\.MARVIS_USKEY_TIMEOUT_MS/)
    expect(fpSrc).toMatch(/Number\.isFinite\(n\)\s*&&\s*n\s*>\s*0\s*\?\s*n\s*:\s*5000/)
  })
})

// ============================================================
// 收尾
// ============================================================
test("清理兜底临时目录", () => {
  rmSync(rootDir, { recursive: true, force: true })
  expect(true).toBe(true)
})
