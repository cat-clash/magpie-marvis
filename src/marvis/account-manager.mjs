// 手机端「账号管理」登录入口 —— 在 magpie 壳里取消登录 / 移除任意账号
//
// ═══ 为什么做成一个登录入口 ═══════════════════════════════════════════
// 壳的账号卡片对「首选」账号不渲染移除按钮（用户截图：第 1 个账号没有移除、
// 第 2 个才有），这是壳侧 UI 行为，插件的 auth 钩子协议里没有 remove/logout
// 扩展点能改它。但壳**一定**会渲染登录方法列表 —— 所以把账号管理做成一个
// type:"oauth" 的方法：点它 → authorize() 起一个本机管理页 → 壳显示
// 「打开浏览器」按钮 → 用户在页面上对**每一个**账号（包括首选）点
// 「取消登录」或「移除」。数据层与 scripts/accounts.mjs 共用
// src/marvis/accounts-store.mjs 的同一套规矩（备份 + 乐观并发 + 原子写）。
//
// ═══ 协议形态（与 mobile-login.mjs 的实测结论一致）═══════════════════
//   method:"code" + opened:false → 壳渲染「打开浏览器」按钮 + 输入框。
//   管理操作在页面上完成，不需要用户粘贴任何东西；callback() 只在用户
//   放弃/超时/取消时收尾（释放端口），永远不返回登录成功。
//
// ⚠ 页面只绑 127.0.0.1 + 一次性 token（CSRF），与登录页同一套防线。
// ⚠ 写盘失败（壳并发写）→ 页面显示可读错误，原文件不动；提示完全退出 magpie 重试。

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

import {
  configDir,
  readAuthFile,
  entries,
  accountRow,
  resolveTargets,
  applyLogout,
  applyRemove,
} from "./accounts-store.mjs"

/** 管理页默认端口（与登录页 4618 错开）；被占用自动退随机端口 */
export const DEFAULT_MANAGER_PORT = 4619

/** 用户在页面上操作的时间窗：10 分钟，与登录页一致 */
export const DEFAULT_MANAGER_TIMEOUT_MS = 10 * 60_000

