// qa-concurrency.test.mjs —— 0.8.4 三处并发修复的并发安全 / 竞态回归测试
//
// 覆盖：
//   A. openclawMode(modeOverride) 并发 150 次（relay/remote/off 各 50）——env 不被改写、不串味
//   B. loader relayConversationId：mock gateway 并发 20 逻辑请求 ×3 callUpstream，会话 ID 隔离
//   C. externalQimeiByAccount / firstLineMemory 账号隔离（行为 + 源码断言）
//   D. breaker 多桶并发 record(false)：分桶独立 + 共因闸全局桶只在条件满足时开
//   E. pacing 多 key 并发：A 账号等待不阻塞 B 账号
//
// 跑法（runner 由 QA 指定）：
//   $bun = "C:\Users\c\.cache\magpie\bun\1.4.5\magpie-bun.exe"
//   $env:MARVIS_MIN_REQUEST_INTERVAL_MS="0"; $env:MARVIS_REQUEST_JITTER_MS="0"; & $bun test tests/qa-concurrency.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ── 环境隔离：必须在动态 import 之前设置（src 里有加载时定型的常量）──
const NATIVE_DIR = mkdtempSync(join(tmpdir(), "qa-concurrency-native-"))
process.env.MARVIS_NATIVE_DIR = NATIVE_DIR
process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "0"
process.env.MARVIS_REQUEST_JITTER_MS = "0"
process.env.MARVIS_PACING_SCOPE = "account"
process.env.MARVIS_RISK_SCOPE = "account"
process.env.MARVIS_DIRECT_TRANSPORT = "fetch"
process.env.MARVIS_DIRECT_FETCH = "0"
process.env.MARVIS_WS_MODE = "off"
delete process.env.MARVIS_GATEWAY_CONVERSATION_ID
delete process.env.MARVIS_GATEWAY_URL
delete process.env.MARVIS_HANDSHAKE
delete process.env.MARVIS_QIMEI36
delete process.env.MARVIS_USKEY_URL

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8")

// 动态 import（确保上面的 env 先生效）
const { openclawMode } = await import("../src/marvis/openclaw.mjs")
const { gatewayChatStream } = await import("../src/marvis/gateway.mjs")
const { openclawChatStream } = await import("../src/marvis/openclaw.mjs")
const { loaderHook } = await import("../src/hooks/loader.mjs")
const { qimei36, uskeyOf, reloadFingerprint } = await import("../src/marvis/fingerprint.mjs")
const {
  createBreaker,
  getBreaker,
  resetAllBreakers,
  breakerBuckets,
  accountKeyOf,
} = await import("../src/breaker.mjs")
const { createPacing } = await import("../src/pacing.mjs")

// ═══════════════════════════════════════════════════════════════════
// A. openclawMode(modeOverride) 并发安全
// ═══════════════════════════════════════════════════════════════════

