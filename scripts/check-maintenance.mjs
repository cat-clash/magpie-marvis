#!/usr/bin/env node
// 维护检查 —— 查「这个插件还维护得下去吗」，不是「它写对了吗」。
//
//   node scripts/check-maintenance.mjs            # 检查当前目录
//   node scripts/check-maintenance.mjs ../my-plugin
//
// 退出码 0 = 维护状态正常，1 = 有会让用户拿不到更新的问题。
//
// 为什么需要它：插件不是一次性产物。最常见的失配不是代码写错，而是 ——
//   · 改了代码，直接 git push，**不发新版本**（git 源的用户永远停在旧 commit）
//   · 版本号没动，用户那边 magpie 比版本号相等 ⇒ 认为「没有更新」
//   · 发了新版本但没打 tag ⇒ GitHub 上「暂无发布版本」，Release 是空的
//   · 三个版本跳着发，中间两个没 tag ⇒ 用户不知道中间改了什么
// 这些都不报错，只是「用户永远拿不到新版」。这和写完就不管是同一种后果。
//
// 它只看 git 与 package.json / CHANGELOG，不需要网络。

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = resolve(process.argv[2] ?? ".")
const results = []
const ok = (cond, name, note, fix) => results.push({ level: cond ? "pass" : "fail", name, note, fix })
const warn = (cond, name, note, fix) => results.push({ level: cond ? "pass" : "warn", name, note, fix })

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 30000 })
  if (r.status !== 0) return null
  return (r.stdout ?? "").trim()
}

// ── 读 package.json ──────────────────────────────────────────────────

let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
} catch {
  console.log("\n没有可读的 package.json —— 不是一个 npm 包，维护检查不适用\n")
  process.exit(0)
}
const version = String(pkg.version ?? "")

// ── ① 是不是 git 仓库 ────────────────────────────────────────────────

const isGit = git(["rev-parse", "--is-inside-work-tree"]) === "true"
if (!warn(isGit, "是 git 仓库", "维护依赖版本历史；没有 git 就只能靠文件名记版本", "git init 并把当前状态作为首个 commit")) {
  report()
}

// ── ② tag / Release 策略：本仓库**不使用** tag 与 GitHub Release ─────
// 2026-11-29 起按 git HEAD 分发：tag 与 Releases 全空是有意为之
// （`.github/workflows/release.yml` 与 `scripts/release.mjs` 已删除）。
// 所以「没打 tag」不再是失败项。若以后回到 tag 发布，把 else 分支的
// results.push 换回 ok(...) 即可。

const tags = (git(["tag", "--list", "v*", "--sort=-v:refname"]) ?? "").split("\n").filter(Boolean)
const lastTag = tags[0] ?? null
const currentTag = `v${version}`

if (tags.length === 0) {
  results.push({
    level: "pass",
    name: "不使用 tag / GitHub Release（按 git HEAD 分发）",
    note: "Releases 为空是设计选择，不是遗漏：用户直接从仓库取最新 HEAD",
  })
} else {
  ok(tags.includes(currentTag),
     `当前版本 ${version} 有 tag（${currentTag}）`,
     "既然已有 tag 体系，却漏打当前版本 ⇒ 用户看到的版本会落后",
     `git tag ${currentTag} && git push origin ${currentTag}`)
}

// ── ④ 自上次 tag 以来，代码变了但版本没变 ────────────────────────────
// 这就是「直接覆盖仓库不发新版本」：git 源的用户永远停在旧 commit，
// 而作者以为「我 push 了，大家应该拿到了」。

const CODE = /\.(mjs|js|cjs|ts|tsx|json)$/
const changedSince = (() => {
  const committed = (git(["diff", "--name-only", `${lastTag}..HEAD`]) ?? "").split("\n").filter(Boolean)
  const dirty = (git(["status", "--porcelain"]) ?? "")
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
  return [...new Set([...committed, ...dirty])].filter((f) => CODE.test(f) && !f.startsWith("package-lock"))
})()

