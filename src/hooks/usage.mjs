// ⑤ auth.usage —— 卡片上的额度窗口
//
// Marvis 的额度是**令牌钱包**：总额 10,000,000 tokens，用掉多少、剩多少。
// 上游 `POST /v3/marvis_get_wallet` 返回：
//   { total_tokens, used_tokens, frozen_tokens, avail_tokens, total_cost, status }
//
// ⚠ 窗口一律交给 src/quota.mjs 的构造器生成（这里只给**原始字段**，不要自己先构造一遍）。
//   它会拦下：缺 used、aside 带 amount/limit、时间不是 ISO —— 这五类写法不会抛错，
//   只会让卡片显示「剩余额度未知」，而这个号在智能路由里等于不存在（HOOKS §三）。

import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { usage as buildUsage, usageWindow } from "../quota.mjs"
import { businessHeaders } from "../marvis/protocol.mjs"
import { directFetch } from "../marvis/directnet.mjs"
import { gatewayUsage } from "../marvis/gateway.mjs"
import { BASE } from "../context.mjs"

const WALLET_URL = `${BASE}/v3/marvis_get_wallet`

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0")

/**
 * 下一个重置时间：Marvis 令牌额度**按北京时间每天 0 点**重置（issue #12 确认）。
 *
 * ⚠ 上游 `/v3/marvis_get_wallet` **不返回**重置时间（实测响应只有 total/used/frozen/avail/cost/status），
 *   所以这里按固定规则推算。规则若变，只改这一个函数。
 * ⚠ `resetsAt` **只影响卡片显示**：路由排序只读 `used`，给了它也不会让这个号排得更前。
 * ⚠ 必须返回 ISO —— `usageWindow()` 会对非 ISO 直接抛（见 src/quota.mjs 的 TIME_KEYS）。
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function nextResetAt(now = new Date()) {
  const CN_OFFSET_MS = 8 * 3600_000
  // 把「北京时间」映射到 UTC 字段上算，不依赖运行机器的时区
  const cn = new Date(now.getTime() + CN_OFFSET_MS)
  const todayMidnightCn = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate()) - CN_OFFSET_MS
  const next = now.getTime() < todayMidnightCn ? todayMidnightCn : todayMidnightCn + 86_400_000
  return new Date(next).toISOString()
}

/**
 * 上游失败时留一份现场（不含 token），方便排查「卡片刻度不更新」。
 * @param {unknown} err
 */
function recordFailure(err) {
  try {
    const dir = join(homedir(), ".cache", "magpie")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "marvis-wallet-error.json"),
      `${JSON.stringify({ at: new Date().toISOString(), message: String(/** @type {any} */ (err)?.message ?? err) }, null, 2)}\n`,
    )
  } catch {
    /* 写不进去就算了，别因为诊断把主流程搞挂 */
  }
}

export function usageHook() {
  return async (getAuth) => {
    const auth = await getAuth()
    const meta = auth?.metadata ?? {}
    const acct = {
      openid: String(meta.openid ?? ""),
      accessToken: String(auth?.access ?? auth?.key ?? ""),
      guid: String(meta.guid ?? ""),
      loginType: String(meta.loginType ?? "1"),
    }
    if (!acct.accessToken || !acct.openid) {
      return { error: "尚未登录 Marvis", windows: [] }
    }

    // ── 0.9.7：优先走本地网关拿**真实消耗**（与客户端 App「今日消耗 Token」同源）──
    //   HTTP 钱包的 used_tokens 恒为 0（上游不计量营销额度），卡片永远不动；
    //   AG-UI 的 token.conversations_usage 才是客户端浮窗展示的那套数据。
    //   网关不可达（客户端没开）→ 静默回落 HTTP 钱包，行为与旧版一致。
    //   MARVIS_USAGE_WS=0 可关掉这条优先路。
    if (String(process.env.MARVIS_USAGE_WS ?? "").trim() !== "0") {
      try {
        const gw = await gatewayUsage()
        if (gw) {
          // ⚠ 窗口传**原始字段**，别先用 usageWindow() 包一遍 —— buildUsage 内部
          //   （quota.mjs usage() 的 windows.map）会再过一次 usageWindow；
          //   先包过的 textOnly 标记在第一轮就被剥掉，第二轮按普通窗口查 used
          //   必抛 QuotaShapeError → 被 catch 吞掉 → 静默回落钱包（0.9.7 首版实测踩坑）。
          return buildUsage({
            plan: "Marvis 令牌",
            windows: [
              // 主窗口：今日真实消耗（数量型，路由排序读的就是它）。
              // limit 沿用钱包总额 1000 万 —— 与客户端 App「83.6万/1000万」同一种刻度。
              {
                name: "今日消耗",
                amount: gw.today,
                limit: 10_000_000,
                unit: "tokens",
                resetsAt: nextResetAt(),
                display:
                  `今日消耗 ${fmt(gw.today)} / 共 10,000,000（客户端实时统计` +
                  `${gw.todayConversations ? `，${gw.todayConversations} 个会话` : ""}）`,
              },
              // 累计（全部会话合计）单独一条，text-only 只上卡片不影响路由
              ...(gw.total > 0
                ? [{ name: "累计消耗", textOnly: true, display: `全部会话累计 ${fmt(gw.total)} tokens` }]
                : []),
            ],
          })
        }
      } catch {
        /* 网关查询失败：回落下面的 HTTP 钱包，不打断用量卡片 */
      }
    }

    /** @type {any} */
    let wallet
    try {
      const body = "{}"
      const res = await directFetch(WALLET_URL, {
        method: "POST",
        headers: businessHeaders(acct, { query: body, method: "POST" }),
        body,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
      wallet = JSON.parse(text)?.data
      if (!wallet) throw new Error(`返回体没有 data：${text.slice(0, 200)}`)
    } catch (err) {
      recordFailure(err)
      // 读取失败不要把整次判死：返回空窗口 + error，magpie 会保留旧值
      return { error: `读取令牌钱包失败：${/** @type {any} */ (err)?.message ?? err}`, windows: [] }
    }

    const total = Number(wallet.total_tokens ?? 0)
    const used = Number(wallet.used_tokens ?? 0)
    const avail = Number(wallet.avail_tokens ?? Math.max(0, total - used))
    const frozen = Number(wallet.frozen_tokens ?? 0)

    return buildUsage({
      plan: "Marvis 令牌",
      windows: [
        // 主窗口：数量型（amount + limit）。路由排序读的就是它。
        //
        // ⚠ 上游 `used_tokens` 实测**恒为 0**（2026-11-27 原始响应：
        //   {"total_tokens":"10000000","used_tokens":"0","frozen_tokens":"0","avail_tokens":"10000000"}）。
        //   这 1000 万是营销额度，实际请求走免费通道、不从这里扣。
        //   照实显示 `10,000,000 / 10,000,000 · 剩余 100%` 会让人误以为「额度没生效」，
        //   所以 used=0 时改成说明性文案，不再暗示有真实消耗。
        usageWindow({
          name: "令牌用量",
          amount: used,
          limit: total,
          unit: "tokens",
          resetsAt: nextResetAt(),
          display:
            used > 0
              ? `${fmt(avail)} 可用 / 共 ${fmt(total)}`
              : `共 ${fmt(total)} tokens（上游未扣减）`,
        }),
        // 冻结额度单独一条，只上卡片（不影响路由）
        ...(frozen > 0
          ? [usageWindow({ name: "冻结中", textOnly: true, display: `冻结 ${fmt(frozen)}` })]
          : []),
      ],
    })
  }
}
