// 离线单测：mock shell，不发真实网络请求。运行: node qa/unit.mjs
import { loadPlugin, makeCtx, pluginApi } from './mock-ctx.js'

let pass = 0, fail = 0
function ok(cond, name) { if (cond) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }
// RPC 层把业务错误包成 {ok:false,error} 而非抛异常——两种都算"拒绝"
async function rejects(fn, re, name) {
  let r
  try { r = await fn() } catch (e) { ok(re.test(e.message), name + ' [' + e.message.slice(0, 60) + ']'); return }
  if (r && r.ok === false) { ok(re.test(r.error || ''), name + ' [' + String(r.error || '').slice(0, 60) + ']') }
  else { fail++; console.log('  ❌ ' + name + ' (未拒绝)') }
}

// ---- 可脚本化 shell：按 URL 前缀返回响应，记录请求 ----
function scriptShell(scripts) {
  const calls = []
  return {
    calls,
    resolve: (s) => s,
    // 对齐真实 DSH v24.16：只有 execute（句柄+result），生产必经分支在全部断言下覆盖；
    // 旧 run 兼容分支由本文件内联的 shell2/hungShell（仍用 run）覆盖
    execute: async (spec) => {
      const url = (spec.command.match(/'(https:[^']+)'/) || [])[1] || spec.command
      calls.push({ url, at: Date.now(), cmd: spec.command, stdin: spec.stdin })
      const hit = scripts.find((s) => url.includes(s.match))
      const out = !hit
        ? { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }  // 空响应
        : hit.throws
          ? { exitCode: 1, stdout: { text: '' }, stderr: { text: 'boom' } }
          : { exitCode: 0, stdout: { text: typeof hit.body === 'function' ? hit.body(url, calls.length) : hit.body }, stderr: { text: '' } }
      return { result: async () => out }
    },
  }
}
const WLSJ = (syms) => JSON.stringify({ symbols: syms, lastSyncAt: 0 })
const quoteBody = (sym, cur) => JSON.stringify({ error_code: 0, data: { items: [{ market: { status_id: 1 }, quote: { symbol: sym, name: 'T', current: cur, percent: 1 } }] } })

async function fresh(scripts, files) {
  const plugin = loadPlugin()
  const shell = scripts ? scriptShell(scripts) : undefined
  const ctx = makeCtx({ shell, files })
  const call = await pluginApi(plugin, ctx)
  return { call, shell, ctx }
}

