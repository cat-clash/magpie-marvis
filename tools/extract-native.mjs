// extract-native.mjs —— 从本机已安装的 Marvis Windows 客户端提取 Beacon SDK 4 件套。
//
// 用法：
//   node tools/extract-native.mjs                    打印帮助 + 探测报告 + 目标目录状态（不写盘）
//   node tools/extract-native.mjs --dry-run         只打印将做什么，不写盘
//   node tools/extract-native.mjs --dest DIR        指定目标目录（不存在自动创建）
//   node tools/extract-native.mjs --qimei           额外探测客户端数据目录的 qimei36，写入 qimei36.txt
//   （可组合：--dest DIR --dry-run --qimei）
//
// 目标目录优先级：--dest 参数 > MARVIS_NATIVE_DIR 环境变量 > ~/.magpie-marvis-native
// （与 src/marvis/localgateway.mjs 的 nativeDir() 语义一致；本工具自包含判断，不 import 该模块）
//
// 退出码：
//   0  找到客户端且 4 件套复制成功
//   1  找到客户端但缺文件
//   2  找不到 Marvis 客户端
//   3  复制过程出错
//
// Windows / Android 说明：
//   · 4 件套（beacon_napi.node / qimei.dll / beacon_sdk.dll / beacon_wrapper.dll）在客户端安装
//     目录的 win32-native/ 子目录；本工具只复制、不改客户端。
//   · 客户端真实安装位置五花八门（Program Files、D:\Marvis、LOCALAPPDATA 等），因此按下面
//     的候选顺序探测，并在输出里打印找过哪些位置、哪个命中。
//   · Android 端没有 win32-native：本工具面向 Windows 客户端；手机端把 qimei36 写进目标目录的
//     qimei36.txt 即可，无需运行本工具。
//
// qimei36 扫描逻辑与 src/marvis/fingerprint.mjs 的 detectQimeiFromClient 对应（复制实现、自包含，
// 不 import；该文件由别的工具管，勿改）。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 必需的 4 件套（与 src/marvis/fingerprint.mjs 的 REQUIRED 一致） */
export const REQUIRED = ["beacon_napi.node", "qimei.dll", "beacon_sdk.dll", "beacon_wrapper.dll"]

/** 在客户端根目录树内搜 win32-native 的递归深度上限 */
const MAX_NATIVE_DEPTH = 4

/** qimei36 扫描参数（与 fingerprint.mjs 保持一致） */
const MAX_SCAN_FILE = 8 * 1024 * 1024
const QIMEI_RX = /qimei36\W{0,3}([0-9a-f]{36,40})\b/i
const CLIENT_FILE_RX = /(\.log$|\.txt$|\.ldb$|\.sst$|\.json$|manifest|current)/i
const SKIP_DIR_RX = /(node_modules|Cache|GPUCache|Code Cache|Crashpad)/i

/** 读取目录名列表，失败（不存在/无权限）返回空数组 */
function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => e.name)
  } catch {
    return []
  }
}

/** 客户端数据目录默认候选（与 fingerprint.mjs 的 roots 一致） */
function defaultDataRoots() {
  return [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP]
    .filter(Boolean)
    .map((base) => join(String(base), "Tencent", "Marvis"))
}

/** 从路径提取盘符前缀（如 C:），无盘符返回空串 */
function rootDriveOf(p) {
  const m = /^([A-Za-z]):[\\/]/.exec(String(p))
  return m ? `${m[1].toUpperCase()}:` : ""
}

/** 枚举当前系统存在的盘符根 */
function safeDriveList() {
  const out = []
  for (const d of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (existsSync(`${d}:\\`)) out.push(`${d}:`)
  }
  return out
}

/**
 * 注册表 Uninstall 键只读查询：HKLM / HKCU 下 DisplayName 含 Marvis 的 InstallLocation。
 * 用 reg query（只读命令）；查询失败静默跳过。
 */
function registryCandidates() {
  const out = []
  for (const hive of [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]) {
    let buf = ""
    try {
      buf = execFileSync("reg", ["query", hive, "/s"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      })
    } catch {
      continue
    }
    // reg query /s 输出：键名行（HKEY...）+ 缩进的 值名 REG_类型 值
    let disp = ""
    let loc = ""
    const flush = () => {
      if (/marvis/i.test(disp) && loc) out.push({ root: resolve(loc), source: `注册表 Uninstall（${hive}）` })
      disp = ""
      loc = ""
    }
    for (const raw of buf.split(/\r?\n/)) {
      if (/^HKEY/i.test(raw.trim())) {
        flush()
        continue
      }
      const m = /^(\w+)\s+REG_\w+\s+(.*)$/.exec(raw.trim())
      if (!m) continue
      const [, name, val] = m
      if (/^DisplayName$/i.test(name)) disp = val
      else if (/^InstallLocation$/i.test(name)) loc = val
    }
    flush()
  }
  return out
}

