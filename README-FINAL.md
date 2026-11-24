# magpie-marvis-final · Marvis 最终版插件（0.7.0 · PC + 手机通用）

> provider id 固定为 `marvis` —— 已有账号、路由组、模型配置**全部无缝沿用**。
> 本版合并了 3 条线的全部可用成果：`MYCF711/magpie-marvis`（0.2.58 现签修复）·
> `cat-clash/magpie-marvis-ws`（openclaw WS 传输）·
> `yy158358/Marvis-proxy-public`（本地网关协议 / 风控熔断 / 4100406 护栏）。
> **0.6.0 起正名为纯 magpie / OpenCode provider 插件**；手机通过本地 OpenAI 网关使用。

---

## 一、本版修了什么（对着 403 / 503 说）

| 症状 | 根因（社区实测） | 本版处理 |
|---|---|---|
| `403 4100404`（magpie 显示 503 risk_blocked） | uskey 必须按本次请求上下文由 Beacon SDK 现签；11-22 起 PC 端网关被全局风控，11-24 实测已恢复 | 每请求按 bus_info 七段现签 uskey；**默认走本地网关**；`429 + Retry-After` 取代裸 503；连续 5 次后熔断，退避改为指数退避（基数 `base×2^n`，上限 8h，±10% jitter），状态持久化到 `<稳定资产目录>/breaker-state.json`（重启不丢） |
| `401 4100403`（登录态过期） | 续期端点写错、微信 token 只有 2h、并发刷新互相打掉 | 正确端点 `POST /marvis_client_login/marvis_refresh_token` + 同账号串行刷新 + 60s 成功回放；-107/-101 才判登录失效 |
| `403 非法请求 / 4100406` | system 首行身份词对命中内容指纹 | 兜底首行换**官方中文身份句**「你是功能强大的 AI 助手，名字叫 Marvis（马维斯）。」；可选 `MARVIS_GUARD_WORD_JOINER=1` 注入 U+2060 二道防线 |
| `400 4130001` / 裸 `503` / 工具调用 400 | 真实模型 id 直传 / SSE 被 text/plain 包裹 / 空 `parameters` 被拒 | 槽位名归一（模型级错误一律 404）；content-type 归一为 event-stream、流原样透传；`normalizeTools` 补空 object schema |
| UA 触发风控 | Headers 把双 UA 逗号拼接 | 按小写判重合并，上游只收到 `AsyncOpenAI/Python 2.32.0` |

---

## 二、传输通道（默认推荐顺序：gateway → off → openclaw）

```
MARVIS_TRANSPORT = gateway    ← 默认推荐：本地 OpenAI 兼容网关 http://127.0.0.1:8088/v1，跨平台（PC + 手机）✅
                = off        ← PC HTTP 直连 yybadaccess /v1/chat/completions，Beacon 现签 uskey，零模拟器依赖
                = openclaw   ← 手机会话域 WS（remote）或 PC 客户端本地网关（relay），需 native/handshake.log
```

- 不设 `MARVIS_TRANSPORT` 时默认 `gateway`，并自动探测本地 `127.0.0.1:8088` 网关；网关地址 / 鉴权 / 超时可用
  `MARVIS_GATEWAY_URL` / `MARVIS_GATEWAY_KEY` / `MARVIS_GATEWAY_TIMEOUT_MS` 覆盖。旧变量 `MARVIS_WS_MODE` 兼容保留。
- **gateway（默认）**：跨平台，PC 与手机都走同一个本地 OpenAI 兼容网关。手机出票、登录由网关层承担，
  插件本体只发标准 `/v1/chat/completions` 请求，不需要 Windows 原生组件。网关的搭建见第四节。
- **off（PC HTTP 直连）**：实测（2026-11-24）Beacon 现签 34ms + `magpie provider test` 1690ms PONG，HTTP 200。
  uskey 出票资产放**稳定资产目录** `C:\Users\<你的用户名>\.magpie-marvis-native`（用户环境变量 `MARVIS_NATIVE_DIR`），
  在插件目录之外，`magpie plugin update` 清不掉，跨更新免疫。
- **openclaw（WS，备选）**：`remote` 用手机会话域 wss，握手头 `sessionId` / `token` / `Host` 与可选 `frames.log`
  放资产目录（`MARVIS_NATIVE_DIR`），凭据短命（≈15-20 分钟），失效重抓；`relay` 用 PC 客户端本地网关
  `ws://127.0.0.1:10123`，token 自动从 `%TEMP%\Tencent\Marvis\logs\Marvis.log` 的 `AiStarter.GetGatewayToken` 取最后一条。
  抓包工具链（adb + frida + 断网重连）**本机自备，不随插件分发**。
