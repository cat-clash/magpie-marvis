process.env.MARVIS_WS_MODE ||= ""
// tests/openclaw-config-bom.test.mjs —— Windows PowerShell 写出的 UTF-8 BOM 配置必须仍能读取。
//
// 事故（2026-11-27）：`~/.magpie-marvis-native/openclaw.json` 被写成 EF-BB-BF 开头，
// Node 的 JSON.parse 直接抛错 → fileConfig() 返回 {} → 模式落到 auto →
// 插件把 openclaw method:connect 发给只认 AG-UI 的 PC 网关 10123，12s 后误报握手无应答。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const MODULE = pathToFileURL(join(ROOT, "src", "marvis", "openclaw.mjs")).href

test("NATIVE_DIR/openclaw.json 带 UTF-8 BOM 时仍能读到 mode=relay", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-openclaw-bom-"))
  try {
    // 故意写 BOM（模拟 Windows PowerShell 5.1 的 Set-Content -Encoding UTF8）
    writeFileSync(join(dir, "openclaw.json"), '\uFEFF{"mode":"relay","relayUrl":"ws://127.0.0.1:10123/"}', "utf8")

    const script = `
      import(${JSON.stringify(MODULE)}).then((m) => {
        const s = m.openclawStatus()
        console.log(JSON.stringify({ mode: s.mode, fileMode: s.fileMode, url: s.url }))
      })
    `
    const out = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        MARVIS_NATIVE_DIR: dir,
        MARVIS_WS_CONFIG: "",
        MARVIS_WS_MODE: "",
        MARVIS_HANDSHAKE: "",
        MARVIS_WS_URL: "",
      },
    })
    assert.equal(out.status, 0, `子进程失败：${out.stderr}`)
    const j = JSON.parse(out.stdout.trim().split("\n").at(-1))
    assert.equal(j.fileMode, "relay", "BOM 配置必须被解析出来")
    assert.equal(j.mode, "relay", "读到 relay 后不能再落回 auto")
    assert.equal(j.url, "ws://127.0.0.1:10123/", "relayUrl 生效")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