/**
 * 探测 Marvis 客户端安装根目录。
 *
 * @param {{ roots?: string[] }} [opts] roots 为注入的候选根（测试用），给了就跳过真实探测序
 * @returns {Array<{ root: string, source: string }>} 按探测顺序去重后的候选列表
 */
export function findClientRoots(opts = {}) {
  const seen = new Set()
  const out = []
  const add = (root, source) => {
    if (!root) return
    const p = resolve(String(root))
    if (seen.has(p) || !existsSync(p)) return
    seen.add(p)
    out.push({ root: p, source })
  }

  if (opts.roots) {
    for (const r of opts.roots) add(r, "注入候选根")
    return out
  }

  // 1. 环境变量显式指定
  if (process.env.MARVIS_CLIENT_DIR) add(process.env.MARVIS_CLIENT_DIR, "MARVIS_CLIENT_DIR")

  // 2. Program Files / Program Files (x86) / ProgramW6432 下 Tencent\* 含 marvis 的目录
  for (const envName of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const base = process.env[envName]
    if (!base) continue
    for (const name of safeReaddir(join(base, "Tencent"))) {
      if (/marvis/i.test(name)) add(join(base, "Tencent", name), `${envName}\\Tencent\\${name}`)
    }
  }

  // 3. %LOCALAPPDATA%\Programs\* 下含 marvis 的目录
  if (process.env.LOCALAPPDATA) {
    for (const name of safeReaddir(join(process.env.LOCALAPPDATA, "Programs"))) {
      if (/marvis/i.test(name)) add(join(process.env.LOCALAPPDATA, "Programs", name), `LOCALAPPDATA\\Programs\\${name}`)
    }
  }

  // 4. 非系统盘根目录一层：X:\Marvis、X:\Tencent\Marvis（只扫根目录一层，不递归）
  for (const drive of safeDriveList()) {
    add(join(drive, "Marvis"), `${drive}\\ 根目录`)
    add(join(drive, "Tencent", "Marvis"), `${drive}\\Tencent\\Marvis`)
  }

  // 5. 客户端数据目录的同级/上级推断：数据目录所在盘根下的 Marvis / Tencent\Marvis（兜底）
  for (const dataRoot of defaultDataRoots()) {
    const drive = rootDriveOf(dataRoot)
    if (!drive) continue
    add(join(drive, "Marvis"), `数据目录所在盘根推断（${dataRoot}）`)
    add(join(drive, "Tencent", "Marvis"), `数据目录所在盘根推断（${dataRoot}）`)
  }

  // 6. 注册表 Uninstall 键 InstallLocation
  for (const c of registryCandidates()) add(c.root, c.source)

  return out
}

/**
 * 在客户端根目录树内定位 win32-native 目录（限深 MAX_NATIVE_DEPTH，
 * 要求目录内至少存在一个必需文件，避免命中空壳）。
 *
 * @param {string} clientRoot 客户端安装根
 * @returns {string} win32-native 绝对路径；找不到返回空串
 */
export function findNativeDir(clientRoot) {
  const walk = (dir, depth) => {
    if (depth > MAX_NATIVE_DEPTH) return ""
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (/^win32-native$/i.test(name) && isDir) {
        if (REQUIRED.some((f) => existsSync(join(p, f)))) return p
      } else if (isDir) {
        const r = walk(p, depth + 1)
        if (r) return r
      }
    }
    return ""
  }
  return walk(resolve(String(clientRoot)), 0)
}

/**
 * 从 Marvis 客户端数据目录扫描 qimei36。
 * 逻辑与 src/marvis/fingerprint.mjs 的 detectQimeiFromClient 对应（自包含复制，不 import）：
 * 过滤 .log/.txt/.ldb/.sst/.json/manifest/current，跳过 node_modules/Cache/GPUCache/
 * Code Cache/Crashpad，单文件 ≤8MB，正则 /qimei36\W{0,3}([0-9a-f]{36,40})\b/i。
 *
 * @param {string[]} roots 数据目录根列表
 * @returns {string} 找到的 qimei36；找不到返回空串（可选项，不影响出票）
 */
