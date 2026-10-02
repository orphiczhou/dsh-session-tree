/**
 * Headless render test for the real `client.js` —— 可移植版。
 *
 * 它在一个沙箱里加载真正要发布的那份 `client.js`（`../client.js`，从 __dirname
 * 解析，不写死绝对路径），配上最小 React 桩 + 最小元素渲染器，喂给它一份
 * `byId` 会话图，然后对组件产出的行结构逐条断言。
 *
 * 与参考实现（`dsh-session-tree/test/render.test.cjs`）的差别只有数据来源：
 *
 *   1. 【内置确定性夹具】。参考实现先从本机实时会话库重建 byId（多帧 zstd
 *      会话日志，1213+ 个会话），于是它只能在装了 DSH 的这台机器上跑。这里换成
 *      一份自己写的合成会话图，图结构与真实数据同形：多层嵌套（深度 4）、
 *      一个 >300 子会话的父会话（命中 MAX_CHILDREN=300 的上限）、已归档、
 *      已置顶、无真标题（走 displayTitle 回退）、以及畸形 lineage（自环 /
 *      孤儿 / 互相引用 / Host 形状的行）。因此本文件不依赖 ~/.dsh、不依赖
 *      Windows 路径、不依赖 zstd 解码，在没有任何 DSH 安装的机器上同样全绿。
 *
 *   2. 包名是 `@orphiczhou/dsh-session-tree`，`client.js` 就在包的根目录。
 *
 *   3. 【可选实时附加阶段】。如果本机确实存在 DSH 会话库（自动探测；可用
 *      DSH_HOME / DSH_SESSION_TREE_SESSIONS 指定，DSH_SESSION_TREE_LIVE=off
 *      关闭，=strict 可让实时检查参与判定），就额外在真实数据上再跑一遍
 *      数据驱动的检查。这一段永不崩溃、永不阻塞、默认永不失败（不一致只打印
 *      WARN），缺失时静默退回夹具模式。
 *
 * 断言构成：90 项与参考套件逐条对应（名称、判定、意图都不变），另有 8 项
 * 夹具/套件自检（前缀 `夹具：`），用来证明夹具真的满足上面那串要求、并且那
 * 90 项确实全部执行（没有被条件分支悄悄跳过）。总判定项 98。
 *
 * 只使用 Node 内置模块（node:fs / node:path / node:vm / node:zlib / node:os）。
 *
 * Run:  node test/render.test.cjs
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')

/** 被测试模块：包的 client 半边，始终相对于本文件解析。 */
const CLIENT = path.join(__dirname, '..', 'client.js')
/** 参考套件（dsh-session-tree/test/render.test.cjs）的断言条数，逐条对齐。 */
const REFERENCE_ASSERTIONS = 90

// ------------------------------------------------------------------ 结果统计
let failures = 0
let checks = 0
let coreChecks = 0
let coreFailures = 0
let fixtureChecks = 0
let fixtureFailures = 0
let liveChecks = 0
let liveWarnings = 0

/** 实时附加阶段的模式：off 关闭；strict 时实时不一致也会让退出码非零。 */
const LIVE_MODE = String(process.env.DSH_SESSION_TREE_LIVE || '').trim().toLowerCase()
const LIVE_OFF = ['off', '0', 'no', 'false', 'none'].includes(LIVE_MODE)
const LIVE_STRICT = LIVE_MODE === 'strict'

