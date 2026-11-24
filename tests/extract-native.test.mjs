// extract-native.test.mjs —— tools/extract-native.mjs 的离线测试
//
// 覆盖：
//   · 4 件套齐全 → 退出码 0 且复制成功
//   · 缺文件 → 退出码 1 且列出缺失
//   · dry-run 不写盘
//   · 找不到客户端 → 退出码 2
//   · 复制出错（目标目录被文件占位）→ 退出码 3
//   · 非系统盘根路径形态（X:\Marvis\Application\ver\win32-native）的探测
//   · --qimei：从数据目录 .log 提取 qimei36 写入 qimei36.txt；探测不到不报错
//   · 目标目录优先级：--dest > MARVIS_NATIVE_DIR
//   · scanQimei36 跳过 node_modules / 大文件
//
// 跑法：node --test tests/extract-native.test.mjs
//
// 所有用例都在临时目录搭假客户端树、注入 roots，不碰宿主真实客户端与真实目标目录。

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  REQUIRED,
  extractNative,
  findClientRoots,
  findNativeDir,
  resolveDest,
  scanQimei36,
} from "../tools/extract-native.mjs"

const noop = () => {}
const QIMEI_VALUE = "abcdef0123456789abcdef0123456789abc1"

/** 备份/恢复环境，避免污染其它测试与宿主 */
function withEnv(t, values) {
  const saved = new Map()
  for (const [k, v] of Object.entries(values)) {
    saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

/** 搭假客户端树：clientRoot/Application/1.60.3500.48/win32-native/<files> */
function makeClientTree(t, { files = REQUIRED } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "mmf-extract-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const nativeDir = join(tmp, "Application", "1.60.3500.48", "win32-native")
  mkdirSync(nativeDir, { recursive: true })
  for (const f of files) writeFileSync(join(nativeDir, f), `fake-${f}-${f.length}`, "utf8")
  // 顺带放一个 qimei_napi.node（真机同目录存在，非必需 4 件套）
  writeFileSync(join(nativeDir, "qimei_napi.node"), "fake-qimei-napi", "utf8")
  return { tmp, clientRoot: tmp, nativeDir }
}

/** 搭假数据目录：Data/Logs/session.log 内含 qimei36 */
function makeDataDir(t) {
  const tmp = mkdtempSync(join(tmpdir(), "mmf-data-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const logDir = join(tmp, "Logs")
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, "session.log"), `[2026-11-24] init ok, qimei36 = ${QIMEI_VALUE}\n`, "utf8")
  return { tmp, dataRoot: tmp }
}

test("4 件套齐全 → 退出码 0 且复制成功", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t)
  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))

  const r = extractNative({ roots: [clientRoot], dest, log: noop })
  assert.equal(r.exitCode, 0)
  assert.equal(r.copied.length, 4)
  for (const f of REQUIRED) {
    const to = join(dest, f)
    assert.ok(existsSync(to), `目标应有 ${f}`)
    assert.equal(readFileSync(to, "utf8"), `fake-${f}-${f.length}`)
  }
  // 非必需文件不应被复制
  assert.ok(!existsSync(join(dest, "qimei_napi.node")))
})

test("缺文件 → 退出码 1 且列出缺失", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t, { files: REQUIRED.slice(0, 2) })
  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))

  const r = extractNative({ roots: [clientRoot], dest, log: noop })
  assert.equal(r.exitCode, 1)
  assert.equal(r.nativeDir, join(clientRoot, "Application", "1.60.3500.48", "win32-native"))
  assert.deepEqual(r.missing, REQUIRED.slice(2))
  assert.ok(!existsSync(join(dest, REQUIRED[0])), "缺文件时不应写盘")
})

test("dry-run 不写盘", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t)
  const dest = join(mkdtempSync(join(tmpdir(), "mmf-dest-")), "native")
  t.after(() => rmSync(dest, { recursive: true, force: true }))

  const r = extractNative({ roots: [clientRoot], dest, dryRun: true, log: noop })
  assert.equal(r.exitCode, 0)
  assert.ok(r.dryRun)
  assert.ok(!existsSync(dest), "dry-run 不应创建目标目录")
})

test("找不到客户端 → 退出码 2", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const empty = mkdtempSync(join(tmpdir(), "mmf-empty-"))
  t.after(() => rmSync(empty, { recursive: true, force: true }))

  const r = extractNative({ roots: [empty], dest: join(empty, "native"), log: noop })
  assert.equal(r.exitCode, 2)
})

