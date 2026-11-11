/**
 * Independent conformance check for the SessionTree Cordis Inspect provider.
 *
 * What it does, in one process:
 *   1. extracts the SHIPPED JSON-Schema engine verbatim out of the extracted
 *      `@deepseek-ai/dsh-tools/lib/index.js` (`assertSupportedJsonSchema` +
 *      `validateJsonSchemaValue`, lines 8-534 = `region lib/types/json-schema.js`)
 *      and the real `snapshotJsonValue` out of `@deepseek-ai/dsh-util-values`,
 *   2. loads the REAL plugin client half (client.js) in the main realm with a
 *      minimal browser/DOM fixture — no jsdom, no browser,
 *   3. captures the provider it registers through `ctx.inject(['cordisInspect'], cb)`,
 *   4. asserts the manifest schema passes the shipped subset checker,
 *   5. runs `query('snapshot', {})` and validates the answer with the shipped
 *      `validateJsonSchemaValue` exactly as the Host does (`validateOutput`,
 *      dsh-cordis-host-runner/lib/index.js:925),
 *   6. mutates the answer deliberately to prove that validation can FAIL, so a
 *      green run is evidence rather than a tautology,
 *   7. asserts the two service-absence semantics: no `ctx.inject` at all, and an
 *      `inject` that never calls back — the plugin must still register its slot.
 *
 * The only non-verbatim piece is `HarnessError`, which sits in the import graph
 * of dsh-tools and is a three-field Error subclass; it is reproduced below.
 *
 * Usage:
 *   node test/provider-conformance.cjs [<rc2-fixture-dir>]
 *
 * The fixture is an unpacked DSH asar tree that must contain, under
 * `<fixture>/dsh/node_modules/@deepseek-ai/`:
 *   dsh-tools/lib/index.js        — with the `lib/types/json-schema.js` region INLINE
 *   dsh-util-values/lib/index.js  — the shipped values bundle (no imports)
 *
 * Resolution order (the first usable candidate wins; an explicitly named candidate
 * that is unusable fails immediately instead of silently falling through):
 *   1. CLI argument          node test/provider-conformance.cjs <dir>
 *   2. env DSH_RC2_FIXTURE_DIR
 *   3. %TEMP%\dsh-asar-inspect\out-rc2-compat   (known rc.2-compatible layout)
 *   4. %TEMP%\dsh-asar-inspect\out              (legacy default; newer DSH builds move
 *                                                the engine to ./shared-*.js -> rejected)
 *
 * A missing / non-rc.2 fixture is a CONFIGURATION failure: exit code 2 with an
 * actionable message (how to build the fixture), never a raw crash stack. Exit code 1
 * means an assertion failed. The provenance, file list and SHA-256 of the rc.2 fixture
 * used for the recorded 29/29 run are in docs/reports/conformance-rc2-2026-11-12.md.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const CLIENT = path.resolve(__dirname, '..', 'client.js')
const FIXTURE_ENV = 'DSH_RC2_FIXTURE_DIR'
const FIXTURE_SUBDIR = path.join('dsh', 'node_modules', '@deepseek-ai')
const KNOWN_FIXTURE_DIRS = [
  path.join(os.tmpdir(), 'dsh-asar-inspect', 'out-rc2-compat'),
  path.join(os.tmpdir(), 'dsh-asar-inspect', 'out'),
]

let failures = 0
let checks = 0
const check = (name, ok, detail) => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ------------------------------------------------------------- fixture discovery
/** A configuration problem (missing / non-rc.2 fixture), not a test crash. */
class FixtureError extends Error {}

/**
 * Classify one candidate directory. The contract the extractor below relies on is
 * that the schema engine is INLINE in `dsh-tools/lib/index.js` (region marker plus
 * `function validateJsonSchemaValue(`). Newer DSH builds re-export it from a split
 * chunk (`./shared-*.js`), which this heuristic cannot lift, so they are reported
 * as "not rc.2-compatible" up front instead of crashing mid-extraction.
 */
