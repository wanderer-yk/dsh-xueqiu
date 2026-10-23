// qa/client-pure.mjs — client 纯逻辑层单测（P1-B）。运行: node qa/client-pure.mjs
// 从 dynamic/client.js 的 pure-helpers 标记区整段提取源码，new Function 求值直测。
// 背景：2200 行 client 曾零单测（历史复发 bug 全在 client 侧）；标记区提取对源码
// 格式不敏感（区别于 vol-units 按函数名花括号配对的旧法）。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  >> ' + String(detail).slice(0, 160) : '')) }
}

// ---- 提取标记区 ----
const src = readFileSync(new URL('../dynamic/client.js', import.meta.url), 'utf8')
const BEGIN = '// ---- qa-extract-begin: pure-helpers ----'
const END = '// ---- qa-extract-end: pure-helpers ----'
const b = src.indexOf(BEGIN), e = src.indexOf(END)
ok(b > 0 && e > b, 'pure-helpers 标记区存在')
const region = src.slice(b + BEGIN.length, e)
const NAMES = 'pad2,fmt,fmtPct,fmtBig,fmtVol,fmtTime,fmtDay,colorOf,upColor,viewport,pageHidden,sessionState,aSession,hkSession,usSession,sessionsText,sessionOpenFor,klcNormRows,klcPrecision,makeIndexPoll,makeUiStore'.split(',')
let api
try { api = new Function(region + '\nreturn {' + NAMES.join(',') + '}')() } catch (err) { ok(false, '标记区可求值', err); process.exit(1) }
ok(NAMES.every((n) => typeof api[n] === 'function'), '标记区导出全部 21 个函数')

console.log('== 格式化 ==')
ok(api.pad2(3) === '03' && api.pad2(12) === '12' && api.pad2(0) === '00', 'pad2 补零')
ok(api.fmt(null) === '--' && api.fmt(undefined) === '--' && api.fmt('') === '--', 'fmt 空值 → --')
ok(api.fmt('abc') === '--' && api.fmt(NaN) === '--', 'fmt 非数值 → --')
ok(api.fmt(1234.5678) === '1234.57' && api.fmt(1234.5678, 3) === '1234.568' && api.fmt(5, 0) === '5', 'fmt 精度（默认2/指定3/0）')
ok(api.fmtPct(1.234) === '+1.23%' && api.fmtPct(-0.5) === '-0.50%' && api.fmtPct(0) === '+0.00%', 'fmtPct 符号与精度')
ok(api.fmtPct(null) === '--', 'fmtPct 空值')
ok(api.fmtBig(1.5e8) === '1.50亿' && api.fmtBig(-12345) === '-1.23万' && api.fmtBig(999) === '999', 'fmtBig 亿/万/原值（负数走绝对值档位）')
ok(api.fmtVol(1000000, 'SH600519') === '1.00万手', 'fmtVol A股 ÷100 转手')
ok(api.fmtVol(1000000, '00700') === '100.00万股' && api.fmtVol(1000000, 'AAPL') === '100.00万股', 'fmtVol 港美股按股')
ok(api.fmtVol(550, 'SZ300750') === '6手', 'fmtVol A股零头四舍五入（5.5手→6手）')
ok(api.fmtVol(null, 'SH600519') === '--' && api.fmtVol('x', 'SH600519') === '--', 'fmtVol 空值/非法')
const TS = new Date(2026, 9, 22, 8, 5, 9).getTime()   // 本地时区构造，确定性
ok(api.fmtTime(TS) === '08:05:09', 'fmtTime 数字时间戳')
ok(api.fmtTime(String(TS)) === '08:05:09', 'fmtTime 字符串数字时间戳（NewsTab 兼容路径）')
ok(api.fmtTime('garbage') === '--:--:--', 'fmtTime 无效输入不产生 NaN:NaN:NaN')
ok(api.fmtTime(0) === '' && api.fmtTime(null) === '', 'fmtTime falsy 返回空串')
ok(api.fmtDay(new Date(2026, 9, 22, 23, 59).getTime()) === '2026-10-22', 'fmtDay 本地日期')
ok(api.fmtDay(0) === '', 'fmtDay falsy')
ok(api.colorOf(1) === 'xq-up' && api.colorOf(-1) === 'xq-down' && api.colorOf(0) === 'xq-flat' && api.colorOf(null) === 'xq-flat', 'colorOf 四态')
ok(api.upColor(true) !== api.upColor(false), 'upColor 两态')
ok(api.pageHidden() === false, 'pageHidden 无 document 环境返回 false（不抛）')
ok(api.viewport() === null, 'viewport 无 window 环境返回 null（不抛）')

