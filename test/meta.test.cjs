/**
 * Pure-function tests for the conversation-UI session metadata derivation.
 *
 * The real `client.js` is loaded the same way `style-guard.cjs` loads it: the
 * browser bundle is executed in the current realm with a minimal
 * `window.__ModuleLoader__` fixture, then its module object is taken from the
 * appended `export default` line. No React render and no DSH package is
 * involved — `metaOf` / `selectReadOnlyMeta` are pure functions.
 *
 * What is pinned here (report `session-metadata-display-2026-11-12.md` §9.4):
 *   - `modelSelection.lastUsed` wins over `next`; a missing effort stays null
 *     (the component renders the localized "default");
 *   - the context percentage uses the shipped `ContextMeter` formula:
 *     `used = projectedTokens ?? pressureTokens`,
 *     `pct = min(100, round(used / window * 100))` clamped to 0–100;
 *   - missing window / missing tokens / zero or negative window → no pct;
 *   - every absent fact stays null and nothing displayable → `null`;
 *   - `selectReadOnlyMeta` mirrors the shipped read-only-composer predicate
 *     exactly (unknown / one-shot / parent offline + not running).
 *
 * Run:  node test/meta.test.cjs
 * Exit: 0 = all green, 1 = at least one check failed.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const CLIENT = path.resolve(__dirname, '..', 'client.js')

let checks = 0
let failures = 0
const check = (name, ok, detail) => {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + detail}`)
}

/**
 * The plugin only destructures React at factory time and these helpers never
 * render, so a shape-complete stub is enough.
 */
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, kids: children }),
  Component: class {
    constructor(props) {
      this.props = props || {}
    }
  },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
}

let loadSeq = 0
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const tmp = path.join(os.tmpdir(), `session-tree-meta-${process.pid}-${loadSeq++}.mjs`)
  fs.writeFileSync(tmp, `${src}\nexport default globalThis.__CAPTURED_SESSION_TREE__\n`)
  return import(pathToFileURL(tmp).href + `?n=${loadSeq}`).then((m) => {
    fs.unlinkSync(tmp)
    return m.default
  })
}

/** Install the module-loader fixture the client bundle expects. */
function installSandbox() {
  globalThis.window = globalThis
  globalThis.window.__ModuleLoader__ = {
    load({ factory }) {
      globalThis.__CAPTURED_SESSION_TREE__ = factory((name) => {
        if (name === 'react') return REACT_STUB
        throw new Error(`unexpected require: ${name}`)
      })
    },
  }
  globalThis.__CAPTURED_SESSION_TREE__ = null
}

const selection = (lastUsed, next) => ({ lastUsed: lastUsed || null, next: next || null })
const pressure = (contextWindow, tokens) => ({ contextWindow, ...tokens })

