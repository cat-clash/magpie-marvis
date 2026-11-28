import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { titleRequestLocalResponse } = await import(
  pathToFileURL(join(HERE, "..", "src", "hooks", "loader.mjs")).href
)

const TITLE_SYS = "Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line."

test("0.9.12：标题请求被本地拦截，非流式返回短标题", async () => {
  const payload = {
    model: "group/qq",
    stream: false,
    messages: [
      { role: "system", content: TITLE_SYS },
      { role: "user", content: 'Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"恢复已删域名"}]' },
    ],
  }
  const res = titleRequestLocalResponse(JSON.stringify(payload))
  assert.ok(res, "标题请求应被拦截")
  const d = await res.json()
  assert.equal(d.choices[0].message.content, "恢复已删域名")
  assert.ok(!d.choices[0].message.content.includes("jailbreak"))
})

test("0.9.12：标题请求流式也被本地拦截", async () => {
  const payload = {
    model: "group/qq",
    stream: true,
    messages: [
      { role: "system", content: TITLE_SYS },
      { role: "user", content: '[{"seq":1,"text":"你好"}]' },
    ],
  }
  const res = titleRequestLocalResponse(payload)
  assert.ok(res)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let raw = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value, { stream: true })
  }
  assert.ok(raw.includes('"content":"你好"'))
  assert.ok(!raw.includes("jailbreak"))
})

test("0.9.12：普通对话请求不被拦截（返回 null）", () => {
  const payload = {
    model: "group/qq",
    messages: [{ role: "user", content: "帮我写个脚本" }],
  }
  assert.equal(titleRequestLocalResponse(payload), null)
})

test("0.9.12：空消息 / 非 JSON 输入安全返回", () => {
  assert.equal(titleRequestLocalResponse("not json"), null)
  assert.equal(titleRequestLocalResponse({}), null)
  assert.equal(titleRequestLocalResponse(null), null)
})
