// failure-hints.mjs —— 连接故障 / 风控拦截的可行动诊断与自愈决策（0.7.7）
//
// 这两类故障以前只甩一句「连不上 / 被风控了」，用户不知道下一步做什么：
//   · 手机 503：openclaw WS 默认连 ws://127.0.0.1:10123/（PC 客户端端口），
//     手机上没有这个进程 → 每次都 503。正确出路是本地 8088 HTTP 网关。
//   · PC 429/4100404：HTTP 模型网关的 uskey 节奏风控，换账号/IP/UA 都没用，
//     唯一可行路线是绕开 HTTP 走 openclaw WS（relay 10123 / remote 手机会话域）。
//
// 本模块只放纯函数 + 一个 TCP 探针：不读凭据、不发请求、不改全局状态，
// 方便离线单测；真正的动作（重试、设环境变量）由 loader.mjs 决定。

import { createConnection } from "node:net"

const DEFAULT_RELAY_HOST = "127.0.0.1"
const DEFAULT_RELAY_PORT = 10123

/**
 * 连接失败（callUpstream 抛错）时的可行动诊断。
 *
 * @param {{mobile: boolean, errText: string}} arg
 * @returns {{header: string, hint: string, command: string}}
 */
export function connectionFailureHint({ mobile, errText }) {
  const text = String(errText ?? "")
  if (/openclaw|websocket|10123|ws:\/\//i.test(text)) {
    if (mobile) {
      return {
        header: "openclaw-10123-unreachable",
        hint:
          "10123 是 Marvis PC 客户端的 AG-UI relay 端口，手机上没有这个进程，openclaw WS 通道必然连不上。" +
          "修复：Termux 执行 sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix —— 它会写好 " +
          "gateway.json（mode=gateway, url=http://127.0.0.1:8088/v1）并尝试启动本地 8088 网关。" +
          "若提示找不到网关目录，先把 Marvis-proxy-public 放到 ~/Marvis-proxy-public 再重跑。" +
          "网关起来后重试即可；注意 ws://127.0.0.1:10123/ 与 8088 是两条完全不同的链路。",
        command: "sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix",
      }
    }
    return {
      header: "openclaw-10123-unreachable",
      hint:
        "10123 是 Marvis PC 客户端的 AG-UI relay 端口：确认 PC 客户端已启动并登录（10123 在监听）。" +
        "若不想走 WS 通道，设 MARVIS_WS_MODE=off 或 MARVIS_TRANSPORT=direct 走 HTTP 直连；" +
        "若是残留的 handshake 记录把通道劫到 remote，删掉 MARVIS_HANDSHAKE 指向的文件。" +
        "自检：node scripts/cli.mjs doctor。",
      command: "node scripts/cli.mjs doctor",
    }
  }
  return {
    header: "upstream-unreachable",
    hint:
      mobile
        ? "连不上本地网关：Termux 执行 sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix " +
          "检查/启动 8088 网关，确认 gateway.json.mode=gateway、url=http://127.0.0.1:8088/v1。"
        : "连不上上游：检查网络与代理（HTTP(S)_PROXY），或用 node scripts/cli.mjs doctor 自检通道配置。",
    command: mobile
      ? "sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix"
      : "node scripts/cli.mjs doctor",
  }
}

/**
 * 解析本机 relay 地址：环境变量/配置只影响端口， host 默认 127.0.0.1。
 * 探针是纯网络层面的 TCP connect，不碰任何凭据。
 */
function relayEndpoint() {
  const raw = String(process.env.MARVIS_LOCAL_WS || "").trim()
  if (!raw) return { host: DEFAULT_RELAY_HOST, port: DEFAULT_RELAY_PORT }
  try {
    const u = new URL(raw)
    return {
      host: u.hostname || DEFAULT_RELAY_HOST,
      port: Number.parseInt(u.port || (u.protocol === "wss:" ? "443" : "80"), 10) || DEFAULT_RELAY_PORT,
    }
  } catch {
    return { host: DEFAULT_RELAY_HOST, port: DEFAULT_RELAY_PORT }
  }
}

