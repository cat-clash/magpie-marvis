# 代码层补丁设计：gateway.mjs 最小可合并方案（带复核修正）

来源：子智能体 `patch-designer` 初稿，已按 `repo-reviewer` 的全仓库证据修正。

## 0. 复核后的定位修正

补丁初稿把 `MARVIS_GW_URL` 当成 8088 网关变量来改，这是错误的。全仓库证据表明：

- `src/marvis/gateway.mjs` / `MARVIS_GW_URL` / 10123 是 **AG-UI WS relay / PC 客户端** 通道；
- `src/marvis/localgateway.mjs` / `MARVIS_GATEWAY_URL` / `MARVIS_TRANSPORT` / gateway.json / 8088 是 **手机 HTTP/OpenAI 网关** 主线，由 `src/hooks/loader.mjs:437-464` 实际生效；
- `src/marvis/localgateway.mjs:36-39,60-78,84-105,118-140` 已经实现了 gateway.json 读取、env 优先和 1.5s `/models` 探测。

因此“给 gateway.mjs 改默认 8088 WS”不能解决主线的 HTTP 网关 503，且可能引入协议错误。下面保留初稿作为 **AG-UI WS relay 可观测性补丁参考**，并给出真正应优先做的 **localgateway 诊断增强补丁**。

## 0.1 真正优先的补丁：localgateway 诊断增强

目标：不破坏现有选择逻辑，只让来源可观测，解决“用户不知道自己走哪条路”的问题。

在 `src/marvis/localgateway.mjs` 的 `gatewayConfig()` 返回值中增加 source 信息，或在 `doctor` 输出中增加：

```js
export function gatewayConfigDebug() {
  const c = gatewayConfig()
  const file = gatewayFileConfig()
  return {
    enabled: c.enabled,
    forced: c.forced,
    configured: c.configured,
    modeSource: process.env.MARVIS_TRANSPORT
      ? "env:MARVIS_TRANSPORT"
      : file?.mode || file?.transport
        ? "gateway.json"
        : "auto",
    urlSource: process.env.MARVIS_GATEWAY_URL
      ? "env:MARVIS_GATEWAY_URL"
      : file?.url
        ? "gateway.json"
        : "default",
    url: c.url,
    mode: c.mode,
    nativeDir: nativeDir(),
  }
}
```

并在 `scripts/doctor.mjs` 中输出：

```js
console.log(JSON.stringify(gatewayConfigDebug(), null, 2))
console.log(`probe ${cfg.url}/models -> ${await probeGateway(cfg.url) ? 'ok' : 'fail'}`)
```

文档纠偏：

- README.md:17 和 README-FINAL.md:31 中“默认 gateway”改成“未显式配置时探测 8088，可达才走 gateway，否则按既有 off/openclaw 规则”；
- 变量表明确分两条链路：8088 HTTP=`MARVIS_GATEWAY_URL`/`MARVIS_TRANSPORT`；10123 WS=`MARVIS_GW_URL`/`MARVIS_WS_MODE`；
- 统一 phone-kit 路径描述（README.md:51 vs 根目录 gateway.example.json）。

实现语义修复：

- `src/hooks/loader.mjs:484` 的 `openclawEnabled()` 应同时考虑 `MARVIS_TRANSPORT=openclaw`，否则文档说切 openclaw 实际只关了 HTTP 网关却没开启 WS，并补测试。

## 0.2 保留参考：AG-UI WS relay 的 gateway.mjs 可观测性补丁

以下为 `patch-designer` 初稿，只针对 10123 AG-UI WS relay，**不能替代上面的 localgateway 修复**。

## 设计目标

1. `MARVIS_GW_URL` 仍为最高优先级；
2. PC 默认仍是 `ws://127.0.0.1:10123/`；
3. 手机环境默认改走本地 Python 网关 `ws://127.0.0.1:8088/`，或在 remote 模式下走远端地址；
4. 记录并返回“URL 来源”，通过 `gatewayStatus()` 暴露；
5. 环境变量名统一为 `MARVIS_GW_URL` / `MARVIS_WS_MODE`，不新增第二套冲突变量。

## 决策表

| 条件 | 选中 URL | source |
|---|---|---|
| `MARVIS_GW_URL` 非空 | 环境变量值 | `env:MARVIS_GW_URL` |
| `MARVIS_WS_MODE=remote` 且 `MARVIS_GW_REMOTE_URL` 非空 | 远端 URL | `env:MARVIS_GW_REMOTE_URL` |
| `MARVIS_WS_MODE=remote` 且无远端 URL | `ws://127.0.0.1:10123/` | `fallback:remote-default` |
| mobile 环境，未设置 `MARVIS_GW_URL` | `ws://127.0.0.1:8088/` | `default:mobile-python-gateway-8088` |
| PC 环境，未设置环境变量 | `ws://127.0.0.1:10123/` | `default:pc-10123` |

## 核心代码段

建议放在 `DEFAULT_URL` 附近：