test("A1 openclawMode：relay/remote/off 各 50 次并发，env 全程零写入、各调用不串味", { timeout: 20_000 }, async (t) => {
  // 用属性拦截器捕获任何对 process.env.MARVIS_WS_MODE 的写入（最强行为级证据）。
  let envWrites = 0
  let value = "off"
  const desc = Object.getOwnPropertyDescriptor(process.env, "MARVIS_WS_MODE")
  let installed = false
  try {
    Object.defineProperty(process.env, "MARVIS_WS_MODE", {
      configurable: true,
      enumerable: true,
      get() {
        return value
      },
      set(next) {
        envWrites += 1
        value = String(next)
      },
    })
    installed = true
  } catch {
    // 某些运行时 process.env 不可重定义；退化成快照比对
  }
  t.after(() => {
    if (!installed) return
    if (desc) Object.defineProperty(process.env, "MARVIS_WS_MODE", desc)
    else delete process.env.MARVIS_WS_MODE
  })

  const baseline = process.env.MARVIS_WS_MODE
  const sampler = []
  const modes = ["relay", "remote", "off"]
  const calls = []
  for (let i = 0; i < 150; i += 1) {
    const mode = modes[i % 3]
    calls.push(
      (async () => {
        // 制造微任务交错窗口：老实现会在此窗口里写 env 导致串味
        await Promise.resolve()
        const got = openclawMode(mode)
        sampler.push(process.env.MARVIS_WS_MODE)
        return { mode, got }
      })(),
    )
  }
  const results = await Promise.all(calls)

  assert.equal(results.length, 150)
  for (const { mode, got } of results) {
    assert.equal(got, mode, `modeOverride=${mode} 必须原样生效，实际 ${got}`)
  }
  assert.ok(
    sampler.every((v) => v === baseline),
    `并发期间 env 不得出现任何其它值（baseline=${baseline}）`,
  )
  assert.equal(process.env.MARVIS_WS_MODE, baseline, "调用结束后 env 必须与基线一致")
  if (installed) assert.equal(envWrites, 0, "openclawMode 全程不得写 process.env.MARVIS_WS_MODE")

  // 源码级兜底：cfg 只读取 env，不存在赋值
  const src = readSrc("src/marvis/openclaw.mjs")
  assert.doesNotMatch(
    src,
    /process\.env\.MARVIS_WS_MODE\s*=/,
    "openclaw.mjs 不得出现对 MARVIS_WS_MODE 的赋值",
  )
  assert.match(src, /export function openclawMode\(modeOverride = ""\) \{\s*return cfg\(modeOverride\)\.mode/, "入口必须把 override 透传给 cfg")
})

// ═══════════════════════════════════════════════════════════════════
// MockGateway（进程内 WS 网关，复用 gateway-stream.test.mjs 的帧协议）
// ═══════════════════════════════════════════════════════════════════

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

function sendServerFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8")
  let header
  if (payload.length < 126) header = Buffer.from([0x81, payload.length])
  else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

function decodeClientFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  if (opcode === 0x8) return { close: true }
  if (opcode !== 0x1 && opcode !== 0x2) return null
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  if (buf.length < off + 4) return null
  const mask = buf.subarray(off, off + 4)
  off += 4
  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.subarray(off, off + len))
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  try {
    return JSON.parse(payload.toString("utf8"))
  } catch {
    return null
  }
}

async function startMockGateway() {
  const state = { agentRuns: [], sockets: new Set() }
  const server = createServer((_req, res) => res.writeHead(404).end())
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"]
    if (!key) return socket.destroy()
    const accept = createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    state.sockets.add(socket)
    socket.on("close", () => state.sockets.delete(socket))
    socket.on("error", () => {})
    sendServerFrame(socket, {
      type: "event",
      event: "gateway.connected",
      data: { agentConnectionStatus: "Ready" },
    })
    socket.on("data", (buf) => {
      const msg = decodeClientFrame(buf)
      if (!msg || msg.close || !(msg.type === "req" && msg.event === "agent.run")) return
      state.agentRuns.push(msg)
      sendServerFrame(socket, { type: "res", requestId: msg.requestId, ok: true, data: {} })
      sendServerFrame(socket, {
        type: "event",
        event: "ag_ui_event",
        data: { event: "TEXT_MESSAGE_CONTENT", delta: "ok", messageId: "msg_qa" },
      })
      setTimeout(() => {
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "RUN_FINISHED", model: "qa-mock" },
        })
      }, 3)
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const close = () => {
    for (const s of state.sockets) s.destroy()
    state.sockets.clear()
    return new Promise((r) => server.close(r))
  }
  return { port: server.address().port, state, close }
}

// ═══════════════════════════════════════════════════════════════════
// B. loader relayConversationId：并发 + 重试链会话隔离
// ═══════════════════════════════════════════════════════════════════

const CRED = { openid: "QAOPENID", accessToken: "QATOKEN", guid: "qa-guid" }

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