console.log('== U1 调度与缓存 ==')
{
  // TTL 缓存命中：同一 URL 第二次不发请求
  const { call, shell } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 100) }])
  await call('quote', { symbols: 'SH600519' })
  await call('quote', { symbols: 'SH600519' })
  ok(shell.calls.filter((c) => c.url.includes('batch/quote')).length === 1, 'TTL 缓存内第二次命中缓存(仅1次上游请求)')
}
{
  // TTL 过期：伪造时间不好做——用 ttl=0 的接口重复调用验证无缓存路径 + inflight 去重
  const { call, shell } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 1) }])
  await Promise.all([call('quote', { symbols: 'SH600519' }), call('quote', { symbols: 'SH600519' })])
  ok(shell.calls.filter((c) => c.url.includes('batch/quote')).length === 1, '并发同 URL in-flight 去重(1次数据请求, 总请求=' + shell.calls.length + ')')
}
{
  // 请求最小间隔 100ms：并发 3 个不同 URL，任两次实际启动间隔 >= ~90ms
  const { call, shell } = await fresh([
    { match: 'symbol=SH600519', body: quoteBody('SH600519', 1) },
    { match: 'symbol=SZ000001', body: quoteBody('SZ000001', 2) },
    { match: 'symbol=SH601318', body: quoteBody('SH601318', 3) },
  ])
  await Promise.all([
    call('quoteDetail', { symbol: 'SH600519' }), call('quoteDetail', { symbol: 'SZ000001' }), call('quoteDetail', { symbol: 'SH601318' }),
  ])
  // 只统计被 gate 节流的数据请求（cookie 种子的 2 次 curl 不走 gate，属预期并发）
  const gated = shell.calls.filter((c) => c.url.includes('symbol='))
  const gaps = gated.map((c, i) => (i === 0 ? 999 : c.at - gated[i - 1].at))
  // 允许并发 2 造成的成对突发(<90ms)，但连续突发不得超过 2 个
  let burst = 1, bad = false
  for (let i = 1; i < gaps.length; i++) { if (gaps[i] < 90) { if (++burst > 2) bad = true } else burst = 1 }
  ok(!bad, '最小间隔节流生效(突发≤2) (gaps=' + gaps.join(',') + ')')
}
{
  // cache stampede 冒烟：TTL 接口(quoteDetail 15s)并发 5 个不同 URL miss + 同 URL 重复 3 次
  // 期望：每个不同 URL 恰好 1 次上游请求（miss 时不重复回源），同 URL 全部命中 in-flight 共享
  const syms = ['SH600519', 'SZ000001', 'SH601318', 'AAPL', '00700']
  const { call, shell } = await fresh(syms.map((s) => ({ match: 'symbol=' + s, body: quoteBody(s, 1) })))
  const tasks = []
  for (const s of syms) for (let i = 0; i < 3; i++) tasks.push(call('quoteDetail', { symbol: s }))
  const rs = await Promise.all(tasks)
  ok(rs.every((r) => r.ok), '并发 15 个请求（5 URL × 3）全部成功')
  const dataCalls = shell.calls.filter((c) => syms.some((s) => c.url.includes('symbol=' + s)))
  ok(dataCalls.length === 5, '每个 URL miss 仅回源 1 次，无 stampede (上游请求=' + dataCalls.length + ')')
}
{
  // 重试链：network 失败一次后成功
  let n = 0
  const { call } = await fresh([{ match: 'batch/quote', body: () => (n++ === 0 ? null : quoteBody('SH600519', 5)) }])
  const r = await call('quote', { symbols: 'SH600519' })
  ok(r.ok && r.data.list[0].current === 5, 'network 错误重试一次后成功')
}
{
  // 重试链：纯垃圾文本（非 HTML）报 [parse] 且不重试
  const { call, shell } = await fresh([{ match: 'batch/quote', body: 'not json at all' }])
  const r = await call('quote', { symbols: 'SH600519' })
  ok(!r.ok && /parse/.test(r.error), '非 JSON 非 HTML 响应报 [parse] 且不重试 (请求次数=' + shell.calls.length + ')')
}
{
  // waf 自愈：HTML 挑战页 → 重新播种 cookie 后重试成功（v1.22.16 行为变更，原为 [parse] 不重试）
  let n = 0
  const { call, shell } = await fresh([{ match: 'batch/quote', body: () => (n++ === 0 ? '<!DOCTYPE html><html><head>acw_sc</head></html>' : quoteBody('SH600519', 9)) }])
  const r = await call('quote', { symbols: 'SH600519' })
  ok(r.ok && r.data.list[0].current === 9, 'WAF 挑战页自动重播种并重试成功')
  ok(shell.calls.filter((c) => (c.cmd || '').includes('xueqiu.com/hq')).length >= 1, 'WAF 触发了 cookie 重播种')
}
{
  // cookie 不进 argv：登录态请求的命令行不含 cookie 值，且使用 -H @- + spec.stdin
  const { call, shell } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 1) }], { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=SECRET_TOKEN_9f; u=42' }) })
  await call('watchlist.get', {})   // 触发 loadLogin 就绪（actQuote 不主动加载登录态）
  await call('quote', { symbols: 'SH600519' })
  const dataCmds = shell.calls.filter((c) => c.url.includes('batch/quote'))
  ok(dataCmds.every((c) => !c.cmd.includes('SECRET_TOKEN_9f')), '登录 cookie 不出现在命令行（防 ps 泄漏）')
  ok(dataCmds.every((c) => c.cmd.includes('-H @-')), 'cookie 经 stdin 注入（-H @-）')
}
{
  // watchlist 200 上限：超限时 add 报错不再静默截断
  const many = []
  for (let i = 0; i < 200; i++) many.push('SH60' + String(100000 + i))
  const { call } = await fresh(undefined, { '.xueqiu-watchlist.json': JSON.stringify({ symbols: many }) })
  const r = await call('watchlist.add', { symbol: 'SH600519' })
  ok(!r.ok && /上限/.test(r.error), 'watchlist 200 上限前置拦截')
}
{
  // .bak 回退：主状态文件损坏（半截 JSON）时读 .bak 恢复
  const { call } = await fresh(undefined, {
    '.xueqiu-watchlist.json': '{"symbols":["SH6005",',
    '.xueqiu-watchlist.json.bak': '{"symbols":["SH600519"]}',
  })
  const r = await call('watchlist.get', {})
  ok(r.ok && r.data.symbols[0] === 'SH600519', '主文件半截损坏时回退 .bak（不回退默认列表）')
}
{
  // 身份切换缓存失效三连之 loadLogin 首载：匿名缓存不得跨身份复用
  const { call, shell } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 3) }], { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=FIRST_LOAD' }) })
  await call('quote', { symbols: 'SH600519' })   // 匿名期进缓存（login 未加载）
  await call('watchlist.get', {})                // 触发 loadLogin 首载（null→登录态，应 cache.clear）
  await call('quote', { symbols: 'SH600519' })   // 应重新打上游
  const ups = shell.calls.filter((c) => c.url.includes('batch/quote')).length
  ok(ups === 2, 'loadLogin 首载清缓存（quote 上游=' + ups + '，期望 2）')
}
{
  // 身份切换缓存失效三连之 logout：注销后缓存同样失效
  const { call, shell } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 4) }], { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=BEFORE_OUT' }) })
  await call('watchlist.get', {})
  await call('quote', { symbols: 'SH600519' })
  const r = await call('login.logout', {})
  ok(r.ok && r.data.loggedIn === false, 'login.logout 成功返回')
  await call('quote', { symbols: 'SH600519' })
  const ups = shell.calls.filter((c) => c.url.includes('batch/quote')).length
  ok(ups === 2, 'logout 清缓存（quote 上游=' + ups + '，期望 2）')
}
{
  // login.save 成功全链路：校验通过 → 登录态生效 + .bak 伴生文件生成 + 缓存失效
  const { call, shell, ctx } = await fresh([
    { match: 'portfolio/list', body: '{"data":{"portfolios":[{"pid":-1,"name":"全部"}]}}' },
    { match: 'batch/quote', body: quoteBody('SH600519', 5) },
  ])
  const cookie = 'Cookie: xq_a_token=NEWLOGIN; u=4242'
  const r = await call('login.save', { cookie })
  ok(r.ok && r.data.loggedIn === true, 'login.save 校验通过并生效')
  ok(ctx.__files['.xueqiu-login.json'] && ctx.__files['.xueqiu-login.json'].includes('NEWLOGIN'), '登录文件写入')
  ok(ctx.__files['.xueqiu-login.json.bak'] && ctx.__files['.xueqiu-login.json.bak'].includes('NEWLOGIN'), '登录 .bak 伴生文件生成（saveLogin 走 stateWrite）')
  const cmds = shell.calls.filter((c) => c.url.includes('portfolio/list'))
  ok(cmds.every((c) => !c.cmd.includes('NEWLOGIN') && (c.stdin || '').includes('Cookie: xq_a_token=NEWLOGIN')), '校验请求 cookie 走 stdin 且不进 argv')
}
{
  // waf 与登录态并存：带登录态遇 WAF 直接抛错不重播种（不白打播种 curl）
  const { call, shell } = await fresh([{ match: 'batch/quote', body: '<!DOCTYPE html><html>acw</html>' }], { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=UNDER_WAF' }) })
  await call('watchlist.get', {})
  const seedsBefore = shell.calls.filter((c) => /xueqiu\.com\/hq|www\.xueqiu\.com\/$/.test(c.url)).length   // watchlist.get 的云端同步可能自带播种（empty 链），以此为基线
  const r = await call('quote', { symbols: 'SH600519' })
  ok(!r.ok && /\[waf\]/.test(r.error), '登录态遇 WAF 报 [waf] 错误')
  const seedsAfter = shell.calls.filter((c) => /xueqiu\.com\/hq|www\.xueqiu\.com\/$/.test(c.url)).length
  ok(seedsAfter === seedsBefore, '登录态 WAF 不触发播种（增量=' + (seedsAfter - seedsBefore) + '，期望 0）')
}
{
  // 登录凭证权限收紧：saveLogin 落盘后发出 chmod 600（有 shell 且 fs 提供 processPath 时）
  const { call, shell } = await fresh([
    { match: 'portfolio/list', body: '{"data":{"portfolios":[{"pid":-1}]}}' },
  ])
  await call('login.save', { cookie: 'Cookie: xq_a_token=CHMODME; u=1' })
  const chmods = shell.calls.filter((c) => /chmod 600/.test(c.cmd))
  ok(chmods.length >= 1, '登录文件写入后发出 chmod 600（calls=' + chmods.length + '）')
  ok(chmods.every((c) => c.cmd.includes('.xueqiu-login.json')), 'chmod 目标是登录文件')
}
{
  // actQuote 截断提示：超量符号返回 truncated 计数字段
  const syms = []
  for (let i = 0; i < 55; i++) syms.push('SH6000' + (100 + i))
  const { call } = await fresh([{ match: 'batch/quote', body: quoteBody('SH6000100', 1) }])
  const r = await call('quote', { symbols: syms })
  ok(r.ok && r.data.truncated === 5, 'actQuote 超量 55→50 返回 truncated=5')
}
{
  // actKline 空 symbol（纯非法字符剥除后为空）：立即空结果，不发上游请求
  const { call, shell } = await fresh([{ match: 'kline', body: '{"data":{}}' }])
  const r = await call('kline', { symbol: '!!!', period: 'day' })
  ok(r.ok && Array.isArray(r.data.rows) && r.data.rows.length === 0, 'kline 空 symbol 返回结构化空结果')
  ok(shell.calls.filter((c) => (c.url || '').includes('kline.json')).length === 0, '空 symbol 不发起上游 kline 请求')
}
{
  // cookie_expired 降级：登录态 400016 → 匿名重试（先 watchlist.get 触发 loadLogin——
  // 直接 quote 不会加载登录文件，旧测试的"登录态"实为匿名路径）
  let n = 0
  const { call } = await fresh([{ match: 'batch/quote', body: () => (n++ === 0 ? '{"error_code":400016,"error_description":"Cookie 失效"}' : quoteBody('SH600519', 7)) }], { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=bad' }) })
  await call('watchlist.get', {})   // 触发 loadLogin（portfolio mock 默认空响应 → 空云列表，不镜像）
  const r = await call('quote', { symbols: 'SH600519' })
  ok(r.ok && r.data.list[0].current === 7, 'cookie_expired 自动重试成功')
}
{
  // seed_blocked 短路（P0-A）：匿名 + 播种失败（种子 URL 空响应）+ 400016 →
  // 不再空转重试 2 轮（旧行为共打 3 次上游），首轮即转译为可操作的 seed_blocked
  const { call, shell } = await fresh([{ match: 'batch/quote', body: () => '{"error_code":400016,"error_description":"Cookie 失效"}' }])
  const r = await call('quote', { symbols: 'SH600519' })
  ok(!r.ok && /seed_blocked|匿名 Cookie 获取失败/.test(r.error), 'seed_blocked 快速失败且文案含登录引导 [' + String(r.error || '').slice(0, 50) + ']')
  ok(shell.calls.filter((c) => c.url.includes('batch/quote')).length === 1, 'seed_blocked 不空转重试（上游=1，旧行为 3）')
}
{
  // rate_limited 退避后成功
  let n = 0
  const { call } = await fresh([{ match: 'batch/quote', body: () => (n++ === 0 ? '{"error_code":400017,"error_description":"请求过于频繁"}' : quoteBody('SH600519', 8)) }])
  const t0 = Date.now()
  const r = await call('quote', { symbols: 'SH600519' })
  ok(r.ok && Date.now() - t0 >= 1900, 'rate_limited 指数退避 >=2s 后重试成功')
}

console.log('== U2 watchlist 语义 ==')
{
  const { call, ctx } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 1) }])
  const r = await call('watchlist.get')
  ok(JSON.stringify(r.data.symbols) === JSON.stringify(['SH600519', 'SZ300750', 'SZ002594', 'SH601318', '00700', 'AAPL']), '无文件时返回默认列表')
  await call('watchlist.add', { symbol: 'TSLA' })
  ok(ctx.__files['.xueqiu-watchlist.json'].includes('TSLA'), 'add 持久化到文件')
  await call('watchlist.remove', { symbol: 'TSLA' })
  ok(!ctx.__files['.xueqiu-watchlist.json'].includes('TSLA'), 'remove 从文件移除')
  // add 幂等
  await call('watchlist.add', { symbol: 'TSLA' }); await call('watchlist.add', { symbol: 'TSLA' })
  const wl = JSON.parse(ctx.__files['.xueqiu-watchlist.json'])
  ok(wl.symbols.filter((s) => s === 'TSLA').length === 1, 'add 幂等(无重复)')
  // remove 不存在的 no-op
  const r2 = await call('watchlist.remove', { symbol: 'NOPE123' })
  ok(r2.ok && r2.data.symbols.length === wl.symbols.length, 'remove 不存在代码为 no-op')
}
{
  // 无效代码 add
  const { call } = await fresh([{ match: 'batch/quote', body: quoteBody('X', 1) }])
  await rejects(() => call('watchlist.add', { symbol: 'SH600519; rm -rf' }), /无效代码/, 'add 拒绝非法字符(命令注入防护)')
  await rejects(() => call('watchlist.add', { symbol: "x'x" }), /无效代码/, 'add 拒绝单引号')
}