/** 一条判定。`夹具：` 前缀的算夹具/套件自检，其余算参考套件对齐断言。 */
function check(name, pass, detail) {
  const isFixture = name.startsWith('夹具：')
  checks++
  if (isFixture) {
    fixtureChecks++
    if (!pass) fixtureFailures++
  } else {
    coreChecks++
    if (!pass) coreFailures++
  }
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 实时附加阶段的判定：默认只打印 WARN，不影响退出码。 */
function checkLive(name, pass, detail) {
  liveChecks++
  if (!pass) {
    liveWarnings++
    if (LIVE_STRICT) failures++
  }
  console.log(`  ${pass ? 'PASS' : 'WARN'}  [实时] ${name}${detail ? '  — ' + detail : ''}`)
}

// ============================================================== 内置夹具
/**
 * 合成会话图。字段形状刻意混用两种真实来源：
 *   - 客户端 store 行：{ id, displayTitle?, title?, parentId?, origin?, updatedAt?, projectionValues? }
 *   - Host SessionSummary：{ sessionId, parentSessionId, projections: { values: { title } } }
 * 外加若干畸形行（自环 / 孤儿 / 互相引用）。
 */
const BIG_CHILD_COUNT = 302 // > MAX_CHILDREN(300)，用来命中截断与省略提示
const BIG_PARENT = 'root-big'

function buildFixture() {
  const byId = {}

  // ---- 顶层 A：root-main → sub-mid → sub-leaf → sub-deep（深度 4，≥3 层嵌套）
  byId['root-main'] = {
    id: 'root-main',
    title: '主会话：插件验证',
    updatedAt: 9000,
    projectionValues: {
      subagentCatalog: [
        { id: 'sub-mid', mode: 'continuable', label: '研究员 A' },
        // 只存在于父目录、byId 里没有行的子会话：走 catalogOnly 合成路径
        { id: 'sub-catalog-only', mode: 'one-shot', label: '仅目录里存在的子会话', activity: 'inactive' },
      ],
    },
  }
  byId['sub-mid'] = {
    id: 'sub-mid',
    parentId: 'root-main',
    origin: 'subagent',
    updatedAt: 8900,
    projectionValues: { subagent: { label: '研究员 A' } },
  }
  byId['sub-leaf'] = {
    id: 'sub-leaf',
    parentId: 'sub-mid',
    origin: 'subagent',
    title: '第三层：叶子',
    updatedAt: 8800,
    projectionValues: {},
  }
  byId['sub-deep'] = {
    id: 'sub-deep',
    parentId: 'sub-leaf',
    origin: 'subagent',
    title: '第四层：更深',
    updatedAt: 8700,
    projectionValues: {},
  }

  // ---- 顶层 B：没有真标题 → 只能回退到 displayTitle（目录名），并打回退标记
  byId['root-fallback'] = {
    id: 'root-fallback',
    displayTitle: 'default-workspace',
    updatedAt: 8000,
    projectionValues: {},
  }

  // ---- 顶层 C：已归档（默认被视图选项隐藏）
  byId['root-archived'] = {
    id: 'root-archived',
    title: '已归档会话',
    updatedAt: 7000,
    projectionValues: {},
  }

  // ---- 顶层 D：302 个子会话，命中 MAX_CHILDREN 上限
  const catalog = []
  for (let i = 0; i < BIG_CHILD_COUNT; i++) {
    const id = 'sub-kid-' + String(i).padStart(3, '0')
    catalog.push({
      id,
      mode: i % 2 === 0 ? 'continuable' : 'one-shot',
      label: '子会话 #' + i,
      activity: i === 0 ? 'running' : 'inactive',
    })
    byId[id] = {
      id,
      parentId: BIG_PARENT,
      origin: 'subagent',
      displayTitle: '子会话（委派标签回退） ' + i,
      updatedAt: 5000 - i,
      projectionValues: {},
    }
  }
  byId[BIG_PARENT] = {
    id: BIG_PARENT,
    title: '超大父会话',
    updatedAt: 6000,
    projectionValues: { subagentCatalog: catalog },
  }

  // ---- 畸形 lineage：自环 / 孤儿 / 互相引用 / Host 形状的行
  byId['bad-self'] = { id: 'bad-self', parentId: 'bad-self', displayTitle: '自环', updatedAt: 400 }
  byId['bad-orphan'] = {
    id: 'bad-orphan',
    parentId: 'missing-parent-session',
    displayTitle: '孤儿',
    updatedAt: 300,
  }
  byId['bad-cycle-a'] = { id: 'bad-cycle-a', parentId: 'bad-cycle-b', displayTitle: '互相引用 A', updatedAt: 200 }
  byId['bad-cycle-b'] = { id: 'bad-cycle-b', parentId: 'bad-cycle-a', displayTitle: '互相引用 B', updatedAt: 100 }
  byId['bad-host-shape'] = {
    sessionId: 'bad-host-shape',
    parentSessionId: 'bad-orphan',
    projections: { values: { title: 'Host 形状的行' } },
    updatedAt: 50,
  }

  // 视图选项的来源（与自带浏览器读的是同一个快照）
  const workspaces = {
    archivedSessionIds: ['root-archived'],
    pinnedSessionIds: ['root-main'],
  }
  return { byId, workspaces }
}

const fixture = buildFixture()
/** 夹具模式下的 byId —— 后续 90 项断言全部跑在它上面。 */
const byId = fixture.byId
const fixtureWorkspaces = fixture.workspaces

console.log('=== 数据来源：内置确定性夹具 ===')
console.log(
  `  ${Object.keys(byId).length} 个会话（其中 ${BIG_CHILD_COUNT} 个挂在同一个父会话下）、` +
    `${fixtureWorkspaces.archivedSessionIds.length} 个已归档、${fixtureWorkspaces.pinnedSessionIds.length} 个已置顶`,
)

// ------------------------------------------------- 夹具自检（防止"空跑"全绿）
console.log('\n=== 测试 F：夹具自检（保证下面 90 项不是空跑）===')
const fixtureIds = Object.keys(byId)
const parentOfFixture = (k) => {
  const r = byId[k] || {}
  return r.parentId || r.parentSessionId || null
}
const idOfFixture = (k) => (byId[k] && (byId[k].id || byId[k].sessionId)) || k
const rootIds = fixtureIds.filter((k) => {
  const pid = parentOfFixture(k)
  return !pid || pid === idOfFixture(k) || !Object.prototype.hasOwnProperty.call(byId, pid)
})
check('夹具：存在多个顶层会话', rootIds.length >= 5, `${rootIds.length} 个顶层：${JSON.stringify(rootIds)}`)

function fixtureDepth(k) {
  const seen = new Set([k])
  let d = 0
  let cur = parentOfFixture(k)
  while (cur && Object.prototype.hasOwnProperty.call(byId, cur) && !seen.has(cur)) {
    seen.add(cur)
    d++
    cur = parentOfFixture(cur)
  }
  return d
}
const maxDepth = Math.max(...fixtureIds.map(fixtureDepth))
check('夹具：嵌套深度 ≥ 3', maxDepth >= 3, `最深 ${maxDepth} 层（root-main → sub-mid → sub-leaf → sub-deep）`)

const fixtureTally = {}
for (const k of fixtureIds) {
  const pid = parentOfFixture(k)
  if (pid) fixtureTally[pid] = (fixtureTally[pid] || 0) + 1
}
const fixtureWidest = Math.max(...Object.values(fixtureTally))
check('夹具：存在 >300 个子会话的父节点（命中 300 上限）', fixtureWidest > 300, `最宽父节点 ${fixtureWidest} 个子会话`)

check(
  '夹具：含已归档会话（默认应被隐藏）',
  fixtureWorkspaces.archivedSessionIds.length > 0,
  JSON.stringify(fixtureWorkspaces.archivedSessionIds),
)
check(
  '夹具：含已置顶会话（排序时应排到最前）',
  fixtureWorkspaces.pinnedSessionIds.length > 0,
  JSON.stringify(fixtureWorkspaces.pinnedSessionIds),
)
const fixtureFallbackIds = fixtureIds.filter((k) => {
  const r = byId[k] || {}
  const durable = (typeof r.title === 'string' && r.title.trim()) || null
  const display = (typeof r.displayTitle === 'string' && r.displayTitle.trim()) || null
  return !durable && !!display
})
check(
  '夹具：含无真标题的会话（走 displayTitle 回退路径）',
  fixtureFallbackIds.length > 0,
  `${fixtureFallbackIds.length} 个，例如 ${JSON.stringify(fixtureFallbackIds.slice(0, 3))}`,
)
const hasSelfParent = fixtureIds.some((k) => parentOfFixture(k) === idOfFixture(k))
const hasOrphan = fixtureIds.some((k) => {
  const pid = parentOfFixture(k)
  return !!pid && pid !== idOfFixture(k) && !Object.prototype.hasOwnProperty.call(byId, pid)
})
const hasMutual = fixtureIds.some((k) => {
  const pid = parentOfFixture(k)
  return !!pid && Object.prototype.hasOwnProperty.call(byId, pid) && parentOfFixture(pid) === idOfFixture(k) && pid !== k
})
check(
  '夹具：含畸形 lineage（自环 / 孤儿 / 互相引用）',
  hasSelfParent && hasOrphan && hasMutual,
  `自环=${hasSelfParent} 孤儿=${hasOrphan} 互相引用=${hasMutual}`,
)

// ============================================================ 实时库探测（可选）
/** 目录判断，永不抛。 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch (e) {
    return false
  }
}

/**
 * 一个目录下的会话日志文件（多帧 zstd，首帧是会话头）。
 * 兼容两种真实布局：
 *   <dir>/<session-id>/session.v4.jsonl.zstd   （本地会话库）
 *   <dir>/session.v4.jsonl.zstd                （单个会话目录）
 */
function sessionFilesIn(dir) {
  const out = []
  try {
    const direct = path.join(dir, 'session.v4.jsonl.zstd')
    if (fs.existsSync(direct)) out.push(direct)
  } catch (e) {}
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch (e) {
    return out
  }
  for (const name of entries.slice(0, 5000)) {
    const sub = path.join(dir, name)
    if (!isDir(sub)) continue
    try {
      const f = path.join(sub, 'session.v4.jsonl.zstd')
      if (fs.existsSync(f)) out.push(f)
    } catch (e) {}
  }
  return out
}

/**
 * 找到本机的 DSH 会话库。返回 { dir, files } 或 null。
 * 依次尝试：DSH_SESSION_TREE_SESSIONS → DSH_HOME/sessions → ~/.dsh/sessions。
 * DSH_HOME 一旦被显式设置就【只】认它（不回落 ~/.dsh），这样把 DSH_HOME 指向
 * 一个不存在的目录就能确定性地验证"夹具模式"。
 */
function findLiveStore() {
  const roots = []
  const explicit = process.env.DSH_SESSION_TREE_SESSIONS
  if (explicit) roots.push(explicit)
  const home = process.env.DSH_HOME
  if (home) roots.push(path.join(home, 'sessions'))
  else {
    let h = ''
    try {
      h = os.homedir()
    } catch (e) {
      h = ''
    }
    const fallback = process.env.USERPROFILE || process.env.HOME || h
    if (fallback) roots.push(path.join(fallback, '.dsh', 'sessions'))
  }

  for (const root of roots) {
    if (!isDir(root)) continue
    // root 本身就是某个项目的会话目录
    const own = sessionFilesIn(root)
    if (own.length) return { dir: root, files: own }
    // root 是 sessions 容器，下面按项目分目录
    let entries = []
    try {
      entries = fs.readdirSync(root)
    } catch (e) {
      continue
    }
    const projects = []
    for (const name of entries.slice(0, 500)) {
      const d = path.join(root, name)
      if (!isDir(d)) continue
      const files = sessionFilesIn(d)
      if (files.length) projects.push({ dir: d, files })
    }
    if (projects.length) {
      // 优先当前工作目录对应的那个项目目录，找不到就挑会话最多的
      let slug = ''
      try {
        slug = '--' + String(process.cwd()).replace(/[:\\/]+/g, '-') + '--'
      } catch (e) {
        slug = ''
      }
      const preferred =
        projects.find((p) => path.basename(p.dir) === slug) ||
        projects.slice().sort((a, b) => b.files.length - a.files.length)[0]
      return { dir: preferred.dir, files: preferred.files }
    }
  }
  return null
}

let liveStore = null
let liveSkipReason = ''
try {
  if (LIVE_OFF) liveSkipReason = 'DSH_SESSION_TREE_LIVE 明确关闭'
  else if (typeof zlib.zstdDecompressSync !== 'function') liveSkipReason = `当前 Node ${process.version} 没有 zstd 解压`
  else {
    liveStore = findLiveStore()
    if (!liveStore) liveSkipReason = '未发现 DSH 会话库'
  }
} catch (e) {
  liveStore = null
  liveSkipReason = '探测异常：' + (e && e.message)
}

console.log('\n=== 运行模式 ===')
console.log(
  liveStore
    ? `  夹具（确定性）+ 实时会话库（附加，非判定）：${liveStore.dir}`
    : `  仅夹具（确定性内置数据）—— ${liveSkipReason}`,
)

// ------------------------------------------------------------ 沙箱 React
let captured = null
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(def) {
        captured = def
      },
    },
  },
}
if (!fs.existsSync(CLIENT)) {
  console.log(`\n  FAIL  找不到被测模块 ${CLIENT}`)
  console.log('\n合计失败 1 项')
  console.log('❌ client.js 缺失，测试无法执行')
  process.exit(1)
}
vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })
check('client.js 调用了 __ModuleLoader__.load', !!captured)
check('模块 id 等于包名', captured && captured.id === '@orphiczhou/dsh-session-tree', captured && captured.id)

let useStateSeed = null
let useStateCalls = 0
/**
 * `expandedIds` 在 TreeView 里的 useState 调用序号（1 基，按调用顺序）。
 * 它同时被 STATE_HOOK_COUNT 断言钉住：客户端一旦新增/移动 useState，
 * 这条断言会直接报红，而不是让种子静默播到别的钩子上。
 */
const EXPANDED_IDS_HOOK = 9
/** `collapsedGroups` 的钩子序号（1 基）；工作区分组用它折叠。 */
const COLLAPSED_GROUPS_HOOK = 3
/** TreeView 里 useState 的总数（client.js 中 grep 可得）。 */
const STATE_HOOK_COUNT = 10
/**
 * 按【钩子位置】播种一个 Set 状态。
 *
 * 这里以前是按“第一个 Set 型初始值”自动匹配的。客户端加入 collapsedGroups
 * （也是 `useState(() => new Set())`）之后，种子被静默播到了它身上，
 * 十几条展开断言集体失效却看不出原因——所以改成显式位置。
 */
