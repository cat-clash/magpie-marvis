// gateway.mjs —— 本地 xiaobao 网关（Marvis PC 客户端）的 AG-UI 通道
//
// 2026-11-23 实测确认的协议（不是 openclaw 的 method:connect）：
//
//   连接：ws://127.0.0.1:10123/?token=<gateway token>
//         token 由 PC 客户端每次启动随机生成，写在 Marvis.log 的
//         `AiStarter.GetGatewayToken ... {"token":"<uuid>","port":10123}` 行。
//         不带 token 会被鉴权中间件拒：`url_token 缺失或与网关 token 不匹配`。
//
//   首帧：服务端主动发 {"type":"event","event":"gateway.connected","data":{"agentConnectionStatus":"Ready"}}
//
//   请求：{"type":"req","requestId":"<string>","event":"agent.run","payload":{
//            conversation_id, message, response_id, attachments: [], mcp_manage_tools_enabled: true }}
//         ⚠ payload 必须放在 `payload` 字段；放 data/params/body 会回
//           `agent.run payload 必须为对象`。
//         ⚠ 帧里用 `requestId`（不是 `id`），缺了回 `missing field requestId`。
//
//   响应：ACK {"type":"res","requestId":"...","ok":true,"data":{...}}
//         事件流 {"type":"event","event":"ag_ui_event","data":{
//                  conversation_id, event, delta, messageId, response_id, ... }}
//         AG-UI 事件名：RUN_STARTED / TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT /
//         TEXT_MESSAGE_END / RUN_FINISHED / RUN_ERROR / TOOL_CALL_*
//
// 重要边界：这条通道只是把请求交给 PC 客户端的本地 agent；
// agent 最终仍要调 Marvis 的 HTTP 模型网关，而 PC 端目前被 4100404 全局风控
// （回复通常表现为「当前环境有误，暂时无法回答你的问题」）。
// 所以它是「链路可用、上游受限」，真正出内容要靠 remote（手机会话域）。
//
// 流式改造（C 类）：gatewayChatStream 是 async generator，AG-UI 的每个
// TEXT_MESSAGE_CONTENT delta 到达即实时 yield（不再全量攒完才 resolve）；
// gatewayChat 是它的聚合 wrapper，返回形状 { text, model } 与改造前完全一致，
// 现有调用方零改动。

import { randomUUID } from "node:crypto"

import { localGatewayToken } from "./openclaw.mjs"

const DEFAULT_URL = "ws://127.0.0.1:10123/"
const CONNECT_TIMEOUT_MS = 12_000

function hex32() {
  return randomUUID().replace(/-/g, "")
}

function withToken(url, token) {
  if (!token) return url
  const u = new URL(url)
  if (!u.searchParams.has("token")) u.searchParams.set("token", token)
  return u.toString()
}

function maskUrl(url) {
  return String(url).replace(/([?&]token=)[^&]+/, "$1***")
}

/**
 * relay（连 PC 客户端本地网关）失败时的补充说明。
 *
 * ⚠ 2026-11-24 用户实测：手机上装完插件直接用，每个请求都是
 *   「503 · 连不上 Marvis 网关：本地网关 WebSocket 错误（ws://127.0.0.1:10123/）」
 *   —— 10123 是 **PC 客户端**的端口，手机上根本没有那个进程。
 *   这条错误本身看不出"手机没有 PC 客户端"这层原因，必须补一句。
 */
