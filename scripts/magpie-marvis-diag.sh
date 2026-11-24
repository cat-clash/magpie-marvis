#!/bin/sh
# magpie-marvis 端口与 503 诊断脚本（Termux / POSIX sh）
# 用法：sh magpie-marvis-diag.sh [--fix]
# 只读诊断默认；--fix 会在确认使用 8088 HTTP 网关时补写 gateway.json 与稳定目录脚本。
# 不依赖 jq。

set -u

GW_JSON="$HOME/.magpie-marvis-native/gateway.json"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

section() {
  printf '\n============================================================\n'
  printf '%s\n' "$1"
  printf '============================================================\n'
}

have() {
  command -v "$1" >/dev/null 2>&1
}

section '[0] 平台与运行时信息'
printf 'DATE          : %s\n' "$(date 2>/dev/null || echo unknown)"
printf 'UNAME         : %s\n' "$(uname -a 2>/dev/null || echo unknown)"
printf 'SHELL         : %s\n' "${SHELL:-<unset>}"
printf 'USER          : %s\n' "$(id -un 2>/dev/null || echo unknown)"
printf 'HOME          : %s\n' "$HOME"
printf 'PREFIX        : %s\n' "${PREFIX:-<unset>}"
printf 'TERMUX_VERSION: %s\n' "${TERMUX_VERSION:-<unset>}"

section '[1] 关键环境变量（两条通道）'
printf '%s\n' 'HTTP/OpenAI 8088 通道：MARVIS_GATEWAY_URL / MARVIS_TRANSPORT / MARVIS_GATEWAY_KEY / MARVIS_GATEWAY_TIMEOUT_MS / MARVIS_GATEWAY_CONFIG'
printf '%s\n' 'AG-UI WS 10123 通道：MARVIS_GW_URL / MARVIS_WS_MODE / MARVIS_HANDSHAKE'
for v in MARVIS_GATEWAY_URL MARVIS_TRANSPORT MARVIS_GATEWAY_KEY MARVIS_GATEWAY_TIMEOUT_MS \
          MARVIS_GATEWAY_CONFIG MARVIS_GW_URL MARVIS_WS_MODE MARVIS_HANDSHAKE \
          MARVIS_GW_REMOTE_URL MARVIS_GATEWAY_URL MARVIS_GATEWAY_MODE \
          MAGPIE_PLATFORM MAGPIE_APP MAGPIE_SHELL DSH_PLATFORM \
          MARVIS_RUNTIME MARVIS_CLIENT MARVIS_ENV ANDROID_ROOT ANDROID_DATA \
          HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy; do
  eval "_set=\${$v+x}"
  if [ "$_set" = x ]; then
    eval "_val=\${$v}"
    case "$v" in
      *KEY*|*TOKEN*|*HANDSHAKE*) printf '%-30s = <set, hidden>\n' "$v" ;;
      *) printf '%-30s = %s\n' "$v" "$_val" ;;
    esac
  else
    printf '%-30s = <unset>\n' "$v"
  fi
done

section '[2] gateway.json 状态与内容'
if [ -f "$GW_JSON" ]; then
  printf 'FOUND       : %s\n' "$GW_JSON"
  printf 'PERMS       : %s\n' "$(ls -l "$GW_JSON" 2>/dev/null || echo unknown)"
  printf '%s\n' '--- BEGIN gateway.json ---'
  if have python3; then
    python3 -m json.tool < "$GW_JSON" 2>/dev/null || cat "$GW_JSON"
  else
    cat "$GW_JSON"
  fi
  printf '%s\n' '--- END gateway.json ---'
else
  printf 'MISSING     : %s\n' "$GW_JSON"
  printf '%s\n' '说明：若走 8088 HTTP 网关，可运行 phone-setup.sh 自动写入，或手工创建。'
fi