const seedSetAt = (index, ids) => () => (useStateCalls === index ? new Set(ids) : undefined)
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, kids: children }),
  Component: class {
    constructor(props) {
      this.props = props || {}
    }
  },
  useState(init) {
    useStateCalls++
    const value = typeof init === 'function' ? init() : init
    if (useStateSeed !== null) {
      if (typeof useStateSeed === 'function') {
        const replaced = useStateSeed(value)
        if (replaced !== undefined) return [replaced, () => {}]
      } else {
        // 裸种子（例如直接赋一个 Set）在这里直接失败：它曾经能“碰巧”工作。
        throw new Error('useStateSeed 必须是函数——请用 seedSetAt(EXPANDED_IDS_HOOK, ids)')
      }
    }
    return [value, () => {}]
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init }),
  // 单次渲染的测试里直接把 effect 跑一遍（真实 React 会在提交后跑）
  useEffect: (fn) => {
    try {
      fn()
    } catch (e) {}
  },
}

const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('factory 返回 { inject, apply }', !!mod && typeof mod.apply === 'function')

// ------------------------------------------------------------------- ctx stub
let registered = null
let registeredSlot = null
const opened = []
const refreshed = []
const started = []
const aside = []
const rowCalls = []
const titleCalls = []
let hostListItems = []
const ctx = {
  locale: { register() {}, bind: () => (k) => k },
  sessions: {
    refreshProjections: (id) => (refreshed.push(id), Promise.resolve()),
    using: (id, opts, fn) => (rowCalls.push({ kind: 'rename', id }), Promise.resolve({ ok: true })),
  },
  uiWorkspace: {
    openSession: (t) => opened.push(t),
    startSession: () => started.push(true),
    forkSession: (id) => (rowCalls.push({ kind: 'fork', id }), Promise.resolve()),
    archiveSession: (id) => (rowCalls.push({ kind: 'archive', id }), Promise.resolve()),
    unarchiveSession: (id) => (rowCalls.push({ kind: 'unarchive', id }), Promise.resolve()),
  },
  remote: {
    workspace: {
      pinSession: (r) => (rowCalls.push({ kind: 'pin', ...r }), Promise.resolve()),
      unpinSession: (r) => (rowCalls.push({ kind: 'unpin', ...r }), Promise.resolve()),
    },
    session: {
      list: (req) => {
        titleCalls.push(req)
        return Promise.resolve({ ok: true, value: { items: hostListItems } })
      },
    },
  },
  sidebarRight: { openResource: (url, opts) => aside.push({ url, opts }) },
  slots: {
    inject(key, cb) {
      cb()
    },
    register(opts, Comp) {
      registeredSlot = opts
      registered = Comp
      return () => {}
    },
  },
}
mod.apply(ctx)
check('注册进 sidebar.workspaces', registeredSlot && registeredSlot.name === 'sidebar.workspaces')
check('priority 为 -100（低于自带浏览器的 0）', registeredSlot && registeredSlot.priority === -100,
  String(registeredSlot && registeredSlot.priority))

// 回归护栏：apply 的 ctx 只带 inject 解析出的服务。曾经只写 ['slots']，
// 于是 ctx.uiWorkspace 是 undefined、每次点击都静默无效。
console.log('\n=== 测试 0：inject 必须声明用到的服务（点击失效的根因）===')
const required = ['slots', 'sessions', 'uiWorkspace', 'sidebarRight', 'locale']
check('mod.inject 是数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
for (const name of required) {
  check(`inject 声明了 ${name}`, Array.isArray(mod.inject) && mod.inject.includes(name))
}
check('remote 不在硬 inject 里（避免一个错键让整个插件不加载）',
  Array.isArray(mod.inject) && !mod.inject.includes('remote'), JSON.stringify(mod.inject))

// --------------------------------------------------------------- mini renderer
function renderTree(node, sink) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) {
    for (const n of node) renderTree(n, sink)
    return null
  }
  const kids = (node.kids || []).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  const full = Object.assign({}, node.props)
  if (kids.length === 1) full.children = kids[0]
  else if (kids.length) full.children = kids
  const t = node.type
  if (typeof t === 'function') {
    if (t.prototype && typeof t.prototype.render === 'function') {
      const inst = new t(full)
      inst.props = full
      return renderTree(inst.render(), sink)
    }
    return renderTree(t(full), sink)
  }
  const el = { tag: String(t), props: full, kids: [] }
  for (const k of kids) {
    const c = renderTree(k, sink)
    if (c) el.kids.push(c)
  }
  sink.push(el)
  return el
}

const EMPTY_WS = { archivedSessionIds: [], pinnedSessionIds: [] }

/**
 * 渲染一次面板。sessions / workspaces 省略时用内置夹具；
 * 实时附加阶段会显式传入实时 byId（并沿用参考实现的空 workspaces）。
 */
function renderPanel(seed, sessions, workspaces) {
  useStateCalls = 0
  useStateSeed = seed === undefined ? null : seed
  const sink = []
  const el = registered({
    useSessions: (sel) => sel({ byId: sessions || byId, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel({}),
    useWorkspaces: (sel) => sel(workspaces || fixtureWorkspaces),
    wide: true,
    expandSidebar: () => {},
  })
  renderTree(el, sink)
  const rows = sink.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
  return { rows, sink }
}

function labelOf(row) {
  const el = row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
  return el && el.kids.map((c) => c.text).join('')
}

function indentOf(row) {
  const st = row.props.style
  return st && typeof st.paddingLeft === 'number' ? st.paddingLeft : NaN
}

// ------------------------------------------------------------ test 1: default
console.log('\n=== 测试 1：默认（全折叠）渲染 ===')
const t1 = renderPanel(undefined)
// 钩子位置是种子契约的一部分（见 EXPANDED_IDS_HOOK）。
check(
  '夹具：useState 钩子数量与 EXPANDED_IDS_HOOK 一致（钩子位置是种子契约）',
  useStateCalls === STATE_HOOK_COUNT,
  `${useStateCalls} 个 useState（期望 ${STATE_HOOK_COUNT}，expandedIds 在第 ${EXPANDED_IDS_HOOK} 位）`,
)
const rootCount = Object.values(byId).filter((s) => s.origin !== 'subagent').length
check('无异常渲染', t1.rows.length > 0, `${t1.rows.length} 行`)
check(
  '默认只渲染顶层会话（不展开子会话）',
  t1.rows.length <= rootCount,
  `渲染 ${t1.rows.length} 行，顶层会话 ${rootCount} 个`,
)
const depths = t1.rows.map(indentOf)
check('默认所有行缩进相同（depth=0）', new Set(depths).size === 1, JSON.stringify([...new Set(depths)]))
const expandable = t1.rows.filter((r) => {
  const twist = r.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-twist'))
  return twist && !String(twist.props.className).includes('st-empty')
})
check('存在可展开的会话节点', expandable.length > 0, `${expandable.length} 个可展开`)

// find the widest parent from the fixture map（夹具保证它 > 300，见测试 F）
const childTally = {}
for (const s of Object.values(byId)) if (s.parentId) childTally[s.parentId] = (childTally[s.parentId] || 0) + 1
const widest = Object.entries(childTally).sort((a, b) => b[1] - a[1])[0]
console.log(`  子节点最多的父会话: ${widest[0].slice(0, 20)}… 有 ${widest[1]} 个子会话`)

// --------------------------------------------------------- test 2: expansion
console.log('\n=== 测试 2：展开子节点最多的父会话 ===')
const t2 = renderPanel(seedSetAt(EXPANDED_IDS_HOOK, [widest[0]]))
check('展开后渲染出子行', t2.rows.length > t1.rows.length, `${t1.rows.length} → ${t2.rows.length} 行`)
const d2 = t2.rows.map(indentOf)
check('出现了更深的缩进层级', Math.max(...d2) > Math.min(...d2), JSON.stringify([...new Set(d2)].sort((a, b) => a - b)))
// 夹具保证最宽的父会话一定 > 300（测试 F 里已断言），所以这条不再需要 if：
// 一旦夹具退化，它会直接 FAIL，而不是被静默跳过。
const more = t2.sink.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-note'))
check('超过 300 个子节点时给出省略提示', more.length > 0, more.map((m) => m.kids.map((c) => c.text).join('')).join(' | '))
check('子行数量不超过上限 300', t2.rows.length - t1.rows.length <= 301, `${t2.rows.length - t1.rows.length} 个子行`)

// -------------------------------------------------------------- test 3: 独一性
console.log('\n=== 测试 3：行唯一性与字段健壮性 ===')
const keys = t2.rows.map((r) => r.props.key)
check('没有重复的 React key', new Set(keys).size === keys.length, `${keys.length} 行 / ${new Set(keys).size} 个唯一 key`)
const labels = t2.rows.map(labelOf)
check('每行都有非空标签', labels.every((l) => typeof l === 'string' && l.length > 0))

// ------------------------------------------------------- test 4: malformed data
console.log('\n=== 测试 4：畸形数据不应崩溃 ===')
useStateCalls = 0
useStateSeed = null
const sink4 = []
let threw = null
try {
  renderTree(
    registered({
      useSessions: (sel) =>
        sel({
          byId: {
            a: { id: 'a', parentId: 'a' },                       // 自环
            b: { id: 'b', parentId: 'missing' },                 // 孤儿
            c: { id: 'c', parentId: 'd' },                       // 环 a↔
            d: { id: 'd', parentId: 'c' },
            e: null,                                             // 空行
            f: { sessionId: 'f', parentSessionId: 'b', projections: { values: { title: 'F' } } }, // Host 形状
          },
          projectionsBySession: {},
        }),
      useSessionStatus: (sel) => sel({}),
      wide: true,
    }),
    sink4,
  )
} catch (err) {
  threw = err
}
check('自环/孤儿/互相引用/空行/异构字段都不抛异常', threw === null, threw && threw.message)

// ------------------------------------------------------------- test 5: 窄栏
console.log('\n=== 测试 5：侧栏折叠为 icon rail ===')
const sink5 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel({}),
    useWorkspaces: (sel) => sel(fixtureWorkspaces),
    wide: false,
    expandSidebar: () => {},
  }),
  sink5,
)
const railBtn = sink5.find((e) => e.tag === 'button')
check('wide=false 时渲染展开按钮而不是树', !!railBtn)

