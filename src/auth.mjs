// auth 对象装配 —— 各钩子摆到一起
//
// 数据字段（不是钩子，但决定 UI）：
//   icon           两处必须一致：这里 + package.json 的 magpie.icon
//   maxConcurrency 实测上限 8：8 并发 / 9 秒跑完 8 发、15 发 1 秒间隔全 200；uskey 已按请求现签，不再抢配额
//   refreshLead    距到期多久开始调 refresh（默认 5 分钟；可用 MARVIS_REFRESH_LEAD_MS 覆盖）
//
// ⚠⚠ 「主动续期」的正确落点就是**这个字段**，不是在 loader 里偷偷续：
//   magpie 的契约是「宿主看 refreshLead，到点自己调 auth.refresh，并把返回的
//   access/refresh/expires **落库**」。插件在 loader 里刷出来的新 token 拿不到
//   写回宿主的入口 —— 刷了也存不进去，下一次请求还是旧 token，于是每个请求都刷一次，
//   既没用又正好撞上节奏风控。所以：把 lead 调对，交给宿主执行。
//   微信 token 只有 2 小时，lead 必须远小于它 —— `MARVIS_REFRESH_LEAD_MS` 就是给
//   这种情况用的（见 resolveRefreshLead 的 clamp）。

import { PROVIDER, ICON, REFRESH_LEAD_MS, PLUGIN_OPTIONS } from "./context.mjs"
import { methods } from "./hooks/methods.mjs"
import { refreshHook } from "./hooks/refresh.mjs"
import { loaderHook } from "./hooks/loader.mjs"
import { usageHook } from "./hooks/usage.mjs"
import { WX_TTL_MS } from "./marvis/expiry.mjs"

/**
 * 解析宿主该提前多久调续期。
 *
 * 优先级：`MARVIS_REFRESH_LEAD_MS`（正整数才生效） → `REFRESH_LEAD_MS`（5 分钟）。
 *
 * ⚠ clamp 到微信 TTL 的 1/3：lead 一旦逼近 token 生命期，账号从登录那刻起就
 *   「永远该刷新」，宿主会陷入连续刷新循环。微信是最短的（2h），所以用它的 1/3 当上限
 *   （默认 5 分钟、用户设 10 分钟都在界内；设成 3 小时会被压回 40 分钟）。
 *
 * @param {{ raw?: unknown, fallback?: number, cap?: number }} [o]
 * @returns {number}
 */
export function resolveRefreshLead({ raw = process.env.MARVIS_REFRESH_LEAD_MS, fallback = REFRESH_LEAD_MS, cap = Math.floor(WX_TTL_MS / 3) } = {}) {
  const n = Number(String(raw ?? "").trim())
  const lead = Number.isFinite(n) && n > 0 ? n : fallback
  return Math.min(lead, cap)
}

export function authHooks(input, options = {}) {
  return {
    provider: PROVIDER,
    icon: ICON,
    maxConcurrency: 8,
    refreshLead: resolveRefreshLead(),
    methods: methods(),
    // provider 卡片里的开关（magpie 渲染成 Off/On，用户在编辑器里点一下即生效）
    options: PLUGIN_OPTIONS,
    refresh: refreshHook(),
    loader: loaderHook(input, options),
    usage: usageHook(),
  }
}
