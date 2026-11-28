// thinking-split 单元测试 + 流式/非流式接线测试（0.9.13）
//
// 背景：走 WS relay（PC 客户端 agent.run）时，PC agent 把推理、重试、最终回答
// 拼进同一个 text 流，没有独立 REASONING_* 事件。这里按行分类：几乎不含中文的
// 英文「思考行」移入 reasoning_content（客户端折叠、不占正文），中文回答留在 content。
import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

const { classifyLine, createLineSplitter, splitFullText } = await import(
  pathToFileURL(join(HERE, "..", "src", "marvis", "thinking-split.mjs")).href
)
const { openclawStreamResponse, openclawResponse } = await import(
  pathToFileURL(join(HERE, "..", "src", "marvis", "openclaw.mjs")).href
)

test("classifyLine：以思考句式开头的纯英文行 → reasoning", () => {
  for (const line of [
    "The user wants me to check how many domains they had.\n",
    "Let me read those memories. Then decide. Likely the site is a CatPaw-related service.\n",
    "I should do: recall_memory read those IDs.\n",
    "Hmm — but wait. There's a serious conflict in the injected text here.\n",
  ]) {
    assert.equal(classifyLine(line), "reasoning", line.trim())
  }
})

test("classifyLine：中文行 → content（哪怕夹着英文）", () => {
  for (const line of [
    "老板，测试收到，通道正常。\n",
    "我是 Marvis，电脑端的活儿都可以直接派给我：文件查找与整理。\n",
    "结论：这个站是美团 CatPaw 的全球站。\n",
    "用 Chrome DevTools 打开 Network 面板看请求。\n",
  ]) {
    assert.equal(classifyLine(line), "content", line.trim())
  }
})

test("classifyLine：空行 → blank；空/非字符串不崩", () => {
  assert.equal(classifyLine(""), "blank")
  assert.equal(classifyLine("   \n"), "blank")
  assert.equal(classifyLine(undefined), "blank")
  assert.equal(classifyLine(null), "blank")
})

test("classifyLine：英文但过短（不是思考长句）→ content", () => {
  assert.equal(classifyLine("OK\n"), "content")
  assert.equal(classifyLine("The end.\n"), "content")
})

test("splitFullText：英文思考归 reasoning，中文正文原样保留", () => {
  const text = [
    "The user just said test. The appropriate response is brief and direct.",
    "Let me check the tool output first before answering anything.",
    "",
    "老板，测试收到，通道正常。",
    "有具体要做的，直接把目标说给我。",
  ].join("\n")
  const r = splitFullText(text)
  assert.match(r.content, /老板，测试收到/)
  assert.match(r.content, /有具体要做的/)
  assert.doesNotMatch(r.content, /The user just said/)
  assert.doesNotMatch(r.content, /Let me check/)
  assert.match(r.reasoning, /The user just said/)
  assert.match(r.reasoning, /Let me check/)
})

test("splitFullText：重复的思考行只留一次（PC agent 重试会叠两遍）", () => {
  const dup = "The user wants the site nature explained in detail right now."
  const r = splitFullText([dup, dup, dup, "好的，我来说明。"].join("\n"))
  assert.equal(r.reasoning.split(dup).length - 1, 1)
  assert.equal(r.dupDropped, 2)
  assert.match(r.content, /好的，我来说明/)
})

test("createLineSplitter：跨 delta 的半行会被拼完整再分类", () => {
  const sp = createLineSplitter()
  const out = []
  out.push(...sp.feed("The user wants me to "))   // 半行，不出
  out.push(...sp.feed("read the file first.\n"))  // 凑成完整思考行
  out.push(...sp.feed("我在查了。\n"))
  out.push(...sp.flush())
  const kinds = out.map((x) => x.kind)
  assert.deepEqual(kinds, ["reasoning", "content"])
  assert.match(out[0].text, /read the file first/)
  assert.match(out[1].text, /我在查了/)
})

