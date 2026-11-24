// 账号管理页（src/marvis/account-manager.mjs）—— 离线测试
//
// 背景：magpie 壳对「首选」账号不渲染移除按钮（壳侧 UI，插件 auth 协议没有
// remove/logout 扩展点）。0.7.6 把账号管理做成一个登录方法：点它 → 本机管理页
// → 每个账号（包括首选）都有「取消登录 / 移除」按钮。
//
// 这里钉住的硬规矩：
//   ① 页面对每个账号都渲染两个动作按钮（首选也不例外 —— 数据层没有「首选」概念）；
//   ② 取消登录 = access:"" + refresh:"" + expires:1000 + metadata.revokedAt，身份字段保留；
//   ③ 移除 = 整条键删除；两种操作写盘前都有 .bak-* 备份；
//   ④ CSRF：没有/错误 token 一律 403，且不写盘；
//   ⑤ 只认整键：模糊选择器（卡片名/uid 片段）在页面这条路上必须被拒，防误删；
//   ⑥ 并发写冲突 → 409 可读错误，原文件不动；
//   ⑦ 登录方法形状：method:"code" + opened 不为 true（壳才有「打开浏览器」按钮），
//      callback 不产生账号（管理完直接关页面），cancel 释放端口。
//
// 跑法：node --test tests/account-manager.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startAccountManager, accountManagerMethod, managerPage } from "../src/marvis/account-manager.mjs"

const cleanup = []
test.afterEach(() => {
  for (const d of cleanup) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
  cleanup.length = 0
})

const TWO_ACCOUNTS = {
  "marvis#111": {
    access: "ACC-A",
    refresh: "REF-A",
    expires: Date.now() + 86_400_000,
    accountId: "QQ·阿伟",
    uid: "OPENID-A",
    metadata: { openid: "OPENID-A", guid: "a".repeat(32), loginType: "1", nickname: "阿伟" },
  },
  "marvis#222": {
    access: "ACC-B",
    refresh: "REF-B",
    expires: Date.now() + 7_200_000,
    accountId: "微信·同号",
    uid: "OPENID-B",
    metadata: { openid: "OPENID-B", guid: "b".repeat(32), loginType: "2", nickname: "同号" },
  },
  "other#999": { access: "NOT-OURS" },
}

function fixture(json) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-mgr-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(json, null, 2) + "\n", "utf8")
  cleanup.push(dir)
  return dir
}

function readJson(dir) {
  const file = join(dir, "plugin-auth.json")
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

async function withManager(dir, fn) {
  const mgr = await startAccountManager({ dir, port: 0, timeoutMs: 30_000 })
  try {
    return await fn(mgr)
  } finally {
    mgr.close()
  }
}

/** 从页面里抠出一次性 token（真实用户浏览器里是隐藏表单字段） */
async function tokenOf(mgr) {
  const html = await (await fetch(mgr.url)).text()
  const m = html.match(/name="t" value="([0-9a-f]+)"/)
  assert.ok(m, "页面必须带一次性 CSRF token")
  return { html, token: m[1] }
}

async function postAction(mgr, fields) {
  return fetch(`${mgr.url}action`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  })
}

test("管理页：每个账号都有「取消登录」和「移除」按钮（首选账号也不例外）", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { html } = await tokenOf(mgr)
    // 两个账号 × 两个动作 = 4 个提交按钮；数据层没有「首选」概念，谁都有按钮
    assert.equal((html.match(/name="op" value="logout"/g) ?? []).length, 2, "每个账号都要有取消登录按钮")
    assert.equal((html.match(/name="op" value="remove"/g) ?? []).length, 2, "每个账号都要有移除按钮（包括首选）")
    assert.match(html, /QQ·阿伟/)
    assert.match(html, /微信·同号/)
    assert.doesNotMatch(html, /NOT-OURS/, "别的插件的账号不许出现")
    assert.match(html, /完全退出并重启 magpie/, "必须提示重启（壳有内存态）")
    assert.match(html, /127\.0\.0\.1/, "必须说明页面只在本机")
  })
})

test("管理页：取消登录 —— 清凭据、expires:1000、revokedAt，身份字段保留，写前有备份", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    const res = await postAction(mgr, { t: token, key: "marvis#111", op: "logout" })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /已取消登录/)
    const json = readJson(dir)
    const acct = json["marvis#111"]
    assert.equal(acct.access, "")
    assert.equal(acct.refresh, "")
    assert.equal(acct.expires, 1000, "expires 必须是正数且远在当下之前（0=到期未知，壳会当未过期）")
    assert.ok(acct.metadata.revokedAt > 0)
    assert.equal(acct.accountId, "QQ·阿伟", "卡片名保留（重新登录复用）")
    assert.equal(acct.uid, "OPENID-A")
    assert.equal(acct.metadata.guid, "a".repeat(32), "设备 guid 保留")
    // 另一个账号与其他插件条目原样不动
    assert.equal(json["marvis#222"].access, "ACC-B")
    assert.deepEqual(json["other#999"], { access: "NOT-OURS" })
    assert.ok(
      readdirSync(dir).some((f) => f.startsWith("plugin-auth.json.bak-")),
      "写盘前必须有 .bak-* 备份",
    )
  })
})

test("管理页：取消登录幂等 —— 已取消的账号再点一次不重写文件", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    await postAction(mgr, { t: token, key: "marvis#111", op: "logout" })
    const before = readFileSync(join(dir, "plugin-auth.json"), "utf8")
    const backupsBefore = readdirSync(dir).filter((f) => f.includes(".bak-")).length
    const res = await postAction(mgr, { t: token, key: "marvis#111", op: "logout" })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /已是取消登录状态/)
    assert.equal(readFileSync(join(dir, "plugin-auth.json"), "utf8"), before, "幂等：文件内容不变")
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, backupsBefore, "不产生新备份")
  })
})

