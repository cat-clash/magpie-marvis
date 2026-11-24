// 手机端登录 —— 本地粘贴表单服务与登录编排的离线测试
//
// 覆盖「手机点 QQ / 微信登录唤不起」的三个根因对应的修复：
//   ① QQ 授权页在手机上必须是 display=mobile（否则渲染 PC 表单，不唤起 App）
//   ② 微信是 PC 扫码页，instructions 与登录页必须教「唤起微信 App + 复制授权链接到微信里打开」
//   ③ 壳的粘贴补丁按包名打，本插件包名不匹配 → 自带 127.0.0.1 表单页，不依赖壳
//
// 跑法：node --test tests/mobile-login.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import { isMobile, mobileInstructions, startPasteServer, mobileOauthLogin } from "../src/marvis/mobile-login.mjs"
import { authorizeUrl, extractCode, stateOf } from "../src/marvis/login.mjs"

/** 与真实换取同形的回调地址（不联网：只测到 code/state 解析与表单流程） */
function fakeCallback(code = "ABCDEF1234567890abcdef", state = "31.1177412") {
  return `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=${code}&state=${state}`
}

// ── isMobile ───────────────────────────────────────────────────────────

test("isMobile：安卓 platform 直接判手机", () => {
  assert.equal(isMobile({ platform: "android", env: {} }), true)
})

test("isMobile：Termux 的 PREFIX 判手机", () => {
  assert.equal(isMobile({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true)
})

test("isMobile：安卓运行时变量判手机", () => {
  assert.equal(isMobile({ platform: "linux", env: { ANDROID_ROOT: "/system" } }), true)
})

test("isMobile：magpie 壳注入的平台标识判手机（大小写不敏感）", () => {
  assert.equal(isMobile({ platform: "linux", env: { MAGPIE_PLATFORM: "Android" } }), true)
  assert.equal(isMobile({ platform: "linux", env: { DSH_PLATFORM: "termux" } }), true)
})

test("isMobile：/data/data/com.termux 存在也判手机", () => {
  const exists = (p) => p === "/data/data/com.termux"
  assert.equal(isMobile({ platform: "linux", env: {}, exists }), true)
})

test("isMobile：桌面环境不误判（Windows / macOS / 普通 Linux）", () => {
  assert.equal(isMobile({ platform: "win32", env: { PREFIX: "C:\\msys64" } }), false)
  assert.equal(isMobile({ platform: "darwin", env: {} }), false)
  assert.equal(isMobile({ platform: "linux", env: { HOME: "/home/u" } }), false)
})

// ── authorizeUrl 的 mobile 分支 ─────────────────────────────────────────

test("authorizeUrl：手机端 QQ 用 display=mobile（否则不唤起手机 QQ App）", () => {
  const u = new URL(authorizeUrl("QC", "a".repeat(32), { mobile: true }))
  assert.equal(u.host, "graph.qq.com")
  assert.equal(u.searchParams.get("display"), "mobile")
})

test("authorizeUrl：桌面端 QQ 仍是 display=pc（不破坏 PC 行为）", () => {
  const u = new URL(authorizeUrl("QC", "a".repeat(32)))
  assert.equal(u.searchParams.get("display"), "pc")
  assert.equal(new URL(authorizeUrl("QC", "a".repeat(32), { mobile: false })).searchParams.get("display"), "pc")
})

test("authorizeUrl：mobile 只改 display，redirect_uri / client_id / which 一字不改", () => {
  const desktop = new URL(authorizeUrl("QC", "b".repeat(32)))
  const mobile = new URL(authorizeUrl("QC", "b".repeat(32), { mobile: true }))
  for (const key of ["redirect_uri", "client_id", "which", "response_type"]) {
    assert.equal(mobile.searchParams.get(key), desktop.searchParams.get(key), `${key} 不许被 mobile 改动`)
  }
  // redirect_uri 必须仍带 ?login_type=QC（缺了服务端 -109）
  assert.match(mobile.searchParams.get("redirect_uri"), /marvis_oauth\?login_type=QC$/)
})

test("authorizeUrl：mobile 下 state 仍是小数形态（服务端校验格式）", () => {
  const u = new URL(authorizeUrl("QC", "c".repeat(32), { mobile: true }))
  assert.match(u.searchParams.get("state"), /^\d+(\.\d+)?$/)
})

test("authorizeUrl：微信两条路都不加 display（qrconnect 没有这个参数）", () => {
  for (const mobile of [true, false]) {
    const u = new URL(authorizeUrl("WX", "d".repeat(32), { mobile }))
    assert.equal(u.host, "open.weixin.qq.com")
    assert.equal(u.searchParams.has("display"), false)
    assert.equal(u.searchParams.get("state"), "d".repeat(32), "微信 state 就是 guid")
  }
})

// ── instructions ───────────────────────────────────────────────────────

test("mobileInstructions：微信教「唤起微信 App + 在微信里打开链接」，不再教保存二维码扫码", () => {
  const s = mobileInstructions("WX")
  assert.match(s, /唤起微信/)
  assert.match(s, /复制授权链接/)
  assert.match(s, /不要.*二维码/, "要明确说不要保存二维码图片扫码")
  assert.doesNotMatch(s, /识别图中二维码/, "手机上不再依赖长按识别二维码")
})

test("mobileInstructions：QQ 说明会唤起 App 或走手机版网页", () => {
  const s = mobileInstructions("QC")
  assert.match(s, /唤起/)
  assert.match(s, /手机 QQ/)
})

test("mobileInstructions：两条都要求复制地址栏整条地址", () => {
  for (const t of ["QC", "WX"]) {
    const s = mobileInstructions(t)
    assert.match(s, /地址栏/)
    assert.match(s, /粘贴/)
  }
})

// ── 本地粘贴表单服务 ───────────────────────────────────────────────────

test("startPasteServer：GET 返回可在手机上打开的表单页，且只绑 127.0.0.1", async () => {
  const s = await startPasteServer({ loginType: "QC", guid: "e".repeat(32), port: 0, timeoutMs: 5000 })
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const res = await fetch(s.url)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /<textarea/, "要有粘贴框")
    assert.match(html, /name="callback"/)
    assert.match(html, /name="t" value="[0-9a-f]{32}"/, "要有一次性 token")
    assert.match(html, /viewport/, "手机页面必须有 viewport")
  } finally {
    s.close()
  }
})

