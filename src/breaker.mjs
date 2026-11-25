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
//   · 熔断按**账号分桶**（0.8.0 起，MARVIS_RISK_SCOPE=account 为默认）——
//     一个号被 4100404 拦住只冷却这个号，兄弟账号照常出网。
//     旧行为（所有账号共享一个闸）用 MARVIS_RISK_SCOPE=global 找回；
//     MARVIS_RISK_SCOPE=off 后退到「一个账号一个桶但永不互相影响」，等价 account。
//
//     为什么改：magpie 壳一次请求只传**当前选中的那一个账号**（loader 的 credsOf(auth)），
//     插件侧本来就没有账号池；原来的进程单例让「个别账号被限流」变成「所有账号一起停」，
//     这正是用户抱怨的点。分桶后每个账号各有一条独立的失败计数 / 冷却 / 退避链。
//
//   · 跨账号共因闸（保留原保护，0.8.0 新增）：分桶之后还剩一个风险 —— 如果**多个不同
//     账号**在短时间内先后被 4100404 拦住，说明拦的不是账号而是通道（IP / UA / uskey /
//     上游节点）。此时自动把 `"*"` 全局桶也打开，等于回到旧的「全停」行为。
//     MARVIS_RISK_CONSENSUS（默认 2，设 0 = 关闭共因闸）：窗口内被拦的不同账号数达到它才开；
//     MARVIS_RISK_WINDOW_MS（默认 600000 = 10min）：判定窗口。
//
//   · 持久化形状升到 v2（0.8.0）：{ version: 2, accounts: { [bucket]: {label?, consecutiveOpens,
//     openedAt, failures} } }。读到 v1 扁平格式（无 version/accounts）时整体归入 `"*"` 桶 ——
//     老用户的已有冷却不会因为升级而丢失。bucket 是账号标识的短哈希（见 accountKeyOf），
//     不落 openid 明文；label 只存脱敏后的可读标签，供 CLI 与报错文案使用。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

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

const DEFAULT_CONSENSUS = 2 // 窗口内被拦的**不同账号**数达到几个才判定为通道级封锁
const DEFAULT_CONSENSUS_WINDOW_MS = 10 * 60 * 1_000 // 共因判定窗口
const GLOBAL_BUCKET = "*" // 全局桶 / 未指定账号时的退化桶

/**
 * 熔断作用域（0.8.0）：
 *   account（默认）= 按账号分桶，一个号被拦只冷却这个号
 *   global        = 旧行为，所有账号共用一个闸
 * 未知值一律当 account（宁可隔离过度，也不要一个号拖垮全部）。
 */
export function riskScope() {
  const v = String(process.env.MARVIS_RISK_SCOPE ?? "").trim().toLowerCase()
  return v === "global" ? "global" : "account"
}

/** 共因闸配置：n=0 表示关闭（分桶后永不自动升级为全局冷却） */
function consensusConfig() {
  return {
    n: intEnv("MARVIS_RISK_CONSENSUS", DEFAULT_CONSENSUS, { allowZero: true }),
    windowMs: intEnv("MARVIS_RISK_WINDOW_MS", DEFAULT_CONSENSUS_WINDOW_MS),
  }
}

/**
 * 账号 → 桶 key：稳定短哈希，不落 openid 明文。
 * 没有凭据时退化为全局桶（这种账号本来也发不出请求，共用一个闸不会误伤别人）。
 */
export function accountKeyOf(creds) {
  const raw = String(creds?.openid ?? creds?.uid ?? creds?.accountId ?? "").trim()
  if (!raw) return GLOBAL_BUCKET
  return createHash("sha256").update(raw).digest("hex").slice(0, 12)
}

/** 账号 → 可读标签（脱敏：首 4 + 尾 4），只用于 CLI 列表与报错文案 */
export function accountLabelOf(creds) {
  const raw = String(creds?.openid ?? creds?.uid ?? creds?.accountId ?? "").trim()
  if (!raw) return "未指定账号"
  return raw.length <= 10 ? raw : `${raw.slice(0, 4)}…${raw.slice(-4)}`
}

