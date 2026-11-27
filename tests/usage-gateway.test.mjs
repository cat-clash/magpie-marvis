import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { aggregateUsage } = await import(pathToFileURL(join(HERE, "..", "src", "marvis", "gateway.mjs")).href)

// 固定时间：2026-11-28 04:00 UTC = 北京 12:00。今天0点(北京) = 2026-11-27T16:00Z
const NOW = Date.parse("2026-11-28T04:00:00Z")
const TODAY_START = Date.parse("2026-11-27T16:00:00Z")

const conv = (id, iso) => ({ conversation_id: id, created_at: iso })
const row = (id, i, o) => ({ conversation_id: id, remote: { input_tokens: i, output_tokens: o }, local: { input_tokens: 0, output_tokens: 0 } })

test("今日/累计分档：昨天创建的会话只进累计，今天创建的进两档", () => {
  const list = [
    conv("a", "2026-11-27T10:00:00Z"), // 昨天（北京 18:00，今天0点前）
    conv("b", "2026-11-27T17:00:00Z"), // 北京 01:00 今天
    conv("c", "2026-11-28T03:00:00Z"), // 北京 11:00 今天
  ]
  const rows = [row("a", 100, 50), row("b", 200, 100), row("c", 10, 5)]
  const r = aggregateUsage(list, rows, NOW)
  assert.equal(r.today, 315) // b+c
  assert.equal(r.total, 465)
  assert.equal(r.todayConversations, 2)
  assert.equal(r.totalConversations, 3)
})

test("负数/缺失行被跳过；列表缺失时 created 无法判定 → 只进累计", () => {
  const rows = [row("x", -5, 0), row("y", 0, 0), row("z", 7, 3)]
  const r = aggregateUsage([], rows, NOW) // conversations 空 → byId 无命中 → created=NaN → 不进今日
  assert.equal(r.today, 0)
  assert.equal(r.total, 10)
  assert.equal(r.todayConversations, 0)
  assert.equal(r.totalConversations, 1)
})

test("空输入安全", () => {
  const r = aggregateUsage(null, undefined, NOW)
  assert.deepEqual(r, { today: 0, total: 0, todayConversations: 0, totalConversations: 0 })
})

test("0.9.7 源码接线：usage.mjs 优先网关用量、可关、回落钱包", () => {
  const usage = readFileSync(join(HERE, "..", "src", "hooks", "usage.mjs"), "utf8")
  assert.match(usage, /MARVIS_USAGE_WS/, "MARVIS_USAGE_WS=0 可关网关用量优先")
  assert.match(usage, /gatewayUsage\(\)/, "usageHook 调 gatewayUsage()")
  assert.match(usage, /今日消耗/, "主窗口文案含今日消耗")
  assert.match(usage, /let wallet/, "HTTP 钱包回落路径保留")
})

test("gatewayUsage 连接条件：没 token 且没显式 URL 时短路 null（不白连）", () => {
  const src = readFileSync(join(HERE, "..", "src", "marvis", "gateway.mjs"), "utf8")
  assert.match(src, /if \(!token && !process\.env\.MARVIS_GW_URL\) return null/)
})
