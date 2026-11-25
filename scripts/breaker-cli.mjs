#!/usr/bin/env node
// breaker —— 查看 / 解除按账号分桶的风控熔断（0.8.0）
//
//   node scripts/cli.mjs breaker                 # 列表（等价 breaker list）
//   node scripts/cli.mjs breaker list --json     # 机器可读
//   node scripts/cli.mjs breaker reset <账号>    # 解除某个账号的冷却（bucket 或 label 子串）
//   node scripts/cli.mjs breaker reset --all     # 解除全部
//
// 作用域由 MARVIS_RISK_SCOPE 决定（account 默认 / global 旧行为）；
// 状态文件默认 ~/.magpie-marvis-native/breaker-state.json（MARVIS_NATIVE_DIR 可改）。
//
// 退出码：0 = 正常；1 = 参数错误 / 没匹配到账号。

import { existsSync } from "node:fs"
import {
  breakerBuckets,
  breakerStatePath,
  getBreaker,
  resetAllBreakers,
  riskScope,
} from "../src/breaker.mjs"

const USAGE = [
  "用法：node scripts/cli.mjs breaker <list|reset> [参数]",
  "",
  "  list [--json]        列出所有账号桶（失败次数 / 冷却剩余 / 退避重开次数）",
  "  reset <账号>         解除某个账号的冷却：bucket 或 label（脱敏账号名）子串均可",
  "  reset --all          解除全部账号的冷却",
  "",
  "环境变量：",
  "  MARVIS_RISK_SCOPE=account|global   熔断作用域（默认 account = 一个号被拦只冷却这个号）",
  "  MARVIS_RISK_THRESHOLD=5            连续失败几次熔断",
  "  MARVIS_RISK_COOLDOWN_MS=1800000    冷却基准（0 = 禁用熔断）",
  "  MARVIS_RISK_CONSENSUS=2            多少个不同账号接连被拦 → 判定通道级封锁，全局也冷却",
  "  MARVIS_NATIVE_DIR=...              状态文件目录（默认 ~/.magpie-marvis-native）",
  "",
  "示例：",
  "  node scripts/cli.mjs breaker",
  "  node scripts/cli.mjs breaker reset QQ·1",
  "  node scripts/cli.mjs breaker reset --all",
].join("\n")

function humanRemain(ms) {
  const t = Math.max(0, Math.trunc(Number(ms) || 0))
  if (t <= 0) return "-"
  if (t < 60_000) return `${Math.ceil(t / 1000)}s`
  if (t < 3_600_000) return `${Math.ceil(t / 60_000)}m`
  return `${(t / 3_600_000).toFixed(1)}h`
}

function list(args) {
  const asJson = args.includes("--json")
  const rows = breakerBuckets().sort((a, b) => {
    if (a.bucket === "*") return -1
    if (b.bucket === "*") return 1
    return b.failures - a.failures
  })
  if (asJson) {
    console.log(JSON.stringify({ scope: riskScope(), state: breakerStatePath(), accounts: rows }, null, 2))
    return 0
  }
  console.log(`作用域：${riskScope()}${riskScope() === "global" ? "（旧行为：所有账号共用一个闸）" : "（一个账号一条冷却链，互不影响）"}`)
  console.log(`状态文件：${breakerStatePath()}${existsSync(breakerStatePath()) ? "" : "（尚未生成）"}`)
  if (!rows.length) {
    console.log("没有任何账号熔断记录 —— 当前没有被 4100404 拦住过的账号。")
    return 0
  }
  const head = `${"账号".padEnd(22)}${"失败".padEnd(6)}${"冷却剩余".padEnd(10)}${"重开"}`
  console.log("")
  console.log(head)
  console.log("-".repeat(46))
  for (const r of rows) {
    const name = r.bucket === "*" ? "全局（通道级）" : `${r.label}`
    const id = r.bucket === "*" ? "" : `  ${r.bucket}`
    console.log(`${name.padEnd(22)}${String(r.failures).padEnd(6)}${humanRemain(r.retryAfterMs).padEnd(10)}${r.consecutiveOpens}`)
    if (id) console.log(`${"".padEnd(22)}${id.trim()}`)
  }
  console.log("")
  console.log("解除：node scripts/cli.mjs breaker reset <账号>   或 --all")
  return 0
}

function reset(args) {
  const all = args.includes("--all")
  const selector = args.filter((a) => !a.startsWith("--")).join(" ").trim()

  if (!all && !selector) {
    process.stderr.write("✗ 需要指定账号（bucket 或 label 子串），或用 --all 解除全部。\n\n")
    process.stderr.write(`${USAGE}\n`)
    return 1
  }

  if (all) {
    const n = resetAllBreakers()
    console.log(`✓ 已解除全部 ${n} 个账号桶的冷却。`)
    return 0
  }

  const rows = breakerBuckets()
  const hit = rows.filter(
    (r) => r.bucket === selector || r.bucket.startsWith(selector) || r.label.includes(selector),
  )
  if (!hit.length) {
    process.stderr.write(`✗ 没找到匹配「${selector}」的账号桶。\n`)
    if (rows.length) {
      process.stderr.write("现有账号桶：\n")
      for (const r of rows) process.stderr.write(`  ${r.bucket}  ${r.label}\n`)
    } else {
      process.stderr.write("（当前没有任何熔断记录）\n")
    }
    return 1
  }
  for (const r of hit) {
    getBreaker(r.bucket, r.label).reset()
    console.log(`✓ 已解除「${r.bucket === "*" ? "全局（通道级）" : r.label}」(${r.bucket}) 的冷却。`)
  }
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}

const [action = "list", ...rest] = argv
let code = 1
if (action === "list") code = list(rest)
else if (action === "reset") code = reset(rest)
else {
  process.stderr.write(`✗ 不认识的 breaker 子命令：${action}\n\n${USAGE}\n`)
  code = 1
}
process.exit(code)