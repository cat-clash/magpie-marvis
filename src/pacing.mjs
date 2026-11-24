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

/** 环境变量解析：非负有限数才采纳，否则用 fallback（负数 / 非数 = 没设） */
function numEnv(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] ?? ""))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function createPacing({ minMs, jitterMs, now = Date.now, random = Math.random, sleep } = {}) {
  // 显式参数优先；未传时才读 env（显式传 0 = 关闭对应部分）
  if (minMs === undefined) minMs = numEnv("MARVIS_MIN_REQUEST_INTERVAL_MS", 800)
  if (jitterMs === undefined) jitterMs = numEnv("MARVIS_REQUEST_JITTER_MS", 400)
  minMs = Math.max(0, minMs)
  jitterMs = Math.max(0, jitterMs)
  const doSleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  let lastDispatchAt = null // 上次放行时刻（计划值，含 jitter）；null = 尚未放行

  /**
   * 出网前 await：距上次放行不足 minMs 时等到槽位（剩余时间），并叠加 random()*jitterMs 抖动。
   * 并发安全：同步占位（单线程原子）—— 多调用方按同一时间轴排队，启动间隔不小于 minMs；
   * 不做互斥队列：各调用方独立睡眠、醒来即出网。
   */
  async function pacingWait() {
    const t = now()
    const remaining =
      minMs > 0 && lastDispatchAt !== null ? Math.max(0, lastDispatchAt + minMs - t) : 0
    const jitter = jitterMs > 0 ? random() * jitterMs : 0
    const waitMs = remaining + jitter
    lastDispatchAt = t + waitMs // 同步占位（含 jitter）
    if (waitMs > 0) await doSleep(waitMs)
    return waitMs
  }

  /** 当前节奏状态（诊断面板用）：lastDispatchAt / nextFreeAt 为 0 表示尚未放行 / 无间隔闸 */
  function pacingStatus() {
    const last = lastDispatchAt ?? 0
    return {
      minMs,
      jitterMs,
      lastDispatchAt: last,
      nextFreeAt: minMs > 0 && lastDispatchAt !== null ? last + minMs : 0,
    }
  }

  return { pacingWait, pacingStatus }
}

// —— 进程级默认单例：惰性读 env，第一次调用时定型（之后改 env 不再生效）——

let singleton = null

function defaultPacing() {
  if (!singleton) singleton = createPacing()
  return singleton
}

/** 出站请求节奏闸（进程单例）：每次出网补全前 await pacingWait() */
export const pacingWait = async () => defaultPacing().pacingWait()

/** 进程单例节奏状态：{ minMs, jitterMs, lastDispatchAt, nextFreeAt } */
export const pacingStatus = () => defaultPacing().pacingStatus()
