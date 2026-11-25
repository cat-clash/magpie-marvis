// 微信登录引导页 —— 0.7.10 起主路径是「复制扫码链接 → 电脑上打开 → 手机微信扫」
//
// 历史：0.7.6 教「分享到微信 + 微信内打开」；0.7.8 改公众号网页授权（userinfo）；
// 0.7.9 改 snsapi_base。三次都被真机打回：Marvis 的 appid 是网站应用（只有
// snsapi_login），oauth2/authorize 在微信内一律 10005；qrconnect 只能出二维码页，
// 而微信已禁止长按/相册识别二维码 —— 所以二维码必须显示在**另一块屏幕**（电脑）上。
// 结论：微信没有 QQ mqqapi:// 那种带 URL 的 scheme，唯一可行链路就是
//   复制链接 → 电脑浏览器打开出二维码 → 手机微信扫 → 电脑跳 code → 整条粘回来。
// QQ 分支一个字节都不许变（doesNotMatch shareWx / wx-next-steps / 复制授权链接）。
//
// 跑法：node --test tests/wx-share.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { formPage, WECHAT_OPEN_HINT, mobileInstructions } from "../src/marvis/mobile-login.mjs"

const TOKEN = "0".repeat(32)
const WX_AUTH_URL =
  "https://open.weixin.qq.com/connect/qrconnect?appid=wxTESTAPPID&redirect_uri=https%3A%2F%2Fyybadaccess.3g.qq.com%2Fmarvis_client_login%2Fmarvis_oauth%3Flogin_type%3DWX&response_type=code&scope=snsapi_login&state=" +
  "8".repeat(32)
const WX_WEB_URL =
  "https://open.weixin.qq.com/connect/oauth2/authorize?appid=wxTESTAPPID&redirect_uri=https%3A%2F%2Fyybadaccess.3g.qq.com%2Fmarvis_client_login%2Fmarvis_oauth%3Flogin_type%3DWX&response_type=code&scope=snsapi_base&state=" +
  "8".repeat(32) +
  "#wechat_redirect"
const QQ_AUTH_URL = "https://graph.qq.com/oauth2.0/authorize?display=mobile&client_id=1903794758"

const wxHtml = formPage({ loginType: "WX", token: TOKEN, authorizeUrl: WX_AUTH_URL, webAuthUrl: WX_WEB_URL })
const qqHtml = formPage({ loginType: "QC", token: TOKEN, authorizeUrl: QQ_AUTH_URL })

// ── 微信页：主按钮是「复制授权链接」 ──────────────────────────────────

