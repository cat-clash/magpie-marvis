// 直连网络 —— yybadaccess.3g.qq.com 是腾讯国内端点，直连才是正确路径。
//
// ⚠ magpie 宿主进程带着 HTTPS_PROXY 时，Bun 的 fetch 会把请求交给代理；
//   clash 一旦没开，所有上游请求直接 ECONNRESET（2026-11-24 实测）。
//   这里在每次外发 fetch 前临时剥掉代理变量，完成后恢复 ——
//   只影响本插件自己的请求，宿主里其他 provider 照常走它们的代理。
//   MARVIS_DIRECT_FETCH=0 可关（比如你的网络必须经代理才能到腾讯）。
//
// 0.5.3：剥 env 不是 100% 保险 —— Bun 可能在**启动时**就把代理解析固化进 fetch 的
//   配置里，运行时 delete process.env 对已固化的值无效。所以主补全路径默认改走
//   node:https（Node 原生 API，Bun 完整兼容实现）——它不走 Bun fetch 的那套代理解析，
//   在任何宿主环境下都**强制直连**腾讯国内端点。
//
//   MARVIS_DIRECT_TRANSPORT 环境变量：
//     · 默认（或任何非 "fetch" 值）→ "https"：node:https 直连（directPost / directGet）
//     · "fetch"                    → 回退旧的 fetch + 剥 env 版本（directFetch）
//
// 0.5.4：directPost 重构为方法无关的 directRequest(method, url, opts)，新增
//   directGet(url, opts) 供 /models 探测、gatewayStatus 等非补全请求使用；
//   响应头到达后的 abort 不再提前摘监听，改为让响应流以 abort 错误收尾。

import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

/** @type {Record<string, string | undefined> | null} */
let saved = null

export function stripProxyEnv() {
  if (saved) return
  saved = {}
  for (const k of PROXY_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
}

export function restoreProxyEnv() {
  if (!saved) return
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  saved = null
}

export function directFetchEnabled() {
  return process.env.MARVIS_DIRECT_FETCH !== "0"
}

/**
 * 剥离代理环境后执行 fetch（异步安全：恢复发生在 await 之后）。
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function directFetch(input, init) {
  if (!directFetchEnabled()) return fetch(input, init)
  stripProxyEnv()
  try {
    return await fetch(input, init)
  } finally {
    restoreProxyEnv()
  }
}

// ── node:https 强制直连（0.5.3）────────────────────────────────────────
//
// 为什么它绕得开代理：node:https 是 Node 的原生 HTTP 客户端 API（Bun 按官方
// 兼容层实现），它**不读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY**——
// Bun 的代理解析只存在于全局 fetch（undici 风格）那一层。也就是说
// directPost 从根上就不给代理留入口，不需要剥 env，也不怕启动时固化。
//
// ⚠ 但只靠"不用 fetch"还不够：Node ≥24 在 NODE_USE_ENV_PROXY=1 时，
//   https.request 的**默认 agent** 也会吃代理 env（2026-11-24 死端口差分实测：
//   HTTPS_PROXY=死端口 → 默认 agent ECONNREFUSED，显式 agent 直连成功）。
//   所以这里**必须显式传 agent** —— 显式 agent 完全绕开 env 代理，
//   是两套运行时（Node / Bun）都成立的直连保证。

/** 本插件专属的直连 agent：keepAlive 复用连接，maxSockets 与 maxConcurrency(8) 对齐 */
const DIRECT_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 })
const DIRECT_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8 })

/** 传输通道开关：默认 "https"（node:https 直连）；显式设 "fetch" 回退 directFetch */
export function directTransport() {
  const t = String(process.env.MARVIS_DIRECT_TRANSPORT ?? "").trim().toLowerCase()
  return t === "fetch" ? "fetch" : "https"
}

