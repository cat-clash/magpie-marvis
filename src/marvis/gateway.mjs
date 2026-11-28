// gateway.mjs —— 本地 xiaobao 网关（Marvis PC 客户端）的 AG-UI 通道

/** 0.9.11：AG-UI 事件是否为 reasoning（思考）——命中即丢弃，不进正文也不进 reasoning_content。 */
export function isReasoningEvent(evName) {
  return /^REASONING(?:_MESSAGE)?(?:_|$)/i.test(String(evName ?? ""))
}
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
      "手机上唯一可走的是本地 Python 网关（0.9.8 起 remote 手机会话域通道已移除）：\n" +
      "  1. Termux / PRoot 里 cd 到本插件的 gateway/ 目录，执行 sh run.sh（或 python serve.py），" +
      "监听 127.0.0.1:8088；\n" +
      "  2. 控制台 http://127.0.0.1:8088/ 里加号登录 Marvis（账号池为空会回 503 no_account）；\n" +
      "  3. 写 ~/.magpie-marvis-native/gateway.json：" +
      "{\"mode\":\"gateway\",\"url\":\"http://127.0.0.1:8088/v1\"}，插件随后自动走它。"
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
 * @param {{signal?:AbortSignal, conversationId?:string}} [opts]
 *   conversationId：由调用方传入时**复用**该会话（一次逻辑请求的所有重试共用一条 conv_*），
 *   不传才新建 —— 旧版每次调用都新建，403 候选池/探针会在 PC 客户端刷出成百上千条空会话。
 */