- **直连代理剥离**：所有上游请求构造前临时剥离代理变量、完成后恢复（`MARVIS_DIRECT_FETCH=0` 可关）。
- **流式透传（0.7.0 新增）**：`gateway`（PC AG-UI WS）与 `openclaw`（手机会话域 WS）两条通道改为流式 ——
  网关侧 `TEXT_MESSAGE_CONTENT` / openclaw 侧 `event:chat` 增量实时转成 OpenAI `chat.completion.chunk` SSE，
  首字延迟从「整轮结束」降到秒级；**非流式行为不变**。flatten 改进：单条 user 消息原样直发，
  system 独立置顶保留；`agent.run` 的 requestId 已唯一化。
- **主动续期（0.7.0）**：`refreshLead`（宿主「距到期多久算该续」的提前量）改为可配置
  `MARVIS_REFRESH_LEAD_MS`（默认 `2592000000`，即 30 天；clamp 到微信 TTL 的 1/3 防连续刷新）——
  到点由**宿主**调续期钩子并落库，微信 2h token 不再周期性掉线；30 天窗口对微信 2h / QQ 30 天
  都落在窗口内，即「持续保活」：每次节流放行就顺手续一次，token 永远新。
  ⚠ 提前续期必须在宿主侧执行：插件在请求路径里刷出来的新 token 拿不到写回宿主的入口，
  刷了也存不住，反而会每请求刷一次。同模块另提供 `needsProactiveRefresh()`（纯判定，供诊断）
  与 `proactiveRefresh()`（带同账号最小间隔 `MARVIS_REFRESH_MIN_INTERVAL_MS`，默认 1 小时节流，
  `0` 关闭 —— 这才是把「30 天窗口」压到「每小时最多一次」的节奏阀），
  供**能把结果落库**的调用方使用；主动续期失败（`fatal` / `error` / `throttled`）一律不向宿主传播，
  等真实 401 仍走宿主正常流程。

### 风控与节奏（0.7.0）

- **熔断器**：连续 `MARVIS_RISK_THRESHOLD`（默认 5）次风控后本地拒绝出网，退避改为**指数退避**——
  以 `MARVIS_RISK_COOLDOWN_MS` 为基数按 `base×2^n` 增长，上限 8h，±10% jitter；
  半开状态一次失败**立即重开**，不再等满整个退避周期；状态持久化到 `<稳定资产目录>/breaker-state.json`（重启不丢）；
  `riskEvents()` 提供事件环形缓冲〔接口形态与保留条数〔待主控核对〕〕。
- **请求节奏闸 pacing**：出站补全请求最小间隔 `MARVIS_MIN_REQUEST_INTERVAL_MS`（默认 `800`）+
  随机抖动 `MARVIS_REQUEST_JITTER_MS`（默认 `400`），压平请求节奏。
- **随机 uskey 兜底默认关闭（0.7.0 行为变更）**：没有 `native/`、也没有 `MARVIS_USKEY_URL` 时 **fail-fast**
  报可操作错误，不再静默放行随机票（线上必 `4100404`）；显式设 `MARVIS_ALLOW_RANDOM_USKEY=1` 才找回旧兜底（仅开发排查用）。

## 三、PC 端安装（magpie / OpenCode）

```bash
magpie plugin add ./dist/magpie-marvis-final      # 本地路径安装
magpie plugin login marvis                        # QQ / 微信 OAuth（或从本机 Marvis 客户端导入）
magpie provider test marvis-plugin
```

默认即 `gateway`：PC 上可先跑本地网关（第四节）走统一通道；不跑网关时按下面的 off 直连配置：

1. 建稳定资产目录 `C:\Users\<你的用户名>\.magpie-marvis-native`，写入 `openclaw.json`：`{"mode":"off"}`
2. 设**用户环境变量** `MARVIS_NATIVE_DIR=C:\Users\<你的用户名>\.magpie-marvis-native` —— 资产在插件目录之外，`magpie plugin update` 清不掉，跨更新免疫
3. 设 `MARVIS_TRANSPORT=off`（或沿用旧 `MARVIS_WS_MODE=off`）

uskey 出票资产（off 通道需要；gateway / openclaw WS 通道不需要）：