export function scanQimei36(roots) {
  const scan = (dir, depth) => {
    if (depth > 5) return ""
    const entries = safeReaddir(dir)
    for (const name of entries) {
      const file = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(file).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (SKIP_DIR_RX.test(name)) continue
        const found = scan(file, depth + 1)
        if (found) return found
        continue
      }
      if (!CLIENT_FILE_RX.test(name)) continue
      try {
        if (statSync(file).size > MAX_SCAN_FILE) continue
        const m = QIMEI_RX.exec(readFileSync(file, "utf8"))
        if (m) return m[1]
      } catch {
        /* 单个文件读不了就跳过 */
      }
    }
    return ""
  }
  for (const root of roots) {
    if (root && existsSync(root)) {
      const found = scan(root, 0)
      if (found) return found
    }
  }
  return ""
}

/**
 * 解析目标目录（与 localgateway.mjs 的 nativeDir() 语义一致，自包含判断）：
 * --dest > MARVIS_NATIVE_DIR > ~/.magpie-marvis-native。
 *
 * @param {{ cliDest?: string }} [opts]
 * @returns {string} 目标目录绝对路径
 */
export function resolveDest({ cliDest } = {}) {
  if (cliDest) return resolve(cliDest)
  if (process.env.MARVIS_NATIVE_DIR) return resolve(process.env.MARVIS_NATIVE_DIR)
  try {
    return resolve(join(homedir(), ".magpie-marvis-native"))
  } catch {
    return resolve(join(ROOT, "native"))
  }
}

/**
 * 提取主函数（可被测试直接调用）。
 *
 * @param {object} [opts]
 * @param {string} [opts.dest]   --dest 的目标目录
 * @param {boolean} [opts.dryRun] --dry-run：只打印计划，不写盘
 * @param {boolean} [opts.qimei]  --qimei：额外探测 qimei36 并写入目标目录 qimei36.txt
 * @param {string[]} [opts.roots] 注入的客户端候选根（测试用，跳过真实探测序）
 * @param {string[]} [opts.dataRoots] 注入的客户端数据目录根（测试用）
 * @param {(...args: any[]) => void} [opts.log] 日志输出函数（默认 console.log）
 * @returns {{ exitCode: number, destDir: string, clientRoots: Array, clientRoot: string,
 *            nativeDir: string, missing: string[], copied: string[], qimei36: string, dryRun: boolean }}
 */
export function extractNative(opts = {}) {
  const { dest, dryRun = false, qimei = false, roots, dataRoots, log = (...a) => console.log(...a) } = opts
  const destDir = resolveDest({ cliDest: dest })
  const report = {
    exitCode: -1,
    destDir,
    clientRoots: [],
    clientRoot: "",
    nativeDir: "",
    missing: [],
    copied: [],
    qimei36: "",
    dryRun,
  }

  log(`[目标目录] ${destDir}${dryRun ? "（dry-run，不写盘）" : ""}`)

  const found = findClientRoots({ roots })
  report.clientRoots = found
  for (const c of found) log(`[探测] 候选 ${c.root}（来源：${c.source}）`)
  if (found.length === 0) {
    log("[探测] 未找到 Marvis 客户端安装目录（以上是全部找过的位置）。")
    report.exitCode = 2
    return report
  }

  // 选第一个能定位到 win32-native 的候选
  for (const c of found) {
    const nd = findNativeDir(c.root)
    if (nd) {
      report.clientRoot = c.root
      report.nativeDir = nd
      break
    }
  }
  if (!report.nativeDir) {
    // 候选根存在但树内没有含必需文件的 win32-native —— 只是个普通目录，不算找到客户端
    log("[探测] 找过以上位置，没有任何候选的目录树内（限深 4）含必需文件的 win32-native 目录。")
    report.exitCode = 2
    return report
  }
  log(`[命中] ${report.nativeDir}`)

  report.missing = REQUIRED.filter((f) => !existsSync(join(report.nativeDir, f)))
  for (const f of REQUIRED) {
    log(`[状态] ${f} ${existsSync(join(report.nativeDir, f)) ? "齐全" : "缺失"}`)
  }
  if (report.missing.length > 0) {
    log(`缺少：${report.missing.join(" / ")}`)
    report.exitCode = 1
    return report
  }

  // 写盘前打印来源 → 目标清单
  const plan = REQUIRED.map((f) => ({ file: f, from: join(report.nativeDir, f), to: join(destDir, f) }))
  log("[计划] 复制清单：")
  for (const p of plan) log(`  ${p.from}  →  ${p.to}`)

  if (dryRun) {
    if (qimei) {
      const q = scanQimei36(dataRoots ?? defaultDataRoots())
      report.qimei36 = q
      log(`[dry-run] qimei36 ${q ? `探测到 ${q}，将写入 ${join(destDir, "qimei36.txt")}` : "未探测到（可选项，不影响出票）"}`)
    }
    log("[dry-run] 仅打印，不写盘。")
    report.exitCode = 0
    return report
  }

  try {
    mkdirSync(destDir, { recursive: true })
    for (const p of plan) {
      copyFileSync(p.from, p.to)
      report.copied.push(p.file)
      log(`copied ${p.file}`)
    }
    log("native 就绪")
    report.exitCode = 0

    if (qimei) {
      const q = scanQimei36(dataRoots ?? defaultDataRoots())
      report.qimei36 = q
      if (q) {
        writeFileSync(join(destDir, "qimei36.txt"), `${q}\n`, "utf8")
        log(`qimei36 已写入 ${join(destDir, "qimei36.txt")}`)
      } else {
        log("qimei36 未在客户端数据目录中找到，属可选项，不影响出票。")
      }
    }
  } catch (err) {
    log(`复制出错：${err?.message ?? err}`)
    report.exitCode = 3
  }
  return report
}