console.log('== U3 云端同步 (mock) ==')
const PLSJ = (syms) => JSON.stringify({ error_code: 0, data: { stocks: [{ name: '全部', id: -1, pid: -1 }] } })
const STKSJ = (syms) => JSON.stringify({ error_code: 0, data: { stocks: syms.map((s) => ({ stock_symbol: s })) } })
{
  // 未登录: get 不触发任何云端请求
  const { call, shell } = await fresh([{ match: 'portfolio', body: PLSJ() }])
  await call('watchlist.get')
  ok(shell.calls.filter((c) => c.url.includes('portfolio')).length === 0, '未登录不触发云端同步')
}
{
  // 已登录 + 节流窗口内：不重复同步
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; u=1' }), '.xueqiu-watchlist.json': JSON.stringify({ symbols: ['SH600519'], lastSyncAt: Date.now() }) }
  const { call, shell } = await fresh([{ match: 'portfolio', body: PLSJ() }], files)
  await call('watchlist.get')
  ok(shell.calls.filter((c) => c.url.includes('portfolio')).length === 0, '节流窗口内(10min)不同步')
}
{
  // 云端为准镜像：云端顺序变化 → 本地被镜像
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; u=1' }), '.xueqiu-watchlist.json': WLSJ(['SH600519']) }
  const { call, shell, ctx } = await fresh([
    { match: 'portfolio/list', body: PLSJ() },
    { match: 'portfolio/stock/list', body: STKSJ(['SZ000001', 'SH600519']) },
  ], files)
  const r = await call('watchlist.get')
  ok(JSON.stringify(r.data.symbols) === JSON.stringify(['SZ000001', 'SH600519']), '云端顺序变化被镜像(云端为准)')
  const saved = JSON.parse(ctx.__files['.xueqiu-watchlist.json'])
  ok(saved.lastSyncAt > 0, '同步后 lastSyncAt 持久化')
}
{
  // 空云端结果不镜像清空
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; u=1' }), '.xueqiu-watchlist.json': WLSJ(['SH600519']) }
  const { call } = await fresh([
    { match: 'portfolio/list', body: PLSJ() },
    { match: 'portfolio/stock/list', body: STKSJ([]) },
  ], files)
  const r = await call('watchlist.get')
  ok(JSON.stringify(r.data.symbols) === JSON.stringify(['SH600519']), '云端空结果不清空本地(防误删)')
}
{
  // 云端拉取抛错 → 静默，get 仍返回本地
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; u=1' }), '.xueqiu-watchlist.json': WLSJ(['SH600519']) }
  const { call } = await fresh([{ match: 'portfolio', throws: true }], files)
  const r = await call('watchlist.get')
  ok(r.ok && r.data.symbols.length === 1, '同步失败静默(不影响 get)')
}
{
  // 手动 pull：未登录明确报错
  const { call } = await fresh([])
  await rejects(() => call('watchlist.pull'), /未登录/, 'pull 未登录报错')
}
{
  // 手动 pull 去重（P2）：同步成功且已拿到云端列表时不再二次拉取（旧实现无条件重拉 2 个请求）
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; u=1' }), '.xueqiu-watchlist.json': WLSJ(['SH600519']) }
  const { call, shell } = await fresh([
    { match: 'portfolio/list', body: PLSJ() },
    { match: 'portfolio/stock/list', body: STKSJ(['SH600519']) },
  ], files)
  const r = await call('watchlist.pull')
  ok(r.ok && r.data.symbols.length === 1, 'pull 成功返回镜像列表')
  const pfCalls = shell.calls.filter((c) => c.url.includes('portfolio'))
  ok(pfCalls.length === 2, 'pull 单轮同步只打 2 个 portfolio 请求（list+stock/list，无重复） [' + pfCalls.length + ']')
}

