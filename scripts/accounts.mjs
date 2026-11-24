#!/usr/bin/env node
// accounts.mjs —— 账号管理 CLI：列出 / 取消登录状态 / 移除
//
//   node scripts/accounts.mjs list
//   node scripts/accounts.mjs logout "<marvis#键 | uid | 卡片名>" [--dry-run] [--yes]
//   node scripts/accounts.mjs remove "<同上>" [--dry-run] [--yes]
//
// 为什么需要它：magpie 壳的账号卡片没有可靠的「移除」入口（第一个账号点移除没反应，
// 壳侧行为插件管不到），而账号数据本体就在壳的 plugin-auth.json 里 —— 这里直接对
// 那份文件做**可审计的最小修改**，让每一个账号都能取消登录、也能整条删掉。
//
// ═══ 两个动作的精确定义 ═══════════════════════════════════════════════
//   取消登录（logout）：access:"" + refresh:"" + expires:1000 + metadata.revokedAt=now
//     · access/refresh 置**空串**（不是占位字符串）：refresh 空 → src/hooks/refresh.mjs:57
//       直接短路，账号不会被自动续期"复活"；access 空 → src/hooks/loader.mjs 凭据不齐，
//       不会带着假 token 出网把"已取消"伪装成"登录过期"。
//     · expires 必须写**正数且远在当下之前**（1000ms）。绝不能写 0 或删字段：
//       src/marvis/expiry.mjs 规定 0/缺失/负数 = "不知道过期时间"，壳会当它**未过期**。
//     · accountId / uid / metadata 其余键全部保留：重新登录时卡片名与设备 guid 复用。
//   移除（remove）：整条键删除。插件没有任何上游登出/吊销接口（协议层只有 oauth/refresh），
//     删除只是本地清凭据，远端会话由 token 自然过期兜底；guid 是每次登录独立的虚拟设备号，
//     删一条不影响其他号。
//
// ═══ 与壳并发写的安全（壳随时会写回 plugin-auth.json）═══════════════════
//   1. 乐观并发控制：写前重读磁盘，除目标键外任何条目变了 → 放弃并提示先退出 magpie；
//   2. 备份：写前 copyFile 到 <file>.bak-<epoch>，路径打进输出；
//   3. 原子写：先写 <file>.tmp 再同目录 rename，壳不会读到半截 JSON；
//   4. 收尾固定提示重启 magpie —— 壳内存态可能仍持旧账号，重启前别在 magpie 里点该号。
//
// 退出码：0 成功 / 1 环境或目标错误（文件缺失、找不到账号、壳在并发写、非交互无 --yes）
//        / 2 歧义（匹配到多条，需人工用更精确的选择器）。

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { msUntilExpiry } from "../src/marvis/expiry.mjs"

const PREFIX = "marvis#"
/** 取消登录时写入的 expires：1970-01-01，正数、远在当下之前，且永不被当成"未知" */
const REVOKED_EXPIRES = 1000

/** magpie 配置目录：MAGPIE_CONFIG 优先，其次 ~/.config/magpie（与 probe-served-model.mjs 同口径） */
function configDir(explicit) {
  return String(explicit || process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie"))
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? "")
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const nxt = String(argv[i + 1] ?? "")
      if (!nxt || nxt.startsWith("--")) out[k] = true
      else {
        out[k] = nxt
        i += 1
      }
    } else if (a) {
      out._.push(a)
    }
  }
  return out
}

/** 读 plugin-auth.json → { file, json }；文件不存在给空对象（list 时再按缺失处理） */
function readAuthFile(dir) {
  const file = join(dir, "plugin-auth.json")
  if (!existsSync(file)) return { file, json: null }
  try {
    return { file, json: JSON.parse(readFileSync(file, "utf8")) }
  } catch (err) {
    process.stderr.write(`✗ ${file} 解析失败：${String(err?.message ?? err)}\n`)
    process.exit(1)
  }
}

/** 本插件的账号条目（顶层键以 marvis# 开头） */
function entries(json) {
  const out = []
  for (const [key, v] of Object.entries(json ?? {})) {
    if (!key.startsWith(PREFIX) || !v || typeof v !== "object" || Array.isArray(v)) continue
    out.push({ key, acct: v })
  }
  return out
}

/**
 * 选择器匹配：整键 > uid 精确 > accountId 精确 > 卡片名包含 > 键后缀包含。
 * 命中 0 条 / 多条由调用方决定退出码（1 / 2）。
 */