section '[3] 端口监听检查（10123 / 8088）'
check_port_listen() {
  _port="$1"
  printf '\n--- PORT %s ---\n' "$_port"
  _found=0

  if have ss; then
    printf '[ss]\n'
    ss -ltnp 2>/dev/null | grep -E "(^|[:.])${_port}([[:space:]]|$)" || echo '(ss 未发现监听)'
    _ss_out=$(ss -ltn 2>/dev/null | grep -E "(^|[:.])${_port}([[:space:]]|$)" || true)
    [ -n "$_ss_out" ] && _found=1
  else
    printf '[ss] 不可用\n'
  fi

  if have netstat; then
    printf '[netstat]\n'
    netstat -ltnp 2>/dev/null | grep -E "(^|[:.])${_port}([[:space:]]|$)" || echo '(netstat 未发现监听)'
    _ns_out=$(netstat -ltn 2>/dev/null | grep -E "(^|[:.])${_port}([[:space:]]|$)" || true)
    [ -n "$_ns_out" ] && _found=1
  else
    printf '[netstat] 不可用\n'
  fi

  if have nc; then
    printf '[nc -z 127.0.0.1 %s]\n' "$_port"
    if nc -z -w 2 127.0.0.1 "$_port" >/dev/null 2>&1; then
      echo 'CONNECT OK（TCP 可连接）'
      _found=1
    else
      echo 'CONNECT FAIL（TCP 不可连接）'
    fi
  else
    printf '[nc] 不可用\n'
  fi

  if [ "$_found" -eq 1 ]; then
    printf 'RESULT port %s : 有监听/可连接的证据\n' "$_port"
  else
    printf 'RESULT port %s : 未发现监听（或工具不可用导致无法确认）\n' "$_port"
  fi
}

check_port_listen 10123
check_port_listen 8088

section '[4] curl 测试 http://127.0.0.1:8088/v1/models'
if have curl; then
  printf '%s\n' '$ curl -sS -i --max-time 5 http://127.0.0.1:8088/v1/models'
  curl -sS -i --max-time 5 http://127.0.0.1:8088/v1/models 2>&1
  printf '\nHTTP_CODE: %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8088/v1/models 2>/dev/null || echo 000)"
else
  printf '%s\n' 'curl 不可用：Termux 可执行 pkg install curl 后重试。'
fi

section '[5] tcpdump 抓包建议'
if have tcpdump; then
  printf '检测到 tcpdump：%s\n' "$(command -v tcpdump)"
  printf '%s\n' '建议（需要 root 或 Termux 已授权存储/网络能力时）：'
  printf '%s\n' '  tcpdump -i any -nn -s 0 -A "tcp port 10123 or tcp port 8088" -w /sdcard/marvis_ports.pcap'
  printf '%s\n' '实时查看：'
  printf '%s\n' '  tcpdump -i any -nn -A -s 0 "tcp port 10123 or tcp port 8088"'
else
  printf '%s\n' '未检测到 tcpdump。'
  printf '%s\n' 'Termux 安装：pkg install root-repo && pkg install tcpdump'
  printf '%s\n' '安装后抓包命令：'
  printf '%s\n' '  tcpdump -i any -nn -s 0 -A "tcp port 10123 or tcp port 8088" -w /sdcard/marvis_ports.pcap'
fi

section '[6] 结构化诊断结论'
GW_JSON_EXISTS=0
PORT_10123_OK=0
PORT_8088_OK=0
MODELS_HTTP='000'

[ -f "$GW_JSON" ] && GW_JSON_EXISTS=1

if have ss; then
  ss -ltn 2>/dev/null | grep -E "(^|[:.])10123([[:space:]]|$)" >/dev/null 2>&1 && PORT_10123_OK=1
  ss -ltn 2>/dev/null | grep -E "(^|[:.])8088([[:space:]]|$)" >/dev/null 2>&1 && PORT_8088_OK=1
fi
if have netstat; then
  netstat -ltn 2>/dev/null | grep -E "(^|[:.])10123([[:space:]]|$)" >/dev/null 2>&1 && PORT_10123_OK=1
  netstat -ltn 2>/dev/null | grep -E "(^|[:.])8088([[:space:]]|$)" >/dev/null 2>&1 && PORT_8088_OK=1
fi
if have nc; then
  nc -z -w 2 127.0.0.1 10123 >/dev/null 2>&1 && PORT_10123_OK=1
  nc -z -w 2 127.0.0.1 8088 >/dev/null 2>&1 && PORT_8088_OK=1
fi
if have curl; then
  MODELS_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8088/v1/models 2>/dev/null || echo 000)
fi

