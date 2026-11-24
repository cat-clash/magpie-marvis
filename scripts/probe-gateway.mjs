#!/usr/bin/env node
// 自检：本地 OpenAI 兼容网关是否就绪（手机端默认通道）
// 输出只含状态字段，不含任何密钥明文；可达 exit 0，不可达 exit 1。
import { gatewayStatus } from "../src/marvis/localgateway.mjs"

const s = await gatewayStatus()
console.log("=== magpie-marvis-final · 本地网关状态 ===")
console.log(JSON.stringify(s, null, 2))
console.log()
if (s.reachable) {
  console.log(`网关可达：${s.url}/models（${s.models} 个模型）`)
  if (!s.keyConfigured) console.log("未设置 MARVIS_GATEWAY_KEY：网关若要求鉴权请补上。")
} else {
  console.log(`网关不可达：${s.url}`)
  if (s.error) console.log(`  原因：${s.error}`)
  console.log("  确认本地网关已启动（默认 http://127.0.0.1:8088/v1），或设置 MARVIS_GATEWAY_URL。")
}
process.exitCode = s.reachable ? 0 : 1