console.log('== U4 登录校验 ==')
{
  const { call } = await fresh([])
  await rejects(() => call('login.save', { cookie: 'foo=bar' }), /xq_a_token/, '缺 xq_a_token 拒绝')
  await rejects(() => call('login.save', { cookie: 'Cookie: xq_a_token=abc' }), /无法访问雪球|校验/, '无网络(mock)时校验失败报错')
  const st = await call('login.status')
  ok(st.ok && st.data.loggedIn === false, '未登录 status=false')
}
{
  // JWT 过期检测：构造过期 token
  const mk = (payload) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return b({ alg: 'none' }) + '.' + b(payload) + '.' }
  const files = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; xq_id_token=' + mk({ uid: 42, cn: '测试', exp: Math.floor(Date.now() / 1000) - 100 }) }) }
  const { call } = await fresh([], files)
  const st = await call('login.status')
  ok(st.data.expired === true && st.data.loggedIn === false, 'JWT 过期被识别')
  const files2 = { '.xueqiu-login.json': JSON.stringify({ cookie: 'xq_a_token=t; xq_id_token=' + mk({ uid: 42, cn: '测试', exp: Math.floor(Date.now() / 1000) + 9999 }) }) }
  const c2 = await (async () => { const p = loadPlugin(); const cx = makeCtx({ files: files2 }); return pluginApi(p, cx) })()
  const st2 = await c2('login.status')
  // 排障防错位（v1.21.5）：status 必须暴露真实文件路径，避免"插件写 A、排查查 B"
  ok(typeof st2.data.path === 'string' && st2.data.path.includes('.xueqiu-login.json'), 'status 暴露登录文件真实路径 (' + st2.data.path + ')')
  // F1 已修复: 登录文件缺 uid/screen_name 字段时回退到 jwt 解码值
  ok(st2.data.loggedIn === true && st2.data.screenName === '测试' && st2.data.uid === 42, 'JWT 有效: 中文昵称解码 + uid 回退')
}

