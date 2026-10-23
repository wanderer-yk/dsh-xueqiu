// qa/cache.mjs — host 缓存工厂单测（P2：时钟接缝）。运行: node qa/cache.mjs
// 从 dynamic/host.js 的 cache-factory 标记区提取 makeCache，注入假时钟直测
// TTL 过期 / 过期懒清 / FIFO 淘汰 / 24h 清扫 / clear / in-flight。
// 背景：旧实现 Date.now() 散落，unit.mjs 自认"伪造时间不好做"——TTL 过期路径零覆盖。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  >> ' + String(detail).slice(0, 160) : '')) }
}

const src = readFileSync(new URL('../dynamic/host.js', import.meta.url), 'utf8')
const BEGIN = '// ---- qa-extract-begin: cache-factory ----'
const END = '// ---- qa-extract-end: cache-factory ----'
const b = src.indexOf(BEGIN), e = src.indexOf(END)
ok(b > 0 && e > b, 'cache-factory 标记区存在')
const makeCache = new Function(src.slice(b + BEGIN.length, e) + '\nreturn makeCache')()

console.log('== TTL 命中/过期（注入时钟）==')
{
  let clock = 1000
  const c = makeCache({ maxKeys: 5, now: () => clock })
  c.put('k', 'v1')
  ok(c.get('k', 10000) === 'v1', 'TTL 窗口内命中')
  clock = 1500
  ok(c.get('k', 10000) === 'v1', '半衰期仍命中（500 < 10000）')
  clock = 11001
  ok(c.get('k', 10000) === undefined, 'TTL 过期未命中')
  ok(c.size() === 0, '过期条目读取时顺手清除（懒清）')
  c.put('k2', 'v2'); c.put('k2', 'v2b')
  ok(c.get('k2', 0) === undefined && c.get('k2', 99999) === 'v2b', 'ttl=0 永不命中（实时路径）')
}

console.log('== FIFO 淘汰 ==')
{
  let clock = 1000
  const c = makeCache({ maxKeys: 3, now: () => clock })
  c.put('a', 1); c.put('b', 2); c.put('c', 3)
  ok(c.size() === 3, '容量内不淘汰')
  c.put('d', 4)
  ok(c.size() === 3, '超容量钳制在上限')
  ok(c.get('a', 1e9) === undefined && c.get('b', 1e9) === 2 && c.get('d', 1e9) === 4, '最旧(a)被 FIFO 淘汰，其余健在')
}

console.log('== 24h 清扫优先于 FIFO ==')
{
  let clock = 0
  const c = makeCache({ maxKeys: 2, now: () => clock })
  clock = 0; c.put('old1', 1); c.put('old2', 2)   // 两条远古条目
  clock = 25 * 3600 * 1000; c.put('new1', 3)      // 超 24h 触发清扫而非 FIFO 挤占
  ok(c.size() === 1 && c.get('new1', 1e9) === 3, '超 24h 条目被清扫（新条目保留）')
  ok(c.get('old1', 1e9) === undefined && c.get('old2', 1e9) === undefined, '远古条目不驻留')
}

console.log('== clear / in-flight ==')
{
  const c = makeCache({ maxKeys: 5, now: () => 1000 })
  c.put('k', 'v')
  const p = Promise.resolve('v')
  c.inflightSet('k', p)
  ok(c.inflightGet('k') === p, 'in-flight 写读对称')
  ok(JSON.stringify(c.inflightKeys()) === '["k"]', 'in-flight 键清单')
  c.clear()
  ok(c.size() === 0 && c.get('k', 99999) === undefined, 'clear 全量失效缓存')
  ok(c.inflightGet('k') === p, 'clear 不动 in-flight（与旧实现语义一致）')
  c.inflightDelete('k')
  ok(c.inflightGet('k') === undefined, 'in-flight 删除')
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ` cache: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