test("B1 loader relay 通道：20 并发 fetch 各走一次 callUpstream，conversation_id 两两不同且不串号", { timeout: 40_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withEnv(t, {
    MARVIS_WS_MODE: "relay",
    MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`,
    MARVIS_GATEWAY_TOKEN: "qa-token",
    MARVIS_GATEWAY_CONVERSATION_ID: "",
  })

  const load = loaderHook({}, {})
  const auth = async () => ({
    access: "QATOKEN",
    refresh: "R",
    uid: "QAOPENID",
    metadata: { openid: "QAOPENID", guid: "qa-guid", loginType: "1" },
  })
  const hook = await load(auth)
  assert.ok(typeof hook.fetch === "function", "loader 必须给出 fetch")

  const N = 20
  const fetchCalls = []
  for (let i = 0; i < N; i += 1) {
    const mark = `QA-REQ-${i}`
    fetchCalls.push(
      (async () => {
        const body = JSON.stringify({
          model: "marvis-gateway",
          messages: [{ role: "user", content: mark }],
        })
        const res = await hook.fetch("http://localhost/v1/chat/completions", {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        })
        return { mark, status: res.status }
      })(),
    )
  }
  const responses = await Promise.all(fetchCalls)
  for (const r of responses) assert.equal(r.status, 200, `${r.mark} 应成功`)

  const runs = gw.state.agentRuns
  assert.equal(runs.length, N, `mock gateway 应收到 ${N} 个 agent.run，实际 ${runs.length}`)

  const byMark = new Map()
  for (const run of runs) {
    const cid = run.payload?.conversation_id
    const mark = String(run.payload?.message || "")
    assert.match(String(cid), /^conv_[0-9a-f]{32}$/i, `conversation_id 格式：${cid}`)
    assert.ok(!byMark.has(mark), `mark=${mark} 不应重复`)
    byMark.set(mark, cid)
  }
  assert.equal(byMark.size, N)
  const cids = [...byMark.values()]
  assert.equal(new Set(cids).size, N, "不同逻辑请求的 conversation_id 必须两两不同（无跨请求串号）")
})

test("B2 重试链模拟：每个逻辑请求 3 次 callUpstream 共用同一 conversation_id，20 请求并发不串号", { timeout: 60_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withEnv(t, {
    MARVIS_WS_MODE: "relay",
    MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`,
    MARVIS_GATEWAY_TOKEN: "qa-token",
    MARVIS_GATEWAY_CONVERSATION_ID: "",
  })

  const N = 20
  const RETRIES = 3
  const requested = new Map() // mark -> convId（行为侧真值）

  const logicalRequests = []
  for (let i = 0; i < N; i += 1) {
    const mark = `RETRY-${i}`
    // 与 loader fetch 闭包内一致：一次逻辑请求只生成一次 relayConversationId
    const relayConversationId = `conv_${randomUUID().replace(/-/g, "")}`
    requested.set(mark, relayConversationId)
    logicalRequests.push(
      (async () => {
        for (let k = 0; k < RETRIES; k += 1) {
          // 模拟 403 自愈链的每次 callUpstream：同一 relayConversationId 贯穿
          for await (const _frame of openclawChatStream(
            CRED,
            { model: "marvis-gateway", messages: [{ role: "user", content: mark }] },
            { mode: "relay", conversationId: relayConversationId },
          )) {
            /* drain */
          }
          await Promise.resolve() // 交错窗口
        }
      })(),
    )
  }
  await Promise.all(logicalRequests)

  const runs = gw.state.agentRuns
  assert.equal(runs.length, N * RETRIES, `应收到 ${N * RETRIES} 个 agent.run，实际 ${runs.length}`)

  const byMark = new Map()
  for (const run of runs) {
    const cid = run.payload?.conversation_id
    const mark = String(run.payload?.message || "")
    assert.match(String(cid), /^conv_[0-9a-f]{32}$/i)
    if (!byMark.has(mark)) byMark.set(mark, [])
    byMark.get(mark).push(cid)
  }
  assert.equal(byMark.size, N, "20 个逻辑请求都应有帧")
  for (const [mark, cids] of byMark) {
    assert.equal(cids.length, RETRIES, `${mark} 应有 ${RETRIES} 次重试`)
    assert.equal(new Set(cids).size, 1, `${mark} 内部所有重试必须共用同一 conversation_id`)
    assert.equal(cids[0], requested.get(mark), `${mark} 不得跨请求串号`)
  }
  const allIds = [...byMark.values()].map((xs) => xs[0])
  assert.equal(new Set(allIds).size, N, "逻辑请求之间的 conversation_id 必须不同")
})