function relayHint(url) {
  const base = `本地网关 ${maskUrl(url)} 连不上`
  // 手机 / Termux / 安卓壳：没有 PC 客户端 ⇒ relay 这条路不存在
  const mobile =
    process.platform === "android" ||
    /com\.termux/i.test(String(process.env.PREFIX ?? "")) ||
    ["MAGPIE_PLATFORM", "MAGPIE_APP", "MAGPIE_SHELL", "DSH_PLATFORM"].some((k) =>
      /android|termux|mobile/i.test(String(process.env[k] ?? "")),
    ) ||
    process.env.ANDROID_ROOT ||
    process.env.ANDROID_DATA
  if (mobile) {
    return (
      `${base}：${maskUrl(url)} 是 **Marvis PC 客户端**的端口，手机上没有这个进程。\n` +
      "手机上有两条可走的路（任选其一）：\n" +
      "  1. 跑本地 Python 网关（推荐）：在 Termux 里执行 phone-kit 的 sh phone-setup.sh，" +
      "它会写 ~/.magpie-marvis-native/gateway.json 并起网关；插件随后自动走它；\n" +
      "  2. 走手机会话域：设置 MARVIS_WS_MODE=remote 并提供 MARVIS_HANDSHAKE（抓包文件）。"
    )
  }
  return `${base}：确认 Marvis PC 客户端已打开（它负责监听这个端口）。`
}

