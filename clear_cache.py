# -*- coding: utf-8 -*-
"""
清理 qimei36 持久化缓存脚本

此脚本清除以下持久化存储位置：
1. IndexedDB 数据库 (electron_data 目录)
2. Local Storage leveldb 数据
3. qimei36.txt (插件缓存)

注意：删除这些文件将重置 qimei36 号码，需要在新的 Python 进程中启动以获取新号码。
"""
import os, shutil, glob

CLEAN_PATHS = [
    # IndexedDB 数据库 (Tencent Marvis 客户端)
    r"C:\Users\c\AppData\Roaming\Tencent\Marvis\electron_data\IndexedDB\https_marvis-client.yyb.qq.com_0.indexeddb.leveldb",
    
    # Local Storage leveldb
    r"C:\Users\c\AppData\Roaming\Tencent\Marvis\electron_data\Local Storage\leveldb",
    
    # qimei36.txt (插件缓存)
    r"C:\Users\c\.magpie-marvis-native\qimei36.txt",
]

for path in CLEAN_PATHS:
    if os.path.exists(path):
        try:
            os.remove(path)
            print(f"已删除: {path}")
        except Exception as e:
            print(f"删除失败: {path}, {e}")
    else:
        print(f"不存在: {path}")