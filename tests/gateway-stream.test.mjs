process.env.MARVIS_WS_MODE = ""
// 宿主机可能带着 MARVIS_* 真实配置跑 magpie —— 测试必须与宿主环境隔离
process.env.MARVIS_DIRECT_TRANSPORT ??= "fetch"
// tests/gateway-stream.test.mjs —— gateway.mjs 流式改造（C 类）回归锁
//
// 全部进程内 mock：node:http 服务器处理 upgrade，手写最小 WebSocket 帧收发
// （纯 node:crypto / Buffer，零外部依赖，不 spawn python —— 与 openclaw.test.mjs
// 的 python mock 互补）。
//
//   ① gatewayChatStream 按 AG-UI TEXT_MESSAGE_CONTENT 的 delta **实时** yield
//      （能观察到增量到达，而不是全量攒完一次性吐出）
//   ② yield 契约：{ delta?, model? }；RUN_FINISHED 的 model 随帧带出
//   ③ gatewayChat 聚合 wrapper：返回形状 { text, model } 与改造前一致
//   ④ RUN_ERROR → throw（文案沿用原风格）
//   ⑤ requestId 每请求唯一（不再是恒 "1"）
//   ⑥ flatten 保守改进：单条 user 直发原文；有 system 时独立在最前
//   ⑦ loader 接线：stream:true + relay → chat.completion.chunk SSE 实时透传；
//     非流式请求走聚合路径，行为零变化

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"

import { gatewayChat, gatewayChatStream, flatten } from "../src/marvis/gateway.mjs"

const CRED = { openid: "TESTOPENID", accessToken: "TESTTOKEN", guid: "test-guid" }
const PAYLOAD = { messages: [{ role: "user", content: "你好" }] }

