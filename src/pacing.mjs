// 出站请求节奏闸 —— 风控看节奏分布，熔断只是止损，节流是预防
//
// 背景（issue #71 后续）：账号级自适应风控按「请求节奏」画像 —— 短时间内的固定间隔
// 连发与尖峰同样可疑。breaker.mjs 只在被拦后止血；本模块把出站请求在**发出前**就
// 拉开最小间隔并叠加随机抖动，让节奏分布更接近人。
//
// 可调（createPacing 未显式传参时的默认来源）：
//   MARVIS_MIN_REQUEST_INTERVAL_MS（默认 800）：相邻两次放行的最小间隔；0 = 关闭间隔闸
//   MARVIS_REQUEST_JITTER_MS（默认 400）：每次放行叠加的随机抖动上限；0 = 关闭抖动
//   两部分相互独立：minMs=0 只关间隔闸，抖动仍生效；jitterMs=0 只关抖动，间隔仍生效。
//
// 语义要点：
//   · pacingWait() **同步占位再异步等待** —— JS 单线程保证占位原子：并发调用方按调用
//     顺序落在同一时间轴上（放行槽位含 jitter），**请求启动间隔不小于 minMs**；
//     但不做互斥队列：每个调用方各睡各的，醒来即出网，互不交接。
//   · 间隔不足时：等待剩余时间（距上次放行不足 minMs 的差额）；每次放行（含首次）另叠加
//     random() * jitterMs 抖动 —— 把固定间隔打散成随机分布，也把进程启动后的第一批请求
//     错开。下一个请求的最早放行 = 本次槽位 + minMs。
//   · 纯内存、零 IO、零依赖。pacingWait() 返回本次实际等待的毫秒数（0 = 立即放行）。
//
// 调用方接线（主控集成）：每次出网补全前 `await pacingWait()`。
//
// 作用域（0.8.0）：
//   MARVIS_PACING_SCOPE=account（默认）—— 每个账号一条独立时间轴。A 号在等间隔时，
//     B 号的请求立刻就能走；一个账号被限流也不会把别的账号拖进慢车道。
//   MARVIS_PACING_SCOPE=global（旧行为）—— 所有账号共用一条时间轴（总出网速率被压平）。
//   无 key 调用（`pacingWait()`）永远落在 `"*"` 桶：account 作用域下它只是「没有账号信息
//   的那几个调用方」的桶，行为与旧版单实例完全一致。

/** 环境变量解析：非负有限数才采纳，否则用 fallback（负数 / 非数 = 没设） */
function numEnv(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] ?? ""))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

const GLOBAL_KEY = "*"

/** 节奏闸作用域：未知值一律当 account（宁可隔离，也不要一个账号拖慢全部） */
export function pacingScope() {
  const v = String(process.env.MARVIS_PACING_SCOPE ?? "").trim().toLowerCase()
  return v === "global" ? "global" : "account"
}

export function createPacing({
  minMs,
  jitterMs,
  now = Date.now,
  random = Math.random,
  sleep,
  scope,
} = {}) {
  // 显式参数优先；未传时才读 env（显式传 0 = 关闭对应部分）
  if (minMs === undefined) minMs = numEnv("MARVIS_MIN_REQUEST_INTERVAL_MS", 800)
  if (jitterMs === undefined) jitterMs = numEnv("MARVIS_REQUEST_JITTER_MS", 400)
  if (scope === undefined) scope = pacingScope()
  minMs = Math.max(0, minMs)
  jitterMs = Math.max(0, jitterMs)
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  // 每个 key 一条时间轴：key = 账号桶；global 作用域下只有 "*" 一条
  const axes = new Map() // key → lastDispatchAt（计划值，含 jitter）
  // axes 无上限累积：长期挂机几百个账号会留下几百条过期时间轴。
  // 超过阈值时做一次过期回收（TTL 默认 1h），只删明显过期的 key，不影响活跃账号。
  const AXES_SOFT_LIMIT = 128
  const AXES_TTL_MS = 60 * 60 * 1000
  function pruneAxes(t) {
    if (axes.size <= AXES_SOFT_LIMIT) return
    for (const [key, last] of axes) {
      if (t - Number(last) > AXES_TTL_MS) axes.delete(key)
    }
  }

  /**
   * 出网前 await：距**该 key 上次放行**不足 minMs 时等到槽位（剩余时间），
   * 并叠加 random()*jitterMs 抖动。
   * 并发安全：同步占位（单线程原子）—— 同一 key 的多调用方按同一时间轴排队，
   * 启动间隔不小于 minMs；不同 key 互不阻塞（account 作用域）。不做互斥队列。
   */
  async function pacingWait(key) {
    const k = scope === "global" ? GLOBAL_KEY : String(key ?? "") || GLOBAL_KEY
    const t = now()
    pruneAxes(t)
    const lastDispatchAt = axes.get(k) ?? null
    const remaining =
      minMs > 0 && lastDispatchAt !== null ? Math.max(0, lastDispatchAt + minMs - t) : 0
    const jitter = jitterMs > 0 ? random() * jitterMs : 0
    const waitMs = remaining + jitter
    axes.set(k, t + waitMs) // 同步占位（含 jitter）
    if (waitMs > 0) await doSleep(waitMs)
    return waitMs
  }

  /** 当前节奏状态（诊断面板用）：lastDispatchAt / nextFreeAt 为 0 表示尚未放行 / 无间隔闸 */
  function pacingStatus(key) {
    const k = scope === "global" ? GLOBAL_KEY : String(key ?? "") || GLOBAL_KEY
    const raw = axes.get(k)
    const last = raw ?? 0
    return {
      minMs,
      jitterMs,
      scope,
      key: k,
      lastDispatchAt: last,
      nextFreeAt: minMs > 0 && raw !== undefined ? last + minMs : 0,
      activeKeys: axes.size,
    }
  }

  return { pacingWait, pacingStatus, scope }
}

// —— 进程级默认单例：惰性读 env，第一次调用时定型（之后改 env 不再生效）——

let singleton = null

function defaultPacing() {
  if (!singleton) singleton = createPacing()
  return singleton
}

/**
 * 出站请求节奏闸（进程单例，按账号分时间轴）：
 * 每次出网补全前 `await pacingWait(accountKey)`；不传 key = `"*"` 桶（旧行为）。
 */
export const pacingWait = async (key) => defaultPacing().pacingWait(key)

/** 进程单例节奏状态：{ minMs, jitterMs, scope, key, lastDispatchAt, nextFreeAt, activeKeys } */
export const pacingStatus = (key) => defaultPacing().pacingStatus(key)