```bash
node tools/extract-native.mjs    # 从 Program Files\Tencent\Marvis\Application\<ver>\win32-native 提取 Beacon 4 件套到插件 native/，
                                 # 再把 4 件套复制进资产目录（工具只写插件目录，运行时读的是 MARVIS_NATIVE_DIR）
# 无 Windows 客户端时：MARVIS_USKEY_URL=http://127.0.0.1:4617/uskey（node tools/uskey-server.mjs）
```

## 四、手机安装（Termux / PRoot / magpie 安卓壳）

**手机端现在可以直接点 QQ / 微信登录，三个入口都在**（QQ 登录 / 微信登录 / 浏览器·粘贴回调地址）。

> 0.7.1 修的就是这条路上的两个真问题：
> 上一版手机端返回 `{ opened:true, method:"auto" }`，而宿主在这两种形态下渲染的东西不一样
> （2026-11-24 用探针插件 + `magpie plugin login` 实测）：
>
> | authorize() 返回 | 宿主渲染 |
> |---|---|
> | `opened:false` + `method:"code"` | 授权页 URL + instructions + **「Code:」粘贴输入框** |
> | `opened:true` + `method:"auto"` | 只有 URL + instructions，**没有「Code:」那一行** |
>
> 上一版正好是第二种 —— 于是手机上点登录只剩一段文字：没有输入框可粘，
> 也没有「打开浏览器」按钮可点（截图现象）。现在手机端一律 `method:"code"` + 不设 `opened:true`，
> 两个控件都拿回来了。宿主协议层：`method === "code"` 时，用户在「Code:」框里输入的内容
> 会原样交给插件的 `callback(code)`。
>
> QQ 登录另外用 `mqqapi://forward/url` 真正唤起手机 QQ App（`display=mobile` 只影响网页版布局，
> 不会唤起 App）；微信是「网站应用扫码登录」页，手机上只能**长按二维码 → 识别图中二维码**。

手机登录 4 步：

1. 供应商 `marvis` → 添加账号 → 点 **QQ 登录 / 微信登录**（手机端排在最前；「本地网关（免登录）」占位账号在真登录之后）。
2. 点宿主给出的「打开浏览器」按钮 —— QQ 会唤起已装的手机 QQ（没装则网页版登录）；微信显示二维码，
   **长按二维码 → 识别图中二维码**跳进微信授权。
3. 授权完成后浏览器停在 `yybadaccess…` 回调地址（页面可能是空白/报错，**这是预期**），把地址栏整条复制。
4. 粘贴到登录界面里的 **Code 输入框**提交。若该壳版本没有这个输入框，登录提示里还给了一个
   本机登录页地址（`http://127.0.0.1:4618/`），上面有「唤起 QQ 按钮 + 粘贴框」，照样能走通
   （失败可在同一页重试，10 分钟超时）。

gateway 通道仍然推荐（账号池在网关侧维护），但**不再是手机唯一的出路**——想单独用手机 magpie 的，
直接按上面 4 步登录即可。仍然**不要折腾 adb+frida 抓 handshake.log**（凭据 15–20 分钟就失效，
那条 remote 路不适合手机）。

### 最快路径：下载 phone-kit 附件，一条命令（gateway 通道）

Release 附件 `magpie-marvis-phone-kit.zip` 已把**插件 + Python 网关 + 一键脚本**打在一起，
不用分别 clone 两个仓库。解压后：

```sh
pkg update && pkg install python curl -y  # Termux 里装 Python 3.8+ 与 curl（网关探活用）
cd magpie-marvis-phone-kit
sh phone-setup.sh                        # 起网关 + 写 gateway.json + 打印后续步骤
```

> 请用 `sh phone-setup.sh` 调用：zip 解压后脚本可能没有可执行位，直接 `./phone-setup.sh` 会报
> `Permission denied`。脚本按 Termux 的 `/bin/sh` 写，配置落在 `$HOME/.magpie-marvis-native/gateway.json`。

脚本做完第 1、3 步（起网关、写配置），剩下的两步在手机 GUI 里点：网关控制台加号登录、
magpie 导入 `plugin/` 目录并加「免登录」账号。

> **附件校验**：从 GitHub Release 页下载 `magpie-marvis-phone-kit.zip` 后，用页面显示的
> asset digest（`sha256:…`）核对：`sha256sum magpie-marvis-phone-kit.zip`。校验值**只以
> Release 页面的 asset digest 为准**，不写在本仓库文档里 —— 因为本文件会随插件打进 zip，
> 在文档里硬编码 zip 哈希会形成「改文档 → zip 变 → 哈希过期」的循环。对不上就是下到旧包 / 下载损坏。

