# 交付汇总：magpie-marvis 手机端 503 分析 + 子智能体协作成果

## 一、最终结论（三句话）

1. 截图回复的大方向对：10123 是 PC / AG-UI WS relay 端口，手机没有这个进程；8088 HTTP 网关需要先起来再让插件指向它。
2. 真正主线逻辑不在 `gateway.mjs`，而在 `src/marvis/localgateway.mjs` + `src/hooks/loader.mjs:437-464`：手机 HTTP 网关使用 `MARVIS_GATEWAY_URL` / `MARVIS_TRANSPORT` / `gateway.json`，默认 `http://127.0.0.1:8088/v1`，并有 1.5 秒 `/models` 探测。
3. `MARVIS_GW_URL` 是另一条 AG-UI WS relay（10123）的变量，不是 8088 网关变量；把两者混在一起会越改越乱。

## 二、源码证据要点

- 10123 默认值：`src/marvis/gateway.mjs:38` → `const DEFAULT_URL = "ws://127.0.0.1:10123/"`。
- AG-UI WS 变量：`src/marvis/gateway.mjs:105,379` → `MARVIS_GW_URL`。
- 8088 默认值：`src/marvis/localgateway.mjs:36` → `DEFAULT_GATEWAY_URL="http://127.0.0.1:8088/v1"`。
- HTTP 网关变量：`src/marvis/localgateway.mjs:38-39` → `MARVIS_GATEWAY_URL`、`MARVIS_TRANSPORT`。
- gateway.json 读取：`src/marvis/localgateway.mjs:60-78`。
- mode/url/key/timeoutMs 解析：`src/marvis/localgateway.mjs:84-105`。
- 自动探测：`src/marvis/localgateway.mjs:118-140`，1.5s timeout，30s 缓存。
- 实际生效分支：`src/hooks/loader.mjs:437-464`，先 localGatewayEnabled，再 viaGateway。
- 占位账号：`src/hooks/methods.mjs:370` 只有 `gatewayConfig().enabled` 才显示。
- phone-setup.sh：`phone-setup.sh:39-53` 从 config.json 读端口，默认 8088，写 gateway.json，`:60-62` 启动网关。

## 三、按通道修复

### A. 你走手机 HTTP/OpenAI 网关（8088，推荐）

Termux 里：

```sh
export MARVIS_GATEWAY_URL=http://127.0.0.1:8088/v1
export MARVIS_TRANSPORT=gateway
```

或写 `~/.magpie-marvis-native/gateway.json`：

```json
{
  "mode": "gateway",
  "url": "http://127.0.0.1:8088/v1",
  "timeoutMs": 600000
}
```

验证：

```sh
curl -sS -i http://127.0.0.1:8088/v1/models
```

### B. 错误仍指向 `ws://127.0.0.1:10123/`

那是 AG-UI WS relay 通道，应设置：

```sh
export MARVIS_WS_MODE=remote
# 或提供 PC relay / MARVIS_HANDSHAKE
```

`MARVIS_GW_URL` 只用于 WS relay，不要指向 `http://127.0.0.1:8088/v1`。

## 四、可优化方案

1. 诊断增强（优先）：在 doctor / gatewayConfigDebug 中输出 mode/url 来源（env/file/default）和 8088 `/models` 探测结果。
2. 文档纠偏：明确区分 8088 HTTP 与 10123 WS 两套变量，修正“默认 gateway”的误导表述。
3. 实现语义修复：`src/hooks/loader.mjs:484` 的 `openclawEnabled()` 应考虑 `MARVIS_TRANSPORT=openclaw`，否则文档说切 openclaw 实际只关 HTTP 网关。
4. 保留 AG-UI WS 侧 gateway.mjs 的可观测性补丁（source 日志、gatewayStatus 增字段），作为独立改进，不用于解决 HTTP 主线 503。

## 五、已生成文件

- [诊断脚本 magpie-marvis-diag.sh](magpie-marvis-diag.sh)：Termux 只读诊断，检查环境变量、gateway.json、10123/8088 监听、/v1/models、抓包建议与结构化结论。
- [优化方案 magpie-marvis-503-optimization-plan.md](magpie-marvis-503-optimization-plan.md)：含完整源码证据、截图回复评价、配置/诊断/代码三层方案。
- [代码补丁设计 magpie-marvis-code-patch-design.md](magpie-marvis-code-patch-design.md)：按复核证据修正，区分真正优先的 localgateway 诊断补丁与 AG-UI WS 参考补丁。

## 六、子智能体成果

- `repo-reviewer`：全仓库复核，给出精确行号证据，纠正了两条通道变量混淆。
- `diag-script-writer`：生成 Termux 诊断脚本，已按复核证据二次修正。
- `patch-designer`：生成 gateway.mjs 补丁初稿，已按复核结论降级为 AG-UI WS 参考方案并在补丁文档中补充真正优先的 localgateway 修复。