function pickAccounts(json, selector) {
  const sel = String(selector ?? "").trim()
  const all = entries(json)
  if (!sel) return { all, matched: [] }

  const exactKey = all.filter((e) => e.key === sel)
  if (exactKey.length === 1) return { all, matched: exactKey }

  const byUid = all.filter((e) => String(e.acct.uid ?? "") === sel && sel)
  if (byUid.length >= 1) return { all, matched: byUid }

  const byName = all.filter((e) => String(e.acct.accountId ?? "") === sel)
  if (byName.length >= 1) return { all, matched: byName }

  const loose = all.filter((e) => {
    const name = String(e.acct.accountId ?? "").toLowerCase()
    const suffix = e.key.slice(PREFIX.length).toLowerCase()
    const q = sel.toLowerCase()
    return (name && name.includes(q)) || (suffix && suffix.includes(q))
  })
  return { all, matched: loose }
}

function loginTypeLabel(acct) {
  const t = String(acct?.metadata?.loginType ?? "")
  if (t === "2" || t.toUpperCase() === "WX") return "微信"
  if (t === "1" || t.toUpperCase() === "QC") return "QQ"
  return t || "-"
}

function stateLabel(acct) {
  const hasAccess = String(acct?.access ?? "").trim() !== ""
  const hasRefresh = String(acct?.refresh ?? "").trim() !== ""
  if (acct?.metadata?.revokedAt) return "已取消登录"
  if (!hasAccess && !hasRefresh) return "无凭据"
  if (!hasRefresh) return "仅 access（不会被续期）"
  const left = msUntilExpiry(acct)
  if (left === null) return "有效（到期未知）"
  if (left <= 0) return "已过期（等重登）"
  const days = Math.floor(left / 86_400_000)
  const hours = Math.floor((left % 86_400_000) / 3_600_000)
  const mins = Math.floor((left % 3_600_000) / 60_000)
  // 不足 1 小时别显示「剩 0h」——那看起来像已经过期，会让人误判要不要重登
  if (days > 0) return `有效（剩 ${days}d ${hours}h）`
  if (hours > 0) return `有效（剩 ${hours}h ${mins}m）`
  if (mins > 0) return `有效（剩 ${mins}m，即将过期）`
  return "有效（剩不到 1m，即将过期）"
}

function usage() {
  process.stdout.write(
    [
      "用法：node scripts/accounts.mjs <list|logout|remove> [选择器] [参数]",
      "",
      "  list                        列出 plugin-auth.json 里本插件的全部账号",
      '  logout "<键|uid|卡片名>"     取消该账号登录状态（清凭据、保留身份，magpie 里会要求重新登录）',
      '  remove "<键|uid|卡片名>"     整条移除该账号',
      "  logout|remove --all         对全部账号执行",
      "",
      "参数：",
      "  --config <目录>   magpie 配置目录（默认 $MAGPIE_CONFIG 或 ~/.config/magpie）",
      "  --dry-run         只打印 before/after，不写盘",
      "  --yes             非交互环境跳过确认（推荐脚本里带上）",
      "  --json            list 输出 JSON",
      "",
      "退出码：0 成功 · 1 环境/目标错误 · 2 选择器歧义（打印了候选，请用更精确的选择器）",
      "注意：执行前先**完全退出 magpie**，执行后**重启 magpie** 才会看到效果（壳有内存态）。",
      "",
    ].join("\n"),
  )
}

/** 乐观并发检查：写前重读，除目标键外任何变化都放弃本次写入 */
function recheckUnchanged(file, beforeJson, touchedKeys) {
  let now = null
  try {
    now = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    process.stderr.write("✗ 写入前重读失败：plugin-auth.json 可能被 magpie 同时改写，已放弃本次操作。\n")
    process.exit(1)
  }
  const keys = new Set([...Object.keys(beforeJson ?? {}), ...Object.keys(now ?? {})])
  for (const k of keys) {
    if (touchedKeys.has(k)) continue
    const a = JSON.stringify(beforeJson?.[k] ?? null)
    const b = JSON.stringify(now?.[k] ?? null)
    if (a !== b) {
      process.stderr.write(
        `✗ 检测到 ${k} 在本次操作期间发生变化 —— magpie 很可能正在运行并写回了该文件。\n` +
          "  请**完全退出 magpie** 后重试；本次未写入任何内容（原文件未动）。\n",
      )
      process.exit(1)
    }
  }
  return now
}