下面是从零手工步骤（没有附件时用）。**以下第 1–4 步是 gateway 通道的装法**；
不想起网关、只想直接登录的，装完第 2 步的插件后按本节开头的手机登录 4 步走即可。

### 第 1 步：在手机上起本地网关（出票 / 登录都在这里）

1. Termux 装 Python 3.8+（`pkg install python`），放置参考仓库 `yy158358/Marvis-proxy-public`
   到手机（出票用的 `.so` 已随包，Termux 里不需要 root）。
2. 在网关目录执行 `sh run.sh start`，网关监听 `127.0.0.1:8088`；浏览器打开
   `http://127.0.0.1:8088/` 进 Web 控制台，**先「加号登录」腾讯 Marvis**（QQ / 微信），
   否则对话会回 `503 no_account`。加号流程：控制台 → 账号池 → `login start` → 手机浏览器登录 → 复制回调 → `login exchange`。

### 第 2 步：装插件到 magpie 手机壳

magpie 插件要走 **magpie 自己的插件管理**，不是 `dsh plugin add`（那条命令装的是 dsh 侧插件）：

1. 把本插件整个目录放到手机（电脑 clone → 打 zip 传手机解压，或直接放到 `Download/`）。
2. magpie App → 侧栏 `≡` → **控制后台 `http://127.0.0.1:3430`** → **插件** → 添加 / 导入 →
   选那个文件夹（壳里的「导入本地插件」SAF 选文件夹入口也行）。

### 第 3 步：开 gateway 模式（写文件，不用环境变量）

手机 magpie 壳没有环境变量入口，用配置文件。建稳定资产目录并写 `gateway.json`：

```sh
mkdir -p ~/.magpie-marvis-native
cat > ~/.magpie-marvis-native/gateway.json <<'EOF'
{
  "mode": "gateway",
  "url": "http://127.0.0.1:8088/v1",
  "key": "",
  "timeoutMs": 600000
}
EOF
```

> 网关若建了 key，把 `key` 填上；网关不在本机就改 `url`。PC 用户仍可用环境变量
> `MARVIS_TRANSPORT=gateway` / `MARVIS_GATEWAY_URL` / `MARVIS_GATEWAY_KEY`，优先级高于文件。

### 第 4 步：在 magpie 里加账号 + 验证

1. 供应商 `marvis` → 添加账号：走 gateway 通道选 **「本地网关（手机推荐，免登录）」**（0.7.0 起排在真登录之后；
   这一步不打开任何浏览器，只是给 magpie 一个占位账号让它出模型）；直接登录则选 **QQ / 微信登录**，按本节开头 4 步走完。
2. `magpie provider test marvis-plugin`；确认 `GET http://127.0.0.1:8088/v1/models` 返回 `marvis/*`，
   再在 dsh-go 里加渠道指向 `http://127.0.0.1:3430/v1`。

> 网关协议与手机出票方案思路来自参考仓库 `yy158358/Marvis-proxy-public`（MIT），
> 本插件的网关转发实现已改写为通用 OpenAI 兼容转发，详见 [`NOTICE.md`](./NOTICE.md)。

## 五、凭据失效怎么办

- **gateway（默认，手机 / PC 通用）**：登录态在网关层维护，凭据失效时回到网关界面重新用加号登录一次即可，插件侧无需改动。
- **off（HTTP 直连，主通道）**：走插件登录态 —— QQ / 微信 token 由内置续期钩子自动刷新（正确端点 + 同账号串行刷新 + 60s 成功回放），真正失效（-107/-101）时在 magpie 重新登录一次即可，无需重装、无需抓包。
- **openclaw（WS 备选）**：握手凭据实测短命（≈15-20 分钟）。凭据失效时插件会报出明确的失效诊断 —— 此时把新抓的 `handshake.log` 放回资产目录（`MARVIS_NATIVE_DIR`）即可恢复，无需重装。抓包工具链（adb + frida + 断网重连）是**本机自备**的开发台产物，不随插件分发；插件本体永不调用模拟器 / adb / frida。