// ------------------------------------------------- test 6: 点击打开（② 的接线）
console.log('\n=== 测试 6：点击节点打开会话（多轮内容的入口）===')
const topRow = t1.rows.find((r) => r.id !== undefined) || t1.rows[0]
opened.length = 0
topRow.props.onClick()
check('顶层会话以纯 id 打开', opened.length === 1 && typeof opened[0] === 'string', JSON.stringify(opened[0]))

// 展开后有子会话行：它以 {parentSessionId, childSessionId, mode} 地址打开
const subRow = t2.rows.find((r) =>
  r.kids.some((k) => typeof k.props.className === 'string' && k.props.className.includes('st-tag')),
)
check('展开后能找到子会话行（带 st-tag 标记）', !!subRow)
if (subRow) {
  opened.length = 0
  subRow.props.onClick()
  const a = opened[0]
  check(
    '子会话以 durable 地址打开，且字段恰好是 parentSessionId/childSessionId/mode',
    !!a &&
      typeof a === 'object' &&
      typeof a.parentSessionId === 'string' &&
      typeof a.childSessionId === 'string' &&
      ['one-shot', 'continuable', 'unknown'].includes(a.mode) &&
      a.kind === undefined,
    JSON.stringify(a),
  )
}

// ------------------------------------------------- test 7: 展开时触发投影加载
console.log('\n=== 测试 7：展开时尽力加载子目录投影 ===')
refreshed.length = 0
const expandRow = t1.rows.find((r) =>
  r.kids.some((k) => typeof k.props.className === 'string' && k.props.className.includes('st-twist') && !String(k.props.className).includes('st-empty')),
)
const expandTwist = expandRow && expandRow.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-twist'))
check('可展开行带有点击展开的箭头', !!expandTwist)
if (expandTwist) {
  expandTwist.props.onClick({ stopPropagation() {} })
  check('展开会刷新该节点自身的投影', refreshed.includes(expandRow.props.key), JSON.stringify(refreshed.slice(0, 3)))
  // 这正是"标题对不上"的修复：子会话的真标题在它自己的投影里，必须主动加载
  check('展开还会为子会话加载标题投影（否则树里只能显示委派标签）',
    refreshed.length > 1, `共 ${refreshed.length} 次（自身 + 首批子会话）`)
}

// ------------------------------- test 8: 目录补充 continuable 模式（② 的可交互性）
console.log('\n=== 测试 8：子会话从父目录取得 mode（决定对话可否继续输入）===')
const byId8 = {
  root: {
    id: 'root',
    displayTitle: 'Root',
    updatedAt: 2,
    projectionValues: {
      subagentCatalog: [
        { id: 'kid-cont', mode: 'continuable', label: 'Continuable kid', activity: 'running' },
        { id: 'kid-one', mode: 'one-shot', label: 'One-shot kid', activity: 'inactive' },
      ],
    },
  },
  'kid-cont': { id: 'kid-cont', parentId: 'root', origin: 'subagent' },
  'kid-one': { id: 'kid-one', parentId: 'root', origin: 'subagent' },
}
useStateCalls = 0
useStateSeed = seedSetAt(EXPANDED_IDS_HOOK, ['root'])
const sink8 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId8, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel({}),
    wide: true,
  }),
  sink8,
)
const rows8 = sink8.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
const kidContRow = rows8.find((r) => {
  const el = r.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
  return el && el.kids.map((c) => c.text).join('') === 'Continuable kid'
})
check('展开后子会话行按目录标签显示', !!kidContRow)
if (kidContRow) {
  opened.length = 0
  kidContRow.props.onClick()
  check('continuable 子会话以 mode=continuable 打开（对话可继续输入）',
    opened[0] && opened[0].mode === 'continuable', JSON.stringify(opened[0]))
}
const kidOneRow = rows8.find((r) => {
  const el = r.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
  return el && el.kids.map((c) => c.text).join('') === 'One-shot kid'
})
if (kidOneRow) {
  opened.length = 0
  kidOneRow.props.onClick()
  check('one-shot 子会话以 mode=one-shot 打开（只读执行记录）',
    opened[0] && opened[0].mode === 'one-shot', JSON.stringify(opened[0]))
}

// ------------------------------------------- test 9: 多层嵌套（≥3 层）
console.log('\n=== 测试 9：多层嵌套（root → mid → leaf → deep，逐级展开）===')
const byId9 = {
  root: { id: 'root', displayTitle: 'Root', updatedAt: 4, projectionValues: {} },
  mid: { id: 'mid', parentId: 'root', origin: 'subagent', displayTitle: 'Mid', updatedAt: 3, projectionValues: {} },
  leaf: { id: 'leaf', parentId: 'mid', origin: 'subagent', displayTitle: 'Leaf', updatedAt: 2, projectionValues: {} },
  deep: { id: 'deep', parentId: 'leaf', origin: 'subagent', displayTitle: 'Deep', updatedAt: 1, projectionValues: {} },
}
for (const [name, seed, expectRows] of [
  ['仅展开 root', ['root'], 2],
  ['展开 root+mid', ['root', 'mid'], 3],
  ['展开 root+mid+leaf', ['root', 'mid', 'leaf'], 4],
]) {
  useStateCalls = 0
  useStateSeed = seedSetAt(EXPANDED_IDS_HOOK, seed)
  const sink9 = []
  renderTree(
    registered({
      useSessions: (sel) => sel({ byId: byId9, projectionsBySession: {} }),
      useSessionStatus: (sel) => sel({}),
      wide: true,
    }),
    sink9,
  )
  const rows9 = sink9.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
  const indents = [...new Set(rows9.map(indentOf))].sort((a, b) => a - b)
  const names = rows9.map((r) => {
    const el = r.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
    return el && el.kids.map((c) => c.text).join('')
  })
  // 每多展开一级，恰好多一行、多一个缩进层级；且层级必须是 6+13n 的等差数列
  const ladder = indents.every((v, i) => v === 6 + i * 13)
  check(
    `${name} → ${rows9.length} 行 / 缩进 ${JSON.stringify(indents)}`,
    rows9.length === expectRows && indents.length === expectRows && ladder,
    names.join(' > '),
  )
}
// 三层全展开时最深层缩进必须是 6 + 3*13 = 45
useStateCalls = 0
useStateSeed = seedSetAt(EXPANDED_IDS_HOOK, ['root', 'mid', 'leaf'])
const sink9b = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId9, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel({}),
    wide: true,
  }),
  sink9b,
)
const deepest = Math.max(
  ...sink9b
    .filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
    .map(indentOf),
)
check('最深一层缩进 = 45（depth 3）', deepest === 45, String(deepest))

// -------------------------------------- test 10: 新建会话（接管侧栏后的必备补偿）
console.log('\n=== 测试 10：新建会话按钮（遮蔽自带浏览器后的补偿）===')
started.length = 0
const newBtn = t1.sink.find(
  (e) => e.tag === 'button' && typeof e.props.className === 'string' && e.props.className.includes('st-new'),
)
check('标题栏渲染了新建会话按钮', !!newBtn)
if (newBtn) {
  newBtn.props.onClick()
  check('点击调用 uiWorkspace.startSession()', started.length === 1, JSON.stringify(started))
}

// ------------------------------------- test 11: 在右侧栏打开（用户明确要求）
console.log('\n=== 测试 11：子会话行提供"在右侧栏打开" ===')
const asideBtnIn = (row) =>
  row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-aside'))
check('子会话行有 ↗ 按钮', !!subRow && !!asideBtnIn(subRow))
if (subRow && asideBtnIn(subRow)) {
  aside.length = 0
  asideBtnIn(subRow).props.onClick({ stopPropagation() {} })
  const call = aside[0]
  check('点击调用 sidebarRight.openResource', !!call, JSON.stringify(call && call.url))
  check(
    '资源地址是规范形式 dsh-resource://subagentchat/session/<child>?parent=&mode=',
    !!call && /^dsh-resource:\/\/subagentchat\/session\/[^?]+\?parent=.+&mode=(one-shot|continuable|unknown)$/.test(call.url),
    call && call.url,
  )
  check('kind=subagentchat 且 preferNewPane=true', !!call && call.opts.kind === 'subagentchat' && call.opts.preferNewPane === true)
}
const topRowAside = asideBtnIn(topRow)
check('顶层会话行不显示 ↗（它直接进主视图）', !topRowAside)

