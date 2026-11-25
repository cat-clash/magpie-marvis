// openclaw.mjs —— Marvis 的 openclaw WebSocket 传输层
//
// 背景（2026-11-23 实测）：
//   /v1/chat/completions 在 PC 端被上游 4100404 全局风控（所有账号、所有槽位、
//   uskey/AK-SK/UA/IP 全试过，官方 PC 客户端自己也一样）。唯一验证可行的路线是
//   文档 dsh-magpie-marvis §"路线 11.3"：绕开 HTTP 模型网关，直接走 openclaw WS。
//
// 两种模式：
//   1. relay  （默认）：连 Marvis PC 客户端自己的本地网关 ws://127.0.0.1:10123/。
//      用插件里已有的账号凭据构造 connect 帧（结构对照 PC 客户端日志里的真帧），
//      网关把 chat.send 转给已登录的手机/ui 节点。**不需要抓握手包**。
//      前提：Marvis PC 客户端已登录并打开（网关 10123 在监听）。
//   2. remote ：连 openclaw 远端 wss，握手头 sessionId/token 来自抓包文件
//      (handshake.log)；connect / hello 帧模板来自 frames.log。
//      这是文档 11.3 的原版路线：直接复用手机 App 的会话，手机端风控域不受影响。
//      设置 MARVIS_HANDSHAKE / MARVIS_WS_URL 之一即进入 remote 模式。
//
// 配置（环境变量优先，其次插件 native/openclaw.json）：
//   MARVIS_WS_MODE       relay | remote | off（默认自动：有 handshake 就 remote，否则 relay）
//   MARVIS_WS_URL        relay 模式的 WS 地址（默认 ws://127.0.0.1:10123/）
//   MARVIS_HANDSHAKE     handshake.log 路径
//   MARVIS_FRAMES        frames.log 路径
//   MARVIS_SESSION_KEY   默认 agent:main:main
//   MARVIS_WS_TIMEOUT    单轮对话超时毫秒（默认 180000）
//   MARVIS_WS_KILL_CMD   每请求前执行的命令（remote 模式下抢手机独占会话用，可选）

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
const DEFAULT_REMOTE_URL = "wss://124.223.136.123:20017/ws"
const DEFAULT_SESSION_KEY = "agent:main:main"
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
      const j = JSON.parse(readFileSync(p, "utf8"))
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

function cfg() {
  const f = fileConfig()
  const handshake = env("MARVIS_HANDSHAKE", f.handshakeFile || f.handshake || "")
  const explicitMode = env("MARVIS_WS_MODE", f.mode || "").toLowerCase()
  
  // 1. 显式配置优先
  if (["relay", "remote", "off"].includes(explicitMode)) {
    return buildCfg(explicitMode, f, handshake)
  }
  // 2. 握手凭据优先 (handshake 存在 -> 走 remote)
  if (handshake) {
    return buildCfg("remote", f, handshake)
  }
  // 3. 默认模式：自动探测。
  //    如果本机有 relay 网关 (10123) 可达，则走 relay；否则走 off (HTTP 直连)。
  //    注意：probeRelayReachable 是异步的，但 cfg() 是同步的。
  //    为了不阻塞初始化，这里返回 "auto"，在具体的请求执行路径 (openclawEnabled) 中决定。
  return buildCfg("auto", f, handshake)
}