console.log('== U5 UI 状态 ==')
{
  const { call, ctx } = await fresh([])
  await call('ui.set', { dockH: 9999, badgeW: 5 })
  const r = await call('ui.get')
  ok(r.data.dockH === 1200 && r.data.badgeW === 120, 'dockH/badgeW 钳制到边界')
  await call('ui.set', { dockH: null, badgeW: null })
  const r2 = await call('ui.get')
  ok(r2.data.dockH === null && r2.data.badgeW === null, 'null 显式复位(不落入下限)')
  await call('ui.set', { badgePos: { x: 10, y: 20 } })
  ok(JSON.stringify((await call('ui.get')).data.badgePos) === JSON.stringify({ x: 10, y: 20 }), 'badgePos 持久化')
}

console.log('== U7 缓存淘汰（F4）==')
{
  // 容量上限：塞入超过 200 个不同 URL 的请求，debug 报告的 cacheKeys 应被钳在 200
  const scripts = []
  for (let i = 0; i < 230; i++) scripts.push({ match: 'sym' + i + '&', body: quoteBody('X' + i, i) })
  scripts.push({ match: 'symbol=', body: () => quoteBody('X' + (scripts.n = (scripts.n || 0)), 1) })
  const plugin = loadPlugin()
  const shell = scriptShell(scripts.map((s) => ({ ...s, match: 'batch/quote' })))
  // 不同 symbol 集合产生不同 URL key
  const shell2 = { resolve: (s) => s, run: async (spec) => {
    const url = (spec.command.match(/'(https:[^']+)'/) || [])[1] || ''
    const m = url.match(/symbol=([A-Za-z0-9_,]+)/)
    const syms = m ? m[1] : ''
    const n = syms.split(',').reduce((a, c) => a + c.charCodeAt(0), 0)
    return { exitCode: 0, stdout: { text: quoteBody(syms.split(',')[0], n) }, stderr: { text: '' } }
  } }
  const ctx = makeCtx({ shell: shell2 })
  const call = await pluginApi(plugin, ctx)
  for (let i = 0; i < 230; i++) {
    const sym = 'SH6005' + String(i).padStart(3, '0')
    await call('quote', { symbols: sym })
  }
  const dbg = await call('debug')
  ok(dbg.data.cacheKeys <= 200, '缓存条目被钳在 200 以内 (' + dbg.data.cacheKeys + ')')
  // 条目仍可用：第一个请求的缓存已可能被淘汰，但最后一个必然在
  const r = await call('quote', { symbols: 'SH6005' + String(229).padStart(3, '0') })
  ok(r.ok, '淘汰后正常请求不受影响')
}

