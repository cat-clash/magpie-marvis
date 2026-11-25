// import-login.mjs —— 把电脑端导出的登录态合并进手机 plugin-auth.json
//
// 为什么需要它：微信给 Marvis 的 appid 开的是「网站应用扫码登录」（qrconnect），
// 微信已禁止长按/相册识别二维码，所以一台手机自己扫自己是死路（真机 10005 / 扫码提醒页）。
// 电脑端已经登录好的一份 marvis# 凭据，直接搬过去最快。
//
// 跑法：node --test tests/import-login.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dirname, "..", "scripts", "import-login.mjs")

const DESKTOP = {
  "marvis#ftv1l6": {
    access: "ACCESS-FROM-DESKTOP",
    refresh: "REFRESH-FROM-DESKTOP",
    expires: 1798147312115,
    accountId: "QQ·1",
    uid: "7112B71CBC19ABCE6160066A637266F0",
    loginType: 1,
    nickname: "1",
    metadata: { openid: "OPENID-DESK", loginType: 1 },
  },
}

const OTHER_ACCOUNTS = {
  "trae-auth#abc": { access: "TRAE-ACCESS" },
}

const dirs = []
function fixture(targetJson) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-import-test-"))
  dirs.push(dir)
  if (targetJson !== null) {
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(targetJson, null, 2) + "\n", "utf8")
  }
  return dir
}
function sourceFile(json) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-import-src-"))
  dirs.push(dir)
  const file = join(dir, "login.json")
  writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json, null, 2), "utf8")
  return file
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }
}
function readTarget(dir) {
  const file = join(dir, "plugin-auth.json")
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf8"))
}
function backups(dir) {
  return readdirSync(dir).filter((n) => n.includes(".bak-"))
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test("--help：打印用法并退出 0", () => {
  const r = run(["--help"])
  assert.equal(r.code, 0)
  assert.match(r.out, /用法/)
  assert.match(r.out, /--dry-run/)
  assert.match(r.out, /--overwrite/)
})

test("没有文件参数：打印用法并退出 1", () => {
  const r = run([])
  assert.equal(r.code, 1)
  assert.match(r.out, /用法/)
})

test("源文件不存在：退出 1 且报路径", () => {
  const dir = fixture(null)
  const r = run([join(dir, "nope.json"), "--config", dir, "--yes"])
  assert.equal(r.code, 1)
  assert.match(r.out, /找不到源文件/)
})

test("源文件不是合法 JSON：退出 1", () => {
  const dir = fixture(null)
  const src = sourceFile("{ not json")
  const r = run([src, "--config", dir, "--yes"])
  assert.equal(r.code, 1)
  assert.match(r.out, /不是合法 JSON/)
})

test("源文件里没有 marvis# 键：拒绝导入（不碰别的插件的凭据）", () => {
  const dir = fixture(null)
  const src = sourceFile({ "trae-auth#abc": { access: "X" } })
  const r = run([src, "--config", dir, "--yes"])
  assert.equal(r.code, 1)
  assert.match(r.out, /没有 marvis#/)
  assert.equal(readTarget(dir), null, "不该写盘")
})

test("--dry-run：只打印计划，不写盘、不建文件", () => {
  const dir = fixture(null)
  const src = sourceFile(DESKTOP)
  const r = run([src, "--config", dir, "--dry-run"])
  assert.equal(r.code, 0)
  assert.match(r.out, /\[dry-run\]/)
  assert.match(r.out, /\+ marvis#ftv1l6/)
  assert.equal(existsSync(join(dir, "plugin-auth.json")), false, "dry-run 不许建文件")
})

test("正常导入（--yes）：写入 + 备份 + 值原样搬过来", () => {
  const dir = fixture({ ...OTHER_ACCOUNTS })
  const src = sourceFile(DESKTOP)
  const r = run([src, "--config", dir, "--yes", "--json"])
  assert.equal(r.code, 0)
  const result = JSON.parse(r.out)
  assert.equal(result.count, 1)
  assert.deepEqual(result.plan.map((p) => p.action), ["add"])
  assert.ok(result.backup, "必须留备份")
  const target = readTarget(dir)
  assert.equal(target["marvis#ftv1l6"].access, "ACCESS-FROM-DESKTOP")
  assert.equal(target["marvis#ftv1l6"].uid, "7112B71CBC19ABCE6160066A637266F0")
  assert.equal(target["trae-auth#abc"].access, "TRAE-ACCESS", "别的插件的账号必须原样保留")
  assert.equal(backups(dir).length, 1, "写盘前要备份一次")
})

test("目标文件不存在（手机第一次导入）：自动建目录与文件", () => {
  const dir = fixture(null)
  const src = sourceFile(DESKTOP)
  const r = run([src, "--config", dir, "--yes"])
  assert.equal(r.code, 0)
  const target = readTarget(dir)
  assert.equal(target["marvis#ftv1l6"].refresh, "REFRESH-FROM-DESKTOP")
})

test("目标已有同名键：默认跳过、退出 0、不写盘", () => {
  const dir = fixture({ "marvis#ftv1l6": { access: "OLD" } })
  const src = sourceFile(DESKTOP)
  const before = readTarget(dir)
  const r = run([src, "--config", dir, "--yes", "--json"])
  assert.equal(r.code, 0)
  const result = JSON.parse(r.out)
  assert.equal(result.count, 0)
  assert.match(result.plan[0].reason, /--overwrite/)
  assert.deepEqual(readTarget(dir), before, "默认不许覆盖已有登录态")
  assert.equal(backups(dir).length, 0, "没写盘就不该产生备份")
})

test("--overwrite：覆盖同名键并留备份", () => {
  const dir = fixture({ "marvis#ftv1l6": { access: "OLD" } })
  const src = sourceFile(DESKTOP)
  const r = run([src, "--config", dir, "--yes", "--overwrite", "--json"])
  assert.equal(r.code, 0)
  const result = JSON.parse(r.out)
  assert.equal(result.count, 1)
  assert.equal(result.plan[0].action, "overwrite")
  assert.equal(readTarget(dir)["marvis#ftv1l6"].access, "ACCESS-FROM-DESKTOP")
  assert.equal(backups(dir).length, 1)
})

test("条目没有 access/refresh：跳过，不算命中", () => {
  const dir = fixture(null)
  const src = sourceFile({ "marvis#empty": { accountId: "QQ·x" } })
  const r = run([src, "--config", dir, "--yes", "--json"])
  assert.equal(r.code, 0)
  const result = JSON.parse(r.out)
  assert.equal(result.count, 0)
  assert.match(result.plan[0].reason, /没有 access/)
})

test("非交互环境没给 --yes：拒写并退出 1", () => {
  const dir = fixture(null)
  const src = sourceFile(DESKTOP)
  const r = run([src, "--config", dir])
  assert.equal(r.code, 1)
  assert.match(r.out, /--yes/)
  assert.equal(existsSync(join(dir, "plugin-auth.json")), false, "没确认不许写")
})

test("未知参数：退出 1 并指出参数名", () => {
  const r = run(["--nope"])
  assert.equal(r.code, 1)
  assert.match(r.out, /未知参数：--nope/)
})