function probeFixture(dir) {
  const pkgs = path.join(dir, FIXTURE_SUBDIR)
  const tools = path.join(pkgs, 'dsh-tools', 'lib', 'index.js')
  const utils = path.join(pkgs, 'dsh-util-values', 'lib', 'index.js')
  const problems = []
  if (!fs.existsSync(pkgs)) {
    problems.push(`missing ${pkgs}`)
  } else {
    if (!fs.existsSync(tools)) problems.push(`missing ${tools}`)
    if (!fs.existsSync(utils)) problems.push(`missing ${utils}`)
  }
  if (problems.length === 0) {
    const lines = fs.readFileSync(tools, 'utf8').split(/\r?\n/)
    const hasRegion = lines.includes('//#region lib/types/json-schema.js')
    const hasValidator = lines.some((line) => line.startsWith('function validateJsonSchemaValue('))
    const splitChunk = /from "\.\/shared-[^"]+\.js"/.test(lines.join('\n'))
    if (!hasRegion || !hasValidator) {
      problems.push(
        'not rc.2-compatible: dsh-tools/lib/index.js has no inline "lib/types/json-schema.js" region' +
          (splitChunk ? ' (newer build: the engine lives in ./shared-*.js)' : '') +
          ` [region=${hasRegion}, validateJsonSchemaValue=${hasValidator}]`,
      )
    }
  }
  return { dir, pkgs, tools, utils, problems, ok: problems.length === 0 }
}

function fixtureHelp(probed) {
  const lines = [
    'fixture 缺失或不兼容 rc.2（missing or not rc.2-compatible）：',
    '  provider-conformance 需要一份「rc.2 兼容」的 DSH asar 解包目录（内联 json-schema 引擎 + dsh-util-values）。',
    '',
    '已检查（checked）:',
  ]
  for (const p of probed) {
    lines.push(`  - ${p.dir}  [${p.source}]`)
    for (const problem of p.problems) lines.push(`      ${problem}`)
  }
  lines.push(
    '',
    '获取步骤（how to provide the fixture）:',
    `  1) 解包 rc.2 版 DSH app.asar 的两个文件到 ${path.join(os.tmpdir(), 'dsh-asar-inspect', 'out-rc2-compat')}`,
    `     node "${path.join(os.tmpdir(), 'dsh-asar-inspect', 'extract-fixture.cjs')}" "<rc.2 app.asar>" "${path.join(os.tmpdir(), 'dsh-asar-inspect', 'out-rc2-compat')}" "dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js" "dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js"`,
    '  2) 或指向已有的 rc.2 兼容目录（本次记录见 docs/reports/conformance-rc2-2026-11-12.md）:',
    `     $env:${FIXTURE_ENV} = '<dir>'   # PowerShell；或 node test/provider-conformance.cjs <dir>`,
    '  3) 若只有新版 DSH（引擎在 dsh-tools/lib/shared-*.js），在解包副本里把该 shared chunk 复制为 dsh-tools/lib/index.js',
    '     （out-rc2-compat 就是这样构造的：逐字节 verbatim，不改安装目录本身）；',
    '     单纯重跑不会成功，本脚本不会把缺 fixture 当成断言失败。',
  )
  return lines.join('\n')
}

function resolveFixture() {
  const explicit = []
  if (process.argv[2]) explicit.push({ source: 'CLI argument', dir: path.resolve(process.argv[2]) })
  if (process.env[FIXTURE_ENV]) {
    explicit.push({ source: `env ${FIXTURE_ENV}`, dir: path.resolve(process.env[FIXTURE_ENV]) })
  }
  for (const candidate of explicit) {
    const probe = Object.assign(probeFixture(candidate.dir), { source: candidate.source })
    if (probe.ok) return probe
    throw new FixtureError(fixtureHelp([probe]))
  }
  const probed = KNOWN_FIXTURE_DIRS.map((dir) => Object.assign(probeFixture(dir), { source: 'known default' }))
  const usable = probed.find((probe) => probe.ok)
  if (usable) return usable
  throw new FixtureError(fixtureHelp(probed))
}

// --------------------------------------------------------------- shipped engine
/** Verbatim `HarnessError` (dsh-llm/lib/index.js:126-134). */
class HarnessError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

