import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { applyReasoningBudgetFloor } = await import(pathToFileURL(join(HERE, "..", "src", "hooks", "loader.mjs")).href)

test("effort=max + 小预算 → 抬到 64000", () => {
  const j = { reasoning_effort: "max", max_tokens: 16000 }
  assert.equal(applyReasoningBudgetFloor(j), true)
  assert.equal(j.max_tokens, 64_000)
})

test("effort=max + 没给预算 → 补 max_tokens=64000（不凭空加 max_completion_tokens）", () => {
  const j = { reasoning_effort: "max" }
  assert.equal(applyReasoningBudgetFloor(j), true)
  assert.equal(j.max_tokens, 64_000)
  assert.equal(j.max_completion_tokens, undefined)
})

test("effort=max + 已是 64000 → 不动", () => {
  const j = { reasoning_effort: "max", max_tokens: 64000 }
  assert.equal(applyReasoningBudgetFloor(j), false)
  assert.equal(j.max_tokens, 64000)
})

test("effort=high + 小预算 → 抬；没预算 → 不动（交给上游默认）", () => {
  const a = { reasoning_effort: "high", max_tokens: 8000 }
  assert.equal(applyReasoningBudgetFloor(a), true)
  assert.equal(a.max_tokens, 64_000)
  const b = { reasoning_effort: "high" }
  assert.equal(applyReasoningBudgetFloor(b), false)
  assert.equal(b.max_tokens, undefined)
})

test("effort=low/medium/缺省 → 一律不动", () => {
  for (const effort of ["low", "medium", ""]) {
    const j = { reasoning_effort: effort, max_tokens: 1000 }
    assert.equal(applyReasoningBudgetFloor(j), false, `effort=${effort}`)
    assert.equal(j.max_tokens, 1000)
  }
})

test("max_completion_tokens 同样被补偿", () => {
  const j = { reasoning_effort: "max", max_completion_tokens: 16000 }
  applyReasoningBudgetFloor(j)
  assert.equal(j.max_completion_tokens, 64_000)
  assert.equal(j.max_tokens, undefined)
})

test("MARVIS_MAX_TOKENS_FLOOR=0 可关", () => {
  process.env.MARVIS_MAX_TOKENS_FLOOR = "0"
  try {
    const j = { reasoning_effort: "max", max_tokens: 16000 }
    assert.equal(applyReasoningBudgetFloor(j), false)
    assert.equal(j.max_tokens, 16000)
  } finally {
    delete process.env.MARVIS_MAX_TOKENS_FLOOR
  }
})

test("0.9.7 接线：loader 的 body 归一化里调用了补偿", () => {
  const src = readFileSync(join(HERE, "..", "src", "hooks", "loader.mjs"), "utf8")
  assert.match(src, /if \(applyReasoningBudgetFloor\(json\)\) changed = true/, "body 归一化调用补偿函数")
})

test("0.9.7 用量接线：usage.mjs 优先网关且传原始窗口字段（不双重包装）", () => {
  const usage = readFileSync(join(HERE, "..", "src", "hooks", "usage.mjs"), "utf8")
  assert.match(usage, /MARVIS_USAGE_WS/, "MARVIS_USAGE_WS=0 可关")
  assert.match(usage, /const gw = await gatewayUsage\(\)/, "usageHook 优先调 gatewayUsage")
  const gatewayBlock = usage.slice(usage.indexOf("MARVIS_USAGE_WS"), usage.indexOf("let wallet"))
  assert.doesNotMatch(gatewayBlock, /usageWindow\(\{/, "网关分支传原始字段（quota.usage 内部统一包装），防 textOnly 被双重包装剥掉")
})
