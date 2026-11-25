# magpie-marvis 0.8.3 + 三项优化：升级与回滚方案

> 生成时间：2026-11-26
> 基线：cat-clash/magpie-marvis `main` @ `9e497da`（0.8.3）
> 工作副本：`C:\Users\c\Documents\deepseek-harness\default-workspace\magpie-marvis-083-opt`
> 干净基线副本：`...\magpie-marvis-083-base`（同一 commit，未改动，用于回滚对照）

---

## 一、改了什么（3 个文件 + 1 个测试）

| # | 文件 | 优化 | 验证 |
|---|---|---|---|
| 1 | `src/marvis/openclaw.mjs` + `src/hooks/loader.mjs` | 4100404 自动 WS 回退不再写 `process.env.MARVIS_WS_MODE`。改为把 `mode:"relay"` 作为**单次请求参数**透传（`cfg(modeOverride)` → `openclawChatStream` / `openclawChat`），消除 await 窗口期并发请求被串味的竞态。 | 单测 `openclawMode(modeOverride)` 断言 env 原封不动；loader 源码断言不再赋值 env |
| 2 | `src/hooks/loader.mjs` | 403 首行自愈链（兜底句 / 4 句候选池 / U+2060 护栏）的 3 次重试全部改走 `pacedRetryUpstream`，纳入账号节奏闸；`MARVIS_RETRY_PACING=0` 可关（仅调试）。 | 单测断言 3 处 `pacedRetryUpstream`，零处直调 `callUpstream` |
| 3 | `src/marvis/fingerprint.mjs` | `APP_VERSION` 不再写死 `1.60.3400.35`。新增 `appVersion()`：env `MARVIS_APP_VERSION` 优先 → 扫客户端日志 `client_platform_version` → 扫安装目录 `Application\<version>\` → 兜底旧值。诊断 `fingerprintStatus()` 增加 `appVersion` / `appVersionSource`。 | 本机实测探测到 `1.60.3600.59`，source=detected；env 覆盖仍最高优先 |

新增回归测试：`tests/optimization-083.test.mjs`（4 条全过）。

## 二、测试结论（重要：本机没有 node，只有 magpie 自带的 bun）

- 项目 `package.json` 的 `test` 脚本是 `node --test`，本机 PATH 里没有 node，用 `magpie-bun.exe test` 代替，存在 bun 对 node:test 的兼容噪音（少量用例固定 5s 超时）。
- **关键对比（关掉默认节流 `MARVIS_MIN_REQUEST_INTERVAL_MS=0 MARVIS_REQUEST_JITTER_MS=0`）**：

| 测试文件 | 基线 0.8.3 | 改动后 |
|---|---|---|
| `loader-model-support` | 8 pass / 26 fail | **33 pass / 1 fail** |
| `legacy-model-loader` | 11 / 0 | 11 / 0 |
| `breaker` | 16 / 0 | 16 / 0 |
| `pacing` | 8 / 0 | 8 / 0 |
| `gateway-stream` | 13 / 0 | 13 / 0 |
| `openclaw` | 8 / 0 | 8 / 0 |
| `optimization-083`（新） | — | **4 / 0** |

唯一剩下的 1 fail 是 `4100404 风控 → 429` 用例，在**基线里同样是 5.00s 固定超时**（bun 环境问题，非本次改动）。结论：改动**零新增失败**，还顺带修复了 25 个 bun 下的预存失败。

## 三、升级步骤（在 magpie 运行时插件目录上执行）

先确认 magpie 当前实际加载的插件路径：

```powershell
$plug = "$env:USERPROFILE\.config\magpie\plugins\node_modules\magpie-marvis-final"
$cache = Get-ChildItem "$env:USERPROFILE\.cache\magpie\bun\install-cache" -Directory |
  Where-Object { $_.Name -match 'cat-clash-magpie-marvis' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
```

> 本机缓存里发现多个 `@GH@cat-clash-magpie-marvis-*` 副本，且曾装过 `magpie-marvis-final` 0.7.x。**先确认 providers.json 里 provider id = `marvis` 指向哪个目录**，别改错副本。

1. **备份**（时间戳自定）：
   ```powershell
   $stamp = Get-Date -Format yyyyMMdd-HHmmss
   Copy-Item $plug "$plug.bak-$stamp" -Recurse
   ```

2. **同步三个改过的源码文件**（从工作副本）：
   ```powershell
   $src = "...\magpie-marvis-083-opt"
   Copy-Item "$src\src\hooks\loader.mjs"        "$plug\src\hooks\loader.mjs" -Force
   Copy-Item "$src\src\marvis\fingerprint.mjs"  "$plug\src\marvis\fingerprint.mjs" -Force
   Copy-Item "$src\src\marvis\openclaw.mjs"     "$plug\src\marvis\openclaw.mjs" -Force
   Copy-Item "$src\tests\optimization-083.test.mjs" "$plug\tests\" -Force
   ```

3. **其余文件（README / context.mjs / breaker / 新 tests 等）来自 0.8.3 升级本身**：
   如果要完整升到 0.8.3（不只是打这 3 个补丁），把整个工作副本目录覆盖到 `$plug`，再重做第 2 步（3 个优化文件），避免 0.8.3 原始文件把优化覆盖掉。顺序：**先 0.8.3 → 再 3 个补丁**。

4. **重启 magpie**，确认日志里：
   - `[marvis-fingerprint]` 不再有随机 uskey 告警；
   - 请求头里的 Beacon 版本跟客户端一致（可用 `fingerprintStatus().appVersion` 在诊断脚本里打印）。

5. **冒烟验证**：`provider test marvis-plugin` 打一条 `main-auto`，看是否 200；再单独验证 4100404 场景是否回 429 + Retry-After（而不是连试 7 次）。

## 四、回滚（两种情况）

**A. 只回滚 3 个优化，保留 0.8.3：**
```powershell
Copy-Item "...\magpie-marvis-083-base\src\hooks\loader.mjs"       $plug\src\hooks\loader.mjs -Force
Copy-Item "...\magpie-marvis-083-base\src\marvis\fingerprint.mjs" $plug\src\marvis\fingerprint.mjs -Force
Copy-Item "...\magpie-marvis-083-base\src\marvis\openclaw.mjs"    $plug\src\marvis\openclaw.mjs -Force
Remove-Item "$plug\tests\optimization-083.test.mjs" -Force
```

**B. 回滚到升级前的旧版本：**
```powershell
Remove-Item $plug -Recurse -Force
Rename-Item "$plug.bak-$stamp" $plug
```
重启 magpie。

**环境开关兜底**（不回滚代码也能缓解）：
- 优化 2 不顺手：`MARVIS_RETRY_PACING=0`
- 优化 3 不想要：`MARVIS_APP_VERSION=1.60.3400.35`（恢复旧写死值）
- 优化 1 无开关（本来就是修 bug），靠回滚文件。

## 五、保留的工作副本

```
magpie-marvis-083-opt/    ← 0.8.3 + 3 优化（可交付）
magpie-marvis-083-base/   ← 0.8.3 干净（回滚对照）
magpie-marvis-final/      ← 原仓库 clone，main 分支未动（0.7.3 本地状态）
```

没有创建 git commit，没有 push。三个副本都是 worktree，原 clone 的 main 分支保持原样。
