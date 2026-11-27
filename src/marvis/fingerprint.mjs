// 设备指纹 —— uskey / qimei36 的来源
//
// 2026-11-17 16:42 之后，腾讯 Marvis 的 `/v1/chat/completions` 会校验
// `Ual-Access-MarvisExt.uskey` 是否由 Beacon/Qimei SDK 按**本次请求上下文**现算。
// 随机 uskey 第一次请求就会 4100404（issue #70 / #71 / #72）。
//
// 本模块按优先级走三条路：
//   1. native/ 里的官方 Beacon SDK（beacon_napi.node）—— 推荐；
//   2. MARVIS_USKEY_URL 指向的外部出票服务（Docker / 容器场景）；
//   3. 仅开发兜底：MARVIS_ALLOW_RANDOM_USKEY=1 时随机生成。
//
// native/ 需要的 4 个文件：beacon_napi.node / qimei.dll / beacon_sdk.dll / beacon_wrapper.dll
// 从本机 Marvis 客户端的 win32-native 目录复制。qimei36 可以放在 native/qimei36.txt，
// 也可以用环境变量 MARVIS_QIMEI36 传入。

import { randomBytes } from "node:crypto"
import { directFetch } from "./directnet.mjs"
import { createRequire } from "node:module"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件根目录下的 native/；可用 MARVIS_NATIVE_DIR 指到外部目录 */
export const NATIVE_DIR = process.env.MARVIS_NATIVE_DIR || join(HERE, "..", "..", "native")

/** 四个文件一起才工作（beacon_napi.node 靠同目录兄弟 DLL 动态加载） */
const REQUIRED = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

/** 上游 appKey —— 来自 Marvis 的 resources/.env 的 MARVIS_QIMEI_APPKEY */
const APP_KEY = process.env.MARVIS_QIMEI_APPKEY || "0WIN06Y06DKV1IUQ"
/**
 * Beacon SDK 初始化版本。
 *
 * 旧版写死 `1.60.3400.35`，但本机客户端实际版本持续在变（已见 1.60.3500.x /
 * 1.60.3600.x）。`init(appKey, appVersion)` 的版本号会进入 SDK 的风纹参数；
 * 与实际客户端不一致会放大“插件指纹 vs 官方客户端”的差异。
 *
 * 取值顺序：
 *   1. MARVIS_APP_VERSION（显式覆盖，最高优先级，行为与旧版完全一致）；
 *   2. 客户端日志里的 `client_platform_version`（本机实测 1.60.3600.59）；
 *   3. 客户端安装目录 `Application\<version>\win32-native` 的目录名；
 *   4. 兜底 DEFAULT_APP_VERSION（旧值）。
 *
 * 探测结果进程级缓存一次（日志扫描有 IO 成本）；环境变量每次读取，改了立即生效。
 */
