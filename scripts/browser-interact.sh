#!/usr/bin/env bash
# 浏览器交互回归（真实鼠标事件，非合成 dispatch）：
#   徽章结构、拖拽+持久化、⤡ 调宽+持久化、双击复位(null 落盘)、
#   面板开关、四 tab 数据渲染、越屏位置恢复钳制（含钳制落盘）。
#
# 用法:
#   bash scripts/browser-interact.sh                                  # 默认 http://127.0.0.1:3080
#   BASE_URL=http://h:p bash scripts/browser-interact.sh              # 指定实例
# 前提: agent-browser 已安装。全新隔离实例可直接跑（脚本自动完成宿主首跑向导并建立会话视图）。
# 环境豁免: 上游 WAF 拦截热榜/快讯时标记 SKIP 不计失败（[waf] 是宿主侧正确分类，非回归）。
# 测试自动保存并在退出时恢复原 UI 状态（badgePos/badgeW/dockH/tab/open）。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE_URL=${BASE_URL:-http://127.0.0.1:3080}
# agent-browser 的 socket 目录默认在 ~/.agent-browser；沙箱/受限环境下可用 AGENT_BROWSER_SOCKET_DIR 改道
[ -n "${AGENT_BROWSER_SOCKET_DIR:-}" ] && export AGENT_BROWSER_SOCKET_DIR
PORT=$(echo "$BASE_URL" | grep -o '[0-9]*$')
O="Origin: $BASE_URL"
# 新版 dsh token 鉴权：E2E_TOKEN 存在时页面导航带 token（消费后种 auth cookie），rpc 直调带 query token
PAGE_URL="$BASE_URL/"
RPC_Q=""
if [ -n "${E2E_TOKEN:-}" ]; then PAGE_URL="$BASE_URL/?token=$E2E_TOKEN"; fi

