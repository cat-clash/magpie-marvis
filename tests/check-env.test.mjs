// tests/check-env.test.mjs —— 测试环境自检工具自身的测试
//
// 自检工具最讽刺的死法就是被宿主环境带歪：所以本文件用例内先把
// process.env 的 MARVIS_* 存后清再恢复（隔离宿主泄漏），核心逻辑全部
// 通过注入 { env, files, probePython } 驱动，不碰真实环境。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkEnv, classifyMarvisKey } from "../scripts/check-env.mjs"

// ── 宿主环境隔离：MARVIS_* 先存后清再恢复 ──────────────────────────────────
const SAVED = {}
for (const k of Object.keys(process.env)) {
  if (/marvis/i.test(k)) { SAVED[k] = process.env[k]; delete process.env[k] }
}
test("check-env 自身与宿主 MARVIS_* 隔离", () => {
  assert.deepEqual(Object.keys(process.env).filter((k) => /marvis/i.test(k)), [])
})
test.after(() => {
  for (const [k, v] of Object.entries(SAVED)) process.env[k] = v
})

// ── 分级函数 ───────────────────────────────────────────────────────────────
test("classifyMarvisKey：危险 / 信息 / 未知的warn 三档", () => {
  for (const k of ["MARVIS_WS_MODE", "MARVIS_NATIVE_DIR", "MARVIS_TRANSPORT",
    "MARVIS_DIRECT_TRANSPORT", "MARVIS_GATEWAY_URL", "MARVIS_GATEWAY_KEY",
    "MARVIS_RISK_COOLDOWN_MS", "MARVIS_ALLOW_RANDOM_USKEY"]) {
    assert.equal(classifyMarvisKey(k), "danger", `${k} 应为危险级`)
  }
  assert.equal(classifyMarvisKey("MARVIS_QIMEI36"), "info")
  assert.equal(classifyMarvisKey("MARVIS_SOMETHING_NEW"), "warn")
})

// ── 危险 env：判危险并给建议（PowerShell + bash 双写法） ────────────────────
test("注入危险 env：报 danger、给 unset 与 Remove-Item 两种建议、exitCode=1", () => {
  const r = checkEnv({ env: { MARVIS_WS_MODE: "off", MARVIS_RISK_COOLDOWN_MS: "7200000" } })
  assert.equal(r.exitCode, 1)
  const labels = r.levels.danger.map((f) => f.label).join("\n")
  assert.match(labels, /MARVIS_WS_MODE/)
  assert.match(labels, /MARVIS_RISK_COOLDOWN_MS/)
  for (const f of r.levels.danger) {
    assert.match(f.advice, /Remove-Item Env:/, "要给 PowerShell 写法")
    assert.match(f.advice, /unset /, "要给 bash 写法")
  }
})

// ── 干净 env：通过 ─────────────────────────────────────────────────────────
test("干净 env：无泄漏、无 danger、exitCode=0", () => {
  const r = checkEnv({ env: { PATH: "x" }, files: [], probePython: () => ({ found: "python", version: "Python 3.12.0" }) })
  assert.equal(r.exitCode, 0)
  assert.equal(r.levels.danger.length, 0)
  const leak = r.findings.find((f) => f.section === "环境泄漏")
  assert.match(leak.label, /无 MARVIS_\* 泄漏/)
})

