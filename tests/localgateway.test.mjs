// localgateway.test.mjs —— 本地 OpenAI 兼容网关传输层离线测试
//
//   · gatewayConfig：显式 transport / 默认 URL / key / 超时
//   · targetPath：magpie 原始 URL → 网关相对路径
//   · localGatewayConfigured：同步判断，不联网
//   · gatewayFetch：header 清洗 + body/path/SSE 原样透传（本机 mock server）
//   · gatewayStatus：连通性 JSON，不含密钥明文
//
// 跑法：node --test tests/localgateway.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_GATEWAY_URL,
  gatewayConfig,
  gatewayFetch,
  gatewayStatus,
  gatewayFileConfig,
  localGatewayConfigured,
  targetPath,
} from "../src/marvis/localgateway.mjs"

const ENV_KEYS = [
  "MARVIS_TRANSPORT",
  "MARVIS_GATEWAY_URL",
  "MARVIS_GATEWAY_KEY",
  "MARVIS_GATEWAY_TIMEOUT_MS",
  "MARVIS_WS_MODE",
  "MARVIS_DIRECT_TRANSPORT",
  "MARVIS_NATIVE_DIR",
  "MARVIS_GATEWAY_CONFIG",
]

/**
 * 每个测试前后都恢复环境，避免污染其它测试。
 *
 * 0.5.4 语义收紧：ENV_KEYS 里的键**一律强制隔离** —— 用例没显式传值的键直接
 * 删除，不再继承宿主真实环境。宿主机器正带着 MARVIS_WS_MODE=off 和
 * MARVIS_NATIVE_DIR=<真实目录> 在跑插件，旧语义"没传就保留原值"会让
 * gatewayConfig() 看到 legacy="off" 而非用例预期值（5 个用例误红的根因）。
 * 显式传 undefined 与"没传"等价，都是删除。
 */
function env(t, values) {
  const prev = {}
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  // 先全量清场：ENV_KEYS 一律不继承宿主
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = String(v)
  }
  // 隔离本机 ~/.magpie-marvis-native/gateway.json：未显式指定时指向临时空目录，
  // 否则本机真实配置（带 key）会漏进测试，造成「只给 URL 也算配置好」等用例误判。
  if (!Object.prototype.hasOwnProperty.call(values, "MARVIS_NATIVE_DIR")) {
    const empty = mkdtempSync(join(tmpdir(), "gwcfg-empty-"))
    process.env.MARVIS_NATIVE_DIR = empty
    t.after(() => rmSync(empty, { recursive: true, force: true }))
  }
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
}

/** 起一个 127.0.0.1 随机端口的 mock 网关，返回带 /v1 的基址 */
async function mockGateway(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  return `http://127.0.0.1:${port}/v1`
}

test("手机无环境变量：gateway.json 配置文件开启网关（环境变量优先，含 UTF-8 BOM）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gwcfg-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Windows 编辑器 / PowerShell 常写 BOM；JSON.parse 遇 U+FEFF 会整份失败 → 必须容错
  writeFileSync(
    join(dir, "gateway.json"),
    "\uFEFF" +
      JSON.stringify({ mode: "gateway", url: "http://127.0.0.1:9999/v1", key: "filekey", timeoutMs: 2222 }),
  )
  env(t, {
    MARVIS_TRANSPORT: undefined,
    MARVIS_GATEWAY_URL: undefined,
    MARVIS_GATEWAY_KEY: undefined,
    MARVIS_NATIVE_DIR: dir,
  })
  const f = gatewayFileConfig()
  assert.equal(f.mode, "gateway")
  const c = gatewayConfig()
  assert.equal(c.enabled, true, "手机只写 gateway.json 就该开网关")
  assert.equal(c.explicit, true, "文件 mode=gateway 也视为显式开启（跳过自动探测）")
  assert.equal(c.source, "file")
  assert.equal(c.url, "http://127.0.0.1:9999/v1")
  assert.equal(c.key, "filekey")
  assert.equal(c.timeoutMs, 2222)
  assert.equal(localGatewayConfigured(), true)

  // 环境变量覆盖文件
  process.env.MARVIS_GATEWAY_URL = "http://127.0.0.1:8888/v1"
  process.env.MARVIS_TRANSPORT = "gateway"
  assert.equal(gatewayConfig().url, "http://127.0.0.1:8888/v1", "环境变量优先")
  // 显式 off 覆盖文件
  process.env.MARVIS_TRANSPORT = "off"
  assert.equal(gatewayConfig().enabled, false, "env off 覆盖文件 gateway")
})

test("gatewayConfig 默认：URL 是默认值，未显式配置时 enabled=false", (t) => {
  env(t, {
    MARVIS_NATIVE_DIR: join(tmpdir(), "__no_such_native_dir__"),
    MARVIS_TRANSPORT: undefined,
    MARVIS_GATEWAY_URL: undefined,
    MARVIS_GATEWAY_KEY: undefined,
    MARVIS_GATEWAY_TIMEOUT_MS: undefined,
  })
  const c = gatewayConfig()
  assert.equal(c.url, DEFAULT_GATEWAY_URL)
  assert.equal(c.key, "")
  assert.equal(c.timeoutMs, 600_000)
  assert.equal(c.enabled, false)
  assert.equal(c.explicit, false)
})