console.log('== U8 看门狗超时路径 ==')
{
  // curl 挂起 31s+：shell.run 永不返回，看门狗 30s 强制释放并报错。
  // 用未决 Promise 模拟挂起；整体等待上限 35s。
  const hungShell = { resolve: (s) => s, run: () => new Promise(() => {}) }
  const plugin = loadPlugin()
  const ctx = makeCtx({ shell: hungShell })
  const call = await pluginApi(plugin, ctx)
  const t0 = Date.now()
  const r = await Promise.race([
    call('quote', { symbols: 'SH600519' }),
    new Promise((res) => setTimeout(() => res({ ok: false, error: 'TEST_TIMEOUT_35S' }), 35000)),
  ])
  const dt = Date.now() - t0
  ok(!r.ok && /timeout|请求超时/.test(r.error) && dt >= 28000 && dt < 34000, '看门狗 30s 超时强制释放 (' + dt + 'ms, ' + (r.error || '').slice(0, 40) + ')')
  // 槽位释放后管线不冻结：再发一个能成功的请求
  const okShell = scriptShell([{ match: 'batch/quote', body: quoteBody('SH600519', 42) }])
  // 换不了 shell（闭包捕获）——用 debug 验证 waiters 归零即可
  const dbg = await call('debug')
  ok(dbg.ok && dbg.data.running === 0, '超时后调度槽已释放 (running=' + dbg.data.running + ')')
}

console.log('== U6 RPC 分发与安全 ==')
{
  const { call } = await fresh([{ match: 'batch/quote', body: quoteBody('SH600519', 1) }])
  const r = await call('nonsense', {})
  ok(!r.ok && /未知操作/.test(r.error), '未知 action 返回结构化错误')
  const proto = await call('constructor', { foo: 1 })
  ok(!proto.ok && /未知操作/.test(proto.error), '原型键(constructor)不绕过 dispatch 白名单')
  const ts = await call('toString', {})
  ok(!ts.ok && /未知操作/.test(ts.error), '原型键(toString)不绕过 dispatch 白名单')
  // quote 过滤非法 symbol
  const r2 = await call('quote', { symbols: 'SH600519,evil$code,00700' })
  ok(r2.ok, 'quote 混入非法代码不崩')
}
{
  // sanitize: undefined → null（JSON 序列化安全）
  const { call } = await fresh([{ match: 'batch/quote', body: JSON.stringify({ data: { items: [{ market: { status_id: 1 }, quote: { symbol: 'X' } }] } }) }])
  const r = await call('quote', { symbols: 'X' })
  ok(JSON.stringify(r.data.list[0]).includes('"current":null'), 'sanitize 把 undefined 转为 null')
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ` 单测: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