function extractShippedEngine(pkgs) {
  const toolsSrc = fs.readFileSync(path.join(pkgs, 'dsh-tools', 'lib', 'index.js'), 'utf8')
  // The shipped bundle uses CRLF line terminators, so split on both.
  const lines = toolsSrc.split(/\r?\n/)
  const start = lines.indexOf('//#region lib/types/json-schema.js')
  const declaredAt = lines.findIndex((line) => line.startsWith('function validateJsonSchemaValue('))
  const end = declaredAt < 0 ? -1 : lines.indexOf('//#endregion', declaredAt)
  if (start < 0 || end < 0) {
    const probe = path.join(pkgs, 'dsh-tools', 'lib', 'index.js')
    throw new Error(
      `json-schema region not found in dsh-tools (file=${probe}, bytes=${fs.statSync(probe).size}, ` +
        `lines=${lines.length}, start=${start}, declaredAt=${declaredAt}, end=${end})`,
    )
  }
  const region = lines.slice(start, end).join('\n')
  // `snapshotJsonValue` needs its own closure (`walkJsonValue` and the plain-value
  // guards). `@deepseek-ai/dsh-util-values` has NO imports at all, so its whole
  // body is lifted in place — declaration order and every helper stay exactly as
  // shipped, instead of re-deriving the closure by hand (which silently loses a
  // helper the moment a function gains one).
  const utilsSrc = fs
    .readFileSync(path.join(pkgs, 'dsh-util-values', 'lib', 'index.js'), 'utf8')
    .replace(/^export \{[^}]*\};\s*$/m, '')
    .replace(/^\/\/#region .*$/gm, '')
    .replace(/^\/\/#endregion$/gm, '')
  const mod = new Function(
    'HarnessError',
    `${utilsSrc}
     ${region}
     return { assertSupportedJsonSchema, validateJsonSchemaValue, snapshotJsonValue, JsonSchemaError }`,
  )
  return mod(HarnessError)
}

// ------------------------------------------------------------------- DOM fixture
/** One rendered row plus the members the provider reads off it. */
function node(tag, className, attrs = {}, style = {}, kids = []) {
  const el = {
    tagName: tag,
    className,
    attrs: Object.assign({}, attrs),
    style: Object.assign({}, style),
    textContent: '',
    kids,
    children: kids,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
    },
    setAttribute(name, value) {
      this.attrs[name] = value
      return value
    },
    querySelector(sel) {
      const want = String(sel).replace(/^\./, '')
      const seen = []
      const walk = (list) => {
        for (const k of list) {
          seen.push(k)
          walk(k.kids || [])
        }
      }
      walk(this.kids)
      return seen.find((k) => String(k.className).split(/\s+/).includes(want)) || null
    },
    getBoundingClientRect() {
      return this.box
    },
  }
  return el
}

/** Build one `.st-row` from the exact facts the renderer was given. */
function row({ key, kind, depth, label = '', secondary = '', state = 'idle', expanded = false, top = 0, height = 24, width = 300, color = 'rgb(230, 232, 238)', background = 'rgba(0, 0, 0, 0)', fontWeight = '400' }) {
  const labelEl = label === null ? null : node('span', 'st-label', secondary ? { title: secondary } : {}, {}, [])
  if (labelEl) labelEl.textContent = label
  const dotEl = state === null ? null : node('span', 'st-dot', { 'data-state': state }, {}, [])
  const kids = [labelEl, dotEl].filter(Boolean)
  const el = node('div', 'st-row' + (kind === 'workspace' ? ' st-group' : ''), {
    'data-key': key,
    'data-kind': kind,
    'data-depth': String(depth),
    ...(kind === 'workspace' ? { 'aria-expanded': expanded ? 'true' : 'false' } : {}),
    ...(kind === 'subagent' ? {} : {}),
  }, { paddingLeft: 6 + depth * 13 + 'px' }, kids)
  el.box = { top, height, width, left: 0, right: width, bottom: top + height }
  el.computed = { paddingLeft: 6 + depth * 13 + 'px', color, backgroundColor: background, fontWeight }
  return el
}

/**
 * Three workspaces + nested sessions + one invisible row, so order, level,
 * geometry and computed styles are all exercised.
 */
function fixture() {
  const rows = [
    row({ key: 'ws:w-a', kind: 'workspace', depth: 0, label: 'Alpha', secondary: 'C:\\proj\\alpha', top: 10, expanded: true, fontWeight: '600', color: 'rgb(200, 206, 224)' }),
    row({ key: 'ws:w-a/A1', kind: 'session', depth: 1, label: '重构会话树的工作区分组', secondary: 'title — pending', state: 'ongoing', expanded: true, top: 34 }),
    row({ key: 'ws:w-a/A1c', kind: 'subagent', depth: 2, label: '研究员 A', secondary: 'durable child title', state: 'done', top: 58 }),
    row({ key: 'ws:w-b', kind: 'workspace', depth: 0, label: 'Beta', secondary: null, top: 82, expanded: false, fontWeight: '600' }),
    row({ key: '', kind: 'workspace', depth: 0, label: '未分组', top: 106, expanded: true, fontWeight: '500', background: 'rgba(59, 130, 246, 0.08)' }),
    row({ key: 'ws:/Z1', kind: 'session', depth: 1, label: '游离会话', top: 130, height: 0, width: 0 }),
  ]
  return rows
}