test("startPasteServer：错误 token 被拒绝（防本机其他程序乱 POST）", async () => {
  const s = await startPasteServer({ loginType: "QC", guid: "f".repeat(32), port: 0, timeoutMs: 5000 })
  try {
    const res = await fetch(`${s.url}submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: "0".repeat(32), callback: fakeCallback() }).toString(),
    })
    assert.equal(res.status, 403)
  } finally {
    s.close()
  }
})

test("startPasteServer：没有 code 的粘贴内容被拒绝，且页面仍可用（可重试）", async () => {
  const s = await startPasteServer({ loginType: "QC", guid: "1".repeat(32), port: 0, timeoutMs: 5000 })
  try {
    // 从表单页里抠出 token
    const html = await (await fetch(s.url)).text()
    const token = /name="t" value="([0-9a-f]{32})"/.exec(html)[1]

    const bad = await fetch(`${s.url}submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: token, callback: "https://example.com/nothing" }).toString(),
    })
    assert.equal(bad.status, 400)
    assert.match(await bad.text(), /没有 code/)

    // 页子还在，用户可以再贴一次
    assert.equal((await fetch(s.url)).status, 200)
  } finally {
    s.close()
  }
})

test("startPasteServer：超时会 reject，且错误里说明是超时", async () => {
  const s = await startPasteServer({ loginType: "QC", guid: "2".repeat(32), port: 0, timeoutMs: 80 })
  await assert.rejects(s.wait, /超时/)
})

