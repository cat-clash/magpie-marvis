import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const oc = await import(pathToFileURL(join(HERE, "..", "src", "marvis", "openclaw.mjs")).href)

// 0.9.10 回归：PC agent 的 REASONING_* delta 必须走 reasoning_content，
// 不能再混进 content（否则 DSH 把整段思考当正文显示 = 用户看到的乱码）。

test("非流式：reasoning 进 reasoning_content，正文只有 content", async () => {
  const res = oc.openclawResponse(
    { stream: false, model: "group/qq" },
    { text: "2", reasoning: "让我算一下 1+1", model: "deepseek-v4-1-flash-261017" },
  )
  assert.equal(res.status, 200)
  const d = await res.json()
  const msg = d.choices[0].message
  assert.equal(msg.content, "2")
  assert.equal(msg.reasoning_content, "让我算一下 1+1")
})

test("非流式：无 reasoning 时不产生 reasoning_content 字段", async () => {
  const res = oc.openclawResponse({ stream: false }, { text: "ok", model: "m" })
  const d = await res.json()
  assert.equal(d.choices[0].message.reasoning_content, undefined)
})

test("流式：content 与 reasoning_content 分不同 chunk", async () => {
  const res = oc.openclawStreamResponse(
    { stream: true },
    (async function* () {
      yield { reasoning: "思考A" }
      yield { delta: "正文B" }
      yield { reasoning: "思考C" }
    })(),
  )
  assert.equal(res.status, 200)
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
  assert.deepEqual(reasoning, ["思考A", "思考C"])
  assert.deepEqual(content, ["正文B"])
  assert.ok(!reasoning.join("").includes("正文"))
  assert.ok(!content.join("").includes("思考"))
})
