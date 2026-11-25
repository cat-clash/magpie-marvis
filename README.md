# 腾讯 Marvis · magpie 供应商插件（0.8.1）

> **⭐ 使用文档请读 [`README-FINAL.md`](./README-FINAL.md)。**
>
> 本插件把腾讯 Marvis（应用宝 AI 助手）背后的 DeepSeek V4.1 Flash / V4 Pro、
> Claude Sonnet/Opus 4.6、GPT-5.4、Hy3、HY-Vision 2.0 接进 magpie / OpenCode，
> QQ / 微信登录，不用粘贴 key。**PC 与手机通用（手机通过本地 OpenAI 网关）。**

## 传输通道（0.8.1）

| 模式 | 说明 | 适用 |
|---|---|---|
| `gateway`（默认推荐） | 本地 OpenAI 兼容网关 `http://127.0.0.1:8088/v1`，跨平台，PC 与手机共用；手机在 Termux / PRoot 里跑 Python 网关即可 | PC + 手机，默认 |
| `off`（PC HTTP 直连） | `https://yybadaccess.3g.qq.com/v1/chat/completions`，Beacon SDK 按请求上下文现签 uskey | PC（2026-11-24 实测 200） |
| `openclaw`（WS） | 手机会话域 WebSocket，凭据来自 `native/handshake.log` | 备选；凭据短命（≈15-20 分钟），失效重抓 |

模式选择：环境变量 `MARVIS_TRANSPORT=gateway|off|openclaw`，未显式配置时**探测**本地 8088 `/v1/models`，可达才走 gateway，否则按既有 off/openclaw 规则处理（不是无条件默认 gateway）。
网关地址 / 鉴权 / 超时分别用
`MARVIS_GATEWAY_URL` / `MARVIS_GATEWAY_KEY` / `MARVIS_GATEWAY_TIMEOUT_MS` 配置。
`MARVIS_GW_URL` 是另一条 PC AG-UI WS relay（10123）的变量，不是 8088 网关地址，不要混用。
出票与配置资产放**稳定目录**（用户环境变量 `MARVIS_NATIVE_DIR`，建议
`C:\Users\<你的用户名>\.magpie-marvis-native`），在插件目录之外，`magpie plugin update` 清不掉 —— 跨更新免疫；详见 README-FINAL 第二节。

**流式透传（0.7.0 新增）**：`gateway`（PC AG-UI WS）与 `openclaw`（手机会话域 WS）两条通道改为流式 ——
网关侧 `TEXT_MESSAGE_CONTENT` / openclaw 侧 `event:chat` 增量实时转成 OpenAI `chat.completion.chunk` SSE，
首字延迟从「整轮结束」降到秒级；**非流式行为不变**。flatten 改进：单条 user 消息原样直发，
system 独立置顶保留；`agent.run` 的 requestId 已唯一化。

**风控与节奏（0.7.0）**：出站补全请求受请求节奏闸 pacing 约束——
`MARVIS_MIN_REQUEST_INTERVAL_MS`（默认 `800`）控制最小间隔，`MARVIS_REQUEST_JITTER_MS`（默认 `400`）叠加随机抖动；
熔断器退避改为指数退避并持久化到 `<稳定资产目录>/breaker-state.json`（重启不丢）。
**0.8.0 起两者都按账号分桶** —— 一个账号被拦只冷却这个账号，其他账号照常出网
（`MARVIS_RISK_SCOPE=global` / `MARVIS_PACING_SCOPE=global` 可退回旧的「全停」行为）。
**随机 uskey 兜底默认关闭（0.7.0 行为变更）**：没有 `native/`、也没有 `MARVIS_USKEY_URL` 时直接 fail-fast
报可操作错误，不再静默放行随机票（线上必 `4100404`）；显式设 `MARVIS_ALLOW_RANDOM_USKEY=1` 可找回旧兜底（仅开发排查用）。
主动续期：token 剩余时效不足 `MARVIS_REFRESH_LEAD_MS`（默认 30 天，clamp 微信 TTL 1/3）时提前续期，
同账号最多每 `MARVIS_REFRESH_MIN_INTERVAL_MS`（默认 1 小时）续一次；微信 2h token 不再周期性掉线。
完整环境变量见 [README-FINAL](./README-FINAL.md)。

## 0.7.4 – 0.8.1 新增（手机上最常用的几条）

