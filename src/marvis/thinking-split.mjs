// thinking-split.mjs — 把 PC agent 混在正文里的英文「思考」段切出来（0.9.13）
//
// 背景：走 WS relay（PC 客户端 agent.run，ws://127.0.0.1:10123）时，PC agent 把自己的
// 推理、重试、最终回答**拼进同一个 text 流**，没有独立的 REASONING_* 事件，也没有
// reasoning_content 字段。客户端收到就是普通正文，于是满屏英文「让我先想想……」。
//
// 本模块只做一件保守的事：按**行**分类，把「几乎不含中文的英文思考行」移到
// reasoning_content（客户端会自动折叠、不占正文），中文行一律原样保留在 content。
//
// 保守性（宁可漏切，不可误伤）：
//   1. 行内必须命中英文思考句式开头（The user / I should / Let me / Hmm …）
//   2. 行内中文字符占比 < 5%
//   3. 英文词数 >= 12
//   三条同时满足才判为思考。任何含中文正文的行（哪怕夹着英文）都留给正文。
//
// 重复的思考行（PC agent 重试时会叠两遍）按前 140 字去重，只留一次。
//
// 流式实时性（0.9.13 修正）：一旦某段已被判定为中文正文，splitter 立即进入
// 「直通」状态，之后每个 delta 原样放行 —— 不会因为等换行把整段回复憋到最后。

/** 英文思考句的固定开头（PC agent 的推理总是以这些句式起头）。 */
const THINK_HEAD =
  /^(The user|The query|The request|I |I'm|I'll|I've|I need|I should|I must|Let me|Let's|But |Now,|Then |Given the|Actually|Also |So |Wait|OK\b|Good\b|Fine\b|Keep it|Don't reveal|No |Maybe|Per |This |That |These |There |It |Hmm|However|Note that|We |First,|Next,|Finally|Quick |Also,)/

/**
 * 判断一行是「思考」还是「正文」。
 * @param {string} line
 * @returns {"reasoning"|"content"|"blank"}
 */
export function classifyLine(line) {
  const t = String(line ?? "").trim()
  if (!t) return "blank"
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
  if (!THINK_HEAD.test(t)) return "content"
  const words = (t.match(/[A-Za-z][A-Za-z'-]*/g) || []).length
  const cjkRatio = cjk / Math.max(1, t.length)
  if (cjk === 0 && words >= 8) return "reasoning"
  if (cjkRatio < 0.05 && words >= 12) return "reasoning"
  return "content"
}

/**
 * 流式行切分器：喂 delta，吐出已判定完整的行；末尾余量由 flush() 收尾。
 * 重复的思考行只保留第一次。进入正文后转为直通，保证流式实时性。
 */
export function createLineSplitter() {
  let buf = ""
  let opened = false
  const seen = new Set()

  const take = (line) => {
    const kind = classifyLine(line)
    if (kind === "reasoning") {
      const key = line.trim().slice(0, 140)
      if (seen.has(key)) return null
      seen.add(key)
      return { kind: "reasoning", text: line }
    }
    if (kind === "blank") return { kind: "blank", text: line }
    return { kind: "content", text: line }
  }

  return {
    /**
     * @param {string} delta
     * @returns {{kind:"reasoning"|"content"|"blank", text:string}[]}
     */
    feed(delta) {
      const d = String(delta ?? "")
      if (!d) return []
      // 已进入正文：之后一律直通（不再缓冲、不再判定）
      if (opened) return [{ kind: "content", text: d }]

      buf += d
      const out = []
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx + 1)
        buf = buf.slice(idx + 1)
        const r = take(line)
        if (r) out.push(r)
        if (r && r.kind === "content") {
          // 见到正文即转直通：把缓冲里剩下的半行一起放出去
          opened = true
          if (buf) {
            out.push({ kind: "content", text: buf })
            buf = ""
          }
          return out
        }
      }
      // 没有换行，但缓冲里已经有中文、且整段不像思考行 → 提前放行，保住流式观感。
      // ⚠ 必须含中文才放行：纯英文半行（"The user wants me to…"）要继续等换行，
      //   否则思考行的前半段会因为词数不够被判成正文而直通出去。
      if (buf && /[\u4e00-\u9fff]/.test(buf) && classifyLine(buf) === "content") {
        out.push({ kind: "content", text: buf })
        buf = ""
        opened = true
      }
      return out
    },
    /** 收尾：把缓冲里剩余的不完整行也判一次。 */
    flush() {
      if (!buf) return []
      const line = buf
      buf = ""
      if (opened) return [{ kind: "content", text: line }]
      const r = take(line)
      return r ? [r] : []
    },
  }
}

/**
 * 非流式：整段文本一次切分。
 * @param {string} text
 * @returns {{content:string, reasoning:string, dupDropped:number}}
 */
export function splitFullText(text) {
  const lines = String(text ?? "").split("\n")
  const reasoning = []
  const content = []
  const seen = new Set()
  let dupDropped = 0
  for (const line of lines) {
    if (classifyLine(line) === "reasoning") {
      const key = line.trim().slice(0, 140)
      if (seen.has(key)) {
        dupDropped++
        continue
      }
      seen.add(key)
      reasoning.push(line)
    } else {
      content.push(line)
    }
  }
  const contentText = content.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  const reasoningText = reasoning.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  // 兜底（防误伤）：如果切完正文一个字符都不剩，说明整段都被判成思考 ——
  // 那多半是「全文英文的回答」被误切，宁可整段还给正文，也不能给出空回答。
  if (!contentText && reasoningText) {
    return { content: reasoningText, reasoning: "", dupDropped }
  }
  return {
    content: contentText,
    reasoning: reasoningText,
    dupDropped,
  }
}
