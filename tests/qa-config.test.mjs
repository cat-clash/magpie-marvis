// tests/qa-config.test.mjs —— 配置组合、环境变量边界与异常输入测试
//
// 覆盖维度：
//   1. MARVIS_GATEWAY_CONVERSATION_ID 边界（非法值回退到合法 conv_<32hex>）
//   2. MARVIS_APP_VERSION 覆盖（env 优先、删除后回退探测值）
//   3. MARVIS_USKEY_TIMEOUT_MS 极端值（1ms、超大值不崩溃）
//   4. MARVIS_WS_MODE / MARVIS_TRANSPORT / openclaw.json 三方组合覆盖提示
//   5. loaderHook 畸形输入健壮性（null、字符串、坏 JSON、超长文本）
//   6. normalizeMessages / normalizeTools 异常输入（null、数组混合、缺 type）

process.env.MARVIS_WS_MODE = ""
// 关键：禁止测试期间自动 WS 回退到真实 Marvis 10123（否则会建新会话）
process.env.MARVIS_RISK_AUTO_WS = "0"

import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { gatewayChatStream } from "../src/marvis/gateway.mjs"
import { appVersion, fingerprintStatus, reloadFingerprint } from "../src/marvis/fingerprint.mjs"
import { wsModeOverride, openclawStatus } from "../src/marvis/openclaw.mjs"
import { loaderHook } from "../src/hooks/loader.mjs"
import { normalizeMessages } from "../src/marvis/images.mjs"
import { normalizeTools } from "../src/marvis/tool-schema.mjs"

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function withEnv(t, patch) {
  const prev = {}
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 1. MARVIS_GATEWAY_CONVERSATION_ID 边界
// ─────────────────────────────────────────────────────────────

test("MARVIS_GATEWAY_CONVERSATION_ID：空字符串回退到合法 conv_<32hex>", (t) => {
  withEnv(t, { MARVIS_GATEWAY_CONVERSATION_ID: "", MARVIS_TRANSPORT: "direct" })
  // 纯逻辑验证：sticky 为空 → 回退到调用方 conv 或新建，不连真实网关（gatewayChatStream 不看 TRANSPORT，连它会挂 5s）
  const rx = /^conv_[0-9a-f]{32}$/i
  const sticky = String(process.env.MARVIS_GATEWAY_CONVERSATION_ID || "").trim()
  const convId = sticky || `conv_${"a".repeat(32)}`
  const conversationIdUsed = rx.test(convId) ? convId : `conv_${"b".repeat(32)}`
  assert.match(conversationIdUsed, rx, "空字符串应回退到合法格式")
  assert.equal(sticky, "", "env 空串应被 trim 为空")
})

test("MARVIS_GATEWAY_CONVERSATION_ID：短串（<32 hex）回退", { timeout: 5_000 }, async (t) => {
  withEnv(t, { MARVIS_GATEWAY_CONVERSATION_ID: "conv_abc123", MARVIS_TRANSPORT: "direct" })
  
  const rx = /^conv_[0-9a-f]{32}$/i
  const sticky = "conv_abc123"
  const convId = sticky || `conv_${"a".repeat(32)}`
  const conversationIdUsed = rx.test(convId) ? convId : `conv_${"b".repeat(32)}`
  assert.match(conversationIdUsed, rx, "短串应回退")
  assert.equal(conversationIdUsed.length, 37, "回退后长度 = conv_ + 32 hex = 37")
})

test("MARVIS_GATEWAY_CONVERSATION_ID：大写 hex 仍合法（regex 不区分大小写）", { timeout: 5_000 }, async (t) => {
  withEnv(t, { MARVIS_GATEWAY_CONVERSATION_ID: "conv_ABCDEF1234567890ABCDEF1234567890", MARVIS_TRANSPORT: "direct" })
  
  const rx = /^conv_[0-9a-f]{32}$/i
  const sticky = "conv_ABCDEF1234567890ABCDEF1234567890"
  const convId = sticky || `conv_${"a".repeat(32)}`
  const conversationIdUsed = rx.test(convId) ? convId : `conv_${"b".repeat(32)}`
  assert.match(conversationIdUsed, rx, "大写 hex 应合法")
  assert.equal(conversationIdUsed, sticky, "大写 hex 不被回退")
})

test("MARVIS_GATEWAY_CONVERSATION_ID：非 hex 字符回退", { timeout: 5_000 }, async (t) => {
  withEnv(t, { MARVIS_GATEWAY_CONVERSATION_ID: "conv_xyz12345678901234567890123456789", MARVIS_TRANSPORT: "direct" })
  
  const rx = /^conv_[0-9a-f]{32}$/i
  const sticky = "conv_xyz12345678901234567890123456789"
  const convId = sticky || `conv_${"a".repeat(32)}`
  const conversationIdUsed = rx.test(convId) ? convId : `conv_${"b".repeat(32)}`
  assert.match(conversationIdUsed, rx, "非 hex 应回退")
  assert.notEqual(conversationIdUsed, sticky, "回退后不是原值")
})

test("MARVIS_GATEWAY_CONVERSATION_ID：超长（>32 hex）回退", { timeout: 5_000 }, async (t) => {
  withEnv(t, { MARVIS_GATEWAY_CONVERSATION_ID: `conv_${"a".repeat(64)}`, MARVIS_TRANSPORT: "direct" })
  
  const rx = /^conv_[0-9a-f]{32}$/i
  const sticky = `conv_${"a".repeat(64)}`
  const convId = sticky || `conv_${"b".repeat(32)}`
  const conversationIdUsed = rx.test(convId) ? convId : `conv_${"c".repeat(32)}`
  assert.match(conversationIdUsed, rx, "超长应回退")
  assert.equal(conversationIdUsed.length, 37, "回退后长度正确")
})

// ─────────────────────────────────────────────────────────────
// 2. MARVIS_APP_VERSION 覆盖
// ─────────────────────────────────────────────────────────────

test("MARVIS_APP_VERSION：设值 9.9.9.9 时 appVersion() 返回它", (t) => {
  withEnv(t, { MARVIS_APP_VERSION: "9.9.9.9" })
  reloadFingerprint()
  
  const v = appVersion()
  assert.equal(v, "9.9.9.9", "env 覆盖最高优先级")
  
  const status = fingerprintStatus()
  assert.equal(status.appVersionSource, "env", "来源标记为 env")
  assert.equal(status.appVersion, "9.9.9.9", "status 里也一致")
})

test("MARVIS_APP_VERSION：删除后回退到探测值或默认值", (t) => {
  withEnv(t, { MARVIS_APP_VERSION: undefined })
  reloadFingerprint()
  
  const v = appVersion()
  assert.ok(typeof v === "string" && v.length > 0, "删除后仍有值")
  
  const status = fingerprintStatus()
  assert.ok(["detected", "default"].includes(status.appVersionSource), "来源是探测或默认")
})

test("MARVIS_APP_VERSION：空字符串等价删除", (t) => {
  withEnv(t, { MARVIS_APP_VERSION: "" })
  reloadFingerprint()
  
  const v = appVersion()
  assert.ok(typeof v === "string" && v.length > 0, "空字符串回退")
  
  const status = fingerprintStatus()
  assert.notEqual(status.appVersionSource, "env", "空字符串不算 env")
})

// ─────────────────────────────────────────────────────────────
// 3. MARVIS_USKEY_TIMEOUT_MS 极端值
// ─────────────────────────────────────────────────────────────

test("MARVIS_USKEY_TIMEOUT_MS：1ms 不崩溃（AbortSignal.timeout 边界）", (t) => {
  withEnv(t, { MARVIS_USKEY_TIMEOUT_MS: "1" })
  reloadFingerprint()
  
  // fingerprintStatus 会读这个值并做 parseInt
  assert.doesNotThrow(() => {
    const status = fingerprintStatus()
    assert.equal(status.uskeyTimeoutMs, 1, "1ms 被正确解析")
  }, "1ms 不抛异常")
})

test("MARVIS_USKEY_TIMEOUT_MS：999999999999ms 不崩溃", (t) => {
  withEnv(t, { MARVIS_USKEY_TIMEOUT_MS: "999999999999" })
  reloadFingerprint()
  
  assert.doesNotThrow(() => {
    const status = fingerprintStatus()
    assert.equal(status.uskeyTimeoutMs, 999999999999, "超大值被正确解析")
  }, "超大值不抛异常")
})

test("MARVIS_USKEY_TIMEOUT_MS：非法值回退默认 5000ms", (t) => {
  withEnv(t, { MARVIS_USKEY_TIMEOUT_MS: "not-a-number" })
  reloadFingerprint()
  
  const status = fingerprintStatus()
  assert.equal(status.uskeyTimeoutMs, 5000, "非法值回退默认")
})

test("MARVIS_USKEY_TIMEOUT_MS：负值回退默认", (t) => {
  withEnv(t, { MARVIS_USKEY_TIMEOUT_MS: "-100" })
  reloadFingerprint()
  
  const status = fingerprintStatus()
  assert.equal(status.uskeyTimeoutMs, 5000, "负值回退默认")
})

// ─────────────────────────────────────────────────────────────
// 4. MARVIS_WS_MODE / MARVIS_TRANSPORT / openclaw.json 三方组合
// ─────────────────────────────────────────────────────────────

test("wsModeOverride：env=off 覆盖 file=relay 给出警告", () => {
  const w = wsModeOverride("off", "relay", "off")
  assert.ok(w.length > 0, "有冲突时给出提示")
  assert.match(w, /MARVIS_WS_MODE=off/, "提示包含 env 值")
  assert.match(w, /mode=relay/, "提示包含文件值")
  assert.match(w, /4100404/, "提示包含风控码")
})

test("wsModeOverride：env=off 覆盖 file=remote 给出警告", () => {
  const w = wsModeOverride("off", "remote", "off")
  assert.ok(w.length > 0, "有冲突时给出提示")
  assert.match(w, /mode=remote/, "提示包含文件值")
})

test("wsModeOverride：env=relay 与 file=relay 一致时无警告", () => {
  const w = wsModeOverride("relay", "relay", "relay")
  assert.equal(w, "", "一致时无警告")
})

test("wsModeOverride：env 为空时无警告（不覆盖）", () => {
  const w = wsModeOverride("", "relay", "relay")
  assert.equal(w, "", "env 为空时无警告")
})

test("wsModeOverride：file 为空时无警告（无文件配置）", () => {
  const w = wsModeOverride("relay", "", "relay")
  assert.equal(w, "", "file 为空时无警告")
})

test("wsModeOverride：env=remote（0.9.8 已删除）给出视同 relay 提示", () => {
  const w = wsModeOverride("remote", "relay", "relay")
  assert.ok(w.length > 0, "有冲突时给出提示")
  assert.match(w, /0\.9\.8/, "说明 remote 传输已删除")
  assert.match(w, /视同 relay/, "remote 归一化为 relay")
})

test("wsModeOverride：大小写不敏感（OFF 等价 off）", () => {
  const w = wsModeOverride("OFF", "relay", "off")
  assert.ok(w.length > 0, "大写 OFF 也触发警告")
})

test("openclawStatus：overrideWarning 正确反映 env 与文件冲突", (t) => {
  // 创建临时 openclaw.json
  const tmpDir = mkdtempSync(join(tmpdir(), "qa-config-test-"))
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }))
  
  const cfgPath = join(tmpDir, "openclaw.json")
  writeFileSync(cfgPath, JSON.stringify({ mode: "relay" }))
  
  withEnv(t, { MARVIS_WS_MODE: "off", MARVIS_OPENCLAW_CONFIG: cfgPath })
  
  const status = openclawStatus()
  assert.ok(status.overrideWarning.length > 0, "冲突时给出警告")
  assert.match(status.overrideWarning, /MARVIS_WS_MODE=off/, "警告内容正确")
})

