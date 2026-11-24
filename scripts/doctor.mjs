#!/usr/bin/env node
// 一键诊断：插件版本 → 网关配置 → 网关连通 → 关键 chat 分流。
// 只读环境变量 / 本地文件；网络探测只发最小请求。绝不打印 key / qimei36 明文。
// 风格对齐 scripts/probe-gateway.mjs：逐环 ✓/✗ + 修复提示 + 总结 exit code。

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { directFetch } from "../src/marvis/directnet.mjs"
import { gatewayConfig, gatewayFileConfig, localGatewayEnabled, nativeDir } from "../src/marvis/localgateway.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HTTP_TIMEOUT = 5_000
const CHAT_TIMEOUT = 15_000

/** 兜底脱敏：即使上游把凭据回显在错误文案里也不外泄。 */
function scrub(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer ***")
    .replace(/\b[0-9a-f]{32}\b/gi, "***")            // qimei36 / guid / 指纹串
    .replace(/\b(sk|mk)-[A-Za-z0-9_-]{8,}\b/gi, "$1-***")
    .replace(/\b(key|token|secret|uskey)\s*[:=]\s*["']?[^\s,;"'}]{6,}/gi, "$1=***")
}

const failures = []
function ok(label, detail) {
  console.log(`✓ ${label}${detail ? `：${scrub(detail)}` : ""}`)
}
function info(label, detail) {
  console.log(`ℹ ${label}${detail ? `：${scrub(detail)}` : ""}`)
}
function bad(label, detail, hint, rank = 99) {
  console.log(`✗ ${label}${detail ? `：${scrub(detail)}` : ""}`)
  if (hint) console.log(`  → 修复：${scrub(hint)}`)
  failures.push({ label, hint, rank })
}

async function getJson(url, timeoutMs = HTTP_TIMEOUT) {
  const res = await directFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 忽略 */ }
  return { status: res.status, ok: res.ok, json, text }
}

console.log("=== magpie-marvis-final · 一键诊断（模型不出字排查） ===")

// ── 1. 插件版本 ──────────────────────────────────────────────────────────
console.log()
console.log("[1/4] 插件版本 / 入口")
let pkg = null
try { pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) } catch { /* 缺失 */ }
if (!pkg?.name || !pkg?.version) {
  bad("插件版本", "package.json 读不到 name/version", "重装插件：确认 package.json 完整", 60)
} else if (!existsSync(join(ROOT, "index.mjs"))) {
  bad("插件入口", "index.mjs 不存在", "重装插件：确认 files 中 index.mjs 已安装", 60)
} else {
  ok("插件版本", `${pkg.name}@${pkg.version}；入口 index.mjs 存在`)
}

// ── 2. 网关配置 ──────────────────────────────────────────────────────────
console.log()
console.log("[2/4] 网关配置")
const cfg = gatewayConfig()
let gatewayEnabled = false
try { gatewayEnabled = await localGatewayEnabled({ probe: false }) } catch { /* 保持 false */ }
const fileCfg = gatewayFileConfig()
const keyConfigured = Boolean(cfg.key) // 只判有无，绝不输出 cfg.key

// 有的 gateway.json 带 UTF-8 BOM：localgateway 的 JSON.parse 会整份跳过，
// 插件因此以为「mode=auto / 没配 key」。这里只读地做一次 BOM 容错解析供探测用，
// 不写回任何文件；同时把这件事明确打出来。
const configCandidates = [
  process.env.MARVIS_GATEWAY_CONFIG,
  join(nativeDir(), "gateway.json"),
  join(ROOT, "native", "gateway.json"),
].filter(Boolean)
let tolerant = null
let bomFile = ""
if (!fileCfg.key || !fileCfg.mode) {
  for (const p of configCandidates) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, "utf8")
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) }
      if (parsed && typeof parsed === "object") {
        if (/^\uFEFF/.test(raw)) bomFile = p
        if (!tolerant) tolerant = parsed
      }
    } catch { /* 坏配置跳过 */ }
  }
}
const mode = String(process.env.MARVIS_TRANSPORT || fileCfg.mode || fileCfg.transport || tolerant?.mode || "auto")
const probeKey = cfg.key || String(tolerant?.key || "") // 内存中使用，绝不打印
if (/^https?:\/\//i.test(String(cfg.url || ""))) {
  ok("网关配置", `mode=${mode}，url=${cfg.url}，keyConfigured=${keyConfigured}（插件视角），modeSource=${cfg.modeSource || "auto"}，urlSource=${cfg.urlSource || "default"}`)
  if (bomFile) {
    info("配置警告", `${bomFile} 带 UTF-8 BOM：gatewayConfig() 会跳过它；本次探测用 BOM 容错读到的 key（脚本未改文件）`)
  } else if (!probeKey) {
    info("提示", "未配置网关 key；若网关要求鉴权，下一步 chat 会返回 401")
  }
} else {
  bad("网关配置", `url=${cfg.url || "(空)"}`, "设置 MARVIS_GATEWAY_URL 或写 gateway.json", 50)
}
if (!gatewayEnabled) {
  info("提示", `localGatewayEnabled({probe:false})=false（未显式走网关；仍按该 URL 继续探测）`)
}