const DEFAULT_APP_VERSION = "1.60.3400.35"
const CLIENT_VERSION_RX = /client_platform_version\\?["']?\s*[:=]\s*\\?["']?(\d+\.\d+\.\d+\.\d+)/g
const CLIENT_DIR_VERSION_RX = /^(\d+\.\d+\.\d+\.\d+)$/
let detectedAppVersion = ""
let appVersionScanned = false

function compareVersionDesc(a, b) {
  const pa = String(a).split(".").map(Number)
  const pb = String(b).split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** 从客户端日志与安装目录探测运行中的 Marvis 版本；找不到返回空串 */
function detectAppVersion() {
  if (appVersionScanned) return detectedAppVersion
  appVersionScanned = true
  const found = new Set()

  // 1) 客户端日志：客户端自己上报的 client_platform_version 最可靠。
  //    优先取 mtime 最新的几个 Marvis*.log，避免读一整个历史目录。
  const logDirs = [
    process.env.MARVIS_LOG_DIR,
    join(homedir(), "AppData", "Local", "Temp", "Tencent", "Marvis", "logs"),
    join(homedir(), ".config", "Tencent", "Marvis", "logs"),
    "/tmp/Tencent/Marvis/logs",
  ].filter(Boolean)
  let stop = false
  for (const dir of logDirs) {
    if (stop || !existsSync(dir)) continue
    let files = []
    try {
      files = readdirSync(dir)
        .filter((f) => /^Marvis.*\.log$/i.test(f))
        .map((f) => ({ f, p: join(dir, f) }))
        .filter((x) => {
          try {
            return statSync(x.p).size < 64 * 1024 * 1024
          } catch {
            return false
          }
        })
        .sort((a, b) => {
          try {
            return statSync(b.p).mtimeMs - statSync(a.p).mtimeMs
          } catch {
            return 0
          }
        })
        .slice(0, 5)
    } catch {
      continue
    }
    for (const { p } of files) {
      try {
        const text = readFileSync(p, "utf8")
        for (const m of text.matchAll(CLIENT_VERSION_RX)) found.add(m[1])
        if (found.size) {
          stop = true
          break
        }
      } catch {
        /* 日志被占用 / 读不了就跳过 */
      }
    }
  }

  // 2) 安装目录名兜底：Program Files\Tencent\Marvis\Application\<version>\
  if (!found.size) {
    for (const envName of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
      const base = process.env[envName]
      if (!base) continue
      let names = []
      try {
        names = readdirSync(join(base, "Tencent", "Marvis", "Application"))
      } catch {
        continue
      }
      for (const name of names) {
        if (CLIENT_DIR_VERSION_RX.test(name)) found.add(name)
      }
      if (found.size) break
    }
  }

  detectedAppVersion = [...found].sort(compareVersionDesc)[0] || ""
  return detectedAppVersion
}

/** 当前生效的 Beacon 初始化版本（每次读 env，探测结果缓存） */
export function appVersion() {
  const env = String(process.env.MARVIS_APP_VERSION ?? "").trim()
  return env || detectAppVersion() || DEFAULT_APP_VERSION
}

/** native SDK 的业务 id（不是 /v3 的 marvis_client） */
export const USKEY_BUS_ID = process.env.MARVIS_USKEY_BUSID || "marvis"

/** 旧版随机兜底的字节长度；只在开发兜底时使用 */
export const USKEY_BYTES = 376

/** @type {{ getUskey?: Function, getQimei?: Function, init?: Function, setCommonParams?: Function } | null} */
let beacon = null
let beaconTried = false
let beaconError = ""
let commonKey = ""
let qimeiCache = ""
/** 外部出票返回的 qimei36，按账号缓存（旧版是进程级单例，多账号互相覆盖） */
const externalQimeiByAccount = new Map()
/** detectQimeiFromClient 的进程级缓存：扫过一次（哪怕没找到）就不再扫 */
let clientScanDone = false
let clientScanHit = ""
let warnedRandom = false
let warnedNative = false

/** 账号 key：优先 login_openid，其次 guid，都没有落 "*" 桶 */
function accountKeyOfCommon(common = {}) {
  return String(common?.login_openid ?? common?.guid ?? "").trim() || "*"
}

/**
 * 重置指纹缓存（客户端升级 DLL / 首次扫描时日志还没生成 qimei36 时用）。
 * 不改 process.env：MARVIS_APP_VERSION 等仍即时生效；这里只重置进程级探测结果，
 * 下次 uskeyOf / qimei36 调用会重新加载 native 与扫描日志。供 CLI / doctor 调用。
 */
export function reloadFingerprint() {
  beacon = null
  beaconTried = false
  beaconError = ""
  commonKey = ""
  qimeiCache = ""
  externalQimeiByAccount.clear()
  clientScanDone = false
  clientScanHit = ""
  warnedRandom = false
  warnedNative = false
  detectedAppVersion = ""
  appVersionScanned = false
}

/** native 目录 mtime（诊断用：升级 DLL 后与上次记录对比，提示 reloadFingerprint） */
export function nativeMtimeMs() {
  try {
    return Math.max(...REQUIRED.map((f) => {
      try { return statSync(join(NATIVE_DIR, f)).mtimeMs } catch { return 0 }
    }))
  } catch {
    return 0
  }
}

function warnOnce(msg) {
  if (warnedNative) return
  warnedNative = true
  try {
    console.warn(`[marvis-fingerprint] ${msg}`)
  } catch {
    /* 日志失败不影响请求 */
  }
}

function applyCommon(common) {
  if (!beacon || !common) return
  const key = JSON.stringify(common)
  if (key === commonKey) return
  if (typeof beacon.setCommonParams === "function") {
    try {
      beacon.setCommonParams(common)
      commonKey = key
    } catch (err) {
      beaconError = `setCommonParams: ${err?.message ?? err}`
    }
  }
}

/**
 * 加载官方 Beacon SDK。
 *
 * 注意：`beacon_napi.node` 的真实签名是 `init(appKey, appVersion)`，
 * 不是 `init({ appKey, appVersion })`；`getUskey` 的第二参是 `busInfo` 字符串，
 * 不是 `{ reqScene, taskType }`。旧实现这两处都传错了，所以即使放了 native/
 * 也拿不到与请求上下文绑定的票。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} [common]
 * @returns {object | null}
 */
function loadBeacon(common = {}) {
  if (beaconTried) {
    applyCommon(common)
    return beacon
  }
  beaconTried = true
  try {
    if (!REQUIRED.every((f) => existsSync(join(NATIVE_DIR, f)))) {
      beaconError = `native/ 缺少文件：${REQUIRED.join(" / ")}（目录 ${NATIVE_DIR}）`
      return null
    }
    const mod = require(join(NATIVE_DIR, "beacon_napi.node"))
    // 有的版本 init 返回 0，有的返回 undefined；调用失败也继续试着出票。
    try {
      mod.init(APP_KEY, appVersion())
    } catch (err) {
      beaconError = `init: ${err?.message ?? err}`
    }
    beacon = mod
    applyCommon(common)
    return mod
  } catch (err) {
    beaconError = `${err?.name ?? "Error"}: ${err?.message ?? err}`
    return null
  }
}

/**
 * 外部出票服务地址：环境变量优先，其次插件 native/uskey-url.txt。
 * 0.9.8 瘦身：Android 默认地址（4617）已删除（手机传输已整体移除）。
 */
function uskeyUrl() {
  const env = String(process.env.MARVIS_USKEY_URL || "").trim()
  if (env) return env
  for (const name of ["uskey-url.txt", "uskey_url.txt"]) {
    try {
      const v = readFileSync(join(NATIVE_DIR, name), "utf8").trim()
      if (v) return v
    } catch {
      /* 文件不存在就继续 */
    }
  }
  return ""
}

/**
 * 从外部出票服务取一张 uskey。
 *
 * 请求：POST `MARVIS_USKEY_URL`
 * body：{"busid":"marvis","businfo":"...","common":{"guid":"...","login_openid":"...","login_type":"6"}}
 * 响应：{"uskey":"..."} 或纯文本 uskey。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} common
 * @param {string} busInfo
 * @param {AbortSignal} [signal] 调用方的取消信号（可选，与超时合并）
 * @returns {Promise<string>}
 */
async function externalUskey(common, busInfo, signal) {
  const url = uskeyUrl()
  if (!url) return ""
  // 出票服务挂起不能拖死整条请求链；默认 5s，由 MARVIS_USKEY_TIMEOUT_MS 覆盖。
  // 调用方给了 signal 时用 AbortSignal.any 合并（Node 24 / Bun ≥1.1 都有）。
  const timeoutRaw = Number.parseInt(String(process.env.MARVIS_USKEY_TIMEOUT_MS ?? ""), 10)
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 5000
  const deadline = AbortSignal.timeout(timeoutMs)
  const merged =
    signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, deadline]) : deadline
  try {
    const res = await directFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ busid: USKEY_BUS_ID, businfo: busInfo, common }),
      signal: merged,
    })
    if (!res.ok) return ""
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      const q = String(json?.qimei36 || json?.data?.qimei36 || "").trim()
      if (q) externalQimeiByAccount.set(accountKeyOfCommon(common), q)
      return String(json?.uskey || json?.data?.uskey || "").trim()
    } catch {
      return text.trim()
    }
  } catch {
    return ""
  }
}