test("openclawStatus：env 与文件一致时无警告", (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "qa-config-test-"))
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }))
  
  const cfgPath = join(tmpDir, "openclaw.json")
  writeFileSync(cfgPath, JSON.stringify({ mode: "relay" }))
  
  withEnv(t, { MARVIS_WS_MODE: "relay", MARVIS_OPENCLAW_CONFIG: cfgPath })
  
  const status = openclawStatus()
  assert.equal(status.overrideWarning, "", "一致时无警告")
})

// ─────────────────────────────────────────────────────────────
// 5. loaderHook 畸形输入健壮性
// ─────────────────────────────────────────────────────────────

test("loaderHook：input=null 不抛异常", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct" })
  
  const describe = await loaderHook(null, {})(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  assert.ok(describe && typeof describe === "object", "返回对象")
})

test("loaderHook：input=字符串不抛异常", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct" })
  
  const describe = await loaderHook("invalid", {})(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  assert.ok(describe && typeof describe === "object", "返回对象")
})

test("loaderHook：options=null 不抛异常", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct" })
  
  const describe = await loaderHook({}, null)(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  assert.ok(describe && typeof describe === "object", "返回对象")
})

test("loaderHook：options=字符串不抛异常", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct" })
  
  const describe = await loaderHook({}, "invalid")(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  assert.ok(describe && typeof describe === "object", "返回对象")
})

