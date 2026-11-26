# -*- coding: utf-8 -*-
"""
清理 qimei36 相关缓存脚本 (v2)

注意：经逆向验证，qimei36 = 硬件指纹 + 持久化种子 确定性派生。
清缓存后 DLL 会重新采集同样的硬件、派生出同样的种子并自愈回写，
因此清缓存一般【不会】让 qimei36 变成新号；要变号必须改派生输入
(MAC / 磁盘序列号 / 卷序列号 / beacon GUID / appkey)。

本脚本清除以下位置：
1. IndexedDB / Local Storage leveldb 目录（上层应用落盘的 q36 副本）
2. qimei36.txt / qimei-cache.json（上层应用缓存）
3. Tencent beacon 持久化种子文件（DLL 派生输入种子）
"""
import os, shutil

HOME = os.path.expanduser("~")
APPDATA = os.environ.get("APPDATA", os.path.join(HOME, "AppData", "Roaming"))

# (路径, 是否目录)
CLEAN_TARGETS = [
    (os.path.join(APPDATA, "Tencent", "Marvis", "electron_data", "IndexedDB",
                  "https_marvis-client.yyb.qq.com_0.indexeddb.leveldb"), True),
    (os.path.join(APPDATA, "Tencent", "Marvis", "electron_data", "Local Storage", "leveldb"), True),
    (os.path.join(HOME, ".magpie-marvis-native", "qimei36.txt"), False),
    (os.path.join(HOME, ".workbuddy", "qimei-cache.json"), False),
    # DLL 真正的持久化种子（删后会从硬件重新派生并回写）
    (os.path.join(APPDATA, "Tencent", "beacon", "GlobalMgr.db"), False),
    (os.path.join(APPDATA, "Tencent", "qimei", "RanMgr.db"), False),
    (os.path.join(APPDATA, "Tencent", "beacon", "beacon_marvis.db"), False),
]

for path, is_dir in CLEAN_TARGETS:
    if not os.path.exists(path):
        print(f"不存在: {path}")
        continue
    try:
        if is_dir:
            shutil.rmtree(path)
        else:
            os.remove(path)
        print(f"已删除: {path}")
    except Exception as e:
        print(f"删除失败: {path}, {e}  (若 Marvis 客户端正在运行，请先退出后重试)")
