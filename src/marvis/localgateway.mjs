// localgateway.mjs —— 本地 OpenAI 兼容网关传输（手机端默认通道）
//
// 为什么要有这一层：
//   原插件的两条出票链在手机上都不成立 ——
//     · HTTP 直连（mode=off）要 Beacon 现签 uskey，靠 Windows 的 beacon_wrapper.dll
//       或 bionic libqimei.so；dsh-go proot 里 dlopen 不了 bionic 库，也没有 Windows DLL。
//     · openclaw WS（mode=remote）要 adb + frida 抓包拿握手凭据，凭据 15-20 分钟就失效。
//   参考仓库 yy158358/Marvis-proxy-public 用**纯 Python 标准库**在 Termux / PRoot 里
//   解决了出票（bionic_shim）、账号池、风控、登录续期，并暴露 OpenAI 兼容接口
//   http://127.0.0.1:8088/v1 —— 手机上跑得起来、凭据由那边维护。
//
// 所以这一层做的事很简单：**把补全请求原样转发给本地网关**，不再自己出票 / 抓包。
// magpie 插件退化成纯 provider（模型表 + 首行护栏 + 错误分流），账号/凭据/出票
// 全部归网关。这样插件本体跨平台（PC 和手机都能装），手机端零 native 依赖。
//
// 配置（两条路，环境变量优先；手机 magpie 壳没有环境变量入口 → 用配置文件）：
//   环境变量：MARVIS_TRANSPORT / MARVIS_GATEWAY_URL / MARVIS_GATEWAY_KEY / MARVIS_GATEWAY_TIMEOUT_MS
//   配置文件：<稳定资产目录>/gateway.json（或插件根 native/gateway.json），字段：
//     { "mode": "gateway", "url": "http://127.0.0.1:8088/v1", "key": "", "timeoutMs": 600000 }
//   稳定资产目录顺序：MARVIS_NATIVE_DIR 环境变量 > <用户目录>/.magpie-marvis-native（手机写这个）
//   ⚠ 手机只要写一份 gateway.json 到 ~/.magpie-marvis-native/ 即可开启，无需任何环境变量。
//
// 模式别名（MARVIS_TRANSPORT / gateway.json 的 mode）：
//   gateway / local  → 强制走本地网关
//   off / direct     → 关掉网关，走插件的 HTTP 直连（等价旧 MARVIS_WS_MODE=off）
//   openclaw / ws    → 关掉网关，走 openclaw WebSocket（旧 relay/remote）
// 不设时：给了 URL/key 自动走网关，否则短探测本机 8088，可达才走，避免打断已有 PC 用户。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { directFetch, directPost, directGet, directTransport } from "./directnet.mjs"
// directFetch 现在只剩 MARVIS_DIRECT_TRANSPORT=fetch 回退分支在用（gatewayFetch）

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8088/v1"
export const GATEWAY_KEY_ENV = "MARVIS_GATEWAY_KEY"
export const GATEWAY_URL_ENV = "MARVIS_GATEWAY_URL"
export const GATEWAY_MODE_ENV = "MARVIS_TRANSPORT"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, "..", "..")

function env(name, fallback = "") {
  const v = process.env[name]
  return v === undefined || v === "" ? fallback : String(v)
}

/** 稳定资产目录（与 openclaw.mjs 一致）：手机没有环境变量时用 ~/.magpie-marvis-native */
export function nativeDir() {
  if (process.env.MARVIS_NATIVE_DIR) return process.env.MARVIS_NATIVE_DIR
  try {
    return join(homedir(), ".magpie-marvis-native")
  } catch {
    return join(PLUGIN_ROOT, "native")
  }
}

