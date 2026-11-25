// 会话刷屏 bug 回归测试：
//   一次宿主请求（含所有 403 兜底/候选池/护栏重试）只复用一条 conv_*；
//   gatewayChatStream 接受 opts.conversationId，MARVIS_GATEWAY_CONVERSATION_ID 可 sticky。

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const ROOT = join(HERE, "..")
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

test("gatewayChatStream：接受 opts.conversationId 并用于 agent.run 帧", () => {
  const src = read("src/marvis/gateway.mjs")
  assert.match(src, /export async function\* gatewayChatStream\(creds, payload, \{ signal, conversationId \} = \{\}\)/, "函数签名接收 conversationId")
  assert.match(src, /const convId = sticky \|\| String\(conversationId \|\| ""\)/, "sticky > 调用方 > 新建 的优先级")
  assert.match(src, /conversation_id: conversationIdUsed/, "agent.run 帧使用校验后的会话 ID")
  assert.match(src, /const responseId = `resp_\$\{hex32\(\)\}`/, "responseId 仍每次新建")
})

test("gatewayChatStream：sticky 环境变量与格式校验存在", () => {
  const src = read("src/marvis/gateway.mjs")
  assert.match(src, /MARVIS_GATEWAY_CONVERSATION_ID/, "sticky 开关存在")
  assert.match(src, /\^conv_\[0-9a-f\]\{32\}\$/i, "会话 ID 格式校验存在")
})

test("gatewayChat 聚合 wrapper 把 opts 原样透传给 stream", () => {
  const src = read("src/marvis/gateway.mjs")
  assert.match(src, /for await \(const frame of gatewayChatStream\(creds, payload, opts\)\)/, "wrapper 透传 opts（含 conversationId）")
})

test("openclaw relay 分支把 conversationId 透传给 gatewayChatStream", () => {
  const src = read("src/marvis/openclaw.mjs")
  assert.match(src, /export async function\* openclawChatStream\(creds, payload, \{ signal, mode, conversationId \} = \{\}\)/, "stream 签名接收 conversationId")
  assert.match(src, /yield\* gatewayChatStream\(creds, payload, \{ signal, conversationId \}\)/, "relay 透传")
})

test("loader：一次请求只生成一次 relayConversationId，贯穿全部 4 个 agent.run 调用点", () => {
  const src = read("src/hooks/loader.mjs")
  assert.equal((src.match(/const relayConversationId = `conv_\$\{randomUUID\(\)\.replace/g) ?? []).length, 1, "只生成一次")
  const calls = [
    [/openclawChatStream\(creds, json, \{ signal: init\?\.signal, conversationId: relayConversationId \}\)/, "WS 主路径·流式"],
    [/openclawChat\(creds, json, \{ signal: init\?\.signal, conversationId: relayConversationId \}\)/, "WS 主路径·非流式"],
    [/const relayOpts = \{[^\n]*mode: "relay"[^\n]*conversationId: relayConversationId \}/, "4100404 回退 opts"],
    [/openclawChatStream\(creds, requestJson, relayOpts\)/, "回退·流式"],
    [/openclawChat\(creds, requestJson, relayOpts\)/, "回退·非流式"],
  ]
  for (const [re, name] of calls) assert.match(src, re, name + " 带 conversationId")
  assert.doesNotMatch(src, /openclawChatStream\(creds, (json|requestJson), \{ signal: init\?\.signal \}\)/, "没有漏传 conversationId 的调用")
})

test("loader：重试链复用同一 callUpstream → 同一 relayConversationId", () => {
  const src = read("src/hooks/loader.mjs")
  const retrySection = src.slice(src.indexOf("const pacedRetryUpstream"), src.indexOf("// 风控熔断中"))
  assert.equal((retrySection.match(/pacedRetryUpstream\(JSON\.stringify\(next\)\)/g) ?? []).length, 3, "三处重试都经同一节流包装")
  assert.doesNotMatch(retrySection, /await callUpstream\(JSON\.stringify\(next\)\)/, "没有绕过包装的直调")
})