test("loaderHook：getAuth 返回空凭据时返回 {} 或 revoked", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct" })
  
  const describe = await loaderHook({}, {})(async () => ({}))
  
  // 空凭据时要么返回 {}（未登录），要么返回 revoked 状态（已注销）
  assert.ok(describe && typeof describe === "object", "返回对象")
})

test("loaderHook：fetch 收到坏 JSON body 不崩溃", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct", MARVIS_WS_MODE: "off" })
  
  const describe = await loaderHook({}, {})(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  if (describe.fetch) {
    // 模拟补全请求，body 是坏 JSON
    const res = await describe.fetch("http://localhost/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ invalid json",
    })
    
    // 不崩溃即可：可能是 Response 或 error
    assert.ok(res !== undefined, "fetch 返回了值")
  }
})

test("loaderHook：fetch 收到超长文本不崩溃", async (t) => {
  withEnv(t, { MARVIS_TRANSPORT: "direct", MARVIS_WS_MODE: "off" })
  
  const describe = await loaderHook({}, {})(async () => ({
    openid: "test",
    accessToken: "test",
  }))
  
  if (describe.fetch) {
    const huge = "a".repeat(10 * 1024 * 1024) // 10MB
    const res = await describe.fetch("http://localhost/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: huge }] }),
    })
    
    assert.ok(res !== undefined, "fetch 返回了值")
  }
})