test("createLineSplitter：含中文的半行立即放行（保住流式实时性）", () => {
  const sp = createLineSplitter()
  const out = sp.feed("我做完了")
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, "content")
  assert.equal(out[0].text, "我做完了")
  // 进入正文后直通，不再缓冲
  assert.deepEqual(sp.feed("，下一个。").map((x) => x.text), ["，下一个。"])
  assert.deepEqual(sp.flush(), [])
})

test("createLineSplitter：纯英文半行不提前放行，flush 才吐", () => {
  const sp = createLineSplitter()
  // 纯英文、词数不足的思考半行 —— 必须继续等换行，不能当正文直通出去
  assert.deepEqual(sp.feed("The user wants me to "), [])
  const tail = sp.flush()
  assert.equal(tail.length, 1)
  assert.equal(tail[0].kind, "content")   // 没凑够思考判据 → flush 时按正文处理（宁可漏切）
  assert.match(tail[0].text, /The user wants me to/)
})

test("splitFullText：整段英文被切光时兜底还回正文（防误伤）", () => {
  const r = splitFullText([
    "The user wants a full breakdown of the deployment steps in detail.",
    "Let me list every step of the rollout plan for the operator.",
  ].join("\n"))
  assert.equal(r.reasoning, "", "全文英文时不能把整段吞进 reasoning")
  assert.match(r.content, /full breakdown of the deployment steps/)
})

/** 收集 SSE 文本 */
async function readSse(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let s = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    s += dec.decode(value, { stream: true })
  }
  return s
}

function frames(list) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of list) yield f
    },
  }
}

test("openclawStreamResponse：英文思考进 reasoning_content，中文正文进 content", async () => {
  const payload = { model: "deepseek-v4-1-flash-261017", stream: true }
  const res = openclawStreamResponse(payload, frames([
    { delta: "The user wants me to check the recycle bin contents first." },
    { delta: "\n老板，我查到了。\n" },
    { delta: "共 3 个文件可以恢复。\n" },
  ]))
  assert.equal(res.status, 200)
  const sse = await readSse(res)

  const thinkChunks = sse.split("\n\n")
    .filter((l) => l.includes('"reasoning_content"'))
  const contentChunks = sse.split("\n\n")
    .filter((l) => l.includes('"content":"') && !l.includes('"reasoning_content"'))

  assert.ok(thinkChunks.length >= 1, "应有 reasoning_content 帧")
  assert.ok(thinkChunks.join("").includes("The user wants me"), "思考内容应进 reasoning_content")
  assert.ok(contentChunks.join("").includes("老板，我查到了"), "中文正文应进 content")
  assert.ok(!contentChunks.join("").includes("The user wants me"), "正文里不应再有英文思考")
  assert.ok(sse.trimEnd().endsWith("data: [DONE]"))
})

test("openclawResponse（非流式）：content 与 reasoning_content 分开", async () => {
  const payload = { model: "deepseek-v4-1-flash-261017", stream: false }
  const text = [
    "The user asked about the site. Let me reason about what it actually is.",
    "结论：这是企业版 AI 工作台。",
  ].join("\n")
  const res = openclawResponse(payload, { text, model: payload.model })
  const obj = await res.json()
  const msg = obj.choices[0].message
  assert.match(msg.content, /结论：这是企业版 AI 工作台/)
  assert.doesNotMatch(msg.content, /Let me reason/)
  assert.match(msg.reasoning_content, /Let me reason/)
})

test("openclawResponse（非流式）：纯中文回答不产生 reasoning_content", async () => {
  const payload = { model: "deepseek-v4-1-flash-261017", stream: false }
  const res = openclawResponse(payload, { text: "老板，都办好了。", model: payload.model })
  const obj = await res.json()
  assert.equal(obj.choices[0].message.reasoning_content, undefined)
  assert.equal(obj.choices[0].message.content, "老板，都办好了。")
})