/**
 * Headers 实例 / `[key, value]` 数组 / 普通对象 → 普通对象。
 * 键保留原大小写（node 的 header 处理不区分大小写），值一律转成字符串。
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
function flattenHeaders(headers) {
  const out = {}
  if (headers && typeof headers.forEach === "function" && !Array.isArray(headers)) {
    // Headers 实例（含 Bun/Node 的全局 Headers）
    headers.forEach((value, key) => {
      out[String(key)] = String(value)
    })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key)] = String(value)
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) out[String(key)] = String(value)
  }
  return out
}

/**
 * node:https 直连的 POST —— 主补全路径的强制直连通道。
 * 保持原对外签名与行为，内部委托给 directRequest。
 *
 * @param {string | URL} url
 * @param {{ headers?: unknown, body?: string | Buffer | Uint8Array | null, signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export function directPost(url, opts = {}) {
  return directRequest("POST", url, opts)
}

/**
 * node:https/http 直连的 GET —— /models 探测、gatewayStatus 等非补全请求使用。
 *
 * 为什么探测也要走这条链路：localGatewayEnabled() 的探测与 gatewayStatus() 之前
 * 走 directFetch（fetch，受宿主代理环境变量影响），而主补全路径默认 node:https
 * 强制直连 —— fetch 撞上没开的代理时 ECONNRESET，网关明明活着也会被判
 * "不可达"。改用 directGet 后：**探测看到的链路 = 主路径链路**。
 *
 * @param {string | URL} url
 * @param {{ headers?: unknown, signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export function directGet(url, opts = {}) {
  return directRequest("GET", url, opts)
}

/**
 * 方法无关的 node:https/http 强制直连请求 —— directPost / directGet 的公共实现。
 *
 * 与 fetch 版（directFetch）的差异：
 *   · **无条件直连**：不读代理环境变量、不剥 env、不受 Bun fetch 代理解析影响；
 *   · 响应对象是**类 Response 的最小实现**（loader 只用这些字段）：
 *       ok / status / headers.get(name) / text() / json() / clone().text()
 *       以及真实 ReadableStream 的 `body` —— loader 的 normalizeStreaming 会把
 *       res.body 交给宿主流式消费（`Readable.toWeb(res)` 包装，Bun 支持）；
 *       Content-Type 的 SSE 归一化仍由 loader 的 normalizeStreaming 负责；
 *   · 主动**不发送 accept-encoding**：node 不会像 fetch 那样自动解压，
 *     要了 gzip 就得自己解 —— 不要，上游回 identity，SSE/JSON 原样可读；
 *   · 主动丢弃入站 content-length：node 按**本次真实 body** 重算
 *     （loader 改写 body 后旧值必错，长一个字节都是 400）；
 *   · `signal`（AbortSignal）→ `request.destroy()`，对齐 fetch 的取消语义；
 *     ⚠ 0.5.4 修复：abort 监听保留到**响应流真正结束**（end/close/error）才移除。
 *     旧版在响应头一到就摘监听，宿主在流式 body 中途 abort 时监听已经没了，
 *     连接会一直挂到 600s 空闲超时。现在：响应头到达 → Promise 照常 resolve、
 *     abort 监听**保留**；abort 触发时 `req.destroy()` + `response.destroy()`，
 *     让正在读的 web 流以 abort 错误收尾（text()/aggregate() 立即 reject，
 *     不会挂死），已 resolve 的 Promise 绝不二次 reject（double-settle 防护）；
 *   · `timeoutMs` 是**socket 空闲超时**（连接阶段 + 响应间隔都算），
 *     默认 600000ms（与 X-Stainless-Read-Timeout: 600.0 对齐）。
 *
 * @param {"POST" | "GET" | string} method 请求方法（大写化后原样发给上游）
 * @param {string | URL} url 只会是 https（http: 也兼容，走 node:http）
 * @param {{ headers?: unknown, body?: string | Buffer | Uint8Array | null, signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean, status: number, headers: Headers,
 *   body: ReadableStream, text(): Promise<string>, json(): Promise<any>, clone(): object,
 * }>}
 */
