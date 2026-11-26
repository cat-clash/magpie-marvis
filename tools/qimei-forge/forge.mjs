#!/usr/bin/env node
// forge.mjs —— qimei36 铸号 CLI（frida 驱动）
//
// 用法：
//   node tools/qimei-forge/forge.mjs --pid 12345                 # attach 到进程，每次 getqimei 都换随机号
//   node tools/qimei-forge/forge.mjs --pid 12345 --value <36hex> # 固定值
//   node tools/qimei-forge/forge.mjs --spawn "node app.js"       # 启动并注入
//   node tools/qimei-forge/forge.mjs --list                      # 列出含 qimei.dll 的进程
//
// 依赖：frida（npm i -g frida / pip install frida）
// 原理：hook qimei.dll!b 的输出缓冲区，写入自定义 36 位 hex（详见 README.md）

import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync, spawn as spawnChild } from "node:child_process"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, "forge.js")

function usage() {
  console.log(`qimei36 铸号工具

用法:
  --list                      列出可能加载 qimei.dll 的进程
  --pid <PID>                 附加到指定进程
  --name <NAME>               按进程名附加（如 Marvis.exe）
  --spawn "<cmd> [args...]"   启动新进程并注入
  --value <36hex>             固定铸号值（默认每次随机）
  --once                      只改一次（默认持续改）
  --dry                       只观察，不改写
  --help                      显示帮助

示例:
  node forge.mjs --list
  node forge.mjs --name Marvis.exe
  node forge.mjs --pid 1234 --value a1b2c3d4e5f60718293a4b5c6d7e8f90abcd

说明:
  目标进程必须已加载 qimei.dll。工具 hook 其 b 导出（getqimei），
  在结果写入输出缓冲区后替换为指定/随机 36 位 hex。
`)
}

function parseArgs(argv) {
  const out = { mode: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--list": out.mode = "list"; break
      case "--pid": out.mode = "pid"; out.pid = Number(argv[++i]); break
      case "--name": out.mode = "name"; out.name = argv[++i]; break
      case "--spawn": out.mode = "spawn"; out.cmd = argv[++i]; break
      case "--value": out.value = argv[++i]; break
      case "--once": out.once = true; break
      case "--dry": out.dry = true; break
      case "--help": case "-h": out.mode = "help"; break
      default: if (!a.startsWith("-")) { /* ignore */ } else { console.error("未知参数:", a); out.mode = "help" }
    }
  }
  return out
}

async function loadFrida() {
  try {
    const mod = await import("frida")
    return mod.default ?? mod
  } catch {
    try {
      // 允许通过 FRIDA_PYTHON 指定 python 版 frida 的桥（不常用）
      throw new Error("missing")
    } catch {
      console.error(`未找到 frida 模块。

安装方式（任选其一）:
  npm i -g frida            # Node 版
  pip install frida         # Python 版（用 tools/qimei-forge/forge.py）

安装后重试。`)
      process.exit(1)
    }
  }
}

function listProcesses() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: "utf8", windowsHide: true })
    const rows = out.split(/\r?\n/).filter(Boolean).map(l => {
      const m = l.match(/^"([^"]+)","(\d+)"/)
      return m ? { name: m[1], pid: Number(m[2]) } : null
    }).filter(Boolean)
    const interesting = rows.filter(r => /marvis|node|electron|python/i.test(r.name))
    console.log("候选进程（可能加载 qimei.dll）:")
    for (const r of interesting) console.log(`  ${String(r.pid).padStart(7)}  ${r.name}`)
    console.log(`\n共 ${interesting.length} 个。用 --pid <PID> 附加。`)
  } catch (e) {
    console.error("列出进程失败:", e.message)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mode || args.mode === "help") { usage(); return }
  if (args.mode === "list") { listProcesses(); return }

  if (args.value && !/^[0-9a-fA-F]{36}$/.test(args.value)) {
    console.error("--value 必须是 36 位十六进制（qimei36 格式）")
    process.exit(2)
  }
  if (!existsSync(SCRIPT_PATH)) {
    console.error("缺少 forge.js:", SCRIPT_PATH)
    process.exit(2)
  }

  const frida = await loadFrida()
  const src = readFileSync(SCRIPT_PATH, "utf8")

  let targetPid
  let child = null
  if (args.mode === "spawn") {
    // 拆命令（简单空格分割；复杂命令请用 shell）
    const parts = args.cmd.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, "")) ?? []
    if (!parts.length) { console.error("--spawn 需要命令"); process.exit(2) }
    targetPid = await frida.spawn(parts)
    console.log(`已启动 pid=${targetPid}: ${parts.join(" ")}`)
  } else if (args.mode === "pid") {
    targetPid = args.pid
  } else if (args.mode === "name") {
    const procs = await frida.enumerateProcesses()
    const hit = procs.find(p => p.name.toLowerCase() === String(args.name).toLowerCase())
    if (!hit) {
      console.error(`未找到进程: ${args.name}`)
      console.log("现有进程:", procs.filter(p => /marvis|node/i.test(p.name)).map(p => `${p.pid}:${p.name}`).join(", "))
      process.exit(3)
    }
    targetPid = hit.pid
  }
  if (!targetPid) { console.error("需要 --pid / --name / --spawn 之一"); process.exit(2) }

  console.log(`附加到 pid=${targetPid} ...`)
  const session = await frida.attach(targetPid)
  const script = await session.createScript(src, { name: "qimei-forge" })

  let done = false
  script.message.connect((msg) => {
    if (msg.type === "send") {
      console.log(msg.payload)
    } else if (msg.type === "error") {
      console.error("[js error]", msg.description)
    }
  })

  await script.load()
  if (args.value) await script.exports.setValue(args.value)
  if (args.dry) await script.exports.setEnabled(false)
  console.log(`已注入。value=${args.value || "(每次随机)"} dry=${!!args.dry}`)

  if (args.mode === "spawn") await frida.resume(targetPid)

  // 定期打印统计
  const timer = setInterval(async () => {
    try {
      const s = await script.exports.stats()
      if (s.calls) console.log(`[stats] calls=${s.calls} forced=${s.forced} last="${s.lastValue}" (orig "${s.lastOrig}")`)
      if (args.once && s.forced > 0) {
        clearInterval(timer)
        console.log("--once 已生效，退出。")
        process.exit(0)
      }
    } catch { /* script 可能已卸载 */ }
  }, 3000)

  const stop = async () => {
    clearInterval(timer)
    try { await script.unload() } catch {}
    try { await session.detach() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

main().catch(e => { console.error("失败:", e?.message ?? e); process.exit(1) })
