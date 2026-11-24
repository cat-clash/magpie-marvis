// 最小出票服务：给 magpie 插件（或 Docker 里的插件）提供 uskey。
//
// 用法（需要插件根目录 native/ 的 4 个文件）：
//   node tools/uskey-server.mjs --port 4617
//
// 然后在 magpie 插件所在环境设置：
//   MARVIS_USKEY_URL=http://127.0.0.1:4617/uskey
//
// 请求：POST /uskey
// {"busid":"marvis","businfo":"marvisAgentTag=main&...","common":{"guid":"...","login_openid":"...","login_type":"6"}}
// 响应：{"uskey":"..."}
//
// 安全（0.5.4 加固）：
//   · 默认只绑定 127.0.0.1 —— 出票服务签的是能过上游校验的真票，绑 0.0.0.0
//     等于把"借我登录态出票"的能力开放给整个局域网。要外放必须显式传
//     --host 0.0.0.0（或设 MARVIS_USKEY_HOST），并且强烈建议配共享密钥。
//   · 可选共享密钥：用 --token 参数或 MARVIS_USKEY_TOKEN 环境变量设置后，
//     所有请求（含 /health）必须带 x-uskey-token 头且值匹配，否则 403；
//     比较用 timingSafeEqual，防计时侧信道。未设置密钥时行为不变（本机使用）。
//
// 这个服务不保存凭据；common 只在本次请求里传给 Beacon SDK。

import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import { uskeyOf, fingerprintStatus } from "../src/marvis/fingerprint.mjs"

process.env.MARVIS_ALLOW_RANDOM_USKEY = "0"
process.env.MARVIS_USKEY_URL = ""

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

// 默认只绑回环地址（0.5.4）；--host / MARVIS_USKEY_HOST 是显式外放的唯一入口
const host = argOf("host", process.env.MARVIS_USKEY_HOST || "127.0.0.1")
const port = Number(argOf("port", process.env.MARVIS_USKEY_PORT || "4617"))
// 可选共享密钥：--token 参数优先，其次 MARVIS_USKEY_TOKEN 环境变量（值即密钥本身）
const token = String(argOf("token", "") || process.env["MARVIS_USKEY_TOKEN"] || "")

/** 共享密钥校验：设置过密钥后，所有请求都必须带匹配的 x-uskey-token 头 */
function tokenOk(req) {
  if (!token) return true
  const got = String(req.headers["x-uskey-token"] ?? "")
  if (got.length !== token.length) return false
  try {
    // 等长才比较；timingSafeEqual 防计时侧信道
    return timingSafeEqual(Buffer.from(got), Buffer.from(token))
  } catch {
    return false
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ""
    req.setEncoding("utf8")
    req.on("data", (c) => {
      buf += c
      if (buf.length > 1024 * 1024) {
        reject(new Error("body too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(buf))
    req.on("error", reject)
  })
}

const server = http.createServer(async (req, res) => {
  // 密钥校验放在最前：/health 与 /uskey 都受保护（/health 会暴露指纹状态）
  if (!tokenOk(req)) {
    return send(res, 403, { error: "forbidden" })
  }
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return send(res, 200, { status: "ok", ...fingerprintStatus() })
  }
  if (req.method !== "POST" || !req.url.startsWith("/uskey")) {
    return send(res, 404, { error: "not_found" })
  }
  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw || "{}")
    const common = body.common || {}
    const acct = {
      guid: String(common.guid || ""),
      openid: String(common.login_openid || ""),
      loginType: String(common.login_type || "6"),
    }
    const uskey = await uskeyOf(acct, {
      busInfo: String(body.businfo || ""),
      loginType: String(common.login_type || "6"),
    })
    return send(res, 200, { uskey })
  } catch (err) {
    return send(res, 503, { error: String(err?.message ?? err) })
  }
})

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

server.listen(port, host, () => {
  console.log(`[uskey-server] http://${host}:${port}/uskey`)
  console.log(`[uskey-server] native: ${fingerprintStatus().native ? "ok" : "not ready"}`)
  console.log(
    `[uskey-server] token: ${token ? "已启用共享密钥（请求须带 x-uskey-token）" : "未设置（仅本机使用，无鉴权）"}`,
  )
  if (!LOOPBACK.has(host) && !token) {
    console.warn(
      `[uskey-server] ⚠ 绑定在 ${host} 且未设置共享密钥 —— 局域网内任何人都能借这个服务出票。` +
        "请加 --token <secret>（或设对应环境变量），或改回默认 127.0.0.1。",
    )
  }
})