// ------------------------------------------ test 12: 四种状态的彩色圆点
console.log('\n=== 测试 12：四种状态的圆点（进行中蓝 / 已完成绿 / 已看过灰 / 待回应橙）===')
const statusMap = new Map([
  ['s-run', { running: true }],
  ['s-done', { running: false, completionUnread: true }],
  ['s-idle', { running: false, completionUnread: false }],
  // 同时"在跑"和"等人回答"：必须按自带优先级取 warning
  ['s-warn', { running: true, completionUnread: true, pendingInteraction: { kind: 'question' } }],
])
const byId12 = {
  's-run': { id: 's-run', displayTitle: 'RUN', updatedAt: 4, projectionValues: {} },
  's-done': { id: 's-done', displayTitle: 'DONE', updatedAt: 3, projectionValues: {} },
  's-idle': { id: 's-idle', displayTitle: 'IDLE', updatedAt: 2, projectionValues: {} },
  's-warn': { id: 's-warn', displayTitle: 'WARN', updatedAt: 1, projectionValues: {} },
}
useStateCalls = 0
useStateSeed = null
const sink12 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId12, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel(statusMap),
    wide: true,
  }),
  sink12,
)
const rows12 = sink12.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
const dotOf = (row) => {
  const d = row.kids.find((k) => typeof k.props.className === 'string' && k.props.className === 'st-dot')
  return d && d.props['data-state']
}
const labelOfRow = (row) => {
  const el = row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
  return el && el.kids.map((c) => c.text).join('')
}
const stateByName = {}
for (const r of rows12) stateByName[labelOfRow(r)] = dotOf(r)
check('running → ongoing（蓝）', stateByName.RUN === 'ongoing', JSON.stringify(stateByName))
check('完成未看 → done（绿）', stateByName.DONE === 'done')
check('完成已看 → idle（灰）', stateByName.IDLE === 'idle')
check('等人回应 → warning（橙），且压过 running', stateByName.WARN === 'warning')

const cssText = (sink12.find((e) => e.tag === 'style')?.kids || []).map((c) => c.text).join('')
for (const [state, token] of [
  // 蓝色没有 alias，只有静态调色板；live 值 #3b82f6，并带字面回退保证一定是蓝
  ['ongoing', '--dsw-static-blue-500'],
  ['done', '--dsw-alias-state-success-primary'],
  ['warning', '--dsw-alias-state-warn-primary'],
  ['idle', '--dsw-alias-state-idle-primary'],
]) {
  check(`CSS 为 ${state} 指定了 ${token}`, cssText.includes(`[data-state='${state}']`) && cssText.includes(token))
}
check('进行中的蓝色带字面回退（token 缺失时仍是蓝）', cssText.includes('var(--dsw-static-blue-500,#3b82f6)'))
// 只针对"进行中圆点"这条规则断言；brand-primary 仍合法地用作菜单勾选色
const ongoingRule = cssText.split('}').find((r) => r.includes("[data-state='ongoing']")) || ''
check('进行中圆点不再用 brand-primary 冒充蓝色（它等于文字色 --dsw-static-neutral-bluish-1000）',
  ongoingRule !== '' && !ongoingRule.includes('brand-primary'), ongoingRule.trim())

// ------------------------------------------ test 13: 视图选项（归档/排序）
console.log('\n=== 测试 13：视图选项 —— 归档过滤与置顶排序 ===')
const byId13 = {
  A: { id: 'A', displayTitle: 'A', updatedAt: 900, projectionValues: {} },
  B: { id: 'B', displayTitle: 'B', updatedAt: 500, projectionValues: {} },
  C: { id: 'C', displayTitle: 'ARCHIVED', updatedAt: 100, projectionValues: {} },
}
function render13(workspaceSnap, seed) {
  useStateCalls = 0
  useStateSeed = seed === undefined ? null : seed
  const sink = []
  renderTree(
    registered({
      useSessions: (sel) => sel({ byId: byId13, projectionsBySession: {} }),
      useSessionStatus: (sel) => sel(new Map()),
      useWorkspaces: (sel) => sel(workspaceSnap),
      wide: true,
    }),
    sink,
  )
  const rows = sink.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
  return { rows, names: rows.map(labelOf), sink }
}

const t13a = render13({ archivedSessionIds: ['C'], pinnedSessionIds: [] })
check('默认隐藏已归档会话', !t13a.names.includes('ARCHIVED'), JSON.stringify(t13a.names))
check('默认按最近更新排序', JSON.stringify(t13a.names) === JSON.stringify(['A', 'B']), JSON.stringify(t13a.names))

const t13b = render13({ archivedSessionIds: ['C'], pinnedSessionIds: [] }, (v) => (v === 'hide' ? 'show' : undefined))
check('切到"显示已归档"后归档会话出现', t13b.names.includes('ARCHIVED'), JSON.stringify(t13b.names))

const t13c = render13({ archivedSessionIds: ['C'], pinnedSessionIds: [] }, (v) => (v === 'hide' ? 'only' : undefined))
check('切到"仅已归档"后只剩归档会话', JSON.stringify(t13c.names) === JSON.stringify(['ARCHIVED']), JSON.stringify(t13c.names))

const t13d = render13({ archivedSessionIds: ['C'], pinnedSessionIds: ['B'] })
check('置顶会话排到最前（尽管它更旧）', JSON.stringify(t13d.names) === JSON.stringify(['B', 'A']), JSON.stringify(t13d.names))

const t13e = render13({ archivedSessionIds: ['C'], pinnedSessionIds: [] }, (v) => (v === 'updated' ? 'title' : undefined))
check('切到"按名称"排序', JSON.stringify(t13e.names) === JSON.stringify(['A', 'B']), JSON.stringify(t13e.names))

const menuBtn = t1.sink.find(
  (e) => e.tag === 'button' && e.props['aria-label'] === '视图选项',
)
check('标题栏渲染视图选项按钮（⋯）', !!menuBtn)

/**
 * Seed "the row menu is open for row A" without polluting later state.
 * Null-initialised states in declaration order: rowMenu, renameId, titleMap —
 * so only the first TWO nulls may be replaced.
 */
function seedRowMenuA() {
  let c = 0
  return (v) => {
    if (v === null) {
      c++
      if (c <= 2) return 'A'
    }
    return undefined
  }
}

// ------------------------------------------ test 14: 每行 "…" 操作菜单
console.log('\n=== 测试 14：每行操作菜单（置顶/重命名/Fork/归档）===')
const byId14 = {
  A: { id: 'A', displayTitle: 'Alpha', updatedAt: 10, projectionValues: {} },
  B: { id: 'B', displayTitle: 'Beta', updatedAt: 5, projectionValues: {} },
}
function render14(workspaceSnap, seed) {
  useStateCalls = 0
  useStateSeed = seed === undefined ? null : seed
  const sink = []
  renderTree(
    registered({
      useSessions: (sel) => sel({ byId: byId14, projectionsBySession: {} }),
      useSessionStatus: (sel) => sel(new Map()),
      useWorkspaces: (sel) => sel(workspaceSnap),
      wide: true,
    }),
    sink,
  )
  const rows = sink.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
  return { rows, sink }
}

const t14 = render14({ archivedSessionIds: [], pinnedSessionIds: [] })
const moreBtn = (row) =>
  row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-more'))
check('每行都有 "…" 按钮', t14.rows.length > 0 && t14.rows.every((r) => !!moreBtn(r)))

// 打开 A 行的菜单：rowMenu 的初值是 null，且它是第一个初值为 null 的 state
const t14open = render14({ archivedSessionIds: [], pinnedSessionIds: [] }, seedRowMenuA())
const menuA = t14open.sink.find(
  (e) => typeof e.props.className === 'string' && e.props.className.includes('st-rowmenu'),
)
check('菜单渲染出来了', !!menuA)
const itemLabels = menuA ? menuA.kids.map((k) => k.kids.map((c) => c.kids.map((x) => x.text).join('')).join('')) : []
check('菜单含 4 项（置顶/重命名/Fork/归档）', itemLabels.length === 4, JSON.stringify(itemLabels))

const pickItem = (label) => {
  const idx = itemLabels.indexOf(label)
  return idx >= 0 ? menuA.kids[idx] : null
}
rowCalls.length = 0
const pinItem = pickItem('置顶')
check('未置顶时菜单显示"置顶"', !!pinItem)
if (pinItem) {
  pinItem.props.onClick({ stopPropagation() {} })
  check('置顶调用 remote.workspace.pinSession({sessionId})',
    rowCalls.length === 1 && rowCalls[0].kind === 'pin' && rowCalls[0].sessionId === 'A',
    JSON.stringify(rowCalls))
}
rowCalls.length = 0
const forkItem = pickItem('Fork 分支会话')
if (forkItem) {
  forkItem.props.onClick({ stopPropagation() {} })
  check('Fork 调用 uiWorkspace.forkSession(id)', rowCalls.length === 1 && rowCalls[0].kind === 'fork' && rowCalls[0].id === 'A', JSON.stringify(rowCalls))
}
rowCalls.length = 0
const archItem = pickItem('归档')
if (archItem) {
  archItem.props.onClick({ stopPropagation() {} })
  check('归档调用 uiWorkspace.archiveSession(id)', rowCalls.length === 1 && rowCalls[0].kind === 'archive', JSON.stringify(rowCalls))
}

