#!/bin/sh
# magpie-marvis 端口与 503 诊断脚本（Termux / POSIX sh）
# 用法：sh magpie-marvis-diag.sh [--fix] [--no-start]
# 只读诊断默认；--fix 会写 gateway.json，并在 8088 未监听时尝试 `sh run.sh start` 拉起网关。
# --no-start 配合 --fix：只写配置不启动。不依赖 jq。

set -u

GW_JSON="$HOME/.magpie-marvis-native/gateway.json"
FIX=0
START=1
for _arg in "$@"; do
  case "$_arg" in
    --fix) FIX=1 ;;
    --no-start) START=0 ;;
    --start) START=1 ;;
    -h|--help)
      printf '%s\n' '用法：sh magpie-marvis-diag.sh [--fix] [--no-start]'
      printf '%s\n' '  默认只读诊断；--fix 写 gateway.json 并在需要时尝试启动 8088 网关。'
      printf '%s\n' '  --no-start  配合 --fix：只写配置，不去启动网关。'
      exit 0
      ;;
  esac
done

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
  printf '%s\n' '8088 有监听但 /v1/models 非 200。401 = 网关开了 key 鉴权而 gateway.json 的 key 为空；000 = curl 不可用/超时；其余先看网关侧日志与账号池。不要把 MARVIS_GW_URL 指向 http 端点。'
elif [ "$PORT_10123_OK" -eq 1 ]; then
  printf '%s\n' '10123 有监听而 8088 无监听。若你走 PC relay：确认 token 与协议；若你走手机 HTTP 网关：启动 phone-setup.sh / run.sh 让 8088 监听，再写 gateway.json。'
else
  printf '%s\n' '10123/8088 均未发现监听。手机请优先启动本地 Python 网关（phone-setup.sh），PC relay 则启动 Marvis 客户端。'
fi

printf '\nCONFIG_ORDER: '
if [ "$GW_JSON_EXISTS" -eq 1 ]; then
  printf '%s\n' 'gateway.json 存在。源码优先级：MARVIS_GATEWAY_CONFIG 指定文件 > ~/.magpie-marvis-native/gateway.json > 插件 native/gateway.json；同名 env 变量 > 文件 > 默认。'
else
  printf '%s\n' 'gateway.json 不存在。未显式配置时，localgateway 会在 1.5s 内探测 8088/v1/models，可达才自动走 gateway；直接跑本脚本 --fix 即可固化配置。'
fi

printf '\nCODE_MEANING:\n'
printf '%s\n' '  200 → 网关活着且能应答（但**不代表**网关侧有登录账号，503 no_account 仍可能）。'
printf '%s\n' '  401 → 网关开了 key 鉴权，而 gateway.json 的 key 是空串：把 key 填对，或在网关侧关掉鉴权。'
printf '%s\n' '  000 → curl 不可用或请求超时（Termux: pkg install curl -y），**不等于**网关没登录。'
printf '%s\n' '  其他非 200 → 网关进程在但内部异常，看网关侧日志。'

printf '\n建议的手机 HTTP 网关最小修复（仅在确认使用 8088 Python 网关时）：\n'
printf '%s\n' '  # ① 首选：本脚本 --fix（会自己写含 schemaVersion 的 gateway.json，'
printf '%s\n' '  #    端口按 ~/Marvis-proxy-public/config.json 取，不会把端口写死成 8088；'
printf '%s\n' '  #    写完再尝试启动网关并轮询 /v1/models 最多 12 秒）'
printf '%s\n' '  sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix'
printf '%s\n' '  # ② 降级：--fix 跑不了才手工写，端口必须与网关实际监听一致'
printf '%s\n' '  #   mkdir -p ~/.magpie-marvis-native'
printf '%s\n' '  #   cat > ~/.magpie-marvis-native/gateway.json <<EOF'
printf '%s\n' '  #   {"schemaVersion":1,"mode":"gateway","url":"http://127.0.0.1:8088/v1","key":"","timeoutMs":600000}'
printf '%s\n' '  #   EOF'
printf '%s\n' '  # ③ 环境变量只对当前 Termux 会话有效（关窗口即失效），持久化靠上面的 gateway.json：'
printf '%s\n' '  export MARVIS_GATEWAY_URL=http://127.0.0.1:8088/v1'
printf '%s\n' '  export MARVIS_TRANSPORT=gateway'
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

  # 配置写好了，但 8088 没进程在听的话插件照样 503 —— 顺手把网关卡起来。
  GW_DIR=''
  for _d in "${MARVIS_PROXY_DIR:-}" "$HOME/Marvis-proxy-public" "$HOME/marvis-proxy-public" \
            "$HOME/Marvis-proxy" "$HOME/.magpie-marvis/gateway"; do
    [ -n "$_d" ] || continue
    if [ -f "$_d/run.sh" ]; then GW_DIR="$_d"; break; fi
  done

  FIX_RUNNING=0
  if have curl && [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$URL/models" 2>/dev/null || echo 000)" = "200" ]; then
    FIX_RUNNING=1
  fi

  START_LOG="$HOME/.magpie-marvis-native/gateway-start.log"
  if [ "$FIX_RUNNING" -eq 1 ]; then
    printf 'GATEWAY: 已在监听（%s）\n' "$URL"
  elif [ "$START" -eq 0 ]; then
    printf 'GATEWAY: 未监听，按 --no-start 跳过启动。请手动执行：sh run.sh start\n'
  elif [ -z "$GW_DIR" ]; then
    printf 'GATEWAY: 未监听，且没找到 run.sh（找过 MARVIS_PROXY_DIR / ~/Marvis-proxy-public 等）。\n'
    printf '         先把网关目录放好，或用 MARVIS_PROXY_DIR=/path/to/gateway 再跑一次。\n'
  else
    printf 'GATEWAY: 未监听，尝试启动：cd %s && sh run.sh start\n' "$GW_DIR"
    ( cd "$GW_DIR" && sh run.sh start ) >>"$START_LOG" 2>&1
    printf 'GATEWAY: 启动命令已执行（日志 %s）\n' "$START_LOG"
    _i=0
    while [ "$_i" -lt 12 ]; do
      sleep 1
      _i=$((_i + 1))
      if have curl && [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$URL/models" 2>/dev/null || echo 000)" = "200" ]; then
        FIX_RUNNING=1
        printf 'GATEWAY: %s 秒后 /v1/models 返回 200\n' "$_i"
        break
      fi
      printf '  等待网关就绪… %s/12\n' "$_i"
    done
    if [ "$FIX_RUNNING" -ne 1 ]; then
      printf 'GATEWAY: 12 秒内没就绪。看日志：tail -n 40 %s\n' "$START_LOG"
    fi
  fi

  printf '\nFIX_RESULT:\n'
  printf '  gateway_json : %s\n' "$GW_JSON"
  printf '  url          : %s\n' "$URL"
  printf '  listening    : %s\n' "$FIX_RUNNING"
  printf '  next         : %s\n' 'listening=0 → 看上面 GATEWAY 行与 ~/.magpie-marvis-native/gateway-start.log；listening=1 仍 503 → 网关侧账号池是空的（去网关登录，并确认 magpie 里挂了「本地网关（免登录）」占位账号）'
fi
exit 0
