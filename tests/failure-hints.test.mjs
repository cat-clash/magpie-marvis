// 连接故障 / 风控拦截诊断纯函数的离线测试（0.7.7）
// 跑法：MARVIS_TRANSPORT=direct node --test tests/failure-hints.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  connectionFailureHint,
  probeLocalRelay,
  shouldAutoWsFallback,
  enhanceRiskMessage,
} from "../src/marvis/failure-hints.mjs"

// ── 手机 503：openclaw / 10123 ─────────────────────────────────────────

test("手机 + openclaw/10123 失败：诊断直指 PC 端口 + diag.sh --fix 自愈", () => {
  const h = connectionFailureHint({
    mobile: true,
    errText: "openclaw WebSocket 错误：WebSocket connection to 'ws://127.0.0.1:10123/' failed",
  })
  assert.equal(h.header, "openclaw-10123-unreachable")
  assert.match(h.hint, /10123/)
  assert.match(h.hint, /手机上没有这个进程/)
  assert.match(h.hint, /8088/)
  assert.match(h.hint, /diag\.sh --fix/)
  assert.equal(h.command, "sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix")
})

test("手机 + 普通 ECONNREFUSED：通用诊断也指向 diag.sh --fix", () => {
  const h = connectionFailureHint({ mobile: true, errText: "connect ECONNREFUSED 127.0.0.1:8088" })
  assert.equal(h.header, "upstream-unreachable")
  assert.match(h.hint, /diag\.sh --fix/)
  assert.match(h.hint, /8088/)
})

test("桌面 + openclaw/10123 失败：提示确认 PC 客户端 + WS_MODE=off 出路", () => {
  const h = connectionFailureHint({ mobile: false, errText: "WebSocket connection to ws://127.0.0.1:10123/ failed" })
  assert.equal(h.header, "openclaw-10123-unreachable")
  assert.match(h.hint, /PC 客户端/)
  assert.match(h.hint, /MARVIS_WS_MODE=off/)
})

// ── relay 探针 ─────────────────────────────────────────────────────────

test("probeLocalRelay：真实 TCP server 可达时 true，关闭后 false", async () => {
  const srv = createServer((sock) => sock.end())
  await new Promise((resolve, reject) => {
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", resolve)
  })
  const port = srv.address().port
  const saved = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = `ws://127.0.0.1:${port}/`
    assert.equal(await probeLocalRelay({ timeoutMs: 500 }), true)
  } finally {
    await new Promise((r) => srv.close(r))
    if (saved === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved
  }
  // server 已关，再探一次应失败
  const s2 = createServer()
  const port2 = await new Promise((resolve) => s2.listen(0, "127.0.0.1", () => resolve(s2.address().port)))
  await new Promise((r) => s2.close(r))
  const saved2 = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = `ws://127.0.0.1:${port2}/`
    assert.equal(await probeLocalRelay({ timeoutMs: 300 }), false)
  } finally {
    if (saved2 === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved2
  }
})

test("probeLocalRelay：无人监听的端口 1s 内返回 false，不抛错", async () => {
  const saved = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = "ws://127.0.0.1:1/"
    const t0 = Date.now()
    assert.equal(await probeLocalRelay({ timeoutMs: 300 }), false)
    assert.ok(Date.now() - t0 < 3000, "探针必须快速失败")
  } finally {
    if (saved === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved
  }
})

// ── 自动 WS 回退决策 ───────────────────────────────────────────────────

test("shouldAutoWsFallback：仅桌面+非remote+未禁用+429 时 true（探针由调用方做）", () => {
  const base = { mobile: false, mode: "auto", autoDisabled: false, riskStatus: 429 }
  assert.equal(shouldAutoWsFallback(base), true)
  assert.equal(shouldAutoWsFallback({ ...base, mode: "relay" }), true)
  assert.equal(shouldAutoWsFallback({ ...base, mobile: true }), false, "手机没有 PC 客户端")
  assert.equal(shouldAutoWsFallback({ ...base, mode: "remote" }), false, "显式 remote 不覆盖")
  assert.equal(shouldAutoWsFallback({ ...base, autoDisabled: true }), false, "用户关掉就不重试")
  assert.equal(shouldAutoWsFallback({ ...base, riskStatus: 503 }), false, "改了状态码保持旧行为")
})

// ── 429 文案升级 ───────────────────────────────────────────────────────

test("enhanceRiskMessage：手机指向 8088 diag.sh", () => {
  const s = enhanceRiskMessage("原始", { mobile: true, probeReachable: false, autoTried: false, autoError: "" })
  assert.match(s, /8088/)
  assert.match(s, /diag\.sh --fix/)
  assert.match(s, /原始/)
})

test("enhanceRiskMessage：PC 探针可达给出 relay 出路", () => {
  const s = enhanceRiskMessage("原始", { mobile: false, probeReachable: true, autoTried: false, autoError: "" })
  assert.match(s, /10123/)
  assert.match(s, /MARVIS_WS_MODE=relay/)
  assert.match(s, /doctor/)
})

test("enhanceRiskMessage：自动重试失败给出具体原因 + remote 出路", () => {
  const s = enhanceRiskMessage("原始", {
    mobile: false, probeReachable: true, autoTried: true, autoError: "connection refused",
  })
  assert.match(s, /connection refused/)
  assert.match(s, /MARVIS_WS_MODE=remote/)
  assert.match(s, /自动尝试/)
})

test("enhanceRiskMessage：PC 探针不可达提示启动客户端", () => {
  const s = enhanceRiskMessage("原始", { mobile: false, probeReachable: false, autoTried: false, autoError: "" })
  assert.match(s, /不可达/)
  assert.match(s, /PC 客户端/)
  assert.match(s, /doctor/)
})
