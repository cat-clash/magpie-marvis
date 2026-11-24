# magpie-marvis 手机端 503 根因分析与可优化方案

## 0. 事件背景

用户在手机 / Termux 环境导入 `cat-clash/magpie-marvis` 插件后，每次请求仍返回 503，错误指向 `ws://127.0.0.1:10123/`。截图中的 Marvis 回复认为：两个仓库是同一项目；10123 是 PC 客户端端口，手机没有该进程；应先起 8088 网关，再写 `~/.magpie-marvis-native/gateway.json` 并测试。

## 1. 源码核对结果（子智能体全仓库复核后修正）

抓取与复核来源：

- `https://raw.githubusercontent.com/cat-clash/magpie-marvis/main/src/marvis/gateway.mjs`
- 子智能体 `repo-reviewer` 对 main 分支全仓库复核（package.json 0.7.3；README 标题仍写 final 0.7.0）

关键事实（行号均为仓库 main 文件行号）：

1. `src/marvis/gateway.mjs:38` 确实硬编码：
   ```js
   const DEFAULT_URL = "ws://127.0.0.1:10123/"
   ```
   这是 **AG-UI WS relay / PC 客户端** 通道，变量是 `MARVIS_GW_URL`（`src/marvis/gateway.mjs:105,379`），不是手机 HTTP 网关变量。
2. 手机上 8088 / OpenAI 兼容网关的主线逻辑在 `src/marvis/localgateway.mjs`，不是 `gateway.mjs`：
   - `src/marvis/localgateway.mjs:36` 默认 `DEFAULT_GATEWAY_URL="http://127.0.0.1:8088/v1"`；
   - `:38` 变量 `MARVIS_GATEWAY_URL`；
   - `:39` 变量 `MARVIS_TRANSPORT`；
   - `:60-78` 实读 `gateway.json`；
   - `:84-105` 读取 mode/url/key/timeoutMs；
   - `:118-140` 未显式配置时 1.5 秒探测 `${url}/models`，30 秒缓存，可达才走 gateway。
3. `gateway.json` 确实被读取：`src/marvis/localgateway.mjs:60-78`；字段来源 `:84-105`；`phone-setup.sh:45-52` 实际写入；`tests/localgateway.test.mjs` 有覆盖。
4. 真实环境变量要按通道区分：
   - HTTP/OpenAI 8088：`MARVIS_GATEWAY_URL` / `MARVIS_TRANSPORT` / `MARVIS_GATEWAY_KEY` / `MARVIS_GATEWAY_TIMEOUT_MS` / `MARVIS_GATEWAY_CONFIG`；
   - AG-UI WS 10123：`MARVIS_GW_URL` / `MARVIS_WS_MODE` / `MARVIS_HANDSHAKE`。
5. 真正生效的分支在 `src/hooks/loader.mjs:437-464`：先 `localGatewayEnabled()`，viaGateway 时直接 `gatewayFetch`，先于 openclaw/直连分支。
6. 关闭规则：`MARVIS_TRANSPORT off/direct/openclaw/ws/relay/remote` 或旧 `MARVIS_WS_MODE=off` 会关掉 HTTP 网关（`src/marvis/localgateway.mjs:93-98`），但 `MARVIS_TRANSPORT=openclaw` 并不会自动开启 openclaw WS，这是实现语义错位点。
7. `relayHint()` 已识别手机环境并提示 `phone-setup.sh` / `MARVIS_WS_MODE=remote`（`src/marvis/gateway.mjs`），但只对 AG-UI WS relay 报错生效。

## 2. 对截图回复的评价（修正版）

正确部分：

- 10123 是 PC 客户端 / AG-UI WS relay 端口，手机没有对应进程。
- `gateway.json`、`MARVIS_TRANSPORT`、`MARVIS_GATEWAY_URL` 确实是 8088 HTTP 网关通道的真实配置。
- 先起 8088 网关再让插件指向它，顺序不能反。

需要精确化/批评的部分：

1. 截图回复把“总是连 10123”归结为单个默认地址，容易导致混淆：报 503 的 `ws://127.0.0.1:10123/` 属于 AG-UI WS relay 通道；手机 HTTP 网关通道默认是 `http://127.0.0.1:8088/v1`（`src/marvis/localgateway.mjs:36`）。两条链路变量不同，必须分开看。
2. “环境变量入口等于不存在”过绝对：Termux 里可以 `export`，源码也确实读取 `MARVIS_GATEWAY_URL` / `MARVIS_TRANSPORT`。
3. “三条 fallback 条件”基本对应源码，但要补精确定义：`gateway.json` 由 `src/marvis/localgateway.mjs:60-78` 实读；env 优先；未显式配置时有 1.5s `/models` 探测（`:118-140`），不是无条件默认走 8088。
4. “0.7.3 唯一有实质意义的改动”需要完整 diff 支撑。
5. 网关侧账号池与 maggie 占位账号是两层，截图未讲清。
6. 只验证 `curl /v1/models` 和 `maggie provider test`，没有验证实际错误来自哪条通道。

## 3. 可优化方案

### 3.1 立即生效的配置层方案

手机 HTTP/OpenAI 网关（8088）正确写法：

```sh
export MARVIS_GATEWAY_URL=http://127.0.0.1:8088/v1
export MARVIS_TRANSPORT=gateway
```

持久化写入 `~/.bashrc` / `~/.profile`。若走配置文件，`~/.magpie-marvis-native/gateway.json`：

```json
{
  "mode": "gateway",
  "url": "http://127.0.0.1:8088/v1",
  "timeoutMs": 600000
}
```

如果错误仍是 `ws://127.0.0.1:10123/`，这是 AG-UI WS relay 通道，应改：

```sh
export MARVIS_WS_MODE=remote
# 或提供 PC relay/MARVIS_HANDSHAKE；MARVIS_GW_URL 只适用于 WS relay
```

重要：不要混淆 `MARVIS_GW_URL` 和 `MARVIS_GATEWAY_URL`。前者是 10123 AG-UI WS，后者是 8088 HTTP 网关。

### 3.2 诊断层方案

创建 `magpie-marvis-diag.sh`，检查：

- 平台与环境变量；
- `gateway.json` 存在与内容；
- 10123、8088 监听情况；
- 8088 `/v1/models` 响应；
- tcpdump / ss 抓实际连接。

### 3.3 代码层方案

最小修改 `src/marvis/gateway.mjs`：

1. 保留 `process.env.MARVIS_GW_URL` 为最高优先级。
2. 在 mobile 环境下，未显式设置 `MARVIS_GW_URL` 时，不再默认 10123；改为提示用户配置本地网关或 remote，或指向手机可用的 relay。
3. 由于当前通道是 WebSocket，不能简单把默认改成 `http://127.0.0.1:8088/v1`；要么新增 HTTP transport，要么让手机本地网关暴露 WS 端点。
4. `gatewayStatus()` 增加 `source` 字段，明确 URL 来源。
5. 文档/example 统一环境变量名为 `MARVIS_GW_URL`。

## 4. 已安排的子智能体

- `repo-reviewer`：复核全仓库真实 fallback 逻辑、配置名与行号证据。
- `diag-script-writer`：编写 Termux 诊断脚本 `magpie-marvis-diag.sh`。
- `patch-designer`：设计最小可合并的 `gateway.mjs` 补丁方案。

## 5. 当前状态

等待三个子智能体返回后，汇总为最终执行清单。
