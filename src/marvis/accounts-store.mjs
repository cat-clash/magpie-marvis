// accounts-store.mjs —— plugin-auth.json 账号读写的**唯一语义层**
//
// CLI（scripts/accounts.mjs）共享的账号语义层（0.7.7 起壳内管理页入口已移除，只留 CLI）
// 共用这里的同一套规矩：选择器优先级、logout/remove 的精确字段形状、
// 乐观并发检查、备份 + 原子写。改语义只改这里，别在两个入口各写一份。
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
//   1. 乐观并发控制：写前重读磁盘，除目标键外任何条目变了 → throw，调用方提示先退出 magpie；
//   2. 备份：写前 copyFile 到 <file>.bak-<epoch>，路径返回给调用方；
//   3. 原子写：先写 <file>.tmp 再同目录 rename，壳不会读到半截 JSON。
//
// ⚠ 本模块**不 process.exit、不打印**：错误一律 throw，退出码/文案由 CLI 或页面决定。

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { msUntilExpiry } from "./expiry.mjs"

export const PREFIX = "marvis#"
/** 取消登录时写入的 expires：1970-01-01，正数、远在当下之前，且永不被当成"未知" */
export const REVOKED_EXPIRES = 1000

/** magpie 配置目录：MAGPIE_CONFIG 优先，其次 ~/.config/magpie（与 probe-served-model.mjs 同口径） */
export function configDir(explicit) {
  return String(explicit || process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie"))
}

/** 读 plugin-auth.json → { file, json }；文件不存在 json=null；解析失败 throw（不 exit） */
export function readAuthFile(dir) {
  const file = join(dir, "plugin-auth.json")
  if (!existsSync(file)) return { file, json: null }
  try {
    return { file, json: JSON.parse(readFileSync(file, "utf8")) }
  } catch (err) {
    throw new Error(`${file} 解析失败：${String(err?.message ?? err)}`)
  }
}

/** 本插件的账号条目（顶层键以 marvis# 开头） */
export function entries(json) {
  const out = []
  for (const [key, v] of Object.entries(json ?? {})) {
    if (!key.startsWith(PREFIX) || !v || typeof v !== "object" || Array.isArray(v)) continue
    out.push({ key, acct: v })
  }
  return out
}

/** expires 毫秒时间戳 → ISO 字符串；0/负数/非数字（= 到期未知）返回空串 */
export function isoOrEmpty(expires) {
  const n = Number(expires ?? 0)
  if (!Number.isFinite(n) || n <= 0) return ""
  try {
    return new Date(n).toISOString()
  } catch {
    return ""
  }
}

/**
 * 选择器匹配：整键 > uid 精确 > accountId 精确 > 卡片名包含 > 键后缀包含。
 * 命中 0 条 / 多条由调用方决定怎么处理（CLI 退出码 1/2；页面只认整键）。
 */
export function pickAccounts(json, selector) {
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

/**
 * 统一目标解析：all=true 走全量（批量语义，不算歧义），否则按选择器匹配。
 * 返回的 all 必须是布尔 —— 曾把 entries(json) 数组当标志位返回，
 * 导致「命中 1 条」也被当成 --all，歧义保护整个失效（0.7.4 修过，别再犯）。
 */
export function resolveTargets(json, { all = false, selector = "" } = {}) {
  if (all) return { all: true, matched: entries(json) }
  const { matched } = pickAccounts(json, selector)
  return { all: false, matched }
}

export function loginTypeLabel(acct) {
  const t = String(acct?.metadata?.loginType ?? "")
  if (t === "2" || t.toUpperCase() === "WX") return "微信"
  if (t === "1" || t.toUpperCase() === "QC") return "QQ"
  return t || "-"
}

export function stateLabel(acct) {
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

/** 机器可读的账号行（list --json 与管理页共用同一形状） */
export function accountRow(e) {
  return {
    key: e.key,
    accountId: e.acct.accountId ?? "",
    nickname: e.acct.metadata?.nickname ?? "",
    uid: e.acct.uid ?? "",
    loginType: loginTypeLabel(e.acct),
    state: stateLabel(e.acct),
    expires: Number(e.acct.expires ?? 0),
    expiresAt: isoOrEmpty(e.acct.expires),
    msLeft: msUntilExpiry(e.acct),
    openid: e.acct.metadata?.openid ?? "",
    guid: e.acct.metadata?.guid ?? "",
    revokedAt: e.acct.metadata?.revokedAt ?? 0,
  }
}

/** 乐观并发检查：写前重读，除目标键外任何变化都 throw（本次不写盘） */
export function recheckUnchanged(file, beforeJson, touchedKeys) {
  let now = null
  try {
    now = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error("写入前重读失败：plugin-auth.json 可能被 magpie 同时改写，已放弃本次操作。")
  }
  const keys = new Set([...Object.keys(beforeJson ?? {}), ...Object.keys(now ?? {})])
  for (const k of keys) {
    if (touchedKeys.has(k)) continue
    const a = JSON.stringify(beforeJson?.[k] ?? null)
    const b = JSON.stringify(now?.[k] ?? null)
    if (a !== b) {
      throw new Error(
        `检测到 ${k} 在本次操作期间发生变化 —— magpie 很可能正在运行并写回了该文件。` +
          "请**完全退出 magpie** 后重试；本次未写入任何内容（原文件未动）。",
      )
    }
  }
  return now
}

/** 备份 + 原子写；返回备份路径 */
export function atomicWrite(file, json) {
  const backup = `${file}.bak-${Math.floor(Date.now() / 1000)}`
  copyFileSync(file, backup)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
  return backup
}

/**
 * 计算 logout 计划（不写盘）：已取消过的账号 already=true，
 * 不重打 revokedAt（幂等，避免每次跑都改动文件）。
 */
export function planLogout(matched, now = Date.now()) {
  return matched.map((e) => {
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
}

/** 执行 logout：计划 → 并发检查 → 备份 + 原子写。全部已取消时不写盘（count:0）。 */
export function applyLogout({ file, json, matched, now = Date.now() }) {
  const plan = planLogout(matched, now)
  const pending = plan.filter((p) => !p.already)
  const already = plan.filter((p) => p.already).map((p) => p.key)
  if (pending.length === 0) return { count: 0, keys: [], already, backup: null, plan }
  const nextJson = { ...(json ?? {}) }
  for (const p of pending) nextJson[p.key] = p.after
  recheckUnchanged(file, json, new Set(pending.map((p) => p.key)))
  const backup = atomicWrite(file, nextJson)
  return { count: pending.length, keys: pending.map((p) => p.key), already, backup, plan }
}

/** 执行 remove：整条删除 → 并发检查 → 备份 + 原子写。只处理 matched[0]（歧义由调用方拦）。 */
export function applyRemove({ file, json, matched }) {
  const e = matched[0]
  const nextJson = { ...(json ?? {}) }
  delete nextJson[e.key]
  recheckUnchanged(file, json, new Set([e.key]))
  const backup = atomicWrite(file, nextJson)
  return { key: e.key, accountId: e.acct.accountId ?? "", backup }
}