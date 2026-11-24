#!/bin/sh
# phone-setup.sh —— magpie 安卓壳一键准备脚本
#
# 作用：把「起 Python 网关 + 写 gateway.json」两步合成一条命令。
# 用法（在解压后的 phone-kit 目录里）：
#   sh phone-setup.sh              # 起网关 + 写配置（网关目录在 ./Marvis-proxy-public）
#   sh phone-setup.sh --no-start   # 只写配置，不启动（自己管网关进程时用）
#
# 前提：Termux 里装了 Python 3.8+ 与 curl（pkg update && pkg install python curl -y）。
# 脚本只写自己的资产目录，不碰系统目录、不需要 root。
# 真正的加号登录仍需浏览器打开网关控制台做一次。

set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

if [ -z "${HOME:-}" ]; then
  echo "HOME 未设置：请在 Termux 内用 sh phone-setup.sh 运行，不要用 Android 系统 shell 直接执行。"
  exit 1
fi
NATIVE="$HOME/.magpie-marvis-native"
GW="$DIR/Marvis-proxy-public"

echo "[1/4] 检查 Python"
if ! command -v python3 >/dev/null 2>&1; then
  echo "没找到 python3。请先运行：pkg update && pkg install python curl -y"
  exit 1
fi
python3 --version

echo "[2/4] 检查网关目录"
if [ ! -f "$GW/serve.py" ] || [ ! -f "$GW/run.sh" ]; then
  echo "网关目录不完整：$GW"
  echo "请确认 phone-kit 完整（应有 Marvis-proxy-public/ 子目录，内含 serve.py 与 run.sh）。"
  exit 1
fi

# 端口从 config.json 读；路径通过 argv 传给 Python，避免目录名里的空格/引号/反斜杠
# 被拼进 Python 源码字符串导致解析失败。读不到就回退 8088（run.sh 同样回退）。
PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get("port",8088))' "$GW/config.json" 2>/dev/null || echo 8088)
URL="http://127.0.0.1:$PORT/v1"

echo "[3/4] 写 gateway.json 到 $NATIVE"
mkdir -p "$NATIVE"
cat > "$NATIVE/gateway.json" <<EOF
{
  "mode": "gateway",
  "url": "$URL",
  "key": "",
  "timeoutMs": 600000
}
EOF
echo "  已写：$NATIVE/gateway.json  →  $URL"

if [ "${1:-}" = "--no-start" ]; then
  echo "[4/4] 跳过启动（--no-start）。手动起：cd '$GW' && sh run.sh start"
  exit 0
fi

echo "[4/4] 启动本地网关（监听 127.0.0.1:$PORT）"
cd "$GW"
if ! sh run.sh start; then
  echo "网关启动失败：请查看 $GW/logs/serve.log"
  echo "若是出票 shim 问题，确认 $GW/tools/bionic_shim/*.so 齐全后重试。"
  cd "$DIR"
  exit 1
fi
cd "$DIR"

echo ""
echo "============================================================"
echo "网关已就绪：$URL"
echo ""
echo "接下来在 magpie 里做三步（本脚本不代劳）："
echo "  1) 导入插件：侧栏 ≡ → 控制后台 127.0.0.1:3430 → 插件 → 导入本地文件夹 → 选 $DIR/plugin"
echo "  2) 网关加号登录：浏览器打开 http://127.0.0.1:$PORT/ → 账号池 → 加号登录（QQ/微信）"
echo "  3) magpie 供应商 marvis → 添加账号 → 选「本地网关（手机推荐，免登录）」→ provider test"
echo "============================================================"