/** 读配置文件：环境变量优先，配置文件补缺。返回纯对象，坏文件当没有。 */
export function gatewayFileConfig() {
  const candidates = [
    process.env.MARVIS_GATEWAY_CONFIG,
    join(nativeDir(), "gateway.json"),
    join(PLUGIN_ROOT, "native", "gateway.json"),
  ].filter(Boolean)
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      // Windows 上的编辑器 / PowerShell Set-Content 会给 UTF-8 文件加 BOM；
      // JSON.parse 遇到 U+FEFF 会整份失败，配置被静默跳过 —— 去掉再解析。
      const j = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""))
      if (j && typeof j === "object") return j
    } catch {
      /* 坏配置跳过 */
    }
  }
  return {}
}

/**
 * 读取本地网关配置。
 * @returns {{enabled:boolean, url:string, key:string, timeoutMs:number, explicit:boolean, source:string}}
 */
export function gatewayConfig() {
  const f = gatewayFileConfig()
  // 环境变量 > 配置文件 > 默认
  const explicit = String(env(GATEWAY_MODE_ENV, f.mode ?? f.transport ?? "")).trim().toLowerCase()
  const url = env(GATEWAY_URL_ENV, String(f.url ?? DEFAULT_GATEWAY_URL)).replace(/\/+$/, "")
  const key = env(GATEWAY_KEY_ENV, String(f.key ?? ""))
  const timeoutMs = Number(env("MARVIS_GATEWAY_TIMEOUT_MS", String(f.timeoutMs ?? "600000"))) || 600000
  const source = process.env[GATEWAY_MODE_ENV] ? "env" : f.mode || f.transport ? "file" : "auto"
  // 显式关掉：off/direct（HTTP 直连）与 openclaw/ws（WebSocket）都不走网关。
  const OFF = new Set(["off", "direct", "openclaw", "ws", "relay", "remote"])
  // 旧变量 MARVIS_WS_MODE=off 等价 PC HTTP 直连：也显式关网关。
  const legacy = String(process.env.MARVIS_WS_MODE ?? "").trim().toLowerCase()
  if (OFF.has(explicit) || legacy === "off") {
    return { enabled: false, url, key, timeoutMs, explicit: true, source }
  }
  const forced = explicit === "gateway" || explicit === "local"
  // 配置文件里写了 mode=gateway 也算显式开启；给了 URL/key 也算 configured
  const configured = Boolean(
    process.env[GATEWAY_URL_ENV] || process.env[GATEWAY_KEY_ENV] || f.url || f.key,
  )
  const modeSource = process.env[GATEWAY_MODE_ENV]
    ? "env:MARVIS_TRANSPORT"
    : f.mode || f.transport
      ? "gateway.json"
      : "auto"
  const urlSource = process.env[GATEWAY_URL_ENV]
    ? "env:MARVIS_GATEWAY_URL"
    : f.url
      ? "gateway.json"
      : "default"
  return {
    enabled: forced || configured,
    url,
    key,
    timeoutMs,
    explicit: forced,
    source,
    mode: explicit,
    modeSource,
    urlSource,
  }
}

const MARVIS_GATEWAY_URL_ENV = GATEWAY_URL_ENV

/**
 * 是否启用本地网关模式。
 * 显式 transport / 显式配置 URL/key → 立即生效；
 * 否则探测本机网关是否可达（短超时），可达才走它，避免打断已有 PC 直连用户。
 */
let cachedReach = null
let cachedAt = 0
const REACH_TTL = 30_000

export async function localGatewayEnabled({ probe = true } = {}) {
  const c = gatewayConfig()
  if (c.explicit) return c.enabled
  if (c.enabled) return true
  if (!probe) return false
  const now = Date.now()
  if (cachedReach !== null && now - cachedAt < REACH_TTL) return cachedReach
  cachedAt = now
  try {
    // 探测与主补全路径同链路：directGet 是 node:https 强制直连（0.5.4），
    // 不走 directFetch —— 宿主代理环境变量会污染 fetch 的可达性判断，
    // 出现"探测说不可达、主路径其实能通"的链路不一致。
    const res = await directGet(`${c.url}/models`, {
      signal: AbortSignal.timeout(1500),
    })
    cachedReach = res.ok
    // 探测只看状态码：把 body 排干，keep-alive 连接才能回到连接池复用
    await res.text().catch(() => {})
  } catch {
    cachedReach = false
  }
  return cachedReach
}