function buildCfg(mode, f, handshake) {
  return {
    mode,
    url: env("MARVIS_WS_URL", f.url || (mode === "remote" ? DEFAULT_REMOTE_URL : env("MARVIS_LOCAL_WS", f.relayUrl || DEFAULT_RELAY_URL))),
    handshake,
    frames: env("MARVIS_FRAMES", f.framesFile || f.frames || ""),
    sessionKey: env("MARVIS_SESSION_KEY", f.sessionKey || DEFAULT_SESSION_KEY),
    timeout: Number(env("MARVIS_WS_TIMEOUT", String(f.timeoutMs || DEFAULT_CHAT_TIMEOUT_MS))),
    killCmd: env("MARVIS_WS_KILL_CMD", f.killCmd || ""),
    insecure: env("MARVIS_WS_INSECURE", f.insecure === false ? "0" : "1") !== "0",
    sendHello: env("MARVIS_SEND_HELLO", f.sendHello === false ? "0" : "1") !== "1" ? "0" : "1",
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
  if (e === "off" && (f === "relay" || f === "remote")) {
    return (
      `环境变量 MARVIS_WS_MODE=off 覆盖了 openclaw.json 的 mode=${f}：` +
      "插件会走被 4100404 拦的 HTTP 直连，表现为 429 限流 / 令牌用满。" +
      `清掉该环境变量（或改设为 ${f}）即可恢复 ${f}。`
    )
  }
  return `环境变量 MARVIS_WS_MODE=${e} 覆盖了 openclaw.json 的 mode=${f}（实际生效：${effectiveMode || e}）。`
}

/** 诊断状态：给拉取配置 / 自检脚本用，不含任何密钥 */
export function openclawStatus() {
  const c = cfg()
  let handshakeOk = false
  let framesOk = false
  let host = ""
  if (c.handshake && existsSync(c.handshake)) {
    try {
      const hs = readFileSync(c.handshake, "utf8")
      handshakeOk = /sessionId\s*:/i.test(hs) && /token\s*:/i.test(hs)
      const m = /Host:\s*([0-9A-Za-z.\-]+:\d+)/i.exec(hs)
      if (m) host = m[1]
    } catch {
      /* 忽略 */
    }
  }
  if (c.frames && existsSync(c.frames)) {
    framesOk = /"method"\s*:\s*"connect"/.test(readFileSync(c.frames, "utf8"))
  }
  const f = fileConfig()
  return {
    mode: c.mode,
    fileMode: String(f.mode ?? ""),
    envMode: String(process.env.MARVIS_WS_MODE ?? ""),
    overrideWarning: wsModeOverride(process.env.MARVIS_WS_MODE, f.mode, c.mode),
    url: host && c.mode === "remote" && !process.env.MARVIS_WS_URL ? `wss://${host}/` : c.url,
    gatewayToken: c.mode === "relay" ? (localGatewayToken() ? "found" : "missing (open Marvis PC client)") : "n/a",
    handshake: c.handshake ? (existsSync(c.handshake) ? (handshakeOk ? "ok" : "missing credentials") : "missing file") : "not configured",
    frames: c.frames ? (framesOk ? "ok" : "no connect frame") : "not configured",
    sessionKey: c.sessionKey,
  }
}

/** 是否启用 openclaw 传输（loader 里判断是否绕过 HTTP 网关） */
export function openclawEnabled() {
  return cfg().mode !== "off"
}

/** 当前传输模式：relay | remote | off */
export function openclawMode() {
  return cfg().mode
}

function handshakeCredentials(handshake) {
  if (!handshake || !existsSync(handshake)) {
    throw new Error(`openclaw remote 模式需要 handshake.log：${handshake || "(未设置 MARVIS_HANDSHAKE)"}`)
  }
  const hs = readFileSync(handshake, "utf8")
  // 兼容 Frida 抓包里常见的 "sessionId: xxx" / "sessionId: xxx\r" 与裸头
  const sids = [...hs.matchAll(/^sessionId\s*:\s*([0-9a-zA-Z\-]+)\s*$/gim)].map((m) => m[1])
  const toks = [...hs.matchAll(/^token\s*:\s*([0-9a-zA-Z._\-]+)\s*$/gim)].map((m) => m[1])
  if (!sids.length || !toks.length) throw new Error("handshake.log 里没有 sessionId / token 两行，请重新抓握手")
  let url = ""
  const host = /^Host:\s*([0-9A-Za-z.\-]+:\d+)\s*$/im.exec(hs)
  if (host) url = `wss://${host[1]}/`
  return { sessionId: sids.at(-1), token: toks.at(-1), url }
}

function loadFrames(framesFile) {
  if (!framesFile || !existsSync(framesFile)) return { connect: null, hello: null }
  const parts = readFileSync(framesFile, "utf8").split("\n-----\n")
  let connect = null
  let hello = null
  for (const raw of parts) {
    const s = raw.trim()
    if (!s) continue
    if (!connect && /"method"\s*:\s*"connect"/.test(s)) {
      try {
        connect = JSON.parse(s)
      } catch {
        /* 不是 JSON 就跳过 */
      }
    }
    if (!hello && s.startsWith("MVT1") && /protocol:hello/i.test(s)) hello = s
  }
  return { connect, hello }
}

/**
 * relay 模式的 connect 帧 —— 结构逐字段对照 PC 客户端日志里手机 App 发出的真帧
 * （MarvisHost.log 2026-11-21 23:35:03 `[req:…] RPC 请求: method=connect`）。
 */
function relayConnectParams(creds, qimei36 = "", relay = {}) {
  const guid = String(creds.guid || hex32())
  const openid = String(creds.openid || "")
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "openclaw-android",
      version: "dev",
      platform: "android",
      mode: "ui",
      displayName: "magpie-marvis-final",
      instanceId: hex32(),
      deviceFamily: "Android",
      modelIdentifier: "magpie-ws",
    },
    role: "operator",
    device: { id: guid },
    locale: "zh-Hans",
    scopes: ["operator.read", "operator.write", "operator.agent_bridge"],
    deviceInfo: {
      originOpenID: openid,
      clientIp: "",
      qimei36: String(qimei36 || ""),
      phoneType: "PHK110",
      manufacturer: "OnePlus",
      osVersion: "14",
      guid,
      isIoa: "0",
      client_platform: "Android",
      client_platform_version: "1.3.9",
    },
    auth: {
      openid,
      loginType: "MOBILEQ",
      // ⚠ 0.4.2 实测（2026-11-24）：remote 模式下**绝不能带 accessToken** ——
      //   登录态就是 relaySessionId/relayToken 这一对（手机会话域凭据）。
      //   带上插件自己的 mv_ token，服务器回
      //   `登录态鉴权失败: AK/SK fetched successfully but data is incomplete`（code -3）：
      //   magpie 会定期轮换 token（refresh 成对轮换），而它与手机 App 的登录互踢，
      //   旧 token 必然失配。relay 模式（无握手凭据）才保留 accessToken 走本地网关。
      ...(relay.sessionId
        ? { relaySessionId: String(relay.sessionId), relayToken: String(relay.token) }
        : { accessToken: String(creds.accessToken || "") }),
    },
    userAgent: "OpenClawAndroid/dev (Android 14; SDK 34)",
  }
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

