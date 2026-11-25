process.env.MARVIS_WS_MODE = ""
process.env.MARVIS_DIRECT_TRANSPORT ??= "fetch"
// 任务要求：关掉节流抖动，避免测试被 pacing 拖到超时
process.env.MARVIS_MIN_REQUEST_INTERVAL_MS = "0"
process.env.MARVIS_REQUEST_JITTER_MS = "0"

// qa-e2e.test.mjs —— 0.8.4 核心链路端到端功能测试（进程内 mock，零真实网络）
//
// 参考 tests/gateway-stream.test.mjs 的 MockGateway：node:http upgrade + 手写 WS 帧。
// 本文件在其基础上补全：
//   · state.events 记录 gateway.connected / agent.run 的到达顺序；
//   · state.riskRunErrorOnly 只发「风控 delta + RUN_ERROR(code=risk_control_blocked)」，
//     精确命中 RUN_ERROR 分支（真机帧序的 CUSTOM 分支另测）；
//   · 服务端回显 WS close 帧，使消费方 break / abort 后的 socket 关闭可被观测；
//   · WebSocket 全局 spy，直接断言客户端实例 readyState，验证无泄漏。
//
// 覆盖：
//   ① 主链路 connected → agent.run → 增量 TEXT_MESSAGE_CONTENT → RUN_FINISHED
//   ② conversationId：传入复用 / 不传新建 conv_<32hex> / sticky 环境变量覆盖
//   ③ responseId 每次调用新建（同一 conv 下两次不同）
//   ④ 风控文案扣留：RUN_ERROR code=risk_control_blocked → throw，文案不进正文
//   ⑤ abort / 消费方 break → socket 关闭、无泄漏

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"

import { gatewayChatStream, gatewayChat } from "../src/marvis/gateway.mjs"

const CRED = { openid: "TESTOPENID", accessToken: "TESTTOKEN", guid: "test-guid" }
const PAYLOAD = { messages: [{ role: "user", content: "你好" }] }
const CONV_RE = /^conv_[0-9a-f]{32}$/
const RESP_RE = /^resp_[0-9a-f]{32}$/
const RISK_TEXT = "当前环境有误，暂时无法回答你的问题，稍后再试试吧～"

/** 每个测试独立 patch 环境变量 + 自动还原（宿主机 MARVIS_* 不得污染测试） */
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

