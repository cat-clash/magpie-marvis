#!/usr/bin/env node
// 测试环境自检：跑 node:test 之前先查「宿主环境会不会把测试带歪」。
//
// 本机实测踩过的坑（这个工具存在的理由）：
//   1. 宿主机带着真实 MARVIS_* 环境变量跑测试 → localgateway 用例看到
//      legacy="off" 全线假红（46 个基线假失败里 39 个是这类）；
//   2. Windows 编辑器 / PowerShell 给 UTF-8 写 BOM → JSON.parse 遇 U+FEFF 整份失败；
//   3. tests/openclaw.test.mjs spawn python3，Windows 上没有 python3 这个名字
//      → 2 个端到端假失败（设 OPENCLAW_TEST_PY 指向真 python 后通过）；
//   4. MARVIS_DIRECT_TRANSPORT 未设时代码默认 node:https 直连，而测试 mock
//      的是全局 fetch → 大量 mock 静默失效。
//
// 风格对齐 scripts/doctor.mjs：中文输出、逐项 ✓/✗/⚠ + 修复提示、总结 exit code。
// 零外部依赖、纯 ESM。核心逻辑在 checkEnv()，参数全部可注入，CLI 只是薄壳。

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ── 危险 / 信息分级 ────────────────────────────────────────────────────────
// 危险：有值就会改变测试结果（transport / gateway / 风控 / 本地资产 / 随机 key）
const DANGER_PATTERNS = [
  /^MARVIS_WS_MODE$/,
  /^MARVIS_NATIVE_DIR$/,
  /^MARVIS_TRANSPORT$/,
  /^MARVIS_DIRECT_TRANSPORT$/,
  /^MARVIS_GATEWAY_/,
  /^MARVIS_RISK_/,
  /^MARVIS_ALLOW_RANDOM_USKEY$/,
]
// 信息：只读展示类，泄漏了不影响测试判定
const INFO_PATTERN = /^MARVIS_QIMEI36$/
// 其余 MARVIS_* 一律按警告（不确定就亮黄灯，让测试者自己决定）

/** 单个 MARVIS_* 键分级：danger / info / warn */
export function classifyMarvisKey(key) {
  if (INFO_PATTERN.test(key)) return "info"
  if (DANGER_PATTERNS.some((re) => re.test(key))) return "danger"
  return "warn"
}

/**
 * python 探测（真实实现）：候选顺序 OPENCLAW_TEST_PY → python3 → python，
 * spawnSync 只读探测 --version，不装任何东西、不写任何文件。
 */
function realProbePython() {
  const candidates = []
  if (process.env.OPENCLAW_TEST_PY) candidates.push(process.env.OPENCLAW_TEST_PY)
  candidates.push("python3", "python")
  for (const name of candidates) {
    try {
      const r = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 10_000 })
      const text = String(r.stdout ?? "") + String(r.stderr ?? "")
      if (!r.error && /python/i.test(text)) {
        return { found: name, version: text.trim().split(/\r?\n/)[0] }
      }
    } catch { /* 下一个候选 */ }
  }
  return { found: null, version: "" }
}

/** 递归收集 BOM 扫描目标（排除 node_modules / .git / .dsh），只收 .mjs/.json/.md */
function collectTargetFiles(root, filter) {
  const SKIP = new Set(["node_modules", ".git", ".dsh"])
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory() && SKIP.has(e.name)) continue
      const p = join(dir, e.name)
      let st = null
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (!/\.(mjs|json|md)$/i.test(e.name)) continue
      if (filter && !filter(p)) continue
      out.push(p)
    }
  }
  walk(root)
  return out
}

