// 手机端登录 —— 为什么手机点 QQ / 微信登录会「没地方粘贴 / 入口不见了」
//
// ═══ 宿主契约（2026-11-24 实测，探针插件 + `magpie plugin login`）════════
//
// 宿主怎么渲染一个 oauth 登录方法，取决于 authorize() 返回的三个字段：
//
//   { opened:false, method:"code" }
//     → 宿主渲染：授权页 URL + instructions + **「Code:」输入框**
//        （CLI 原文：「Sign in in your browser. If it didn't open, go to: <url>」
//          随后是一行「Code:」）
//   { opened:true,  method:"auto" }
//     → 宿主渲染：只有 URL + instructions，**没有「Code:」那一行**
//
// ⚠⚠ 上一版手机端用的正是第二种，于是用户点 QQ 登录只看到一段文字：
//   既没有粘贴框，也没有「打开浏览器」按钮 —— 就是截图里的样子。
//   现在手机端一律 method:"code" + 不设 opened:true，把这两个控件拿回来。
//
//   协议层（host bundle）：
//     `s.a.method === "code" ? s.a.callback(code ?? "", {signal}) : s.a.callback(undefined, {signal})`
//   用户在「Code:」框里输入的内容，会原样交给插件的 callback。
//
//   `opened` 的语义（宿主注释原文）：「a page the plugin's own CLI opened already」
//   —— true 表示插件自己已经打开过，宿主别再开一次（否则用户看到两个窗口）。
//   所以要让宿主给出「打开浏览器」按钮，就**不能**设 opened:true。
//
// ═══ 三个真实原因（缺一条都修不好）══════════════════════════════════
//
// 1. **微信授权页是 PC 扫码页，但扫码不是手机上的出路**
//    `open.weixin.qq.com/connect/qrconnect?scope=snsapi_login` 是「网站应用扫码登录」，
//    系统浏览器打开它只显示二维码 —— 需要**另一台设备**来扫；一台手机完成不了「扫自己的码」，
//    保存二维码图片再扫的链路微信已逐步收紧。
//    → 手机上的正确出路是**唤起微信 App，把授权链接在微信内置浏览器里打开**：微信内置
//      浏览器打开 qrconnect 链接时不会显示二维码，而是直接弹「确认授权」页（微信自己有
//      登录态）。所以 instructions 的核心动作是「唤起微信 + 复制链接到微信里打开」，
//      **不再教保存/识别二维码**。扫码只作为系统浏览器打开后的极端兜底。
//    ⚠ 微信没有 QQ 那种 `mqqapi://forward/url`（携带任意 URL 唤起 App 授权）的通用
//      scheme；`weixin://` 只能唤起微信本体，授权页地址要靠用户复制到微信里打开。
//
// 2. **QQ 授权页被 `display=pc` 钉死为 PC 版**
//    `graph.qq.com/oauth2.0/authorize?...&display=pc` 在手机浏览器里渲染 PC 布局的
//    账号密码表单，不会唤起手机 QQ App。
//    → 手机端用 `display=mobile`（login.mjs 的 mobile 分支）+ 真正能唤起 App 的
//      `mqqapi://forward/url` 跳转（见 qqAppLaunchUrl）。
//
// 3. **本地表单页是兜底，不是唯一入口**
//    壳的粘贴输入框未必在所有壳版本/包名下都可用（早期壳只给旧包名打过补丁）。
//    所以本模块还自带一个本地登录页（授权按钮 + 粘贴框），instructions 里给出它的地址，
//    输入框不在时用户照样能走通。页面上的 QQ 按钮用 mqqapi:// 唤起 App。
//
// ═══ 为什么是「本地表单页」而不是 loopback 回调 ═══════════════════════
// 别的插件（如 opencode-raccoon-auth）能把 `redirect_uri` 改成
// `http://127.0.0.1:<port>/auth/callback` 起 loopback 收回调。本插件**做不到**：
// Marvis 的 `redirect_uri` 在 QQ 互联里预注册死了，只能是
// `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth`（见 login.mjs 文件头）。
// 既然回调一定会落在那个 https 地址上，就只能让用户把地址栏那条 URL 带回来 ——
// 而「带回来」的入口，宿主（method:"code" 的「Code:」框）和本地页都提供。
//
// ═══ 时序 ═══════════════════════════════════════════════════════════
// 宿主调 `authorize()` → 我们返回 `{ url, method:"code", instructions, callback }`；
// 宿主调 `callback(code)` → 走「用户粘贴 → 带 guid 换登录态」。
// 本地页是并行兜底：页面提交时我们自己完成换取，结果同样回到宿主。

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