function atomicWrite(file, json) {
  const backup = `${file}.bak-${Math.floor(Date.now() / 1000)}`
  copyFileSync(file, backup)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
  return backup
}

function confirm(target, args) {
  if (args["dry-run"] || args.yes) return true
  // 非交互（管道 / CI / Termux 脚本）里没有 tty：不猜用户意图，直接拒绝
  if (!process.stdin.isTTY) {
    process.stderr.write(`✗ 非交互环境，已放弃 ${target}（确认无误请加 --yes，或先看 --dry-run）。\n`)
    process.exit(1)
  }
  return true
}

function printDiff(key, before, after) {
  const fmt = (v) => (v === undefined ? "（无此条目）" : JSON.stringify(v, null, 2))
  process.stdout.write(`--- ${key} before\n${fmt(before)}\n+++ ${key} after\n${fmt(after)}\n`)
}

function finishNote(action, wrote) {
  process.stdout.write(
    "\n" +
      (wrote
        ? `✓ 已${action}。请**完全退出并重启 magpie** 再查看账号列表 —— 壳的内存态可能仍持有旧账号；重启前请勿在 magpie 里点该账号的刷新/测试。\n`
        : `（--dry-run：未写盘。去掉 --dry-run 才会真正${action}。）\n`),
  )
}

function cmdList(args) {
  const dir = configDir(args.config)
  const { file, json } = readAuthFile(dir)
  if (json === null) {
    process.stderr.write(`✗ 没有找到 ${file}（magpie 还没写过账号，或 --config 指错目录）\n`)
    return 1
  }
  const list = entries(json)
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        list.map((e) => ({
          key: e.key,
          accountId: e.acct.accountId ?? "",
          uid: e.acct.uid ?? "",
          loginType: loginTypeLabel(e.acct),
          state: stateLabel(e.acct),
          openid: e.acct.metadata?.openid ?? "",
          guid: e.acct.metadata?.guid ?? "",
          revokedAt: e.acct.metadata?.revokedAt ?? 0,
        })),
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  process.stdout.write(`plugin-auth.json = ${file}\n`)
  if (list.length === 0) {
    process.stdout.write("（本插件没有账号条目）\n")
    return 0
  }
  process.stdout.write(`共 ${list.length} 个账号：\n\n`)
  for (const [i, e] of list.entries()) {
    const name = e.acct.accountId || e.acct.metadata?.nickname || e.key
    process.stdout.write(
      `  ${i + 1}. ${name}\n` +
        `     key=${e.key}  uid=${e.acct.uid ?? "-"}  类型=${loginTypeLabel(e.acct)}  状态=${stateLabel(e.acct)}\n`,
    )
  }
  process.stdout.write("\n选择器可用：整条 key / uid / 卡片名（含片段即可匹配）\n")
  return 0
}

/**
 * logout 支持单条与 --all 批量：
 * 单条命中多条 = 歧义，必须人工裁决；--all 命中多条是预期行为，逐条处理。
 * 已取消过的账号只打印不重打 revokedAt（幂等，避免每次跑都改动文件）。
 */
function cmdLogout(args, selector) {
  const dir = configDir(args.config)
  const { file, json } = readAuthFile(dir)
  if (json === null) {
    process.stderr.write(`✗ 没有找到 ${file}\n`)
    return 1
  }
  const { all, matched } = resolveTargets(json, args, selector)
  if (matched.length === 0) {
    process.stderr.write(`✗ 没有账号匹配「${selector}」。先跑 list 看可用选择器。\n`)
    return 1
  }
  if (!all && matched.length > 1) return ambiguous(matched, selector)

  const now = Date.now()
  const plan = matched.map((e) => {
    const before = e.acct
    const already = String(before.access ?? "") === "" && String(before.refresh ?? "") === "" && before.metadata?.revokedAt
    const after = {
      ...before,
      access: "",
      refresh: "",
      expires: REVOKED_EXPIRES,
      metadata: { ...(before.metadata ?? {}), revokedAt: already ? before.metadata.revokedAt : now },
    }
    return { key: e.key, before, after, already }
  })
  for (const p of plan) printDiff(p.key, p.before, p.already ? p.before : p.after)
  const pending = plan.filter((p) => !p.already)
  if (pending.length === 0) {
    process.stdout.write(`（${plan.length} 个账号都已是取消登录状态，未做任何修改）\n`)
    return 0
  }
  confirm("logout", args)
  if (args["dry-run"]) {
    finishNote(`取消 ${pending.length} 个账号登录`, false)
    return 0
  }
  const nextJson = { ...(json ?? {}) }
  for (const p of pending) nextJson[p.key] = p.after
  recheckUnchanged(file, json, new Set(pending.map((p) => p.key)))
  const backup = atomicWrite(file, nextJson)
  process.stdout.write(`备份：${backup}\n`)
  finishNote(`取消 ${pending.length} 个账号登录`, true)
  return 0
}