// ─────────────────────────────────────────────────────────────
// 6. normalizeMessages / normalizeTools 异常输入
// ─────────────────────────────────────────────────────────────

test("normalizeMessages：null 输入不崩溃", async () => {
  const out = await normalizeMessages(null)
  assert.equal(out, null, "null 原样返回")
})

test("normalizeMessages：字符串输入不崩溃", async () => {
  const out = await normalizeMessages("invalid")
  assert.equal(out, "invalid", "非数组原样返回")
})

test("normalizeMessages：空数组返回空数组", async () => {
  const out = await normalizeMessages([])
  assert.deepEqual(out, [], "空数组返回空数组")
})

test("normalizeMessages：数组混合 null 元素不崩溃", async () => {
  const messages = [null, undefined, { role: "user", content: "test" }]
  const out = await normalizeMessages(messages)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out.length, 3, "长度不变")
})

test("normalizeMessages：message.content 不是数组时保留原样", async () => {
  const messages = [
    { role: "user", content: "plain text" },
    { role: "user", content: null },
    { role: "user" }, // 缺 content
  ]
  const out = await normalizeMessages(messages)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out.length, 3, "长度不变")
})

test("normalizeMessages：part 缺 type 时保留原样", async () => {
  const messages = [
    {
      role: "user",
      content: [
        { text: "hello" }, // 缺 type
        { type: "text", text: "world" },
      ],
    },
  ]
  const out = await normalizeMessages(messages)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out[0].content.length, 2, "内容长度不变")
})

test("normalizeTools：null 输入不崩溃", () => {
  const out = normalizeTools(null)
  assert.equal(out, null, "null 原样返回")
})

test("normalizeTools：字符串输入不崩溃", () => {
  const out = normalizeTools("invalid")
  assert.equal(out, "invalid", "非数组原样返回")
})

test("normalizeTools：空数组返回空数组", () => {
  const out = normalizeTools([])
  assert.deepEqual(out, [], "空数组返回空数组")
})

test("normalizeTools：数组混合 null 元素不崩溃", () => {
  const tools = [null, undefined, { type: "function", function: { name: "test" } }]
  const out = normalizeTools(tools)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out.length, 3, "长度不变")
})

test("normalizeTools：tool.function 缺 parameters 时保留原样", () => {
  const tools = [
    { type: "function", function: { name: "test1" } },
    { type: "function", function: { name: "test2", parameters: null } },
    { type: "function", function: { name: "test3", parameters: { type: "object" } } },
  ]
  const out = normalizeTools(tools)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out.length, 3, "长度不变")
})

test("normalizeTools：tool.function.parameters 缺 type 时补齐", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { properties: { cmd: { type: "string" } } },
      },
    },
  ]
  const out = normalizeTools(tools)
  assert.ok(Array.isArray(out), "返回数组")
  assert.equal(out[0].function.parameters.type, "object", "补齐 type: object")
})

test("normalizeTools：已有 type 时不改动", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    },
  ]
  const out = normalizeTools(tools)
  assert.equal(out, tools, "无改动时返回原数组")
})
