#!/usr/bin/env node
// 一个 bin，两个子命令 —— 这样 `npx github:...#tag check .` 能直接跑。
//
//   npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 check .
//   npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 create --dir ... --provider ... --name ...
//
// npm 的 npx 在一个包有多个 bin 时无法判断该跑哪个；所以对外只暴露 `magpie-plugin`。
// 子命令仍然各自是独立脚本，直接 `node scripts/check.mjs` / `node scripts/create.mjs` 也行。

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const COMMANDS = {
  check: "check.mjs",
  create: "create.mjs",
  accounts: "accounts.mjs",
  "import-login": "import-login.mjs",
  breaker: "breaker-cli.mjs",
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? "")
    if (!a.startsWith("--")) continue
    const k = a.slice(2)
    const nxt = String(argv[i + 1] ?? "")
    if (!nxt || nxt.startsWith("--")) out[k] = true
    else {
      out[k] = nxt
      i += 1
    }
  }
  return out
}

async function doctorPhone(argv) {
  const args = parseArgs(argv)
  const port = Number.parseInt(String(args.port ?? process.env.MARVIS_GATEWAY_PORT ?? "8088"), 10) || 8088
  const url = String(process.env.MARVIS_GATEWAY_URL ?? `http://127.0.0.1:${port}/v1`)
  const nativeDir = String(process.env.MARVIS_NATIVE_DIR ?? join(homedir(), ".magpie-marvis-native"))
  const cfgPath = String(process.env.MARVIS_GATEWAY_CONFIG ?? join(nativeDir, "gateway.json"))
  const checks = []
  let ok = true

  try {
    const raw = readFileSync(cfgPath, "utf8")
    const cfg = JSON.parse(raw)
    const mode = String(cfg.mode ?? "").toLowerCase()
    const cfgUrl = String(cfg.url ?? "")
    if (mode !== "gateway") {
      ok = false
      checks.push({ name: "gateway.json.mode", status: "FAIL", value: mode || "<missing>", expect: "gateway" })
    } else {
      checks.push({ name: "gateway.json.mode", status: "OK", value: mode })
    }
    if (cfgUrl && !cfgUrl.includes(`127.0.0.1:${port}`)) {
      checks.push({ name: "gateway.json.url", status: "WARN", value: cfgUrl, expect: url })
    } else {
      checks.push({ name: "gateway.json.url", status: "OK", value: cfgUrl || url })
    }
  } catch (err) {
    ok = false
    checks.push({ name: "gateway.json", status: "MISSING", value: cfgPath, error: String(err?.message ?? err) })
  }

  // 0.9.8 瘦身：手机端 diag 脚本（magpie-marvis-diag.sh / phone-setup.sh）已删除

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1500) })
    const body = await res.text()
    if (res.status === 200) checks.push({ name: "GET /v1/models", status: "OK", value: `${res.status} ${body.slice(0, 80)}` })
    else {
      ok = false
      checks.push({ name: "GET /v1/models", status: "FAIL", value: `${res.status} ${body.slice(0, 120)}` })
    }
  } catch (err) {
    ok = false
    checks.push({ name: "GET /v1/models", status: "FAIL", value: url, error: String(err?.message ?? err) })
  }

  console.log("magpie-marvis phone doctor")
  console.log(`platform=${process.platform}${process.env.PREFIX ? ` prefix=${process.env.PREFIX}` : ""}${process.env.TERMUX_VERSION ? ` termux=${process.env.TERMUX_VERSION}` : ""}`)
  console.log(`config=${cfgPath}`)
  console.log(`gateway=${url}`)
  for (const c of checks) {
    console.log(`${String(c.status).padEnd(7)} ${c.name}: ${c.value ?? ""}${c.error ? ` (${c.error})` : ""}${c.expect ? ` [expect ${c.expect}]` : ""}`)
  }
  console.log(ok ? "VERDICT: gateway ready; run magpie provider test." : "VERDICT: fix FAIL items above; then re-run doctor.")
  process.exit(ok ? 0 : 1)
}

function usage(stream = process.stdout) {
  stream.write(
    [
      "用法：magpie-plugin <check|create|accounts|import-login|breaker|doctor:phone> [参数]",
      "",
      "  check  [目录]                 检查供应商插件，退出码 0 = 合规",
      "  create --dir <目录> --provider <id> --name <显示名>   从模板生成新插件",
      "  accounts list|logout|remove   取消登录 / 移除账号（写 plugin-auth.json，带备份）",
      "  import-login <文件.json>      把另一台机器导出的登录态合并进本机 magpie（手机走不通扫码时用）",
      "  breaker [list|reset]          查看 / 解除按账号分桶的风控熔断（0.8.0：一个号被拦不拖累其他号）",
      "  doctor:phone [--port 8088]    手机本地网关一键自检（配置、诊断脚本、/v1/models）",
      "",
      "示例：",
      "  npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 check .",
      '  npx --yes github:MYCF711/magpie-plugin-scaffold#v0.3.6 create --dir my-provider --provider huawei --name "华为云 HUAWEI"',
      "  node scripts/cli.mjs doctor:phone --port 8088",
      "  node scripts/cli.mjs import-login marvis-desktop-login.json --yes",
      "  node scripts/cli.mjs breaker list",
      "  node scripts/cli.mjs breaker reset --all",
      "",
    ].join("\n"),
  )
}

const [command, ...args] = process.argv.slice(2)
if (!command || command === "--help" || command === "-h") {
  usage()
  process.exit(0)
}

if (command === "doctor:phone") {
  await doctorPhone(args)
}

const script = COMMANDS[command]
if (!script) {
  process.stderr.write(`✗ 不认识的子命令：${command}\n\n`)
  usage(process.stderr)
  process.exit(1)
}

const result = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" })
if (result.error) {
  process.stderr.write(`✗ 启动 ${script} 失败：${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)