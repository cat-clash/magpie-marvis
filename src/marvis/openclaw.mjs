// openclaw.mjs —— Marvis 的 WebSocket 传输层（PC 本地网关，0.9.8 瘦身版）
//
// 背景（2026-11-23 实测）：
//   /v1/chat/completions 在 PC 端被上游 4100404 全局风控（所有账号、所有槽位、
//   uskey/AK-SK/UA/IP 全试过，官方 PC 客户端自己也一样）。唯一验证可行的路线是
//   文档 dsh-magpie-marvis §"路线 11.3"：绕开 HTTP 模型网关，直接走本地 WS。
//
// 仅保留 relay 模式（0.9.8 删除 remote 手机会话域 —— 凭据 15-20 分钟短命、
// 需要抓包、与 PC 同源风控域，从未实测过且无维护价值）：
//   1. relay  （默认）：连 Marvis PC 客户端自己的本地网关 ws://127.0.0.1:10123/。
//      AG-UI 协议（event=agent.run + payload），见 gateway.mjs。
//      前提：Marvis PC 客户端已登录并打开（网关 10123 在监听）。
//
// 配置（环境变量优先，其次插件 native/openclaw.json）：
//   MARVIS_WS_MODE       relay | off（0.9.8 起删除 remote；旧值 remote 视同 relay）
//   MARVIS_WS_URL        relay 模式的 WS 地址（默认 ws://127.0.0.1:10123/）
//   MARVIS_WS_TIMEOUT    单轮对话超时毫秒（默认 180000）

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, "..", "..")
const NATIVE_DIR = process.env.MARVIS_NATIVE_DIR || join(PLUGIN_ROOT, "native")

const DEFAULT_RELAY_URL = "ws://127.0.0.1:10123/"
const CONNECT_TIMEOUT_MS = 12_000
const DEFAULT_CHAT_TIMEOUT_MS = 180_000

function hex32() {
  return randomUUID().replace(/-/g, "")
}

/** 读可选配置：环境变量 > native/openclaw.json */
function fileConfig() {
  // ⚠ 0.4.3：**插件自带的 native/openclaw.json 优先**于 MARVIS_NATIVE_DIR 里的同名文件。
  //   用户环境变量可能残留旧插件的 NATIVE_DIR（实测：里面躺着 mode=bridge 的旧配置，
  //   把整个传输层劫持到 3502 死桥上，表现为所有请求 12s 无响应）。
  for (const p of [
    process.env.MARVIS_WS_CONFIG,
    join(PLUGIN_ROOT, "native", "openclaw.json"),
    join(NATIVE_DIR, "openclaw.json"),
    join(PLUGIN_ROOT, "openclaw.json"),
  ]) {
    if (!p || !existsSync(p)) continue
    try {
      // PowerShell 的 `Set-Content -Encoding UTF8` 在 Windows PowerShell 5.1 会写 BOM；
      // Node 的 JSON.parse 不接受 BOM，配置会被静默跳过 → mode=auto → 走错协议。
      const raw = readFileSync(p, "utf8").replace(/^\uFEFF/, "")
      const j = JSON.parse(raw)
      if (j && typeof j === "object") return j
    } catch {
      /* 坏配置就跳过 */
    }
  }
  return {}
}

function env(name, fallback = "") {
  const v = process.env[name]
  return v === undefined || v === "" ? fallback : String(v)
}

/**
 * 探测本机 Relay 网关（Marvis PC 客户端）是否可达。
 * 默认探测 127.0.0.1:10123，但也支持通过环境变量自定义。
 */
async function probeRelayReachable() {
  const url = env("MARVIS_LOCAL_WS", fileConfig().relayUrl || DEFAULT_RELAY_URL)
  try {
    const parsed = new URL(url)
    const { hostname, port = (parsed.protocol === "wss:" ? 443 : 80) } = parsed
    // 针对 WebSocket 的简单 TCP 探测：尝试创建 socket 只要连接成功即认为可达
    const net = await import("node:net")
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: hostname, port: parseInt(port) }, { timeout: 1000 }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on("error", () => {
        socket.destroy()
        resolve(false)
      })
      socket.setTimeout(1000, () => {
        socket.destroy()
        resolve(false)
      })
    })
  } catch {
    return false
  }
}

/**
 * @param {string} [modeOverride] 显式模式（relay/off），**单次请求**覆盖 env/文件配置。
 *   用途：loader 的 4100404 自动 WS 回退要临时切 relay，但**不能改 process.env.MARVIS_WS_MODE**
 *   —— 那是全局状态，await 期间并发请求会串味（A 号回退把 B 号也劫持到 WS）。
 *   显式参数只影响本次调用链，天然并发安全。空值 = 维持原行为。
 */
