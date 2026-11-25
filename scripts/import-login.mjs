#!/usr/bin/env node
// import-login.mjs —— 把一份导出的登录态合并进 magpie 的 plugin-auth.json
//
// 典型场景：电脑端 magpie 已经用 Marvis（QQ / 微信）登录过，手机端因为
// 「网站应用扫码登录 + 微信禁止长按识别二维码」走不通，直接把电脑这份登录态
// 搬到手机上，比在手机上折腾扫码快得多。
//
// 用法：
//   node scripts/import-login.mjs marvis-desktop-login.json
//   node scripts/import-login.mjs login.json --config ~/.config/magpie --dry-run
//   node scripts/import-login.mjs login.json --overwrite --yes
//
// 约定：
//   - 源文件是 JSON 对象，形如 {"marvis#ftv1l6": {"access": "...", "refresh": "...", ...}}
//   - 只合并 `marvis#` / `marvis-proxy` 前缀的键（别的插件的账号不碰）
//   - 默认跳过目标里已存在的同名键（不覆盖别人的登录态），--overwrite 才覆盖
//   - 写盘前先备份 plugin-auth.json（.bak-<epoch 秒>），再原子 rename
//   - 退出码：0 成功（含无事可做）；1 参数/文件错误；2 键冲突且未给 --overwrite

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { atomicWrite, configDir, readAuthFile } from "../src/marvis/accounts-store.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

/** 只处理本插件的键，避免把别的插件的凭据搅进来 */
const OWN_PREFIXES = ["marvis#", "marvis-proxy"]

function usage() {
  return `用法：node scripts/import-login.mjs <导出的登录态.json> [选项]

把一份导出的登录态（{"marvis#xxxx": {...}}）合并进 magpie 的 plugin-auth.json。

选项：
  --config <dir>   指定 magpie 配置目录（默认 ~/.config/magpie）
  --dry-run        只打印将要做什么，不写盘
  --overwrite      目标里已有同名键时覆盖（默认跳过）
  --yes, -y        非交互环境写盘确认（在终端里会直接问）
  --json           输出 JSON 结果（脚本可解析）
  -h, --help       显示本帮助

通常怎么拿到源文件：在电脑端 magpie 配置目录里找 plugin-auth.json，
把里面 marvis# 开头的那几条复制到一个新文件里即可。`
}

function parseArgs(argv) {
  const args = { file: "", config: "", dryRun: false, overwrite: false, yes: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      args.help = true
    } else if (a === "--dry-run") {
      args.dryRun = true
    } else if (a === "--overwrite") {
      args.overwrite = true
    } else if (a === "--yes" || a === "-y") {
      args.yes = true
    } else if (a === "--json") {
      args.json = true
    } else if (a === "--config") {
      args.config = argv[++i] ?? ""
      if (!args.config) throw new Error("--config 需要目录参数")
    } else if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length)
    } else if (a.startsWith("-")) {
      throw new Error(`未知参数：${a}`)
    } else if (!args.file) {
      args.file = a
    } else {
      throw new Error(`多余的参数：${a}`)
    }
  }
  return args
}

function isOwnKey(key) {
  return OWN_PREFIXES.some((p) => key === p || key.startsWith(p))
}

/** 一条登录态看起来是不是「可用」：至少有 access 或 refresh，不然导过去也没用 */
function looksLikeCredential(v) {
  return Boolean(v && typeof v === "object" && (v.access || v.refresh || v.accessToken || v.access_token))
}

function loadSource(file) {
  if (!existsSync(file)) throw new Error(`找不到源文件：${file}`)
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    throw new Error(`读源文件失败：${err?.message ?? err}`)
  }
  let json = null
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`源文件不是合法 JSON：${err?.message ?? err}`)
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("源文件顶层必须是对象，形如 {\"marvis#xxxx\": {...}}")
  }
  const picked = {}
  for (const [k, v] of Object.entries(json)) {
    if (isOwnKey(k)) picked[k] = v
  }
  if (Object.keys(picked).length === 0) {
    throw new Error(`源文件里没有 ${OWN_PREFIXES.join(" / ")} 开头的键（别的插件的凭据不导入）`)
  }
  return picked
}

function question(text) {
  return new Promise((resolveAnswer) => {
    process.stdout.write(text)
    const onData = (buf) => {
      process.stdin.pause()
      process.stdin.off("data", onData)
      resolveAnswer(String(buf).trim().toLowerCase())
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
  })
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    return 1
  }
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (!args.file) {
    console.error(usage())
    return 1
  }

  let source
  try {
    source = loadSource(resolve(args.file))
  } catch (err) {
    console.error(err.message)
    return 1
  }

  const dir = configDir(args.config || undefined)
  const { file, json } = readAuthFile(dir)
  const target = json ?? {}

  /** @type {{key:string,action:"add"|"overwrite"|"skip",reason?:string}[]} */
  const plan = []
  const merged = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (!looksLikeCredential(value)) {
      plan.push({ key, action: "skip", reason: "没有 access/refresh，导过去也用不了" })
      continue
    }
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      if (args.overwrite) {
        merged[key] = value
        plan.push({ key, action: "overwrite" })
      } else {
        plan.push({ key, action: "skip", reason: "目标里已有同名键（要覆盖加 --overwrite）" })
      }
    } else {
      merged[key] = value
      plan.push({ key, action: "add" })
    }
  }

  const changes = plan.filter((p) => p.action !== "skip")
  const result = {
    action: "import-login",
    dryRun: args.dryRun,
    configDir: dir,
    file,
    fileExisted: Boolean(json),
    source: resolve(args.file),
    count: changes.length,
    plan,
    backup: null,
  }

  if (changes.length === 0) {
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`没有需要写入的账号（目标 ${file}）。`)
      for (const p of plan) console.log(`  - ${p.key}：${p.reason ?? p.action}`)
    }
    return 0
  }

  if (!args.dryRun && !args.yes && process.stdin.isTTY) {
    console.log(`即将写入 ${file}：`)
    for (const p of changes) console.log(`  ${p.action === "add" ? "+" : "~"} ${p.key}`)
    const ans = await question("继续？(y/N) ")
    if (ans !== "y" && ans !== "yes") {
      console.log("已取消，未写盘。")
      return 1
    }
  } else if (!args.dryRun && !args.yes && !process.stdin.isTTY) {
    console.error("非交互环境请在命令里加 --yes 才能写盘（或先 --dry-run 看看）。")
    return 1
  }

  if (args.dryRun) {
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`[dry-run] 目标文件：${file}`)
      for (const p of changes) console.log(`  ${p.action === "add" ? "+" : "~"} ${p.key}`)
    }
    return 0
  }

// atomicWrite 会先 copyFileSync 原文件做备份；目标文件不存在（手机第一次导入）时先建空壳
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "{}\n", "utf8")
  }
  result.backup = atomicWrite(file, merged)
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`已写入 ${file}`)
    for (const p of changes) console.log(`  ${p.action === "add" ? "+" : "~"} ${p.key}`)
    if (result.backup) console.log(`备份：${result.backup}`)
    console.log("完全退出 magpie 再打开（插件里的登录态是启动时读的），然后在账号列表里应该能看到这个号。")
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ?? err)
    process.exit(1)
  },
)