console.log('== 交易时段（注入时钟，确定性）==')
// 2026-10-22 是周四；CST=UTC+8，用 UTC 构造本地钟点
const d = (h, m, day = 22) => new Date(Date.UTC(2026, 9, day, h - 8, m))
const ASEG = [[570, 690], [780, 900]], ALUNCH = [690, 780]
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(9, 30)) === '盘中', 'A股 9:30 盘中')
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(11, 30)) === '午休', 'A股 11:30 午休边界')
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(13, 0)) === '盘中', 'A股 13:00 午后开盘')
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(15, 0)) === '休市', 'A股 15:00 收盘')
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(9, 0)) === '盘前', 'A股 9:00 盘前')
ok(api.sessionState('Asia/Shanghai', ASEG, ALUNCH, d(10, 0, 24)) === '休市', '周六休市（2026-10-24）')
ok(api.sessionState('Bad/Zone', ASEG, ALUNCH, d(10, 0)) === '', '坏时区返回空串（不抛）')
ok(api.aSession(d(10, 0)) === '盘中' && api.aSession(d(12, 0)) === '午休', 'aSession 时间注入透传')
ok(api.sessionsText(d(10, 0)).includes('A股盘中'), 'sessionsText 组合文案')
// 2026-10-22 港股与 A 股同偏移（UTC+8）；美股尚在 EDT（UTC-4）
ok(api.hkSession(d(10, 0)) === '盘中', '港股 10:00 盘中')
ok(api.sessionOpenFor('SH600519', { current: true }) === true && api.sessionOpenFor('SH600519', { current: false }) === false, 'A股开市跟随 aOpenRef（真实 status）')
ok(api.sessionOpenFor('00700', null, d(10, 0)) === true, '港股代码退回时区推算（盘中）')
ok(api.sessionOpenFor('AAPL', null, d(22, 0)) === true, '美股代码退回时区推算（22:00 CST=10:00 EDT 盘中）')

console.log('== K线行归一化/精度 ==')
ok(api.klcNormRows([{ timestamp: 5, close: 1 }]).length === 1 && api.klcNormRows([{ timestamp: 5, close: 1 }])[0].timestamp === 5, '已有 timestamp 原样保留')
ok(api.klcNormRows([{ time: '2026-10-22T10:00:00', close: 2 }])[0].timestamp > 0, 'ISO time 补 timestamp')
ok(api.klcNormRows([{ time: 'garbage' }, { close: 1 }]).length === 0, '无有效时间行被过滤')
ok(api.klcPrecision([], 3) === 3 && api.klcPrecision([{ close: 1 }], 4) === 4, 'precision hint 优先')
ok(api.klcPrecision([{ close: 12.34567 }]) === 4, '末根小数位钳制上限 4')
ok(api.klcPrecision([{ close: '1234.5' }]) === 1 && api.klcPrecision([{ close: '1234' }]) === 2 && api.klcPrecision([]) === 2, 'precision 默认与推导')

