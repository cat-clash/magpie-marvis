#!/usr/bin/env node
// 生成 magpie-marvis-phone-kit.zip：插件 + Python 网关 + 一键脚本，手机上一条命令起 8088 网关。
//
// 用法：
//   node scripts/build-phone-kit.mjs --gateway DIR [--out FILE] [--version X.Y.Z]
//
// 可复现：store（不压缩）+ 固定 DOS 时间戳 + 统一 `/` 路径 + create_system=3（Unix）
// + `.sh` 0755、目录 0755，这样 Termux 的 unzip 解压后目录结构正确、脚本可直接执行。
// CHANGELOG 里不再写死 zip 的 sha256 —— 文档每次改都会让 zip 变，哈希必然过期。

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// 2026-01-01 00:00:00，固定值保证同一批文件产出同一个 zip
const DOS_TIME = 0
const DOS_DATE = (46 << 9) | (1 << 5) | 1

export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8")
    if (name.length > 0xffff) throw new Error(`ZIP 条目名过长：${e.name}`)
    const data = e.data ?? Buffer.alloc(0)
    const crc = e.dir ? 0 : crc32(data)
    const size = e.dir ? 0 : data.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    lh.writeUInt16LE(0, 8) // store
    lh.writeUInt16LE(DOS_TIME, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(size, 18)
    lh.writeUInt32LE(size, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, e.dir ? Buffer.alloc(0) : data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(0x0314, 4) // made by Unix, version 2.0
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(DOS_TIME, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(size, 20)
    ch.writeUInt32LE(size, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30) // extra
    ch.writeUInt16LE(0, 32) // comment
    ch.writeUInt16LE(0, 34) // disk
    ch.writeUInt16LE(0, 36) // internal attr
    ch.writeUInt32LE(((e.mode ?? (e.dir ? 0o40755 : 0o100644)) << 16) >>> 0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += lh.length + name.length + size
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const IGNORE_PLUGIN = new Set([".git", "node_modules", "dist", "tests", ".DS_Store"])
const IGNORE_GATEWAY = new Set([".git", "__pycache__", ".pytest_cache", "node_modules", ".DS_Store"])

function walk(base, prefix, ignore, out) {
  const dirs = []
  const files = []
  for (const name of readdirSync(base).sort()) {
    if (ignore.has(name) || name.endsWith(".pyc")) continue
    const p = join(base, name)
    const st = statSync(p)
    if (st.isDirectory()) dirs.push(name)
    else if (st.isFile()) files.push(name)
  }
  for (const d of dirs) {
    out.push({ name: `${prefix}${d}/`, dir: true, mode: 0o40755 })
    walk(join(base, d), `${prefix}${d}/`, ignore, out)
  }
  for (const f of files) {
    const mode = f.endsWith(".sh") ? 0o100755 : 0o100644
    out.push({ name: `${prefix}${f}`, data: readFileSync(join(base, f)), mode })
  }
}

function arg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

export function main() {
  const gateway = arg("gateway")
  if (!gateway || !existsSync(join(gateway, "serve.py")) || !existsSync(join(gateway, "run.sh"))) {
    throw new Error("缺少 --gateway DIR：目录必须有 serve.py 与 run.sh（yy158358/Marvis-proxy-public）")
  }
  const version = arg("version", "0.0.0")
  const out = resolve(arg("out", join(ROOT, "dist", "magpie-marvis-phone-kit.zip")))
  const entries = [
    { name: "magpie-marvis-phone-kit/", dir: true, mode: 0o40755 },
    {
      name: "magpie-marvis-phone-kit/phone-setup.sh",
      data: readFileSync(join(ROOT, "phone-setup.sh")),
      mode: 0o100755,
    },
  ]
  walk(ROOT, "magpie-marvis-phone-kit/plugin/", IGNORE_PLUGIN, entries)
  walk(gateway, "magpie-marvis-phone-kit/Marvis-proxy-public/", IGNORE_GATEWAY, entries)
  const zip = buildZip(entries)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, zip)
  const sha = createHash("sha256").update(zip).digest("hex")
  console.log(`输出: ${out}`)
  console.log(`版本: ${version}`)
  console.log(`条目: ${entries.length}（其中目录 ${entries.filter((e) => e.dir).length}）`)
  console.log(`大小: ${zip.length} 字节`)
  console.log(`sha256: ${sha}`)
  return { out, sha, entries: entries.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