/** 读文件头 3 字节判 UTF-8 BOM（EF BB BF / U+FEFF） */
function hasBom(path) {
  const buf = readFileSync(path)
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

/**
 * 核心自检（全部依赖可注入，便于测试）：
 *   env         —— 视作 process.env 的对象（默认真实环境）
 *   files       —— BOM 扫描文件清单 { path, isMarkdown }（默认扫仓库）
 *   probePython —— () => { found, version }（默认真实 spawnSync 探测）
 * 返回 { ok, exitCode, levels:{danger,warn,info}, findings:[...], python, json() }
 */
export function checkEnv({ env = process.env, files = null, probePython = realProbePython } = {}) {
  const findings = []

  const push = (level, section, label, detail, advice) => {
    findings.push({ level, section, label, detail, advice })
  }
  const ok = (section, label, detail) => push("ok", section, label, detail, "")

  // ── 1. MARVIS_* 环境泄漏 ────────────────────────────────────────────────
  const marvisKeys = Object.keys(env).filter((k) => /marvis/i.test(k)).sort()
  let dangerCount = 0
  for (const key of marvisKeys) {
    const level = classifyMarvisKey(key)
    const value = String(env[key] ?? "")
    // 只脱敏展示：key / token / qimei 一律打码，避免自检输出本身泄漏凭据
    const shown = /KEY|TOKEN|USKEY|QIMEI|SECRET/i.test(key) ? `${value.slice(0, 4)}***` : value
    if (level === "danger") {
      dangerCount++
      push("danger", "环境泄漏",
        `${key}=${shown}`,
        "宿主真实配置会泄漏进测试进程，改变代码分支判定 → 测试假红/假绿",
        "PowerShell：Remove-Item Env:" + key + " ; 或 bash：unset " + key +
        "（只对当前会话生效；CI / 长期方案：跑测试前清空 MARVIS_*）")
    } else if (level === "info") {
      push("info", "环境泄漏", `${key}=${shown}`, "只读展示类，不影响测试判定", "")
    } else {
      push("warn", "环境泄漏", `${key}=${shown}`, "不在危险清单，但会进入测试进程；若测试失败先怀疑它",
        "确认无影响后可加入白名单，或 Remove-Item Env:" + key + " / unset " + key)
    }
  }
  if (marvisKeys.length > 0 && dangerCount === 0 && !findings.some((f) => f.section === "环境泄漏" && f.level === "warn")) {
    ok("环境泄漏", `${marvisKeys.length} 个 MARVIS_* 变量`, "全部属于信息级，不影响测试判定")
  }
  if (marvisKeys.length === 0) ok("环境泄漏", "无 MARVIS_* 泄漏", "测试进程环境干净")

  // ── 2. transport 提示 ───────────────────────────────────────────────────
  const dt = String(env.MARVIS_DIRECT_TRANSPORT ?? "").toLowerCase()
  if (!dt) {
    push("warn", "transport",
      "MARVIS_DIRECT_TRANSPORT 未设置",
      "默认走 node:https 直连；跑「mock 全局 fetch」的测试套件时大量 mock 会静默失效",
      "PowerShell：$env:MARVIS_DIRECT_TRANSPORT=\"fetch\" ; 或 bash：export MARVIS_DIRECT_TRANSPORT=fetch")
  } else if (dt === "fetch") {
    ok("transport", `MARVIS_DIRECT_TRANSPORT=${dt}`, "与「mock 全局 fetch」的测试套件路径匹配")
  } else {
    push("warn", "transport", `MARVIS_DIRECT_TRANSPORT=${dt}`,
      "非 fetch：mock 全局 fetch 的测试不会生效（直连代码路径不经过全局 fetch）",
      "跑测试建议 MARVIS_DIRECT_TRANSPORT=fetch")
  }

  // ── 3. BOM 扫描 ─────────────────────────────────────────────────────────
  const bomHits = []
  for (const f of files ?? collectTargetFiles(ROOT).map((p) => ({ path: p, isMarkdown: /\.md$/i.test(p) }))) {
    let bom = false
    try { bom = hasBom(f.path) } catch { continue }
    if (bom) bomHits.push(f)
  }
  for (const f of bomHits) {
    const rel = relative(ROOT, f.path) || f.path
    if (f.isMarkdown) {
      push("warn", "BOM 扫描", `${rel} 带 UTF-8 BOM`, "文档类，暂不影响代码", "编辑器另存为「UTF-8 无 BOM」")
    } else {
      push("danger", "BOM 扫描", `${rel} 带 UTF-8 BOM`,
        "JSON.parse 遇 U+FEFF 整份失败；.mjs 带头三字节也可能被加载器挑剔",
        "PowerShell：[IO.File]::WriteAllText(\"" + rel + "\", (Get-Content \"" + rel + "\" -Raw), (New-Object System.Text.UTF8Encoding $false))" +
        " ；或编辑器另存为「UTF-8 无 BOM」")
      dangerCount++
    }
  }
  if (bomHits.length === 0) ok("BOM 扫描", "全部 .mjs/.json/.md 无 BOM", "")

  // ── 4. python 探测（tests/openclaw.test.mjs 端到端要 spawn python） ─────
  const py = probePython()
  if (py.found) {
    ok("python 探测", `可用：${py.found}`, py.version)
    if (py.found === "python3" && !env.OPENCLAW_TEST_PY) {
      push("info", "python 探测", "python3 可用且未设 OPENCLAW_TEST_PY", "Windows 上 python3 常缺失；本机能跑就保持现状", "")
    }
  } else {
    push("warn", "python 探测", "OPENCLAW_TEST_PY / python3 / python 都不可用",
      "tests/openclaw.test.mjs 的 WS 端到端用例会假失败（Windows 无 python3 这个名字）",
      "PowerShell：$env:OPENCLAW_TEST_PY=\"C:\\path\\to\\python.exe\" ; 或 bash：export OPENCLAW_TEST_PY=/usr/bin/python" +
      "；没有 python 时先跳过 WS 端到端用例")
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const levels = {
    danger: findings.filter((f) => f.level === "danger"),
    warn: findings.filter((f) => f.level === "warn"),
    info: findings.filter((f) => f.level === "info"),
    ok: findings.filter((f) => f.level === "ok"),
  }
  const exitCode = levels.danger.length > 0 ? 1 : 0
  return {
    ok: exitCode === 0,
    exitCode,
    levels,
    findings,
    python: py,
    /** --json 的结构化形状（供未来 CI 消费） */
    json() {
      return {
        ok: this.ok,
        exitCode: this.exitCode,
        danger: levels.danger.map((f) => ({ label: f.label, detail: f.detail, advice: f.advice })),
        warnings: levels.warn.map((f) => ({ label: f.label, detail: f.detail, advice: f.advice })),
        info: levels.info.map((f) => ({ label: f.label, detail: f.detail })),
        python: { found: py.found, version: py.version },
      }
    },
  }
}

// ── CLI 薄壳 ───────────────────────────────────────────────────────────────
const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
if (isCli || process.argv[1]?.endsWith("check-env.mjs")) {
  const jsonMode = process.argv.includes("--json")
  const result = checkEnv()

  if (jsonMode) {
    console.log(JSON.stringify(result.json(), null, 2))
  } else {
    console.log("=== magpie-marvis-final · 测试环境自检 ===")
    const sections = ["环境泄漏", "transport", "BOM 扫描", "python 探测"]
    const ICON = { ok: "✓", warn: "⚠", danger: "✗", info: "ℹ" }
    for (const sec of sections) {
      console.log()
      console.log(`[${sec}]`)
      for (const f of result.findings.filter((x) => x.section === sec)) {
        console.log(`${ICON[f.level]} ${f.label}${f.detail ? `：${f.detail}` : ""}`)
        if (f.advice) console.log(`  → 建议：${f.advice}`)
      }
    }
    console.log()
    console.log("=== 总结 ===")
    const d = result.levels.danger.length
    const w = result.levels.warn.length
    if (d > 0) {
      console.log(`✗ 危险 ${d} 项 / ⚠ 警告 ${w} 项 —— 先清危险项再跑测试，否则测试结果不可信`)
      for (const f of result.levels.danger) console.log(`  ✗ ${f.label} → ${f.advice}`)
    } else {
      console.log(`✓ 无危险项（⚠ 警告 ${w} 项，ℹ 信息 ${result.levels.info.length} 项）—— 可以跑测试`)
    }
    console.log(jsonMode ? "" : "（--json 可输出结构化结果，供 CI 使用）")
  }
  process.exitCode = result.exitCode
}
