// ⑥ 主动续期 —— 微信「每 2 小时必挂一次」的终结者（0.5.4 新增）
//
// 问题：续期是**被动**的。宿主只在拿到 401 或 refreshLead 到点时才调 auth.refresh，
// 而微信 access_token 只有 2 小时 —— 于是「登录 → 干活 → 2 小时后第一个请求 401
// → 宿主补刷新 → 用户看到一次报错」，每个周期都挂一次。
//
// 思路：请求**前置检查**时顺手看一眼 `auth.expires`，离到期不足 leadMs 就先续掉，
// 请求拿到的永远是新鲜 token。本模块只做判断 + 调续期 + 归一失败，
// **不碰网络策略、不碰锁**（串行由 refreshAccount 里的 createRefreshLock 保证）。
//
// ⚠ 两道防线各管各的，不许混：
//   · needsProactiveRefresh 只回答「现在该不该续」—— 判据就是干净的 `剩余 < leadMs`。
//     不在这里做任何 clamp：拿 remaining/2 当 TTL/2 是自我指涉（remaining 本身随时间变小），
//     数学上永远推不出 true，会把主动续期整个废掉。
//   · 防「超短 TTL 从出生起永远该刷」的刷新风暴，靠 proactiveRefresh 里的
//     **同账号最小续期间隔**（MARVIS_REFRESH_MIN_INTERVAL_MS，默认 1 小时，0 = 关闭）：
//     间隔内的重复调用直接返回 throttled，不发请求。这才是防风暴的正确位置 ——
//     真正快到期时照样放行，绝不因为节流把该续的续期拦死；30 天窗口（见下）下
//     它同时是**实际续期节奏阀**：所有已登录账号都常驻窗口，频率由它决定。
//
// ⚠ 失败语义（与被动路刻意不同）：
//   被动路 refreshAccount 抛 `signIn:"expired"` 是给**宿主**看的 —— 让 magpie 标账号；
//   主动路是插件**自己**发起的，同一信号在主动语境下没有任何用户可见的动作可做，
//   传播出去只会把「提前续期失败」变成「请求直接失败」，比不续还糟。
//   所以这里一律捕获归一：fatal（FATAL_CODES）→ 等下一次真实 401 走宿主正常流程；
//   其他错误（网络等）→ 同样吞掉。主动续期失败**绝不能把账号搞挂** ——
//   轮到我们出手时 token 还没到期，账号此刻仍是可用的。
//
// ⚠ 判断语义：「不知道过期时间」(msUntilExpiry = null) ≠「没过期」。
//   不知道就不猜（false）—— 网关占位账号 expires:0 正是这种，绝不能对它续期。

import { msUntilExpiry } from "../marvis/expiry.mjs"
import { refreshAccount } from "./refresh.mjs"

/**
 * 提前量默认 **30 天**（用户要求「30 天自动续期」）：距到期 30 天内就续，保持常新。
 *
 * 为什么可以这么大胆：
 *   · 30 天 ≥ 微信 TTL（2 小时）也 ≥ QQ TTL（30 天）—— 等价于「登录态永远在窗口内」，
 *     每次节流放行（默认 1 小时）都顺手把它续新；
 *   · 续期是**幂等重置**（实测 access_token 不变、只重置有效期），多续无害；
 *   · 主动失败不抛（fatal/error/throttled 归一返回），账号永远可用。
 *
 * ⚠ 微信 2h TTL 场景下「提前 30 天续」=「从登录那刻起就该续」，这正是想要的常新语义；
 *   防刷爆上游由节流阀（默认 1 小时/账号）保证，与 leadMs 无关。
 * 旧口径（提前 10 分钟）用 MARVIS_REFRESH_LEAD_MS=600000 找回。
 */
export const DEFAULT_LEAD_MS = 30 * 24 * 60 * 60_000

