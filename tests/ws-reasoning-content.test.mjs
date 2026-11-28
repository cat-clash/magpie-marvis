import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const oc = await import(pathToFileURL(join(HERE, "..", "src", "marvis", "openclaw.mjs")).href)
const gw = await import(pathToFileURL(join(HERE, "..", "src", "marvis", "gateway.mjs")).href)

// 0.9.11：PC agent 的 REASONING_* 事件全部丢弃 —— 不进正文，也不产生 reasoning_content。
// 原因：卡在重试循环时思考里会倒出大量工具调用 JSON / 重复文本（实测 24115 帧），
// 展示出来就是用户看到的乱码。

test("0.9.11：REASONING_* 事件全部判为 reasoning，命中即丢弃", () => {
  for (const ev of ["REASONING_CONTENT", "REASONING_START", "REASONING_END",
                    "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_START", "reasoning_content"]) {
    assert.equal(gw.isReasoningEvent(ev), true, `ev=${ev}`)
  }
})

test("0.9.11：正文/普通事件不判为 reasoning（不会被误丢）", () => {
  for (const ev of ["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_START", "RUN_STARTED",
                    "RUN_FINISHED", "RUN_ERROR", "CUSTOM", "", undefined]) {
    assert.equal(gw.isReasoningEvent(ev), false, `ev=${ev}`)
  }
})

test("0.9.10 兼容：openclaw 侧 reasoning_content 通道仍在（从此无输入，保留兼容）", async () => {
  const res = oc.openclawResponse(
    { stream: false },
    { text: "2", reasoning: "思考", model: "m" },
  )
  const d = await res.json()
  assert.equal(d.choices[0].message.content, "2")
  assert.equal(d.choices[0].message.reasoning_content, "思考")
})

test("0.9.10 兼容：流式 content 与 reasoning_content 分不同 chunk", async () => {
  const res = oc.openclawStreamResponse(
    { stream: true },
    (async function* () {
      yield { reasoning: "思考A" }
      yield { delta: "正文B" }
    })(),
  )
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let raw = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value, { stream: true })
  }
  const chunks = raw.split("\n\n").filter((s) => s.startsWith("data: ") && !s.includes("[DONE]"))
    .map((s) => JSON.parse(s.slice(6)))
  const reasoning = chunks.filter((c) => c.choices[0].delta.reasoning_content).map((c) => c.choices[0].delta.reasoning_content)
  const content = chunks.filter((c) => c.choices[0].delta.content).map((c) => c.choices[0].delta.content)
  assert.deepEqual(reasoning, ["思考A"])
  assert.deepEqual(content, ["正文B"])
})
