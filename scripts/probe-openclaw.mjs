#!/usr/bin/env node
// 自检：openclaw 传输层是否就绪
import { openclawStatus } from "../src/marvis/openclaw.mjs"

const s = openclawStatus()
console.log("=== magpie-marvis-final · openclaw 状态 ===")
console.log(JSON.stringify(s, null, 2))
console.log()
if (s.overrideWarning) {
  console.log("⚠ 配置冲突：" + s.overrideWarning)
  console.log()
}
if (s.mode === "off") {
  console.log("WS 传输已关闭（MARVIS_WS_MODE=off），走原版 HTTP 网关（当前被 4100404 风控）。")
} else if (s.mode === "relay") {
  console.log("relay 模式：确认 Marvis PC 客户端已登录并打开（本地网关 10123 在监听）。")
  console.log("诊断端口：netstat -ano | findstr 10123")
} else {
  console.log("remote 模式：检查 handshake.log 是否为最近抓取（sessionId/token 会过期）。")
  if (s.handshake !== "ok") console.log("  ⚠ handshake:", s.handshake)
  if (s.frames !== "ok") console.log("  ⚠ frames:", s.frames)
}
