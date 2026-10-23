#!/usr/bin/env bash
# 静态安装冒烟关卡：完全模拟用户路径，在隔离的 DSH_HOME 里安装并启动。
# 发布前必须通过。任何 FAIL 都意味着用户 `dsh plugin add` 后会得到坏插件。
#
# 用法: bash scripts/static-smoke.sh [插件目录，默认当前仓库]
#
# 关卡（全部无浏览器，CI 可跑）:
#   1. dsh plugin --profile web add <dir>   — 安装不报错
#   2. dsh --profile web --dump-config      — 组合树含插件行
#   3. dsh --profile web --port <p> 启动     — 退出码 0、日志无 error
#   4. GET / 的 __DSH_BOOT__ 清单           — 含插件 client 行（bundle 被发现）
#   5. GET /plugins/dsh-xueqiu/client.js    — 200 且是 __ModuleLoader__ 工厂格式
#   6. POST /xq-rpc quote                   — 真实行情返回 ok
#   7. 栅栏: 恶意 Origin 得 403
# 可选: 环境变量 SMOKE_BROWSER=1 且装有 agent-browser 时，追加浏览器徽章检查。
#
# 数据关卡分级（P0-C）：SMOKE_LIVE=strict（默认，本地/发版 tag）上游错误一律 FAIL；
# SMOKE_LIVE=warn（CI PR 路径）时上游风控类错误降级为 UPSTREAM_BLOCKED 警告——
# 结构关卡（1-5/7）仍然全数 FAIL。理由：匿名通道是否被雪球边缘拦截取决于出口 IP，
# 与插件好坏无关；PR 上被它劫持会掩盖真正的结构性回归（旧 SMOKE_CI 逃生口的正式化）。
set -uo pipefail

PLUGIN_DIR=${1:-$(cd "$(dirname "$0")/.." && pwd)}
PLUGIN_DIR=$(cd "$PLUGIN_DIR" && pwd)
PORT=${SMOKE_PORT:-3199}
# SMOKE_LIVE 未设时回退旧 SMOKE_CI 语义（设置了即 warn），默认 strict
if [ -z "${SMOKE_LIVE:-}" ]; then
  [ -n "${SMOKE_CI:-}" ] && SMOKE_LIVE=warn || SMOKE_LIVE=strict
