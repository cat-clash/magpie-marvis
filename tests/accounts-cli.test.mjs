// accounts CLI —— 取消登录 / 移除账号的离线测试
//
// 覆盖 scripts/accounts.mjs 的四条硬规矩：
//   ① logout 写的是 access:"" + refresh:"" + expires:1000 + metadata.revokedAt，
//      且 accountId / uid / metadata 其余键**原样保留**（重新登录要复用卡片名与 guid）；
//   ② expires 绝不能写 0 / 删字段（0 = 「到期未知」，壳会当它未过期）；
//   ③ remove 是整条键删除；
//   ④ 写盘前必有 .bak-* 备份；--dry-run 一律不落盘。
// 外加选择器解析：整键 / uid / 卡片名 / 歧义 exit 2 / 找不到 exit 1。
//
// 跑法：node --test tests/accounts-cli.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dirname, "..", "scripts", "accounts.mjs")

/** 造一个隔离的 magpie 配置目录，写入给定账号表 */
function fixture(json) {
  const dir = mkdtempSync(join(tmpdir(), "magpie-accounts-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify(json, null, 2) + "\n", "utf8")
  return dir
}

function run(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--config", dir], { encoding: "utf8" })
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), json: readJson(dir) }
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
const cleanup = []

function fixtureTracked(json) {
  const dir = fixture(json)
  cleanup.push(dir)
  return dir
}

test("list：只列本插件账号，带状态与可用选择器", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["list"])
  assert.equal(r.code, 0)
  assert.match(r.out, /共 2 个账号/, "不能把 other#999 也算进来")
  assert.doesNotMatch(r.out, /NOT-OURS/)
  assert.match(r.out, /QQ·阿伟/)
  assert.match(r.out, /marvis#111/)
})

test("list：剩余时间按量级显示（不足 1 小时别显示「剩 0h」）", () => {
  const dir = fixtureTracked({
    "marvis#mins": {
      access: "A",
      refresh: "R",
      expires: Date.now() + 30 * 60_000,
      accountId: "QQ·半小时",
      uid: "U1",
      metadata: { loginType: "1" },
    },
    "marvis#soon": {
      access: "A",
      refresh: "R",
      expires: Date.now() + 90_000,
      accountId: "QQ·一分半",
      uid: "U2",
      metadata: { loginType: "1" },
    },
    "marvis#dead": {
      access: "A",
      refresh: "R",
      expires: Date.now() - 60_000,
      accountId: "QQ·过期",
      uid: "U3",
      metadata: { loginType: "1" },
    },
  })
  const r = run(dir, ["list"])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /剩 0h/, "「剩 0h」会被误读成已过期")
  assert.match(r.out, /剩 (29|30)m/, "半小时级要落到分钟")
  assert.match(r.out, /即将过期/)
  assert.match(r.out, /已过期/)
})

test("list --json：结构化输出含 key/uid/类型/状态", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["list", "--json"])
  assert.equal(r.code, 0)
  const arr = JSON.parse(r.out)
  assert.equal(arr.length, 2)
  assert.equal(arr[0].key, "marvis#111")
  assert.equal(arr[0].loginType, "QQ")
  assert.equal(arr[1].loginType, "微信")
})

test("logout：清凭据 + expires 写正数过去值 + 保留身份与 metadata 其余键", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["logout", "marvis#111", "--yes"])
  assert.equal(r.code, 0, r.out)
  const acct = r.json["marvis#111"]
  assert.equal(acct.access, "", "access 必须清空（不能留占位串，否则会带假 token 出网）")
  assert.equal(acct.refresh, "", "refresh 必须清空，否则壳会自动续期把账号复活")
  assert.ok(typeof acct.expires === "number" && acct.expires > 0 && acct.expires < Date.now(), "expires 必须是正数且已过")
  assert.notEqual(acct.expires, 0, "0 = 到期未知，壳会当它未过期")
  assert.ok(acct.metadata.revokedAt > 0, "要打 revokedAt 标记，loader 据此走「需要重新登录」")
  assert.equal(acct.accountId, "QQ·阿伟", "卡片名保留")
  assert.equal(acct.uid, "OPENID-A", "身份保留")
  assert.equal(acct.metadata.guid, "a".repeat(32), "虚拟设备 guid 保留（重登复用）")
  assert.equal(acct.metadata.loginType, "1")
})

test("logout：不动其他账号，也不动非本插件条目", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["logout", "OPENID-A", "--yes"])
  assert.equal(r.code, 0)
  assert.deepEqual(r.json["marvis#222"], TWO_ACCOUNTS["marvis#222"], "按 uid 命中一条，另一条必须一字不动")
  assert.deepEqual(r.json["other#999"], { access: "NOT-OURS" })
})