function cfg(modeOverride = "") {
  const f = fileConfig()
  const forced = String(modeOverride || "").trim().toLowerCase()
  const raw = (forced && ["relay", "remote", "off"].includes(forced) ? forced : env("MARVIS_WS_MODE", f.mode || "").toLowerCase())
  // 0.9.8 瘦身：remote（手机会话域 wss）已删除，旧配置/环境变量里的 remote
  // 归一化为 relay（本地 PC 客户端网关），避免存量用户升级后直接报错。
  const mode = raw === "remote" ? "relay" : (["relay", "off"].includes(raw) ? raw : "auto")
  if (["relay", "off"].includes(mode)) {
    return buildCfg(mode, f)
  }
  // auto：探测本地 10123 可达与否，在 openclawChatStream 里决定。
  return buildCfg("auto", f)
}

function buildCfg(mode, f) {
  return {
    mode,
    url: env("MARVIS_WS_URL", f.url || env("MARVIS_LOCAL_WS", f.relayUrl || DEFAULT_RELAY_URL)),
    timeout: Number(env("MARVIS_WS_TIMEOUT", String(f.timeoutMs || DEFAULT_CHAT_TIMEOUT_MS))),
    insecure: env("MARVIS_WS_INSECURE", f.insecure === false ? "0" : "1") !== "0",
  }
}

/**
 * 本地网关要求 URL 带 ?token=<gateway_token>（鉴权中间件："url_token 缺失或与网关 token 不匹配"）。
 * token 由 PC 客户端每次启动随机生成，并写进 %TEMP%\Tencent\Marvis\logs\Marvis.log：
 *   AiStarter.GetGatewayToken ... msg: "{\"token\":\"<uuid>\",\"port\":10123}"
 * 取最后一条即可（= 当前进程的有效 token）。
 */
export function localGatewayToken() {
  const explicit = env("MARVIS_GATEWAY_TOKEN", "")
  if (explicit) return explicit
  const dirs = [
    process.env.MARVIS_LOG_DIR,
    join(homedir(), "AppData", "Local", "Temp", "Tencent", "Marvis", "logs"),
    join(homedir(), ".config", "Tencent", "Marvis", "logs"),
    "/tmp/Tencent/Marvis/logs",
  ].filter(Boolean)
  const RX = /\\?"token\\?"\s*:\s*\\?"([0-9a-fA-F-]{36})\\?"[^\n]*?\\?"port\\?"\s*:\s*(\d+)/g
  let found = ""
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let files = []
    try {
      files = readdirSync(dir)
        .filter((f) => /^Marvis.*\.log$/i.test(f))
        .map((f) => ({ f, p: join(dir, f) }))
        .filter((x) => statSync(x.p).size < 64 * 1024 * 1024)
        .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)
    } catch {
      continue
    }
    for (const { p } of files) {
      try {
        const text = readFileSync(p, "utf8")
        const matches = [...text.matchAll(RX)]
        if (matches.length) {
          found = matches.at(-1)[1]
          break
        }
      } catch {
        /* 单文件读不了就跳过 */
      }
    }
    if (found) break
  }
  return found
}

/**
 * 检测「环境变量覆盖文件配置」的冲突（0.8.2）。
 *
 * 真实踩坑：openclaw.json 写了 mode=relay，但父进程继承了 MARVIS_WS_MODE=off，
 * env 优先级更高 → 插件走被 4100404 拦的 HTTP 直连 → 本地熔断 429 / 令牌用满。
 * 纯函数、不读文件系统，方便离线单测；调用方负责把两侧值传进来。
 *
 * @returns {string} 有冲突时是可行动提示，无冲突返回空串
 */
export function wsModeOverride(envMode, fileMode, effectiveMode) {
  const e = String(envMode ?? "").trim().toLowerCase()
  const f = String(fileMode ?? "").trim().toLowerCase()
  if (!e || !f || e === f) return ""
  if (e === "off" && f === "relay") {
    return (
      `环境变量 MARVIS_WS_MODE=off 覆盖了 openclaw.json 的 mode=relay：` +
      "插件会走被 4100404 拦的 HTTP 直连，表现为 429 限流 / 令牌用满。" +
      "清掉该环境变量（或改设为 relay）即可恢复 relay。"
    )
  }
  if (e === "remote" && f === "relay") {
    return "环境变量 MARVIS_WS_MODE=remote（0.9.8 起已删除 mobile remote 传输，remote 视同 relay）。"
  }
  return `环境变量 MARVIS_WS_MODE=${e} 覆盖了 openclaw.json 的 mode=${f}（实际生效：${effectiveMode || e}）。`
}