/** 读整份状态（v2 多桶 / v1 扁平兼容）；一切异常都当空 */
function readState() {
  try {
    const data = JSON.parse(readFileSync(stateFilePath(), "utf8"))
    if (!data || typeof data !== "object") return {}
    if (data.version === 2 && data.accounts && typeof data.accounts === "object") {
      const out = {}
      for (const [k, v] of Object.entries(data.accounts)) {
        if (v && typeof v === "object") out[k] = v
      }
      return out
    }
    // v1（扁平单账号格式）：整体归入全局桶 —— 老用户的冷却不会因升级丢失
    if ("consecutiveOpens" in data || "openedAt" in data || "failures" in data) {
      return { [GLOBAL_BUCKET]: data }
    }
    return {}
  } catch {
    return {}
  }
}

/** 写整份状态（v2） */
function writeState(accounts) {
  try {
    mkdirSync(resolveStableDir(), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify({ version: 2, accounts }))
  } catch {
    /* 写盘失败不影响请求路径 */
  }
}

/** 状态文件路径（CLI / 诊断打印用） */
export function breakerStatePath() {
  return stateFilePath()
}

/** 诊断 / CLI：列出所有桶 {bucket, label, failures, openedAt, consecutiveOpens, retryAfterMs} */
export function breakerBuckets(nowMs = Date.now()) {
  const all = readState()
  return Object.entries(all).map(([bucket, s]) => {
    const openedAt = clampInt(s.openedAt)
    const failures = clampInt(s.failures)
    const consecutiveOpens = clampInt(s.consecutiveOpens)
    const base = intEnv("MARVIS_RISK_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, { allowZero: true })
    let retryAfterMs = 0
    if (openedAt > 0 && base > 0) {
      const capped = Math.min(base * 2 ** consecutiveOpens, MAX_COOLDOWN_MS)
      retryAfterMs = Math.max(0, capped - (nowMs - openedAt))
    }
    return {
      bucket,
      label: typeof s.label === "string" && s.label ? s.label : bucket === GLOBAL_BUCKET ? "全局" : bucket,
      failures,
      consecutiveOpens,
      openedAt,
      retryAfterMs,
    }
  })
}

/**
 * @param {object} [opts]
 * @param {string} [opts.bucket] 账号桶 key（默认全局桶 `"*"`；见 accountKeyOf）
 * @param {string} [opts.label]  可读标签（脱敏账号名），随状态落盘供 CLI 展示
 * @param {(info:{bucket:string,at:number}) => void} [opts.onOpen]
 *        开闸回调（只在**失败触发**的开闸时调用，`trip()` 不触发）—— 共因闸挂在这里
 */
export function createBreaker({
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  random = Math.random,
  bucket = GLOBAL_BUCKET,
  label = "",
  onOpen,
} = {}) {
  threshold = intEnv("MARVIS_RISK_THRESHOLD", threshold)
  // 0 = 禁用熔断（loader 文案早已承诺这个开关，这里真正落实）
  cooldownMs = intEnv("MARVIS_RISK_COOLDOWN_MS", cooldownMs, { allowZero: true })
  bucket = String(bucket || GLOBAL_BUCKET)

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
      const data = readState()[bucket]
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

  /** 每次状态变化落盘（只改自己这个桶，其余桶原样保留）；失败静默，绝不影响请求路径 */
  function persist() {
    const all = readState()
    const entry = { consecutiveOpens, openedAt, failures }
    if (label) entry.label = label
    else if (all[bucket]?.label) entry.label = all[bucket].label
    all[bucket] = entry
    writeState(all)
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
    // 共因闸挂点：只在失败触发的开闸上报（trip() 本身不回调，避免自我递归）
    if (typeof onOpen === "function") {
      try {
        onOpen({ bucket, at: openedAt })
      } catch {
        /* 回调失败不影响熔断本身 */
      }
    }
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
    /**
     * 外部开闸（0.8.0）：不算失败、不递增退避链，只为「不是这个账号的问题」的判定
     * （跨账号共因 / 通道级封锁）套一层冷却。已在冷却中则不改动。
     * 注意：不触发 onOpen 回调，避免共因闸自我递归。
     */
    trip(reason = "external") {
      loadState()
      expireIfDue()
      if (cooldownMs <= 0) return
      if (openedAt && !halfOpen) return // 已在冷却：保留原冷却与退避链
      openedAt = now()
      halfOpen = false
      activeCooldown = computeCooldown(consecutiveOpens)
      pushEvent(String(reason) || "external", activeCooldown)
      persist()
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

// —— 进程级按账号分桶的池（0.8.0）：一个账号一条独立的失败/冷却/退避链 ——

const pool = new Map() // bucket → breaker 实例
const labels = new Map() // bucket → 可读标签（CLI 列表与报错文案用）
const tripLog = [] // { bucket, at }：共因判定窗口内的开闸记录

/**
 * 共因判定：MARVIS_RISK_WINDOW_MS 内**不同账号**开闸数 ≥ MARVIS_RISK_CONSENSUS 时，
 * 判定拦的不是账号而是通道（IP / UA / uskey / 上游节点），把全局桶也打开。
 * 分桶带来的新风险正好被这一层兜住。
 */
function noteBucketTrip(bucketName) {
  if (bucketName === GLOBAL_BUCKET) return
  const { n, windowMs } = consensusConfig()
  if (n <= 0) return // 共因闸关闭：纯分桶
  const t = Date.now()
  tripLog.push({ bucket: bucketName, at: t })
  while (tripLog.length && t - tripLog[0].at > windowMs) tripLog.shift()
  if (new Set(tripLog.map((e) => e.bucket)).size < n) return
  tripLog.length = 0
  getBreaker(GLOBAL_BUCKET, "跨账号共因").trip("cross-account")
}

/**
 * 取某个账号桶的熔断器（惰性创建，进程内复用）。
 * `bucket` 用 accountKeyOf(creds)；`label` 传 accountLabelOf(creds) 便于 CLI 显示；
 * `opts` 只在该桶**首次创建**时透传给 createBreaker（threshold / cooldownMs / now / random，
 * 测试与自定义装配用；onOpen 由池统一接管，不可覆盖）。
 */
export function getBreaker(bucket = GLOBAL_BUCKET, label = "", opts = {}) {
  const key = String(bucket || GLOBAL_BUCKET)
  if (label) labels.set(key, label)
  let b = pool.get(key)
  if (!b) {
    b = createBreaker({
      ...opts,
      bucket: key,
      label: labels.get(key) ?? "",
      onOpen: () => noteBucketTrip(key), // 放在最后：池统一接管共因上报
    })
    pool.set(key, b)
  }
  return b
}

/** 人为解除所有桶的冷却（CLI `breaker reset --all`） */
export function resetAllBreakers() {
  const keys = new Set([...Object.keys(readState()), ...pool.keys()])
  for (const k of keys) getBreaker(k).reset()
  tripLog.length = 0
  return keys.size
}

/** 兼容导出：全局桶实例（旧的进程单例语义；account 作用域下它只在共因闸/无凭据时生效） */
export const riskBreaker = getBreaker(GLOBAL_BUCKET)

/** 诊断面板用：全局桶最近 limit 条风险事件（{at, type, cooldownMs}，按时间追加） */
export function riskEvents(limit = MAX_EVENTS) {
  return riskBreaker.events(limit)
}

/** 诊断面板用：指定账号桶最近 limit 条风险事件 */
export function riskEventsOf(bucket = GLOBAL_BUCKET, limit = MAX_EVENTS) {
  return getBreaker(bucket).events(limit)
}