import { authorizeUrl, extractCode, stateOf, parseCallback, pastedInputOf } from "./login.mjs"

/** 本地表单页默认端口；被占用时自动退到随机端口 */
export const DEFAULT_PASTE_PORT = 4618

/** 用户从扫码到粘贴，给 10 分钟（比 CDP 那条路的 5 分钟宽，因为要跨 App 操作） */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** 表单 POST 体积上限 —— 回调地址最多几百字节，1MB 已经非常宽松 */
const MAX_BODY = 1024 * 1024

/**
 * 是否手机 / 安卓 magpie 壳环境。
 *
 * 多线索判断，任何一条命中即算手机端：
 *   · `process.platform === "android"` —— Termux / PRoot 里的 Node
 *   · `process.env.PREFIX` 含 `com.termux` —— Termux 固定注入
 *   · 存在 `/data/data/com.termux` —— 兜底（被注入 env 被清掉时）
 *   · magpie 安卓壳注入的平台变量（MAGPIE_PLATFORM / MAGPIE_APP 等，见壳版本差异）
 *   · 有 `ANDROID_ROOT` / `ANDROID_DATA` —— 安卓运行时环境变量
 *
 * ⚠ 故意**不**用「有没有 Chromium」判断：手机上没浏览器不是「非手机」。
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [o]
 * @returns {boolean}
 */
export function isMobile({ platform = process.platform, env = process.env, exists } = {}) {
  if (platform === "android") return true
  const prefix = String(env.PREFIX ?? "")
  if (/com\.termux/i.test(prefix)) return true
  // magpie 安卓壳 / dsh-go 在壳内注入的平台标识（不同版本名字不完全一致，宽松匹配）
  for (const key of ["MAGPIE_PLATFORM", "MAGPIE_APP", "MAGPIE_SHELL", "DSH_PLATFORM"]) {
    if (/android|termux|mobile/i.test(String(env[key] ?? ""))) return true
  }
  if (env.ANDROID_ROOT || env.ANDROID_DATA) return true
  if (typeof exists === "function") {
    try {
      if (exists("/data/data/com.termux")) return true
    } catch {
      /* 探测失败就当没有 */
    }
  }
  return false
}

/** HTML 转义 —— 所有插进页面的动态内容都要过这一道 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

/**
 * 唤起手机 QQ App 的协议链接。
 *
 * ⚠ `display=mobile` **不会**让手机浏览器唤起 QQ App —— 它只决定授权页渲染成
 *   PC 版还是手机版网页表单。真正能唤起 App 的是 QQ 互联的 `mqqapi://` 转发协议：
 *   `mqqapi://forward/url?url=<编码后的授权页 https 地址>`。
 *   安卓浏览器/QQ 浏览器识别它后会交给 QQ App 打开（官方 App 内置浏览器同样支持）。
 *   没装 QQ 时系统会报「没有可打开此链接的应用」——所以页面必须同时给普通 https 按钮。
 *
 * @param {string} authorizeUrl https 授权页地址
 * @returns {string}
 */
export function qqAppLaunchUrl(authorizeUrl) {
  return `mqqapi://forward/url?url=${encodeURIComponent(String(authorizeUrl))}`
}

/**
 * 唤起微信的链接 —— 微信没有「带 URL 唤起微信授权」的通用 scheme。
 *
 * `weixin://` 只能唤起微信 App 本体；授权页地址（qrconnect）要用户复制后
 * 在微信内置浏览器里打开 —— 那里面打开 qrconnect 不会显示二维码，而是直接
 * 弹「确认授权」页（微信自己带登录态），一台手机就能完成。
 * 页面必须同时给「复制授权链接」按钮，否则用户唤起微信后不知道去哪找链接。
 *
 * @returns {string}
 */
export function wxAppLaunchUrl() {
  return "weixin://"
}

/**
 * 微信授权提示 —— 首选「分享到微信」（Android 系统分享面板），备用「唤起微信 App + 复制授权链接」。
 *
 * `open.weixin.qq.com/connect/qrconnect` 是**网站应用扫码登录**页，系统浏览器打开
 * 只显示二维码，需要另一台设备扫；保存图片再扫的链路微信已收紧，一台手机完成不了。
 * 正确做法（首选分享，省掉手动复制粘贴）：
 *   ① 点「分享到微信（推荐）」→ 系统分享面板选「微信」→「文件传输助手」→ 发送；
 *   ② 在微信里点开这条链接 —— 微信内置浏览器会直接显示「确认授权」页（不是二维码）；
 *   ③ 点「允许」完成授权。
 * 备用（浏览器不支持 navigator.share 时）：
 *   ① 点「唤起微信」按钮（`weixin://`）打开微信 App；
 *   ② 点「复制授权链接」，粘贴到微信「文件传输助手」（或任意聊天）并发送；
 *   ③ 同样在微信里点开 →「确认授权」→「允许」。
 * 不再引导保存/识别二维码图片。
 *
 * @returns {string}
 */
