// openclaw 传输层离线测试 —— 用 tests/mock_gateway.py 模拟真实本地网关（0.9.8：remote 测试已删）
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  flattenMessages,
  openclawChat,
  openclawResponse,
  openclawEnabled,
  openclawStatus,
  wsModeOverride,
} from "../src/marvis/openclaw.mjs"

// 宿主机可能带着 MARVIS_* 真实配置跑 magpie —— 测试必须与宿主环境隔离
process.env.MARVIS_WS_MODE = ""
process.env.MARVIS_DIRECT_TRANSPORT ??= "fetch"

const HERE = dirname(fileURLToPath(import.meta.url))

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
  assert.ok(["relay", "auto", "off"].includes(s.mode))
  assert.equal(typeof s.url, "string")
  assert.equal(typeof openclawEnabled(), "boolean")
  // 0.8.2：配置来源诊断字段
  assert.equal(typeof s.fileMode, "string")
  assert.equal(typeof s.envMode, "string")
  assert.equal(typeof s.overrideWarning, "string")
  // 0.9.8：remote 删除后不再有 handshake/frames/sessionKey 字段
  assert.equal(s.handshake, undefined)
  assert.equal(s.frames, undefined)
  assert.equal(s.sessionKey, undefined)
})

test("wsModeOverride：env=off 覆盖 file=relay 给出可行动提示", () => {
  const w = wsModeOverride("off", "relay", "off")
  assert.match(w, /MARVIS_WS_MODE=off/)
  assert.match(w, /openclaw\.json/)
  assert.match(w, /relay/)
  assert.match(w, /4100404|429/)
  assert.match(w, /清掉|SetEnvironmentVariable/)
})

test("wsModeOverride：env=remote（已删除）给出视同 relay 提示", () => {
  const w = wsModeOverride("remote", "relay", "relay")
  assert.match(w, /remote/)
  assert.match(w, /0\.9\.8/)
})

test("wsModeOverride：一致或未设置时不告警", () => {
  assert.equal(wsModeOverride("relay", "relay", "relay"), "")
  assert.equal(wsModeOverride("", "relay", "relay"), "")
  assert.equal(wsModeOverride("off", "", "off"), "")
  assert.equal(wsModeOverride(undefined, "relay", "relay"), "")
})

test("wsModeOverride：其它不一致组合给出通用提示", () => {
  // 0.9.8：off→relay 与 remote→relay 有专属文案，通用分支用 relay→off 组合验证
  const w = wsModeOverride("relay", "off", "relay")
  assert.match(w, /覆盖/)
  assert.match(w, /实际生效/)
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

// 0.9.8 瘦身：remote（method:connect → chat.send 手机会话域）端到端测试已删除
// （传输层整体移除，mock_openclaw.py 保留但不再被引用）