test("管理页：移除 —— 整条键删除，其他账号不动，写前有备份", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    const res = await postAction(mgr, { t: token, key: "marvis#222", op: "remove" })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /已移除/)
    const json = readJson(dir)
    assert.equal(json["marvis#222"], undefined, "整条删除")
    assert.equal(json["marvis#111"].access, "ACC-A", "别的账号不许动")
    assert.deepEqual(json["other#999"], { access: "NOT-OURS" })
    assert.ok(readdirSync(dir).some((f) => f.startsWith("plugin-auth.json.bak-")))
  })
})

test("管理页：CSRF —— 没有/错误 token 一律 403，且不写盘", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const before = readFileSync(join(dir, "plugin-auth.json"), "utf8")
    const noToken = await postAction(mgr, { key: "marvis#111", op: "remove" })
    assert.equal(noToken.status, 403)
    const badToken = await postAction(mgr, { t: "0".repeat(32), key: "marvis#111", op: "remove" })
    assert.equal(badToken.status, 403)
    assert.equal(readFileSync(join(dir, "plugin-auth.json"), "utf8"), before, "CSRF 失败不许写盘")
    assert.equal(readdirSync(dir).some((f) => f.includes(".bak-")), false, "也不许产生备份")
  })
})

test("管理页：只认整键 —— 模糊选择器（卡片名/uid）必须被拒，防误删", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    const before = readFileSync(join(dir, "plugin-auth.json"), "utf8")
    for (const key of ["QQ·阿伟", "OPENID-A", "111", "marvis#"]) {
      const res = await postAction(mgr, { t: token, key, op: "remove" })
      assert.equal(res.status, 400, `选择器「${key}」不是整键，必须拒绝`)
    }
    assert.equal(readFileSync(join(dir, "plugin-auth.json"), "utf8"), before, "模糊选择器不许写盘")
  })
})

test("管理页：并发写冲突 —— 页面打开后文件被别处改写 → 409，原文件不动", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    // 模拟壳在用户操作期间写回了另一个账号（刷新 token 等）
    const changed = JSON.parse(JSON.stringify(TWO_ACCOUNTS))
    changed["marvis#222"].access = "ACC-B-REFRESHED"
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(changed, null, 2) + "\n", "utf8")
    const res = await postAction(mgr, { t: token, key: "marvis#111", op: "logout" })
    assert.equal(res.status, 409)
    const html = await res.text()
    assert.match(html, /完全退出 magpie/, "冲突时要给出可行动的下一步")
    const json = readJson(dir)
    assert.equal(json["marvis#111"].access, "ACC-A", "冲突时原文件不动")
    assert.equal(json["marvis#222"].access, "ACC-B-REFRESHED", "别处的改写不能被覆盖")
  })
})

test("管理页：不存在的整键 / 不认识的 op → 400，不写盘", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  await withManager(dir, async (mgr) => {
    const { token } = await tokenOf(mgr)
    const gone = await postAction(mgr, { t: token, key: "marvis#999", op: "remove" })
    assert.equal(gone.status, 400)
    const badOp = await postAction(mgr, { t: token, key: "marvis#111", op: "nuke" })
    assert.equal(badOp.status, 400)
    assert.equal(readJson(dir)["marvis#111"].access, "ACC-A")
  })
})

test("管理页：没有账号文件时给可读提示，不崩", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-mgr-empty-"))
  cleanup.push(dir)
  await withManager(dir, async (mgr) => {
    const res = await fetch(mgr.url)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /没有找到|还没有账号/, "空目录要给用户可读的说明")
  })
})

test("accountManagerMethod：登录方法形状 —— code + 不 opened，url 是本机管理页，cancel 释放端口", async () => {
  const dir = fixture(TWO_ACCOUNTS)
  const m = accountManagerMethod({ dir })
  assert.equal(m.type, "oauth")
  assert.match(m.label, /账号管理/)
  const r = await m.authorize()
  try {
    assert.equal(r.method, "code", "必须 method:'code'（与手机登录入口同一套壳渲染规矩）")
    assert.notEqual(r.opened, true, "不能 opened:true，壳才显示「打开浏览器」按钮")
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.match(r.instructions, /取消登录/)
    assert.match(r.instructions, /移除/)
    assert.match(r.instructions, /重启 magpie/)
    assert.match(r.instructions, /不需要.*粘贴/, "要说明管理完不用粘贴任何东西")
    // callback 不产生账号：用户误在输入框里提交时给可读错误，而不是假登录
    await assert.rejects(() => r.callback("", {}, undefined), /不是登录入口/)
  } finally {
    await r.cancel()
  }
  const after = await fetch(r.url).then(
    () => "STILL_OPEN",
    () => "CLOSED",
  )
  assert.equal(after, "CLOSED", "cancel 之后端口必须释放")
  await r.cancel() // close 幂等
})

test("managerPage：HTML 转义 —— 账号名里的 <script> 不许原样进页面", () => {
  const html = managerPage({
    token: "abc",
    rows: [
      {
        key: "marvis#<x>",
        accountId: '<script>alert(1)</script>',
        nickname: "",
        uid: "",
        loginType: "QQ",
        state: "有效",
      },
    ],
    file: "/tmp/plugin-auth.json",
  })
  assert.doesNotMatch(html, /<script>alert/, "账号名必须转义（plugin-auth.json 是不可信输入）")
  assert.match(html, /&lt;script&gt;/)
})