const QIMEI_RX = /qimei36\W{0,3}([0-9a-f]{36,40})\b/i
const CLIENT_FILE_RX = /(\.log$|\.txt$|\.ldb$|\.sst$|\.json$|manifest|current)/i
const SKIP_DIR_RX = /(node_modules|Cache|GPUCache|Code Cache|Crashpad)/i
const MAX_SCAN_FILE = 8 * 1024 * 1024

/**
 * 快路径：只读客户端日志目录里已知的 qimei_debug_*.log / Marvis*.log。
 * 本机日志目录里确实有 qimei36 真值，命中后不必做深度 5 的全盘递归扫描。
 */
function detectQimeiFromKnownLogs() {
  const dirs = [
    process.env.MARVIS_LOG_DIR,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Temp", "Tencent", "Marvis", "logs"),
    process.env.APPDATA && join(process.env.APPDATA, "Tencent", "Marvis", "logs"),
    "/tmp/Tencent/Marvis/logs",
  ].filter(Boolean)
  for (const dir of dirs) {
    let files = []
    try {
      files = readdirSync(dir)
        .filter((f) => /^(qimei_debug_.*|Marvis.*)\.log$/i.test(f))
        .map((f) => join(dir, f))
        .slice(0, 8)
    } catch {
      continue
    }
    for (const p of files) {
      try {
        if (statSync(p).size > MAX_SCAN_FILE) continue
        const m = QIMEI_RX.exec(readFileSync(p, "utf8"))
        if (m) return m[1]
      } catch {
        /* 单文件读不了就跳过 */
      }
    }
  }
  return ""
}

