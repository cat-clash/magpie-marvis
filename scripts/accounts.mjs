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
// ⚠ 0.7.6 起读写/选择器/logout/remove 的语义全部在 src/marvis/accounts-store.mjs，
//   与手机端登录菜单里的「账号管理」入口共用同一套规矩；本文件只是 CLI 薄壳
//   （参数解析、确认、diff 打印、退出码）。改语义去 store，别在这里另写一份。
//
// 退出码：0 成功 / 1 环境或目标错误（文件缺失、找不到账号、壳在并发写、非交互无 --yes）
//        / 2 歧义（匹配到多条，需人工用更精确的选择器）。

import {
  configDir,
  readAuthFile,
  entries,
  isoOrEmpty,
  resolveTargets,
  loginTypeLabel,
  stateLabel,
  accountRow,
  planLogout,
  applyLogout,
  applyRemove,
} from "../src/marvis/accounts-store.mjs"
import { msUntilExpiry } from "../src/marvis/expiry.mjs"

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
      "  --json            list/logout/remove 都输出 JSON（stdout 只有一份结果，便于脚本接管）",
      "  --verbose         list 额外显示 expires / 剩余毫秒 / guid / 字段全集",
      "",
      "退出码：0 成功 · 1 环境/目标错误 · 2 选择器歧义（打印了候选，请用更精确的选择器）",
      "注意：执行前先**完全退出 magpie**，执行后**重启 magpie** 才会看到效果（壳有内存态）。",
      "",
    ].join("\n"),
  )
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

/** --json 模式：stdout 只留一份机器可读结果，人读信息一律不混进来 */
function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
  return 0
}

/** 读文件；缺失/解析失败按 CLI 口径报错退出（store 本身不 exit） */
function loadOrExit(dir) {
  let loaded
  try {
    loaded = readAuthFile(dir)
  } catch (err) {
    process.stderr.write(`✗ ${dir} 里的 plugin-auth.json 解析失败：${String(err?.message ?? err)}\n`)
    process.exit(1)
  }
  if (loaded.json === null) {
    process.stderr.write(`✗ 没有找到 ${loaded.file}（magpie 还没写过账号，或 --config 指错目录）\n`)
    process.exit(1)
  }
  return loaded
}

function cmdList(args) {
  const { file, json } = loadOrExit(configDir(args.config))
  const list = entries(json)
  if (args.json) return emitJson(list.map(accountRow))
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
    if (args.verbose) {
      const left = msUntilExpiry(e.acct)
      const fields = Object.keys(e.acct).sort().join(",")
      process.stdout.write(
        `     expires=${isoOrEmpty(e.acct.expires) || "-"}` +
          `  ${left === null ? "剩余=未知" : `剩余ms=${left}`}\n` +
          `     openid=${e.acct.metadata?.openid ?? "-"}  guid=${e.acct.metadata?.guid ?? "-"}\n` +
          `     revokedAt=${e.acct.metadata?.revokedAt ?? 0}  metadata键=${Object.keys(e.acct.metadata ?? {}).sort().join(",") || "-"}\n` +
          `     字段=${fields || "-"}\n`,
      )
    }
  }
  process.stdout.write(
    "\n选择器可用：整条 key / uid / 卡片名（含片段即可匹配）" +
      (args.verbose ? "\n" : "（加 --verbose 看 expires / guid / 字段全集）\n"),
  )
  return 0
}

/**
 * logout 支持单条与 --all 批量：
 * 单条命中多条 = 歧义，必须人工裁决；--all 命中多条是预期行为，逐条处理。
 * 已取消过的账号只打印不重打 revokedAt（幂等，避免每次跑都改动文件）。
 */
function cmdLogout(args, selector) {
  const { file, json } = loadOrExit(configDir(args.config))
  const { all, matched } = resolveTargets(json, { all: Boolean(args.all), selector })
  if (matched.length === 0) {
    process.stderr.write(`✗ 没有账号匹配「${selector}」。先跑 list 看可用选择器。\n`)
    return 1
  }
  if (!all && matched.length > 1) return ambiguous(matched, selector)

  const plan = planLogout(matched)
  if (!args.json) for (const p of plan) printDiff(p.key, p.before, p.already ? p.before : p.after)
  const pending = plan.filter((p) => !p.already)
  const alreadyKeys = plan.filter((p) => p.already).map((p) => p.key)
  if (pending.length === 0) {
    if (args.json)
      return emitJson({
        action: "logout",
        file,
        dryRun: !!args["dry-run"],
        count: 0,
        keys: [],
        already: alreadyKeys,
        backup: null,
        note: "所有目标账号已是取消登录状态，未做任何修改",
      })
    process.stdout.write(`（${plan.length} 个账号都已是取消登录状态，未做任何修改）\n`)
    return 0
  }
  confirm("logout", args)
  if (args["dry-run"]) {
    if (args.json)
      return emitJson({
        action: "logout",
        file,
        dryRun: true,
        count: pending.length,
        keys: pending.map((p) => p.key),
        already: alreadyKeys,
        backup: null,
      })
    finishNote(`取消 ${pending.length} 个账号登录`, false)
    return 0
  }
  let res
  try {
    res = applyLogout({ file, json, matched })
  } catch (err) {
    process.stderr.write(`✗ ${String(err?.message ?? err)}\n`)
    return 1
  }
  if (args.json)
    return emitJson({ action: "logout", file, dryRun: false, count: res.count, keys: res.keys, already: res.already, backup: res.backup })
  process.stdout.write(`备份：${res.backup}\n`)
  finishNote(`取消 ${res.count} 个账号登录`, true)
  return 0
}

function cmdRemove(args, selector) {
  const { file, json } = loadOrExit(configDir(args.config))
  const { all, matched } = resolveTargets(json, { all: Boolean(args.all), selector })
  if (matched.length === 0) {
    process.stderr.write(`✗ 没有账号匹配「${selector}」。先跑 list 看可用选择器。\n`)
    return 1
  }
  // remove 的 --all 已在 main() 里拒绝；这里兜底，避免误删整表
  if (all || matched.length > 1) return ambiguous(matched, selector || "--all")

  const e = matched[0]
  if (!args.json) printDiff(e.key, e.acct, undefined)
  confirm("remove", args)
  if (args["dry-run"]) {
    if (args.json)
      return emitJson({ action: "remove", file, dryRun: true, key: e.key, accountId: e.acct.accountId ?? "", backup: null })
    process.stdout.write("提示：插件没有上游登出接口，移除=本地清凭据；远端会话由 token 自然过期兜底。\n")
    finishNote("移除该账号", false)
    return 0
  }
  let res
  try {
    res = applyRemove({ file, json, matched })
  } catch (err) {
    process.stderr.write(`✗ ${String(err?.message ?? err)}\n`)
    return 1
  }
  if (args.json) return emitJson({ action: "remove", file, dryRun: false, key: res.key, accountId: res.accountId, backup: res.backup })
  process.stdout.write(`备份：${res.backup}\n`)
  process.stdout.write("提示：路由组/用量统计里若还引用该账号，重启 magpie 后由壳自行清理（插件不碰壳的其他状态）。\n")
  finishNote("移除该账号", true)
  return 0
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