FAIL=0
SKIP=0
pass() { printf '  ✅ %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*"; FAIL=1; }
skip() { printf '  ⏭️  %s（环境豁免，不计失败）\n' "$*"; SKIP=1; }
ev() { agent-browser eval "$1" 2>/dev/null; }
# token 鉴权模式（新版 dsh，单次消费语义——2026-10-23 CI 实证）：
# 浏览器 open PAGE_URL 是唯一一次 token 消费（种 auth cookie），此后 curl 已无凭据可用，
# rpc() 全部改走页面同源 fetch（借浏览器 cookie 鉴权）。无 token 模式（旧版 dsh/本地）维持 curl。
# 注意：页内 fetch 由 agent-browser(Playwright) 等待 promise，返回对象直接序列化为 JSON——
# 与 curl 输出同为可 grep 的 {"ok":...} 形状。
rpc() {
  if [ -n "${E2E_TOKEN:-}" ]; then
    # body 必须 JSON.stringify（fetch 只收字符串，直接传对象会变 "[object Object]"，
    # 服务端解析出 action:undefined——CI 实测）；输出经 jq -c 压平成与 curl 一致的
    # 紧凑单行 JSON（agent-browser 对返回对象是 2 空格缩进 pretty 打印，会打断
    # 脚本里所有 "badgePos":{...} 形状的行内 grep 断言）。jq 缺失时原样透传（弱化但不崩）。
    local out
    out=$(ev "(async function(){try{const r=await fetch('/xq-rpc',{method:'POST',headers:{'Content-Type':'application/json','Origin':location.origin},body:JSON.stringify($1)});return await r.json()}catch(e){return {ok:false,error:'E2E_PAGE_FETCH:'+String(e&&e.message||e)}}})()")
    printf '%s' "$out" | jq -c . 2>/dev/null || printf '%s' "$out"
  else
    curl -s -m 20 -X POST "$BASE_URL/xq-rpc" -H "$O" -H 'Content-Type: application/json' -d "$1"
  fi
}

# 浏览器必须最先消费 token（在第一次 rpc 之前！）——先开页面种 cookie，再备份状态
agent-browser open "$PAGE_URL" >/dev/null 2>&1
sleep 8

# ---- 状态保存/恢复 ----
SAVED=$(rpc '{"action":"ui.get","args":{}}')
spos=$(echo "$SAVED" | grep -o '"badgePos":{[^}]*}' | sed 's/"badgePos"://' || true)
sbw=$(echo "$SAVED" | grep -o '"badgeW":[0-9]*' | grep -o '[0-9]*$' || true)
sdh=$(echo "$SAVED" | grep -o '"dockH":[0-9]*' | grep -o '[0-9]*$' || true)
stab=$(echo "$SAVED" | grep -o '"tab":"[^"]*"' | cut -d'"' -f4 || true)
sopen=$(echo "$SAVED" | grep -o '"open":[a-z]*' | grep -o 'true\|false' || true)
restore() {
  local args=()
  [ -n "$stab" ] && args+=("\"tab\":\"$stab\"")
  [ -n "$sopen" ] && args+=("\"open\":$sopen")
  # badgePos 越屏/残留兜底：原值为空（null/未设置）时显式回中，防 99999 残留
  [ -n "$spos" ] && args+=("\"badgePos\":$spos") || args+=('"badgePos":{"x":420,"y":160}')
  [ -n "$sbw" ] && args+=("\"badgeW\":$sbw")
  [ -n "$sdh" ] && args+=("\"dockH\":$sdh")
  rpc "{\"action\":\"ui.set\",\"args\":{$(IFS=,; echo "${args[*]}")}}" >/dev/null
  return 0
}
trap 'restore >/dev/null 2>&1; agent-browser close >/dev/null 2>&1' EXIT

echo "==> 浏览器交互回归  base=$BASE_URL"
command -v agent-browser >/dev/null 2>&1 || { echo "❌ 需要 agent-browser"; exit 1; }


# ---- 0. 就绪预处理（全新实例专用；本地已引导实例自动跳过）----
# 两个前置坑（2026-10 实测定位，曾误判为 agent-browser 0.27 mouse API 兼容问题——
# mouse 事件实为真 pointer 事件，问题在命中目标）：
#   a) 首跑工作区向导的宿主 mask（_mask_* 遮罩）盖在徽章上层，pointerdown 命中 mask 而非徽章
#   b) 无活动对话时 conversation.input.dock 槽不渲染——DockGate 不挂载，
#      badgePos 的 hydrate 恢复与越屏钳制都不执行
echo "-- 就绪预处理（向导/会话，已引导实例自动跳过）"
ev '(function(){var bs=Array.from(document.querySelectorAll("button"));var hit=bs.filter(function(b){return (b.textContent||"").replace(/\s+/g,"").indexOf("标准模式")>=0});hit.forEach(function(b){b.click()});return hit.length})()' >/dev/null
sleep 1
ev '(function(){var bs=Array.from(document.querySelectorAll("button"));for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||"").trim();if(t==="继续"){bs[i].click();return 1}}return 0})()' >/dev/null
sleep 3
ev '(function(){var gs=Array.from(document.querySelectorAll("[role=treeitem][aria-expanded=false]"));gs.forEach(function(g){g.dispatchEvent(new MouseEvent("click",{bubbles:true}))});return gs.length})()' >/dev/null
sleep 2
ev '(function(){var items=Array.from(document.querySelectorAll("[role=treeitem]"));var leaf=items.filter(function(e){return !e.querySelector("[role=treeitem]")}).pop();if(leaf){leaf.dispatchEvent(new MouseEvent("click",{bubbles:true}));return "opened-session"}return "no-session"})()' >/dev/null
sleep 3

# ---- 1. 结构 ----
echo "-- 徽章结构与挂载"
# SPA 冷启动 + token 消费 + 插件挂载在慢 runner 上可超 8s（2026-10-23 CI tag run 实证：
# 单次 sleep 8 一锤定音误报"未挂载"）——改轮询 6×5s；最终失败输出分层诊断，
# 区分"插件没被加载"（boot 清单/加载器缺失 → dsh 侧问题）与"加载了没挂上"（→插件代码问题）。
R="NO"
for i in 1 2 3 4 5 6; do
  R=$(ev 'document.querySelector(".xq-badge") ? "OK" : "NO"')
  [ "$R" = '"OK"' ] && break
  # 中途兜底：若页面连应用加载器都没有（CI 实证过——boot 探针可能已消费 token，
  # 浏览器再开同 token 落在无应用内容的页面），第 3 轮起用同 token 重开一次
  if [ "$i" = 3 ]; then
    HASLOADER=$(ev 'typeof window.__ModuleLoader__ !== "undefined" ? "yes" : "no"' 2>/dev/null)
    [ "$HASLOADER" != '"yes"' ] && { agent-browser open "$PAGE_URL" >/dev/null 2>&1; sleep 6; }
  fi
  sleep 5
done
if [ "$R" != '"OK"' ]; then
  echo "     诊断: url=$(ev 'location.href' 2>/dev/null | head -c 80)"
  echo "     诊断: title=$(ev 'document.title' 2>/dev/null | head -c 60)"
  echo "     诊断: 正文头=$(ev '(document.body.innerText||"").slice(0,60).replace(/\n/g,"|")' 2>/dev/null)"
  echo "     诊断: boot清单=$(ev 'typeof window.__DSH_BOOT__==="object" ? (String(JSON.stringify(window.__DSH_BOOT__)).includes("dsh-xueqiu") ? "has-plugin" : "no-plugin") : "no-boot"' 2>/dev/null)"
  echo "     诊断: 插件样式标签=$(ev '!!document.querySelector("style[data-plugin=dsh-xueqiu]")' 2>/dev/null)"
  echo "     诊断: 模块加载器=$(ev 'typeof window.__ModuleLoader__ !== "undefined" ? "yes" : "no"' 2>/dev/null)"
  echo "     诊断: dsh版本=$("$DSH_BIN" --version 2>/dev/null || echo unknown)"
fi
[ "$R" = '"OK"' ] && pass "徽章挂载" || { fail "徽章未挂载 ($R)"; exit 1; }
R=$(ev '(function(){var h=document.querySelector(".xq-badge-hd");return h?getComputedStyle(h).flexDirection:"NO_HD"})()')
[ "$R" = '"row"' ] && pass "头部行水平排列" || fail "头部行排列异常 ($R)"
# 数据可用性预探：quote RPC 失败（cookie 过期 / WAF / 匿名种子被拦）时，数据类断言整体环境豁免。
# 结构/交互类断言（挂载/布局/手柄/拖拽/调宽/钳制/tab/开关）不受影响，保持硬性。
QPROBE=$(rpc '{"action":"quote","args":{"symbols":["SH000001"]}}')
DATA_OK=1
if ! echo "$QPROBE" | grep -q '"ok":true'; then
  DATA_OK=0
  skip "上游数据不可用（$(echo "$QPROBE" | grep -o '\[[a-z_]*\]' | head -1)）—— 指数/自选/热榜/快讯数据断言豁免"
fi
if [ "$DATA_OK" = 1 ]; then
  R=$(ev 'document.querySelectorAll(".xq-idxgrid .xq-idxrow").length')
  [ "$R" -ge 4 ] 2>/dev/null && pass "指数网格 4 行 (实际 $R)" || fail "指数网格行数异常 ($R)"
  R=$(ev '(function(){var rows=document.querySelectorAll(".xq-idxgrid .xq-idxrow");for(var i=0;i<rows.length;i++){if(!/[+-]?\d/.test(rows[i].textContent))return "EMPTY_"+i}return "OK"})()')
  [ "$R" = '"OK"' ] && pass "指数行有数字报价" || fail "有指数行无数据 ($R)"
  R=$(ev 'document.querySelectorAll(".xq-wgrid > *").length')
  [ "$R" -ge 1 ] 2>/dev/null && pass "自选网格有数据 ($R 项)" || fail "自选网格为空 ($R)"
fi
R=$(ev '(function(){var g=document.querySelector(".xq-badge-grip");if(!g)return "NO";var r=g.getBoundingClientRect();return (r.width<=20&&r.height<=20)?"OK":"SIZE_"+Math.round(r.width)+"x"+Math.round(r.height)})()')
[ "$R" = '"OK"' ] && pass "⤡ 手柄 16×16" || fail "手柄异常 ($R)"

# ---- 2. 拖拽（真实鼠标）----
echo "-- 徽章拖拽"
# 确定性起点：徽章遗留位置可能在视口边缘，让真实鼠标的拖拽/点击目标不可靠。
# 先 rpc 固定到中部安全区再刷新页面，后续每步的目标坐标就不再依赖上一轮遗留状态。
rpc '{"action":"ui.set","args":{"badgePos":{"x":420,"y":160},"badgeW":null}}' >/dev/null
agent-browser open "$PAGE_URL" >/dev/null 2>&1; sleep 8
C=$(ev '(function(){var b=document.querySelector(".xq-badge").getBoundingClientRect();return Math.round(b.left+b.width/2)+","+Math.round(b.top+b.height/2)})()' | tr -d '"')
X=${C%,*}; Y=${C#*,}
agent-browser mouse move "$X" "$Y" >/dev/null && agent-browser mouse down >/dev/null \
  && agent-browser mouse move $((X-100)) $((Y+80)) >/dev/null && agent-browser mouse move $((X-105)) $((Y+85)) >/dev/null \
  && agent-browser mouse up >/dev/null
sleep 3   # saveUi 800ms debounce + ui.set 往返
R=$(ev '(function(){var b=document.querySelector(".xq-badge");return b.style.left&&b.style.left!==""?"MOVED":"NOT"})()')
[ "$R" = '"MOVED"' ] && pass "拖拽位置样式生效" || fail "拖拽未生效 ($R)"
# 持久化断言（强）：拖拽把 badgePos 从预设 (420,160) 挪走——只查"是对象"会被 rpc 预设值骗过
P=$(rpc '{"action":"ui.get","args":{}}' | grep -o '"badgePos":{"x":[0-9-]*,"y":[0-9-]*}' | sed 's/[^0-9,-]//g')
PX=${P%,*}; PY=${P#*,}
if [ -n "$PX" ] && { [ "$PX" -ne 420 ] || [ "$PY" -ne 160 ]; } 2>/dev/null; then
  pass "位置已持久化并移出预设点 ($PX,$PY)"
else
  fail "位置未持久化/未移动 (host=$P 预设=420,160)"
fi

# ---- 3. ⤡ 调宽 + 双击复位 ----
echo "-- 手柄调宽/复位"
BASE_W=$(ev 'Math.round(document.querySelector(".xq-badge").getBoundingClientRect().width)' | tr -d '"')
C=$(ev '(function(){var g=document.querySelector(".xq-badge-grip").getBoundingClientRect();return Math.round(g.left+g.width/2)+","+Math.round(g.top+g.height/2)})()' | tr -d '"')
X=${C%,*}; Y=${C#*,}
agent-browser mouse move "$X" "$Y" >/dev/null && agent-browser mouse down >/dev/null \
  && agent-browser mouse move $((X+100)) "$Y" >/dev/null && agent-browser mouse move $((X+101)) "$Y" >/dev/null \
  && agent-browser mouse up >/dev/null
sleep 3
W=$(ev 'Math.round(document.querySelector(".xq-badge").getBoundingClientRect().width)' | tr -d '"')
BW=$(rpc '{"action":"ui.get","args":{}}' | grep -o '"badgeW":[0-9]*' | grep -o '[0-9]*$' || true)
[ -n "$BW" ] && [ "$W" -gt $((BASE_W+40)) ] 2>/dev/null && [ "$BW" -gt $((BASE_W+20)) ] 2>/dev/null \
  && pass "拖 ⤡ 变宽并持久化 (${BASE_W}→${W}, badgeW=${BW})" || fail "调宽异常 (基准 ${BASE_W} / 渲染 $W / 持久 $BW)"
# 双击复位：agent-browser dblclick 的两次点击间隔超出系统双击判定阈值，产生不了
# 真 dblclick DOM 事件（实测页面监听计数为 0）——改为直接派发 dblclick（React 合成监听同一路径）。
ev 'document.querySelector(".xq-badge-grip").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))' >/dev/null
sleep 2   # saveUi 是 800ms debounce，等落盘后再读
BW=$(rpc '{"action":"ui.get","args":{}}' | grep -o '"badgeW":[0-9]*' | grep -o '[0-9]*$' || true)
[ -z "${BW}" ] && pass "双击复位 → badgeW=null（回归：曾落盘为下限120）" || fail "复位后 badgeW=${BW}（null 复位仍被钳制！）"

# ---- 4. 面板开关 + 四 tab ----
echo "-- 面板与 tab"
agent-browser click ".xq-badge" >/dev/null 2>&1; sleep 3
# 首击可能早于徽章 hydrate（点击被吞）——面板没出现就再点一次
if ! ev '(document.querySelector(".xq-dock")?"1":"0")' | grep -q '"1"'; then
  agent-browser click ".xq-badge" >/dev/null 2>&1; sleep 4
fi
R=$(ev '(function(){var d=document.querySelector(".xq-dock");if(!d)return "NO_DOCK";return Array.prototype.map.call(document.querySelectorAll(".xq-tab"),function(x){return x.textContent}).join(",")})()')
[ "$R" = '"行情,热榜,搜索,快讯"' ] && pass "面板打开 + 四 tab 齐全" || fail "面板/tab 异常 ($R)"
# 热榜：切 tab 后数据来自最长 60s 的内容轮询，轮询等待而非 5s 定时断言；
# 上游拦截（WAF/凭据过期）直接探 RPC 错误码 —— 宿主侧正确分类，环境豁免
agent-browser eval '(function(){var t=document.querySelectorAll(".xq-tab");for(var i=0;i<t.length;i++)if(t[i].textContent==="热榜")t[i].click()})()' >/dev/null
if [ "$DATA_OK" = 1 ]; then
HOT_N=0
for i in $(seq 1 14); do
  sleep 5
  HOT_N=$(ev 'document.querySelectorAll(".xq-hot-row").length' | tr -d '"')
  [ "${HOT_N:-0}" -ge 1 ] 2>/dev/null && break
  HERR=$(rpc '{"action":"hot","args":{"market":"cn","size":10}}' | grep -o '\[[a-z_]*\]' | head -1)
  [ -n "$HERR" ] && break
done
if [ "${HOT_N:-0}" -ge 1 ] 2>/dev/null; then
  pass "热榜渲染数据 ($HOT_N 行)"
else
  HERR=$(rpc '{"action":"hot","args":{"market":"cn","size":10}}' | grep -o '\[[a-z_]*\]' | head -1)
  [ -n "$HERR" ] && skip "热榜上游不可用（$HERR）" || fail "热榜无数据 ($HOT_N)"
fi
fi
agent-browser eval '(function(){var t=document.querySelectorAll(".xq-tab");for(var i=0;i<t.length;i++)if(t[i].textContent==="快讯")t[i].click()})()' >/dev/null
if [ "$DATA_OK" = 1 ]; then
NEWS_N=0
for i in $(seq 1 8); do
  sleep 5
  NEWS_N=$(ev '(function(){var d=document.querySelector(".xq-dock");return (d.textContent.match(/小时|分钟|今天|昨天|\d{1,2}月/g)||[]).length})()' | tr -d '"')
  [ "${NEWS_N:-0}" -ge 1 ] 2>/dev/null && break
  NERR=$(rpc '{"action":"news","args":{"count":5}}' | grep -o '\[[a-z_]*\]' | head -1)
  [ -n "$NERR" ] && break
done
if [ "${NEWS_N:-0}" -ge 1 ] 2>/dev/null; then
  pass "快讯有时间线 ($NEWS_N 处)"
else
  NERR=$(rpc '{"action":"news","args":{"count":5}}' | grep -o '\[[a-z_]*\]' | head -1)
  [ -n "$NERR" ] && skip "快讯上游不可用（$NERR）" || fail "快讯无内容 ($NEWS_N)"
fi
fi
agent-browser eval '(function(){var t=document.querySelectorAll(".xq-tab");for(var i=0;i<t.length;i++)if(t[i].textContent==="搜索")t[i].click()})()' >/dev/null; sleep 3
R=$(ev '(function(){var d=document.querySelector(".xq-dock");return d&&d.querySelector("input")?"OK":"NO"})()')
[ "$R" = '"OK"' ] && pass "搜索 tab 有输入框" || fail "搜索输入框缺失 ($R)"
agent-browser click ".xq-badge" >/dev/null 2>&1; sleep 2
R=$(ev 'document.querySelector(".xq-dock")?"OPEN":"CLOSED"')
[ "$R" = '"CLOSED"' ] && pass "再点徽章关闭面板" || fail "面板未关闭 ($R)"

# ---- 5. 越屏恢复钳制 ----
echo "-- 越屏恢复钳制"
rpc '{"action":"ui.set","args":{"badgePos":{"x":99999,"y":99999}}}' >/dev/null
agent-browser open "$PAGE_URL" >/dev/null 2>&1; sleep 9
R=$(ev '(function(){var b=document.querySelector(".xq-badge");if(!b)return "NO_BADGE";var r=b.getBoundingClientRect();return (r.left>=0&&r.top>=0&&r.right<=window.innerWidth+1&&r.bottom<=window.innerHeight+1)?"IN_VIEW":"OUT_"+Math.round(r.left)+","+Math.round(r.top)})()')
[ "$R" = '"IN_VIEW"' ] && pass "越屏位置恢复时钳制回视口" || fail "徽章越屏 ($R)"
# 钳制落盘（v1.24.1 起钳制修正会持久化）：等 debounce 后 host 不应再存 99999
sleep 2
P=$(rpc '{"action":"ui.get","args":{}}' | grep -o '"badgePos":{"x":[0-9]*,"y":[0-9]*}')
echo "$P" | grep -q '"x":99999' && fail "越屏值残留 host（钳制未落盘: $P）" || pass "钳制已落盘，无 99999 残留 ($P)"

echo ""
if [ "$FAIL" = 0 ]; then
  [ "$SKIP" = 1 ] && echo "✅ 浏览器交互回归通过（含环境豁免项）" || echo "✅ 浏览器交互回归全部通过"
  exit 0
else
  echo "❌ 浏览器交互回归有失败项"; exit 1
fi