printf 'gateway_json_exists    : %s\n' "$GW_JSON_EXISTS"
printf 'port_10123_listening   : %s\n' "$PORT_10123_OK"
printf 'port_8088_listening    : %s\n' "$PORT_8088_OK"
printf 'models_http_code       : %s\n' "$MODELS_HTTP"
printf 'MARVIS_GATEWAY_URL     : %s\n' "${MARVIS_GATEWAY_URL:-<unset>}"
printf 'MARVIS_TRANSPORT       : %s\n' "${MARVIS_TRANSPORT:-<unset>}"
printf 'MARVIS_GW_URL          : %s\n' "${MARVIS_GW_URL:-<unset>}"
printf 'MARVIS_WS_MODE         : %s\n' "${MARVIS_WS_MODE:-<unset>}"

printf '\nNEXT_ACTION: '
if [ "$PORT_8088_OK" -eq 1 ] && [ "$MODELS_HTTP" = "200" ]; then
  printf '%s\n' '8088 HTTP 网关可用。若仍报 503：请确认 MARVIS_GATEWAY_URL=http://127.0.0.1:8088/v1 且 MARVIS_TRANSPORT=gateway（或 gateway.json.mode=gateway）；同时确认网关账号池与 maggie 占位账号都有号。若报的是 ws://127.0.0.1:10123/，说明当前是 AG-UI relay 通道，需设置 MARVIS_WS_MODE=remote 或启动 PC relay，MARVIS_GW_URL 与 MARVIS_GATEWAY_URL 是两条不同链路。'
elif [ "$PORT_8088_OK" -eq 1 ]; then
  printf '%s\n' '8088 有监听但 /v1/models 非 200。优先在 Python 网关侧排查账号池/登录状态；不要把 MARVIS_GW_URL 指向 http 端点。'
elif [ "$PORT_10123_OK" -eq 1 ]; then
  printf '%s\n' '10123 有监听而 8088 无监听。若你走 PC relay：确认 token 与协议；若你走手机 HTTP 网关：启动 phone-setup.sh / run.sh 让 8088 监听，再写 gateway.json。'
else
  printf '%s\n' '10123/8088 均未发现监听。手机请优先启动本地 Python 网关（phone-setup.sh），PC relay 则启动 Marvis 客户端。'
fi

printf '\nCONFIG_ORDER: '
if [ "$GW_JSON_EXISTS" -eq 1 ]; then
  printf '%s\n' 'gateway.json 存在。源码优先级：MARVIS_GATEWAY_CONFIG 指定文件 > ~/.magpie-marvis-native/gateway.json > 插件 native/gateway.json；同名 env 变量 > 文件 > 默认。'
else
  printf '%s\n' 'gateway.json 不存在。未显式配置时，localgateway 会在 1.5s 内探测 8088/v1/models，可达才自动走 gateway；建议直接创建 gateway.json 固化配置。'
fi

printf '\n建议的手机 HTTP 网关最小修复（仅在确认使用 8088 Python 网关时）：\n'
printf '%s\n' '  export MARVIS_GATEWAY_URL=http://127.0.0.1:8088/v1'
printf '%s\n' '  export MARVIS_TRANSPORT=gateway'
printf '%s\n' '  # 或写入 gateway.json: {"mode":"gateway","url":"http://127.0.0.1:8088/v1","timeoutMs":600000}'
printf '%s\n' '  # 若错误仍指向 ws://127.0.0.1:10123/，那是 AG-UI WS 通道：设置 MARVIS_WS_MODE=remote 或启动 PC relay。'
printf '\nDONE\n'

if [ "$FIX" -eq 1 ]; then
  section '[7] --fix：固化 8088 HTTP 网关配置'
  PORT=8088
  if [ -f "$HOME/Marvis-proxy-public/config.json" ] && have python3; then
    PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get("port",8088))' "$HOME/Marvis-proxy-public/config.json" 2>/dev/null || echo 8088)
  fi
  URL="http://127.0.0.1:$PORT/v1"
  mkdir -p "$HOME/.magpie-marvis-native"
  cat > "$GW_JSON" <<EOF
{
  "schemaVersion": 1,
  "mode": "gateway",
  "url": "$URL",
  "key": "",
  "timeoutMs": 600000
}
EOF
  printf 'WROTE  : %s\n' "$GW_JSON"
  printf 'URL    : %s\n' "$URL"
  printf '%s\n' '下一步：若 8088 未监听，先在网关目录执行 sh run.sh start；再执行 magpie provider test。'
fi
exit 0