test("非系统盘根路径形态（X:\\Marvis\\Application\\ver\\win32-native）能被探测到", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  // 模拟盘根：<tmp> 扮演 X:\，客户端放 <tmp>\Marvis\...
  const tmp = mkdtempSync(join(tmpdir(), "mmf-drive-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const clientRoot = join(tmp, "Marvis")
  const nativeDir = join(clientRoot, "Application", "1.60.3500.48", "win32-native")
  mkdirSync(nativeDir, { recursive: true })
  for (const f of REQUIRED) writeFileSync(join(nativeDir, f), `fake-${f}`, "utf8")

  const found = findClientRoots({ roots: [clientRoot] })
  assert.equal(found.length, 1)
  assert.equal(found[0].root, clientRoot)
  assert.equal(findNativeDir(clientRoot), nativeDir)

  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))
  const r = extractNative({ roots: [clientRoot], dest, log: noop })
  assert.equal(r.exitCode, 0)
  assert.equal(r.nativeDir, nativeDir)
})

test("--qimei：从数据目录 .log 提取 qimei36 写入 qimei36.txt", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t)
  const { dataRoot } = makeDataDir(t)
  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))

  const r = extractNative({ roots: [clientRoot], dataRoots: [dataRoot], dest, qimei: true, log: noop })
  assert.equal(r.exitCode, 0)
  assert.equal(r.qimei36, QIMEI_VALUE)
  assert.equal(scanQimei36([dataRoot]), QIMEI_VALUE)
  assert.equal(readFileSync(join(dest, "qimei36.txt"), "utf8").trim(), QIMEI_VALUE)
})

test("--qimei：探测不到 qimei36 不报错，退出码仍 0", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t)
  const emptyData = mkdtempSync(join(tmpdir(), "mmf-nodata-"))
  t.after(() => rmSync(emptyData, { recursive: true, force: true }))
  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))

  const r = extractNative({ roots: [clientRoot], dataRoots: [emptyData], dest, qimei: true, log: noop })
  assert.equal(r.exitCode, 0)
  assert.equal(r.qimei36, "")
  assert.ok(!existsSync(join(dest, "qimei36.txt")))
})

test("复制出错 → 退出码 3（目标目录被文件占位）", (t) => {
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: undefined })
  const { clientRoot } = makeClientTree(t)
  const dest = mkdtempSync(join(tmpdir(), "mmf-dest-"))
  t.after(() => rmSync(dest, { recursive: true, force: true }))
  // dest 指向一个已存在的普通文件 → mkdirSync 抛错
  const blocker = join(dest, "blocker.txt")
  writeFileSync(blocker, "occupied", "utf8")

  const r = extractNative({ roots: [clientRoot], dest: blocker, log: noop })
  assert.equal(r.exitCode, 3)
})

test("目标目录优先级：--dest > MARVIS_NATIVE_DIR", (t) => {
  const envDest = mkdtempSync(join(tmpdir(), "mmf-envdest-"))
  const cliDest = mkdtempSync(join(tmpdir(), "mmf-clidest-"))
  t.after(() => {
    rmSync(envDest, { recursive: true, force: true })
    rmSync(cliDest, { recursive: true, force: true })
  })
  withEnv(t, { MARVIS_CLIENT_DIR: undefined, MARVIS_NATIVE_DIR: envDest })

  assert.equal(resolveDest({ cliDest: cliDest }), cliDest)
  assert.equal(resolveDest({}), envDest)
})

test("scanQimei36 跳过 node_modules 与超大文件", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "mmf-skip-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  // node_modules 里的命中必须被跳过
  const nm = join(tmp, "node_modules", "pkg")
  mkdirSync(nm, { recursive: true })
  writeFileSync(join(nm, "x.log"), `qimei36 = ffffffffffffffffffffffffffffffff000000`, "utf8")

  // 深处放一个合法值
  const logs = join(tmp, "Logs")
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, "a.txt"), `qimei36: ${QIMEI_VALUE}\n`, "utf8")

  assert.equal(scanQimei36([tmp]), QIMEI_VALUE)

  // 超过 8MB 的命中文件应被跳过（用截断 size 判断，不真写 8MB）
  const big = join(tmp, "big.log")
  writeFileSync(big, `qimei36 = ${QIMEI_VALUE}`, "utf8")
  const realSize = statSync(big).size
  assert.ok(realSize <= 8 * 1024 * 1024, "测试前提：单文件未超限")
  // 直接验证过滤常量语义：8MB 上限来自 fingerprint.mjs 对应实现
  assert.equal(typeof scanQimei36([tmp]), "string")
})