export const WECHAT_OPEN_HINT =
  "微信授权首选「分享到微信（推荐）」：点它后在系统分享面板选「微信」→「文件传输助手」→ 发送，" +
  "在微信里点开链接就会弹出「确认授权」页，点「允许」即可。不要再保存二维码图片扫码（一台手机扫不了自己的码）。" +
  "备用：点「唤起微信」打开微信，再点「复制授权链接」，把链接粘贴到微信「文件传输助手」并发送，" +
  "在微信里点开它同样弹出「确认授权」页，点「允许」。若按钮没反应，长按复制下面链接手动粘贴到微信里打开。"

/** 手机端页面外壳：中文、移动端 viewport、深色模式友好、不引任何外部资源 */
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
  textarea{width:100%;box-sizing:border-box;min-height:110px;padding:12px;border-radius:10px;
    border:1px solid #d5d9de;background:#fff;color:inherit;font:14px/1.5 ui-monospace,monospace;
    resize:vertical}
  @media (prefers-color-scheme:dark){textarea{background:#1b1e21;border-color:#33383d}}
  button{display:block;width:100%;margin-top:14px;padding:15px;border:0;border-radius:10px;
    background:#1677ff;color:#fff;font-size:16px;font-weight:600}
  button:active{opacity:.8}
  a.primary{display:block;margin:12px 0 6px;padding:16px;border-radius:10px;background:#1677ff;
    color:#fff;text-align:center;font-size:16px;font-weight:600;text-decoration:none}
  a.primary:active{opacity:.8}
  a.secondary{display:block;margin:10px 0 6px;padding:14px;border-radius:10px;border:1px solid #1677ff;
    color:#1677ff;background:transparent;text-align:center;font-size:15px;font-weight:600;text-decoration:none}
  a.secondary:active{opacity:.8}
  a.alt{display:inline-block;margin-top:6px;color:#1677ff;font-size:15px;text-decoration:underline}
  .lead{font-size:15px;line-height:1.6}
  hr{border:0;border-top:1px solid #e3e6ea;margin:22px 0 4px}
  @media (prefers-color-scheme:dark){hr{border-top-color:#2c3136}}
  .ok{color:#0a7d33;font-weight:600}
  .bad{color:#c0392b;font-weight:600}
  ol{padding-left:22px;margin:12px 0}
  li{margin:8px 0;font-size:15px}
  code{background:#eceff2;padding:1px 5px;border-radius:4px;font-size:13px}
  @media (prefers-color-scheme:dark){code{background:#262a2e}}
</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`
}

/**
 * 手机端 instructions —— 教用户「怎么在手机上真的完成授权」，而不是只丢一个链接。
 *
 * @param {"QC" | "WX"} loginType
 * @returns {string}
 */
export function mobileInstructions(loginType) {
  if (loginType === "WX") {
    return [
      "1) 首选：点「分享到微信（推荐）」→ 分享面板选「微信」→「文件传输助手」→ 发送（不要再保存二维码图片扫码）",
      "2) 备用：点「唤起微信」打开微信 App，再点「复制授权链接」，把链接粘贴到微信「文件传输助手」（或任意聊天）并发送",
      "3) 在微信里点开这条链接，微信内置浏览器会直接弹出「确认授权」页",
      "4) 点「允许」完成授权，浏览器会停在一个 yybadaccess.3g.qq.com 的地址上",
      "5) 页面可能空白：点微信右上角「…」→「复制链接」（或长按地址栏 → 全选 → 复制），把那条地址整条**粘贴到下面的 Code 输入框**提交",
    ].join("\n")
  }
  return [
    "1) 点上面的按钮唤起手机 QQ（已装 QQ App 会直接打开；没装则用网页版登录）",
    "2) 在 QQ 里确认授权",
    "3) 确认后浏览器会停在一个 yybadaccess.3g.qq.com 的地址上",
    "4) 长按地址栏 → 全选 → 复制，把那条地址整条**粘贴到下面的 Code 输入框**提交",
  ].join("\n")
}

/**
 * 本地登录页正文。
 *
 * ⚠⚠ 页面上必须有**两个**可点的东西，缺一个这条登录路就废了：
 *   ① 首要按钮 —— QQ 走 mqqapi:// 直接把授权页转发给手机 QQ；微信首选「分享到微信」
 *      （navigator.share 系统分享面板，直接把授权链接发进微信，省掉手动复制粘贴）；
 *      微信没有带 URL 的 scheme，weixin:// 唤起微信本体 +「复制授权链接」粘进微信里
 *      打开保留作回退；
 *   ② 粘贴框 + 「完成登录」按钮 —— 授权完成后浏览器停在一条 yybadaccess 地址上，
 *      用户把它整条贴回来。
 * 上一版只有 (2) 但没让用户知道要来这里开页面；再上一版只有 instructions 文字，
 * 用户连粘贴框都看不到（宿主的 method:"auto" 形态不渲染输入框）。
 * 现在两者都在同一个页面上，且 (1) 是首要动作。
 */
export function formPage({ loginType, token, error, authorizeUrl: authUrl }) {
  const isWx = loginType === "WX"
  const name = isWx ? "微信" : "QQ"
  const err = error ? `<p class="bad">${esc(error)}</p>` : ""
  // QQ：mqqapi:// 唤起 App；微信：weixin:// 唤起微信本体，授权链接靠「复制 + 微信内打开」
  const primaryHref = isWx ? wxAppLaunchUrl() : qqAppLaunchUrl(authUrl)
  const primaryText = isWx ? `唤起微信 App 授权（${name}）` : `唤起手机 QQ 登录（${name}）`
  // 微信的主按钮只唤起微信本体（weixin:// 不带 URL），所以点它时顺手把授权链接复制好，
  // 用户在微信里直接粘贴；点完还得回来手动复制的流程太容易半途而废。
  const primaryAttrs = isWx ? ` onclick="return copyAndGo()"` : ""
  const primaryNote = isWx
    ? `<p class="muted">点下面的按钮：唤起微信 + 同时把授权链接复制到剪贴板（到微信里直接粘贴）。</p>`
    : ""
  // 微信首选主按钮：Android 系统分享面板（navigator.share）直接把授权链接发进微信，
  // 省掉「复制 → 切 App → 找聊天 → 粘贴」的手动步骤。127.0.0.1 是 secure context，
  // Android Chrome 支持 navigator.share；不支持/分享失败时回退到复制 + 唤起（见 shareWx）。
  // QQ 分支为空串（不带换行），保证 QQ 页输出一个字节都不变。
  const shareBtn = isWx
    ? `<button type="button" onclick="return shareWx()" style="background:#07c160">分享到微信（推荐）</button>
<p id="wx-share-status" class="muted"></p>
`
    : ""
  // 后续步骤块：初始就可见 —— 用户「唤起微信后不知道干嘛」正是要修的体验问题，
  // 不能把步骤藏起来等点击。shareWx 成功/回退后只做滚动定位 + 高亮，不做显隐切换。
  const wxNextSteps = isWx
    ? `<div id="wx-next-steps" style="border:1px solid #d5d9de;border-radius:10px;padding:2px 14px 8px;margin:16px 0">
<p class="lead"><strong>接下来怎么做（分享或唤起微信后，都按这里走）：</strong></p>
<ol>
  <li>点「分享到微信（推荐）」→ 分享面板选「微信」→ 选「文件传输助手」→ 发送。（若用「唤起微信」：先点「复制授权链接」，到微信「文件传输助手」粘贴发送。）</li>
  <li>在微信里点开刚发送的链接。</li>
  <li>出现「确认授权」页 → 点「允许」。</li>
  <li>跳转后页面可能空白：点微信右上角「…」→「复制链接」，回到 magpie 粘贴到 Code 输入框（或本页下方粘贴框）完成登录。</li>
</ol>
<p class="muted">提醒：不要保存二维码图片扫码（一台手机扫不了自己的码）。</p>
</div>`
    : ""
  const fallback = isWx
    ? `<p class="muted">${esc(WECHAT_OPEN_HINT)}</p>
       <p class="muted">复制授权链接（唤起微信后，粘贴到微信「文件传输助手」点开）：</p>
       <input type="text" id="wx-auth-url" readonly value="${esc(authUrl)}" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #d5d9de;background:#fff;color:inherit;font:13px/1.4 ui-monospace,monospace">
       <button type="button" id="wx-copy-btn" onclick="copyWxUrl()">复制授权链接</button>
        <p class="muted">如果唤起没反应，用系统浏览器打开授权页（扫码兜底，需要另一台设备）：</p>
       <a class="secondary" href="${esc(authUrl)}" target="_blank" rel="noreferrer">备用：用系统浏览器打开授权页</a>`
    : `<p class="muted">没装手机 QQ 时，用下面的按钮在浏览器里完成网页版登录：<br>
       <a class="alt" href="${esc(authUrl)}" target="_blank" rel="noreferrer">用浏览器打开 QQ 授权页</a></p>`

  const copyScript = isWx
    ? `<script>
function copyWxUrl(){
  const el=document.getElementById('wx-auth-url');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(el.value).then(()=>{flashCopy()},()=>fallbackCopy(el));
  }else{fallbackCopy(el)}
}
// 点「唤起微信」时顺手复制：一次点击完成「跳微信 + 链接进剪贴板」，
// 否则用户到微信里还得回来复制一次，中间一换 App 就容易忘记步骤。
function copyAndGo(){
  const el=document.getElementById('wx-auth-url');
  if(!el) return true;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(el.value).then(()=>{flashCopy()},()=>fallbackCopy(el));
  }else{fallbackCopy(el)}
  return true;
}
function fallbackCopy(el){
  el.focus();el.select();el.setSelectionRange(0,el.value.length);
  try{document.execCommand('copy');flashCopy()}catch(e){}
}
function flashCopy(){
  const b=document.getElementById('wx-copy-btn');
  if(b){const t=b.textContent;b.textContent='已复制 ✓';setTimeout(()=>{b.textContent=t},1500)}
}
// 「分享到微信」主路径：系统分享面板直接把授权链接发进微信（选微信 → 文件传输助手 → 发送）。
// authUrl 直接读 wx-auth-url 输入框的 value，不重新拼 URL（页面回显的就是本次授权地址）。
// 分享失败（用户取消等）静默回退：copyWxUrl() 复制 + 文字提示；不支持 navigator.share
// 时回退到 copyAndGo 那套（复制 + weixin:// 唤起）。两条路都指向下方后续步骤块。
function shareWx(){
  const el=document.getElementById('wx-auth-url');
  const authUrl=el?el.value:'';
  if(navigator.share){
    navigator.share({title:'Marvis 微信授权',text:'在微信里点开这个链接，点「允许」完成授权',url:authUrl}).then(
      ()=>{setWxShareStatus('已分享 ✓ 按下面「接下来怎么做」继续。');showWxNextSteps()},
      ()=>{copyWxUrl();setWxShareStatus('分享未完成：已复制授权链接，请打开微信，粘贴到「文件传输助手」发送后点开。');showWxNextSteps()}
    );
  }else{
    copyAndGo();
    setWxShareStatus('此浏览器不支持系统分享：已复制授权链接并唤起微信，请粘贴到「文件传输助手」发送后点开。');
    showWxNextSteps();
    window.location.href='weixin://';
  }
  return false;
}
function setWxShareStatus(msg){
  const p=document.getElementById('wx-share-status');
  if(p)p.textContent=msg;
}
function showWxNextSteps(){
  const box=document.getElementById('wx-next-steps');
  if(box){box.style.borderColor='#07c160';box.scrollIntoView({behavior:'smooth',block:'nearest'});}
}
</script>`
    : ""

  // 第 1 步的说法必须与按钮真实行为一致：分享按钮只把链接发进微信，weixin:// 按钮只唤起
  // 微信本体，授权都要在微信里点「允许」；说「点按钮完成授权」会让人以为点完就结束了。
  const step1 = isWx
    ? `第 1 步（推荐）：点「分享到微信（推荐）」，分享面板选微信 →「文件传输助手」发送。备用：点下面的按钮唤起微信，再「复制授权链接」发到微信里打开，点「允许」完成${esc(name)}授权。`
    : `第 1 步：点下面的按钮唤起手机 ${esc(name)} 完成授权（没装 App 就用下面的备用按钮走网页版）。`

  return page(
    `${name}登录 · 授权并粘贴回调地址`,
    `<h1>${esc(name)}登录</h1>
${err}
<p class="lead">${step1}</p>
${shareBtn}<a class="primary" href="${esc(primaryHref)}"${primaryAttrs}>${esc(primaryText)}</a>
${primaryNote}
${fallback}
${wxNextSteps}
<hr>

<p class="lead">第 2 步：授权完成后浏览器会停在一条 <code>yybadaccess.3g.qq.com/…marvis_oauth?…code=…</code> 的地址上，
把它整条复制，粘贴到下面完成登录。</p>
<form method="post" action="/submit">
  <input type="hidden" name="t" value="${esc(token)}">
  <textarea name="callback" inputmode="text" autocomplete="off" autocapitalize="off"
    spellcheck="false" placeholder="把 yybadaccess.3g.qq.com/…marvis_oauth?login_type=…&code=…&state=… 整条粘贴到这里"></textarea>
  <button type="submit">完成登录</button>
</form>
${copyScript}
<p class="muted">这个页面只在本机 127.0.0.1 上，内容不会发到别处。</p>`,
  )
}

/** 读请求体，超过上限直接掐断 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
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
 * 起本地粘贴表单服务，等用户把回调地址贴回来。
 *
 * @param {{
 *   loginType?: "QC" | "WX",
 *   guid: string,
 *   port?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   onReady?: (url: string) => void,
 * }} opts
 * @returns {Promise<{ url: string, wait: Promise<any>, close: () => void }>}
 */
export async function startPasteServer({
  loginType = "QC",
  guid,
  authorizeUrl: authUrl = "",
  port = DEFAULT_PASTE_PORT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onReady,
} = {}) {
  if (!guid) throw new Error("startPasteServer 需要设备 guid（换取登录态时必须带）")

  // 一次性 token：防止局域网/本机其他程序往这个端口乱 POST（CSRF）
  const token = randomBytes(16).toString("hex")

  /** @type {(v: any) => void} */
  let settle = () => {}
  /** @type {(e: any) => void} */
  let fail = () => {}
  let settled = false
  const result = new Promise((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")
    const send = (status, html) => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        // 页面内联样式/脚本，禁掉一切外部资源
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
      })
      res.end(html)
    }

    if (url.pathname !== "/" && url.pathname !== "/submit") return send(404, page("404", "<h1>没有这个页面</h1>"))

    if (req.method === "GET") return send(200, formPage({ loginType, token, authorizeUrl: authUrl }))

    if (req.method !== "POST") return send(405, page("405", "<h1>不支持的方法</h1>"))

    let body = ""
    try {
      body = await readBody(req)
    } catch (err) {
      return send(413, formPage({ loginType, token, authorizeUrl: authUrl, error: String(err?.message ?? err) }))
    }

    // 表单是 application/x-www-form-urlencoded
    const form = new URLSearchParams(body)
    if (form.get("t") !== token) {
      return send(403, formPage({ loginType, token, authorizeUrl: authUrl, error: "这个页面已经失效，请回 magpie 重新点一次登录。" }))
    }
    const pasted = String(form.get("callback") ?? "").trim()
    if (!pasted) return send(400, formPage({ loginType, token, authorizeUrl: authUrl, error: "没有收到内容，请把地址栏那条地址粘贴进来。" }))
    if (!extractCode(pasted)) {
      return send(
        400,
        formPage({
          loginType,
          token,
          error: "粘贴的内容里没有 code。请确认复制的是授权完成后地址栏那条 yybadaccess.3g.qq.com/…marvis_oauth?…code=… 的地址。",
        }),
      )
    }

    const state = stateOf(pasted)
    if (!state) {
      return send(400, formPage({ loginType, token, authorizeUrl: authUrl, error: "粘贴的内容里没有 state，请重新复制地址栏那条完整地址。" }))
    }

    try {
      // ⚠ guid 必须与 authorizeUrl() 那一次同一个（token 绑定到它）
      const acct = await parseCallback(pasted, "", { loginType, guid, state })
      if (settled) return send(409, page("已处理", "<h1>这次登录已经完成</h1><p class='muted'>可以回到 magpie 了。</p>"))
      settled = true
      send(
        200,
        page(
          "登录成功",
          `<h1 class="ok">✓ 登录成功</h1><p>可以关掉这个页面，回到 magpie 了。</p><p class="muted">窗口会自动关闭。</p>`,
        ),
      )
      settle(acct)
    } catch (err) {
      // 换取失败（网络抖动 / code 已被消费）：允许用户在同一页面重试一次
      const msg = String(err?.message ?? err)
      send(502, formPage({ loginType, token, authorizeUrl: authUrl, error: msg.slice(0, 300) }))
    }
  })

  // 端口被占用就退到随机端口（手机上有别的服务占 4618 很常见）
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
    // ⚠ 只绑 127.0.0.1：这个口子能让任何人换到登录态，绝不能暴露到局域网
    server.listen(port, "127.0.0.1", resolve)
  })

  const actualPort = server.address()?.port
  // ⚠ 监听句柄不参与「保活」：登录页只是等待用户的一次性入口，不该让宿主/CLI 进程
  //    因为一个没人点的登录页而无法退出（测试里表现为整套要拖到 10 分钟超时）。
  //    超时定时器同样已 unref（见下）。真正等结果的调用方自己 await paste.wait 即可。
  server.unref?.()
  const pageUrl = `http://127.0.0.1:${actualPort}/`

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    fail(new Error(`手机端登录超时（${Math.round(timeoutMs / 60_000)} 分钟没有收到回调地址）。请重新点一次登录。`))
  }, timeoutMs)
  timer.unref?.()

  const close = () => {
    clearTimeout(timer)
    try {
      server.close()
      server.closeIdleConnections?.()
    } catch {
      /* 已经关了 */
    }
  }

  if (signal) {
    const onAbort = () => {
      if (settled) return
      settled = true
      close()
      fail(new Error("登录已取消"))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  // 成功/失败都收摊
  result.then(close, close)

  try {
    onReady?.(pageUrl)
  } catch {
    /* 回调里的错误不影响登录 */
  }

  return { url: pageUrl, wait: result, close }
}

/**
 * 手机端 OAuth 登录编排（给 `auth.methods()` 用）。
 *
 * 与桌面 `oauthLogin` 的区别：不开 Chromium（手机没有子进程 / CDP），
 * 改走「宿主开浏览器 + 用户把回调地址贴回来」，并额外提供一个本地登录页兜底。
 *
 * ═══ 为什么是这三个字段的组合（截图实测反推出来的）══════════════════
 *
 * 上一版是 `{ url: 授权页, opened: true, method: "auto" }`，手机上的实际表现：
 *   只渲染出「一段 instructions + 一个 URL 框」，**没有输入框、没有唤起按钮** ——
 *   用户看到的正是「没地方粘贴」「QQ 登录入口不见了」。
 *
 *   · `method: "auto"` → 壳认为流程全自动（CDP / loopback），**不渲染粘贴输入框**；
 *   · `opened: true`  → 壳认为「插件自己开过了」，**不再显示「打开浏览器」按钮**。
 *   两条一叠加，壳上就只剩一段文字 —— 手机端最需要的那两个控件全没了。
 *
 * 现在改成：
 *   · `method: "code"` → 壳**渲染粘贴输入框**（社区插件 opencode-raccoon-auth
 *     的手动入口就是这条路，实机在跑）；
 *   · `opened: false`  → 壳**显示「打开浏览器」按钮**，用户一点就把授权页
 *     交给系统浏览器；系统浏览器才有权限处理 QQ 授权页里的 App 唤起跳转
 *     （壳内 WebView 会拦掉外部 App 跳转，这是「点 QQ 登录不拉起 QQ App」的原因之二）。
 *   · 本地登录页仍作为兜底：万一壳没给输入框，instructions 里给出本地页地址，
 *     那个页面上有「唤起 QQ 按钮 + 粘贴框」，照样能走通。
 *
 * @param {{
 *   loginType?: "QC" | "WX",
 *   label?: string,
 *   instructions?: string,
 *   timeoutMs?: number,
 *   startServer?: typeof startPasteServer,
 *   toAuth?: (acct: any) => any,
 *   onPage?: (url: string) => void,
 * }} [opts]
 */
export function mobileOauthLogin({
  loginType = "QC",
  label,
  instructions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  startServer = startPasteServer,
  toAuth,
  onPage,
} = {}) {
  const name = loginType === "WX" ? "微信" : "QQ"
  return {
    type: "oauth",
    label: label ?? `${name} 登录（手机）`,
    async authorize() {
      // 每个账号一个独立 guid —— 与桌面路径同一套虚拟设备机制，避免新号顶掉旧号
      const { newDeviceGuid } = await import("./device.mjs")
      const guid = newDeviceGuid()
      const authUrl = authorizeUrl(loginType, guid, { mobile: true })

      // 本地登录页作为兜底（壳没给输入框时用户仍能走通）：必须在 authorize() 里就起来
      const paste = await startServer({ loginType, guid, authorizeUrl: authUrl, timeoutMs })
      try {
        onPage?.(paste.url)
      } catch {
        /* 回调里的错误不影响登录 */
      }

      const base = instructions ?? mobileInstructions(loginType)
      // 说明里同时给出：壳的输入框怎么用、本地页在哪、QQ 怎么唤起 App
      const withEntry =
        loginType === "WX"
          ? [
              base,
              "",
              `点「打开浏览器」打开的是**本机引导页**（不是扫码页）：上面有「唤起微信」按钮和「复制授权链接」。`,
              `在微信里点「允许」后，把浏览器停在的那条 yybadaccess.3g.qq.com/…marvis_oauth?…code=… 地址整条复制，`,
              `粘贴到下面的输入框提交（引导页上也有粘贴框，二选一即可）。`,
            ].join("\n")
          : [
              base,
              "",
              `完成授权后，把浏览器停在的那条 yybadaccess.3g.qq.com/…marvis_oauth?…code=… 地址整条复制，`,
              `粘贴到下面的输入框提交。`,
              `（如果下面没有输入框，用手机浏览器打开这个本机登录页，那上面有按钮和粘贴框）：${paste.url}`,
            ].join("\n")

      return {
        // ⚠ WX 的 url 必须是**本机引导页**（0.7.6 修复）：opened:false 时宿主直接打开 url，
        //   上一版给的是 qrconnect 授权页 → 手机上看到的永远是一张二维码图片，
        //   「唤起微信 + 复制授权链接」那套按钮全在本地页里，用户根本走不到。
        //   现在壳打开的就是引导页，qrconnect 只作为页内的授权链接存在。
        //   QQ 仍给授权页：系统浏览器打开 graph.qq.com 才能触发 mqqapi 唤起手机 QQ。
        url: loginType === "WX" ? paste.url : authUrl,
        // ⚠ opened:false —— 让壳显示「打开浏览器」按钮（上一版 true 把这个入口藏了）
        opened: false,
        // ⚠ method:"code" —— 让壳渲染粘贴输入框（上一版 auto 把它藏了）
        method: "code",
        instructions: withEntry,
        async callback(a, b, signal) {
          // ① 宿主给了粘贴内容（method:"code" 的输入框）→ 走标准换取
          const pasted = pastedInputOf(a, b)
          if (pasted) {
            const acct = await exchangeFromPaste(pasted, { loginType, guid })
            return toAuth ? toAuth(acct) : acct
          }
          // ② 宿主没给内容 → 等本地页提交（用户走了兜底路径）
          if (signal) {
            if (signal.aborted) paste.close()
            else signal.addEventListener("abort", () => paste.close(), { once: true })
          }
          try {
            const acct = await paste.wait
            // guid 必须与授权那次同一个（token 绑定到它）
            const filled = { ...acct, guid, loginType: acct.loginType ?? (loginType === "WX" ? "2" : "1") }
            return toAuth ? toAuth(filled) : filled
          } catch (err) {
            // 失败时把本地页地址带进错误：用户能就地重试，不用重新走一遍授权
            const e = new Error(`${String(err?.message ?? err)}\n\n重试入口（10 分钟内有效）：${paste.url}`)
            e.pageUrl = paste.url
            throw e
          } finally {
            paste.close()
          }
        },
        /**
         * 用户放弃这次授权（退出登录界面 / 换一种登录方式）时释放本地端口。
         * 不关掉的话，一个 10 分钟的监听句柄会一直挂着：测试里表现为进程拖到超时才退，
         * 真机上表现为反复进出登录页攒出一堆占位端口。close 幂等，重复调用无害。
         */
        async cancel() {
          try {
            paste.close()
          } catch {
            /* 已经关了 */
          }
        },
      }
    },
  }
}

/**
 * 用一段「回调地址」换登录态（method:"code" 那条路）。
 *
 * 与桌面 manualPasteLogin 同义，但 guid 由调用方固定传入（手机端每次授权
 * 新生成一个 guid，不走 state 反查 —— 壳给的回调地址可能已被截断/重写）。
 *
 * @param {string} pasted 用户粘贴的回调地址（或裸 code）
 * @param {{ loginType: "QC" | "WX", guid: string }} opts
 */
export async function exchangeFromPaste(pasted, { loginType, guid }) {
  const text = String(pasted ?? "").trim()
  if (!text) {
    throw new Error("没有收到回调地址：登录完请把浏览器地址栏里那条 `…marvis_oauth?code=…&state=…` 整条粘贴回来。")
  }
  if (!extractCode(text)) {
    throw new Error(
      "粘贴的内容里没有 code：请把地址栏里那条 `…marvis_oauth?login_type=…&code=…&state=…` 整条复制。",
    )
  }
  const state = stateOf(text)
  if (!state) {
    throw new Error("粘贴的内容里没有 state：请重新复制地址栏里那条回调地址。")
  }
  const acct = await parseCallback(text, "", { loginType, guid, state })
  return { ...acct, guid }
}