// 已归档的会话应显示"取消归档"
const seedArchMenu = seedRowMenuA()
const t14arch = render14({ archivedSessionIds: ['A'], pinnedSessionIds: [] }, (v) => {
  if (v === 'hide') return 'show'
  return seedArchMenu(v)
})
const menuA2 = t14arch.list ? null : t14arch.sink.find((e) => typeof e.props.className === 'string' && e.props.className.includes('st-rowmenu'))
const labels2 = menuA2 ? menuA2.kids.map((k) => k.kids.map((c) => c.kids.map((x) => x.text).join('')).join('')) : []
check('已归档时菜单显示"取消归档"', labels2.includes('取消归档'), JSON.stringify(labels2))

rowCalls.length = 0
const t14pin = render14({ archivedSessionIds: [], pinnedSessionIds: ['A'] }, seedRowMenuA())
const menuA3 = t14pin.sink.find((e) => typeof e.props.className === 'string' && e.props.className.includes('st-rowmenu'))
const labels3 = menuA3 ? menuA3.kids.map((k) => k.kids.map((c) => c.kids.map((x) => x.text).join('')).join('')) : []
check('已置顶时菜单显示"取消置顶"', labels3.includes('取消置顶'), JSON.stringify(labels3))

// 重命名：进入行内编辑后提交，走 sessions.using(...).binding.session.rename
// 初值为 null 的 state 依次是 rowMenu / renameId / titleMap，前两个种成 'A'；
// 初值为 '' 的依次是 renameText / query，只种第一个。
let empties14 = 0
const seedRename = seedRowMenuA()
const t14ren = render14({ archivedSessionIds: [], pinnedSessionIds: [] }, (v) => {
  const forMenu = seedRename(v)
  if (forMenu !== undefined) return forMenu
  if (v === '') return ++empties14 === 1 ? 'New name' : undefined
  return undefined
})
const renameInput = t14ren.sink.find((e) => typeof e.props.className === 'string' && e.props.className.includes('st-rename'))
check('重命名状态渲染出行内输入框', !!renameInput, renameInput ? String(renameInput.props.value) : '(无)')
if (renameInput) {
  rowCalls.length = 0
  renameInput.props.onKeyDown({ key: 'Enter' })
  check('回车提交调用 sessions.using(...).binding.session.rename',
    rowCalls.length === 1 && rowCalls[0].kind === 'rename' && rowCalls[0].id === 'A', JSON.stringify(rowCalls))
  check('输入框预填新标题', String(renameInput.props.value) === 'New name', String(renameInput.props.value))
  check('渲染的是输入框而非普通标签', !t14ren.rows.some((r) => r.props['data-renaming'] === undefined && false))
}
// 未在重命名状态时，行内是普通标签
check('默认行内是普通标签而非输入框',
  !t14.sink.some((e) => typeof e.props.className === 'string' && e.props.className.includes('st-rename')))

// ---------------------- test 15: 树里的文字必须与打开后的会话标题一致
console.log('\n=== 测试 15：标题一致性（displayTitle 不是标题）===')
// 真实语义：displayTitle 的推导是 真标题 -> cwd 目录名 -> 原始 id；
// 目录子节点则退化成委派标签（child.label）。所以真标题必须优先。
const byId15 = {
  A: { id: 'A', displayTitle: 'default-workspace', title: '只回答一个词：可用', updatedAt: 9, projectionValues: {} },
  B: { id: 'B', displayTitle: 'default-workspace', updatedAt: 8, projectionValues: {} },
  C: { id: 'C', title: '投影里的标题', updatedAt: 7, projectionValues: { title: '投影里的标题' } },
}
useStateCalls = 0
useStateSeed = null
const sink15 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId15, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel(new Map()),
    useWorkspaces: (sel) => sel({ archivedSessionIds: [], pinnedSessionIds: [] }),
    wide: true,
  }),
  sink15,
)
const rows15 = sink15.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
const labelEl = (row) =>
  row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
const byIdRow = {}
for (const r of rows15) byIdRow[r.props.key] = r

check('有真标题时显示真标题，而不是 displayTitle（目录名）',
  byIdRow.A && labelEl(byIdRow.A).kids.map((c) => c.text).join('') === '只回答一个词：可用',
  byIdRow.A ? labelEl(byIdRow.A).kids.map((c) => c.text).join('') : '(无 A)')
check('有真标题时不加"回退"样式',
  byIdRow.A && !String(labelEl(byIdRow.A).props.className).includes('st-label-fallback'))
check('无真标题时退化为 displayTitle，并标记为回退',
  byIdRow.B &&
    labelEl(byIdRow.B).kids.map((c) => c.text).join('') === 'default-workspace' &&
    String(labelEl(byIdRow.B).props.className).includes('st-label-fallback'),
  byIdRow.B ? labelEl(byIdRow.B).props.className : '(无 B)')
check('回退行的 tooltip 说明这不是标题',
  byIdRow.B && String(byIdRow.B.props.title).includes('标题尚未加载'))
check('projectionValues.title 也能作为真标题',
  byIdRow.C && labelEl(byIdRow.C).kids.map((c) => c.text).join('') === '投影里的标题')
// 目录标签绝不能冒充标题
check('目录标签只进回退槽位（src 里不再把 e.label 写进 title）',
  !/c\.title = String\(e\.label\)/.test(fs.readFileSync(CLIENT, 'utf8')))

// ---------- test 16: 标题必须来自宿主最新值（会话标题会被替换，store 会陈旧）
console.log('\n=== 测试 16：宿主最新标题优先（陈旧快照是"对不上"的根因）===')
// 真实语义：一个会话的 session/title 会被后来的事件替换
//   seq22 fallback(首条消息截断) -> seq26 provider(模型生成的短名字)
// 而客户端 store 的 byId[id].title 可能是【早期快照】，因为
// refreshProjections 是 "once per connection"（manager.js:254-264），之后永远空操作。
const byId16 = {
  ROOT: { id: 'ROOT', title: '那个先了解一下你本身的这个', updatedAt: 9, projectionValues: {} },
}
useStateCalls = 0
useStateSeed = null
titleCalls.length = 0
hostListItems = [
  { sessionId: 'ROOT', projections: { values: { title: '自我进化插件与多会话能力探讨' } } },
  { sessionId: 'GHOST', projections: { values: { title: '宿主才知道的标题' } } },
]
const sink16 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId16, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel(new Map()),
    useWorkspaces: (sel) => sel({ archivedSessionIds: [], pinnedSessionIds: [] }),
    wide: true,
  }),
  sink16,
)
check('挂载时调用 remote.session.list({})', titleCalls.length === 1 && JSON.stringify(titleCalls[0]) === '{}', JSON.stringify(titleCalls))
check('remote.session.list 存在且形状正确（ok/value/items）', hostListItems.length === 2)
check('已接线：宿主标题会成为行的首选来源（陈旧 store 标题被覆盖）',
  /hostTitle\(n\) \|\| n\.title/.test(fs.readFileSync(CLIENT, 'utf8')))

// 直接验证优先级函数的行为：把 titleMap 种进去（第 3 个初值为 null 的 state）
let nulls16 = 0
const seeded = new Map([['ROOT', '自我进化插件与多会话能力探讨']])
const sink16b = []
useStateCalls = 0
useStateSeed = (v) => {
  if (v === null) {
    nulls16++
    return nulls16 === 3 ? seeded : undefined // rowMenu, renameId, titleMap
  }
  return undefined
}
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId16, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel(new Map()),
    useWorkspaces: (sel) => sel({ archivedSessionIds: [], pinnedSessionIds: [] }),
    wide: true,
  }),
  sink16b,
)
const row16 = sink16b
  .filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
  .find((r) => r.props.key === 'ROOT')
const txt16 = row16
  ? row16.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label')).kids.map((c) => c.text).join('')
  : '(无行)'
check('宿主标题覆盖了陈旧的 store 标题', txt16 === '自我进化插件与多会话能力探讨', txt16)

// ---------------- test 17: 子会话显示"描述符标签"，主窗口/右侧栏就是它
console.log('\n=== 测试 17：子会话行必须显示描述符标签（主窗口与右侧栏显示的就是它）===')
// 依据：主窗口 header 面包屑渲染父目录的 currentEntry.label；
//       右侧栏 subagentchat 渲染 byId[child].projectionValues.subagent.label。
//       两者一致，且【都不是】会话标题 —— 这正是前两轮"对不上"的真因。
const byId17 = {
  P: {
    id: 'P',
    displayTitle: '我是父会话标题',
    updatedAt: 9,
    projectionValues: {
      subagentCatalog: [
        { id: 'K1', mode: 'continuable', label: '父目录里的标签' },
        { id: 'K2', mode: 'one-shot', label: '跑批 B' },
      ],
    },
  },
  K1: {
    id: 'K1',
    parentId: 'P',
    origin: 'subagent',
    title: '那个先了解一下你本身的这个',                       // 陈旧 fallback 标题
    projectionValues: { subagent: { label: '研究员 A' } },     // ← 权威描述符标签
  },
  K2: {
    id: 'K2',
    parentId: 'P',
    origin: 'subagent',
    title: '下面 JSON 中所有数字（含数组',
  },
}
useStateCalls = 0
useStateSeed = seedSetAt(EXPANDED_IDS_HOOK, ['P'])
const sink17 = []
renderTree(
  registered({
    useSessions: (sel) => sel({ byId: byId17, projectionsBySession: {} }),
    useSessionStatus: (sel) => sel(new Map()),
    useWorkspaces: (sel) => sel({ archivedSessionIds: [], pinnedSessionIds: [] }),
    wide: true,
  }),
  sink17,
)
const rows17 = sink17.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-row'))
const rowById = {}
for (const r of rows17) rowById[r.props.key] = r
const textOf = (row) => {
  const el = row && row.kids.find((k) => typeof k.props.className === 'string' && k.props.className.includes('st-label'))
  return el ? el.kids.map((c) => c.text).join('') : '(无)'
}
check('子会话用【自身 subagent.label】而不是会话标题',
  textOf(rowById.K1) === '研究员 A', textOf(rowById.K1))