// ── 3. 网关连通 ──────────────────────────────────────────────────────────
console.log()
console.log("[3/4] 网关连通（/models + /health）")
let modelId = ""
let modelsOk = false
try {
  const r = await getJson(`${String(cfg.url).replace(/\/+$/, "")}/models`)
  if (r.ok && Array.isArray(r.json?.data)) {
    modelsOk = true
    modelId = String(r.json.data[0]?.id ?? "")
    ok("GET /models", `${r.json.data.length} 个模型${modelId ? `；首个 id=${modelId}` : ""}`)
  } else {
    const brief = r.json ? JSON.stringify(r.json).slice(0, 120) : r.text.slice(0, 120)
    bad("GET /models", `HTTP ${r.status} ${brief}`, "确认网关已启动并监听该 URL", 40)
  }
} catch (err) {
  bad("GET /models", `连接失败：${err?.message ?? err}`, "网关没起，sh run.sh start（Windows：marvis.bat bg / run-local.bat）", 40)
}

// /health 是参考仓库 Marvis-proxy-public 的接口；别的网关没有就跳过，不算失败。
const healthUrl = `${String(cfg.url).replace(/\/v1\/?$/i, "").replace(/\/+$/, "")}/health`
try {
  const r = await getJson(healthUrl)
  if (r.ok && r.json?.accounts) {
    const a = r.json.accounts
    const u = r.json.uskey
    ok("GET /health",
      `accounts total=${a.total ?? 0} active=${a.active ?? 0} cooling=${a.cooling ?? 0} expired=${a.expired ?? 0}` +
      `；uskey ok=${u?.ok ?? "?"} backend=${u?.backend ?? "?"}`)
  } else {
    info("GET /health", `不可用或格式不符（HTTP ${r.status}），非参考仓库网关则跳过`)
  }
} catch (err) {
  info("GET /health", `不可用（${err?.message ?? err}），跳过`)
}

// ── 4. 关键分流：最小 chat 请求 ──────────────────────────────────────────
console.log()
console.log("[4/4] 关键分流：最小 chat 请求（max_tokens=1，超时 15s）")
if (!modelsOk || !modelId) {
  bad("chat 探测", "没有可用模型 id（/models 未返回 data[0].id）", "先修网关连通，再重跑诊断", 30)
} else {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "magpie-doctor/1.0",
  }
  if (probeKey) {
    headers.Authorization = `Bearer ${probeKey}` // 只用于请求，不打印
    headers["X-API-Key"] = probeKey
  }
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: false,
  })
  try {
    const res = await directFetch(`${String(cfg.url).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(CHAT_TIMEOUT),
    })
    const text = await res.text()
    let j = null
    try { j = JSON.parse(text) } catch { /* 非 JSON 忽略 */ }
    const status = res.status
    const code = String(j?.error?.code ?? j?.code ?? "")
    const msg = String(j?.error?.message ?? j?.msg ?? j?.message ?? "")
    const label = `chat model=${modelId}`
    const brief = `HTTP ${status} code=${code || "-"} msg=${(msg || text).slice(0, 120)}`

    if (res.ok && !code) {
      ok(label, `HTTP ${status}，全链路通：网关确实拿到上游输出`)
    } else if (code === "4100404" || /风控/.test(msg)) {
      bad(label, brief, "上游风控，非配置问题，等解除；切 off/gateway 无效", 1)
    } else if (code === "4100403" || /登录态/.test(msg)) {
      bad(label, brief, "网关加号重新登录（控制台 → 账号池 → login start / login exchange）", 2)
    } else if (code === "no_account" || status === 503 || /没有可用账号/.test(msg)) {
      bad(label, brief, "网关账号池空，先加号（账号池 → login start）", 3)
    } else if (status === 401 || code === "invalid_api_key" || /api key|鉴权|unauthorized/i.test(msg)) {
      bad(label, brief, "网关 key 没配，写进 gateway.json 或 MARVIS_GATEWAY_KEY", 4)
    } else {
      bad(label, brief, "查网关日志 logs/ 定位上游状态码", 5)
    }
  } catch (err) {
    bad("chat 探测", `连接失败：${err?.message ?? err}`,
      "网关没起，sh run.sh start（Windows：marvis.bat bg / run-local.bat）", 6)
  }
}

// ── 总结 ─────────────────────────────────────────────────────────────────
console.log()
console.log("=== 总结 ===")
if (failures.length === 0) {
  ok("全链路", "插件 / 配置 / /models / /health / chat 全通")
} else {
  console.log(`✗ 共 ${failures.length} 环失败`)
  failures.sort((a, b) => a.rank - b.rank)
  const top = failures[0]
  console.log(`最可能的一环：${top.label} —— ${top.hint}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
