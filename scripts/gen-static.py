#!/usr/bin/env python3
"""从 dynamic/ 生成静态安装形态 src/，并校验无 drift。

单一真源约定：
  - dynamic/host.js、dynamic/client.js 是唯一手写源（函数体形式）。
  - src/index.js     = dynamic/host.js 包上 `export default {...}`
  - src/client/index.js = dynamic/client.js 包上 __ModuleLoader__ CJS 工厂 + 注入
    vendored KLineChart UMD。

P1-A 起 gen-static 不再做任何文本替换：动态/静态的差异（styles.insert 与 host.call
传输层）已改为 client 源码内的运行时接缝（typeof styles / typeof host 判定），
本脚本退化为「纯包装 + KLC 注入 + drift 校验」。旧方案的 DYNAMIC_CALL/STATIC_CALL
整函数文本替换要求每次改 call() 同步改本脚本，锚点漂移即失败——运行时接缝消除了
这一整类维护负担（代价仅是静态 bundle 多带一个死分支，体积可忽略）。

用法：
  python3 scripts/gen-static.py          # 生成并校验（drift 时退出码 1，先重写文件）
  python3 scripts/gen-static.py --check  # 只校验，不写文件（CI 用）
"""
import sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
check_only = '--check' in sys.argv

def die(msg):
    print('GEN-STATIC FAIL:', msg)
    sys.exit(1)

host_body = (root / 'dynamic/host.js').read_text(encoding='utf-8').strip()
client_body = (root / 'dynamic/client.js').read_text(encoding='utf-8').strip()

if not host_body.startswith('return {'):
    die('dynamic/host.js 必须以 "return {" 开头（函数体形式）')
if not client_body.startswith('return {'):
    die('dynamic/client.js 必须以 "return {" 开头（函数体形式）')

# ---- host: export default 包装（函数体顶层 return 换成 export default）----
# 注意：不注入任何宿主包 import —— file: 安装不会安装 peer 依赖，顶层 import
# 会直接 ERR_MODULE_NOT_FOUND 崩掉宿主。
host_static = 'export default {' + host_body[len('return {'):] + '\n'

# ---- client: 接缝自检（静态形态依赖的两个运行时判定必须在源码里）----
if 'typeof styles' not in client_body:
    die('dynamic/client.js 缺少 styles 运行时接缝（typeof styles）—— 接缝被移除了吗？')
if "typeof host !== 'undefined'" not in client_body:
    die('dynamic/client.js 缺少 host 传输接缝（typeof host）—— 接缝被移除了吗？')
if '/xq-rpc' not in client_body:
    die('dynamic/client.js 缺少静态传输目标 /xq-rpc —— fetch 分支被移除了吗？')
# 函数体顶层 return {...} → exports.default = {...}（loader 取 exports.default ?? exports）
c = 'exports.default = {' + client_body[len('return {'):]

# ---- vendored KLineChart UMD（Apache-2.0）----
# 注入 factory 头部：遮蔽 module/exports/define 使 UMD 走 global 分支挂 window.klinecharts。
# 升级方法：npm pack klinecharts && tar xzf && cp package/dist/umd/klinecharts.min.js assets/
klc_src = (root / 'assets' / 'klinecharts.min.js').read_text(encoding='utf-8').strip()
klc_inject = (
    '    // vendored KLineChart v10 UMD（assets/klinecharts.min.js，Apache-2.0，升级见 gen-static.py 注释）\n'
    '    ;(function () {\n'
    '      var module = undefined, exports = undefined, define = undefined\n'
    + klc_src + '\n'
    '    }).call(typeof window !== "undefined" ? window : this)\n\n'
)

client_static = '''// 由 scripts/gen-static.py 从 dynamic/client.js 生成 —— 勿手改；改 dynamic/ 后重新生成。
// 静态 bundle 格式：classic script 注册到 __ModuleLoader__，factory 为 CJS 形式。
// 动态/静态差异（样式注入与 RPC 传输）由源码内运行时接缝处理，本文件不做文本替换。
window.__ModuleLoader__.load({
  id: 'dsh-xueqiu',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

''' + klc_inject + c + '''
    return module.exports
  }
})
'''

targets = {
    root / 'src/index.js': host_static,
    root / 'src/client/index.js': client_static,
}

drift = []
for path, content in targets.items():
    old = path.read_text(encoding='utf-8') if path.exists() else None
    if old != content:
        drift.append(path.name)
        if not check_only:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
            print('regenerated', path.relative_to(root))

if drift:
    if check_only:
        die('src/ 与 dynamic/ 不同步: ' + ', '.join(drift) + ' — 运行 python3 scripts/gen-static.py')
    print('OK (已重新生成: ' + ', '.join(drift) + ')')
else:
    print('OK: src/ 与 dynamic/ 完全同步')