function killApp(cmd) {
  if (!cmd) return
  try {
    require("node:child_process").spawnSync(cmd, { shell: true, timeout: 15_000, stdio: "ignore" })
  } catch {
    /* 清理失败不阻塞 */
  }
}

/**
 * 发一轮 openclaw 对话的**实时**文本增量（async generator，C 类流式改造）。
 *
 * yield 契约与 gatewayChatStream 一致：{ delta?: string, model?: string }。
 *   · relay：连本地 xiaobao 网关走 AG-UI 通道（直接委托 gatewayChatStream），
 *     RUN_FINISHED 的 model 随帧带出；
 *   · remote：connect → chat.send → event:chat，文本按「增量」逐帧产出，
 *     isAgentTextFinal / agent end 终止。
 * 错误（握手失败 / chat.send 被拒 / agent 错误 / 超时无文本 / 取消）以 throw 结束，
 * 错误文案与改造前一致。
 *
 * @param {{openid:string, accessToken:string, guid?:string}} creds
 * @param {{messages:any[], model?:string}} payload
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function* openclawChatStream(creds, payload, { signal } = {}) {
  const c = cfg()
  if (c.mode === "off") throw new Error("openclaw transport 已关闭（MARVIS_WS_MODE=off）")

  // relay 走本地 xiaobao 网关的 AG-UI 协议（event=agent.run + payload），
  // 这是 2026-11-23 实测确认的格式；openclaw 的 method:connect 只适用于远端 wss。
  if (c.mode === "relay") {
    const { gatewayChatStream } = await import("./gateway.mjs")
    yield* gatewayChatStream(creds, payload, { signal })
    return
  }

  yield* openclawRemoteStream(creds, payload, c, { signal })
}

/** remote 模式的流式实现：握手 → chat.send → event:chat 增量逐帧产出 */
async function* openclawRemoteStream(creds, payload, c, { signal } = {}) {
  let url = c.url
  const wsInit = {}
  let connectTemplate = null
  let hello = null

  if (c.mode === "remote") {
    const cred = handshakeCredentials(c.handshake)
    if (!process.env.MARVIS_WS_URL) url = cred.url || url
    wsInit.headers = {
      sessionId: cred.sessionId,
      token: cred.token,
      platform: "mobile",
      role: "operator",
      version: String(Date.now()),
    }
    const frames = loadFrames(c.frames)
    connectTemplate = frames.connect
    hello = c.sendHello ? frames.hello : null
    killApp(c.killCmd)
  } else {
    // relay：本地网关要求 ?token=<每次启动随机生成的 gateway token>
    const tok = localGatewayToken()
    if (tok) {
      const u = new URL(url)
      if (!u.searchParams.has("token")) u.searchParams.set("token", tok)
      url = u.toString()
    }
    connectTemplate = null
    hello = null
  }

  // wss 自签证书：openclaw 的对端证书链不被 Node 默认信任。
  // 进程级开关只在开着 MARVIS_WS_INSECURE 时设置（默认开，可用 =0 关掉）。
  if (c.insecure && /^wss:/i.test(url) && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
  }

  // ⚠ 0.4.2 代理剥离（实测 2026-11-24）：magpie 宿主带着 HTTPS_PROXY 时，Bun 的
  //   WebSocket 会把 wss 连接交给代理转发 —— 对 openclaw 端点直接
  //   `proxy_connect: message forward failed`（clash 转发 20017 非标端口失败）。
  //   构造前临时剥掉代理变量，onopen / 失败路径恢复；MARVIS_WS_BYPASS_PROXY=0 可关。
  const bypassProxy = env("MARVIS_WS_BYPASS_PROXY", "1") !== "0"
  /** @type {Record<string, string | undefined>} */
  let savedProxy = null
  const stripProxyEnv = () => {
    savedProxy = {}
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
      savedProxy[k] = process.env[k]
      delete process.env[k]
    }
  }
  const restoreProxyEnv = () => {
    if (!savedProxy) return
    for (const [k, v] of Object.entries(savedProxy)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    savedProxy = null
  }
  if (bypassProxy) stripProxyEnv()

  const ws = new WebSocket(url, wsInit)
  const pending = new Map()
  // WS 回调是推模型、generator 是拉模型：中间用「待发队列 + 唤醒器」桥接，
  // 增量一到就入队并立刻唤醒等待中的消费方，宿主看到的是实时增量。
  /** @type {{delta?:string, model?:string}[]} */
  const pendingFrames = []
  let waiter = null
  let ended = false
  let streamError = null
  let anyDelta = false
  let lastText = ""

  const wake = () => {
    if (!waiter) return
    const w = waiter
    waiter = null
    w()
  }
  const pushFrame = (frame) => {
    pendingFrames.push(frame)
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

  const cleanup = () => {
    restoreProxyEnv()
    clearTimeout(connectTimer)
    clearTimeout(chatTimer)
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }

  const connectTimer = setTimeout(
    () =>
      failStream(
        new Error(
          `openclaw 握手无应答（已连上 ${url.replace(/[?&]token=[^&]+/, "?token=***")}，` +
            `但 ${CONNECT_TIMEOUT_MS}ms 内没收到 connect 响应；relay 模式请确认 Marvis PC 客户端已登录且未被前端独占会话）`,
        ),
      ),
    CONNECT_TIMEOUT_MS,
  )
  let chatTimer = null

  const sendReq = (method, params) => {
    const id = randomUUID()
    pending.set(id, { resolve: () => {}, reject: failStream })
    ws.send(JSON.stringify({ type: "req", id, method, params }))
    return id
  }

  ws.onopen = () => {
    // 连接已建立（直连，没走代理）：立刻恢复代理变量，别影响宿主里其他 provider 的出网
    restoreProxyEnv()
    let conn
    if (connectTemplate) {
      conn = { ...connectTemplate, id: randomUUID() }
    } else {
      conn = {
        type: "req",
        id: randomUUID(),
        method: "connect",
        params: relayConnectParams(
          creds,
          readQimei(),
          c.mode === "remote"
            ? { sessionId: wsInit.headers?.sessionId, token: wsInit.headers?.token }
            : {},
        ),
      }
    }
    pending.set(conn.id, {
      resolve: (msg) => {
        // connect 响应到达才算握手完成：在此之前 connectTimer 必须一直生效，
        // 否则网关「连上但不回帧」会永久挂起（TCP open ≠ 握手成功）。
        clearTimeout(connectTimer)
        if (msg && msg.ok === false) {
          failStream(new Error(`openclaw connect 被拒绝：${JSON.stringify(msg.error || msg.payload || {}).slice(0, 200)}`))
          return
        }
        // 握手成功 → 发 chat.send
        if (hello) {
          try {
            ws.send(hello)
          } catch {
            /* hello 失败不阻塞 */
          }
        }
        const rid = randomUUID()
        const prompt = flattenMessages(payload?.messages)
        const params = { sessionKey: c.sessionKey, message: prompt }
        if (payload?.model) params.model = payload.model
        pending.set(rid, {
          resolve: (m) => {
            if (m && m.ok === false) failStream(new Error(`chat.send 被拒绝：${JSON.stringify(m.error || {}).slice(0, 200)}`))
          },
          reject: failStream,
        })
        try {
          ws.send(JSON.stringify({ type: "req", id: rid, method: "chat.send", params }))
        } catch (e) {
          failStream(e)
        }
        chatTimer = setTimeout(() => {
          if (!anyDelta) failStream(new Error(`openclaw chat 超时（${c.timeout}ms）`))
          else endStream()
        }, c.timeout)
      },
      reject: failStream,
    })
    try {
      ws.send(JSON.stringify(conn))
    } catch (e) {
      failStream(e)
    }
  }

  ws.onerror = (e) => failStream(new Error(`openclaw WebSocket 错误：${e?.message || e?.type || "未知"}`))
  ws.onclose = () => {
    if (ended) return
    if (anyDelta) endStream()
    else failStream(new Error("openclaw WebSocket 在拿到回复前关闭"))
  }
  signal?.addEventListener?.("abort", () => failStream(new Error("请求已取消")), { once: true })

  ws.onmessage = (ev) => {
    let msg
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data))
    } catch {
      return
    }
    if (msg?.type === "res" && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      p.resolve(msg)
      return
    }
    if (msg?.type !== "event") return
    if (msg.event === "chat") {
      const m = msg.payload?.message || {}
      const model = m.model
      const parts = Array.isArray(m.content) ? m.content : []
      const txt = parts.map((x) => (typeof x === "object" && x?.type === "text" ? x.text ?? "" : "")).join("")
      if (txt) {
        // 协议发的是「累计快照」：快照以上一次为前缀时，增量 = 后缀（聚合语义不变）；
        // 非前缀（内容被重排）的极端情况保守跳过，不产出 delta，避免拼出错乱文本。
        const isExtend = lastText && txt.startsWith(lastText)
        const delta = isExtend ? txt.slice(lastText.length) : txt
        lastText = txt
        pushFrame({ delta, ...(model ? { model } : {}) })
      } else if (model) {
        pushFrame({ model })
      }
      if (parts.some((x) => x && (x.isAgentTextFinal || x.name === "message_complete")) && anyDelta) endStream()
      return
    }
    if (msg.event === "agent") {
      const phase = msg.payload?.data?.phase
      if (phase === "error") {
        failStream(new Error(`openclaw agent 错误：${JSON.stringify(msg.payload?.data?.reason ?? "").slice(0, 200)}`))
      } else if (["end", "complete"].includes(phase) && anyDelta) {
        endStream()
      }
    }
  }

  // 消费方每要一帧，先看队列、再看结束信号：错误 / 结束在此处以 throw 暴露
  try {
    while (true) {
      while (pendingFrames.length) {
        yield pendingFrames.shift()
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
    if (!anyDelta) throw new Error("openclaw 通道结束但没有返回文本")
  } finally {
    cleanup()
  }
}

/**
 * 发一轮 openclaw 对话，返回助手文本（聚合 wrapper）。
 *
 * 内部消费 openclawChatStream；返回形状 { text, model } 与改造前完全一致，
 * 现有调用方零改动。
 *
 * @param {{openid:string, accessToken:string, guid?:string}} creds
 * @param {{messages:any[], model?:string}} payload
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function openclawChat(creds, payload, opts = {}) {
  // relay 经 gateway 通道，默认模型名沿用 gateway 的 "marvis-gateway"；remote 用 "marvis-ws"
  const fallbackModel = openclawMode() === "relay" ? "marvis-gateway" : "marvis-ws"
  let text = ""
  let usedModel = ""
  for await (const frame of openclawChatStream(creds, payload, opts)) {
    if (typeof frame?.delta === "string" && frame.delta) text += frame.delta
    if (frame?.model) usedModel = frame.model
  }
  return { text, model: usedModel || payload?.model || fallbackModel }
}

/** 把 openclaw 结果包成 OpenAI 兼容的 Response（流 / 非流都支持） */
export function openclawResponse(payload, { text, model }) {
  const id = `chatcmpl-${hex32().slice(0, 12)}`
  const ts = Math.floor(Date.now() / 1000)
  const usedModel = model || payload?.model || "marvis-ws"
  if (payload?.stream) {
    // 与 openclawStreamResponse 共用同一套 chunk 构造（格式零分叉）
    const chunk = chatChunkSse({ id, created: ts, model: usedModel })
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: text })))
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
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

export { cfg as openclawConfig }