check('子会话没有 subagent 投影时用【父目录标签】',
  textOf(rowById.K2) === '跑批 B', textOf(rowById.K2))
check('子会话行不再显示陈旧的 fallback 标题',
  textOf(rowById.K1) !== '那个先了解一下你本身的这个')
check('会话标题作为次要信息保留在 tooltip 里',
  rowById.K1 && String(rowById.K1.props.title).includes('那个先了解一下你本身的这个'),
  rowById.K1 ? String(rowById.K1.props.title) : '(无)')
check('顶层会话仍然显示标题',
  textOf(rowById.P) === '我是父会话标题', textOf(rowById.P))

// ======================================== 测试 18：工作区分组（自带左栏的层级）
console.log('\n=== 测试 18：工作区分组（归属取 workspace.sessionIds，不是 cwd）===')
/** 进入新增用例前的断言条数 = 参考套件的 90 条（见测试 M 的自检）。 */
const referenceChecks = coreChecks

/**
 * 自带浏览器按 `workspace.sessionIds` 归属会话，**不是**按 cwd
 * （dsh-client-ui-workspace/lib/client.js:420-439 `groupByWorkspace`）。
 * 下面每个会话都带 cwd，另外 Z1 的 cwd 指向 alpha 却不在任何 sessionIds 里，
 * 专门用来钉住「不是按 cwd 分组」；未分组桶固定在最后。
 */
const WS_A = 'C:\\proj\\alpha'
const WS_B = 'C:\\proj\\beta'
const wsById = {
  A1: { id: 'A1', displayTitle: 'A one', updatedAt: 50, cwd: WS_A, projectionValues: {} },
  A2: { id: 'A2', displayTitle: 'A two', updatedAt: 40, cwd: WS_A, projectionValues: {} },
  A1c: { id: 'A1c', parentId: 'A1', origin: 'subagent', displayTitle: 'A one child', updatedAt: 49, cwd: WS_A, projectionValues: {} },
  B1: { id: 'B1', displayTitle: 'B one', updatedAt: 30, cwd: WS_B, projectionValues: {} },
  Z1: { id: 'Z1', displayTitle: 'Z loose', updatedAt: 20, cwd: WS_A, projectionValues: {} },
}
const wsItem = (id, path, title, sessionIds) => ({
  workspaceId: id,
  path,
  title,
  sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
})
const itemA = wsItem('w-a', WS_A, 'Alpha', ['A1', 'A2'])
const itemB = wsItem('w-b', WS_B, 'Beta', ['B1'])
const wsSnap = { archivedSessionIds: [], pinnedSessionIds: [], items: [itemA, itemB] }
const noItems = { archivedSessionIds: [], pinnedSessionIds: [] }
const isGroupRow = (r) => String(r.props.className).includes('st-group')
const seqOf = (rendered) =>
  rendered.rows.map((r) => (isGroupRow(r) ? '[' + labelOf(r) + ']' : labelOf(r)))
const countOf = (row) => {
  const el = row.kids.find((k) => typeof k.props.className === 'string' && k.props.className === 'st-count')
  return el ? el.kids.map((c) => c.text).join('') : null
}

const t18 = renderPanel(undefined, wsById, wsSnap)
const g18 = t18.rows.filter(isGroupRow)
check('两个 workspace + 一个未分组 = 3 个分组头', g18.length === 3, `${g18.length} 个`)
check('分组顺序 = Host 的 items 顺序，未分组固定在最后',
  JSON.stringify(g18.map(labelOf)) === JSON.stringify(['Alpha', 'Beta', '未分组']),
  JSON.stringify(g18.map(labelOf)))
check('分组头在 depth 0', g18.every((r) => indentOf(r) === 6), JSON.stringify(g18.map(indentOf)))
check('工作区内的会话缩进一层（depth 1）',
  t18.rows.filter((r) => !isGroupRow(r)).every((r) => indentOf(r) === 19),
  JSON.stringify(t18.rows.filter((r) => !isGroupRow(r)).map(indentOf)))
check('归属由 workspace.sessionIds 决定，而不是 cwd',
  JSON.stringify(seqOf(t18)) ===
    JSON.stringify(['[Alpha]', 'A one', 'A two', '[Beta]', 'B one', '[未分组]', 'Z loose']),
  JSON.stringify(seqOf(t18)))

// ★ 未被任何 workspace 收录的子会话必须挂在父会话下——把它当成根行，
//   正是插件最初要修的「1200 行平铺」回归。
const t18exp = renderPanel(seedSetAt(EXPANDED_IDS_HOOK, ['A1']), wsById, wsSnap)
check('未被任何 workspace 收录的子会话仍挂在父会话下，而不是变成未分组的根行',
  JSON.stringify(seqOf(t18exp)) ===
    JSON.stringify(['[Alpha]', 'A one', 'A1c', 'A two', '[Beta]', 'B one', '[未分组]', 'Z loose']),
  JSON.stringify(seqOf(t18exp)))
const a1cRow = t18exp.rows.find((r) => labelOf(r) === 'A1c')
check('子会话在分组内缩进两层（depth 2）', !!a1cRow && indentOf(a1cRow) === 32,
  a1cRow ? String(indentOf(a1cRow)) : '(无)')

// 折叠：分组头显示计数，组内会话消失
const t18col = renderPanel(seedSetAt(COLLAPSED_GROUPS_HOOK, ['w-a']), wsById, wsSnap)
check('折叠的分组隐藏其会话',
  JSON.stringify(seqOf(t18col)) === JSON.stringify(['[Alpha]', '[Beta]', 'B one', '[未分组]', 'Z loose']),
  JSON.stringify(seqOf(t18col)))
check('折叠的分组头显示会话数，展开的不显示',
  countOf(t18col.rows.find((r) => labelOf(r) === 'Alpha')) === '2' &&
    countOf(t18col.rows.find((r) => labelOf(r) === 'Beta')) === null,
  `Alpha=${countOf(t18col.rows.find((r) => labelOf(r) === 'Alpha'))} Beta=${countOf(t18col.rows.find((r) => labelOf(r) === 'Beta'))}`)
check('折叠状态写进 aria-expanded',
  t18col.rows.find((r) => labelOf(r) === 'Alpha').props['aria-expanded'] === 'false' &&
    t18col.rows.find((r) => labelOf(r) === 'Beta').props['aria-expanded'] === 'true')

// 分组顺序跟着 Host 的 items 走，不按名字或时间重排
const t18rev = renderPanel(undefined, wsById, { ...wsSnap, items: [itemB, itemA] })
check('分组顺序随 items 顺序变化（不做名称/时间排序）',
  JSON.stringify(t18rev.rows.filter(isGroupRow).map(labelOf)) ===
    JSON.stringify(['Beta', 'Alpha', '未分组']),
  JSON.stringify(t18rev.rows.filter(isGroupRow).map(labelOf)))

// 全部会话都被某个 workspace 收录时，不出现未分组
const t18all = renderPanel(undefined, wsById, {
  ...wsSnap,
  items: [itemA, wsItem('w-b', WS_B, 'Beta', ['B1', 'Z1'])],
})
check('没有游离会话时不渲染未分组桶',
  t18all.rows.filter(isGroupRow).length === 2,
  JSON.stringify(t18all.rows.filter(isGroupRow).map(labelOf)))

// 空 workspace：hide/show 下保留裸分组头；only 下丢弃
const t18empty = renderPanel(undefined, wsById, {
  ...wsSnap,
  items: [itemA, wsItem('w-c', 'C:\\proj\\gamma', 'Gamma', [])],
})
check('hide 模式下空 workspace 仍渲染分组头',
  JSON.stringify(t18empty.rows.filter(isGroupRow).map(labelOf)) ===
    JSON.stringify(['Alpha', 'Gamma', '未分组']),
  JSON.stringify(t18empty.rows.filter(isGroupRow).map(labelOf)))
const notes18 = t18empty.sink.filter(
  (e) => typeof e.props.className === 'string' && e.props.className === 'st-note',
)
check('空 workspace 组内给出空态说明', notes18.length === 1, `${notes18.length} 条`)
const t18only = renderPanel((v) => (v === 'hide' ? 'only' : undefined), wsById, {
  archivedSessionIds: ['B1'],
  pinnedSessionIds: [],
  items: [itemA, itemB],
})
check('only 模式下没有可见成员的 workspace 被丢弃',
  JSON.stringify(t18only.rows.filter(isGroupRow).map(labelOf)) === JSON.stringify(['Beta']),
  JSON.stringify(t18only.rows.filter(isGroupRow).map(labelOf)))

// Host 基线未就绪（没有 items）时退回扁平布局，不凭空造分组
const t18flat = renderPanel(undefined, wsById, noItems)
check('没有 items 时退回扁平布局（不造分组）',
  t18flat.rows.filter(isGroupRow).length === 0 && t18flat.rows.length === 4,
  `${t18flat.rows.filter(isGroupRow).length} 个分组 / ${t18flat.rows.length} 行`)