/**
 * 经本地网关跑一轮 agent.run，**实时**产出助手文本增量（async generator）。
 *
 * 每个 AG-UI TEXT_MESSAGE_CONTENT 的 delta 到达就 yield 一帧，宿主能看到流式增量
 * 而不是全量攒完。yield 契约：{ delta?: string, model?: string } —— 有模型信息时
 * 随帧带出（没有 delta 的帧，如 RUN_FINISHED，只带 model）。
 *
 * 结束语义（与改造前 gatewayChat 的聚合行为一致）：
 *   · RUN_FINISHED 且已有文本 → 正常收尾（消费方把队列读完即结束）；
 *   · RUN_ERROR / 会话 failed → 以 throw 结束（错误文案沿用原有风格）；
 *   · 连接超时 / agent.run 超时 / 无文本结束 → 以 throw 结束；
 *   · 消费方提前 break / throw 时，finally 负责关连接、清定时器（不泄漏 socket）。
 *
 * @param {{openid?:string, accessToken?:string, guid?:string}} creds  （本地通道不校验，保留签名一致）
 * @param {{messages:any[], model?:string}} payload
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function* gatewayChatStream(creds, payload, { signal } = {}) {
  const baseUrl = process.env.MARVIS_GW_URL || DEFAULT_URL
  const token = localGatewayToken()
  const url = withToken(baseUrl, token)
  const timeout = Number(process.env.MARVIS_GW_TIMEOUT || 180_000)

  const ws = new WebSocket(url)
  const conversationId = `conv_${hex32()}`
  const responseId = `resp_${hex32()}`

  // WS 回调是推模型、generator 是拉模型：中间用「待发队列 + 唤醒器」桥接，
  // delta 一到就入队并立刻唤醒等待中的消费方，宿主看到的是实时增量。
  /** @type {{delta?:string, model?:string}[]} */
  const pending = []
  let waiter = null
  let ended = false
  let streamError = null
  let anyDelta = false

  const wake = () => {
    if (!waiter) return
    const w = waiter
    waiter = null
    w()
  }
  const pushFrame = (frame) => {
    pending.push(frame)
    anyDelta = true
    wake()
  }
  const endStream = () => {
    if (ended) return
    ended = true
    wake()
  }
  const failStream = (err) => {
    if (ended) return
    streamError = err instanceof Error ? err : new Error(String(err))
    ended = true
    wake()
  }

  let connectTimer = null
  let chatTimer = null

  const cleanup = () => {
    clearTimeout(connectTimer)
    clearTimeout(chatTimer)
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }

  connectTimer = setTimeout(
    () =>
      failStream(
        new Error(
          `本地网关 ${maskUrl(url)} 没有回 gateway.connected（${CONNECT_TIMEOUT_MS}ms）。` +
            `确认 Marvis PC 客户端已打开；token 由客户端启动时生成，重启客户端后需要重试。`,
        ),
      ),
    CONNECT_TIMEOUT_MS,
  )

  ws.onopen = () => {
    /* 等 gateway.connected 再发请求 */
  }

  ws.onmessage = (ev) => {
    let msg
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data))
    } catch {
      return
    }

    // 1) 网关就绪 → 发 agent.run
    if (msg?.type === "event" && msg.event === "gateway.connected") {
      clearTimeout(connectTimer)
      const prompt = flatten(payload?.messages)
      // requestId 每请求唯一（旧实现恒为 "1"，多路并发会串帧）
      const frame = {
        type: "req",
        requestId: randomUUID(),
        event: "agent.run",
        payload: {
          conversation_id: conversationId,
          message: prompt,
          response_id: responseId,
          attachments: [],
          mcp_manage_tools_enabled: true,
        },
      }
      if (payload?.model) frame.payload.model_config = { model: payload.model }
      try {
        ws.send(JSON.stringify(frame))
      } catch (e) {
        failStream(e)
        return
      }
      chatTimer = setTimeout(() => {
        if (anyDelta) endStream()
        else failStream(new Error(`agent.run 超时（${timeout}ms 没有产出文本）`))
      }, timeout)
      return
    }

    // 2) 错误帧
    if (msg?.type === "error") {
      failStream(new Error(`本地网关拒绝 agent.run：${msg.message || JSON.stringify(msg).slice(0, 200)}`))
      return
    }

    // 3) ACK
    if (msg?.type === "res") {
      if (msg.ok === false) {
        failStream(new Error(`agent.run ACK 失败：${JSON.stringify(msg.error || msg.data || {}).slice(0, 200)}`))
      }
      return
    }

    // 4) AG-UI 事件流
    if (msg?.type === "event" && msg.event === "ag_ui_event") {
      const d = msg.data || {}
      const evName = String(d.event || d.type || "")

      // RUN_ERROR 的 code 若是风控拦截（实测 PC 客户端 20 连挂全是它），
      // 必须当失败抛出 —— 否则那句「当前环境有误，暂时无法回答…」会作为
      // 正文 delta 流出去，用户拿到一段假回复，不知道自己被风控了。
      if (evName === "RUN_ERROR") {
        const code = String(d.code || "")
        if (code === "risk_control_blocked") {
          // 风控文案不算产出文本：把它从累计里剥掉（见 pushFrame 记录的 riskBlock 前缀）
          failStream(
            new Error(
              "Marvis PC 客户端 agent 被风控拦截（risk_control_blocked，与 HTTP 直连的 4100404 同源）。" +
                "换账号 / 换 IP 无效；改走 MARVIS_WS_MODE=remote（手机会话域）或本地 Python 网关。" +
                `上游文案：${d.message || ""}`,
            ),
          )
          return
        }
        failStream(new Error(`agent 运行出错：${d.message || d.error || d.code || "unknown"}`))
        return
      }

      // CUSTOM message_complete 带 finishReason —— 风控拦截的另一形态
      if (evName === "CUSTOM" && String(d.name || "") === "message_complete") {
        const reason = String(d.value?.metadata?.finishReason || "")
        if (reason === "risk_control_blocked") {
          failStream(
            new Error(
              "Marvis PC 客户端 agent 被风控拦截（message_complete.finishReason=risk_control_blocked）。" +
                "与 HTTP 直连的 4100404 同源；改走 MARVIS_WS_MODE=remote（手机会话域）或本地 Python 网关。",
            ),
          )
          return
        }
      }

      const hasModel = Boolean(d.model)
      if (typeof d.delta === "string" && d.delta) {
        pushFrame({ delta: d.delta, ...(hasModel ? { model: d.model } : {}) })
      } else if (hasModel) {
        // 无 delta 的帧（RUN_FINISHED 等）单独带 model 一帧，聚合 wrapper 才能拿到
        pushFrame({ model: d.model })
      }
      if (evName === "RUN_FINISHED") {
        if (anyDelta) endStream()
        else failStream(new Error("agent.run 结束但没有返回文本（PC 端模型调用可能被 4100404 风控）"))
      }
      return
    }

    // 5) 会话状态变化：只在没有任何文本时当作失败信号
    if (msg?.type === "event" && /status/i.test(String(msg.event || ""))) {
      const st = msg.data?.status
      if (st === "failed" || st === "error") {
        // 诊断要看到**完整**的会话数据：失败原因常藏在 error / message 字段里，
        // 截断会把关键信息切掉（实测只看到 status/updated_at，原因丢了）。
        const detail = String(JSON.stringify(msg.data)).slice(0, 800)
        failStream(new Error(`会话状态 ${st}：${detail}`))
      }
    }
  }

  ws.onerror = () => failStream(new Error(`本地网关 WebSocket 错误（${maskUrl(url)}）\n${relayHint(url)}`))
  ws.onclose = () => {
    if (ended) return
    if (anyDelta) endStream()
    else failStream(new Error("本地网关在返回文本前关闭了连接"))
  }
  signal?.addEventListener?.("abort", () => failStream(new Error("请求已取消")), { once: true })

  // 消费方每要一帧，先看队列、再看结束信号：错误 / 结束在此处以 throw 暴露
  try {
    while (true) {
      while (pending.length) {
        yield pending.shift()
      }
      if (ended) {
        if (streamError) throw streamError
        break
      }
      await new Promise((res) => {
        waiter = res
      })
      if (streamError) throw streamError
    }
    // 各终止条件都有「无文本即报错」的语义，这里只是兜底（正常不会走到）
    if (!anyDelta) throw new Error("agent.run 结束但没有返回文本（PC 端模型调用可能被 4100404 风控）")
  } finally {
    cleanup()
  }
}

