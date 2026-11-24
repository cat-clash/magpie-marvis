// 微信「分享到微信」主路径 —— formPage 微信分支的离线测试
//
// 背景：微信没有 QQ mqqapi://forward/url 那种「带 URL 唤起 App」的 scheme，
// weixin:// 只能唤起微信本体，用户反馈「仅仅是调用了微信 就没有后续了」。
// 修复：① navigator.share 系统分享面板直接把授权链接发进微信（首选主按钮）；
//       ② 初始就可见的后续步骤块 wx-next-steps；③ 复制 + 唤起全套保留作回退。
// QQ 分支一个字节都不许变（doesNotMatch shareWx / wx-next-steps）。
//
// 跑法：node --test tests/wx-share.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { formPage, WECHAT_OPEN_HINT, mobileInstructions } from "../src/marvis/mobile-login.mjs"

const TOKEN = "0".repeat(32)
const WX_AUTH_URL =
  "https://open.weixin.qq.com/connect/qrconnect?appid=wxTESTAPPID&redirect_uri=https%3A%2F%2Fyybadaccess.3g.qq.com%2Fmarvis_client_login%2Fmarvis_oauth&response_type=code&scope=snsapi_login&state=" +
  "8".repeat(32)
const QQ_AUTH_URL = "https://graph.qq.com/oauth2.0/authorize?display=mobile&client_id=1903794758"

const wxHtml = formPage({ loginType: "WX", token: TOKEN, authorizeUrl: WX_AUTH_URL })
const qqHtml = formPage({ loginType: "QC", token: TOKEN, authorizeUrl: QQ_AUTH_URL })

// ── 微信页：分享主路径 ─────────────────────────────────────────────────