function helpText() {
  return [
    "extract-native.mjs —— 从本机 Marvis Windows 客户端提取 Beacon SDK 4 件套",
    "",
    "用法：",
    "  node tools/extract-native.mjs                    打印帮助 + 探测报告 + 目标目录状态（不写盘）",
    "  node tools/extract-native.mjs --dry-run         只打印将做什么，不写盘",
    "  node tools/extract-native.mjs --dest DIR        指定目标目录（不存在自动创建）",
    "  node tools/extract-native.mjs --qimei           额外探测 qimei36 写入 qimei36.txt（可选项）",
    "  node tools/extract-native.mjs -h, --help        打印本帮助",
    "",
    "参数：",
    "  --dest DIR    目标目录，优先级最高",
    "  --dry-run     只打印计划，不写盘",
    "  --qimei       从客户端数据目录扫描 qimei36 写入目标目录 qimei36.txt",
    "",
    "目标目录优先级：--dest > MARVIS_NATIVE_DIR > ~/.magpie-marvis-native",
    "",
    "客户端自动探测顺序：",
    "  1. 环境变量 MARVIS_CLIENT_DIR 显式指定",
    "  2. Program Files / Program Files (x86) / ProgramW6432 下 Tencent\\* 含 marvis 的目录",
    "  3. %LOCALAPPDATA%\\Programs\\* 下含 marvis 的目录",
    "  4. 非系统盘根目录一层：X:\\Marvis、X:\\Tencent\\Marvis",
    "  5. 客户端数据目录所在盘根的 X:\\Marvis、X:\\Tencent\\Marvis（兜底推断）",
    "  6. 注册表 HKLM / HKCU ...\\Uninstall 中 DisplayName 含 Marvis 的 InstallLocation",
    "",
    "退出码：0 成功；1 找到客户端但缺文件；2 找不到客户端；3 复制出错。",
  ].join("\n")
}

/** 打印目标目录现有内容（仅展示，不写盘） */
function listDest(destDir, log) {
  try {
    const entries = readdirSync(destDir)
    log(`[目标目录内容] ${destDir}`)
    if (entries.length === 0) log("  （空）")
    for (const e of entries) log(`  ${e}`)
  } catch {
    log(`[目标目录内容] ${destDir} 不存在（首次复制时会自动创建）`)
  }
}

// CLI 壳：仅直接运行时执行。
// 退出用 process.exitCode 而非 process.exit()：后者会在 stdout 重定向/管道场景下
// 截断尚未 flush 的 console.log 输出。
// ⚠ 路径比较用 fileURLToPath + resolve + 小写化：Windows 盘符大小写（D:\ vs d:\）
// 或尾斜杠差异会让严格相等误判，导致「直接运行时 CLI 壳静默不执行」——
// 实测症状：exit 0 但零输出（模块加载成功、壳没进）。
const invokedAsCli =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (invokedAsCli) {
  const argv = process.argv.slice(2)
  const args = { dest: "", dryRun: false, qimei: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dest") args.dest = argv[++i] || ""
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--qimei") args.qimei = true
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(helpText())
    process.exitCode = 0
  } else if (argv.length === 0) {
    // 无参数：帮助 + 探测报告 + 目标目录状态（不写盘）
    console.log(helpText())
    console.log()
    const r = extractNative({ dryRun: true })
    listDest(r.destDir, console.log)
    process.exitCode = r.exitCode
  } else {
    const r = extractNative({ dest: args.dest, dryRun: args.dryRun, qimei: args.qimei })
    process.exitCode = r.exitCode
  }
}