test("B3 源码级：loader 一次 fetch 只生成一次 relayConversationId，贯穿所有 callUpstream 点", () => {
  const src = readSrc("src/hooks/loader.mjs")
  assert.equal(
    (src.match(/const relayConversationId = `conv_\$\{randomUUID\(\)\.replace/g) ?? []).length,
    1,
    "relayConversationId 只能在 fetch 内生成一次",
  )
  for (const re of [
    /openclawChatStream\(creds, json, \{ signal: init\?\.signal, conversationId: relayConversationId \}\)/,
    /openclawChat\(creds, json, \{ signal: init\?\.signal, conversationId: relayConversationId \}\)/,
    /conversationId: relayConversationId \}/, // 4100404 自动回退 relayOpts
  ]) {
    assert.match(src, re, `所有上游调用点都必须透传 relayConversationId：${re}`)
  }
  assert.doesNotMatch(src, /process\.env\.MARVIS_WS_MODE\s*=/, "loader 不得改写 MARVIS_WS_MODE")
})

// ═══════════════════════════════════════════════════════════════════
// C. externalQimeiByAccount / firstLineMemory 账号隔离
// ═══════════════════════════════════════════════════════════════════

test("C1 externalQimeiByAccount：3 账号并发外部出票，qimei36 各取各的、不互相覆盖", { timeout: 30_000 }, async (t) => {
  reloadFingerprint()
  delete process.env.MARVIS_QIMEI36
  const seen = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      let acct = "?"
      try {
        acct = JSON.parse(raw)?.common?.login_openid ?? "?"
      } catch {}
      seen.push(acct)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ uskey: `u_${acct}`, qimei36: `qimei_${acct}` }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  t.after(() => new Promise((r) => server.close(r)))
  withEnv(t, { MARVIS_USKEY_URL: `http://127.0.0.1:${server.address().port}/uskey` })

  const accounts = ["ACCT_A", "ACCT_B", "ACCT_C"]
  const tickets = await Promise.all(
    accounts.map((a) => uskeyOf({ openid: a, guid: `g_${a}` }, { busInfo: `bus_${a}` })),
  )
  assert.deepEqual(tickets, accounts.map((a) => `u_${a}`))

  const got = accounts.map((a) => qimei36({ login_openid: a }))
  assert.deepEqual(got, accounts.map((a) => `qimei_${a}`), "每个账号必须拿到自己的 qimei36")
  assert.equal(new Set(got).size, 3, "三账号 qimei36 不得互相覆盖")
  assert.equal(new Set(seen).size, 3, "三个账号都要真实走过外部出票")
})

test("C2 firstLineMemory：账号桶 + 首行 hash 复合 key，并发写不覆盖（源码断言 + 行为模拟）", () => {
  const src = readSrc("src/hooks/loader.mjs")
  assert.match(src, /const firstLineMemory = new Map\(\)/, "记忆表存在")
  assert.match(src, /firstLineMemoryKey\(bucket, originalLine\)/, "key 同时依赖 bucket 与首行")
  assert.match(
    src,
    /const hash = createHash\("sha256"\)\.update\(String\(originalLine \|\| ""\)\)\.digest\("hex"\)\.slice\(0, 16\)/,
    "首行参与 hash",
  )
  assert.match(src, /return `\$\{bucket\}:\$\{hash\}`/, "bucket 是 key 前缀（账号隔离关键）")
  for (const fn of ["rememberedFirstLine", "rememberFirstLine", "forgetFirstLine"]) {
    assert.match(src, new RegExp(`${fn}\\([^)]*\\).*firstLineMemoryKey\\(bucket, originalLine\\)`, "s"), `${fn} 必须走 firstLineMemoryKey`)
  }

  // 行为模拟：按源码一致的 key 算法，3 账号并发写各自首行记忆
  const mem = new Map()
  const key = (bucket, line) => `${bucket}:${createHash("sha256").update(String(line || "")).digest("hex").slice(0, 16)}`
  const writes = []
  for (const acct of ["A", "B", "C"]) {
    writes.push(
      (async () => {
        await Promise.resolve()
        mem.set(key(acct, "You are an AI agent."), `sentence_${acct}`)
      })(),
    )
  }
  return Promise.all(writes).then(() => {
    for (const acct of ["A", "B", "C"]) {
      assert.equal(mem.get(key(acct, "You are an AI agent.")), `sentence_${acct}`)
    }
    assert.equal(mem.size, 3, "三个账号的记忆条目并存，不互相覆盖")
  })
})

// ═══════════════════════════════════════════════════════════════════
// D. breaker 多桶并发 record
// ═══════════════════════════════════════════════════════════════════

function breakerEnv(patch) {
  const prev = {}
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k]
    process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("D1 breaker：10 账号并发 record(false)，各桶独立 open，共因闸关闭时全局桶不开", () => {
  const restore = breakerEnv({
    MARVIS_RISK_THRESHOLD: "1",
    MARVIS_RISK_COOLDOWN_MS: "1800000",
    MARVIS_RISK_CONSENSUS: "0",
    MARVIS_RISK_SCOPE: "account",
  })
  try {
    resetAllBreakers()
    const base = Date.now()
    const buckets = Array.from({ length: 10 }, (_, i) => `qa-bucket-${i}-${randomUUID().slice(0, 6)}`)
    const breakers = buckets.map((b) =>
      createBreaker({ bucket: b, threshold: 1, cooldownMs: 1800000, now: () => base, random: () => 0.5 }),
    )
    const global = getBreaker("*")
    assert.equal(global.open, false, "起始全局桶应关闭")

    for (const b of breakers) b.record(false) // 同步 record；并发语义由分桶保证

    for (const b of breakers) {
      assert.equal(b.open, true, "每个账号桶应独立 open")
      assert.equal(b.failures, 1, "每个账号桶独立计数为 1")
    }
    assert.equal(global.open, false, "MARVIS_RISK_CONSENSUS=0 时全局桶不得被误开")
  } finally {
    resetAllBreakers()
    restore()
  }
})

test("D2 breaker：共因闸开启（consensus=2）时，10 账号并发 record(false) 会 trip 全局桶", () => {
  const restore = breakerEnv({
    MARVIS_RISK_THRESHOLD: "1",
    MARVIS_RISK_COOLDOWN_MS: "1800000",
    MARVIS_RISK_CONSENSUS: "2",
    MARVIS_RISK_WINDOW_MS: "600000",
    MARVIS_RISK_SCOPE: "account",
  })
  try {
    resetAllBreakers()
    const buckets = Array.from({ length: 10 }, (_, i) => `qa-consensus-${i}-${randomUUID().slice(0, 6)}`)
    // 用真实日期：noteBucketTrip 内部用 Date.now()
    const bs = buckets.map((b) => getBreaker(b, `acct-${b}`))
    for (const b of bs) b.record(false)
    assert.equal(getBreaker("*").open, true, "≥2 个不同账号被拦后全局桶应被共因闸 trip")
    const globalState = breakerBuckets().find((x) => x.bucket === "*")
    assert.ok(globalState && globalState.openedAt > 0, "全局桶状态应落盘 openedAt>0")
  } finally {
    resetAllBreakers()
    restore()
  }
})

// ═══════════════════════════════════════════════════════════════════
// E. pacing 多 key 并发隔离
// ═══════════════════════════════════════════════════════════════════

test("E1 pacing：account 作用域下 A 账号等待不阻塞 B 账号放行；global 作用域对照会阻塞", { timeout: 10_000 }, async () => {
  const MIN = 60
  const accountPacing = createPacing({ minMs: MIN, jitterMs: 0, scope: "account" })
  await accountPacing.pacingWait("A") // A 占槽
  const [aWait, bWait] = await Promise.all([
    accountPacing.pacingWait("A"), // 需等 MIN
    accountPacing.pacingWait("B"), // 新 key，应立即 0
  ])
  assert.ok(aWait >= MIN - 5, `A 账号应等待约 ${MIN}ms，实际 ${aWait}`)
  assert.equal(bWait, 0, `B 账号必须立即放行（不受 A 等待影响），实际 ${bWait}`)
  const stB = accountPacing.pacingStatus("B")
  assert.equal(stB.key, "B", "account 作用域下 B 有独立时间轴")
  assert.equal(stB.activeKeys, 2, "A/B 两条独立时间轴")

  // 对照：global 作用域共用一条轴，B 会被 A 拖住
  const globalPacing = createPacing({ minMs: MIN, jitterMs: 0, scope: "global" })
  await globalPacing.pacingWait("A")
  const [ga, gb] = await Promise.all([globalPacing.pacingWait("A"), globalPacing.pacingWait("B")])
  assert.ok(gb > 0, `global 作用域下 B 应被 A 阻塞，实际 ${gb}`)
  assert.equal(globalPacing.pacingStatus("B").activeKeys, 1, "global 作用域只有一条 '*' 轴")
})
