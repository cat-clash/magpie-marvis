// 风控熔断器 —— 4100404 连续命中时停止往上游撞
//
// 依据（issue #71 实测，2026-11-23）：
//   · magpie 宿主对 503/可重试错误的默认策略是连试 7 次 —— 对 4100404 这是**反效果**：
//     账号级自适应节奏风控会被密集请求拉长冷却时间；
//   · 正确做法是 fail-fast：连续命中阈值次后**本地直接拒绝**一段时间，让账号自然冷却。
//
// 可调：
//   MARVIS_RISK_THRESHOLD（默认 5，连续失败达到即熔断）
//   MARVIS_RISK_COOLDOWN_MS（默认 1_800_000，退避基准；设 0 = 禁用熔断）
//
// 状态机（0.6.0 强化）：
//   closed ──连续失败达阈值──> open ──冷却到期──> half-open ──record(true)──> closed
//                              ▲                      │
//                              └─ record(false) 立即重开┘（consecutiveOpens+1，退避翻倍）
//   · 指数退避：冷却 = base * 2^consecutiveOpens，封顶 8h（MAX_COOLDOWN_MS）。
//     consecutiveOpens = 本轮连续熔断中的**重开次数**：首开为 0（冷却 = base，与旧版固定
//     冷却一致）、半开探测失败重开 +1（2×base）、再失败 4×base……record(true) 关闭时清零。
//     默认 30min 基准的完整序列：30min → 1h → 2h → 4h → 8h（封顶）。
//     每次熔断叠加 ±10% 随机 jitter —— 多进程同时开闸会同时苏醒形成请求尖峰，jitter 把
//     苏醒时刻错开（jitter 在熔断时刻一次定死，本轮冷却期内不变，retryAfterMs 稳定可读；
//     进程重启后重算，jitter 重新随机）。封顶作用于指数部分，jitter 叠加其上。
//   · 半开（half-open）：冷却到期后放行探测请求，第一个落地的 record 统一判定 ——
//     record(true) 关闭并清零；record(false) 立即重开、退避翻倍。
//     与旧版差异：旧版冷却结束即清零 failures，要再撞满阈值才重开；新版半开一次失败就重开。
//     已知边界（有意为之）：半开窗口内并发的多个探测请求都会被放行 —— 不做互斥排队，
//     第一个 record 落地时统一判定，其余在途请求的结果按当时状态记账。
//   · 持久化：{ consecutiveOpens, openedAt, failures } 存 <stableDir>/breaker-state.json，
//     stableDir 每次落盘时解析（MARVIS_NATIVE_DIR || ~/.magpie-marvis-native），不缓存 ——
//     测试会改 MARVIS_NATIVE_DIR；首次访问惰性加载。容错：损坏 JSON 当无状态、
//     openedAt 领先当前时刻超过 5 分钟视为时钟偏移（整个状态忽略）、状态总年龄超过冷却
//     上限视为已关闭；写盘 try/catch 静默，绝不影响请求路径；写盘频率 = 每次状态变化。
//   · 熔断按「进程内单例」生效 —— provider id 固定 marvis，多账号共享同一个上游风控域，
//     共享熔断是有意的：一个号被拦，兄弟账号同时时段密集请求同样危险。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const DEFAULT_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 1_800_000
const MAX_COOLDOWN_MS = 8 * 60 * 60 * 1_000 // 指数退避上限 8h
const CLOCK_SKEW_MS = 5 * 60 * 1_000 // openedAt 领先当前时刻超过 5 分钟 = 时钟偏移
const MAX_EVENTS = 50 // 风险事件环形缓冲上限
const JITTER_RATIO = 0.1 // 每次熔断的 ±10% jitter

function intEnv(name, fallback, { allowZero = false } = {}) {
  const raw = Number.parseInt(String(process.env[name] ?? ""), 10)
  const ok = Number.isFinite(raw) && (allowZero ? raw >= 0 : raw > 0)
  return ok ? raw : fallback
}

function clampInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

/** 稳定目录：每次解析、不缓存 —— 测试会改 MARVIS_NATIVE_DIR */
function resolveStableDir() {
  const envDir = process.env.MARVIS_NATIVE_DIR
  if (envDir && envDir.trim()) return envDir
  return join(homedir(), ".magpie-marvis-native")
}

function stateFilePath() {
  return join(resolveStableDir(), "breaker-state.json")
}

