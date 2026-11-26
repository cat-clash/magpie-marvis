# qimei36 持久化缓存清理指南

## 1. 概述

qimei36 号码的持久化存储在多个位置。本文档提供了清除这些缓存的方法，以便在新的 Python 进程中获取新的 qimei36 号码。

## 2. 需要清除的位置

### 2.1 IndexedDB 数据库
路径：`C:\Users\<User>\AppData\Roaming\Tencent\Marvis\electron_data\IndexedDB\https_marvis-client.yyb.qq.com_0.indexeddb.leveldb`

此目录包含 LevelDB 数据库，存储了持久化的 IndexedDB 数据。

### 2.2 Local Storage leveldb
路径：`C:\Users\<User>\AppData\Roaming\Tencent\Marvis\electron_data\Local Storage\leveldb`

此目录包含 LevelDB 数据库，存储了 Local Storage 数据。

### 2.3 qimei36.txt
路径：`C:\Users\<User>\.magpie-marvis-native\qimei36.txt`

此文件直接存储了 qimei36 号码，是插件缓存的直接来源。

## 3. 清除方法

### 3.1 使用清理脚本

运行以下 Python 脚本来自动清除上述位置：

```powershell
python clear_cache.py
```

此脚本将删除上述提到的所有持久化存储位置。

### 3.2 手动清除

如果不使用脚本，可以手动删除以下文件：

1. 删除 IndexedDB 数据库文件
2. 删除 Local Storage leveldb 文件  
3. 删除 qimei36.txt 文件

### 3.3 通过浏览器清除 (替代方案)

虽然直接通过浏览器清除 IndexedDB 较复杂，但可以使用浏览器开发者工具：
1. 打开 Chrome/Firefox 开发者工具
2. 前往 Application 或 Storage 选项卡
3. 找到 IndexedDB 或 Local Storage 条目
4. 使用清除数据按钮

## 3. 后续步骤

清除缓存后：

1. **启动新的 Python 进程**：务必启动全新的 Python 进程（不要使用之前进程的 continue 或 resume），以确保不使用缓存的环境变量。

2. **启动 magpie**：启动 magpie 插件，检查 qimei36 号码是否已更改。

3. **验证**：如果号码已更改，则说明缓存清除成功。如果号码未更改，可能需要清除额外的存储位置或等待风控自然解除。

## 4. 故障排除

- **如果清除后号码未更变**：可能还有其他持久化存储位置未被清除，或号码是由硬件指纹决定的（参考方向二的实验结果）。
- **如果脚本报错**：确保以管理员权限运行或检查文件是否被其他进程占用。

## 5. 相关链接

- [方向一：纯 Python/node 环境验证](方向一验证链接)
- [方向二：frida 驱动](方向二验证链接)

---

文档末尾附有完整的 `clear_cache.py` 脚本内容供直接复制使用。