## 六、环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARVIS_TRANSPORT` | 未显式设置（自动探测 8088） | 传输通道：`gateway` / `off` / `openclaw` / `ws` / `relay` / `remote`（后四者会关掉 HTTP 网关） |
| `MARVIS_GATEWAY_URL` | `http://127.0.0.1:8088/v1` | 本地 OpenAI 兼容 **HTTP** 网关地址（8088） |
| `MARVIS_GW_URL` | `ws://127.0.0.1:10123/` | PC AG-UI **WS relay** 地址（10123），与 8088 HTTP 网关无关；默认仅 PC 客户端通道使用 |
| `MARVIS_GATEWAY_CONFIG` | 空 | 显式指定 gateway.json 路径；优先于默认稳定目录候选 |
| `MARVIS_GATEWAY_KEY` | 空 | 网关鉴权 key（可选） |
| `MARVIS_GATEWAY_TIMEOUT_MS` | `600000` | 网关请求超时（毫秒） |
| `MARVIS_WS_MODE` | 兼容保留 | 旧变量：有 handshake → remote，否则 relay；`off` 强制 HTTP 直连 |
| `MARVIS_NATIVE_DIR` | 空 | 稳定资产目录（建议 `C:\Users\<你的用户名>\.magpie-marvis-native`）：Beacon 出票文件 + `openclaw.json` |
| `MARVIS_DIRECT_FETCH` | 开 | `0` = 关闭直连代理剥离（directnet.mjs 回落普通 fetch） |
| `MARVIS_WS_URL` / `MARVIS_HANDSHAKE` / `MARVIS_FRAMES` | 资产目录下同名文件 | WS 端点与抓包产物 |
| `MARVIS_SESSION_KEY` | `agent:main:main` | chat.send 的 sessionKey |
| `MARVIS_WS_KILL_CMD` | 空 | 每请求前 force-stop 手机 App（独占会话，慎用） |
| `MARVIS_RISK_STATUS` | `429` | 4100404 对外状态码（设 503 找回旧行为） |
| `MARVIS_RISK_THRESHOLD` / `MARVIS_RISK_COOLDOWN_MS` | `5` / `1800000` | 熔断阈值 / 退避基数（0.7.0 起语义变更：指数退避 `base×2^n`，上限 8h，±10% jitter，不再是固定冷却时长） |
| `MARVIS_MIN_REQUEST_INTERVAL_MS` | `800` | 0.7.0 新增：出站补全请求最小间隔（请求节奏闸 pacing） |
| `MARVIS_REQUEST_JITTER_MS` | `400` | 0.7.0 新增：最小间隔之上叠加的随机抖动 |
| `MARVIS_REFRESH_LEAD_MS` | `2592000000` | 0.7.0 新增：token 剩余时效不足该值（默认 30 天）时提前续期（clamp 微信 TTL 1/3） |
| `MARVIS_REFRESH_MIN_INTERVAL_MS` | `3600000` | 0.7.0 新增：同账号两次主动续期的最小间隔（默认 1 小时，`0` 关闭节流） |
| `MARVIS_FALLBACK_FIRST_LINE` | 官方中文身份句 | 403 兜底首行 |
| `MARVIS_GUARD_WORD_JOINER` | 关 | `1` = 启用 U+2060 护栏 |
| `MARVIS_USKEY_URL` / `MARVIS_QIMEI36` | 空 | 出票链配置（off 通道用；gateway 通道由网关侧承担） |
| `MARVIS_ALLOW_RANDOM_USKEY` | 关（0.7.0 起 fail-fast） | 随机票兜底默认关闭：缺失出票链路直接报可操作错误；设 `1` 显式开启随机兜底（仅开发排查用，线上必 4100404） |

## 七、验证与测试

```bash
node scripts/doctor.mjs     # 一键诊断「模型不出字」：逐环查版本/配置/网关/账号/出票/上游，
                            # 直接指出挂在哪一环；exit 0=全通，1=有环失败（含修复提示）。
                            # 其中 4100404=上游风控，非配置问题，等解除；切 off/gateway 无效。
                            # 0.7.0 起输出新增 fingerprintStatus / riskEvents 字段
                            # （fingerprintStatus / riskEvents 的字段名与输出时机〔待主控核对〕）。
node --test                 # 离线测试（MARVIS_TRANSPORT=gateway 注入，不依赖真机/网络）
node scripts/check.mjs .    # 交付面自检
```

已知边界（继承上游实测记录）：WS 通道多轮展平为单段 prompt、usage 恒 0、无自动重连（每轮短连接）；remote 握手凭据短命（失效后重抓 handshake.log 放回资产目录）；`openclaw.test.mjs` 端到端用例需本机可监听 WS 服务的环境。