test("gatewayConfig：显式 transport=direct 关闭（即使 URL/key 已给）", (t) => {
  env(t, {
    MARVIS_TRANSPORT: "DIRECT",
    MARVIS_GATEWAY_URL: "http://127.0.0.1:9999/v1",
    MARVIS_GATEWAY_KEY: "secret",
  })
  const c = gatewayConfig()
  assert.equal(c.enabled, false)
  assert.equal(c.explicit, true)
  assert.equal(c.url, "http://127.0.0.1:9999/v1")
  assert.equal(c.key, "secret")
})

test("gatewayConfig：off/openclaw/ws 都是显式关网关（别名与 README 一致）", (t) => {
  env(t, { MARVIS_TRANSPORT: "openclaw", MARVIS_WS_MODE: undefined })
  const off = gatewayConfig()
  assert.equal(off.enabled, false)
  assert.equal(off.explicit, true)

  for (const mode of ["off", "direct", "ws", "relay", "remote"]) {
    process.env.MARVIS_TRANSPORT = mode
    const c = gatewayConfig()
    assert.equal(c.explicit, true, `${mode} 应显式关掉网关自动探测`)
    assert.equal(c.enabled, false, `${mode} 不应走网关`)
  }
})

test("gatewayConfig：gateway/local 强制开启，URL/key/timeout 读取正确", (t) => {
  env(t, {
    MARVIS_TRANSPORT: "gateway",
    MARVIS_GATEWAY_URL: "http://127.0.0.1:8088/v1///",
    MARVIS_GATEWAY_KEY: "gw-key",
    MARVIS_GATEWAY_TIMEOUT_MS: "1234",
  })
  const c = gatewayConfig()
  assert.equal(c.enabled, true)
  assert.equal(c.explicit, true)
  assert.equal(c.url, "http://127.0.0.1:8088/v1", "末尾斜杠要剥掉，gatewayFetch 直接拼路径")
  assert.equal(c.key, "gw-key")
  assert.equal(c.timeoutMs, 1234)

  process.env.MARVIS_TRANSPORT = "local"
  assert.equal(gatewayConfig().enabled, true, "local 与 gateway 等价")
})

test("gatewayConfig：只给 URL 或 key 也算配置好；超时非法值回落默认", (t) => {
  env(t, {
    MARVIS_TRANSPORT: undefined,
    MARVIS_GATEWAY_URL: "http://127.0.0.1:9000/v1",
    MARVIS_GATEWAY_KEY: undefined,
    MARVIS_GATEWAY_TIMEOUT_MS: "not-a-number",
  })
  const byUrl = gatewayConfig()
  assert.equal(byUrl.enabled, true)
  assert.equal(byUrl.explicit, false)
  assert.equal(byUrl.timeoutMs, 600_000)

  delete process.env.MARVIS_GATEWAY_URL
  process.env.MARVIS_GATEWAY_KEY = "only-key"
  const byKey = gatewayConfig()
  assert.equal(byKey.enabled, true)
  assert.equal(byKey.url, DEFAULT_GATEWAY_URL)
})

test("targetPath：三种兼容端点映射到网关相对路径", () => {
  assert.equal(targetPath("https://yybadaccess.3g.qq.com/v1/chat/completions"), "/chat/completions")
  assert.equal(targetPath("https://yybadaccess.3g.qq.com/v1/messages"), "/messages")
  assert.equal(targetPath("https://yybadaccess.3g.qq.com/v1/responses"), "/responses")
  assert.equal(targetPath(new URL("http://127.0.0.1:8088/v1/chat/completions")), "/chat/completions", "URL 实例也能吃")
})

test("targetPath：奇怪 URL 有兜底，不抛异常", () => {
  assert.equal(targetPath("not a url"), "/chat/completions")
  assert.equal(targetPath(""), "/chat/completions")
  assert.equal(targetPath("http://host/v1"), "/chat/completions")
  assert.equal(targetPath("http://host/v1/custom/path///"), "/custom/path")
  assert.equal(targetPath("http://host/v1/chat/completions/extra"), "/chat/completions/extra")
})

test("localGatewayConfigured 是同步判断且不联网", (t) => {
  env(t, { MARVIS_TRANSPORT: undefined, MARVIS_GATEWAY_URL: undefined, MARVIS_GATEWAY_KEY: undefined })
  const plain = localGatewayConfigured()
  assert.equal(typeof plain, "boolean", "返回值必须是布尔，不是 Promise")
  assert.equal(plain, false)

  process.env.MARVIS_GATEWAY_KEY = "k"
  assert.equal(localGatewayConfigured(), true)

  process.env.MARVIS_TRANSPORT = "direct"
  assert.equal(localGatewayConfigured(), false, "直接关掉优先于 key")
})

