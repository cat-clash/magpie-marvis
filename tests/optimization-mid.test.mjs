// 中优先级优化 4–9 的回归测试（源码级断言，避免网络依赖）

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

test("优化4：首行自愈成功记忆存在且带 TTL", () => {
  const src = read("src/hooks/loader.mjs")
  assert.match(src, /const firstLineMemory = new Map\(\)/, "缓存 Map 存在")
  assert.match(src, /FIRST_LINE_MEMORY_TTL_MS/, "TTL 常量存在")
  assert.match(src, /rememberFirstLine\(acctBucket, systemFirstLine, firstLine\.text, firstLine\.mode\)/, "兜底句成功时记忆")
  assert.match(src, /rememberFirstLine\(acctBucket, systemFirstLine, cand, firstLine\.mode\)/, "候选句成功时记忆")
  assert.match(src, /forgetFirstLine\(acctBucket, systemFirstLine\)/, "被拦时失效记忆")
  assert.match(src, /rememberedFirstLine\(acctBucket, systemFirstLine, firstLine\.mode\)/, "命中记忆直接用")
})

test("优化5：reloadFingerprint 与 nativeMtimeMs 导出", () => {
  const src = read("src/marvis/fingerprint.mjs")
  assert.match(src, /export function reloadFingerprint\(\)/, "reload 导出")
  assert.match(src, /beaconTried = false/, "重置 beaconTried")
  assert.match(src, /clientScanDone = false/, "重置扫描标记")
  assert.match(src, /export function nativeMtimeMs\(\)/, "mtime 诊断导出")
})

test("优化6：qimei36 优先扫已知日志路径", () => {
  const src = read("src/marvis/fingerprint.mjs")
  assert.match(src, /function detectQimeiFromKnownLogs\(\)/, "快路径函数存在")
  assert.match(src, /qimei_debug_/, "匹配 qimei_debug 日志")
  assert.match(src, /const fast = detectQimeiFromKnownLogs\(\)/, "全盘递归前先走快路径")
})

test("优化7：出票超时可配 + qimei36 按账号缓存", () => {
  const src = read("src/marvis/fingerprint.mjs")
  assert.match(src, /MARVIS_USKEY_TIMEOUT_MS/, "超时环境变量")
  assert.match(src, /AbortSignal\.timeout\(timeoutMs\)/, "使用可配超时")
  assert.match(src, /const externalQimeiByAccount = new Map\(\)/, "按账号缓存")
  assert.doesNotMatch(src, /let externalQimei = ""/, "旧的进程级单例已移除")
})

test("优化8：riskEvents 最近20条随状态落盘", () => {
  const src = read("src/breaker.mjs")
  assert.match(src, /MAX_PERSIST_EVENTS = 20/, "落盘上限 20")
  assert.match(src, /entry\.events = events\.slice\(-MAX_PERSIST_EVENTS\)/, "persist 写入事件")
  assert.match(src, /Array\.isArray\(data\.events\)/, "loadState 恢复事件")
})

test("优化9：pacing axes 过期回收", () => {
  const src = read("src/pacing.mjs")
  assert.match(src, /AXES_SOFT_LIMIT/, "软阈值存在")
  assert.match(src, /AXES_TTL_MS/, "TTL 存在")
  assert.match(src, /function pruneAxes\(t\)/, "回收函数存在")
  assert.match(src, /pruneAxes\(t\)/, "pacingWait 调用回收")
})