console.log('== makeIndexPoll（依赖全注入）==')
{
  // T1: 首订阅拉取 / in-flight 去重 / 双订阅通知 / 晚到回放 / 末位退订清理
  const st = { calls: 0, resolve: null, ticks: [], visFns: [], stopped: 0, visOff: 0, clock: 1000, hidden: false }
  const subscribe = api.makeIndexPoll({
    call: () => { st.calls++; return new Promise((r) => { st.resolve = r }) },
    symbols: ['A'],
    interval: (fn) => { st.ticks.push(fn); return () => { st.stopped++ } },
    hidden: () => st.hidden,
    now: () => st.clock,
    listenVis: (fn) => { st.visFns.push(fn); return () => { st.visOff++ } },
  })
  const got = []
  const un1 = subscribe((list, status) => got.push(['a', list, status]))
  ok(st.calls === 1, '首订阅立即拉取')
  const un2 = subscribe(() => got.push(['b']))
  ok(st.calls === 1, '未决期间第二订阅共享 in-flight（去重）')
  st.resolve({ list: [1, 2], status: 5 })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ok(got.filter((x) => x[0] === 'a').length === 1 && got.filter((x) => x[0] === 'b').length === 1, '两订阅者均被通知（含 status）')
  ok(got[0][1].length === 2 && got[0][2] === 5, '通知载荷为 list+status')
  let replayed = 0
  const un3 = subscribe(() => replayed++)
  ok(replayed === 1, '晚到订阅者收到缓存回放')
  un1(); un2(); un3()
  ok(st.stopped === 1 && st.visOff === 1, '末位退订停表+摘除可见性监听')
  ok(st.ticks.length === 1, '定时器只建一次')
}
{
  // T2: tick 隐藏门 / vis 回前台过期刷新（5s 节流）
  const st = { calls: 0, resolve: null, tick: null, vis: null, clock: 1000, hidden: false }
  const subscribe = api.makeIndexPoll({
    call: () => { st.calls++; return new Promise((r) => { st.resolve = r }) },
    symbols: ['A'],
    interval: (fn) => { st.tick = fn; return () => {} },
    hidden: () => st.hidden,
    now: () => st.clock,
    listenVis: (fn) => { st.vis = fn; return () => {} },
  })
  const un = subscribe(() => {})
  st.resolve({ list: [], status: 5 }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  st.clock = 2000
  st.tick(); st.resolve({ list: [], status: 5 }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ok(st.calls === 2, '可见时 tick 正常拉取')
  st.hidden = true
  st.tick()
  ok(st.calls === 2, '页面隐藏时 tick 不拉取')
  st.hidden = false   // 回前台
  st.clock = 7001   // at=2000，间隔 >5s：回前台应刷新
  st.vis()
  ok(st.calls === 3, '回前台且数据过期(>5s)触发刷新')
  st.calls = 0; st.clock = 7200   // 数据刚刷新(at=7001)：5s 节流内不再拉
  st.vis()
  ok(st.calls === 0, '回前台 5s 节流内不重复拉取')
  un()
}
{
  // T3: 失败静默 + 下轮 tick 重试（in-flight 已清）
  const st = { calls: 0, tick: null }
  const subscribe = api.makeIndexPoll({
    call: () => { st.calls++; return Promise.reject(new Error('boom')) },
    symbols: ['A'],
    interval: (fn) => { st.tick = fn; return () => {} },
    hidden: () => false,
    now: () => 1000,
    listenVis: () => () => {},
  })
  const un = subscribe(() => {})
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  ok(st.calls === 1, '失败静默（不抛未捕获异常）')
  st.tick()
  ok(st.calls === 2, '失败后 inflight 已清，下轮 tick 重试')
  un()
}

console.log('== makeUiStore ==')
{
  let persists = 0
  const ui = api.makeUiStore(() => persists++)
  let notified = 0
  const un = ui.subscribe(() => notified++)
  ui.set({ tab: 'hot' })
  ok(ui.tab === 'hot' && notified === 1, 'set 更新并通知')
  ok(ui.tabTouched === true && ui.openTouched === undefined, 'tab 触碰标记（open 未触碰）')
  ui.set({ tab: 'hot' })
  ok(notified === 1 && persists === 0, '同值 set 不通知不落盘')
  ui.set({ open: true })
  ok(persists === 1, 'open 翻转即时 persist（v1.22.11 修复的语义保持）')
  ui.set({ badgePos: { x: 1, y: 2 } })
  ok(persists === 1, '非 open 变更不即时 persist（防抖归调用方）')
  const notifiedBeforeUn = notified
  un()
  ui.set({ open: false })
  ok(notified === notifiedBeforeUn, '退订后不再通知')
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ` client-pure: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