function installBrowser(rows) {
  globalThis.window = globalThis
  globalThis.document = {
    querySelectorAll(sel) {
      if (sel !== '.st-row') throw new Error(`unexpected selector ${sel}`)
      return rows
    },
  }
  globalThis.getComputedStyle = (el) => el.computed
}

/**
 * The plugin only destructures React at factory time (`apply` never renders), so
 * a shape-complete stub is enough — this suite is about the DOM answer and the
 * schema contract, not about rendering (render.test.cjs owns that).
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

// ------------------------------------------------------------------- run client
let loadSeq = 0
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8')
  const tmp = path.join(os.tmpdir(), `session-tree-conformance-${process.pid}-${loadSeq++}.mjs`)
  fs.writeFileSync(tmp, `${src}\nexport default globalThis.__CAPTURED_SESSION_TREE__\n`)
  return import(pathToFileURL(tmp).href + `?n=${loadSeq}`).then((m) => {
    fs.unlinkSync(tmp)
    return m.default
  })
}

async function main() {
  console.log('=== SessionTree inspect provider: conformance against the SHIPPED schema engine ===')
  const fixtureDir = resolveFixture()
  console.log(`  fixture: ${fixtureDir.dir} (source: ${fixtureDir.source})`)
  const engine = extractShippedEngine(fixtureDir.pkgs)
  console.log(`  engine: loaded from ${fixtureDir.tools}`)
  const rows = fixture()
  installBrowser(rows)
  globalThis.__CAPTURED_SESSION_TREE__ = null
  globalThis.window.__ModuleLoader__ = {
    load({ id, factory }) {
      void id
      globalThis.__CAPTURED_SESSION_TREE__ = factory((name) => {
        if (name === 'react') return REACT_STUB
        throw new Error(`unexpected require: ${name}`)
      })
    },
  }

  // ------------------------------------------------------ A. absence semantics
  console.log('\n=== A. optional injection must degrade silently ===')
  for (const scenario of [
    { name: 'ctx has no inject() at all', ctx: { inject: undefined } },
    { name: 'ctx.inject() never calls back (service absent)', ctx: { inject(keys, cb) { void keys; void cb } } },
    { name: 'ctx.inject() calls back with no service (scoped miss)', ctx: { inject(keys, cb) { void keys; cb({}) } } },
  ]) {
    const plugin = await loadClient()
    let slots = 0
    const ctx = Object.assign({}, scenario.ctx, {
      slots: { inject(k, cb) { void k; cb() }, register() { slots++; return () => {} } },
    })
    let threw = null
    try {
      plugin.apply(ctx)
    } catch (error) {
      threw = error
    }
    check(`${scenario.name}: apply() does not throw`, threw === null, threw && threw.message)
    check(`${scenario.name}: sidebar.workspaces still registered`, slots === 1, `${slots} registration(s)`)
  }

  // ---------------------------------------------------------- B. real registration
  console.log('\n=== B. provider registration + manifest subset ===')
  const plugin = await loadClient()
  const inspect = { registered: [], register(reg) { this.registered.push(reg); return () => {} } }
  let slots = 0
  const ctx = {
    inject(keys, cb) {
      if (!Array.isArray(keys) || !keys.includes('cordisInspect')) throw new Error(`unexpected inject keys: ${JSON.stringify(keys)}`)
      cb({ cordisInspect: inspect })
    },
    slots: { inject(k, cb) { void k; cb() }, register() { slots++; return () => {} } },
  }
  plugin.apply(ctx)
  check('sidebar.workspaces still registered alongside the provider', slots === 1, `${slots} registration(s)`)
  check('exactly one inspect provider registered', inspect.registered.length === 1, `${inspect.registered.length}`)
  const registration = inspect.registered[0]
  if (!registration) {
    console.log('\n  cannot continue without a registration')
    process.exit(1)
  }
  const manifest = registration.manifest
  check('manifest.id is "SessionTree"', manifest && manifest.id === 'SessionTree', manifest && manifest.id)
  check('manifest.description is non-empty (Host requires it)', typeof manifest.description === 'string' && manifest.description.trim() !== '')
  check('exactly one method named "snapshot"', manifest.methods.length === 1 && manifest.methods[0].name === 'snapshot')
  const method = manifest.methods[0]
  check('method.description is non-empty (Host requires it)', typeof method.description === 'string' && method.description.trim() !== '')
  let schemaError = null
  try {
    engine.assertSupportedJsonSchema(method.inputSchema)
    engine.assertSupportedJsonSchema(method.outputSchema)
  } catch (error) {
    schemaError = error
  }
  check('input+output schemas pass the shipped subset checker', schemaError === null, schemaError && schemaError.message)

  // -------------------------------------------------------------- C. the answer
  console.log('\n=== C. query("snapshot", {}) judged by the shipped validator ===')
  check('unknown method is rejected loudly', (() => {
    try {
      registration.query('nope', {})
      return false
    } catch (error) {
      return /unknown/.test(String(error && error.message))
    }
  })())
  const data = registration.query('snapshot', {})
  check('returns a plain object', !!data && typeof data === 'object' && !Array.isArray(data))
  check('rowCount matches the DOM', data.rowCount === rows.length, `${data.rowCount} vs ${rows.length}`)
  check('groupCount counts only data-kind="workspace"', data.groupCount === 3, String(data.groupCount))
  check('row order follows document order', data.rows.map((r) => r.key).join('|') === rows.map((r) => r.attrs['data-key']).join('|'))
  check('depth comes from data-depth', data.rows[2].depth === 2, String(data.rows[2].depth))
  check('paddingLeft is the computed value', data.rows[2].paddingLeft === '32px', data.rows[2].paddingLeft)
  check('invisible row reported not visible', data.rows[5].visible === false, JSON.stringify(data.rows[5]))
  check('computed background is reported', data.rows[4].background === 'rgba(59, 130, 246, 0.08)', data.rows[4].background)

  const snapshot = engine.snapshotJsonValue
  const snapshotValue = snapshot(data)
  check('answer survives snapshotJsonValue (the Host runs it first)', snapshotValue !== undefined)
  if (process.env.CONFORMANCE_DEBUG) {
    console.log('  DEBUG method keys:', Object.keys(method))
    console.log('  DEBUG outputSchema:', JSON.stringify(method.outputSchema))
    console.log('  DEBUG same object as manifest.methods[0]?', method === manifest.methods[0])
  }
  const violations = engine.validateJsonSchemaValue(method.outputSchema, snapshotValue, 'output')
  check('answer passes the shipped output validator', violations.length === 0, violations.join('; '))

  // ------------------------------------------- D. negative controls (must fail)
  console.log('\n=== D. negative controls: the validator must reject tampering ===')
  const extraField = JSON.parse(JSON.stringify(snapshotValue))
  extraField.rows[0].unexpectedField = 1
  const extraViolations = engine.validateJsonSchemaValue(method.outputSchema, extraField, 'output')
  check('extra row field is rejected (additionalProperties: false)', extraViolations.length > 0, extraViolations.join('; '))

  const missingField = JSON.parse(JSON.stringify(snapshotValue))
  delete missingField.rows[0].visible
  const missingViolations = engine.validateJsonSchemaValue(method.outputSchema, missingField, 'output')
  check('missing required row field is rejected', missingViolations.length > 0, missingViolations.join('; '))

  const wrongType = JSON.parse(JSON.stringify(snapshotValue))
  wrongType.rows[0].depth = '0'
  const typeViolations = engine.validateJsonSchemaValue(method.outputSchema, wrongType, 'output')
  check('wrong scalar type is rejected', typeViolations.length > 0, typeViolations.join('; '))

  const extraRoot = JSON.parse(JSON.stringify(snapshotValue))
  extraRoot.extra = true
  const rootViolations = engine.validateJsonSchemaValue(method.outputSchema, extraRoot, 'output')
  check('extra root field is rejected', rootViolations.length > 0, rootViolations.join('; '))

  const badSchema = JSON.parse(JSON.stringify(method.outputSchema))
  badSchema.properties.rows.items.properties.key.format = 'uuid'
  let badSchemaError = null
  try {
    engine.assertSupportedJsonSchema(badSchema)
  } catch (error) {
    void error
    badSchemaError = error
  }
  check('an unsupported keyword would have been caught at publish time', badSchemaError !== null, badSchemaError && badSchemaError.message)

  const verdict =
    failures === 0
      ? `ALL CHECKS PASSED (${checks}/${checks})`
      : `${failures} CHECK(S) FAILED (${checks - failures}/${checks})`
  console.log(`\n==================== ${verdict} ====================`)
  console.log(`fixture: ${fixtureDir.dir}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  if (error instanceof FixtureError) {
    // Configuration failure, not a crash: print the actionable message, no stack.
    console.error(`\n[fixture] ${error.message}`)
    process.exit(2)
  }
  console.error('conformance run crashed:', error)
  process.exit(1)
})