fi
# 默认找本地 npx 缓存里的 dsh（避免依赖全局 dsh 命令）；可被 DSH_BIN 覆盖
if [ -z "${DSH_BIN:-}" ]; then
  DSH_BIN=$(ls "$HOME"/.npm/_npx/*/node_modules/.bin/dsh 2>/dev/null | head -1)
  [ -z "$DSH_BIN" ] && DSH_BIN=dsh
fi
export DSH_BIN
TMP=$(mktemp -d /tmp/xq-smoke.XXXXXX)
BOOT_LOG="$TMP/boot.log"
FAIL=0

say()  { printf '%s\n' "$*"; }
pass() { say "  ✅ $*"; }
warn() { say "  ⚠️  $* (SMOKE_LIVE=$SMOKE_LIVE)"; }
fail() { say "  ❌ $*"; FAIL=1; }

cleanup() {
  # 杀整个进程组（只杀子 shell 不够——dsh 是孙进程，会变孤儿占着端口污染下一次运行）
  if [ -n "${SERVER_PID:-}" ]; then
    kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
    sleep 1
    lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null
  fi
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

say "==> 静态冒烟: PLUGIN_DIR=$PLUGIN_DIR  DSH_HOME=$TMP  PORT=$PORT"

# 端口预检：被占用直接拒绝运行（残留监听会伪造“启动成功”）
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  say "❌ 端口 $PORT 已被占用（上一次运行的残留？）— 先清理再跑，否则结果不可信"
  exit 1
fi

# ---- 1. 安装 ----
say "-- 1/7 安装 (dsh plugin add)"
if (cd "$TMP" && DSH_HOME="$TMP" "$DSH_BIN" plugin --profile web add "$PLUGIN_DIR" >"$TMP/install.log" 2>&1); then
  pass "安装成功"
else
  fail "安装失败 — 用户第一步就走不通"
  tail -8 "$TMP/install.log" 2>/dev/null | sed 's/^/     /'
  exit 1
fi

# ---- 2. 组合树 ----
say "-- 2/7 组合树 (--dump-config)"
if (cd "$TMP" && DSH_HOME="$TMP" timeout 120 "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q '^# == dsh-xueqiu'); then
  pass "组合树含 dsh-xueqiu"
else
  fail "组合树缺插件行（loader 侧拒绝或崩溃）"
fi

# ---- 3. 启动 ----
say "-- 3/7 启动 (dsh web)"
# setsid 建独立进程组，保证 cleanup 能整组回收
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "cd '$TMP' && DSH_HOME='$TMP' '$DSH_BIN' --profile web --port '$PORT' >'$BOOT_LOG' 2>&1" &
  SERVER_PID=$!
else
  (cd "$TMP" && DSH_HOME="$TMP" "$DSH_BIN" --profile web --port "$PORT" >"$BOOT_LOG" 2>&1) &
  SERVER_PID=$!
fi
up=0
TOKEN=""
for i in $(seq 1 60); do
  # 新版 dsh web 默认 token 鉴权：裸 / 返回 401（曾致 60s 探测全空转、误报"实例未启动"，
  # 且 boot 日志里明明打印了 token URL——2026-10-23 CI v1.25.0 tag run 实证）。
  # 就绪判定对齐 e2e-ci-boot.sh：裸 200（旧版）或 ?token= 得 200/303（新版）。
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
  [ "$code" = "200" ] && { up=1; break; }
  if [ -z "$TOKEN" ]; then
    TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$BOOT_LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)
  fi
  if [ -n "$TOKEN" ]; then
    tcode=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null)
    if [ "$tcode" = "200" ] || [ "$tcode" = "303" ]; then up=1; break; fi
  fi
  sleep 1
done
if [ "$up" = 1 ]; then
  if [ -n "$TOKEN" ]; then
    pass "实例启动且首页可达（token 鉴权）"
  else
    pass "实例启动且首页 200"
  fi
else
  fail "实例未启动（v1.7.0 同款崩溃？）— 启动日志尾部:"
  tail -5 "$BOOT_LOG" | sed 's/^/     /'
  exit 1
fi
# 后续关卡的鉴权后缀：新版 dsh 带 ?token=，旧版为空串（URL 不变）
AUTH=""
[ -n "$TOKEN" ] && AUTH="?token=$TOKEN"
if grep -qi 'error' "$BOOT_LOG"; then
  fail "启动日志含 error:"
  grep -i error "$BOOT_LOG" | head -3 | sed 's/^/     /'
else
  pass "启动日志无 error"
fi

# ---- 4. boot 清单 ----
say "-- 4/7 __DSH_BOOT__ 清单"
# token 鉴权版：GET /?token= 是 303（消费 token 种 auth cookie 后重定向），curl 不带 -L/cookie
# 只能拿到空重定向体（2026-10-23 CI 实证：gate 6 RPC 带 query token 能通，页面/资源 GET 必须走
# cookie）。先消费 token 落 cookie jar，再带 cookie 抓取；旧版（无 token）jar 为空不影响。
JAR="$TMP/smoke-cookies.txt"
if [ -n "$TOKEN" ]; then
  curl -s -L -c "$JAR" -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"
fi
BOOT=$(curl -s -b "$JAR" "http://127.0.0.1:$PORT/")
if echo "$BOOT" | grep -q '"id":"dsh-xueqiu"'; then
  pass "boot 清单含 dsh-xueqiu client 行"
else
  fail "boot 清单缺插件 — client 半没被发现（dsh.client/exports 声明问题）"
fi

# ---- 5. client bundle ----
say "-- 5/7 client bundle 格式"
# 多候选按序试取（2026-10-23 CI 实证版本差异：部分 dsh 对资源路径强制 ?rev=，缺参 404，
# 本地同路径 200）：① boot 页自证路径 ② 页面其它插件 src 的 rev 参数复用 ③ 带 AUTH 旧路径
BUNDLE=""
HIT_URL=""
TRIED=""
CAND1=$(printf '%s' "$BOOT" | grep -oE '/plugins/dsh-xueqiu/client\.js[^"'\'' ]*' | head -1)
[ -n "$CAND1" ] && TRIED="$TRIED 1:$CAND1"
REV=$(printf '%s' "$BOOT" | grep -oE 'client\.js\?rev=[0-9a-f]+' | head -1 | sed 's/.*rev=//')
CAND2="/plugins/dsh-xueqiu/client.js"
[ -n "$REV" ] && CAND2="/plugins/dsh-xueqiu/client.js?rev=$REV"
for u in "$CAND1" "$CAND2" "/plugins/dsh-xueqiu/client.js$AUTH"; do
  [ -z "$u" ] && continue
  B=$(curl -s -b "$JAR" "http://127.0.0.1:$PORT$u")
  if [[ "$B" == *__ModuleLoader__* ]]; then BUNDLE="$B"; HIT_URL="$u"; break; fi
  TRIED="$TRIED | $u→$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://127.0.0.1:$PORT$u")"
done
# 合并式兜底（2026-10-23 CI 实证：新 dsh 把 bundle 层合并进宿主主 bundle，独立插件
# 资源路径 404 且页面无插件 script src）——扫页面全部 script src，逐个取回找插件标记。
# 命中即证明"插件 client 确实被浏览器加载"，与独立文件形态等价。
if [[ "$BUNDLE" != *__ModuleLoader__* ]]; then
  while read -r src; do
    [ -z "$src" ] && continue
    case "$src" in /*) ;; *) continue ;; esac
    B=$(curl -s -b "$JAR" "http://127.0.0.1:$PORT$src")
    if [[ "$B" == *__ModuleLoader__* && "$B" == *dsh-xueqiu* ]]; then
      BUNDLE="$B"; HIT_URL="$src（合并式）"; break
    fi
  done <<EOF
$(printf '%s' "$BOOT" | grep -oE 'src="[^"]*"' | sed 's/src="//; s/"$//' | head -8)
EOF
fi
if [[ "$BUNDLE" == *__ModuleLoader__* ]]; then
  pass "bundle 是 __ModuleLoader__ 工厂格式 (src=$HIT_URL)"
else
  fail "bundle 缺 __ModuleLoader__.load — 浏览器端会 SyntaxError（尝试=$TRIED head=$(printf '%s' "$B" | head -c 60)）"
fi
# P1-A 起传输层是运行时接缝：host.call 合法存在于 typeof host 守卫内（静态环境走不到），
# 但静态 fetch 分支必须存在（缺了则浏览器端全部 RPC 404/崩）。旧"无 host.call 残留"断言随之废弃。
if [[ "$BUNDLE" == *"/xq-rpc"* && "$BUNDLE" == *"typeof host"* ]]; then
  pass "bundle 含传输接缝（fetch /xq-rpc 分支 + typeof host 守卫）"
else
  fail "bundle 缺静态传输分支 — 浏览器端 RPC 会全挂"
fi

# ---- 6. RPC 真实数据 ----
say "-- 6/7 /xq-rpc 行情"
# v1.22.8 起 Origin 必须存在且同源（浏览器对同源 POST 必带 Origin）——模拟真实浏览器调用
QUOTE=$(curl -s -m 30 -X POST "http://127.0.0.1:$PORT/xq-rpc$AUTH" -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" -d '{"action":"quote","args":{"symbols":"SH600519"}}')
if [[ "$QUOTE" == *'"ok":true'* ]]; then
  pass "RPC 返回真实行情"
elif [ "$SMOKE_LIVE" = "warn" ] && [[ "$QUOTE" == *'[seed_blocked]'* || "$QUOTE" == *'[cookie_expired]'* || "$QUOTE" == *'[waf]'* || "$QUOTE" == *'[empty'* || "$QUOTE" == *'[rate_limited]'* || "$QUOTE" == *'[network]'* ]]; then
  # 上游风控/网络类错误：通道本身已验证（拿到了结构化 JSON 错误，说明 RPC/fence/分发全活）
  warn "UPSTREAM_BLOCKED（上游拒绝匿名请求，非插件损坏）: $(echo "$QUOTE" | head -c 120)"
else
  fail "RPC 失败: $(echo "$QUOTE" | head -c 120)"
fi

# ---- 7. 栅栏 ----
say "-- 7/7 同源栅栏"
if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/xq-rpc$AUTH" -H 'Origin: http://evil.example' -d '{}')" = "403" ]; then
  pass "恶意 Origin 被 403"
else
  fail "栅栏未拦截跨源请求"
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/xq-rpc$AUTH" -H 'Content-Type: application/json' -d '{}')" = "403" ]; then
  pass "无 Origin 直调被 403（v1.22.8 起要求 Origin 必须存在）"
else
  fail "无 Origin 直调未被拦截"
fi

# ---- 可选浏览器层 ----
if [ "${SMOKE_BROWSER:-0}" = "1" ] && command -v agent-browser >/dev/null 2>&1; then
  say "-- 附: 浏览器徽章"
  agent-browser open "http://127.0.0.1:$PORT/" >/dev/null 2>&1
  sleep 6
  RES=$(timeout 25 agent-browser eval 'document.querySelector(".xq-badge") ? "BADGE_OK" : "NO_BADGE"' 2>/dev/null)
  agent-browser close >/dev/null 2>&1
  [ "$RES" = '"BADGE_OK"' ] && pass "浏览器徽章挂载" || fail "浏览器徽章未挂载 ($RES)"
fi

say ""
if [ "$FAIL" = 0 ]; then
  say "✅ 静态冒烟全部通过 — 可发布"
  exit 0
else
  say "❌ 静态冒烟有失败项 — 禁止发布"
  exit 1
fi