test("微信页：有「分享到微信（推荐）」主按钮 + shareWx 脚本 + navigator.share", () => {
  assert.match(wxHtml, /分享到微信/)
  assert.match(wxHtml, /分享到微信（推荐）/)
  assert.match(wxHtml, /onclick="return shareWx\(\)"/, "分享按钮必须挂上脚本，不能只是文案")
  assert.match(wxHtml, /function shareWx\(/, "shareWx 脚本本体必须在页面里")
  assert.match(wxHtml, /navigator\.share/)
})

test("微信页：分享按钮在唤起微信按钮之前（首选路径）", () => {
  const shareAt = wxHtml.indexOf('return shareWx()')
  const launchAt = wxHtml.indexOf('href="weixin://')
  assert.ok(shareAt >= 0 && launchAt >= 0)
  assert.ok(shareAt < launchAt, "「分享到微信」必须排在 weixin:// 唤起按钮之前/之上")
})

test("shareWx：authUrl 读 wx-auth-url 输入框，分享载荷带 title/text/url", () => {
  const fn = /function shareWx\(\)\{[\s\S]*?\n\}/.exec(wxHtml)?.[0]
  assert.ok(fn, "必须能抠出 shareWx 函数本体")
  assert.match(fn, /getElementById\('wx-auth-url'\)/, "authUrl 必须从现有输入框读，不重新拼 URL")
  assert.match(fn, /navigator\.share\(\{/)
  assert.match(fn, /title:'Marvis 微信授权'/)
  assert.match(fn, /点「允许」完成授权/)
  assert.match(fn, /url:authUrl/)
})

test("shareWx：失败回退 copyWxUrl，不支持分享时回退 copyAndGo + weixin://", () => {
  const fn = /function shareWx\(\)\{[\s\S]*?\n\}/.exec(wxHtml)?.[0]
  assert.ok(fn)
  assert.match(fn, /copyWxUrl\(\)/, "分享失败（用户取消等）要静默回退到复制")
  assert.match(fn, /copyAndGo\(\)/, "navigator.share 不可用时要走复制+唤起那套")
  assert.match(fn, /weixin:\/\//, "回退路径要真的唤起微信")
  assert.match(wxHtml, /id="wx-share-status"/, "回退提示要有落点")
})

// ── 微信页：后续步骤块 ─────────────────────────────────────────────────

test("微信页：wx-next-steps 初始就可见（不藏起来）", () => {
  assert.match(wxHtml, /id="wx-next-steps"/)
  const tag = /<div id="wx-next-steps"[^>]*>/.exec(wxHtml)?.[0]
  assert.ok(tag)
  assert.doesNotMatch(tag, /hidden/, "步骤块不许带 hidden")
  assert.doesNotMatch(tag, /display:\s*none/, "步骤块不许初始隐藏")
})

test("微信页：步骤块是 4 步 ordered list，覆盖分享到登录全链路", () => {
  const block = /<div id="wx-next-steps"[\s\S]*?<\/div>/.exec(wxHtml)?.[0]
  assert.ok(block)
  assert.match(block, /<ol>/)
  assert.equal((block.match(/<li>/g) || []).length, 4, "必须是 4 步")
  for (const kw of [
    "分享到微信",
    "文件传输助手",
    "确认授权",
    "允许",
    "右上角",
    "复制链接",
    "Code 输入框",
    "不要保存二维码图片扫码",
  ]) {
    assert.match(block, new RegExp(kw), `步骤块必须提到「${kw}」`)
  }
  // 唤起微信那条回退路也要在步骤里说清楚
  assert.match(block, /唤起微信/)
  assert.match(block, /复制授权链接/)
})

// ── 微信页：既有回退一个不删 ───────────────────────────────────────────

test("微信页：weixin:// 唤起、copyWxUrl、copyAndGo、wx-copy-btn、系统浏览器兜底全保留", () => {
  assert.match(wxHtml, /href="weixin:\/\//)
  assert.match(wxHtml, /onclick="return copyAndGo\(\)"/)
  assert.match(wxHtml, /function copyAndGo\(/)
  assert.match(wxHtml, /function copyWxUrl\(/)
  assert.match(wxHtml, /onclick="copyWxUrl\(\)"/)
  assert.match(wxHtml, /id="wx-copy-btn"/)
  assert.match(wxHtml, /<input[^>]*id="wx-auth-url"/)
  assert.match(wxHtml, /备用：用系统浏览器打开授权页/)
  assert.match(wxHtml, /一台手机扫不了自己的码/)
  assert.match(wxHtml, /点下面的按钮唤起微信/, "第 1 步备用文案必须与 weixin:// 按钮真实行为一致")
  assert.match(wxHtml, /同时把授权链接复制到剪贴板/)
  assert.match(wxHtml, /<textarea/, "粘贴框仍在")
})

test("微信页：带 error 重渲染时分享主路径与步骤块仍在（可重试）", () => {
  const html = formPage({ loginType: "WX", token: TOKEN, error: "测试错误", authorizeUrl: WX_AUTH_URL })
  assert.match(html, /测试错误/)
  assert.match(html, /分享到微信（推荐）/)
  assert.match(html, /function shareWx\(/)
  assert.match(html, /id="wx-next-steps"/)
})

// ── QQ 页：一个字节都不许沾微信分享 ───────────────────────────────────

test("QQ 页：不出现 shareWx / wx-next-steps / 分享到微信，mqqapi 唤起仍在", () => {
  assert.doesNotMatch(qqHtml, /shareWx/)
  assert.doesNotMatch(qqHtml, /wx-next-steps/)
  assert.doesNotMatch(qqHtml, /分享到微信/)
  assert.doesNotMatch(qqHtml, /navigator\.share/)
  assert.match(qqHtml, /mqqapi:\/\/forward\/url/, "QQ 仍走 mqqapi 唤起")
})

// ── 文案：WECHAT_OPEN_HINT / mobileInstructions ────────────────────────

test("WECHAT_OPEN_HINT：分享列为首选，旧关键词（唤起微信/复制授权链接/不要二维码/允许）全保留", () => {
  assert.match(WECHAT_OPEN_HINT, /分享到微信/)
  assert.match(WECHAT_OPEN_HINT, /唤起微信/)
  assert.match(WECHAT_OPEN_HINT, /复制授权链接/)
  assert.match(WECHAT_OPEN_HINT, /不要.*二维码/)
  assert.match(WECHAT_OPEN_HINT, /一台手机扫不了自己的码/)
  assert.match(WECHAT_OPEN_HINT, /确认授权/)
  assert.match(WECHAT_OPEN_HINT, /允许/)
  // 首选必须是分享：分享要出现在「备用」之前
  assert.ok(WECHAT_OPEN_HINT.indexOf("分享到微信") < WECHAT_OPEN_HINT.indexOf("备用"))
})

test("mobileInstructions(WX)：5 步结构不变，第 1 步是分享，旧关键词全保留", () => {
  const s = mobileInstructions("WX")
  const lines = s.split("\n")
  assert.equal(lines.length, 5, "必须仍是 5 步")
  assert.match(lines[0], /分享到微信/, "首选路径放第 1 步")
  assert.match(s, /唤起微信/)
  assert.match(s, /复制授权链接/)
  assert.match(s, /不要.*二维码/)
  assert.match(s, /允许/)
  assert.match(s, /地址栏/)
  assert.match(s, /粘贴/)
  assert.doesNotMatch(s, /识别图中二维码/)
})

test("mobileInstructions(QC)：不受微信改动影响", () => {
  const s = mobileInstructions("QC")
  assert.doesNotMatch(s, /分享到微信/)
  assert.doesNotMatch(s, /shareWx/)
  assert.match(s, /手机 QQ/)
})
