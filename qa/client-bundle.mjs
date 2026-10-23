// qa/client-bundle.mjs — 静态 bundle 加载 + 传输接缝路由单测（P1-A 回归锚点）。运行: node qa/client-bundle.mjs
// 两层：
//  1. 生成物端到端：src/client/index.js（gen-static 产物）在伪浏览器环境求值 + apply 全程，
//     防动态/静态漂移与 const 重排的 TDZ（v1.7.0"静态装即崩"教训的零浏览器版防线）。
//  2. 传输接缝路由：从 dynamic/client.js 提取 call()，验证三种全局环境下走对分支——
//     含"host 是普通函数必须走静态分支"的守卫回归（typeof host.call 对任何函数都为真，
//     曾可被全局同名函数误入动态分支）。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  >> ' + String(detail).slice(0, 160) : '')) }
}

const BUNDLE = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
const React = { createElement: (...a) => ({ a }), useRef: () => ({ current: null }), useState: () => [null, () => {}], useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f }

function makeBrowserEnv() {
  const appended = []
  globalThis.window = {
    navigator: { userAgent: 'qa-runner' },
    matchMedia: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
    __ModuleLoader__: { load: (m) => { globalThis.window.__loaded = m } },
  }
  globalThis.document = {
    head: { appendChild: (n) => appended.push(n) },
    createElement: () => ({ setAttribute: () => {}, textContent: '', style: {} }),
    addEventListener: () => {}, removeEventListener: () => {},
    documentElement: { clientWidth: 800, clientHeight: 600 },
    hidden: true,
  }
  globalThis.slots = { inject: (_n, fn) => fn(), register: () => () => {} }
  return appended
}
function applyBundle() {
  eval(BUNDLE)   // eslint-disable-line no-eval -- 测试桩：求值生成物本体
  const loaded = globalThis.window.__loaded
  if (!loaded || loaded.id !== 'dsh-xueqiu') throw new Error('bundle 未注册到 __ModuleLoader__')
  const mod = loaded.factory((id) => { if (id === 'react') return React; throw new Error('unexpected require: ' + id) })
  const plugin = mod.default || mod
  const ctx = { interval: () => () => {}, debounce: (f) => f, effect: (f) => { f(); return () => {} }, get: () => ({ inject: () => {}, register: () => () => {} }) }
  plugin.apply(ctx)
  return plugin
}

console.log('== 生成物加载（静态环境：无 host / 无 styles）==')
{
  const appended = makeBrowserEnv()
  delete globalThis.styles
  let plugin = null
  try { plugin = applyBundle() } catch (e) { ok(false, 'bundle 求值 + apply 无异常', e.message) }
  ok(!!plugin && Array.isArray(plugin.inject) && typeof plugin.apply === 'function', '插件形态完整（inject/apply）')
  ok(appended.some((n) => String(n.textContent || '').includes('.xq-badge')), '无 styles 服务时回退自管 <style> 标签（含面板样式）')
}
{
  // styles 服务存在（动态环境语义）→ 接缝优先用宿主服务，不再自建标签
  const appended = makeBrowserEnv()
  const got = []
  globalThis.styles = { insert: (css) => got.push(css) }
  try { applyBundle() } catch (e) { ok(false, 'styles 服务存在时 apply 无异常', e.message) }
  ok(got.length === 1 && String(got[0]).includes('.xq-badge'), '有 styles 服务时走宿主 styles.insert')
  ok(appended.length === 0, 'styles 服务存在时不自建 <style> 标签')
  delete globalThis.styles
}

console.log('== 传输接缝路由（提取 call()，三环境）==')
{
  const src = readFileSync(new URL('../dynamic/client.js', import.meta.url), 'utf8')
  const BEGIN = '// ---- qa-extract-begin: transport-call ----'
  const END = '// ---- qa-extract-end: transport-call ----'
  const b = src.indexOf(BEGIN), e = src.indexOf(END)
  ok(b > 0 && e > b, 'transport-call 标记区存在')
  const call = new Function(src.slice(b + BEGIN.length, e) + '\nreturn call')()

  // a. 动态门面对象 → host.call 分支
  const dynCalls = []
  globalThis.host = { call: async (m, p) => { dynCalls.push([m, p]); return { ok: true, data: { echoed: p.action } } } }
  const r1 = await call('quote', { symbols: ['A'] })
  ok(r1 && r1.echoed === 'quote' && dynCalls.length === 1 && dynCalls[0][0] === 'xq.call', 'host 门面对象 → 动态分支（xq.call 透传）')
  const r1b = await call('quote', undefined)
  ok(r1b && dynCalls[1][1].args && JSON.stringify(dynCalls[1][1].args) === '{}', 'args 缺省兜底 {}')
  const savedHost = globalThis.host
  delete globalThis.host

  // b. 守卫回归：host 是普通函数（.call === Function.prototype.call）必须走静态分支
  const fetched = []
  globalThis.fetch = async (url, init) => { fetched.push([url, init]); return { ok: true, json: async () => ({ ok: true, data: { via: 'fetch' } }) } }
  globalThis.host = function wrongBranch() { throw new Error('WRONG-BRANCH') }
  const r2 = await call('quote', {})
  ok(r2 && r2.via === 'fetch' && fetched.length === 1, 'host 为普通函数 → 守卫生效走静态 fetch 分支')
  ok(fetched[0][0] === '/xq-rpc' && fetched[0][1].method === 'POST', '静态分支 POST /xq-rpc')
  delete globalThis.host

  // c. 无 host → 静态分支错误映射
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  let msg = ''
  try { await call('quote', {}) } catch (e) { msg = e.message }
  ok(msg === '请求失败 (HTTP 500)', 'HTTP 5xx → 可读错误')
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad') } })
  msg = ''
  try { await call('quote', {}) } catch (e) { msg = e.message }
  ok(msg === '响应不是有效 JSON（host 异常）', '非 JSON → 可读错误')
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'boom' }) })
  msg = ''
  try { await call('quote', {}) } catch (e) { msg = e.message }
  ok(msg === 'boom', 'ok:false → 透传业务错误')
  // 动态分支错误映射（host 门面回装）
  globalThis.fetch = null
  globalThis.host = savedHost
  globalThis.host = { call: async () => ({ ok: false, error: 'dyn-boom' }) }
  msg = ''
  try { await call('quote', {}) } catch (e) { msg = e.message }
  ok(msg === 'dyn-boom', '动态分支 ok:false → 透传业务错误')
  delete globalThis.host
  delete globalThis.fetch
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ` client-bundle: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