/**
 * 本机 Marvis PC 客户端 relay 网关（默认 10123）是否可达。
 * 1s 超时，失败/拒绝一律 false —— 探针本身绝不能抛错把请求搞挂。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export function probeLocalRelay({ timeoutMs = 1000 } = {}) {
  const { host, port } = relayEndpoint()
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关 */ }
      resolve(v)
    }
    const socket = createConnection({ host, port }, () => done(true))
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("error", () => done(false))
    socket.once("close", () => done(false))
  })
}

/**
 * 4100404 风控命中后要不要**尝试** WS 回退路径（探针由调用方做，见 probeLocalRelay）。
 *
 * 前提缺一不可：
 *   · 桌面（手机没有 PC 客户端，10123 必然不可达）
 *   · 当前不是显式 remote（用户已配了 handshake 就别覆盖）
 *   · 用户没用 MARVIS_RISK_AUTO_WS=0 关掉
 *   · 风险状态没被 MARVIS_RISK_STATUS 改掉（改成 503 时保持旧行为）
 *
 * 注意：本函数**不检查探针** —— 调用方先判这里，通过后再花 1s 做 TCP 探测。
 *
 * @param {{mobile:boolean, mode:string, autoDisabled:boolean, riskStatus:number}} arg
 * @returns {boolean}
 */
export function shouldAutoWsFallback({ mobile, mode, autoDisabled, riskStatus }) {
  if (mobile) return false
  if (autoDisabled) return false
  if (String(mode || "").toLowerCase() === "remote") return false
  if (riskStatus !== 429) return false
  return true
}

/**
 * 把 4100404 的原始 429 文案升级成「有下一步」的版本。
 * 覆盖四种现场：手机 / PC 探针可达 / 自动重试成功或失败 / 探针不可达。
 *
 * @param {string} original
 * @param {{mobile:boolean, probeReachable:boolean, autoTried:boolean, autoError:string}} arg
 * @returns {string}
 */
export function enhanceRiskMessage(original, { mobile, probeReachable, autoTried, autoError }) {
  const base = String(original ?? "")
  if (mobile) {
    return (
      base +
      " 手机端处置：不要靠换账号/换 IP（HTTP uskey 风控与账号无关），改走本地 8088 网关——" +
      "Termux 执行 sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix，网关起来后重试。"
    )
  }
  if (autoTried) {
    if (!autoError) {
      // 成功路径不走这里（loader 直接返回响应），留着只是防御性兜底
      return base + " 已自动切到 Marvis PC 客户端 WS 通道重试。"
    }
    return (
      base +
      ` 已自动尝试切到本机 Marvis PC 客户端 WS 通道（MARVIS_WS_MODE=relay）重试，但失败：${autoError}。` +
      " 请确认 PC 客户端已登录并保持打开，或用手机会话域：设 MARVIS_WS_MODE=remote " +
      "并给 MARVIS_HANDSHAKE 指向 handshake.log（需重新抓握手凭据）。" +
      " 自检：node scripts/cli.mjs doctor。"
    )
  }
  if (probeReachable) {
    return (
      base +
      " 检测到本机 127.0.0.1:10123（Marvis PC 客户端）可达：设 MARVIS_WS_MODE=relay 即可绕开 HTTP 风控；" +
      "或保持现状等冷却结束。自检：node scripts/cli.mjs doctor。"
    )
  }
  return (
    base +
    " 本机 127.0.0.1:10123 不可达（Marvis PC 客户端没开）：启动并登录 PC 客户端后可设 " +
    "MARVIS_WS_MODE=relay 绕开 HTTP 风控；或用手机会话域 MARVIS_WS_MODE=remote + " +
    "MARVIS_HANDSHAKE=<handshake.log>（需抓握手凭据）。" +
    " 自检：node scripts/cli.mjs doctor（会显示当前 WS 模式与凭据状态）。"
  )
}
