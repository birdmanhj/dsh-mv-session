#!/usr/bin/env bash
# dsh-web-restart.command — one-click restart of the dsh Web UI / 一键重启 dsh Web UI
#
# What it does / 功能：locate dsh → kill the old instance on the port → start
# `dsh web` → wait for HTTP 200 → open the browser. All messages bilingual.
# 定位 dsh → 关闭端口上的旧实例 → 启动 dsh web → 等待 HTTP 200 → 打开浏览器。
#
# Usage / 用法:
#   ./dsh-web-restart.command            # default port 3080 / 默认端口 3080
#   ./dsh-web-restart.command 3100       # custom port / 自定义端口
#   DSH_WEB_PORT=3100 ./dsh-web-restart.command
#
# macOS: double-click in Finder (make sure it is executable first) / macOS 可直接双击
#        （首次使用先执行一次 chmod +x）。Linux: bash scripts/dsh-web-restart.command。
set -uo pipefail

PORT="${1:-${DSH_WEB_PORT:-3080}}"
URL="http://127.0.0.1:${PORT}"
LOG="/tmp/dsh-web.log"
TIMEOUT=60

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; NC=$'\033[0m'
say()  { printf '%s\n' "$*"; }
err()  { printf '%s[error/错误]%s %s\n' "$RED" "$NC" "$*"; }
ok()   { printf '%s[ok/完成]%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s[info/检测]%s %s\n' "$YEL" "$NC" "$*"; }

# ---- 1. locate the dsh command / 定位 dsh 命令（多级兜底）-----------------
DSH_CMD=()
if command -v dsh >/dev/null 2>&1; then
  DSH_CMD=( "$(command -v dsh)" )
else
  for CAND in \
    "$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/lib/bin.js" \
    "/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    "/usr/local/bin/dsh"
  do
    if [ -n "$CAND" ] && [ -x "$CAND" ]; then DSH_CMD=( "$CAND" ); break; fi
  done
fi
if [ "${#DSH_CMD[@]}" -eq 0 ]; then
  err "dsh not found. Install it first: npm install -g @deepseek-ai/dsh / 未找到 dsh，请先执行: npm install -g @deepseek-ai/dsh"
  exit 1
fi
say "dsh command / dsh 命令: ${DSH_CMD[*]}"

# ---- 2. detect and stop the old instance / 检测并关闭旧实例 ----------------
PID="$(lsof -nP -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$PID" ]; then
  PROC="$(ps -o comm= -p "$PID" 2>/dev/null || true)"
  warn "Port ${PORT} is in use (PID=${PID}, process=${PROC}) / 端口 ${PORT} 已被占用 (PID=${PID}, 进程=${PROC})"
  if [ "$PROC" != "node" ]; then
    err "The port is held by a non-node program; refusing to kill it. Handle it manually or choose another port. / 端口被非 node 程序占用，为避免误杀已中止。请手动处理或换端口。"
    exit 1
  fi
  warn "Stopping the old dsh instance (PID=${PID}) ... / 正在关闭旧的 dsh 实例 (PID=${PID}) ..."
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -nP -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  if lsof -nP -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Graceful shutdown timed out, forcing kill ... / 优雅关闭超时，强制终止 ..."
    kill -9 "$PID" 2>/dev/null || true
    sleep 1
  fi
  ok "Old instance stopped / 旧实例已关闭"
fi

# ---- 3. start dsh web / 启动 dsh web ---------------------------------------
warn "Starting dsh web (log: ${LOG}) ... / 正在启动 dsh web (日志: ${LOG}) ..."
nohup "${DSH_CMD[@]}" web --port "$PORT" > "$LOG" 2>&1 &
DSH_PID=$!

# ---- 4. wait for readiness / 等待就绪 --------------------------------------
printf '[wait/等待] Waiting for the Web UI / 等待 Web UI 就绪'
READY=0
for _ in $(seq 1 "$TIMEOUT"); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$URL" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    printf '\n'
    err "dsh exited immediately after start. Log tail / dsh 启动后立即退出，日志末尾："
    tail -20 "$LOG"
    exit 1
  fi
  printf '.'
  sleep 1
done
printf '\n'

if [ "$READY" != "1" ]; then
  err "Timed out after ${TIMEOUT}s; the Web UI is not ready. Log tail / 等待 ${TIMEOUT}s 超时，Web UI 未就绪，日志末尾："
  tail -30 "$LOG"
  exit 1
fi

# ---- 5. open the browser / 打开浏览器 --------------------------------------
ok "Web UI ready / Web UI 已就绪: ${URL}"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
else warn "Browser auto-open unavailable; visit ${URL} manually / 无法自动打开浏览器，请手动访问 ${URL}"; fi
ok "Opened in the default browser. Stop it with: kill ${DSH_PID} / 已在默认浏览器打开。停止服务: kill ${DSH_PID}"