/** 从 Marvis 客户端数据目录里找 qimei36（Windows 安装后通常已经有真值） */
function detectQimeiFromClient() {
  const fast = detectQimeiFromKnownLogs()
  if (fast) return fast

  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP]
    .filter(Boolean)
    .map((base) => join(String(base), "Tencent", "Marvis"))

  const scan = (dir, depth) => {
    if (depth > 5) return ""
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return ""
    }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_RX.test(entry.name)) continue
        const found = scan(file, depth + 1)
        if (found) return found
        continue
      }
      if (!entry.isFile() || !CLIENT_FILE_RX.test(entry.name)) continue
      try {
        if (statSync(file).size > MAX_SCAN_FILE) continue
        const text = readFileSync(file, "utf8")
        const m = QIMEI_RX.exec(text)
        if (m) return m[1]
      } catch {
        /* 单个文件读不了就跳过 */
      }
    }
    return ""
  }

  for (const root of roots) {
    const found = scan(root, 0)
    if (found) return found
  }
  return ""
}

/**
 * 设备 qimei36。
 *
 * 取真值顺序：MARVIS_QIMEI36 → native/qimei36.txt → native/qimei.txt →
 * Marvis 客户端数据目录 → Beacon SDK 的 getQimei()。
 * 取不到就返回空串；调用方据此决定要不要把该字段放进请求。
 *
 * @param {{ guid?: string, login_openid?: string, login_type?: string }} [common]
 * @returns {string}
 */
export function qimei36(common = {}) {
  if (qimeiCache) return qimeiCache
  const acctKey = accountKeyOfCommon(common)
  const cachedExternal = externalQimeiByAccount.get(acctKey)
  if (cachedExternal) return cachedExternal

  const env = String(process.env.MARVIS_QIMEI36 || "").trim()
  if (env) {
    qimeiCache = env
    return env
  }

  for (const name of ["qimei36.txt", "qimei.txt"]) {
    try {
      const v = readFileSync(join(NATIVE_DIR, name), "utf8").trim()
      if (v) {
        qimeiCache = v
        return v
      }
    } catch {
      /* 文件不存在就继续 */
    }
  }

  const b = loadBeacon(common)
  if (b && typeof b.getQimei === "function") {
    try {
      const v = String(b.getQimei() ?? "").trim()
      if (v) {
        qimeiCache = v
        return v
      }
    } catch {
      /* 继续从客户端数据里找 */
    }
  }

  // 客户端目录全盘扫（深度 5、单文件 8MB，同步 IO）很贵 —— 负结果也做进程级
  // 缓存：没有 native、没有 qimei 文件的机器上扫过一次没找到，就不再每个请求
  // 都把 APPDATA/LOCALAPPDATA/TEMP 的 Tencent/Marvis 目录重扫一遍。
  // externalQimei 的优先级语义不变：它是在本函数开头的 externalQimei 检查里
  // 先于扫描结果生效的，负缓存不写 qimeiCache，不影响这条链路。
  if (!clientScanDone) {
    clientScanDone = true
    clientScanHit = detectQimeiFromClient()
  }
  if (clientScanHit) {
    qimeiCache = clientScanHit
    return clientScanHit
  }
  return ""
}

/**
 * 本地随机 uskey —— 只用于开发兜底。
 * 2026-11-17 之后上游会按请求上下文校验，随机值在正式环境会 4100404。
 * @returns {string}
 */
export function localUskey() {
  return randomBytes(USKEY_BYTES).toString("base64")
}

/**
 * 随机 uskey 兜底是否显式开启 —— 只认 "1" / "true" / "dev" 三个值，
 * 其余（未设置 / "0" / 其他任意值）一律算关闭。0.5.4 默认翻转：静默兜底
 * 在线上必然 4100404，fail-fast 才能让故障被看见。
 * @returns {boolean}
 */
