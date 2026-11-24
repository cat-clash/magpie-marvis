// 诊断脚本 magpie-marvis-diag.sh —— 离线可跑的冒烟测试
//
// 覆盖三件事：
//   ① POSIX sh 语法正确（sh -n），否则手机上的 busybox/mksh 会直接语法错；
//   ② 默认（只读）模式**不落盘**：不写 gateway.json、不建目录；
//   ③ --fix --no-start 能写出合法 gateway.json（schemaVersion/mode/url/timeoutMs），
//      且明确说明「没去启动网关」。
// --fix 的「自动起网关」分支需要真实 run.sh，这里只验 --no-start 分支，
// 避免测试依赖机器上装没装 Python 网关。
//
// 跑法：node --test tests/diag-script.test.mjs
// 依赖：PATH 里有 sh（Windows 下 Git for Windows 的 usr/bin 即可）；没有就整组跳过。

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dirname, "..", "scripts", "magpie-marvis-diag.sh")

function haveSh() {
  const r = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" })
  return r.status === 0
}

const SH_OK = haveSh()
const skip = SH_OK ? false : "PATH 里没有 sh，跳过 shell 诊断脚本测试"

const dirs = []
test.afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
  dirs.length = 0
})

function fakeHome() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-diag-"))
  dirs.push(dir)
  return dir
}

function runSh(home, args) {
  const env = { ...process.env, HOME: home, MARVIS_PROXY_DIR: join(home, "no-such-gateway") }
  const r = spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env, timeout: 60_000 })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

test("sh -n：语法通过", { skip }, () => {
  const r = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
})

test("--help：打印用法并带上 --no-start", { skip }, () => {
  const home = fakeHome()
  const r = runSh(home, ["--help"])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /--fix/)
  assert.match(r.out, /--no-start/)
})

test("默认只读：不创建 ~/.magpie-marvis-native，也不写 gateway.json", { skip }, () => {
  const home = fakeHome()
  const r = runSh(home, [])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NEXT_ACTION:/)
  assert.ok(!existsSync(join(home, ".magpie-marvis-native")), "只读诊断不许建目录")
})

test("--fix --no-start：写出合法 gateway.json，并说明没启动网关", { skip }, () => {
  const home = fakeHome()
  const r = runSh(home, ["--fix", "--no-start"])
  assert.equal(r.code, 0, r.out)
  const file = join(home, ".magpie-marvis-native", "gateway.json")
  assert.ok(existsSync(file), "--fix 必须把配置落盘")
  const cfg = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(cfg.schemaVersion, 1)
  assert.equal(cfg.mode, "gateway")
  assert.match(cfg.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  assert.equal(cfg.timeoutMs, 600000)
  assert.equal(cfg.key, "")
  assert.match(r.out, /FIX_RESULT:/)
  assert.match(r.out, /listening\s+:\s+0/, "本机没有网关，listening 应为 0")
})

test("--fix：找不到 run.sh 时给出可执行的下一步，而不是静默失败", { skip }, () => {
  const home = fakeHome()
  const r = runSh(home, ["--fix"])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /MARVIS_PROXY_DIR|没找到 run.sh/)
  assert.match(r.out, /next\s+:/)
})