/** 诊断状态：给拉取配置 / 自检脚本用，不含任何密钥 */
export function openclawStatus() {
  const c = cfg()
  const f = fileConfig()
  return {
    mode: c.mode,
    fileMode: String(f.mode ?? ""),
    envMode: String(process.env.MARVIS_WS_MODE ?? ""),
    overrideWarning: wsModeOverride(process.env.MARVIS_WS_MODE, f.mode, c.mode),
    url: c.url,
    gatewayToken: c.mode === "relay" || c.mode === "auto" ? (localGatewayToken() ? "found" : "missing (open Marvis PC client)") : "n/a",
  }
}

/** 是否启用 openclaw 传输（loader 里判断是否绕过 HTTP 网关） */
export function openclawEnabled() {
  return cfg().mode !== "off"
}

/** 当前传输模式：relay | auto | off（0.9.8 起无 remote） */
export function openclawMode(modeOverride = "") {
  return cfg(modeOverride).mode
}

function readQimei() {
  for (const p of [join(NATIVE_DIR, "qimei36.txt"), join(NATIVE_DIR, "qimei.txt")]) {
    try {
      const v = readFileSync(p, "utf8").trim()
      if (v) return v
    } catch {
      /* 没有就继续 */
    }
  }
  return ""
}

/**
 * chat.completion.chunk 的 SSE 帧构造（C 类流式改造抽出的共享辅助）。
 *
 * openclawResponse（聚合）与 openclawStreamResponse（流式接线）共用同一套格式，
 * 不造第二套 —— 保证 WS 路径产出的 SSE 与直连路径 normalizeStreaming 透传的
 * 上游 SSE 事件形状一致（id / object / created / model / choices[].delta /
 * finish_reason，`data: ` 前缀 + 空行分隔，末尾 `data: [DONE]`）。
 *
 * @param {{id:string, created:number, model:string}} parts
 * @returns {(delta:object, finish_reason?:string|null) => string}
 */
export function chatChunkSse({ id, created, model }) {
  return (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
}

/**
 * 把「{delta?, model?} 帧的 async iterable」包成 chat.completion.chunk 的 SSE Response。
 *
 * 帧序：首帧 `delta:{role:"assistant"}`（带 role）→ 每个 delta 一帧
 * `delta:{content}` → 末帧 `finish_reason:"stop"` → `data: [DONE]`。
 * 帧里带 model 时随帧更新（id / created 不变）。
 * 流中途抛错（RUN_ERROR / 断连）时直接结束 body —— 状态码已定 200，只能截断；
 * 首帧之前的错误由调用方（loader 接线处）负责映射成 HTTP 错误响应。
 *
 * @param {{model?:string}} payload 原始请求体（取 model 兜底）
 * @param {AsyncIterable<{delta?:string, model?:string}>} frames
 * @param {{model?:string}} [opts] 初始 model（缺省用 payload.model / "marvis-ws"）
 * @returns {Response}
 */
export function openclawStreamResponse(payload, frames, { model } = {}) {
  const id = `chatcmpl-${hex32().slice(0, 12)}`
  const created = Math.floor(Date.now() / 1000)
  let usedModel = model || payload?.model || "marvis-ws"
  let chunk = chatChunkSse({ id, created, model: usedModel })
  const enc = new TextEncoder()
  const body = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(enc.encode(chunk({ role: "assistant", content: "" })))
      try {
        for await (const f of frames) {
          if (f?.model && f.model !== usedModel) {
            usedModel = f.model
            chunk = chatChunkSse({ id, created, model: usedModel })
          }
          if (typeof f?.delta === "string" && f.delta) {
            ctrl.enqueue(enc.encode(chunk({ content: f.delta })))
          }
          // 0.9.10：PC agent 的 REASONING_* 事件走独立通道，放进 reasoning_content，
          // 不再混进 content —— DSH 等客户端会把它收进思考区，正文保持干净。
          if (typeof f?.reasoning === "string" && f.reasoning) {
            ctrl.enqueue(enc.encode(chunk({ reasoning_content: f.reasoning })))
          }
        }
        ctrl.enqueue(enc.encode(chunk({}, "stop")))
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
      } catch {
        // 流中途失败：已发出 200，只能截断（与上游断流的表现一致）
        try {
          ctrl.close()
        } catch {
          /* 已关闭 */
        }
        return
      }
      ctrl.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  })
}