/**
 * 同账号两次主动续期的最小间隔（防风暴 + 30 天窗口下的实际节奏阀）。
 * 可用 MARVIS_REFRESH_MIN_INTERVAL_MS 覆盖，0 = 关闭。
 * 1 小时：微信 2h TTL 一个有效期内至少续到一次，每账号 ≤24 次/天。
 */
export const DEFAULT_MIN_INTERVAL_MS = 60 * 60_000

/** 节流表容量上限：长驻进程里账号再多也不会无限增长（LRU，淘汰最久未续的） */
const THROTTLE_CAP = 200

/**
 * 解析提前量：显式参数 → MARVIS_REFRESH_LEAD_MS → 默认 30 天。
 * 显式参数给 0 表示「只在已过期时才续」；环境变量非法时回退默认，绝不让请求路径抛错。
 * @param {unknown} [leadMs]
 * @returns {number}
 */
function resolveLeadMs(leadMs) {
  if (Number.isFinite(leadMs)) return Math.max(0, Number(leadMs))
  const raw = Number(String(process.env.MARVIS_REFRESH_LEAD_MS ?? "").trim())
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEAD_MS
}

/**
 * 解析最小续期间隔：MARVIS_REFRESH_MIN_INTERVAL_MS（毫秒）。
 * 非法值回退默认 1 小时；0 / 负数 = 关闭节流（测试与极端场景的逃生门）。
 * @returns {number}
 */
function resolveMinIntervalMs() {
  const text = String(process.env.MARVIS_REFRESH_MIN_INTERVAL_MS ?? "").trim()
  // ⚠ 必须先判空：`Number("") === 0` 是有限数，直接用会把「没设置」误判成
  //   「显式设了 0 = 关闭节流」—— 于是默认配置下节流整条失效，刷新风暴照旧。
  if (!text) return DEFAULT_MIN_INTERVAL_MS
  const raw = Number(text)
  if (!Number.isFinite(raw)) return DEFAULT_MIN_INTERVAL_MS
  return raw > 0 ? raw : 0
}

/**
 * 进程级节流表：账号标识前 8 位 → 上次**实际发起**续期的时间。
 * 只记「发过请求」的时机（无论成败）—— 失败重试同样要隔间隔，否则网络抖动会变成风暴。
 * @type {Map<string, number>}
 */
const lastRefreshAt = new Map()

/**
 * 账号节流 key：优先 metadata.openid，回退 uid，最后 access。
 *
 * ⚠ 绝不能截断成前 8 位：openid 短的时候（测试、"gateway-local" 之类的占位值）
 *   前 8 位会**碰撞到同一个桶** —— 一个账号续期后另一个账号被莫名 throttled，
 *   表现为「换了个号还是说在节流」。宁可键长一点，也不能混号。
 * @param {any} auth
 * @returns {string}
 */
function accountKeyOf(auth) {
  const meta = auth?.metadata ?? {}
  return String(meta.openid ?? auth?.uid ?? auth?.access ?? "")
}

/**
 * 节流闸：间隔内 → false（拦下）；放行则记录本次尝试时间并做 LRU 容量控制。
 * @param {string} key
 * @param {number} at 本次尝试时间（可注入）
 * @returns {boolean}
 */
function throttleGate(key, at) {
  const minInterval = resolveMinIntervalMs()
  if (minInterval <= 0) return true // 显式关闭：不拦也不记
  const last = lastRefreshAt.get(key)
  if (last !== undefined && at - last < minInterval) return false
  // 先删再插 = 活跃账号沉底（LRU）；超限淘汰最久未续的，表不无限增长
  if (lastRefreshAt.has(key)) lastRefreshAt.delete(key)
  lastRefreshAt.set(key, at)
  while (lastRefreshAt.size > THROTTLE_CAP) {
    const oldest = lastRefreshAt.keys().next().value
    lastRefreshAt.delete(oldest)
  }
  return true
}

/**
 * 测试专用：清空进程级节流表。真实调用方永远不该用它 ——
 * 节流的意义就在于跨调用记忆，清空只属于用例隔离。
 */
export function resetProactiveThrottle() {
  lastRefreshAt.clear()
}

