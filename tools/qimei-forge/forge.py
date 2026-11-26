#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""forge.py —— qimei36 铸号 CLI（Python 版 frida 驱动）

用法：
  python forge.py --list
  python forge.py --pid 12345
  python forge.py --pid 12345 --value a1b2c3d4e5f60718293a4b5c6d7e8f90abcd
  python forge.py --name Marvis.exe
  python forge.py --spawn "node app.js"

依赖：pip install frida
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT_PATH = os.path.join(HERE, "forge.js")


def list_processes():
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"],
                             capture_output=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        text = (out.stdout or b"").decode("utf-8", "replace")
        if "marvis" not in text.lower() and "python" not in text.lower():
            # 中文系统 tasklist 输出可能是 GBK
            text = (out.stdout or b"").decode("gbk", "replace")
        rows = []
        for line in text.splitlines():
            parts = line.split('","')
            if len(parts) >= 2:
                name = parts[0].lstrip('"')
                try:
                    pid = int(parts[1].strip('"'))
                except ValueError:
                    continue
                rows.append((pid, name))
        interesting = [(p, n) for p, n in rows if any(k in n.lower() for k in ("marvis", "node", "electron", "python"))]
        print("候选进程（可能加载 qimei.dll）:")
        for pid, name in interesting:
            print(f"  {pid:7d}  {name}")
        print(f"\n共 {len(interesting)} 个。用 --pid <PID> 附加。")
    except Exception as e:
        print("列出进程失败:", e)


def main():
    ap = argparse.ArgumentParser(description="qimei36 铸号工具（frida）")
    ap.add_argument("--list", action="store_true", help="列出候选进程")
    ap.add_argument("--pid", type=int, help="目标进程 PID")
    ap.add_argument("--name", help="按进程名附加")
    ap.add_argument("--spawn", help="启动并注入的命令")
    ap.add_argument("--value", help="固定 36 位 hex 铸号值（默认每次随机）")
    ap.add_argument("--once", action="store_true", help="只改一次")
    ap.add_argument("--dry", action="store_true", help="只观察不改写")
    args = ap.parse_args()

    if args.list:
        list_processes()
        return

    if args.value and not (len(args.value) == 36 and all(c in "0123456789abcdefABCDEF" for c in args.value)):
        print("--value 必须是 36 位十六进制")
        sys.exit(2)

    try:
        import frida
    except ImportError:
        print("未找到 frida。安装：pip install frida")
        sys.exit(1)

    if not os.path.exists(SCRIPT_PATH):
        print("缺少 forge.js:", SCRIPT_PATH)
        sys.exit(2)

    src = open(SCRIPT_PATH, "r", encoding="utf-8").read()

    target_pid = None
    if args.spawn:
        parts = args.spawn.split()
        target_pid = frida.spawn(parts)
        print(f"已启动 pid={target_pid}: {args.spawn}")
    elif args.pid:
        target_pid = args.pid
    elif args.name:
        procs = frida.enumerate_processes()
        hit = next((p for p in procs if p.name.lower() == args.name.lower()), None)
        if not hit:
            print(f"未找到进程: {args.name}")
            cand = [f"{p.pid}:{p.name}" for p in procs if any(k in p.name.lower() for k in ("marvis", "node"))]
            print("候选:", ", ".join(cand))
            sys.exit(3)
        target_pid = hit.pid
    else:
        print("需要 --pid / --name / --spawn 之一，或 --list")
        sys.exit(2)

    print(f"附加到 pid={target_pid} ...")
    session = frida.attach(target_pid)
    script = session.create_script(src, name="qimei-forge")

    def on_message(msg, data):
        if msg.get("type") == "send":
            print(msg.get("payload"))
        elif msg.get("type") == "error":
            print("[js error]", msg.get("description"))

    script.on("message", on_message)
    script.load()

    if args.value:
        script.exports_sync.set_value(args.value)
    if args.dry:
        script.exports_sync.set_enabled(False)

    print(f"已注入。value={args.value or '(每次随机)'} dry={args.dry}")
    if args.spawn:
        frida.resume(target_pid)

    try:
        while True:
            time.sleep(3)
            try:
                s = script.exports_sync.stats()
                if s.get("calls"):
                    print(f"[stats] calls={s['calls']} forced={s['forced']} last=\"{s['lastValue']}\" (orig \"{s['lastOrig']}\")")
                if args.once and s.get("forced", 0) > 0:
                    print("--once 已生效，退出。")
                    break
            except Exception:
                pass
    except KeyboardInterrupt:
        print("\n退出。")
    finally:
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass


if __name__ == "__main__":
    main()