/** 把 GW_URL 指向 mock，并显式关掉 sticky（除 sticky 专项测试外） */
function withGw(t, gw, extra = {}) {
  withEnv(t, {
    MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`,
    MARVIS_GATEWAY_TOKEN: "test-token",
    MARVIS_GATEWAY_CONVERSATION_ID: undefined,
    ...extra,
  })
}

// ─────────────────────────────────────────────────────────────
// 进程内 mock 网关
// ─────────────────────────────────────────────────────────────

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** 服务端 → 客户端文本帧（无掩码，FIN + text） */
function sendServerFrame(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8")
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
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

/** 服务端回显 close 帧，完成关闭握手（真实 WS 服务端行为） */
function sendServerClose(socket) {
  try {
    socket.write(Buffer.from([0x88, 0x00]))
    socket.end()
  } catch {
    /* ignore */
  }
}

/** 客户端 → 服务端帧（带掩码）：解析 agent.run / close */
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
  const state = {
    deltas: ["你", "好", "，", "世界"],
    riskBlocked: false, // 真机帧序：delta → CUSTOM(message_complete) → RUN_ERROR
    riskRunErrorOnly: false, // 精确测 RUN_ERROR(code) 分支：delta → RUN_ERROR
    agentRuns: [],
    events: [],
    sockets: new Set(),
  }
  const server = createServer((_req, res) => res.writeHead(404).end())

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"]
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    state.sockets.add(socket)
    socket.on("close", () => state.sockets.delete(socket))
    socket.on("error", () => {})

    state.events.push({ name: "gateway.connected", at: Date.now() })
    sendServerFrame(socket, {
      type: "event",
      event: "gateway.connected",
      data: { agentConnectionStatus: "Ready" },
    })

    socket.on("data", (buf) => {
      const msg = decodeClientFrame(buf)
      if (!msg) return
      if (msg.close) {
        sendServerClose(socket)
        return
      }
      if (msg?.type !== "req" || msg.event !== "agent.run") return

      state.events.push({ name: "agent.run", at: Date.now() })
      state.agentRuns.push(msg)
      sendServerFrame(socket, { type: "res", requestId: msg.requestId, ok: true, data: {} })

      // 风控分支 A：只有 delta + RUN_ERROR(code) —— 精确覆盖 RUN_ERROR 处理分支
      if (state.riskRunErrorOnly) {
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "TEXT_MESSAGE_CONTENT", delta: RISK_TEXT, messageId: "msg_risk_re" },
        })
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "RUN_ERROR", code: "risk_control_blocked", message: RISK_TEXT },
        })
        return
      }

      // 风控分支 B：真机帧序（拦截文案 → CUSTOM finishReason → RUN_ERROR code）
      if (state.riskBlocked) {
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "TEXT_MESSAGE_CONTENT", delta: RISK_TEXT, messageId: "msg_risk" },
        })
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: {
            event: "CUSTOM",
            name: "message_complete",
            value: {
              content: RISK_TEXT,
              messageId: "msg_risk",
              metadata: { finishReason: "risk_control_blocked" },
              role: "assistant",
              toolCalls: null,
            },
          },
        })
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "RUN_ERROR", code: "risk_control_blocked", message: RISK_TEXT },
        })
        return
      }

      // 正常剧本：delta 每 40ms 一帧，最后 RUN_FINISHED 带 model
      let i = 0
      const pushDelta = () => {
        if (socket.destroyed) return
        if (i < state.deltas.length) {
          sendServerFrame(socket, {
            type: "event",
            event: "ag_ui_event",
            data: { event: "TEXT_MESSAGE_CONTENT", delta: state.deltas[i], messageId: "msg_mock" },
          })
          i += 1
          setTimeout(pushDelta, 40)
          return
        }
        sendServerFrame(socket, {
          type: "event",
          event: "ag_ui_event",
          data: { event: "RUN_FINISHED", model: "mock-gateway-model" },
        })
      }
      setTimeout(pushDelta, 20)
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () => {
    for (const s of state.sockets) s.destroy()
    state.sockets.clear()
    return new Promise((resolve) => server.close(resolve))
  }
  return { port: server.address().port, state, close }
}

/** 全量收集 generator，at = 到达时间戳（观察增量） */
async function collectStream(iter) {
  const out = []
  for await (const frame of iter) out.push({ frame, at: Date.now() })
  return out
}

function waitUntil(fn, ms = 3000) {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const ok = fn()
      if (ok || Date.now() - start >= ms) resolve(ok)
      else setTimeout(tick, 20)
    }
    tick()
  })
}

const RealWebSocket = globalThis.WebSocket

/** spy 全局 WebSocket，拿到 generator 内部创建的客户端实例 */
function spyWebSockets(t) {
  const instances = []
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      const ws = Reflect.construct(target, args)
      instances.push(ws)
      return ws
    },
  })
  t.after(() => {
    globalThis.WebSocket = RealWebSocket
  })
  return instances
}

// ─────────────────────────────────────────────────────────────
// ① 主链路
// ─────────────────────────────────────────────────────────────

test("E2E-1 主链路：gateway.connected → agent.run → 增量 TEXT_MESSAGE_CONTENT → RUN_FINISHED", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)

  const got = await collectStream(gatewayChatStream(CRED, PAYLOAD))

  assert.equal(gw.state.agentRuns.length, 1, "必须且只发出一次 agent.run")
  assert.deepEqual(
    gw.state.events.map((e) => e.name),
    ["gateway.connected", "agent.run"],
    "必须先收到 gateway.connected 才发 agent.run",
  )
  const deltas = got.filter((x) => typeof x.frame.delta === "string").map((x) => x.frame.delta)
  assert.deepEqual(deltas, ["你", "好", "，", "世界"], "delta 按上游顺序逐帧 yield")
  assert.deepEqual(got.at(-1)?.frame, { model: "mock-gateway-model" }, "RUN_FINISHED 的 model 压轴带出")
  const span = got.at(-1).at - got[0].at
  assert.ok(span >= 80, `增量必须实时到达（首末差 ${span}ms < 80ms）`)
})

// ─────────────────────────────────────────────────────────────
// ② conversationId 三种行为
// ─────────────────────────────────────────────────────────────

test("E2E-2 传入 opts.conversationId：agent.run 复用该值，不新建", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)

  const conv = `conv_${"a".repeat(32)}`
  await collectStream(gatewayChatStream(CRED, PAYLOAD, { conversationId: conv }))

  assert.equal(gw.state.agentRuns.length, 1)
  const used = gw.state.agentRuns[0].payload.conversation_id
  assert.equal(used, conv, "传入的 conversation_id 必须原样进入 agent.run 帧")
})

test("E2E-3 不传 conversationId：每次调用新建合法 conv_<32hex>，两次互不相同", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)

  await collectStream(gatewayChatStream(CRED, PAYLOAD))
  await collectStream(gatewayChatStream(CRED, PAYLOAD))

  const ids = gw.state.agentRuns.map((r) => r.payload.conversation_id)
  assert.equal(ids.length, 2)
  for (const id of ids) assert.match(id, CONV_RE, `会话 ID 必须是 conv_<32hex>：${id}`)
  assert.notEqual(ids[0], ids[1], "两次新建不许撞 ID")
})

test("E2E-4 MARVIS_GATEWAY_CONVERSATION_ID sticky 覆盖 opts.conversationId", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  const sticky = `conv_${"b".repeat(32)}`
  const passed = `conv_${"c".repeat(32)}`
  withGw(t, gw, { MARVIS_GATEWAY_CONVERSATION_ID: sticky })

  await collectStream(gatewayChatStream(CRED, PAYLOAD, { conversationId: passed }))
  await collectStream(gatewayChatStream(CRED, PAYLOAD, { conversationId: passed }))

  const ids = gw.state.agentRuns.map((r) => r.payload.conversation_id)
  assert.deepEqual(ids, [sticky, sticky], "即使传了 opts.conversationId，也必须全部钉在 sticky 值上")
})

// ─────────────────────────────────────────────────────────────
// ③ responseId 每次新建
// ─────────────────────────────────────────────────────────────

test("E2E-5 同一 conv 下两次调用：response_id 每次新建且互不相同", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)

  const conv = `conv_${"d".repeat(32)}`
  await collectStream(gatewayChatStream(CRED, PAYLOAD, { conversationId: conv }))
  await collectStream(gatewayChatStream(CRED, PAYLOAD, { conversationId: conv }))

  const runs = gw.state.agentRuns
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => r.payload.conversation_id), [conv, conv], "会话复用")
  const ids = runs.map((r) => r.payload.response_id)
  for (const id of ids) assert.match(id, RESP_RE, `response_id 必须是 resp_<32hex>：${id}`)
  assert.notEqual(ids[0], ids[1], "同一会话下 response_id 不许复用")
})

// ─────────────────────────────────────────────────────────────
// ④ 风控文案扣留
// ─────────────────────────────────────────────────────────────

test("E2E-6 风控扣留：RUN_ERROR(code=risk_control_blocked) 以 throw 结束，拦截文案不进正文", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  gw.state.riskRunErrorOnly = true
  t.after(() => gw.close())
  withGw(t, gw)

  const got = []
  await assert.rejects(
    async () => {
      for await (const f of gatewayChatStream(CRED, PAYLOAD)) got.push(f)
    },
    (err) => {
      assert.equal(err.code, "risk_control_blocked", "必须带 code，上层 loader 才能回 429")
      assert.match(err.message, /风控拦截/)
      return true
    },
    "RUN_ERROR(code=risk_control_blocked) 必须在流式中抛错",
  )
  assert.equal(got.length, 0, "扣住的拦截文案必须随 failStream 丢弃，一帧都不许流出")
  assert.equal(got.some((f) => /当前环境有误|暂时无法回答/.test(String(f?.delta || ""))), false)

  // 聚合 wrapper 同样 throw，绝不返回假正文
  await assert.rejects(
    () => gatewayChat(CRED, PAYLOAD),
    (err) => {
      assert.equal(err.code, "risk_control_blocked")
      return true
    },
  )
})

test("E2E-7 风控扣留：真机帧序（CUSTOM finishReason + RUN_ERROR）同样 throw 且不外泄", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  gw.state.riskBlocked = true
  t.after(() => gw.close())
  withGw(t, gw)

  const got = []
  await assert.rejects(
    async () => {
      for await (const f of gatewayChatStream(CRED, PAYLOAD)) got.push(f)
    },
    (err) => {
      assert.equal(err.code, "risk_control_blocked")
      assert.match(err.message, /风控拦截/)
      return true
    },
  )
  const leaked = got.some((f) => /当前环境有误|暂时无法回答/.test(String(f?.delta || "")))
  assert.equal(leaked, false, "拦截文案不许作为 delta 流出")
})

// ─────────────────────────────────────────────────────────────
// ⑤ abort / cleanup：消费方 break
// ─────────────────────────────────────────────────────────────

test("E2E-8 消费方 break：generator finally 关闭 socket，无泄漏", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)
  const wsSpy = spyWebSockets(t)

  for await (const _f of gatewayChatStream(CRED, PAYLOAD)) {
    break // 只消费首帧就 break
  }

  assert.equal(wsSpy.length, 1, "generator 只应创建一条 WS")
  const ws = wsSpy[0]
  await waitUntil(() => ws.readyState === 3, 5000)
  assert.equal(ws.readyState, 3, `break 后客户端 socket 必须 CLOSED（实际 ${ws.readyState}）`)
  await waitUntil(() => gw.state.sockets.size === 0, 3000)
  assert.equal(gw.state.sockets.size, 0, "服务端侧也必须观察到连接关闭，不能泄漏")
})

test("E2E-9 AbortSignal 取消：以 throw 结束并清理 socket", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withGw(t, gw)
  const wsSpy = spyWebSockets(t)

  const ac = new AbortController()
  await assert.rejects(
    async () => {
      for await (const _f of gatewayChatStream(CRED, PAYLOAD, { signal: ac.signal })) {
        ac.abort()
      }
    },
    /请求已取消/,
    "abort 必须以 throw 结束",
  )

  assert.equal(wsSpy.length, 1)
  const ws = wsSpy[0]
  await waitUntil(() => ws.readyState === 3, 5000)
  assert.equal(ws.readyState, 3, `abort 后客户端 socket 必须 CLOSED（实际 ${ws.readyState}）`)
  await waitUntil(() => gw.state.sockets.size === 0, 3000)
  assert.equal(gw.state.sockets.size, 0, "abort 后不许残留连接")
})