function randomUskeyAllowed() {
  const v = String(process.env.MARVIS_ALLOW_RANDOM_USKEY ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "dev"
}

/** `localUskey()` 的别名，保留旧名字方便迁移。 */
export function syntheticUskey() {
  return localUskey()
}

export async function uskeyOf(acct = {}, identity = {}) {
  const busInfo = String(identity.busInfo || "")
  if (!busInfo) throw new Error("uskeyOf 需要 identity.busInfo（请求上下文不能为空）")

  const common = {
    guid: String(acct.guid ?? ""),
    login_openid: String(acct.openid ?? ""),
    login_type: String(identity.loginType ?? process.env.MARVIS_LOGIN_TYPE ?? "6"),
  }

  const b = loadBeacon(common)
  if (b && typeof b.getUskey === "function") {
    try {
      const real = String(b.getUskey(USKEY_BUS_ID, busInfo) ?? "").trim()
      if (real && real !== "null") return real
    } catch (err) {
      beaconError = `getUskey: ${err?.message ?? err}`
    }
  }

  const external = await externalUskey(common, busInfo)
  if (external) return external

  // 开发兜底（0.5.4 翻转）：只有显式 opt-in（MARVIS_ALLOW_RANDOM_USKEY=1/true/dev）
  // 才允许随机 uskey。旧行为"只要不是 0 就静默随机"在线上必然 4100404，
  // 还会把故障伪装成偶发风控 —— 默认改为 fail-fast，错误信息给出三条出路。
  // 注意：gateway / openclaw 传输不调 uskeyOf，只有 PC HTTP 直连路径受影响。
  if (randomUskeyAllowed()) {
    if (!warnedRandom) {
      warnedRandom = true
      warnOnce(
        `没有可用的 Beacon 出票（${beaconError || "native/ 不可用"}），` +
          "已按 MARVIS_ALLOW_RANDOM_USKEY 显式开启随机 uskey；" +
          "2026-11-17 之后上游按请求上下文校验，正式环境必然 4100404（仅限开发调试）。",
      )
    }
    return localUskey()
  }

  throw new Error(
    "Marvis uskey 出票失败（0.5.4 起默认 fail-fast，不再静默用随机值）。三条出路任选其一：\n" +
      `  1. 把 Marvis 客户端 win32-native 的 4 个文件放进 ${NATIVE_DIR}：` +
      `${REQUIRED.join(" / ")}；\n` +
      "  2. 或设置 MARVIS_USKEY_URL 指向出票服务" +
      "（本机可用 node tools/uskey-server.mjs 启动，默认 http://127.0.0.1:4617/uskey）；\n" +
      "  3. 仅开发调试：显式设 MARVIS_ALLOW_RANDOM_USKEY=1（或 true/dev）启用随机兜底，" +
      "正式环境会被上游 4100404 拦截。\n" +
      `${beaconError ? `底层原因：${beaconError}` : ""}`,
  )
}

/** 当前是否在用官方 Beacon SDK 签指纹（诊断用） */
export function usingNativeFingerprint() {
  return loadBeacon() !== null
}

/** 出票/指纹状态（诊断用） */
export function fingerprintStatus() {
  const native = usingNativeFingerprint()
  const qimei = qimei36()
  return {
    native,
    nativeDir: NATIVE_DIR,
    nativeMtimeMs: nativeMtimeMs(),
    uskeyTimeoutMs: (() => {
      const n = Number.parseInt(String(process.env.MARVIS_USKEY_TIMEOUT_MS ?? ""), 10)
      return Number.isFinite(n) && n > 0 ? n : 5000
    })(),
    appVersion: appVersion(),
    appVersionSource: String(process.env.MARVIS_APP_VERSION ?? "").trim()
      ? "env"
      : detectedAppVersion
        ? "detected"
        : "default",
    qimei36: qimei ? `${qimei.slice(0, 6)}…` : "",
    qimei36Length: qimei.length,
    // backend 只报告"实际会走的出票通道"："random" 仅在显式 opt-in 时出现；
    // 什么都没配（且未 opt-in）时是 "none" —— uskeyOf 会 fail-fast
    backend: native
      ? "native"
      : uskeyUrl()
        ? "external"
        : randomUskeyAllowed()
          ? "random"
          : "none",
    error: beaconError,
  }
}

/** 给用户看的说明 */
export function fingerprintHint() {
  if (usingNativeFingerprint()) return "使用 native/ 里的 Beacon SDK 现签设备指纹"
  if (uskeyUrl()) return "使用外部出票服务（MARVIS_USKEY_URL / native/uskey-url.txt）"
  if (randomUskeyAllowed())
    return "MARVIS_ALLOW_RANDOM_USKEY 已显式开启：随机 uskey 兜底（仅限开发，线上必 4100404）"
  return (
    "未配置出票（fail-fast）：native 4 文件 / MARVIS_USKEY_URL / MARVIS_ALLOW_RANDOM_USKEY=1 三选一"
  )
}