export async function* gatewayChatStream(creds, payload, { signal, conversationId } = {}) {
  const baseUrl = process.env.MARVIS_GW_URL || DEFAULT_URL
  const token = localGatewayToken()
  const url = withToken(baseUrl, token)
  const timeout = Number(process.env.MARVIS_GW_TIMEOUT || 180_000)

  const ws = new WebSocket(url)
  // 一次逻辑请求只建一条会话：调用方（loader）生成一次并贯穿所有重试。
  // 环境变量 MARVIS_GATEWAY_CONVERSATION_ID 可把全部插件流量钉在一条会话里（诊断用）。
  const sticky = String(process.env.MARVIS_GATEWAY_CONVERSATION_ID || "").trim()
  const convId = sticky || String(conversationId || "") || `conv_${hex32()}`
  const conversationIdUsed = /^conv_[0-9a-f]{32}$/i.test(convId) ? convId : `conv_${hex32()}`
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
    flushHeld() // 正常收尾前把扣住的内容放出去，否则会吞掉真回复
    ended = true
    wake()
  }
  const failStream = (err) => {
    if (ended) return
    dropHeld() // 风控 / 出错：扣住的拦截文案直接丢弃，绝不作为正文流出
    streamError = err instanceof Error ? err : new Error(String(err))
    ended = true
    wake()
  }

  // ── 风控文案扣留（2026-11-25 直连 10123 实测的帧序）────────────────────
  //   +496ms TEXT_MESSAGE_CONTENT delta="当前环境有误，暂时无法回答你的问题，稍后再试试吧～"
  //   +513ms RUN_ERROR code=risk_control_blocked        ← 只晚 17ms
  // 差值太小：delta 一到就 yield 的话，拦截文案必然已经流出去 —— 上层 loader 只
  // 预取首帧，拿到文本就锁定 200，之后 RUN_ERROR 只能把流截断（表现为
  // 「200 + 一句假回复 + 没有 finish_reason / [DONE]」）。
  //
  // 扣留规则（不牺牲流式）：
  //   · 本轮**第一段** delta 先压住 —— 风控拦截永远是整轮的唯一一段文本，压住它
  //     就等于压住拦截文案；正常回复在第二段 delta 到达时立刻放行（只差两个字之间
  //     的间隔），上游真卡住时由 FIRST_HOLD_MAX_MS 兜底放行；
  //   · 任何位置命中风控文案 → 压住并等定性；
  //   · 终止信号（RUN_ERROR / finishReason / 会话 failed / RUN_FINISHED）→ 风控就
  //     丢弃扣留内容并抛错，正常收尾就先把扣留内容放出去再结束。
  const RISK_RE = /当前环境有误|暂时无法回答你的问题|risk_control_blocked/
  const HOLD_MS = Number(process.env.MARVIS_RISK_HOLD_MS || 300)
  const FIRST_HOLD_MAX_MS = Number(process.env.MARVIS_RISK_HOLD_FIRST_MS || 800)
  /** @type {{delta?:string, model?:string}[]} */
  let held = []
  let holdTimer = null
  let firstDeltaSeen = false
  const dropHeld = () => {
    clearTimeout(holdTimer)
    holdTimer = null
    held = []
  }
  const flushHeld = () => {
    clearTimeout(holdTimer)
    holdTimer = null
    const out = held
    held = []
    for (const f of out) pushFrame(f)
  }
  /** 扣住的文本是不是风控拦截文案（上游有时只给 status=failed，不给 code） */
  const heldLooksLikeRisk = () => held.some((f) => RISK_RE.test(String(f.delta || "")))
  // code 让上层 loader 能认出来、回 429 risk_blocked（而不是「连不上网关」的 503）
  const riskError = (detail) => {
    const err = new Error(
      "Marvis PC 客户端 agent 被风控拦截（risk_control_blocked，与 HTTP 直连的 4100404 同源）。" +
        "换账号 / 换 IP 无效；改走 MARVIS_WS_MODE=remote（手机会话域）或本地 Python 网关。" +
        `上游文案：${detail || "（未提供）"}`,
    )
    err.code = "risk_control_blocked"
    return err
  }

  let connectTimer = null
  let chatTimer = null
  let graceTimer = null

  const cleanup = () => {
    clearTimeout(connectTimer)
    clearTimeout(chatTimer)
    clearTimeout(holdTimer)
    clearTimeout(graceTimer)
    holdTimer = null
    graceTimer = null
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
          conversation_id: conversationIdUsed,
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
        if (anyDelta || held.length) endStream()
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
          // 风控文案不算产出文本：held 里的拦截文案随 failStream 一起丢弃
          clearTimeout(graceTimer)
          failStream(riskError(d.message))
          return
        }
        failStream(new Error(`agent 运行出错：${d.message || d.error || d.code || "unknown"}`))
        return
      }

      // CUSTOM message_complete 带 finishReason —— 风控拦截的另一形态
      if (evName === "CUSTOM" && String(d.name || "") === "message_complete") {
        const reason = String(d.value?.metadata?.finishReason || "")
        if (reason === "risk_control_blocked") {
          clearTimeout(graceTimer)
          failStream(riskError(`message_complete.finishReason=${reason}`))
          return
        }
      }

      const hasModel = Boolean(d.model)
      // 0.9.11：reasoning 全部丢弃。
      // PC agent 卡在重试循环时，思考里会倒出大量工具调用 JSON（_tool_call_intent）
      // 和重复段落 —— 实测 REASONING_CONTENT 24115 帧 vs 正文 2550 帧。这些不是正常
      // 思考，展示出来就是用户看到的「乱码」。直接吞掉：既不进 content，也不产生
      // reasoning_content。openclaw 侧的 reasoning 通道从此无输入，保留仅为兼容。
      // 0.9.13：REASONING_* 事件走独立 reasoning 通道（DSH 收进可折叠的思考区），
      // 不再直接丢弃 —— 用户要的是「可折叠」，不是「彻底不可见」。
      if (isReasoningEvent(evName)) {
        if (typeof d.delta === "string" && d.delta) {
          pushFrame({ reasoning: d.delta, ...(hasModel ? { model: d.model } : {}) })
        }
        return
      }
      if (typeof d.delta === "string" && d.delta) {
        const frame = { delta: d.delta, ...(hasModel ? { model: d.model } : {}) }
        const hitRisk = RISK_RE.test(d.delta)
        if (hitRisk) {
          // 命中拦截文案：压住，等 RUN_ERROR / status 来定性
          clearTimeout(holdTimer)
          holdTimer = setTimeout(flushHeld, HOLD_MS)
          held.push(frame)
          return
        }
        if (!firstDeltaSeen) {
          // 本轮第一段：可能是拦截文案的另一种措辞 —— 压住，等下一段或终止信号
          firstDeltaSeen = true
          clearTimeout(holdTimer)
          holdTimer = setTimeout(flushHeld, FIRST_HOLD_MAX_MS)
          held.push(frame)
          return
        }
        if (held.length) {
          // 第二段到了 ⇒ 第一段不是一次性拦截文案，立刻放行（不改变流式观感）
          held.push(frame)
          flushHeld()
          return
        }
        pushFrame(frame)
      } else if (hasModel) {
        // 无 delta 的帧（RUN_FINISHED 等）单独带 model 一帧，聚合 wrapper 才能拿到。
        // 扣住的文本排在它前面放出去 —— 顺序必须还是「先文本、后 model」。
        flushHeld()
        pushFrame({ model: d.model })
      }
      if (evName === "RUN_FINISHED") {
        // held 里可能还压着「被疑似风控文案连坐」的正常内容：算作有产出
        if (anyDelta || held.length) endStream()
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
        if (heldLooksLikeRisk()) {
          // 实测帧序：风控文案 delta(+496) → status failed(+450 前后) → RUN_ERROR(+513)。
          // status 帧不带 code，直接报它会丢掉「风控」这层定性；给 RUN_ERROR 一个
          // 很短的抢先窗口，没等到就按扣留的文案自行定性。
          clearTimeout(graceTimer)
          graceTimer = setTimeout(() => failStream(riskError(held.map((f) => f.delta).join(""))), 150)
          return
        }
        failStream(new Error(`会话状态 ${st}：${detail}`))
      }
    }
  }

  ws.onerror = () => failStream(new Error(`本地网关 WebSocket 错误（${maskUrl(url)}）\n${relayHint(url)}`))
  ws.onclose = () => {
    if (ended) return
    if (anyDelta || held.length) endStream()
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

// ── 真实用量查询（0.9.7）─────────────────────────────────────────────
//
// 背景：HTTP 钱包接口 `/v3/marvis_get_wallet` 的 `used_tokens` 恒为 0（营销额度，
// 上游不计量），卡片永远显示 10,000,000/10,000,000。而 Marvis 客户端 App 上
// 「今日消耗 Token」来自 AG-UI 的 `agent.action` 动作：
//   ① {"action":"conversations.list","limit":N} → 会话列表（含 conversation_id / created_at）
//   ② {"action":"token.conversations_usage","conversation_ids":[...]} → 每会话
//      {remote:{input_tokens,output_tokens},local:{...}}（与客户端同源的数据）
// 协议实测（2026-11-28 04:35，本机 10123）：conversations.list → usage 两步全通，
// 汇总数与客户端浮窗「累计Token消耗」一致。
//
// 帧格式与 agent.run 同壳：{"type":"req","requestId":"...","event":"agent.action",
// "payload":{action,...}}；响应 {"type":"ack"|"res",...} / agent.action 事件回包。
// usage_data 里 ack 的 ok:false（如参数缺失）不是致命错，忽略即可，最终以
// 带数据的 agent.action 事件为准。

/**
 * 纯函数：把 conversations.list 与 token.conversations_usage 的原始数据
 * 聚合成「今日 / 累计」两档 token 消耗。单测覆盖（不碰网络）。
 *
 * @param {any[]} conversations conversations.list 的会话数组
 * @param {any[]} usageRows conversations_usage 的数据数组
 * @param {number} [nowMs] 当前时间戳（注入便于测试）
 * @param {number} [cnOffsetMs] 北京时间偏移（默认 +8h）
 * @returns {{today:number,total:number,todayConversations:number,totalConversations:number}}
 */
export function aggregateUsage(conversations, usageRows, nowMs = Date.now(), cnOffsetMs = 8 * 3600_000) {
  const rows = Array.isArray(usageRows) ? usageRows : []
  const list = Array.isArray(conversations) ? conversations : []
  const byId = new Map()
  for (const c of list) {
    const id = c?.conversation_id || c?.id
    if (id) byId.set(String(id), c)
  }
  // 北京时间「今天 0 点」的 UTC 时间戳（与 usage.mjs nextResetAt 同一套换算）
  const cn = new Date(nowMs + cnOffsetMs)
  const todayStart = Date.UTC(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate()) - cnOffsetMs
  const tok = (r) => Number(r?.remote?.input_tokens ?? 0) + Number(r?.remote?.output_tokens ?? 0)
  let today = 0
  let total = 0
  let todayConversations = 0
  let counted = 0
  for (const r of rows) {
    const t = tok(r)
    if (!Number.isFinite(t) || t <= 0) continue
    total += t
    counted += 1
    const c = byId.get(String(r?.conversation_id ?? ""))
    const created = c?.created_at ? Date.parse(c.created_at) : NaN
    if (Number.isFinite(created) && created >= todayStart) {
      today += t
      todayConversations += 1
    }
  }
  return { today, total, todayConversations, totalConversations: counted }
}

/**
 * 经本地网关查询真实 token 用量（与客户端 App 同源）。
 * 客户端没开 / 连不上 / 超时 → 返回 null（调用方回落 HTTP 钱包）。
 *
 * ⚠ conversations.list 的 limit 实测上限 100（超了回 ok:false
 *   "limit must be an integer between 1 and 100"，2026-11-28 04:42 实测
 *   limit=200 被拒 —— 首版默认 200 就栽在这里：list 被拒 → 没有会话 id →
 *   超时返回 null，看起来像「网关不可达」）。这里统一 clamp 进 1..100。
 *
 * @param {{timeoutMs?:number, limit?:number}} [opts] limit=拉取的会话条数上限（默认 100，clamp 1..100）
 * @returns {Promise<{today:number,total:number,todayConversations:number,totalConversations:number}|null>}
 */
export async function gatewayUsage({ timeoutMs = 10_000, limit = 100 } = {}) {
  const listLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 100)))
  const baseUrl = process.env.MARVIS_GW_URL || DEFAULT_URL
  const token = localGatewayToken()
  if (!token && !process.env.MARVIS_GW_URL) return null // 客户端没开，别白连
  const url = withToken(baseUrl, token)
  return new Promise((resolve) => {
    let settled = false
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      resolve(null)
      return
    }
    /** @type {any[]|null} */
    let conversations = null
    /** @type {any[]|null} */
    let usageRows = null
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* 已关 */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    ws.onerror = () => finish(null)
    ws.onclose = () => { if (!settled) finish(null) }
    ws.onmessage = (ev) => {
      let m
      try { m = JSON.parse(String(ev.data)) } catch { return }
      // agent.action 回包：实测（2026-11-28 04:35）type 是 "ack"（不是 "event"），
      // 数据直接挂在 data 上；ok:false 的 ack 是参数错误提示，跳过等后续带数据的回包。
      if (m?.event === "agent.action" && m?.data && m?.data?.ok !== false) {
        const d = m.data
        if (d.action === "conversations.list" && conversations === null) {
          conversations = Array.isArray(d.data?.conversations) ? d.data.conversations : (Array.isArray(d.data) ? d.data : [])
          const ids = conversations.map((c) => c?.conversation_id || c?.id).filter(Boolean).slice(0, listLimit)
          if (!ids.length) {
            finish({ today: 0, total: 0, todayConversations: 0, totalConversations: 0 })
            return
          }
          try {
            ws.send(JSON.stringify({
              type: "req", requestId: `usage-${hex32().slice(0, 8)}`, event: "agent.action",
              payload: { action: "token.conversations_usage", conversation_ids: ids },
            }))
          } catch { finish(null) }
          return
        }
        if (d.action === "token.conversations_usage") {
          usageRows = Array.isArray(d.data) ? d.data : []
          finish(aggregateUsage(conversations ?? [], usageRows))
        }
      }
    }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          type: "req", requestId: `usage-list-${hex32().slice(0, 8)}`, event: "agent.action",
          payload: { action: "conversations.list", limit: listLimit },
        }))
      } catch { finish(null) }
    }
  })
}