test("gatewayFetch：清洗上游鉴权头、注入网关 key、body/path/SSE 原样透传", async (t) => {
  const SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  /** @type {any} */
  let captured
  const base = await mockGateway(t, (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(SSE)
    })
  })
  env(t, {
    MARVIS_GATEWAY_URL: base,
    MARVIS_GATEWAY_KEY: "gw-secret",
    MARVIS_TRANSPORT: "gateway",
    MARVIS_DIRECT_TRANSPORT: "",
  })

  const body = JSON.stringify({ model: "main-auto", messages: [{ role: "user", content: "hi" }], stream: true })
  const res = await gatewayFetch("https://yybadaccess.3g.qq.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer upstream-token",
      "Ual-Access-Token": "ual-secret",
      "Ual-Access-Id": "ual-id",
      "X-Stainless-Read-Timeout": "600.0",
      "X-Stainless-Retry-Count": "0",
      "Marvis-Trace": "trace-1",
      "X-Marvis-Trace": "x-trace-2",
      "X-API-Key": "old-key",
      "X-Custom-Keep": "keep-me",
    },
    body,
  })

  assert.equal(res.ok, true)
  assert.equal(captured.method, "POST")
  assert.equal(captured.url, "/v1/chat/completions", "网关基址已含 /v1，拼接后是完整 OpenAI 路径")
  assert.equal(captured.body, body, "body 一字不改")
  assert.equal(captured.headers.authorization, "Bearer gw-secret", "上游 token 换成网关 key")
  assert.equal(captured.headers["x-api-key"], "gw-secret")
  assert.equal(captured.headers["ual-access-token"], undefined)
  assert.equal(captured.headers["ual-access-id"], undefined)
  assert.equal(captured.headers["x-stainless-read-timeout"], undefined)
  assert.equal(captured.headers["x-stainless-retry-count"], undefined)
  assert.equal(captured.headers["marvis-trace"], undefined)
  assert.equal(captured.headers["x-marvis-trace"], undefined)
  assert.equal(captured.headers["x-custom-keep"], "keep-me", "无关头保留")
  assert.equal(captured.headers["user-agent"], "magpie-marvis-gateway/1.0")
  assert.match(res.headers.get("content-type"), /event-stream/)
  assert.equal(await res.text(), SSE, "SSE 帧原样返回")
})

test("gatewayFetch：Headers 实例入参也能清洗，/v1/messages → /messages", async (t) => {
  /** @type {any} */
  let captured
  const base = await mockGateway(t, (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      captured = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  })
  env(t, {
    MARVIS_GATEWAY_URL: base,
    MARVIS_GATEWAY_KEY: undefined,
    MARVIS_TRANSPORT: "gateway",
    MARVIS_DIRECT_TRANSPORT: "",
  })

  const headers = new Headers({ Authorization: "Bearer up", "Ual-Access-Sign": "sig", "X-Keep": "1" })
  const res = await gatewayFetch("http://example.invalid/v1/messages", { method: "POST", headers, body: "PING" })
  assert.equal(captured.url, "/v1/messages")
  assert.equal(captured.body, "PING")
  assert.equal(captured.headers.authorization, undefined, "没配 key 时不能留下上游鉴权头")
  assert.equal(captured.headers["x-api-key"], undefined)
  assert.equal(captured.headers["ual-access-sign"], undefined)
  assert.equal(captured.headers["x-keep"], "1")
  assert.equal((await res.json()).ok, true)
})

test("gatewayStatus：可达时给出模型数，且 JSON 里没有密钥明文", async (t) => {
  const SECRET = "super-secret-key-do-not-leak"
  const base = await mockGateway(t, (req, res) => {
    assert.equal(req.method, "GET")
    assert.equal(req.url, "/v1/models")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }))
  })
  env(t, {
    MARVIS_GATEWAY_URL: base,
    MARVIS_GATEWAY_KEY: SECRET,
    MARVIS_TRANSPORT: "gateway",
  })

  const s = await gatewayStatus()
  assert.equal(s.mode, "gateway")
  assert.equal(s.url, base)
  assert.equal(s.keyConfigured, true)
  assert.equal(s.reachable, true)
  assert.equal(s.models, 3)
  assert.equal(s.error, undefined)
  assert.equal(JSON.stringify(s).includes(SECRET), false, "自检输出不能带密钥明文")
})

test("gatewayStatus：不可达时 reachable=false、models=0、error 有值", async (t) => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))

  env(t, {
    MARVIS_GATEWAY_URL: `http://127.0.0.1:${port}/v1`,
    MARVIS_GATEWAY_KEY: undefined,
    MARVIS_TRANSPORT: "gateway",
  })
  const s = await gatewayStatus()
  assert.equal(s.mode, "gateway")
  assert.equal(s.reachable, false)
  assert.equal(s.models, 0)
  assert.equal(s.keyConfigured, false)
  assert.equal(typeof s.error, "string")
  assert.ok(s.error.length > 0)
})
