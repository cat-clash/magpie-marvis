# qimei-forge —— Marvis qimei36 铸号工具

在**不改任何系统设置**的前提下，让 `qimei.dll` 返回自定义的 qimei36 设备号。

## 原理（逆向实证）

Marvis 的 `qimei.dll` 导出 12 个混淆函数。实测调用链：

```
qimei_napi.node
  ├─ LoadLibraryW("qimei.dll")
  ├─ GetProcAddress(qimei.dll, "a3")        → 初始化（只收 appKey）
  ├─ LoadLibraryW("iphlpapi.dll")
  ├─ GetProcAddress(iphlpapi.dll, "GetAdaptersInfo")   → 采集网卡 MAC
  └─ GetProcAddress(qimei.dll, "b")         → getqimei(appKey, outBuf, size=70)
        └─ 结果以 36 位 hex 写入 outBuf：这就是 qimei36
```

**关键发现**：`b()` 把最终号写进调用方提供的输出缓冲区。因此最直接、最可靠的铸号点就是
**hook `b` 的 onLeave，覆盖该缓冲区**——不依赖硬件指纹、不需要一致性校验、完全可逆。

### 为什么其它方法都不行

| 方法 | 结果 | 原因 |
|---|---|---|
| 改网卡 MAC（注册表 / `Set-NetAdapterAdvancedProperty`） | `getqimei` 返回 **null** | qimei36 是多源硬件指纹派生，改单一源触发一致性校验失败 |
| 改 MachineGuid | null | 同上 |
| 删/改 beacon 种子（`GlobalMgr.db` / `RanMgr.db` / `beacon_marvis.db`） | 号不变 | 种子由硬件确定性派生，删了会自愈重算 |
| 改 `Androws.db` 里的 32 位种子 | 号不变 | 该文件不参与 36 位号派生 |
| 改 SQLite 里的 `A153` 字段 | 号不变 | 那是**上报日志**，不是生成源 |
| 清缓存 / 关客户端 | 号不变 | 号是即时派生，不是读缓存 |
| **hook `b()` 输出缓冲区** | **✅ 新号** | 直接改最终结果，绕过所有校验 |

实测输出：

```
基线:  7797c26b85ad4b189c223eaf300016019401
铸号:  a1b2c3d4e5f60718293a4b5c6d7e8f90abcd   ← getQ36() 真的返回了这个值
```

## 依赖

需要 [frida](https://frida.re)：

```bash
npm i -g frida        # Node 版（配 forge.mjs）
# 或
pip install frida     # Python 版（配 forge.py）
```

## 用法

### 1. 列出候选进程

```bash
node tools/qimei-forge/forge.mjs --list
# 或
python tools/qimei-forge/forge.py --list
```

输出会筛出 `marvis` / `node` / `electron` / `python` 相关进程。

### 2. 附加到进程（每次取号都换随机值）

```bash
node tools/qimei-forge/forge.mjs --pid 12345
```

### 3. 固定一个号

```bash
node tools/qimei-forge/forge.mjs --pid 12345 --value a1b2c3d4e5f60718293a4b5c6d7e8f90abcd
```

### 4. 只观察，不改写（先确认能 hook 上）

```bash
node tools/qimei-forge/forge.mjs --pid 12345 --dry
```

日志会打印每次 `b()` 的原始返回值。

### 5. 启动新进程并注入

```bash
node tools/qimei-forge/forge.mjs --spawn "node my-app.js"
```

### 6. 改一次就退出

```bash
node tools/qimei-forge/forge.mjs --pid 12345 --once
```

## 编程接口

`forge.js` 暴露 frida RPC：

```js
// Node
await script.exports.setValue("a1b2...")   // 固定值；空串 = 每次随机
await script.exports.setEnabled(false)      // 暂停改写
await script.exports.stats()                // { calls, forced, lastOrig, lastValue }
```

## 参数说明

| 参数 | 说明 |
|---|---|
| `--list` | 列出候选进程 |
| `--pid <PID>` | 附加到指定 PID |
| `--name <NAME>` | 按进程名附加 |
| `--spawn "<cmd>"` | 启动并注入 |
| `--value <36hex>` | 固定铸号值，必须是 36 位十六进制 |
| `--once` | 生效一次后退出 |
| `--dry` | 只观察不改写 |

## 注意事项

1. **目标进程必须已加载或即将加载 `qimei.dll`**。脚本会挂 `LoadLibraryW` 等待，DLL 加载后自动安装 hook。
2. **需要能 attach 到目标进程**。跨权限附加（如目标以管理员运行）需要同等权限。
3. **号的服务端有效性未知**。本地能稳定产出任意 36 位 hex，但腾讯服务端是否接受该号，取决于其校验策略——真号是服务端签发过的。本工具解决的是"本地生成环节"，不等于"服务端认可"。
4. **不要用于绕过付费或访问他人数据**。这是本机软件互操作性研究工具。

## 相关文档

- [`../../CLEARING_CACHE.md`](../../CLEARING_CACHE.md) —— 缓存清理（注意：清缓存不换号）
- [`../../FIX-4100404.md`](../../FIX-4100404.md) —— 4100404 风控处置