- **多账号互不牵连：熔断 / 节奏闸按账号分桶**（0.8.0，默认开启，PC 与手机同效）：以前一个账号被
  `4100404` 拦住会让**所有**账号一起停（进程级单例熔断 + 单条 pacing 时间轴）。现在每个账号各有一条
  独立的失败计数 / 指数退避 / 请求节奏 —— A 号在冷却时，B 号照常出网。报错会写明是哪个账号在冷却；
  `node scripts/cli.mjs breaker` 看各账号状态，`breaker reset <账号>` 立刻解封。
  想找回旧的「一个号出事全停」：`MARVIS_RISK_SCOPE=global` 与 `MARVIS_PACING_SCOPE=global`。
  多个账号**接连**被拦（默认 2 个 / 10 分钟内）说明拦的是通道而不是账号，这时才会自动回到全局冷却
  （`MARVIS_RISK_CONSENSUS` 可调，设 0 = 纯隔离）。
  **0.8.1 修了两个首版回归**：① 全局冷却打开时 loader 现在也检查并挡住（0.8.0 只看账号桶，漏了）；
  ② 从旧版升级时不再继承历史冷却 —— 老 `breaker-state.json` 的全局残留会自动清零，不会升级后被全体挡住。

- **首选：直接把电脑端登录态导到手机**（0.7.14 起首选路径）：不用扫码、不用守着电脑 ——
  电脑 magpie 配置目录的 `plugin-auth.json` 里把 `marvis#` 开头的条目导出成一个小 JSON，手机 Termux 里跑
  `node scripts/cli.mjs import-login login.json --yes`，会自动备份后合并进手机的
  `~/.config/magpie/plugin-auth.json`，重启 magpie 就能看到这个账号。实测比扫码省事得多。
- **备用：微信登录是「电脑出码 + 手机扫」**（0.7.10 定论）：真机两次被微信打回后才确认 ——
  Marvis 的 appid 是**网站应用**（只有 `snsapi_login` 扫码权限），**不是公众号**，所以
  `oauth2/authorize`（0.7.8 的 `snsapi_userinfo`、0.7.9 的 `snsapi_base`）在微信内一律报
  **「此公众号并没有这些scope的权限，错误码:10005」**，改 scope 没用；而 `qrconnect` 只能出
  二维码页，微信又禁止长按/相册识别二维码，所以**一台手机扫不了自己的屏**。可行链路只有一条：
  点「复制授权链接」→ 在**电脑**浏览器打开（屏幕出现二维码）→ 这台手机微信「扫一扫」→
  电脑跳到 `yybadaccess…code=…` → 整条粘回 magpie。页面另有「分享到微信（可选）」把链接送去电脑。
- **诊断脚本的收尾改成能直接判读的**（0.7.13）：`magpie-marvis-diag.sh` 新增 `CODE_MEANING` 段
  （`401` = 网关开了 key 鉴权而 `gateway.json` 的 key 是空串；`000` = curl 不可用/超时，**不是**网关没登录；
  `200` 只证明网关活着，**不代表**账号池有号），并写明「① 首选 `--fix`（自己写含 `schemaVersion` 的
  `gateway.json`、端口按 `Marvis-proxy-public/config.json` 取）② 手工写只是降级 ③ `export` 只对当前 Termux
  会话有效」。`FIX_RESULT.next` 直接给出：`listening=1` 仍 503 → 网关账号池为空。
- **本机引导页不接收粘贴，只在壳里粘 Code**（0.7.12）：之前引导页上有个「完成登录」框，
  在那儿提交会显示「登录成功」但插件里没有账号 —— 壳只有在 `callback()` 被调用且没给粘贴内容时
  才会取本地页的结果，用户在页面这侧提交壳根本不知道；更糟的是 `code` 已被这一侧消费，
  再粘回壳的 Code 框反而失败。现在引导页只给链接和步骤，`POST /submit` 一律 410。
- **账号管理只有 CLI，不在登录菜单**（0.7.7 调整）：0.7.6 曾在登录菜单加过「账号管理」入口，实测位置不对
  （没登录时没账号可管、已登录不会去登录菜单找），已撤掉。取消登录/移除账号统一走 Termux：
  `node scripts/cli.mjs accounts list|logout|remove`，写盘前自动备份，操作后重启 magpie 生效。