test("logout：写盘前留 .bak 备份", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["logout", "微信·同号", "--yes"])
  assert.equal(r.code, 0, r.out)
  const baks = readdirSync(dir).filter((f) => f.startsWith("plugin-auth.json.bak-"))
  assert.ok(baks.length >= 1, "必须有备份文件")
  const bak = JSON.parse(readFileSync(join(dir, baks[0]), "utf8"))
  assert.equal(bak["marvis#222"].access, "ACC-B", "备份里是改动前的原值")
})

test("logout --dry-run：打印 diff 但不写盘", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["logout", "marvis#111", "--dry-run"])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /before/, "要能看到改动前")
  assert.match(r.out, /after/, "要能看到改动后")
  assert.equal(r.json["marvis#111"].access, "ACC-A", "--dry-run 绝不能写盘")
  assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 0, "--dry-run 不该产生备份")
})

test("logout：重复执行幂等，第二次不改 revokedAt", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const first = run(dir, ["logout", "marvis#111", "--yes"])
  assert.equal(first.code, 0)
  const stamp = first.json["marvis#111"].metadata.revokedAt
  const second = run(dir, ["logout", "marvis#111", "--yes"])
  assert.equal(second.code, 0, second.out)
  assert.equal(second.json["marvis#111"].metadata.revokedAt, stamp, "已取消的账号不该被重新打标")
})

test("remove：整条键删除，其他条目原样", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["remove", "marvis#222", "--yes"])
  assert.equal(r.code, 0, r.out)
  assert.ok(!("marvis#222" in r.json), "整条必须删掉")
  assert.deepEqual(r.json["marvis#111"], TWO_ACCOUNTS["marvis#111"])
  assert.deepEqual(r.json["other#999"], { access: "NOT-OURS" })
})

test("remove --dry-run：不写盘", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["remove", "marvis#222", "--dry-run"])
  assert.equal(r.code, 0, r.out)
  assert.ok("marvis#222" in r.json)
})

test("选择器：重名 accountId 走歧义 exit 2 并列出候选", () => {
  const dir = fixtureTracked({
    "marvis#111": { ...TWO_ACCOUNTS["marvis#111"], accountId: "同号" },
    "marvis#222": { ...TWO_ACCOUNTS["marvis#222"], accountId: "同号" },
  })
  const r = run(dir, ["logout", "同号", "--yes"])
  assert.equal(r.code, 2, "accountId 重名必须判歧义，不能猜第一条")
  assert.match(r.out, /marvis#111/)
  assert.match(r.out, /marvis#222/)
  assert.equal(r.json["marvis#111"].access, "ACC-A", "歧义时一条都不许动")
})

test("选择器：同 uid（网关占位号重复）也判歧义", () => {
  const dir = fixtureTracked({
    "marvis#gw1": { ...TWO_ACCOUNTS["marvis#111"], uid: "gateway-local" },
    "marvis#gw2": { ...TWO_ACCOUNTS["marvis#222"], uid: "gateway-local" },
  })
  const r = run(dir, ["remove", "gateway-local", "--yes"])
  assert.equal(r.code, 2)
})

test("选择器：找不到目标 exit 1", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = run(dir, ["logout", "查无此人", "--yes"])
  assert.equal(r.code, 1)
  assert.match(r.out, /没有账号匹配/)
})

test("文件缺失：exit 1 且不创建文件", () => {
  const dir = fixtureTracked({})
  rmSync(join(dir, "plugin-auth.json"))
  const r = run(dir, ["list"])
  assert.equal(r.code, 1)
  assert.equal(r.json, null, "list 不许顺手创建 plugin-auth.json")
})

test("非交互无 --yes：拒绝写入（stdin 非 TTY）", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const r = spawnSync(process.execPath, [SCRIPT, "logout", "marvis#111", "--config", dir], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: "",
  })
  assert.equal(r.status, 1, "非交互环境必须要求 --yes")
  const json = readJson(dir)
  assert.equal(json["marvis#111"].access, "ACC-A", "没确认就不能写盘")
})

test("--all：logout 支持批量，remove 明确拒绝", () => {
  const dir = fixtureTracked(TWO_ACCOUNTS)
  const out = run(dir, ["logout", "--all", "--yes"])
  assert.equal(out.code, 0, out.out)
  assert.equal(out.json["marvis#111"].access, "")
  assert.equal(out.json["marvis#222"].access, "")

  const dir2 = fixtureTracked(TWO_ACCOUNTS)
  const bad = run(dir2, ["remove", "--all", "--yes"])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /不支持 --all/)
  assert.ok("marvis#111" in bad.json)
})