/** 每个测试独立的 WS 环境变量 patch + 自动还原 */
function withWsEnv(t, patch) {
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
// 进程内 mock 网关：node:http upgrade + 最小 WS 帧协议
// ─────────────────────────────────────────────────────────────

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** 服务器 → 客户端帧（不带掩码，FIN + text） */
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

/** 客户端 → 服务器帧（带掩码）：只解析 agent.run 这一类请求 */
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

/**
 * 起一个进程内 mock 网关。
 * 剧本：gateway.connected → agent.run ACK → 逐个 TEXT_MESSAGE_CONTENT delta（40ms 间隔）
 * → RUN_FINISHED（带 model）；state.failWith 非空时改发 RUN_ERROR；
 * state.riskBlocked 非空时走真实风控形态：delta（拦截文案）→ CUSTOM(message_complete,
 * finishReason=risk_control_blocked) → RUN_ERROR(code=risk_control_blocked)。
 */
async function startMockGateway() {
  const state = {
    deltas: ["你", "好", "，", "世界"],
    failWith: null,
    riskBlocked: false,
    agentRuns: [],
    sockets: new Set(),
  }
  const server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
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
    // 首帧：网关就绪（与真实 PC 客户端一致，先于 agent.run）
    sendServerFrame(socket, {
      type: "event",
      event: "gateway.connected",
      data: { agentConnectionStatus: "Ready" },
    })
    socket.on("data", (buf) => {
      const msg = decodeClientFrame(buf)
      if (!msg || msg.close) return
      if (msg?.type === "req" && msg.event === "agent.run") {
        state.agentRuns.push(msg)
        sendServerFrame(socket, { type: "res", requestId: msg.requestId, ok: true, data: {} })
        // 风控剧本：复刻真机抓到的事件序列（delta=拦截文案 → CUSTOM → RUN_ERROR 带 code）
        if (state.riskBlocked) {
          sendServerFrame(socket, {
            type: "event",
            event: "ag_ui_event",
            data: { event: "TEXT_MESSAGE_CONTENT", delta: "当前环境有误，暂时无法回答你的问题，稍后再试试吧～", messageId: "msg_risk" },
          })
          sendServerFrame(socket, {
            type: "event",
            event: "ag_ui_event",
            data: {
              event: "CUSTOM",
              name: "message_complete",
              value: {
                content: "当前环境有误，暂时无法回答你的问题，稍后再试试吧～",
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
            data: { event: "RUN_ERROR", code: "risk_control_blocked", message: "当前环境有误，暂时无法回答你的问题，稍后再试试吧～" },
          })
          return
        }
        // delta 逐帧间隔发送 —— 消费端必须能观察到「增量」而不是一次性
        let i = 0
        const pushDelta = () => {
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
          if (state.failWith) {
            sendServerFrame(socket, {
              type: "event",
              event: "ag_ui_event",
              data: { event: "RUN_ERROR", message: state.failWith },
            })
            return
          }
          sendServerFrame(socket, {
            type: "event",
            event: "ag_ui_event",
            data: { event: "RUN_FINISHED", model: "mock-gateway-model" },
          })
        }
        setTimeout(pushDelta, 20)
      }
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

/** 把 generator 全量收进 {frame, at} 数组（at = 到达时间戳，观察增量用） */
async function collectStream(iter) {
  const out = []
  for await (const frame of iter) {
    out.push({ frame, at: Date.now() })
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// ① gatewayChatStream：按序实时 yield 增量
// ─────────────────────────────────────────────────────────────

test("gatewayChatStream 按序实时 yield 每个 delta（增量可观察，非一次性）", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withWsEnv(t, { MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`, MARVIS_GATEWAY_TOKEN: "test-token" })

  const got = await collectStream(gatewayChatStream(CRED, PAYLOAD))

  // delta 帧按序到达，且最后一个 model 帧（来自 RUN_FINISHED）压轴
  const deltas = got.filter((x) => typeof x.frame.delta === "string").map((x) => x.frame.delta)
  assert.deepEqual(deltas, ["你", "好", "，", "世界"], "delta 必须按上游顺序逐帧 yield")
  const last = got.at(-1)?.frame
  assert.deepEqual(last, { model: "mock-gateway-model" }, "RUN_FINISHED 的 model 单独随帧带出")

  // 增量观察：首 delta 与末 delta 的到达时间差必须明显（mock 间隔 40ms）。
  // 一次性攒完再吐的实现，这个差值接近 0。
  const span = got.at(-1).at - got[0].at
  assert.ok(span >= 80, `增量帧必须实时到达（首末差 ${span}ms < 80ms，疑似一次性攒完）`)
})

// ─────────────────────────────────────────────────────────────
// ② gatewayChat 聚合 wrapper：返回形状与改造前一致
// ─────────────────────────────────────────────────────────────

test("gatewayChat 聚合结果 { text, model } 与现有返回形状一致", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withWsEnv(t, { MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`, MARVIS_GATEWAY_TOKEN: "test-token" })

  const result = await gatewayChat(CRED, PAYLOAD)
  assert.deepEqual(Object.keys(result).sort(), ["model", "text"], "返回形状不许变")
  assert.equal(result.text, "你好，世界", "聚合文本 = 全部 delta 拼接")
  assert.equal(result.model, "mock-gateway-model", "model 取 RUN_FINISHED 帧带出的值")
})

// ─────────────────────────────────────────────────────────────
// ③ RUN_ERROR → throw
// ─────────────────────────────────────────────────────────────

test("RUN_ERROR 以 throw 结束（stream 与聚合路径都要抛）", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  gw.state.failWith = "mock 运行失败"
  t.after(() => gw.close())
  withWsEnv(t, { MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`, MARVIS_GATEWAY_TOKEN: "test-token" })

  await assert.rejects(
    () => collectStream(gatewayChatStream(CRED, PAYLOAD)),
    /agent 运行出错：mock 运行失败/,
    "stream 消费方必须在 RUN_ERROR 处收到 throw",
  )
  await assert.rejects(
    () => gatewayChat(CRED, PAYLOAD),
    /agent 运行出错：mock 运行失败/,
    "聚合 wrapper 同样要把 RUN_ERROR 抛出去",
  )
})

// ─────────────────────────────────────────────────────────────
// ③b 风控拦截：risk_control_blocked 不得伪装成正常回复
// （真机实测：拦截文案作为 delta 流出，之后 CUSTOM/RUN_ERROR 才带 code ——
//   不识别它，用户会拿到一段「当前环境有误…」的假回复，不知道自己被风控了）
// ─────────────────────────────────────────────────────────────

test("risk_control_blocked 以明确错误抛出，拦截文案不作为正文返回", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  gw.state.riskBlocked = true
  t.after(() => gw.close())
  withWsEnv(t, { MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`, MARVIS_GATEWAY_TOKEN: "test-token" })

  // 聚合路径：必须抛「风控拦截」而不是返回 text
  await assert.rejects(
    () => gatewayChat(CRED, PAYLOAD),
    (err) => {
      assert.match(err.message, /risk_control_blocked/)
      assert.match(err.message, /风控拦截/)
      return true
    },
    "风控必须以错误暴露，不能让拦截文案成为 model 的回复",
  )

  // 流式路径：同样 throw；且已吐出的 delta 由消费方按 throw 丢弃
  await assert.rejects(() => collectStream(gatewayChatStream(CRED, PAYLOAD)), /risk_control_blocked/)
})

// ─────────────────────────────────────────────────────────────
// ④ requestId 每请求唯一
// ─────────────────────────────────────────────────────────────

test("agent.run 的 requestId 每请求唯一（不再是恒 \"1\"）", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  withWsEnv(t, { MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`, MARVIS_GATEWAY_TOKEN: "test-token" })

  await gatewayChat(CRED, { messages: [{ role: "user", content: "第一问" }] })
  await gatewayChat(CRED, { messages: [{ role: "user", content: "第二问" }] })

  assert.equal(gw.state.agentRuns.length, 2, "mock 必须收到两次 agent.run")
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  for (const run of gw.state.agentRuns) {
    assert.match(String(run.requestId), UUID, "requestId 必须是 UUID")
    assert.notEqual(String(run.requestId), "1", "不允许再出现恒 \"1\"")
  }
  assert.notEqual(gw.state.agentRuns[0].requestId, gw.state.agentRuns[1].requestId, "两次请求不许撞 id")
})

// ─────────────────────────────────────────────────────────────
// ⑤ flatten 保守改进
// ─────────────────────────────────────────────────────────────

test("flatten：单条 user 消息（无 system）直接发原文，不加 \"user: \" 前缀", () => {
  assert.equal(flatten([{ role: "user", content: "你好" }]), "你好")
})

test("flatten：有 system 时 system 块独立在最前（无前缀），其余轮次保留 role: 结构", () => {
  const out = flatten([
    { role: "system", content: "你是助手。" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "再见" },
  ])
  assert.match(out, /^你是助手。/, "system 块必须独立在最前且不带 system: 前缀")
  assert.match(out, /user: 你好/, "其余轮次保留 \"role: content\" 结构")
  assert.match(out, /assistant: 你好！/)
  assert.match(out, /user: 再见/)
})

test("flatten：无 system 的多轮对话保持 \"role: content\"（旧结构不回归）", () => {
  const out = flatten([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
  ])
  assert.match(out, /^user: 你好/)
  assert.match(out, /assistant: 你好！/)
})

test("flatten：多模态 content 数组兼容保持现状（按 text 块拼接）", () => {
  const out = flatten([
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }] },
  ])
  assert.equal(out, "看图", "单条 user 的多模态数组：文本块拼接后原文直发")
})

// ─────────────────────────────────────────────────────────────
// ⑥ loader 接线：stream:true + relay → chat.completion.chunk SSE；非流式零变化
// ─────────────────────────────────────────────────────────────

/** 假凭据：只是形状对，值全部是测试用的假串，不会发到任何真实上游 */
const AUTH = Object.freeze({
  access: "mv_test_offline_only",
  uid: "0123456789abcdef0123456789abcdef",
  metadata: {
    openid: "fedcba9876543210fedcba9876543210",
    guid: "0".repeat(32),
    loginType: "1",
  },
})

test("loader 接线：relay + stream:true → chat.completion.chunk SSE 实时透传", { timeout: 30_000 }, async (t) => {
  const gw = await startMockGateway()
  t.after(() => gw.close())
  // MARVIS_TRANSPORT=off 显式关掉 HTTP 本地网关（否则 localGatewayEnabled 会真探测 8088）；
  // relay + GW_URL 指向进程内 mock。
  withWsEnv(t, {
    MARVIS_TRANSPORT: "off",
    MARVIS_GATEWAY_URL: "",
    MARVIS_GATEWAY_KEY: "",
    MARVIS_WS_MODE: "relay",
    MARVIS_GW_URL: `ws://127.0.0.1:${gw.port}/`,
    MARVIS_GATEWAY_TOKEN: "test-token",
  })

  const { loaderHook } = await import("../src/hooks/loader.mjs")
  const describe = await loaderHook()(async () => AUTH)

  const res = await describe.fetch("https://yybadaccess.3g.qq.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "main-auto",
      stream: true,
      messages: [{ role: "user", content: "你好" }],
    }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type"), /event-stream/)

  const text = await res.text()
  const lines = text.split("\n\n").filter((s) => s.startsWith("data: "))
  assert.equal(lines.at(-1), "data: [DONE]", "必须以 data: [DONE] 收尾")
  const frames = lines.slice(0, -1).map((s) => JSON.parse(s.slice(6)))
  for (const f of frames) {
    assert.equal(f.object, "chat.completion.chunk")
    assert.equal(f.choices[0].index, 0)
  }
  // 首帧带 role
  assert.deepEqual(frames[0].choices[0].delta, { role: "assistant", content: "" })
  assert.equal(frames[0].choices[0].finish_reason, null)
  // 之后 delta.content 逐帧
  const contents = frames.slice(1).filter((f) => f.choices[0].delta.content).map((f) => f.choices[0].delta.content)
  assert.deepEqual(contents, ["你", "好", "，", "世界"], "增量必须逐帧透传给宿主")
  // 末帧 finish_reason:"stop"
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop")

  // 非流式请求照旧走聚合路径，行为零变化
  const res2 = await describe.fetch("https://yybadaccess.3g.qq.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "main-auto",
      stream: false,
      messages: [{ role: "user", content: "你好" }],
    }),
  })
  assert.equal(res2.status, 200)
  // 注：loader 现有 normalizeStreaming 会把成功响应的 content-type 统一改写成
  // text/event-stream（既有行为，非本次改动引入），所以这里只断言 body 形状。
  const j = await res2.json()
  assert.equal(j.object, "chat.completion")
  assert.equal(j.choices[0].message.content, "你好，世界")
})