/**
 * 经本地网关跑一轮 agent.run，返回助手文本（聚合 wrapper）。
 *
 * 内部消费 gatewayChatStream；返回形状 { text, model } 与改造前完全一致，
 * 现有调用方零改动。
 *
 * @param {{openid?:string, accessToken?:string, guid?:string}} creds
 * @param {{messages:any[], model?:string}} payload
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function gatewayChat(creds, payload, opts = {}) {
  let text = ""
  let usedModel = ""
  for await (const frame of gatewayChatStream(creds, payload, opts)) {
    if (typeof frame?.delta === "string" && frame.delta) text += frame.delta
    if (frame?.model) usedModel = frame.model
  }
  return { text, model: usedModel || payload?.model || "marvis-gateway" }
}

/**
 * OpenAI messages → 一段 prompt（AG-UI agent.run 的 message 字段只收字符串）。
 *
 * ⚠ 保守的原因：AG-UI 上游协议的 message 是**单个字符串**，多轮结构没有可靠的
 *   分字段承载，所以这里只做「最小无损压缩」，不发明新格式：
 *   · 单条 user 消息（没有 system）：直接发原文，不加 "user: " 前缀；
 *   · 有 system：system 块独立放在最前（不带 "system: " 前缀，保持原文），
 *     其余轮次保留 "role: content" 结构；
 *   · 多模态 content 数组的兼容保持现状（按 text 块拼接）。
 */
export function flatten(messages) {
  if (!Array.isArray(messages)) return String(messages ?? "")
  const textOf = (m) => {
    let c = m?.content
    if (Array.isArray(c)) c = c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("")
    return String(c ?? "")
  }
  const hasSystem = messages.some((m) => m?.role === "system")
  // 单条 user（无 system）：原文直发，省掉无意义的 "user: " 前缀
  if (!hasSystem && messages.length === 1 && messages[0]?.role === "user") {
    return textOf(messages[0])
  }
  const lines = []
  for (const m of messages) {
    if (m?.role === "system") lines.push(textOf(m))
  }
  for (const m of messages) {
    if (m?.role === "system") continue
    lines.push(`${m?.role || "user"}: ${textOf(m)}`)
  }
  return lines.join("\n")
}

/** 诊断：本地网关是否就绪（不打印 token） */
export function gatewayStatus() {
  const token = localGatewayToken()
  return {
    url: process.env.MARVIS_GW_URL || DEFAULT_URL,
    gatewayToken: token ? "found" : "missing（打开 Marvis PC 客户端后 token 才会出现在日志里）",
    protocol: "req/requestId + event=agent.run + payload",
  }
}