export function createBreaker({
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  random = Math.random,
} = {}) {
  threshold = intEnv("MARVIS_RISK_THRESHOLD", threshold)
  // 0 = 禁用熔断（loader 文案早已承诺这个开关，这里真正落实）
  cooldownMs = intEnv("MARVIS_RISK_COOLDOWN_MS", cooldownMs, { allowZero: true })

  // —— 内存状态（loadState 之前均为初始值）——
  let failures = 0 // 连续失败计数
  let consecutiveOpens = 0 // 本轮连续熔断中的重开次数（退避指数，见文件头）
  let openedAt = 0 // 本次熔断起点；0 = 未熔断
  let halfOpen = false // 冷却已到期、等待探测结果
  let activeCooldown = 0 // 本次熔断最终冷却（含 jitter，熔断时刻定死）
  let loaded = false // 持久化状态是否已惰性加载
  const events = [] // 风险事件环形缓冲（纯内存，不落盘）

  /** 退避：base * 2^consecutive，封顶 8h（jitter 叠加在封顶值上） */
  function computeCooldown(consecutive) {
    const capped = Math.min(cooldownMs * 2 ** consecutive, MAX_COOLDOWN_MS)
    const jitter = (random() * 2 - 1) * capped * JITTER_RATIO
    return Math.max(0, capped + jitter)
  }

  function pushEvent(type, cooldownMsValue) {
    events.push({ at: now(), type, cooldownMs: cooldownMsValue })
    if (events.length > MAX_EVENTS) events.shift()
  }

  /** 惰性加载持久化状态；一切异常（损坏 JSON / 目录不存在）都当无状态 */
  function loadState() {
    if (loaded) return
    loaded = true
    try {
      const data = JSON.parse(readFileSync(stateFilePath(), "utf8"))
      if (!data || typeof data !== "object") return
      const opened = Number(data.openedAt)
      if (Number.isFinite(opened) && opened > 0) {
        const age = now() - opened
        if (age < -CLOCK_SKEW_MS || age > MAX_COOLDOWN_MS) {
          // openedAt 领先当前时刻超过 5 分钟（时钟偏移）或状态总年龄超过冷却上限：
          // 整个状态忽略 —— 冷却上限都过了，从零开始
          return
        }
        openedAt = opened
        // activeCooldown 留 0：首次访问时按 consecutiveOpens 重算（重启后 jitter 重新随机）
      }
      consecutiveOpens = clampInt(data.consecutiveOpens)
      failures = clampInt(data.failures)
    } catch {
      /* 损坏 JSON / 目录不存在：当无状态 */
    }
  }

  /** 每次状态变化落盘；失败静默，绝不影响请求路径 */
  function persist() {
    try {
      mkdirSync(resolveStableDir(), { recursive: true })
      writeFileSync(stateFilePath(), JSON.stringify({ consecutiveOpens, openedAt, failures }))
    } catch {
      /* 写盘失败不影响请求路径 */
    }
  }

  /** 冷却是否已到期（到期则跃迁到半开；halfOpen 只在此处置位，不落盘） */
  function expireIfDue() {
    if (!openedAt || halfOpen) return
    if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
    if (now() - openedAt >= activeCooldown) halfOpen = true
  }

  /** 开闸：fromProbe=true 表示半开探测失败触发的重开（退避翻倍） */
  function openBreaker(fromProbe) {
    if (fromProbe) {
      consecutiveOpens += 1
      pushEvent("probe-fail", 0) // 半开探测失败标记（紧随其后的 reopen 事件带新冷却）
    }
    openedAt = now()
    halfOpen = false
    activeCooldown = computeCooldown(consecutiveOpens)
    pushEvent(fromProbe ? "reopen" : "open", activeCooldown)
    persist()
  }

  function closeBreaker() {
    openedAt = 0
    halfOpen = false
    activeCooldown = 0
    failures = 0
    consecutiveOpens = 0
    pushEvent("close", 0)
    persist()
  }

  return {
    /** 熔断是否生效中（未熔断 / 已到期半开 / 已禁用均为 false —— 半开放行探测请求） */
    get open() {
      loadState()
      if (cooldownMs <= 0) return false
      expireIfDue()
      return openedAt > 0 && !halfOpen
    },
    /** 距离熔断解除还剩多少毫秒（未熔断 / 半开 / 禁用时为 0） */
    get retryAfterMs() {
      loadState()
      if (cooldownMs <= 0) return 0
      expireIfDue()
      if (!openedAt || halfOpen) return 0
      if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
      return Math.max(0, activeCooldown - (now() - openedAt))
    },
    /** 连续失败计数（诊断用） */
    get failures() {
      loadState()
      return failures
    },
    /** 本轮连续熔断中的重开次数（诊断用：指数退避的指数，首开后为 0） */
    get consecutiveOpens() {
      loadState()
      return consecutiveOpens
    },
    /**
     * 记录一次结果。`ok=true` 清零（成功即证明账号健康；半开探测成功则关闭并清零）；
     * `ok=false` 累加，达到阈值即熔断；半开窗口内一次失败立即重开（退避翻倍）。
     */
    record(ok) {
      loadState()
      expireIfDue()
      if (cooldownMs <= 0) {
        // 熔断禁用（MARVIS_RISK_COOLDOWN_MS=0）：只保留诊断计数，永不开闸
        if (ok) {
          if (failures !== 0) {
            failures = 0
            persist()
          }
        } else {
          failures += 1
          persist()
        }
        return
      }
      if (ok) {
        if (openedAt || halfOpen) closeBreaker() // 半开探测成功 / 在途请求成功：关闭清零
        else if (failures !== 0) {
          failures = 0
          persist()
        }
        return
      }
      failures += 1
      if (halfOpen) {
        openBreaker(true) // 半开一次失败即重开，不重撞阈值
        return
      }
      if (failures >= threshold && !openedAt) openBreaker(false)
      else persist()
    },
    /** 人为解除（用户改完配置后想立刻重试） */
    reset() {
      loadState()
      closeBreaker()
    },
    /** 最近 limit 条风险事件（内存环形缓冲 ≤50，不落盘；limit ≤ 0 返回空） */
    events(limit = MAX_EVENTS) {
      loadState()
      const n = Math.trunc(Math.min(limit, MAX_EVENTS))
      if (n <= 0) return []
      return events.slice(-n)
    },
  }
}

/** 进程级单例：loader 与 WS 路径共用同一份状态 */
export const riskBreaker = createBreaker()

/** 诊断面板用：进程单例最近 limit 条风险事件（{at, type, cooldownMs}，按时间追加） */
export function riskEvents(limit = MAX_EVENTS) {
  return riskBreaker.events(limit)
}
