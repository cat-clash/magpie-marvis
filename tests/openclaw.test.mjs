// openclaw 传输层离线测试 —— 用 tests/mock_openclaw.py 模拟真实 openclaw 网关
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileSync, unlinkSync } from "node:fs"

import {
  flattenMessages,
  openclawChat,
  openclawResponse,
  openclawEnabled,
  openclawStatus,
} from "../src/marvis/openclaw.mjs"

// 宿主机可能带着 MARVIS_* 真实配置跑 magpie —— 测试必须与宿主环境隔离
process.env.MARVIS_WS_MODE = ""
process.env.MARVIS_DIRECT_TRANSPORT ??= "fetch"

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 18766

/** 依次尝试 OPENCLAW_TEST_PY → python3 → python，spawnSync -V 探测；都不可用返回 null */
function detectPython() {
  for (const cand of [process.env.OPENCLAW_TEST_PY, "python3", "python"]) {
    if (!cand) continue
    try {
      // python -V：版本号写 stdout（≥3.4）/ stderr（旧版），退出码 0 即可用
      const r = spawnSync(cand, ["-V"], { timeout: 15_000 })
      if (r.status === 0) return cand
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

const PY = detectPython()

test("flattenMessages 展平多轮消息", () => {
  const out = flattenMessages([
    { role: "system", content: "you are helpful" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ])
  assert.match(out, /system: you are helpful/)
  assert.match(out, /user: hello/)
})

test("openclawEnabled / openclawStatus 形状正确", () => {
  const s = openclawStatus()
  assert.ok(["relay", "remote", "off"].includes(s.mode))
  assert.equal(typeof s.url, "string")
  assert.ok(s.sessionKey)
  assert.equal(typeof openclawEnabled(), "boolean")
})

test("openclawResponse 非流式：OpenAI 兼容结构", async () => {
  const res = openclawResponse({ model: "main-auto" }, { text: "OK", model: "deepseek-v4-1-flash-261017" })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, "OK")
  assert.equal(j.model, "deepseek-v4-1-flash-261017")
})

test("openclawResponse 流式：两帧 + [DONE]", async () => {
  const res = openclawResponse({ stream: true, model: "main-auto" }, { text: "hi", model: "mock-model" })
  assert.match(res.headers.get("content-type"), /event-stream/)
  const text = await res.text()
  assert.match(text, /"role":"assistant","content":"hi"/)
  assert.match(text, /"finish_reason":"stop"/)
  assert.ok(text.trimEnd().endsWith("data: [DONE]"))
})

test("端到端：relay 走本地网关 AG-UI（gateway.connected → agent.run → ag_ui_event）", { timeout: 30_000 }, async (t) => {
  if (!PY) {
    t.skip("python 不可用，跳过 WS 端到端")
    return
  }
  const PORT_GW = 18767
  const child = spawn(PY, [join(HERE, "mock_gateway.py"), String(PORT_GW)], { stdio: "ignore" })
  t.after(() => child.kill())
  const prev = { ...process.env }
  process.env.MARVIS_WS_MODE = "relay"
  process.env.MARVIS_GW_URL = `ws://127.0.0.1:${PORT_GW}/`
  process.env.MARVIS_GATEWAY_TOKEN = "test-token"
  t.after(() => {
    for (const k of ["MARVIS_WS_MODE", "MARVIS_GW_URL", "MARVIS_GATEWAY_TOKEN"]) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
  await new Promise((r) => setTimeout(r, 1200))

  const { gatewayChat } = await import("../src/marvis/gateway.mjs")
  const result = await gatewayChat(
    { openid: "TESTOPENID", accessToken: "TESTTOKEN", guid: "test-guid" },
    { messages: [{ role: "user", content: "你好" }] },
  )
  assert.equal(result.text, "这是 mock 网关的回复")
  assert.equal(result.model, "mock-gateway-model")
})

test("端到端：remote openclaw（method:connect → chat.send）", { timeout: 30_000 }, async (t) => {
  if (!PY) {
    t.skip("python 不可用，跳过 WS 端到端")
    return
  }
  const child = spawn(PY, [join(HERE, "mock_openclaw.py"), String(PORT)], { stdio: "ignore" })
  t.after(() => child.kill())
  const prevMode = process.env.MARVIS_WS_MODE
  const prevUrl = process.env.MARVIS_WS_URL
  process.env.MARVIS_WS_MODE = "remote"
  process.env.MARVIS_WS_URL = `ws://127.0.0.1:${PORT}/`
  // remote 模式要求 handshake；用临时文件造一份
  const hs = join(HERE, ".tmp-handshake.log")
  writeFileSync(hs, "GET / HTTP/1.1\nHost: 127.0.0.1:18766\nsessionId: 11111111-2222-3333-4444-555555555555\ntoken: abc.def-ghi\n")
  process.env.MARVIS_HANDSHAKE = hs
  t.after(() => {
    if (prevMode === undefined) delete process.env.MARVIS_WS_MODE
    else process.env.MARVIS_WS_MODE = prevMode
    if (prevUrl === undefined) delete process.env.MARVIS_WS_URL
    else process.env.MARVIS_WS_URL = prevUrl
    delete process.env.MARVIS_HANDSHAKE
    try { unlinkSync(hs) } catch {}
  })
  await new Promise((r) => setTimeout(r, 1200))

  const result = await openclawChat(
    { openid: "TESTOPENID", accessToken: "TESTTOKEN", guid: "test-guid" },
    { model: "main-auto", messages: [{ role: "user", content: "你好" }] },
  )
  assert.equal(result.text, "这是 mock 网关的回复")
  assert.equal(result.model, "mock-model")
})