async function main() {
  console.log('=== session-tree conversation metadata: pure derivations ===')
  installSandbox()
  const plugin = await loadClient()
  const metaOf = plugin && plugin.metaOf
  const selectReadOnlyMeta = plugin && plugin.selectReadOnlyMeta
  check('模块对象暴露 metaOf（纯函数测试缝）', typeof metaOf === 'function')
  check('模块对象暴露 selectReadOnlyMeta（只读判定测试缝）', typeof selectReadOnlyMeta === 'function')
  if (typeof metaOf !== 'function' || typeof selectReadOnlyMeta !== 'function') {
    console.log('\n==================== FAILED (cannot continue) ====================')
    process.exit(1)
  }

  // ---------------------------------------------------------------- null input
  console.log('\n=== A. 没有可展示事实 → null（组件据此不渲染）===')
  check('metaOf(null, null) === null', metaOf(null, null) === null)
  check('metaOf(undefined, undefined) === null', metaOf(undefined, undefined) === null)
  check('metaOf({}, {}) === null（空投影）', metaOf({}, {}) === null)
  check(
    '非法形状（modelSelection 字符串 / contextPressure 数字）→ null',
    metaOf('nope', 42) === null,
  )
  check(
    '只有 contextPressure 无 window/token → null',
    metaOf(null, { contextWindow: 100000 }) === null,
  )

  // ------------------------------------------------------- model / effort facts
  console.log('\n=== B. model / provider / effort：lastUsed 优先、next 兜底、缺省不猜 ===')
  const lastUsed = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
  const next = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' }

  const both = metaOf(selection(lastUsed, next), null)
  check(
    'lastUsed 优先于 next',
    !!both && both.model === 'deepseek-v4.1-flash' && both.provider === 'opencode-go',
    JSON.stringify(both),
  )
  check('effort 原样取 id（max）', !!both && both.effort === 'max')
  const nextOnly = metaOf(selection(null, next), null)
  check('只有 next 时用 next', !!nextOnly && nextOnly.model === 'deepseek-chat' && nextOnly.provider === 'deepseek')
  check('next 的 effort 同样可用', !!nextOnly && nextOnly.effort === 'low')
  const noEffort = metaOf(selection({ provider: 'p', model: 'm' }, null), null)
  check('缺 reasoningEffort → effort === null（渲染层才显示「默认」）', !!noEffort && noEffort.effort === null)
  const padded = metaOf(
    selection({ provider: '  p  ', model: '  m  ', reasoningEffort: '  high  ' }, null),
    null,
  )
  check(
    '字符串字段 trim（provider/model/effort）',
    !!padded && padded.provider === 'p' && padded.model === 'm' && padded.effort === 'high',
    JSON.stringify(padded),
  )
  const weird = metaOf(selection({ provider: 7, model: '', reasoningEffort: {} }, null), null)
  check('非字符串 / 空字符串字段 → null 且整体无展示 → null', weird === null, JSON.stringify(weird))

  // ---------------------------------------------------------- context pressure
  console.log('\n=== C. 上下文占用：与官方 ContextMeter 同公式 ===')
  const projected = metaOf(
    selection({ model: 'm' }, null),
    pressure(200000, { pressureTokens: 50000, projectedTokens: 76000 }),
  )
  check(
    'projectedTokens 优先于 pressureTokens',
    !!projected && projected.usedTokens === 76000,
    JSON.stringify(projected && projected.usedTokens),
  )
  check('pct = round(76000/200000×100) = 38', !!projected && projected.pct === 38, JSON.stringify(projected && projected.pct))
  check('contextWindow 原样保留', !!projected && projected.contextWindow === 200000)

  const forced = metaOf(selection({ model: 'm' }, null), pressure(100000, { pressureTokens: 25000 }))
  check(
    '缺 projectedTokens 时退回 pressureTokens（25%）',
    !!forced && forced.usedTokens === 25000 && forced.pct === 25,
    JSON.stringify(forced && forced.pct),
  )
  const zero = metaOf(selection({ model: 'm' }, null), pressure(100000, { projectedTokens: 0 }))
  check('0 token 是真实值：usedTokens=0、pct=0（不是 null）', !!zero && zero.usedTokens === 0 && zero.pct === 0)
  const clamped = metaOf(selection({ model: 'm' }, null), pressure(100000, { projectedTokens: 250000 }))
  check('超过窗口 clamp 到 100', !!clamped && clamped.pct === 100, String(clamped && clamped.pct))
  const rounded = metaOf(selection({ model: 'm' }, null), pressure(3, { projectedTokens: 1 }))
  check('四舍五入：1/3 → 33', !!rounded && rounded.pct === 33, String(rounded && rounded.pct))

  console.log('\n=== D. 缺失/非法窗口与 token → 不渲染百分比（诚实缺失）===')
  const noWindow = metaOf(selection({ model: 'm' }, null), { pressureTokens: 123 })
  check('contextPressure 无 contextWindow → pct === null', !!noWindow && noWindow.pct === null)
  check('window 缺失时 usedTokens 仍如实保留', !!noWindow && noWindow.usedTokens === 123)
  check('window 缺失时 contextWindow === null', !!noWindow && noWindow.contextWindow === null)
  const zeroWindow = metaOf(selection({ model: 'm' }, null), pressure(0, { pressureTokens: 10 }))
  check('window = 0 → pct === null（不做除零）', !!zeroWindow && zeroWindow.pct === null)
  check('window = 0 → contextWindow === null（非法值不展示）', !!zeroWindow && zeroWindow.contextWindow === null)
  const negativeWindow = metaOf(selection({ model: 'm' }, null), pressure(-100, { pressureTokens: 10 }))
  check('window 为负 → pct === null', !!negativeWindow && negativeWindow.pct === null)
  const noTokens = metaOf(selection({ model: 'm' }, null), pressure(100000, {}))
  check('有 window 无 token → pct === null', !!noTokens && noTokens.pct === null && noTokens.usedTokens === null)
  const negativeTokens = metaOf(selection({ model: 'm' }, null), pressure(100000, { projectedTokens: -5 }))
  check(
    '负数 token 是畸形事实 → usedTokens/pct 均为 null',
    !!negativeTokens && negativeTokens.usedTokens === null && negativeTokens.pct === null,
  )
  const badWindowType = metaOf(selection({ model: 'm' }, null), { contextWindow: '100000', pressureTokens: 10 })
  check('非数字 window → pct === null', !!badWindowType && badWindowType.pct === null)

  console.log('\n=== E. 只有一部分事实时：能展示的就展示 ===')
  const pctOnly = metaOf(null, pressure(100000, { pressureTokens: 42000 }))
  check(
    '没有 model 但有 pct → 返回对象（组件只渲染百分比）',
    !!pctOnly && pctOnly.model === null && pctOnly.pct === 42,
    JSON.stringify(pctOnly),
  )
  const modelOnly = metaOf(selection({ provider: 'p', model: 'm', reasoningEffort: 'x' }, null), null)
  check('只有 model/effort → pct === null', !!modelOnly && modelOnly.pct === null)

  // ------------------------------------------------- selectReadOnlyMeta mirror
  console.log('\n=== F. selectReadOnlyMeta：精确复刻官方只读 composer 判定 ===')
  check('root 会话（subagent=null）→ null', selectReadOnlyMeta(null, false) === null)
  check('缺 subagent → null', selectReadOnlyMeta(undefined, true) === null)
  check(
    'continuable 且父可用 → null（composer 正常）',
    selectReadOnlyMeta({ address: { mode: 'continuable' }, parentAvailable: true }, true) === null,
  )
  check(
    'continuable parentAvailable 未定（undefined）→ null（官方 !== false 语义）',
    selectReadOnlyMeta({ address: { mode: 'continuable' }, parentAvailable: undefined }, false) === null,
  )
  const unknown = selectReadOnlyMeta({ address: { mode: 'unknown' } }, false)
  check('mode=unknown → { reason:"unknown" }', !!unknown && unknown.reason === 'unknown', JSON.stringify(unknown))
  const oneShot = selectReadOnlyMeta({ address: { mode: 'one-shot' } }, true)
  check('mode=one-shot → { reason:"one-shot" }（运行中也是只读）', !!oneShot && oneShot.reason === 'one-shot', JSON.stringify(oneShot))
  check(
    '父离线但仍在运行的 continuable → null（不覆盖运行中的 composer）',
    selectReadOnlyMeta({ address: { mode: 'continuable' }, parentAvailable: false }, true) === null,
  )
  const offline = selectReadOnlyMeta({ address: { mode: 'continuable' }, parentAvailable: false }, false)
  check(
    '父离线且未运行的 continuable → { reason:"parent-unavailable" }',
    !!offline && offline.reason === 'parent-unavailable',
    JSON.stringify(offline),
  )
  check(
    '畸形 subagent（address 不是对象）→ 不抛错；mode 未定走 parentAvailable 分支',
    selectReadOnlyMeta({ address: 'nope', parentAvailable: true }, false) === null,
  )

  const verdict =
    failures === 0 ? `ALL CHECKS PASSED (${checks}/${checks})` : `${failures} CHECK(S) FAILED (${checks - failures}/${checks})`
  console.log(`\n==================== ${verdict} ====================`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('meta test crashed:', error)
  process.exit(1)
})