/** 同步版：只认显式配置，不做网络探测（供测试/自检用） */
export function localGatewayConfigured() {
  return gatewayConfig().enabled
}

/**
 * 把补全请求原样转发到本地网关。网关已实现 OpenAI / Anthropic 兼容，
 * 这里不改写 body、不读流，直接把 Response 交回去（SSE 原样透传）。
 *
 * @param {string|URL} target magpie 传进来的原始 URL（仅用于日志/方法判断）
 * @param {RequestInit} init magpie 传进来的请求（body/headers 原样）
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 */
export async function gatewayFetch(target, init = {}, opts = {}) {
  const c = gatewayConfig()
  const url = `${c.url}${targetPath(target)}`
  const method = String(init?.method || "POST").toUpperCase()
  const headers = { ...headerObject(init?.headers) }
  // 鉴权交给网关：清掉上游专属头，网关按自己的 key 体系鉴权。
  for (const k of Object.keys(headers)) {
    if (/^(authorization|ual-access-|x?-?marvis-|x-api-key|x-stainless-)/i.test(k)) delete headers[k]
  }
  if (c.key) {
    headers.Authorization = `Bearer ${c.key}`
    headers["X-API-Key"] = c.key
  }
  headers["User-Agent"] = "magpie-marvis-gateway/1.0"
  const timeoutMs = opts.timeoutMs ?? c.timeoutMs
  const signal = opts.signal ?? init?.signal
  if (directTransport() === "fetch") {
    // fetch 分支之前丢了 timeoutMs（fetch 只认 signal，不认 socket 空闲超时），
    // 网关挂起时会一直等 —— 这里用 AbortSignal.any 把调用方 signal 与硬超时
    // 合并（Node 24 / Bun ≥1.1 都有 AbortSignal.any），两者任一触发都取消。
    const deadline = AbortSignal.timeout(timeoutMs)
    const merged =
      signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, deadline]) : (signal ?? deadline)
    return directFetch(url, { ...init, method, headers, signal: merged })
  }
  return directPost(url, {
    headers,
    body: init?.body,
    signal,
    timeoutMs,
  })
}

/** 从 magpie 的原始 URL 里取路径：/v1/chat/completions → /chat/completions（网关基址已含 /v1） */
export function targetPath(target) {
  try {
    const u = target instanceof URL ? target : new URL(String(target))
    const m = /\/(chat\/completions|messages|responses)\b(?!\/)/.exec(u.pathname)
    if (m) return `/${m[1]}`
    const tail = u.pathname.replace(/^\/v1/, "").replace(/\/+$/, "")
    return tail || "/chat/completions"
  } catch {
    return "/chat/completions"
  }
}

/** Headers 实例 / 键值数组 / 普通对象 → 普通对象 */
function headerObject(h) {
  const out = {}
  if (!h) return out
  if (typeof h.forEach === "function" && !Array.isArray(h)) {
    h.forEach((v, k) => { out[String(k)] = String(v) })
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k)] = String(v)
  } else {
    for (const [k, v] of Object.entries(h)) out[String(k)] = String(v)
  }
  return out
}

/** 网关连通性自检（不含任何密钥） */
export async function gatewayStatus() {
  const c = gatewayConfig()
  const out = {
    mode: "gateway",
    url: c.url,
    enabled: c.enabled,
    modeSource: c.modeSource,
    urlSource: c.urlSource,
    keyConfigured: Boolean(c.key),
    reachable: false,
    models: 0,
  }
  try {
    // 自检与探测同链路：directGet（node:https 强制直连，0.5.4），
    // 保证"自检看到的链路 = 主补全路径链路"，不被宿主代理 env 干扰。
    const res = await directGet(`${c.url}/models`, { signal: AbortSignal.timeout(2500) })
    out.reachable = res.ok
    if (res.ok) {
      const j = await res.json().catch(() => ({}))
      out.models = Array.isArray(j?.data) ? j.data.length : 0
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}