```js
// PC 历史默认端口保持不变。
const DEFAULT_URL = "ws://127.0.0.1:10123/";

// 手机上本地 Python 网关默认监听 8088。
const MOBILE_LOCAL_URL = "ws://127.0.0.1:8088/";

// remote 模式下允许用 MARVIS_GW_REMOTE_URL 指定远端网关；
// 未指定时回退到历史默认端口。
const REMOTE_FALLBACK_URL = DEFAULT_URL;

function normalizeMode(value) {
  return String(value || "").trim().toLowerCase();
}

function looksLikeMobileRuntime() {
  const mode = normalizeMode(process.env.MARVIS_WS_MODE);
  if (mode === "mobile" || mode === "remote") return true;

  const hints = [
    process.env.MARVIS_RUNTIME,
    process.env.MARVIS_CLIENT,
    process.env.MARVIS_ENV,
    process.env.USER_AGENT,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .join(" ");

  return /(^|[^a-z])(mobile|phone|android|ios|iphone|ipad)([^a-z]|$)/.test(hints);
}

function resolveGatewayUrl() {
  const explicit = process.env.MARVIS_GW_URL;
  if (explicit && explicit.trim()) {
    return {
      url: explicit.trim(),
      source: "env:MARVIS_GW_URL",
      mobile: looksLikeMobileRuntime(),
      mode: normalizeMode(process.env.MARVIS_WS_MODE) || "auto",
    };
  }

  const mode = normalizeMode(process.env.MARVIS_WS_MODE);
  const mobile = looksLikeMobileRuntime();

  if (mode === "remote") {
    const remote = process.env.MARVIS_GW_REMOTE_URL;
    return {
      url: (remote && remote.trim()) || REMOTE_FALLBACK_URL,
      source:
        remote && remote.trim()
          ? "env:MARVIS_GW_REMOTE_URL"
          : "fallback:remote-default",
      mobile: true,
      mode,
    };
  }

  if (mobile) {
    return {
      url: MOBILE_LOCAL_URL,
      source: "default:mobile-python-gateway-8088",
      mobile: true,
      mode: mode || "mobile-auto",
    };
  }

  return {
    url: DEFAULT_URL,
    source: "default:pc-10123",
    mobile: false,
    mode: mode || "auto",
  };
}

const GATEWAY_RESOLUTION = resolveGatewayUrl();

function logGatewaySource(resolution) {
  const line =
    `[marvis-gateway] url=${resolution.url} ` +
    `source=${resolution.source} ` +
    `mode=${resolution.mode} ` +
    `mobile=${resolution.mobile ? "yes" : "no"}`;
  if (typeof process.stdout?.write === "function") {
    process.stdout.write(line + "\n");
  } else if (typeof console?.info === "function") {
    console.info(line);
  }
}

logGatewaySource(GATEWAY_RESOLUTION);
```

## 连接处替换

原：

```js
const url = process.env.MARVIS_GW_URL || DEFAULT_URL;
```

替换为：

```js
const url = GATEWAY_RESOLUTION.url;
```

注意：若源码里实际写法带 token（例如 `const baseUrl = ...; const url = withToken(baseUrl, token);`），保留 `withToken`，只把 `baseUrl` 的来源替换为解析结果：

```js
const baseUrl = GATEWAY_RESOLUTION.url;
const url = withToken(baseUrl, token);
```

## gatewayStatus() 替换

```js
export function gatewayStatus() {
  return {
    url: GATEWAY_RESOLUTION.url,
    source: GATEWAY_RESOLUTION.source,
    mode: GATEWAY_RESOLUTION.mode,
    mobile: GATEWAY_RESOLUTION.mobile,
    envOverride: Boolean(process.env.MARVIS_GW_URL && process.env.MARVIS_GW_URL.trim()),
    remoteUrlOverride: Boolean(
      process.env.MARVIS_GW_REMOTE_URL && process.env.MARVIS_GW_REMOTE_URL.trim()
    ),
    defaults: {
      pc: DEFAULT_URL,
      mobileLocal: MOBILE_LOCAL_URL,
      remoteFallback: REMOTE_FALLBACK_URL,
    },
  };
}
```

## relayHint() 文案补充

若 `relayHint()` 当前已有返回字符串，只扩展其中手机提示，不改识别逻辑：

```js
"Phone detected. Local Python gateway defaults to ws://127.0.0.1:8088/. " +
"Run phone-setup.sh, or set MARVIS_WS_MODE=remote with " +
"MARVIS_GW_REMOTE_URL for a remote gateway. " +
"Use MARVIS_GW_URL to explicitly override any default."
```

## 文档/example 同步

统一环境变量：

```bash
MARVIS_GW_URL
MARVIS_WS_MODE
MARVIS_GW_REMOTE_URL
MARVIS_RUNTIME
```

`.env.example` 建议：

```env
# Explicit gateway override. Highest priority.
# MARVIS_GW_URL=ws://127.0.0.1:8088/

# Gateway mode: auto | mobile | remote
MARVIS_WS_MODE=auto

# Used only when MARVIS_WS_MODE=remote.
# MARVIS_GW_REMOTE_URL=ws://REMOTE_HOST:8088/

# Optional runtime hints used by mobile auto-detection.
# MARVIS_RUNTIME=mobile
```

重要提醒：当前 `gatewayChatStream` 使用 `new WebSocket(url)`，期望 WebSocket URL。`http://127.0.0.1:8088/v1` 是 OpenAI 兼容 HTTP 端点，不能直接作为 `MARVIS_GW_URL`；本地 Python 网关必须暴露 WS 端点（例如 `ws://127.0.0.1:8088/`）或另写 HTTP transport。