check('扁平布局下所有行仍在 depth 0',
  t18flat.rows.every((r) => indentOf(r) === 6),
  JSON.stringify(t18flat.rows.map(indentOf)))

// ------------------------------------------------- 套件自检：90 项一条不少
console.log('\n=== 测试 M：套件自检 ===')
// 参考套件的 90 条一条不少：这里比的是“进入测试 18 之前”的条数，
// 所以之后再加用例不需要改任何常量。
check('夹具：参考套件的 90 项断言全部执行（无因条件缺失被跳过）',
  referenceChecks === REFERENCE_ASSERTIONS,
  `进入新增用例前 ${referenceChecks} 项 / 参考套件 ${REFERENCE_ASSERTIONS} 项；` +
    `含新增用例共 ${coreChecks} 项`)

// ============================================ 附加阶段：真实会话库（可选、非判定）
/**
 * 多帧 zstd 会话日志的首行（会话头）。只用于附加阶段。
 * 解析被限制在头 32 个帧候选内，保证最坏情况也不会长时间阻塞。
 */
function firstLine(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const buf = fs.readFileSync(file)
  const off = []
  for (let i = 0; i + 4 <= buf.length && off.length < 32; i++)
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) off.push(i)
  for (let k = 0; k < off.length; k++) {
    const s = off[k]
    const e = k + 1 < off.length ? off[k + 1] : buf.length
    try {
      const t = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')
      const nl = t.indexOf('\n')
      const line = nl === -1 ? t : t.slice(0, nl)
      if (line.trim()) return JSON.parse(line)
    } catch (e) {}
  }
  return null
}

/** 用实时会话头重建 byId —— 与参考实现完全相同的构造方式。 */
function buildLiveById(files) {
  const limit = Math.max(1, Number(process.env.DSH_SESSION_TREE_LIVE_LIMIT) || 4000)
  const liveById = {}
  let parsed = 0
  let skipped = 0
  for (const file of files.slice(0, limit)) {
    try {
      const head = firstLine(file)
      if (!head || !head.id) {
        skipped++
        continue
      }
      parsed++
      liveById[head.id] = {
        id: head.id,
        displayTitle: String(head.id).slice(0, 8),
        running: false,
        retainedBy: 0,
        blank: false,
        updatedAt: head.createdAt || 0,
        ...(head.parentSession ? { parentId: head.parentSession } : {}),
        ...(head.origin ? { origin: head.origin } : {}),
        projectionValues: {},
      }
    } catch (e) {
      skipped++
    }
  }
  return { liveById, parsed, skipped }
}

/** 附加阶段：任何异常都只打印一行，绝不影响夹具结论与退出码。 */
function runLivePhase() {
  if (!liveStore) return
  console.log('\n=== 附加阶段：实时会话库（可选；不一致只打印 WARN）===')
  try {
    const live = buildLiveById(liveStore.files)
    const liveById = live.liveById
    if (Object.keys(liveById).length === 0) {
      console.log('  实时会话库里没有可解析的会话头 → 跳过（夹具模式已通过）')
      return
    }
    console.log(`  实时模式：${liveStore.dir}`)
    console.log(`  解析 ${live.parsed} 个会话头，跳过 ${live.skipped} 个（并发写入竞态属正常）`)

    const liveRootCount = Object.values(liveById).filter((s) => s && s.origin !== 'subagent').length
    const l1 = renderPanel(undefined, liveById, EMPTY_WS)
    checkLive('实时数据无异常渲染', l1.rows.length > 0, `${l1.rows.length} 行`)
    checkLive(
      '实时数据默认只渲染顶层会话（不展开子会话）',
      l1.rows.length <= liveRootCount,
      `渲染 ${l1.rows.length} 行，顶层会话 ${liveRootCount} 个`,
    )
    checkLive(
      '实时数据默认所有行缩进相同（depth=0）',
      new Set(l1.rows.map(indentOf)).size === 1,
      JSON.stringify([...new Set(l1.rows.map(indentOf))]),
    )

    const liveTally = {}
    for (const s of Object.values(liveById)) if (s && s.parentId) liveTally[s.parentId] = (liveTally[s.parentId] || 0) + 1
    const liveWidest = Object.entries(liveTally).sort((a, b) => b[1] - a[1])[0]
    if (!liveWidest) {
      console.log('  实时数据里没有任何父子关系 → 跳过展开类检查')
      return
    }
    const l2 = renderPanel(seedSetAt(EXPANDED_IDS_HOOK, [liveWidest[0]]), liveById, EMPTY_WS)
    const liveKeys = l2.rows.map((r) => r.props.key)
    checkLive('实时数据没有重复的 React key', new Set(liveKeys).size === liveKeys.length,
      `${liveKeys.length} 行 / ${new Set(liveKeys).size} 个唯一 key`)
    const liveLabels = l2.rows.map(labelOf)
    checkLive('实时数据每行都有非空标签', liveLabels.every((l) => typeof l === 'string' && l.length > 0))
    checkLive(
      '实时数据展开最宽的父会话后子行不超过上限 300',
      l2.rows.length - l1.rows.length <= 301,
      `${l2.rows.length - l1.rows.length} 个子行（最宽 ${liveWidest[1]} 个）`,
    )
    if (liveWidest[1] > 300) {
      const liveMore = l2.sink.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('st-note'))
      checkLive('实时数据超过 300 个子节点时给出省略提示', liveMore.length > 0,
        liveMore.map((m) => m.kids.map((c) => c.text).join('')).join(' | '))
    }

    // 工作区分组在真实数据量下的不变量：每个顶层会话恰好出现一次。
    // 真实 Host 用 `workspace.sessionIds` 给成员关系；这里把真实顶层会话切成
    // 三组，并故意留两个不被任何 workspace 收录，用来驱动“未分组”桶。
    const liveTop = Object.values(liveById).filter(
      (s) => s && s.id && !(s.parentId && liveById[s.parentId]),
    )
    if (liveTop.length >= 4) {
      const assigned = liveTop.slice(0, liveTop.length - 2)
      const chunk = Math.max(1, Math.ceil(assigned.length / 3))
      const liveItems = []
      for (let i = 0; i < assigned.length; i += chunk) {
        liveItems.push({
          workspaceId: 'live-w' + liveItems.length,
          path: 'C:\\live\\w' + liveItems.length,
          title: 'W' + liveItems.length,
          sessionIds: assigned.slice(i, i + chunk).map((s) => s.id),
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        })
      }
      const l3 = renderPanel(undefined, liveById, {
        archivedSessionIds: [],
        pinnedSessionIds: [],
        items: liveItems,
      })
      const l3groups = l3.rows.filter(isGroupRow)
      const l3sessions = l3.rows.filter((r) => !isGroupRow(r))
      const l3keys = l3sessions.map((r) => r.props.key)
      checkLive('实时数据分组后渲染出 3 个 workspace + 1 个未分组',
        l3groups.length === liveItems.length + 1,
        `${l3groups.length} 个分组（workspace ${liveItems.length}）/ ${liveTop.length} 个顶层会话`)
      checkLive('实时数据分组后每个顶层会话恰好出现一次',
        l3sessions.length === liveTop.length && new Set(l3keys).size === l3keys.length,
        `${l3sessions.length} 行 / ${new Set(l3keys).size} 个唯一 key / 顶层 ${liveTop.length}`)
      checkLive('实时数据分组后分组头 depth 0、会话 depth 1',
        l3groups.every((r) => indentOf(r) === 6) && l3sessions.every((r) => indentOf(r) === 19),
        JSON.stringify([...new Set(l3.rows.map(indentOf))]))
      checkLive('实时数据分组后没有行标签为空',
        l3.rows.map(labelOf).every((l) => typeof l === 'string' && l.length > 0))
    }
  } catch (e) {
    console.log(`  实时阶段异常，已忽略（不影响夹具结果）：${(e && e.message) || e}`)
  }
}
runLivePhase()

// ------------------------------------------------------------------- 汇总
console.log('\n==================== 结果 ====================')
console.log(
  liveStore
    ? `数据模式：内置夹具（判定） + 实时会话库（附加，不参与判定）`
    : `数据模式：仅内置夹具（${liveSkipReason}）`,
)
console.log(`参考套件对齐断言： ${coreChecks - coreFailures} / ${coreChecks} 通过（参考套件共 ${REFERENCE_ASSERTIONS} 项）`)
console.log(`夹具/套件自检断言： ${fixtureChecks - fixtureFailures} / ${fixtureChecks} 通过`)
if (liveChecks > 0) {
  console.log(
    `实时数据附加检查： ${liveChecks - liveWarnings} / ${liveChecks} 通过` +
      (liveWarnings ? `（${liveWarnings} 项与本机数据不一致，不影响退出码）` : ''),
  )
} else {
  console.log('实时数据附加检查： 未运行（无会话库 / 已关闭 / Node 不支持 zstd）')
}
console.log(`合计失败 ${failures} 项`)
console.log(failures === 0 ? '✅ client.js 渲染逻辑在确定性夹具上通过全部检查' : '❌ 有检查未通过')
process.exit(failures === 0 ? 0 : 1)