// ── BOM 检测：临时文件（EF BB BF 三字节 + 正常文件对照） ────────────────────
test("BOM 检测：带 BOM 的 .json 判 danger，正常文件不误报", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-env-"))
  try {
    const withBom = join(dir, "bom.json")
    const clean = join(dir, "clean.json")
    writeFileSync(withBom, Buffer.from([0xef, 0xbb, 0xbf]) + Buffer.from(`{"a":1}\n`))
    writeFileSync(clean, `{"a":1}\n`)
    const r = checkEnv({ env: {}, files: [
      { path: withBom, isMarkdown: false },
      { path: clean, isMarkdown: false },
    ], probePython: () => ({ found: "python", version: "Python 3.12.0" }) })
    const bomDanger = r.levels.danger.find((f) => f.section === "BOM 扫描")
    assert.ok(bomDanger, ".json 带 BOM 要报危险")
    assert.match(bomDanger.label, /bom\.json/)
    assert.equal(r.levels.danger.filter((f) => f.section === "BOM 扫描" && f.label.includes("clean.json")).length, 0,
      "clean.json 不应误报")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("BOM 检测：.md 带 BOM 只警告不危险", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-env-"))
  try {
    const bomMd = join(dir, "readme.md")
    writeFileSync(bomMd, Buffer.from([0xef, 0xbb, 0xbf]) + Buffer.from("# hi\n"))
    const r = checkEnv({ env: {}, files: [{ path: bomMd, isMarkdown: true }],
      probePython: () => ({ found: null, version: "" }) })
    assert.equal(r.levels.danger.filter((f) => f.section === "BOM 扫描").length, 0, ".md 的 BOM 不算危险")
    assert.ok(r.levels.warn.some((f) => f.section === "BOM 扫描" && /readme\.md/.test(f.label)), ".md 的 BOM 要警告")
    assert.equal(r.exitCode, 0, "只有 .md BOM 时整体仍可放行")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── python 探测：注入假 spawn，测三档回退 ──────────────────────────────────
test("python 探测：OPENCLAW_TEST_PY → python3 → python 三档回退", () => {
  // 第一档：显式 OPENCLAW_TEST_PY 优先
  const p1 = checkEnv({ env: { OPENCLAW_TEST_PY: "py3-env" },
    files: [], probePython: () => ({ found: "py3-env", version: "Python 3.11" }) })
  assert.equal(p1.python.found, "py3-env")
  // 第三档：全不可用 → 警告 + 提示跳过 WS 端到端
  const p3 = checkEnv({ env: {}, files: [], probePython: () => ({ found: null, version: "" }) })
  assert.equal(p3.python.found, null)
  const w = p3.levels.warn.find((f) => f.section === "python 探测")
  assert.match(w.advice, /OPENCLAW_TEST_PY/)
  assert.match(w.advice, /跳过/, "要有「跳过 WS 端到端」的提示")
})

// ── transport 提示 ────────────────────────────────────────────────────────
test("transport：未设 → 建议设 fetch；设了 https → 警告 mock 失效；fetch → 通过", () => {
  const mk = (v) => checkEnv({ env: v ? { MARVIS_DIRECT_TRANSPORT: v } : {}, files: [],
    probePython: () => ({ found: "python", version: "Python 3.12.0" }) })
  const unset = mk(null)
  assert.ok(unset.levels.warn.some((f) => f.section === "transport" && f.advice.includes("fetch")))
  const https = mk("https")
  assert.ok(https.levels.warn.some((f) => f.section === "transport" && /mock/.test(f.detail)))
  assert.ok(https.levels.warn.find((f) => f.section === "transport").advice.includes("fetch"))
  const fetch = mk("fetch")
  assert.equal(fetch.levels.warn.filter((f) => f.section === "transport").length, 0)
})

// ── --json 结构化形状 ─────────────────────────────────────────────────────
test("json() 结构化形状：danger/warnings/info 均为数组且字段齐全", () => {
  const r = checkEnv({ env: { MARVIS_WS_MODE: "off", MARVIS_QIMEI36: "abc123" }, files: [],
    probePython: () => ({ found: "python", version: "Python 3.12.0" }) })
  const j = r.json()
  assert.equal(typeof j.ok, "boolean")
  assert.equal(j.ok, false)
  assert.equal(j.exitCode, 1)
  assert.ok(Array.isArray(j.danger) && j.danger.length === 1, "MARVIS_WS_MODE 应进 danger 数组")
  assert.deepEqual(Object.keys(j.danger[0]).sort(), ["advice", "detail", "label"])
  assert.ok(Array.isArray(j.warnings) && Array.isArray(j.info))
  assert.ok(j.info.some((x) => /MARVIS_QIMEI36/.test(x.label)), "QIMEI36 应进 info")
  assert.deepEqual(Object.keys(j.python).sort(), ["found", "version"])
  assert.equal(j.python.found, "python")
})