// 无 tag 体系时本条不适用：没有「上次发布」这个基准
if (!lastTag) {
  results.push({
    level: "pass",
    name: "无 tag 基准 ⇒ 跳过「版本号是否跟上代码」检查",
    note: "按 git HEAD 分发时，版本号只用于显示，不参与更新判定",
  })
} else {
  const versionBumped = `v${version}` !== lastTag
  if (changedSince.length > 0) {
    ok(versionBumped,
       "自上次 tag 以来改了代码 ⇒ 版本号也跟着变了",
       `改了 ${changedSince.length} 个代码文件但 version 还是 ${lastTag?.slice(1)} —— ` +
       `magpie 比的是版本号，相等就认为「没有更新」，git 源的用户永远停在旧 commit`,
       `改完就 bump：npm version patch --no-git-tag-version（然后按 UPDATING 七步走）`)
  } else {
    warn(true, "自上次 tag 以来没有代码改动", "要么还没开始改，要么已经发布过了", "")
  }
}

// ── ⑤ CHANGELOG 有没有当前版本这一节 ─────────────────────────────────

const changelog = existsSync(join(ROOT, "CHANGELOG.md")) ? readFileSync(join(ROOT, "CHANGELOG.md"), "utf8") : ""
ok(changelog.includes(version),
   `CHANGELOG 有 ${version} 这一节`,
   "没有更新日志 ⇒ 用户不知道升上去改了什么，出问题也没法回滚到「哪个版本是好的」",
   `在 CHANGELOG.md 顶部加「## ${version} — <日期>」一节`)

// ── ⑥ 跳版本：中间版本没 tag ─────────────────────────────────────────
// 比如 0.1.16 → 0.1.20，中间三个版本只 commit 没 tag。用户拿不到中间任何一版，
// 也没法说清「我在哪个版本上遇到的 bug」。

function parseSemver(s) {
  const m = String(s).match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const from = parseSemver(lastTag ?? "")
const to = parseSemver(currentTag)
if (from && to) {
  const missing = []
  // 只枚举同一 minor 下的中间 patch（跨 minor 的跳版是正常的）
  if (from[0] === to[0] && from[1] === to[1] && to[2] - from[2] > 1) {
    for (let p = from[2] + 1; p < to[2]; p++) {
      const t = `v${from[0]}.${from[1]}.${p}`
      if (!tags.includes(t)) missing.push(t)
    }
  }
  warn(missing.length === 0,
       "没有跳过版本（中间每个版本都打了 tag）",
       `这几个版本只 commit 没打 tag：${missing.join(" / ")} —— 用户拿不到中间任何一版，也说不清自己在哪版上出的问题`,
       "补 tag：git tag <tag> <commit>（补历史版本是可以的，不改代码）")
}

// ── 输出 ──────────────────────────────────────────────────────────────

report()

function report() {
  const fails = results.filter((r) => r.level === "fail")
  const warns = results.filter((r) => r.level === "warn")
  const mark = { pass: "\x1b[32m✓\x1b[0m", fail: "\x1b[31m✗\x1b[0m", warn: "\x1b[33m!\x1b[0m" }
  console.log(`\n维护检查 · ${ROOT}\n`)
  for (const r of results) {
    console.log(`  ${mark[r.level]} ${r.name}`)
    if (r.level !== "pass" && r.note) console.log(`      ${r.note}`)
    if (r.level !== "pass" && r.fix && r.fix.length > 0) console.log(`      → ${r.fix}`)
  }
  console.log(`\n  通过 ${results.filter((r) => r.level === "pass").length} · 警告 ${warns.length} · 失败 ${fails.length}\n`)
  if (fails.length) {
    console.log("  这些问题的后果是同一个：**用户永远拿不到新版**。而本地一切看起来都对。\n")
  }
  process.exit(fails.length ? 1 : 0)
}