const MAX_BODY = 64 * 1024

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<style>
  :root{color-scheme:light dark}
  html,body{margin:0;padding:0;background:#f6f7f9;color:#1a1a1a;
    font:16px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  @media (prefers-color-scheme:dark){html,body{background:#111315;color:#e8eaed}}
  .wrap{max-width:560px;margin:0 auto;padding:20px 18px 40px}
  h1{font-size:19px;margin:8px 0 14px;font-weight:600}
  p{margin:10px 0;font-size:15px}
  .muted{color:#6b7280;font-size:13px}
  @media (prefers-color-scheme:dark){.muted{color:#9aa2ae}}
  .card{border:1px solid #d5d9de;border-radius:12px;padding:14px;margin:12px 0;background:#fff}
  @media (prefers-color-scheme:dark){.card{background:#1b1e21;border-color:#33383d}}
  .name{font-weight:600;font-size:16px}
  .meta{color:#6b7280;font-size:12px;word-break:break-all;margin:4px 0}
  @media (prefers-color-scheme:dark){.meta{color:#9aa2ae}}
  .state{font-size:13px;margin:4px 0}
  form{display:inline}
  button{padding:10px 14px;border:0;border-radius:8px;font-size:14px;font-weight:600;margin:6px 8px 0 0}
  button.logout{background:#1677ff;color:#fff}
  button.remove{background:#c0392b;color:#fff}
  button:active{opacity:.8}
  .ok{color:#0a7d33;font-weight:600}
  .bad{color:#c0392b;font-weight:600}
  code{background:#eceff2;padding:1px 5px;border-radius:4px;font-size:13px}
  @media (prefers-color-scheme:dark){code{background:#262a2e}}
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`
}

/**
 * 管理页正文：每个账号一张卡，两个动作按钮（取消登录 / 移除）。
 * 首选账号也一样有按钮 —— 这正是壳 UI 缺的那块。
 */
export function managerPage({ token, rows, file, notice, error }) {
  const note = notice ? `<p class="ok">${esc(notice)}</p>` : ""
  const err = error ? `<p class="bad">${esc(error)}</p>` : ""
  const cards = rows
    .map((r) => {
      const name = r.accountId || r.nickname || r.key
      return `<div class="card">
  <div class="name">${esc(name)} <span class="muted">（${esc(r.loginType)}）</span></div>
  <div class="meta">key=${esc(r.key)} · uid=${esc(r.uid || "-")}</div>
  <div class="state">状态：${esc(r.state)}</div>
  <form method="post" action="/action">
    <input type="hidden" name="t" value="${esc(token)}">
    <input type="hidden" name="key" value="${esc(r.key)}">
    <input type="hidden" name="op" value="logout">
    <button type="submit" class="logout">取消登录</button>
  </form>
  <form method="post" action="/action" onsubmit="return confirm('确定移除账号「${esc(name)}」？移除=删除本地凭据，需重新登录才能再用。')">
    <input type="hidden" name="t" value="${esc(token)}">
    <input type="hidden" name="key" value="${esc(r.key)}">
    <input type="hidden" name="op" value="remove">
    <button type="submit" class="remove">移除</button>
  </form>
</div>`
    })
    .join("\n")
  const empty = rows.length === 0 ? `<p class="muted">（本插件还没有账号条目。先在 magpie 里登录一个账号再来管理。）</p>` : ""
  return page(
    "账号管理 · 腾讯 Marvis",
    `<h1>账号管理（取消登录 / 移除）</h1>
${note}${err}
<p class="muted">这里对**每一个**账号都提供「取消登录」和「移除」——包括 magpie 卡片上没有移除按钮的首选账号。
取消登录=清凭据保留卡片（重新登录可复用）；移除=整条删除。每次写盘前自动备份。</p>
${cards}
${empty}
<p class="muted">账号文件：<code>${esc(file)}</code></p>
<p class="muted">⚠ 操作后请**完全退出并重启 magpie** 再看账号列表（壳有内存态）。若提示「文件被同时改写」，先完全退出 magpie 再重试。</p>
<p class="muted">这个页面只在本机 127.0.0.1 上，内容不会发到别处。</p>`,
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

/**
 * 起本机账号管理页。
 *
 * @param {{ dir?: string, port?: number, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function startAccountManager({
  dir,
  port = DEFAULT_MANAGER_PORT,
  timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS,
  signal,
} = {}) {
  const configDirectory = configDir(dir)
  const token = randomBytes(16).toString("hex")

  // 页面渲染那一刻的账号快照 = 并发检查的基线（POST 时不重读，见 /action 注释）
  let pageSnapshot = null

  const render = (res, status, { notice, error } = {}) => {
    let rows = []
    let file = `${configDirectory}/plugin-auth.json`
    let loadError = error
    try {
      const loaded = readAuthFile(configDirectory)
      file = loaded.file
      if (loaded.json === null) {
        loadError = loadError || `没有找到 ${file}（magpie 还没写过账号，或配置目录不对）。`
        pageSnapshot = null
      } else {
        rows = entries(loaded.json).map(accountRow)
        pageSnapshot = loaded
      }
    } catch (err) {
      loadError = `读取账号文件失败：${String(err?.message ?? err)}`
      pageSnapshot = null
    }
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
    })
    res.end(managerPage({ token, rows, file, notice, error: loadError }))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    if (url.pathname === "/" && req.method === "GET") return render(res, 200)
    if (url.pathname !== "/action" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
      return res.end(page("404", "<h1>没有这个页面</h1>"))
    }

    let body = ""
    try {
      body = await readBody(req)
    } catch (err) {
      return render(res, 413, { error: String(err?.message ?? err) })
    }
    const form = new URLSearchParams(body)
    if (form.get("t") !== token) {
      return render(res, 403, { error: "这个页面已经失效，请回 magpie 重新点一次「账号管理」。" })
    }
    const key = String(form.get("key") ?? "")
    const op = String(form.get("op") ?? "")
    if (op !== "logout" && op !== "remove") return render(res, 400, { error: `不认识的操作：${op}` })

    try {
      // ⚠ 并发基线用「页面渲染那一刻」的快照，不是 POST 时重读：
      //   壳在用户看页面期间写回了文件（刷新 token 等），必须在这里被发现并 409，
      //   而不是拿新文件当基线把壳的改动悄悄覆盖掉。
      const baseline = pageSnapshot
      if (!baseline || baseline.json === null) {
        return render(res, 400, { error: `没有找到 ${configDirectory}/plugin-auth.json，没有可管理的账号。` })
      }
      const { file, json } = baseline
      // ⚠ 只认整键：页面上的按钮带的就是 key，不做模糊匹配，杜绝误删
      const { matched } = resolveTargets(json, { selector: key })
      const exact = matched.filter((e) => e.key === key)
      if (exact.length !== 1) return render(res, 400, { error: `账号 ${key} 不存在（可能刚被别处移除），请刷新页面。` })
      if (op === "logout") {
        const r = applyLogout({ file, json, matched: exact })
        return render(res, 200, {
          notice:
            r.count > 0
              ? `✓ 已取消登录：${key}（备份 ${r.backup}）。请完全退出并重启 magpie。`
              : `该账号已是取消登录状态，未做修改。`,
        })
      }
      const r = applyRemove({ file, json, matched: exact })
      return render(res, 200, { notice: `✓ 已移除：${r.accountId || key}（备份 ${r.backup}）。请完全退出并重启 magpie。` })
    } catch (err) {
      return render(res, 409, { error: String(err?.message ?? err) })
    }
  })

  await new Promise((resolve, reject) => {
    const onErr = (err) => {
      if (err?.code === "EADDRINUSE" && port !== 0) {
        server.removeListener("error", onErr)
        server.listen(0, "127.0.0.1", resolve)
        return
      }
      reject(err)
    }
    server.once("error", onErr)
    // ⚠ 只绑 127.0.0.1：这个口子能删账号，绝不能暴露到局域网
    server.listen(port, "127.0.0.1", resolve)
  })

  const actualPort = server.address()?.port
  // 监听句柄不保活：没人点的管理页不该让宿主进程无法退出（与登录页同一课）
  server.unref?.()
  const pageUrl = `http://127.0.0.1:${actualPort}/`

  const timer = setTimeout(() => close(), timeoutMs)
  timer.unref?.()

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    try {
      server.close()
      server.closeIdleConnections?.()
    } catch {
      /* 已经关了 */
    }
  }

  if (signal) {
    if (signal.aborted) close()
    else signal.addEventListener("abort", close, { once: true })
  }

  return { url: pageUrl, close }
}

/**
 * 登录方法形状：点「账号管理」→ 壳给「打开浏览器」按钮 → 本机管理页。
 * callback 不产生账号：用户操作完直接关页面；这里只负责收尾与可读提示。
 *
 * @param {{ startManager?: typeof startAccountManager, dir?: string, timeoutMs?: number }} [opts]
 */
export function accountManagerMethod({ startManager = startAccountManager, dir, timeoutMs = DEFAULT_MANAGER_TIMEOUT_MS } = {}) {
  return {
    type: "oauth",
    label: "账号管理（取消登录 / 移除账号）",
    async authorize() {
      const mgr = await startManager({ dir, timeoutMs })
      return {
        url: mgr.url,
        opened: false,
        method: "code",
        instructions: [
          "这不是登录，是账号管理：点「打开浏览器」打开本机管理页。",
          `管理页地址（壳没弹按钮时手动复制到手机浏览器）：${mgr.url}`,
          "页面上每个账号都有「取消登录」和「移除」按钮 —— 包括 magpie 卡片上没有移除按钮的首选账号。",
          "取消登录=清凭据保留卡片（重新登录可复用）；移除=整条删除。每次写盘前自动备份。",
          "操作完成后**完全退出并重启 magpie** 再看账号列表（壳有内存态）。",
          "管理完直接关掉页面即可，不需要在下面的输入框里粘贴任何东西。",
        ].join("\n"),
        async callback(_a, _b, signal) {
          if (signal) {
            if (signal.aborted) mgr.close()
            else signal.addEventListener("abort", () => mgr.close(), { once: true })
          }
          mgr.close()
          throw new Error(
            "「账号管理」不是登录入口：请在管理页上完成取消登录/移除后直接关掉页面，" +
              "然后完全退出并重启 magpie 查看效果。",
          )
        },
        async cancel() {
          try {
            mgr.close()
          } catch {
            /* 已经关了 */
          }
        },
      }
    },
  }
}