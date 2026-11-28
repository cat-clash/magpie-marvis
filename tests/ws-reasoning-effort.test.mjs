import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { normalizeWsReasoningEffort } = await import(
  pathToFileURL(join(HERE, "..", "src", "hooks", "loader.mjs")).href
)

test("WS 通道：缺档位 → 补 low（思考不再混进正文）", () => {
  const j = { messages: [{ role: "user", content: "hi" }] }
  assert.equal(normalizeWsReasoningEffort(j), true)
  assert.equal(j.reasoning_effort, "low")
})

test("WS 通道：none / off / 空 → 补 low", () => {
  for (const eff of ["none", "off", "", "NONE"]) {
    const j = { reasoning_effort: eff }
    assert.equal(normalizeWsReasoningEffort(j), true, `effort=${eff}`)
    assert.equal(j.reasoning_effort, "low", `effort=${eff}`)
  }
})

test("WS 通道：合法档位 low/medium/high/max 一律不动", () => {
  for (const eff of ["low", "medium", "high", "max"]) {
    const j = { reasoning_effort: eff }
    assert.equal(normalizeWsReasoningEffort(j), false, `effort=${eff}`)
    assert.equal(j.reasoning_effort, eff)
  }
})

test("WS 通道：别名 xhigh/ultra → max，minimal/tiny → low", () => {
  for (const [inEff, outEff] of [["xhigh", "max"], ["ultra", "max"], ["minimal", "low"], ["tiny", "low"]]) {
    const j = { reasoning_effort: inEff }
    assert.equal(normalizeWsReasoningEffort(j), true, `effort=${inEff}`)
    assert.equal(j.reasoning_effort, outEff, `effort=${inEff}`)
  }
})

test("WS 通道：reasoning 字段兜底（客户端用 reasoning 而非 reasoning_effort）", () => {
  const j = { reasoning: "off" }
  assert.equal(normalizeWsReasoningEffort(j), true)
  assert.equal(j.reasoning_effort, "low")
})

test("WS 通道：空对象 / 非对象 → 不崩溃，返回 false", () => {
  assert.equal(normalizeWsReasoningEffort(null), false)
  assert.equal(normalizeWsReasoningEffort(undefined), false)
  assert.equal(normalizeWsReasoningEffort("x"), false)
})

test("WS 通道：MARVIS_REASONING_EFFORT_FLOOR 可覆盖默认档位", () => {
  const prev = process.env.MARVIS_REASONING_EFFORT_FLOOR
  try {
    process.env.MARVIS_REASONING_EFFORT_FLOOR = "medium"
    const j = {}
    assert.equal(normalizeWsReasoningEffort(j), true)
    assert.equal(j.reasoning_effort, "medium")
    process.env.MARVIS_REASONING_EFFORT_FLOOR = "garbage"
    const j2 = {}
    assert.equal(normalizeWsReasoningEffort(j2), true)
    assert.equal(j2.reasoning_effort, "low")
  } finally {
    if (prev === undefined) delete process.env.MARVIS_REASONING_EFFORT_FLOOR
    else process.env.MARVIS_REASONING_EFFORT_FLOOR = prev
  }
})