test("startPasteServer：abort 会取消等待", async () => {
  const ac = new AbortController()
  const s = await startPasteServer({ loginType: "WX", guid: "3".repeat(32), port: 0, timeoutMs: 60_000, signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(s.wait, /取消/)
})

test("startPasteServer：端口被占用时自动退到随机端口（不直接失败）", async () => {
  const first = await startPasteServer({ loginType: "QC", guid: "4".repeat(32), port: 0, timeoutMs: 500 })
  try {
    const usedPort = Number(new URL(first.url).port)
    // 用同一个端口再起一个：应能退到别的端口而不是抛 EADDRINUSE
    const second = await startPasteServer({ loginType: "QC", guid: "5".repeat(32), port: usedPort, timeoutMs: 500 })
    try {
      assert.notEqual(new URL(second.url).port, String(usedPort))
    } finally {
      second.close()
    }
  } finally {
    first.close()
  }
})

// ── mobileOauthLogin 编排 ──────────────────────────────────────────────

test("mobileOauthLogin：authorize 给 method:'code' + 不 opened（壳才有输入框与唤起按钮）", async () => {
  const m = mobileOauthLogin({ loginType: "QC", toAuth: (a) => a, startServer: fakeServer() })
  const r = await m.authorize()
  // ⚠ 截图实测的根因：method:"auto" → 壳不渲染粘贴输入框；opened:true → 壳藏掉唤起按钮
  assert.equal(r.method, "code", "必须 method:'code'，壳才渲染粘贴输入框")
  assert.notEqual(r.opened, true, "不能 opened:true，壳才显示「打开浏览器」按钮")
  assert.match(r.url, /graph\.qq\.com/)
  assert.equal(new URL(r.url).searchParams.get("display"), "mobile")
  assert.match(r.instructions, /手机 QQ|唤起/)
})

/** 永不阻塞的假 server：authorize 阶段用它，避免真起 HTTP 服务把测试拖 10 分钟 */
function fakeServer(url = "http://127.0.0.1:4618/") {
  return async () => ({
    url,
    wait: Promise.resolve({ openid: "X", accessToken: "T", loginType: "1" }),
    close() {},
  })
}

test("mobileOauthLogin：微信 authorize 打开本机引导页（不是 qrconnect 扫码页），instructions 教唤起微信 App", async () => {
  const m = mobileOauthLogin({ loginType: "WX", toAuth: (a) => a, startServer: fakeServer() })
  const r = await m.authorize()
  // ⚠ 0.7.6 修复：上一版 url=qrconnect → 壳「打开浏览器」直接开出一张二维码图片，
  //   用户根本走不到「唤起微信 + 复制授权链接」那套按钮。现在 url 必须是本机引导页。
  assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\//, "微信必须打开本机引导页，不能直接开 qrconnect")
  assert.doesNotMatch(r.url, /open\.weixin\.qq\.com/, "壳打开的 url 里不许出现 qrconnect")
  assert.match(r.instructions, /唤起微信/)
  assert.match(r.instructions, /复制授权链接/)
  assert.doesNotMatch(r.instructions, /识别图中二维码/)
})

test("mobileOauthLogin：authorize 阶段就把本地页地址写进 instructions（兜底入口）", async () => {
  const m = mobileOauthLogin({
    loginType: "QC",
    timeoutMs: 120,
    toAuth: (a) => a,
    startServer: fakeServer("http://127.0.0.1:4618/"),
  })
  const r = await m.authorize()
  // instructions 是 authorize() 的返回值，用户在登录界面看到的就是它
  assert.match(r.instructions, /127\.0\.0\.1:4618/, "instructions 必须含本地页地址作为兜底")
  assert.match(r.instructions, /唤起/, "原有 QQ 授权指引不能丢")
  // ⚠ 壳的输入框 + 唤起按钮必须都保留（截图实测的根因）
  assert.equal(r.method, "code", "必须 method:'code'，否则壳不渲染粘贴输入框")
  assert.notEqual(r.opened, true, "不能 opened:true，否则壳藏掉「打开浏览器」按钮")
  // 主 URL 是授权页（交给系统浏览器才有权限处理 App 唤起）
  assert.match(r.url, /^https:\/\/graph\.qq\.com\//)
})

test("mobileOauthLogin：cancel() 释放本地登录页端口（用户放弃授权 / 换登录方式）", async () => {
  let pageUrl = ""
  const m = mobileOauthLogin({
    loginType: "QC",
    timeoutMs: 60_000,
    toAuth: (a) => a,
    onPage: (u) => {
      pageUrl = u
    },
  })
  const r = await m.authorize()
  assert.match(pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/, "authorize 阶段必须已经起好本地兜底页")
  const alive = await fetch(pageUrl).then(
    (res) => (res.ok ? "OPEN" : `HTTP_${res.status}`),
    () => "CLOSED",
  )
  assert.equal(alive, "OPEN", "cancel 之前页面必须可访问")

  await r.cancel()
  const after = await fetch(pageUrl).then(
    () => "STILL_OPEN",
    () => "CLOSED",
  )
  assert.equal(after, "CLOSED", "cancel 之后端口必须释放，否则反复进出登录页会攒一堆监听句柄")
  // close 幂等：callback 的 finally 里还会再 close 一次，不能因此抛错
  await r.cancel()
})


test("mobileOauthLogin：宿主给了粘贴内容时走标准换取（不再等本地页）", async () => {
  // 注入一个"永远不 resolve"的本地服务：若实现错误地走本地页，测试会超时失败
  const m = mobileOauthLogin({
    loginType: "QC",
    timeoutMs: 60_000,
    toAuth: (a) => ({ type: "success", access: a.accessToken }),
    startServer: async () => ({
      url: "http://127.0.0.1:9997/",
      wait: new Promise(() => {}),
      close() {},
    }),
  })
  const r = await m.authorize()
  // 宿主粘贴的是完整回调地址 —— 换取会真实发网络请求（假 code → 上游 -107）。
  // 这里要证明的是「它走了换取这条路」，而不是「在等本地页」。
  const out = await Promise.race([
    r.callback("https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=abc&state=1").then(
      () => "EXCHANGED",
      (err) => `ERR:${String(err?.message ?? err).slice(0, 40)}`,
    ),
    new Promise((res) => setTimeout(() => res("TIMEOUT_WAITING_LOCAL_PAGE"), 4000)),
  ])
  assert.notEqual(out, "TIMEOUT_WAITING_LOCAL_PAGE", "宿主给了粘贴内容就不该等本地页")
  // 走到了上游换取（假 code 被上游拒 = -107），而不是本地等待
  assert.match(String(out), /^(EXCHANGED|ERR:登录失败)/, `应走上游换取，实际 ${out}`)
})

test("mobileOauthLogin：callback 等超时会带上重试入口", async () => {
  const m = mobileOauthLogin({
    loginType: "QC",
    timeoutMs: 100,
    toAuth: (a) => a,
    startServer: async () => ({
      url: "http://127.0.0.1:9999/",
      wait: Promise.reject(new Error("粘贴的内容里没有 code")),
      close() {},
    }),
  })
  const r = await m.authorize()
  await assert.rejects(r.callback(), (err) => {
    assert.match(err.message, /没有 code/)
    assert.match(err.message, /重试入口/)
    assert.match(err.message, /127\.0\.0\.1:9999/)
    return true
  })
})

test("mobileOauthLogin：成功后把 guid / loginType 补齐再交给 toAuth", async () => {
  let received = null
  const m = mobileOauthLogin({
    loginType: "QC",
    toAuth: (a) => {
      received = a
      return { type: "success", access: a.accessToken }
    },
    startServer: async () => ({
      url: "http://127.0.0.1:9998/",
      wait: Promise.resolve({ openid: "ABCD1234", accessToken: "tok", loginType: "1" }),
      close() {},
    }),
  })
  const r = await m.authorize()
  const out = await r.callback()
  assert.equal(out.type, "success")
  assert.equal(received.openid, "ABCD1234")
  assert.match(received.guid, /^[0-9a-f]{32}$/, "guid 必须补齐（换取时绑定的就是它）")
  assert.equal(received.loginType, "1")
})

// ── 解析器回归（手机端粘贴的内容形态）────────────────────────────────

test("extractCode / stateOf：手机浏览器复制出来的完整地址能被解析", () => {
  const url = fakeCallback()
  assert.equal(extractCode(url), "ABCDEF1234567890abcdef")
  assert.equal(stateOf(url), "31.1177412", "state 必须按字符串原样保留（小数形态）")
})

// ── methods() 顺序（「点登录没反应」的直接表现就是列表顺序不对）────────

/** 在受控环境里跑 methods()，结束后完整还原 env */
async function withEnv(vars, fn) {
  const saved = new Map()
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // 隔离宿主真实 gateway 配置
  const prevNative = process.env.MARVIS_NATIVE_DIR
  process.env.MARVIS_NATIVE_DIR = "C:\\__no_such_native_dir__"
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (prevNative === undefined) delete process.env.MARVIS_NATIVE_DIR
    else process.env.MARVIS_NATIVE_DIR = prevNative
  }
}

test("methods：手机环境 —— 三个入口都在（QQ / 微信 / 浏览器粘贴），且都带输入框", async () => {
  const { methods } = await import("../src/hooks/methods.mjs")
  await withEnv(
    {
      PREFIX: "/data/data/com.termux/files/usr",
      MARVIS_TRANSPORT: "gateway", // 让网关占位账号出现，验证它被排到后面
      MARVIS_WS_MODE: undefined,
      MARVIS_GATEWAY_URL: "http://127.0.0.1:1/v1",
    },
    async () => {
      const list = methods()
      assert.match(list[0].label, /^QQ 登录$/, "第一条是手机 QQ 登录")
      assert.match(list[1].label, /^微信登录$/, "第二条是手机微信登录")

      // ⚠ 截图实测：壳的 method:"auto" 形态没有输入框、opened:true 又藏掉唤起按钮
      //   —— 三个入口必须都走 method:"code" + opened 不为 true
      const realLogins = list.filter((m) => m.type === "oauth" && !/本地网关/.test(m.label))
      assert.ok(realLogins.length >= 4, `手机端应至少 4 个入口（QQ/微信/浏览器粘贴×2），实际 ${realLogins.length}`)
      for (const m of realLogins) {
        const r = await m.authorize()
        // authorize() 会真起本地兜底登录页（默认 10 分钟超时）。测试不走完 callback，
        // 必须显式 cancel 释放句柄，否则 node --test 要拖到超时才退出。
        await r.cancel?.()
        assert.equal(r.method, "code", `${m.label} 必须 method:"code"，否则壳不渲染粘贴输入框`)
        assert.notEqual(r.opened, true, `${m.label} 不能 opened:true，否则壳藏掉「打开浏览器」按钮`)
      }

      // 浏览器登录入口（用户明确要的第三个入口）
      assert.ok(
        list.some((m) => /粘贴回调地址/.test(m.label)),
        "手机端必须有「浏览器 · 粘贴回调地址」入口",
      )

      // 手机上没有 Windows 进程可读 —— 「从本机导入」不该出现
      assert.equal(
        list.some((m) => /从本机 Marvis 导入/.test(m.label)),
        false,
        "手机端不该出现「从本机 Marvis 导入」",
      )

      // 网关占位若出现，必须排在真登录之后（它只是不上传凭据的本地占位）
      const gw = list.findIndex((m) => /本地网关/.test(m.label))
      if (gw >= 0) assert.ok(gw >= 2, `网关占位应排在真登录之后，实际在第 ${gw + 1} 位`)
    },
  )
})

test("methods：桌面环境 —— 保持原来的顺序（桌面路径零改动）", async () => {
  const { methods } = await import("../src/hooks/methods.mjs")
  await withEnv(
    {
      PREFIX: undefined,
      ANDROID_ROOT: undefined,
      MARVIS_TRANSPORT: undefined,
      MARVIS_WS_MODE: undefined,
      MARVIS_GATEWAY_URL: undefined,
      MARVIS_GATEWAY_KEY: undefined,
    },
    () => {
      const list = methods()
      assert.match(list[0].label, /^QQ 登录$/, "桌面第一条仍是隔离浏览器 QQ 登录")
      assert.match(list[1].label, /^微信登录$/, "桌面第二条仍是隔离浏览器微信登录")
      // 桌面保留「从本机导入」与两条手动粘贴
      assert.ok(list.some((m) => /从本机 Marvis 导入/.test(m.label)))
      assert.ok(list.some((m) => /粘贴回调地址/.test(m.label)))
    },
  )
})

test("methods：桌面端隔离浏览器路径不受手机端改动影响（opened:true + method:auto）", async () => {
  const { methods } = await import("../src/hooks/methods.mjs")
  await withEnv(
    {
      PREFIX: undefined,
      ANDROID_ROOT: undefined,
      MARVIS_TRANSPORT: undefined,
      MARVIS_WS_MODE: undefined,
      MARVIS_GATEWAY_URL: undefined,
      MARVIS_GATEWAY_KEY: undefined,
    },
    async () => {
      const list = methods()
      const desktop = list.filter((m) => /^QQ 登录$|^微信登录$/.test(m.label))
      assert.equal(desktop.length, 2)
      for (const m of desktop) {
        const r = await m.authorize()
        await r.cancel?.()
        assert.equal(r.opened, true, `${m.label} 桌面端必须 opened:true（自己开隔离浏览器）`)
        assert.equal(r.method, "auto", `${m.label} 桌面端必须 method:"auto"（CDP 自动拦截）`)
      }
    },
  )
})

test("手机端 QQ 授权页用 display=mobile（否则渲染 PC 表单、不唤起 App）", async () => {
  const { methods } = await import("../src/hooks/methods.mjs")
  await withEnv(
    { PREFIX: "/data/data/com.termux/files/usr", MARVIS_WS_MODE: undefined, MARVIS_GATEWAY_URL: undefined },
    async () => {
      const list = methods()
      const qq = list.find((m) => /^QQ 登录$/.test(m.label))
      const r = await qq.authorize()
      await r.cancel?.()
      const u = new URL(r.url)
      assert.equal(u.host, "graph.qq.com")
      assert.equal(u.searchParams.get("display"), "mobile", "手机端 QQ 必须 display=mobile")
    },
  )
})

test("qqAppLaunchUrl：mqqapi://forward/url 能唤起手机 QQ App", async () => {
  const { qqAppLaunchUrl } = await import("../src/marvis/mobile-login.mjs")
  const https = "https://graph.qq.com/oauth2.0/authorize?display=mobile&client_id=1"
  const u = qqAppLaunchUrl(https)
  assert.match(u, /^mqqapi:\/\/forward\/url\?url=/, "必须用 QQ 互联的转发 scheme")
  // 目标地址必须被完整编码（里面有 ? & = 直接拼会被截断）
  assert.equal(new URL(u).searchParams.get("url"), https)
})

test("wxAppLaunchUrl：weixin:// 唤起微信本体（不带假 URL，授权链接靠复制粘贴）", async () => {
  const { wxAppLaunchUrl } = await import("../src/marvis/mobile-login.mjs")
  assert.equal(wxAppLaunchUrl(), "weixin://")
})

test("本地登录页：同时提供「唤起 QQ 按钮」和「粘贴框」", async () => {
  const { startPasteServer } = await import("../src/marvis/mobile-login.mjs")
  const authUrl = "https://graph.qq.com/oauth2.0/authorize?display=mobile&client_id=1903794758"
  const s = await startPasteServer({
    loginType: "QC",
    guid: "9".repeat(32),
    authorizeUrl: authUrl,
    port: 0,
    timeoutMs: 5000,
  })
  try {
    const html = await (await fetch(s.url)).text()
    // 唤起 App 的按钮（QQ 用 mqqapi://）
    assert.match(html, /mqqapi:\/\/forward\/url/, "页面必须有唤起 QQ App 的入口")
    // 没装 QQ 时的网页版兜底
    assert.match(html, /用浏览器打开 QQ 授权页/, "必须有网页版兜底链接")
    // 粘贴框
    assert.match(html, /<textarea/, "页面必须有粘贴框")
    assert.match(html, /name="callback"/)
    // QQ 的 mqqapi:// 自带 URL，不需要「先复制再粘贴」，别把微信那套脚本塞进 QQ 页
    assert.doesNotMatch(html, /copyAndGo/, "QQ 页不该出现微信的复制跳转脚本")
  } finally {
    s.close()
  }
})

test("本地登录页：微信页给「唤起微信 + 复制授权链接」，不用假的 scheme", async () => {
  const { startPasteServer } = await import("../src/marvis/mobile-login.mjs")
  const authUrl = "https://open.weixin.qq.com/connect/qrconnect?appid=x"
  const s = await startPasteServer({
    loginType: "WX",
    guid: "8".repeat(32),
    authorizeUrl: authUrl,
    port: 0,
    timeoutMs: 5000,
  })
  try {
    const html = await (await fetch(s.url)).text()
    assert.match(html, /href="weixin:\/\//, "唤起微信必须是主按钮上的真链接（不是页面里随便一处字样）")
    assert.match(html, /复制授权链接/, "微信页必须有复制授权链接按钮")
    assert.match(html, /onclick="copyWxUrl\(\)"/, "复制按钮必须挂上脚本，不能只是文案")
    assert.match(html, /function copyWxUrl\(/, "复制脚本本体必须在页面里")
    assert.match(html, /<input[^>]*id="wx-auth-url"/, "必须有可复制的授权链接输入框本体")
    assert.match(html, /id="wx-copy-btn"/, "复制按钮要有稳定 id，别靠 DOM 位置猜")
    assert.match(html, /getElementById\('wx-copy-btn'\)/, "「已复制 ✓」的回写必须按 id 定位按钮")
    assert.match(html, /value="https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/, "输入框必须回显本次授权页地址")
    assert.match(html, /一台手机扫不了自己的码/, "必须明说不要走保存图片扫码那条链路")
    assert.match(html, /备用：用系统浏览器打开授权页/, "必须保留系统浏览器兜底链接")
    assert.doesNotMatch(html, /mqqapi:\/\//, "微信页不该用 QQ 的 scheme")
    assert.doesNotMatch(html, /识别图中二维码/, "微信页不再教长按识别二维码")
    assert.match(html, /点下面的按钮唤起微信/, "第 1 步文案必须与按钮真实行为一致（只唤起，不完成授权）")
    assert.doesNotMatch(html, /点下面的按钮完成微信授权/, "点一下不会完成授权，别写这种误导句")
    assert.match(html, /onclick="return copyAndGo\(\)"/, "主按钮要点一次就同时复制链接，别让用户来回切 App")
    assert.match(html, /function copyAndGo\(/, "copyAndGo 脚本本体必须在页面里")
    assert.match(html, /同时把授权链接复制到剪贴板/, "要把「顺手复制」这件事写在按钮旁边")
    assert.match(html, /<textarea/, "同样要有粘贴框")
  } finally {
    s.close()
  }
})