- **微信登录加「分享到微信」主路径**（0.7.7）：点首选按钮直接把授权链接送进系统分享面板 → 微信 → 文件传输助手
  → 发送 → 微信里点开 →「确认授权」→「允许」，页面上有完整的 4 步后续说明；不支持分享时回退到
  「唤起微信 + 复制授权链接」。微信没有 QQ 那种能带网址的 scheme，这是平台差异。
  （0.7.10 起微信主路径改为「复制授权链接 → 电脑浏览器打开出二维码 → 手机微信扫」，「分享到微信」降为可选手段；
  详见下面的微信条目。）
- **账号随便取消登录 / 移除**（0.7.4）：`node scripts/cli.mjs accounts list|logout|remove`，
  不再受「第一个账号删不掉」限制；`list --verbose` 看 `expires`/`guid`/字段全集，`--json` 给脚本接管（0.7.5）。
- **503 一键自愈 + 说清下一步**（0.7.5 / 0.7.7）：`sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix`
  会写好 `gateway.json`，8088 没监听时自动找到 `run.sh` 执行 `sh run.sh start`，并轮询 `/v1/models` 到就绪；
  0.7.7 起连 `ws://127.0.0.1:10123/`（PC 端口）失败也会明确告诉你改走 8088 网关。
- **电脑端 4100404 风控自动 WS 回退**（0.7.7）：PC 客户端开着时，HTTP 被风控拦截会自动改走 WS 重试一次；
  手机端则提示走本地网关，不再只甩一句「换账号/换 IP 也没用」。

## 手机怎么用（Termux / PRoot / magpie 安卓壳）

手机端走 `gateway` 通道（**0.7.0 起也可以直接点 QQ / 微信登录**，详见 README-FINAL 第四节；
gateway 仍是推荐路径，账号池在网关侧维护）：登录 / 加号账号池由本地 Python 网关维护，插件用「免登录」占位账号出模型
（占位账号现已排在真登录之后）。

> **0.7.2 修好了手机端的两个真问题**（用户实测反馈）：上一版手机端点 QQ / 微信登录只剩一段文字 ——
> 既没有粘贴输入框、也没有「打开浏览器」按钮，三个登录入口只剩两个。实测宿主契约后已改回
> `method:"code"`（拿回「Code:」粘贴输入框）+ 不设 `opened:true`（拿回唤起按钮），
> 并恢复 **QQ 登录 / 微信登录 / 浏览器·粘贴回调地址** 三个入口；QQ 另用 `mqqapi://forward/url`
> 真正唤起手机 QQ App。

简要：① Termux 先 `pkg install python curl -y`，跑参考仓库 `yy158358/Marvis-proxy-public` 的 `sh run.sh start` 并加号登录；
② 插件目录通过 magpie 控制后台 `127.0.0.1:3430` → 插件 → 导入；
③ 复制 `plugin/gateway.example.json` 到 `~/.magpie-marvis-native/gateway.json` 开启网关模式
   （用 phone-kit 附件时直接 `sh phone-setup.sh` 会自动写这份配置）；
④ 加账号选「本地网关（手机推荐，免登录）」→ `magpie provider test`。
完整步骤见 [README-FINAL 第四节](./README-FINAL.md)。

## 历史

- 原版 `MYCF711/magpie-marvis`（HTTP-only）2026-11-18 起停更；
  2026-11-17 上游收紧 uskey 校验、2026-11-22 PC 端全局风控——HTTP 路线一度全灭。
- 本插件经历 0.2.x（现签修复）→ 0.3.x（openclaw WS 传输）→ 0.4.x（断网重连抓包、
  熔断器、中文首行护栏、AK/SK 休眠）→ 0.5.x（精简，HTTP 直连恢复后回归主链路）
  → 0.6.x（正名为纯 magpie 插件，新增本地网关传输，手机可通过 Termux / PRoot 使用）
  → 0.7.x（流式透传、熔断指数退避持久化、请求节奏闸、主动续期、随机 uskey 默认 fail-fast、
  手机端可直接 QQ / 微信登录——自带本地粘贴页，不再依赖旧包名补丁）
  的完整演进，修复史见 [CHANGELOG](./CHANGELOG.md)。

## 帧协议参考（openclaw WS 模式）

- openclaw WS（手机会话域）：握手头 `sessionId` / `token` / `platform: mobile` / `role: operator`，
  `connect` 帧的 `auth` 必须带 `relaySessionId` / `relayToken`（0.4.1 定位）且**不带** accessToken（0.4.2 定位）；
  `chat.send` → `event: chat`（text 累积，`isAgentTextFinal` 终止）/ `event: agent`（phase end/error）。

以上协议细节均为 2026-11-21～24 真机抓包实测值，上游随时可能改。