test("微信页：主按钮是「复制授权链接（粘贴到电脑浏览器打开）」+ copyWxMain 脚本", () => {
  assert.match(wxHtml, /id="wx-copy-main"/, "主按钮要有稳定 id")
  assert.match(wxHtml, /复制授权链接（粘贴到电脑浏览器打开）/, "文案必须说清链接拿去电脑用")
  assert.match(wxHtml, /onclick="return copyWxMain\(\)"/, "主按钮要挂复制脚本")
  assert.match(wxHtml, /function copyWxMain\(/, "copyWxMain 脚本本体必须在页面里")
  assert.match(wxHtml, /getElementById\('wx-auth-url'\)/, "复制的必须是页面上回显的那条链接")
})

test("微信页：不再放 weixin:// 主链接（唤起微信对扫码没帮助）", () => {
  assert.doesNotMatch(wxHtml, /href="weixin:\/\//, "0.7.10 起微信页没有 weixin:// 主链接")
  assert.doesNotMatch(wxHtml, /onclick="return copyAndGo\(\)"/, "唤起微信+顺手复制那套已不是主路径")
  assert.doesNotMatch(wxHtml, /mqqapi:\/\//, "微信页不该用 QQ 的 scheme")
})

test("微信页：「分享到微信（可选）」保留为次按钮，shareWx 仍在", () => {
  assert.match(wxHtml, /分享到微信（可选）/, "分享降为可选路径")
  assert.match(wxHtml, /onclick="return shareWx\(\)"/)
  assert.match(wxHtml, /function shareWx\(/)
  assert.match(wxHtml, /navigator\.share/)
})

test("shareWx：载荷提示「在电脑浏览器打开、手机微信扫」", () => {
  const fn = /function shareWx\(\)\{[\s\S]*?\n\}/.exec(wxHtml)?.[0]
  assert.ok(fn, "必须能抠出 shareWx 函数本体")
  assert.match(fn, /getElementById\('wx-auth-url'\)/, "authUrl 必须从现有输入框读，不重新拼 URL")
  assert.match(fn, /navigator\.share\(\{/)
  assert.match(fn, /title:'Marvis 微信授权'/)
  assert.match(fn, /在电脑浏览器里打开这条链接/, "分享文案要说清接收方在电脑上打开")
  assert.match(fn, /url:authUrl/)
})

test("shareWx：失败回退复制，不支持分享时也回退复制（不再唤起微信）", () => {
  const fn = /function shareWx\(\)\{[\s\S]*?\n\}/.exec(wxHtml)?.[0]
  assert.ok(fn)
  assert.match(fn, /copyWxUrl\(\)/, "分享失败（用户取消等）要静默回退到复制")
  assert.match(fn, /copyWxMain\(\)/, "不支持分享时的回退也是复制")
  assert.doesNotMatch(fn, /window\.location\.href='weixin:\/\//, "不再跳到 weixin://（微信内打开扫码页没用）")
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

test("微信页：步骤块是 4 步，覆盖「电脑出码 → 手机扫 → 粘 code」全链路", () => {
  const block = /<div id="wx-next-steps"[\s\S]*?<\/div>/.exec(wxHtml)?.[0]
  assert.ok(block)
  assert.match(block, /<ol>/)
  assert.equal((block.match(/<li>/g) || []).length, 4, "必须是 4 步")
  for (const kw of [
    "复制授权链接",
    "电脑",
    "二维码",
    "扫一扫",
    "确认登录",
    "yybadaccess",
    "粘贴",
    "另一台设备",
    "不要保存二维码图片",
  ]) {
    assert.match(block, new RegExp(kw), `步骤块必须提到「${kw}」`)
  }
})

// ── 微信页：链接本体 + 实验链接 ────────────────────────────────────────

test("微信页：主输入框回显扫码页（qrconnect），10005 应对写明", () => {
  assert.match(
    wxHtml,
    /id="wx-auth-url"[^>]*value="https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/,
    "主授权框回显网站应用扫码登录地址",
  )
  assert.match(wxHtml, /scope=snsapi_login/, "扫码页 scope 必须是 snsapi_login")
  assert.doesNotMatch(
    wxHtml,
    /id="wx-auth-url"[^>]*value="https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/,
    "主授权框不许回显网页授权",
  )
  assert.match(wxHtml, /10005/, "必须写明 10005 这个真实错误码")
})

test("微信页：实验链接单独一栏、标注对 Marvis appid 无效、灰底", () => {
  assert.match(wxHtml, /id="wx-web-url"/, "实验链接要有独立 id")
  assert.match(wxHtml, /value="https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/, "实验链接是网页授权")
  assert.match(wxHtml, /对 Marvis 的 appid 无效/, "必须标清无效")
  const webBlock = /<input[^>]*id="wx-web-url"[^>]*>/.exec(wxHtml)?.[0]
  assert.ok(webBlock)
  assert.match(webBlock, /background:#f0f1f3/, "实验链接框要弱化成灰底")
})

test("微信页：复制兜底仍在，但不再放粘贴框（0.7.12）", () => {
  assert.match(wxHtml, /function copyWxUrl\(/)
  assert.match(wxHtml, /id="wx-copy-btn"/)
  assert.match(wxHtml, /getElementById\('wx-copy-btn'\)/, "「已复制 ✓」回写按 id 定位")
  assert.match(wxHtml, /一台手机扫不了自己的码/)
  // 0.7.12：本机引导页只给链接和步骤；粘贴统一回 magpie 的 Code 输入框
  assert.doesNotMatch(wxHtml, /<textarea/, "本机引导页不再放粘贴框")
  assert.doesNotMatch(wxHtml, /name="callback"/)
  assert.match(wxHtml, /不接收/, "必须明说这一侧不收粘贴")
})

test("微信页：带 error 重渲染时主按钮与步骤块仍在（可重试）", () => {
  const html = formPage({ loginType: "WX", token: TOKEN, error: "测试错误", authorizeUrl: WX_AUTH_URL, webAuthUrl: WX_WEB_URL })
  assert.match(html, /测试错误/)
  assert.match(html, /复制授权链接（粘贴到电脑浏览器打开）/)
  assert.match(html, /function copyWxMain\(/)
  assert.match(html, /id="wx-next-steps"/)
})

// ── QQ 页：一个字节都不许沾微信那套 ───────────────────────────────────

test("QQ 页：不出现 shareWx / wx-next-steps / 复制授权链接，mqqapi 唤起仍在", () => {
  assert.doesNotMatch(qqHtml, /shareWx/)
  assert.doesNotMatch(qqHtml, /wx-next-steps/)
  assert.doesNotMatch(qqHtml, /分享到微信/)
  assert.doesNotMatch(qqHtml, /navigator\.share/)
  assert.doesNotMatch(qqHtml, /复制授权链接/)
  assert.match(qqHtml, /mqqapi:\/\/forward\/url/, "QQ 仍走 mqqapi 唤起")
})

// ── 文案：WECHAT_OPEN_HINT / mobileInstructions ────────────────────────

test("WECHAT_OPEN_HINT：扫码要另一台设备、不要保存图片、10005 说明、实验链接无效", () => {
  assert.match(WECHAT_OPEN_HINT, /复制授权链接/)
  assert.match(WECHAT_OPEN_HINT, /另一台设备/)
  assert.match(WECHAT_OPEN_HINT, /二维码/)
  assert.match(WECHAT_OPEN_HINT, /不要.*二维码/)
  assert.match(WECHAT_OPEN_HINT, /一台手机扫不了自己的码/)
  assert.match(WECHAT_OPEN_HINT, /10005/, "必须写明 10005")
  assert.match(WECHAT_OPEN_HINT, /对 Marvis 的 appid 无效/, "必须点明实验链接无效")
  assert.ok(
    WECHAT_OPEN_HINT.indexOf("复制授权链接") < WECHAT_OPEN_HINT.indexOf("分享到微信"),
    "主路径必须先是复制链接",
  )
})

test("mobileInstructions(WX)：7 步，第 1 步是复制链接、第 3 步是手机微信扫", () => {
  const s = mobileInstructions("WX")
  const lines = s.split("\n")
  assert.equal(lines.length, 7, "现在是 7 步")
  assert.match(lines[0], /复制授权链接/, "首选路径放第 1 步")
  assert.match(lines[0], /另一台设备/)
  assert.match(lines[1], /二维码/)
  assert.match(lines[2], /扫一扫/)
  assert.match(lines[3], /code=/)
  assert.match(lines[4], /粘贴/)
  assert.match(lines[5], /不要保存二维码图片/)
  assert.match(lines[6], /10005/)
  assert.doesNotMatch(s, /识别图中二维码/)
})

test("mobileInstructions(QC)：不受微信改动影响", () => {
  const s = mobileInstructions("QC")
  assert.doesNotMatch(s, /分享到微信/)
  assert.doesNotMatch(s, /shareWx/)
  assert.match(s, /手机 QQ/)
})