export function directRequest(method, url, { headers, body, signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = url instanceof URL ? url : new URL(String(url))
    } catch (err) {
      reject(new Error(`directRequest: 非法 URL：${err?.message ?? err}`))
      return
    }
    const verb = String(method ?? "GET").toUpperCase()
    const secure = target.protocol !== "http:"
    const transport = secure ? https : http

    const outgoing = flattenHeaders(headers)
    // node 不自动解压 —— 干脆不要压缩体，上游回 identity（见上方说明）
    delete outgoing["accept-encoding"]
    delete outgoing["Accept-Encoding"]
    // content-length 交给 node 按真实 body 重算
    delete outgoing["content-length"]
    delete outgoing["Content-Length"]

    const payload =
      body == null
        ? null
        : typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array
          ? body
          : Buffer.from(String(body))

    let settled = false
    /** 响应头是否已到达（到达后 Promise 即 resolve，abort 不再走 reject 路径） */
    let responded = false
    /** 响应流（IncomingMessage），响应回调里赋值；onAbort 在它销毁时要用 */
    let response = null
    /** @param {unknown} err */
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanupSignal()
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    let req
    try {
      req = transport.request(
        {
          method: verb,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          headers: outgoing,
          // ⚠ 显式 agent 是直连的硬保证：Node ≥24 的 NODE_USE_ENV_PROXY=1 会把
          //   默认 agent 换成吃 env 代理的实现（死端口差分实测），只有显式 agent
          //   能完全无视 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 强制直连。
          agent: secure ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT,
        },
        (res) => {
          response = res
          const status = res.statusCode ?? 0
          const ok = status >= 200 && status < 300
          // 用真 Headers 实例：loader 里 new Headers(res.headers) /
          // new Response(body, { headers }) 都要能直接吃这个对象
          const resHeaders = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            resHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value))
          }

          // Readable.toWeb 一条 node 流只能包一次 —— 缓存，body / text / clone 共用
          let web = null
          const toWeb = () => {
            if (web) return web
            if (res.destroyed || res.errored) {
              // 响应流已经带错销毁（典型：流式中途 abort / 空闲超时先于消费 body）：
              // 直接造一个已 error 的流，保证 text()/aggregate() 以该错误收尾而不是挂死
              const err = res.errored
              web = new ReadableStream({
                start(controller) {
                  try {
                    if (err) controller.error(err instanceof Error ? err : new Error(String(err)))
                    else controller.close()
                  } catch {
                    /* 已关闭 */
                  }
                },
              })
              return web
            }
            if (typeof Readable.toWeb === "function") {
              web = Readable.toWeb(res)
            } else {
              // 极老运行时的兜底桥：node 流 → web ReadableStream
              web = new ReadableStream({
                start(controller) {
                  res.on("data", (chunk) => {
                    try {
                      controller.enqueue(new Uint8Array(chunk))
                    } catch {
                      /* 消费端已关闭 */
                    }
                  })
                  res.on("end", () => {
                    try {
                      controller.close()
                    } catch {
                      /* 已关闭 */
                    }
                  })
                  res.on("error", (err) => {
                    try {
                      controller.error(err)
                    } catch {
                      /* 已关闭 */
                    }
                  })
                },
                cancel() {
                  res.destroy()
                },
              })
            }
            return web
          }

          let textPromise = null
          const aggregate = () => {
            textPromise ??= (async () => {
              const reader = toWeb().getReader()
              const chunks = []
              try {
                for (;;) {
                  const { done, value } = await reader.read()
                  if (done) break
                  chunks.push(Buffer.from(value))
                }
              } finally {
                try {
                  reader.releaseLock()
                } catch {
                  /* 已释放 */
                }
              }
              return Buffer.concat(chunks).toString("utf8")
            })()
            // 没人 await 也不能让错误变成 unhandled rejection
            textPromise.catch(() => {})
            return textPromise
          }

          const json = async () => JSON.parse(await aggregate())

          // 响应头已到：Promise 就此 resolve。⚠ abort 监听**不在这里摘** ——
          // 必须保留到响应流真正结束（end/close/error），否则宿主在流式 body
          // 中途 abort 时监听已经没了，连接会一直挂到 600s 空闲超时。
          responded = true
          settled = true
          // 响应流结束（正常 end、断开 close、出错 error）才移除 abort 监听；
          // cleanupSignal 幂等，三个事件里先到的负责摘。
          const onStreamDone = () => cleanupSignal()
          res.once("end", onStreamDone)
          res.once("close", onStreamDone)
          res.once("error", onStreamDone)
          // body 没人读时（比如只看 status），abort/超时触发的响应流 error
          // 也不能变成 unhandled 'error' 崩进程 —— 挂个静默兜底监听。
          res.on("error", () => {})
          resolve({
            ok,
            status,
            headers: resHeaders,
            /** 真实 ReadableStream —— normalizeStreaming 后交给宿主流式消费 */
            get body() {
              return toWeb()
            },
            text: aggregate,
            json,
            /** loader 的错误路径只用 clone().text() —— 与主对象共享同一份聚合 */
            clone() {
              return { ok, status, headers: resHeaders, text: aggregate, json }
            },
          })
        },
      )
    } catch (err) {
      fail(err)
      return
    }

    // AbortSignal → request.destroy()（对齐 fetch 取消语义）
    // ⚠ 用函数声明（提升）：`transport.request` 同步抛错时 catch → fail() → cleanupSignal()
    //   会先于 const 定义执行，箭头函数常量会踩 TDZ
    function onAbort() {
      const err = new Error("This operation was aborted")
      // 先销毁响应流再销毁请求：保证 res.errored 是 abort 错误（而不是 socket
      // 断开的 ECONNRESET），正在读的 web 流 / 后续的 text() 都能拿到准确语义。
      if (responded && response) {
        // 响应头已到：Promise 已 resolve，不能再次 reject（double-settle 防护）。
        // 只销毁响应流 —— req.destroy 已经断了 socket，这里让 res 以 abort 错误
        // 收尾：正在读的 web 流收到 error（Readable.toWeb 与兜底桥都监听 res 的
        // error 并 controller.error），还没开始读的 text()/aggregate() 走 toWeb()
        // 的 destroyed/errored 守卫，同样立即以 abort 错误结束，不会挂死。
        try {
          response.destroy(err)
        } catch {
          /* 已销毁 */
        }
      }
      req?.destroy(err)
      // abort 监听由响应流的 end/close/error 事件（onStreamDone）负责摘除
    }
    function cleanupSignal() {
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort)
        } catch {
          /* 老 EventTarget 实现 */
        }
      }
    }
    if (signal) {
      if (signal.aborted) {
        req.destroy()
        fail(new Error("This operation was aborted"))
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    req.on("error", fail)

    // socket 空闲超时（对齐 X-Stainless-Read-Timeout: 600.0 的语义）。
    // 与 abort 对称：响应头已到时也把响应流一起销毁，text()/正在读的流
    // 以超时错误收尾，而不是等 600s 后才发现连接早死了。
    const idle = Number(timeoutMs) > 0 ? Number(timeoutMs) : 600_000
    req.setTimeout(idle, () => {
      const err = new Error(`上游 ${idle}ms 无数据（空闲超时）`)
      if (responded && response && !response.readableEnded) {
        try {
          response.destroy(err)
        } catch {
          /* 已销毁 */
        }
      }
      req.destroy(err)
    })

    if (payload == null) req.end()
    else req.end(payload)
  })
}
