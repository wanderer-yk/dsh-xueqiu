// qa/probe-seed.mjs — 播种链路手动探针（不进 CI；决策工具，不是断言）。
//
// 背景：2026-10-22 实测部分网络 IP 上两个种子 URL 均被 TencentEdgeOne 拦截
// （HTTP 5xx、完全不发 set-cookie），匿名链路冷启动死板。本工具用与 ensureCookie
// 相同的 curl 形态，对候选 URL × 两种头组合（裸 UA / 浏览器导航头）逐一探测，
// 输出状态码与 set-cookie 名单，供 seedUrls 扩容与 SEED_HDRS 效果评估——
// 一切以实测为准，勿凭猜测往播种链里加 URL。
//
// 用法:
//   node qa/probe-seed.mjs                      # 内置候选清单
//   node qa/probe-seed.mjs https://xueqiu.com/x # 自定义 URL
//   XQ_PROBE_HEADERS=1 node qa/probe-seed.mjs   # 只测硬化的头组合
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// UA 单一真源：从 dynamic/host.js 提取（与本插件真实请求完全一致，防测试漂移）
const hostSrc = readFileSync(new URL('../dynamic/host.js', import.meta.url), 'utf8')
const uaMatch = /const UA = '([^']+)'/.exec(hostSrc)
if (!uaMatch) { console.error('host.js 中未找到 UA 常量（锚点漂移）'); process.exit(1) }
const UA = uaMatch[1]

// 与 host.js ensureCookie 保持同形的头组合（硬化版）
const NAV_HEADERS = [
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest: document', 'Sec-Fetch-Mode: navigate', 'Sec-Fetch-Site: none', 'Sec-Fetch-User: ?1',
  'Upgrade-Insecure-Requests: 1',
]

const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://xueqiu.com/hq',
  'https://www.xueqiu.com/',
  'https://stock.xueqiu.com/',
  'https://xueqiu.com/about',
  'https://xueqiu.com/today',
]

const sets = process.env.XQ_PROBE_HEADERS === '1'
  ? [{ name: 'nav-headers', headers: NAV_HEADERS }]
  : [{ name: 'bare-ua', headers: [] }, { name: 'nav-headers', headers: NAV_HEADERS }]

function probe(url, headers) {
  const args = ['-s', '-L', '--compressed', '--max-time', '8', '-D', '-', '-o', '/dev/null',
    '-H', `User-Agent: ${UA}`, '-w', '\n__PROBE_STATUS__%{http_code}']
  for (const h of headers) args.push('-H', h)
  args.push(url)
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 12000 })
    const status = (/\n__PROBE_STATUS__(\d+)/.exec(out) || [])[1] || '?'
    const cookies = [...out.matchAll(/^set-cookie:\s*([^=;\s]+)=/gim)].map((m) => m[1])
    const unique = [...new Set(cookies)]
    return { status, cookies: unique }
  } catch (e) {
    return { status: 'ERR', cookies: [], error: String((e && e.message) || e).slice(0, 80) }
  }
}

console.log(`播种探针（UA 与 host.js 同源，${CANDIDATES.length} 个候选 URL × ${sets.length} 种头组合）\n`)
let anyToken = false
for (const url of CANDIDATES) {
  for (const set of sets) {
    const r = probe(url, set.headers)
    const hasToken = r.cookies.includes('xq_a_token')
    if (hasToken) anyToken = true
    const mark = hasToken ? '✅ 可播种' : (r.cookies.length ? '⚠️  有cookie无token' : '❌ 无cookie')
    console.log(`  ${mark}  [${r.status}] ${set.name.padEnd(11)} ${url}`)
    if (r.cookies.length) console.log(`           cookies: ${r.cookies.join(', ')}`)
    if (r.error) console.log(`           error:   ${r.error}`)
  }
  console.log('')
}
console.log(anyToken
  ? '结论：当前网络至少有一条可用播种路径（✅ 行）。若插件仍播种失败，检查 host.js seedUrls 是否包含该 URL。'
  : '结论：当前网络所有候选均拿不到 xq_a_token（边缘节点拦截或网络不可达）。匿名链路将走 seed_blocked 降级提示；可用浏览器登录粘贴 Cookie 解锁。')