/** 把 OpenAI messages 展平成一段 prompt（与 marvis_gateway.py 的 flatten 一致） */
export function flattenMessages(messages) {
  if (!Array.isArray(messages)) return String(messages ?? "")
  return messages
    .map((m) => {
      let c = m?.content
      if (Array.isArray(c)) c = c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("")
      return `${m?.role || "user"}: ${String(c ?? "")}`
    })
    .join("\n")
}

/**
 * 发一轮 openclaw 对话的**实时**文本增量（async generator，C 类流式改造）。
 *
 * 0.9.8 瘦身：remote（手机会话域 wss / connect-chat.send 协议）已整体删除，
 * 本函数只保留 relay/auto 两条本地网关路径（AG-UI 协议，委托 gatewayChatStream）。
 * 错误以 throw 结束，错误文案与改造前一致。
 *
 * @param {{openid:string, accessToken:string, guid?:string}} creds
    * @param {{messages:any[], model?:string}} payload
 * @param {{signal?:AbortSignal, mode?:string, conversationId?:string}} [opts] mode=单次请求覆盖传输模式（relay/off）；
 *   conversationId=一次逻辑请求复用同一条 conv_*（贯穿 403 重试链，避免刷屏）
 */
export async function* openclawChatStream(creds, payload, { signal, mode, conversationId } = {}) {
  const c = cfg(mode)
  if (c.mode === "off") throw new Error("openclaw transport 已关闭（MARVIS_WS_MODE=off）")

  // relay / auto 都走本地 xiaobao 网关的 AG-UI 协议（event=agent.run + payload），
  // 这是 2026-11-23 实测确认的格式。auto 的 URL 就是 ws://127.0.0.1:10123/。
  // ⚠ 0.9.8：remote（wss 远端 connect-chat.send）已删除 —— 该路径需要
    // 15-20 分钟短命的抓包凭据、与 PC 同源风控域、从未实测成功，无维护价值。
  const { gatewayChatStream } = await import("./gateway.mjs")
  yield* gatewayChatStream(creds, payload, { signal, conversationId })
}

export async function openclawChat(creds, payload, opts = {}) {
  // relay 经 gateway 通道，默认模型名沿用 gateway 的 "marvis-gateway"（0.9.8 起无 remote）
  const fallbackModel = "marvis-gateway"
  let text = ""
  let reasoning = ""
  let usedModel = ""
  for await (const frame of openclawChatStream(creds, payload, opts)) {
    if (typeof frame?.delta === "string" && frame.delta) text += frame.delta
    if (typeof frame?.reasoning === "string" && frame.reasoning) reasoning += frame.reasoning
    if (frame?.model) usedModel = frame.model
  }
  return { text, reasoning, model: usedModel || payload?.model || fallbackModel }
}

/** 把 openclaw 结果包成 OpenAI 兼容的 Response（流 / 非流都支持） */
export function openclawResponse(payload, { text, reasoning, model }) {
  const id = `chatcmpl-${hex32().slice(0, 12)}`
  const ts = Math.floor(Date.now() / 1000)
  const usedModel = model || payload?.model || "marvis-gateway"
  const think = typeof reasoning === "string" && reasoning ? reasoning : ""
  if (payload?.stream) {
    // 与 openclawStreamResponse 共用同一套 chunk 构造（格式零分叉）
    const chunk = chatChunkSse({ id, created: ts, model: usedModel })
    const body = new ReadableStream({
      start(ctrl) {
        if (think) {
          // 有思考：先发 reasoning_content，再发正文（DSH 把思考收进思考区）
          ctrl.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "" })))
          ctrl.enqueue(new TextEncoder().encode(chunk({ reasoning_content: think })))
          ctrl.enqueue(new TextEncoder().encode(chunk({ content: text })))
        } else {
          // 无思考：保持原有单帧格式，避免破坏现有客户端/测试
          ctrl.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: text })))
        }
        ctrl.enqueue(new TextEncoder().encode(chunk({}, "stop")))
        ctrl.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        ctrl.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    })
  }
  return Response.json({
    id,
    object: "chat.completion",
    created: ts,
    model: usedModel,
    choices: [{ index: 0, message: { role: "assistant", content: text, ...(think ? { reasoning_content: think } : {}) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

export { cfg as openclawConfig }