function cmdRemove(args, selector) {
  const dir = configDir(args.config)
  const { file, json } = readAuthFile(dir)
  if (json === null) {
    process.stderr.write(`✗ 没有找到 ${file}\n`)
    return 1
  }
  const { all, matched } = resolveTargets(json, args, selector)
  if (matched.length === 0) {
    process.stderr.write(`✗ 没有账号匹配「${selector}」。先跑 list 看可用选择器。\n`)
    return 1
  }
  // remove 的 --all 已在 main() 里拒绝；这里兜底，避免误删整表
  if (all || matched.length > 1) return ambiguous(matched, selector || "--all")

  const e = matched[0]
  printDiff(e.key, e.acct, undefined)
  confirm("remove", args)
  if (args["dry-run"]) {
    process.stdout.write("提示：插件没有上游登出接口，移除=本地清凭据；远端会话由 token 自然过期兜底。\n")
    finishNote("移除该账号", false)
    return 0
  }
  const nextJson = { ...(json ?? {}) }
  delete nextJson[e.key]
  recheckUnchanged(file, json, new Set([e.key]))
  const backup = atomicWrite(file, nextJson)
  process.stdout.write(`备份：${backup}\n`)
  process.stdout.write("提示：路由组/用量统计里若还引用该账号，重启 magpie 后由壳自行清理（插件不碰壳的其他状态）。\n")
  finishNote("移除该账号", true)
  return 0
}

/** --all 或选择器；返回 matched 列表 */
/**
 * 统一目标解析：--all 走全量（批量语义，不算歧义），否则按选择器匹配。
 * 返回的 all 必须是布尔 —— 之前直接把 entries(json) 数组当标志位返回，
 * 导致「命中 1 条」也被当成 --all，歧义保护整个失效。
 */
function resolveTargets(json, args, selector) {
  if (args.all) return { all: true, matched: entries(json) }
  const { matched } = pickAccounts(json, selector)
  return { all: false, matched }
}

function ambiguous(matched, selector) {
  process.stderr.write(`✗ 选择器「${selector}」匹配到 ${matched.length} 个账号，已放弃（歧义必须人工裁决）：\n`)
  for (const e of matched) {
    process.stderr.write(`  · key=${e.key}  accountId=${e.acct.accountId ?? "-"}  uid=${e.acct.uid ?? "-"}\n`)
  }
  process.stderr.write("  请改用整条 key 或 uid 作为选择器。\n")
  return 2
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (!command || command === "-h" || command === "--help" || command === "help") {
    usage()
    return 0
  }
  const selector = args._[0] ?? ""
  if (command === "list") return cmdList(args)
  if (command === "logout" || command === "revoke") {
    if (!selector && !args.all) {
      process.stderr.write("✗ 缺少选择器（要取消哪个账号？用 list 查看；批量用 --all）\n")
      return 1
    }
    if (args.all && !args.yes && !args["dry-run"]) {
      process.stderr.write("✗ --all 批量取消登录必须显式 --yes（或先 --dry-run 预览）\n")
      return 1
    }
    return cmdLogout(args, selector)
  }
  if (command === "remove" || command === "delete") {
    if (!selector && !args.all) {
      process.stderr.write("✗ 缺少选择器（要移除哪个账号？用 list 查看；批量用 --all）\n")
      return 1
    }
    if (args.all && !args.yes && !args["dry-run"]) {
      process.stderr.write("✗ --all 批量移除必须显式 --yes（或先 --dry-run 预览）\n")
      return 1
    }
    // --all 移除：逐条删，但一次只处理一条最安全 —— 这里直接拒绝，要求逐条来
    if (args.all) {
      process.stderr.write("✗ 移除不支持 --all（删光账号风险太高）；请逐条用 key 移除。\n")
      return 1
    }
    return cmdRemove(args, selector)
  }
  process.stderr.write(`✗ 不认识的子命令：${command}\n\n`)
  usage()
  return 1
}

process.exit(await main())