/**
 * 现在是不是该主动续期了？
 *
 * 判据（全部满足才 true）：
 *   1. 有 refresh token（没有就轮不到我们 —— refreshAccount 会直接返回 {}）；
 *   2. msUntilExpiry 非 null（知道过期时间才谈得上「提前」；「不知道」≠「快到期」）；
 *   3. 剩余 < leadMs —— leadMs 解析顺序：显式参数 → MARVIS_REFRESH_LEAD_MS → 默认 30 天。
 *
 * ⚠ 这里**不做** clamp（见文件头「两道防线」）：防超短 TTL 的刷新风暴是
 *   proactiveRefresh 最小间隔节流的职责，不是判据的职责。
 *
 * @param {any} auth 账号对象
 * @param {{ leadMs?: number, now?: number }} [opts]
 * @returns {boolean}
 */
export function needsProactiveRefresh(auth, { leadMs, now } = {}) {
  if (!auth || typeof auth !== "object") return false
  if (!String(auth.refresh ?? "")) return false

  const ms = msUntilExpiry(auth, now === undefined ? {} : { now })
  if (ms === null) return false

  return ms < resolveLeadMs(leadMs)
}

/**
 * 主动续期：该续就续，失败**绝不向宿主传播**。
 *
 * @param {any} auth 账号对象
 * @param {any} provider magpie 的 provider 上下文（透传给 refreshAccount）
 * @param {{ now?: number, refreshFn?: (auth: any, provider: any) => Promise<any> }} [opts]
 *   `now`：可注入的当前时间（判定 + 节流都用它，测试可控）；
 *   `refreshFn`：默认 refreshAccount，测试可注入假实现。
 * @returns {Promise<
 *   | { refreshed: true, auth: any }
 *   | { refreshed: false, reason: "throttled" | "fatal" | "error" }
 *   | null>}
 *   · null                —— needsProactiveRefresh 为 false（不需要续 / 无从判断），不发请求
 *   · { refreshed:true, auth } —— 续期成功，auth 是**合并后的新账号对象**（可直接落库）
 *   · { refreshed:false, reason:"throttled" } —— 同账号最小间隔内（默认 1 小时）的重复调用，
 *     未发请求；防「超短 TTL 每次检查都刷」的风暴，也是 30 天窗口下的续期节奏阀
 *   · { refreshed:false, reason:"fatal" } —— refreshAccount 判 FATAL_CODES（-107/-101）；
 *     等下一次真实 401 走宿主正常流程
 *   · { refreshed:false, reason:"error" } —— 其他一切失败（网络 / 非 JSON / 非致命业务码）
 */
export async function proactiveRefresh(auth, provider, { now, refreshFn } = {}) {
  if (!needsProactiveRefresh(auth, { now })) return null

  // 节流在判定之后、发请求之前：不需要续的调用永远不该被记成「续过」。
  const at = now === undefined ? Date.now() : now
  if (!throttleGate(accountKeyOf(auth), at)) {
    return { refreshed: false, reason: "throttled" }
  }

  const refresh = typeof refreshFn === "function" ? refreshFn : refreshAccount
  /** @type {any} */
  let fresh
  try {
    fresh = await refresh(auth, provider)
  } catch (err) {
    // FATAL_CODES 判定在 refreshAccount 内部完成：它给错误挂 signIn:"expired"。
    // 主动语境下不向宿主传播 —— 等下一次真实 401 走宿主的正常补刷流程。
    if (err && typeof err === "object" && err.signIn === "expired") {
      return { refreshed: false, reason: "fatal" }
    }
    return { refreshed: false, reason: "error" }
  }

  // 合并成新 auth：refreshAccount 只给「变更字段」（合并语义），
  // 主动续期拿到的应该是完整可落库的对象 —— 调用方直接替换即可。
  const merged = {
    ...auth,
    ...fresh,
    metadata: { ...(auth?.metadata ?? {}), ...(fresh?.metadata ?? {}) },
  }
  return { refreshed: true, auth: merged }
}
