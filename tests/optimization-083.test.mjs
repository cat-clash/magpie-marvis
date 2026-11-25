// 三个优化的回归测试：
//   ① cfg(modeOverride) 走单次请求参数，不碰全局 process.env.MARVIS_WS_MODE
//   ② 403 自愈链的重试全部走 pacedRetryUpstream（节奏闸覆盖）
//   ③ appVersion() 自动探测客户端版本，env 覆盖仍最高优先级

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { openclawMode } from "../src/marvis/openclaw.mjs"
import { appVersion, fingerprintStatus } from "../src/marvis/fingerprint.mjs"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const ROOT = join(HERE, "..")

test("openclawMode(modeOverride)：显式模式覆盖 env/文件，且不改 process.env", () => {
  const before = process.env.MARVIS_WS_MODE
  try {
    process.env.MARVIS_WS_MODE = "off"
    assert.equal(openclawMode("relay"), "relay", "单次请求覆盖成 relay")
    assert.equal(process.env.MARVIS_WS_MODE, "off", "全局 env 原封不动")
    assert.equal(openclawMode("remote"), "remote")
    assert.equal(process.env.MARVIS_WS_MODE, "off", "多次覆盖也不串味")
    assert.equal(openclawMode(""), "off", "空覆盖退回 env")
  } finally {
    if (before === undefined) delete process.env.MARVIS_WS_MODE
    else process.env.MARVIS_WS_MODE = before
  }
})

test("loader 自动 WS 回退：不再写 process.env.MARVIS_WS_MODE", () => {
  const src = readFileSync(join(ROOT, "src", "hooks", "loader.mjs"), "utf8")
  assert.match(src, /const relayOpts = \{[^\n]*mode: "relay"[^\n]*conversationId: relayConversationId \}/, "单次请求参数含会话复用")
  assert.doesNotMatch(src, /process\.env\.MARVIS_WS_MODE\s*=\s*"relay"/, "不再赋值全局 env")
  assert.doesNotMatch(src, /savedMode/, "旧的 env 保存/恢复逻辑已删掉")
})

test("403 自愈链：三处重试都走节奏闸，绕过 callUpstream 直调为零", () => {
  const src = readFileSync(join(ROOT, "src", "hooks", "loader.mjs"), "utf8")
  assert.match(src, /const pacedRetryUpstream = async \(payload\) => \{/, "节流包装存在")
  const retrySection = src.slice(src.indexOf("const pacedRetryUpstream"), src.indexOf("// 风控熔断中"))
  assert.equal((retrySection.match(/pacedRetryUpstream\(JSON\.stringify\(next\)\)/g) ?? []).length, 3,
    "兜底句 / 候选池 / 护栏三次重试全部节流")
  assert.doesNotMatch(retrySection, /await callUpstream\(JSON\.stringify\(next\)\)/, "没有直调绕过")
})

test("appVersion()：env 覆盖优先；无 env 时探测到本机真实版本", () => {
  const before = process.env.MARVIS_APP_VERSION
  try {
    process.env.MARVIS_APP_VERSION = "9.8.7.6"
    assert.equal(appVersion(), "9.8.7.6")
    assert.equal(fingerprintStatus().appVersionSource, "env")
  } finally {
    if (before === undefined) delete process.env.MARVIS_APP_VERSION
    else process.env.MARVIS_APP_VERSION = before
  }
  const v = appVersion()
  assert.match(v, /^\d+\.\d+\.\d+\.\d+$/, `探测值形如版本号（实际 ${v}）`)
  assert.notEqual(v, "1.60.3400.35", "不再是写死的旧版本（本机客户端已升级）")
})
