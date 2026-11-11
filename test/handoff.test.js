/**
 * Offline tests for the merged session-tree Host half:
 * `session_handoff` (ported from @local/dsh-session-handoff) beside `tree_send`.
 *
 * The Host services are mocked at the seam the handoff tool consumes:
 * `tools`/`agents`/`subagents`/`tokenMeter`, the optional `workingDirectory`
 * fallback, and the optional inheritance services `workspaceRegistry`,
 * `agentPresets`, `permissionPresets`, `approval`. No @deepseek-ai package is
 * loaded, no real session is created; handoff files are written to a throw-away
 * temp workspace.
 *
 * Ported from packages/dsh-session-handoff/tests/handoff.test.js (24 cases,
 * semantics preserved). Added cases pin the inheritance repair: workspace
 * attach for root successors, Agent-preset mount + durable inheritance events in
 * the `agents.create({ setup })` callback, source-fact reporting for sibling
 * successors, the new `status` fields, and the explicit preset-mount /
 * workspace-attach failure reporting.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, makeExecute, HANDOFF_TOOL } from '../index.js'

// Locale resolution must not depend on the developer's real DSH profile: the
// test process runs inside DSH, where DSH_PROFILE_DIR points at a profile whose
// Language row is whatever the user picked. Start every test from "no stored
// preference" (English) and let the locale cases opt in explicitly.
const SAVED_PROFILE_DIR = process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE_DIR
after(() => {
  if (SAVED_PROFILE_DIR !== undefined) process.env.DSH_PROFILE_DIR = SAVED_PROFILE_DIR
})

const PARENT_ID = 'session-parent-00000000'

/** A throw-away workspace directory removed after each test. */
async function makeWorkspace(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-handoff-'))
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return dir
}

function makeSession({ id = 'session-current-abcd1234', cwd, parentSession, config } = {}) {
  const header = { id }
  if (cwd !== undefined) header.cwd = cwd
  if (parentSession !== undefined) header.parentSession = parentSession
  return {
    id,
    header,
    requestHeader: () => (config === undefined ? undefined : { config }),
  }
}

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  reasoningEffort: 'high',
  maxTokens: 8192,
}

function makeExec(session) {
  return { agent: { session }, signal: new AbortController().signal }
}

/**
 * A mock successor Agent that records every durable event the setup callback
 * appends to it (the real host reconstructs permission/preset state from these
 * events, so they are the contract under test).
 */
function makeRecordedAgent(id, options, calls) {
  const appended = []
  const agent = {
    id,
    appended,
    session: {
      id,
      header: { id },
      append: (type, data) => {
        appended.push({ type, data })
        calls.appended.push({ type, data })
      },
    },
    followup: async (message) => {
      calls.followup.push({ options, message })
    },
  }
  return agent
}

/**
 * Mock Host services and a call log. Overrides are shallow-merged, so a test can
 * replace `services.agents.create` or drop a whole service.
 *
 * The `agents.create` mock behaves like the real Host closely enough for the
 * merged tool: it saves the options (including `setup`), builds a recorded
 * successor Agent, and invokes `options.setup(agentCtx, agent)` before
 * resolving — that is where the tool mounts the Agent preset and appends the
 * inheritance events.
 */
function makeServices(overrides = {}, { pressureTokens = 60000, contextWindow = 100000 } = {}) {
  const calls = {
    create: [],
    followup: [],
    startActivation: [],
    get: [],
    agents: [],
    appended: [],
    setupCalls: [],
    resolveByPath: [],
    attach: [],
    mount: [],
    presetForSession: [],
    permissionState: [],
    setPolicy: [],
    workingDirectorySet: [],
  }
  const parentAgent = { id: PARENT_ID }
  const services = {
    tokenMeter: {
      contextPressure: () => ({ pressureTokens, contextWindow }),
    },
    agents: {
      get: (id) => {
        calls.get.push(id)
        return id === PARENT_ID ? parentAgent : undefined
      },
      create: async (options) => {
        calls.create.push(options)
        const agent = makeRecordedAgent(options.sessionId, options, calls)
        calls.agents.push(agent)
        if (typeof options.setup === 'function') {
          calls.setupCalls.push(options)
          const agentCtx = {
            get: (key) => services[key],
            ...services,
          }
          await options.setup(agentCtx, agent)
        }
        return { agent, dispose: async () => {} }
      },
    },
    subagents: {
      startActivation: async (spec) => {
        calls.startActivation.push(spec)
        return { childId: 'session-successor-sibling-1' }
      },
    },
    workingDirectory: { get: () => '/working-directory-fallback' },
    ...overrides,
  }
  return { services, calls, parentAgent }
}

/** The source-session facts the inheritance repair must carry over. */
const DEFAULT_INHERITED = {
  preset: 'architect',
  permission: { preset: 'auto', sandbox: 'workspace-write', approval: 'ask', seeded: true },
  workspaceId: 'workspace-1',
}

/**
 * Install the optional inheritance services onto `services` and record each
 * production call. `options` can force the failure paths:
 *   - `mountThrows: 'boom'`      → `agentPresets.mount` rejects
 *   - `attachThrows: 'boom'`     → `workspace.attachSession` rejects
 *   - `workspace: null`          → `workspaceRegistry.resolveByPath` finds nothing
 * A bare `makeServices()` (no inheritance services) is the "services missing"
 * baseline the ported cases rely on.
 */
function installInheritance(services, calls, options = {}) {
  const facts = { ...DEFAULT_INHERITED, ...options }
  services.workspaceRegistry = {
    resolveByPath: async (cwd) => {
      calls.resolveByPath.push(cwd)
      if (facts.workspace === null) return undefined
      return {
        id: facts.workspaceId,
        path: cwd,
        attachSession: async (sessionId) => {
          calls.attach.push(sessionId)
          if (facts.attachThrows) throw new Error(facts.attachThrows)
        },
      }
    },
  }
  services.agentPresets = {
    presetForSession: (session) => {
      calls.presetForSession.push(session)
      return facts.preset
    },
    mount: async (ctx, id) => {
      calls.mount.push({ ctx, id })
      if (facts.mountThrows) throw new Error(facts.mountThrows)
      return { id }
    },
  }
  services.permissionPresets = {
    permissionState: (session) => {
      calls.permissionState.push(session)
      return { ...facts.permission }
    },
    current: (session) => facts.permission.preset ?? 'custom',
  }
  services.approval = {
    setPolicy: (agent, policy) => {
      calls.setPolicy.push({ agent, policy })
    },
  }
  services.workingDirectory = {
    get: () => facts.workingDirectoryFallback ?? '/working-directory-fallback',
    set: async (agent, directory, signal) => {
      calls.workingDirectorySet.push({ agent, path: directory, signal })
      if (facts.workingDirectorySetThrows) throw new Error(facts.workingDirectorySetThrows)
      return directory
    },
  }
  return facts
}

async function handoffFiles(dir) {
  const entries = await fsp.readdir(dir)
  return entries.filter((entry) => /^HANDOFF-.*\.md$/.test(entry)).sort()
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** The durable event a setup callback appended, by type (optionally filtered). */
function appendedEvent(agent, type, predicate) {
  return (agent.appended || []).find(
    (entry) => entry.type === type && (predicate === undefined || predicate(entry.data)),
  )
}

// ===========================================================================
// Ported cases (unchanged semantics): status / guards / file / spawn matrix
// ===========================================================================

test('status：pressure/model/cwd 齐全时返回真实百分比与继承信息', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.action, 'status')
  assert.equal(status.context_pct, 60)
  assert.equal(status.pressure_tokens, 60000)
  assert.equal(status.context_window, 100000)
  assert.equal(status.threshold_pct, 50)
  assert.equal(status.provider, 'deepseek')
  assert.equal(status.model, 'deepseek-chat')
  assert.equal(status.reasoning_effort, 'high')
  assert.equal(status.cwd, cwd)
  assert.equal(status.session_id, session.id)
  assert.equal(status.parent_session, 'unavailable')
  assert.equal(status.successor_available, true)
  assert.equal(status.successor_kind, 'root')
  assert.equal(status.recommended_action, 'handoff')
  assert.deepEqual(status.notes, [])
})

test('status：pressure 字段缺失时显式 unavailable，不猜', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({ tokenMeter: { contextPressure: () => ({}) } })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.context_pct, 'unavailable')
  assert.equal(status.pressure_tokens, 'unavailable')
  assert.equal(status.context_window, 'unavailable')
  assert.ok(status.notes.some((note) => /pressure/i.test(note)))
  assert.equal(status.recommended_action, 'continue')
  assert.equal(status.provider, 'deepseek')
})

test('status：tokenMeter 整个缺失时不抛错，其余字段仍诚实可用', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({ tokenMeter: undefined })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.context_pct, 'unavailable')
  assert.ok(status.notes.some((note) => /tokenMeter/i.test(note)))
  assert.equal(status.model, 'deepseek-chat')
})

test('status：header.cwd 缺失时回退 workingDirectory.get；无 requestHeader 时 provider unavailable', async (t) => {
  const { services } = makeServices()
  const session = makeSession({ config: undefined })
  delete session.header.cwd
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.cwd, '/working-directory-fallback')
  assert.equal(status.provider, 'unavailable')
  assert.equal(status.model, 'unavailable')
  assert.equal(status.reasoning_effort, 'unavailable')
})

test('status：agents/subagents 缺失时 successor_available=false', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({ agents: undefined, subagents: undefined })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.successor_available, false)
  assert.equal(status.successor_kind, 'root')
})

test('handoff：pct 低于阈值 → 拒绝并返回当前 pct，不写文件', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({}, { pressureTokens: 30000, contextWindow: 100000 })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'should not happen' }, makeExec(session))

  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'below-threshold')
  assert.equal(result.context_pct, 30)
  assert.equal(result.threshold_pct, 50)
  assert.deepEqual(await handoffFiles(cwd), [])
})

test('handoff：达到阈值 → 写出 HANDOFF 文件，模板字段齐全', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({}, { pressureTokens: 50000, contextWindow: 100000 })
  const session = makeSession({
    id: 'session-abcdef1234567890',
    cwd,
    config: DEFAULT_CONFIG,
  })
  const execute = makeExecute(services)

  const result = await execute(
    {
      action: 'handoff',
      summary: 'Implement the session handoff feature',
      next_steps: ['Run the offline tests', 'Report evidence to the Lead'],
      files: ['packages/dsh-session-tree/index.js'],
      open_questions: ['Does the sidebar show created root sessions?'],
      note: 'Chose agents.create + followup over a setup callback.',
    },
    makeExec(session),
  )

  assert.equal(result.status, 'handed-off')
  assert.equal(result.context_pct, 50)
  assert.equal(result.session_id, session.id)
  assert.equal(path.dirname(result.handoff_path), cwd)
  assert.match(path.basename(result.handoff_path), /^HANDOFF-abcdef12-\d{8}-\d{6}\.md$/)
  assert.equal(await exists(result.handoff_path), true)

  const content = await fsp.readFile(result.handoff_path, 'utf8')
  for (const needle of [
    '## Task',
    'Implement the session handoff feature',
    '## Current status',
    '## Decisions',
    'Chose agents.create + followup over a setup callback.',
    '## Changed files',
    'packages/dsh-session-tree/index.js',
    '## Next steps',
    '1. Run the offline tests',
    '2. Report evidence to the Lead',
    '## Open questions',
    'Does the sidebar show created root sessions?',
    '## Original session',
    session.id,
    'deepseek/deepseek-chat',
    'reasoning effort: high',
    '## Successor instructions',
    'First read the handoff file at:',
  ]) {
    assert.ok(content.includes(needle), `handoff file is missing: ${needle}`)
  }
})

test('handoff：根会话 → agents.create（session-* / meta.cwd / agentOptions）后再 followup', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ id: 'session-abcdef1234567890', cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Root successor' }, makeExec(session))

  assert.equal(calls.create.length, 1)
  const options = calls.create[0]
  assert.match(String(options.sessionId), /^session-[0-9a-f-]{36}$/)
  assert.equal(options.meta.cwd, cwd)
  assert.deepEqual(options.agentOptions, DEFAULT_CONFIG)
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.signal.aborted, false)
  assert.equal(result.successor.kind, 'root')
  assert.equal(result.successor.session_id, options.sessionId)
  assert.equal(result.successor.parent_session, 'unavailable')
  assert.equal(result.successor.inherited, 'session-route')

  assert.equal(calls.followup.length, 1)
  const { message } = calls.followup[0]
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.ok(message.content[0].text.includes(result.handoff_path))
  assert.match(message.content[0].text, /read the handoff file/i)
})

test('handoff：子会话且父 Agent 活 → startActivation 启动兄弟会话（同父、同层级）', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls, parentAgent } = makeServices()
  const session = makeSession({ cwd, parentSession: PARENT_ID, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Sibling successor' }, makeExec(session))

  assert.equal(calls.create.length, 0)
  assert.equal(calls.startActivation.length, 1)
  const spec = calls.startActivation[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.request.parent, parentAgent)
  assert.equal(spec.request.cwd, cwd)
  assert.deepEqual(spec.request.agentOptions, DEFAULT_CONFIG)
  assert.equal(spec.request.prompt.length, 1)
  assert.equal(spec.request.prompt[0].type, 'text')
  assert.ok(spec.request.prompt[0].text.includes(result.handoff_path))
  assert.match(spec.request.prompt[0].text, /read the handoff file/i)
  assert.match(String(spec.label), /^handoff /)
  assert.ok(spec.signal instanceof AbortSignal)
  assert.equal(spec.signal.aborted, false)

  assert.equal(result.status, 'handed-off')
  assert.equal(result.successor.kind, 'sibling')
  assert.equal(result.successor.session_id, 'session-successor-sibling-1')
  assert.equal(result.successor.parent_session, PARENT_ID)
  assert.equal('degraded' in result, false)
})

test('handoff：子会话但父不活 → 降级根级并显式 degraded', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  services.agents.get = () => undefined
  const session = makeSession({ cwd, parentSession: PARENT_ID, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Degraded successor' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(result.degraded, 'parent-inactive')
  assert.equal(result.successor.kind, 'root')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.startActivation.length, 0)
  assert.equal(calls.create[0].meta.cwd, cwd)
})

test('handoff：kind=root 强制根级（子会话父活也不建兄弟）', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, parentSession: PARENT_ID, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute(
    { action: 'handoff', kind: 'root', summary: 'Forced root' },
    makeExec(session),
  )

  assert.equal(result.status, 'handed-off')
  assert.equal(result.successor.kind, 'root')
  assert.equal('degraded' in result, false)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.startActivation.length, 0)
})

test('handoff：kind=sibling 但父不活 → 根级 + degraded=parent-inactive', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  services.agents.get = () => undefined
  const session = makeSession({ cwd, parentSession: PARENT_ID, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute(
    { action: 'handoff', kind: 'sibling', summary: 'Explicit sibling gone' },
    makeExec(session),
  )

  assert.equal(result.successor.kind, 'root')
  assert.equal(result.degraded, 'parent-inactive')
  assert.equal(calls.create.length, 1)
})

test('handoff：根会话请求 kind=sibling → 回退根级，根级本身即同层不标降级', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute(
    { action: 'handoff', kind: 'sibling', summary: 'No parent for sibling' },
    makeExec(session),
  )

  assert.equal(result.status, 'handed-off')
  assert.equal(result.successor.kind, 'root')
  assert.equal('degraded' in result, false)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.startActivation.length, 0)
})

test('handoff：spawn 失败但文件已写成功 → 返回 handoff_path + spawn_error，不静默', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices()
  services.agents.create = async () => {
    throw new Error('boom-create')
  }
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Spawn failure' }, makeExec(session))

  assert.equal(result.status, 'handoff-file-written')
  assert.match(String(result.spawn_error), /boom-create/)
  assert.equal(result.successor, 'unavailable')
  assert.equal(await exists(result.handoff_path), true)
  assert.deepEqual(await handoffFiles(cwd), [path.basename(result.handoff_path)])
})

test('handoff：spawn=false → 只写文件，不启动接替会话', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute(
    { action: 'handoff', summary: 'File only', spawn: false },
    makeExec(session),
  )

  assert.equal(result.status, 'file-only')
  assert.equal(result.spawn, 'skipped')
  assert.equal(result.successor, 'unavailable')
  assert.equal(calls.create.length, 0)
  assert.equal(calls.startActivation.length, 0)
  assert.equal(await exists(result.handoff_path), true)
})

test('handoff：5 分钟内防重复，超过窗口后可再次交接', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const base = Date.parse('2026-11-11T12:00:00Z')
  let clock = base
  const execute = makeExecute(services, { now: () => clock })

  const first = await execute({ action: 'handoff', summary: 'First' }, makeExec(session))
  assert.equal(first.status, 'handed-off')
  assert.deepEqual(await handoffFiles(cwd), [path.basename(first.handoff_path)])

  clock = base + 90_000
  const second = await execute({ action: 'handoff', summary: 'Second too early' }, makeExec(session))
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason, 'recent-handoff')
  assert.equal(second.last_handoff_at, new Date(base).toISOString())
  assert.equal(second.handoff_path, first.handoff_path)
  assert.deepEqual(await handoffFiles(cwd), [path.basename(first.handoff_path)])
  assert.equal(calls.create.length, 1)

  clock = base + 300_001
  const third = await execute({ action: 'handoff', summary: 'Third after window' }, makeExec(session))
  assert.equal(third.status, 'handed-off')
  assert.equal((await handoffFiles(cwd)).length, 2)
  assert.equal(calls.create.length, 2)
})

test('handoff：force 同时覆盖阈值守卫与 5 分钟防重复', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices({}, { pressureTokens: 10000, contextWindow: 100000 })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const base = Date.parse('2026-11-11T13:00:00Z')
  let clock = base
  const execute = makeExecute(services, { now: () => clock })

  const first = await execute(
    { action: 'handoff', summary: 'Forced below threshold', force: true },
    makeExec(session),
  )
  assert.equal(first.status, 'handed-off')

  clock = base + 1000
  const rejected = await execute({ action: 'handoff', summary: 'No force' }, makeExec(session))
  assert.equal(rejected.reason, 'below-threshold')

  const second = await execute(
    { action: 'handoff', summary: 'Forced duplicate override', force: true },
    makeExec(session),
  )
  assert.equal(second.status, 'handed-off')
  assert.equal((await handoffFiles(cwd)).length, 2)
  assert.equal(calls.create.length, 2)
})

test('handoff：文件写失败 → 整体失败，且未启动接替会话', async (t) => {
  const cwd = await makeWorkspace(t)
  const blocker = path.join(cwd, 'not-a-directory')
  await fsp.writeFile(blocker, 'x', 'utf8')
  const { services, calls } = makeServices()
  const session = makeSession({ cwd: blocker, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  await assert.rejects(
    execute({ action: 'handoff', summary: 'Unwritable' }, makeExec(session)),
    /could not write the handoff file/,
  )
  assert.equal(calls.create.length, 0)
  assert.equal(calls.startActivation.length, 0)
})

test('handoff：threshold_pct 参数生效（显式 80 拒绝，50 放行）', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const rejected = await execute(
    { action: 'handoff', summary: 'Too early for 80', threshold_pct: 80 },
    makeExec(session),
  )
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.threshold_pct, 80)
  assert.equal(rejected.context_pct, 60)

  const status = await execute({ action: 'status', threshold_pct: 80 }, makeExec(session))
  assert.equal(status.threshold_pct, 80)
  assert.equal(status.recommended_action, 'continue')

  const allowed = await execute(
    { action: 'handoff', summary: 'Allowed at 50', threshold_pct: 50 },
    makeExec(session),
  )
  assert.equal(allowed.status, 'handed-off')
})

test('handoff：缺 summary 拒绝（handoff 必填非空）', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  await assert.rejects(
    execute({ action: 'handoff' }, makeExec(session)),
    /"summary" is required/,
  )
  assert.deepEqual(await handoffFiles(cwd), [])
})

test('handoff：缺 agents/subagents 服务 → 文件仍写成功，spawn_error 明示', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({ agents: undefined, subagents: undefined })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'No spawn service' }, makeExec(session))

  assert.equal(result.status, 'handoff-file-written')
  assert.match(String(result.spawn_error), /no successor path available/)
  assert.equal(await exists(result.handoff_path), true)
})

test('handoff：读不到 requestHeader().config → 省略 agentOptions 并标 inherited=provider-default', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: undefined })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Provider default' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(result.successor.inherited, 'provider-default')
  assert.equal(calls.create[0].agentOptions, undefined)
  assert.equal(result.successor.model, 'unavailable')
})

test('execute：没有调用中的会话 → 明确报错', async () => {
  const { services } = makeServices()
  const execute = makeExecute(services)
  await assert.rejects(execute({ action: 'status' }, {}), /no calling session/)
})

test('apply：注入服务后同包注册 session_handoff 与 tree_send，工具为 JSON-Schema 形状且 render 有界', () => {
  const injected = []
  const registered = []
  const fakeCtx = {
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      },
    },
    inject: (deps, callback) => {
      injected.push(deps)
      callback(fakeCtx)
    },
  }

  apply(fakeCtx)

  const flatDeps = injected.flat()
  for (const name of ['tools', 'subagents', 'agents', 'tokenMeter']) {
    assert.ok(flatDeps.includes(name), `apply must inject ${name}`)
  }

  // The merge goal: both Host tools live in this one package.
  const names = registered.map((definition) => definition.name)
  assert.ok(names.includes('session_handoff'), `session_handoff not registered: ${JSON.stringify(names)}`)
  assert.ok(names.includes('tree_send'), `tree_send not registered: ${JSON.stringify(names)}`)

  const tool = registered.find((definition) => definition.name === 'session_handoff')
  // The exported definition is what apply() registers (plus the executor).
  assert.equal(HANDOFF_TOOL.name, 'session_handoff')
  assert.deepEqual(tool.parameters, HANDOFF_TOOL.parameters)
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'handoff'])
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.properties.spawn.type, 'boolean')
  assert.equal(tool.parameters.properties.threshold_pct.type, 'number')
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.description.length > 100)
  assert.match(tool.description, /50%/)

  const rendered = tool.output.render(
    { action: 'status' },
    {
      action: 'status',
      context_pct: 62.5,
      threshold_pct: 50,
      pressure_tokens: 125000,
      context_window: 200000,
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoning_effort: 'high',
      successor_available: true,
      successor_kind: 'root',
      recommended_action: 'handoff',
    },
  )
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('62.5'))
  assert.ok(rendered[0].text.length <= 400)
})

// ===========================================================================
// Added cases: inheritance repair (workspace / preset / permission facts)
// ===========================================================================

test('status：新增继承字段 agent_preset/permission/workspace 从服务读取真实事实', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const facts = installInheritance(services, calls)
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.agent_preset, facts.preset)
  assert.ok(status.permission && typeof status.permission === 'object')
  assert.equal(status.permission.preset, facts.permission.preset)
  assert.equal(status.permission.sandbox, facts.permission.sandbox)
  assert.equal(status.permission.approval, facts.permission.approval)
  assert.ok(status.workspace && typeof status.workspace === 'object')
  assert.equal(status.workspace.workspace_id, facts.workspaceId)
  assert.equal(status.workspace.path, cwd)
  // The workspace fact is resolved from the session cwd, not guessed.
  assert.ok(calls.resolveByPath.includes(cwd), JSON.stringify(calls.resolveByPath))
})

test('status：继承服务缺失时三个字段取 unavailable，不猜', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices() // no workspaceRegistry / agentPresets / permissionPresets
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))

  assert.equal(status.agent_preset, 'unavailable')
  // The implementation reports the whole permission fact as unavailable when
  // no permission service is composed (instead of fabricating an object).
  assert.equal(status.permission, 'unavailable')
  assert.ok(status.workspace && typeof status.workspace === 'object')
  for (const field of ['workspace_id', 'path']) {
    assert.equal(status.workspace[field], 'unavailable', `workspace.${field}`)
  }
})

test('handoff：root 接替会话 attach 到同工作区，返回 workspace = {attached:true, id, path}', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const facts = installInheritance(services, calls)
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Root joins workspace' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(result.successor.kind, 'root')
  assert.ok(calls.resolveByPath.includes(cwd), JSON.stringify(calls.resolveByPath))
  assert.equal(calls.attach.length, 1)
  assert.equal(calls.attach[0], result.successor.session_id)

  const workspace = result.successor.workspace
  assert.ok(workspace && typeof workspace === 'object')
  assert.equal(workspace.attached, true)
  assert.equal(workspace.workspace_id, facts.workspaceId)
  assert.equal(workspace.path, cwd)
})

test('handoff：root 无 workspaceRegistry → workspace.attached=false + reason，交接仍成功', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices() // no workspaceRegistry at all
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'No workspace registry' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(calls.attach.length, 0)
  const workspace = result.successor.workspace
  assert.ok(workspace && typeof workspace === 'object')
  assert.equal(workspace.attached, false)
  assert.match(String(workspace.reason), /workspace|registry|unavailable/i)
})

test('handoff：root 有 registry 但路径未命中工作区 → attached=false + reason，交接仍成功', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  installInheritance(services, calls, { workspace: null })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Workspace not registered' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(calls.attach.length, 0)
  assert.equal(result.successor.workspace.attached, false)
  assert.match(String(result.successor.workspace.reason), /workspace|unavailable|no/i)
})

test('handoff：root setup 传 meta.agentPreset、mount 预设、追加四类继承事件', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const facts = installInheritance(services, calls)
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Inherit preset' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  // 1. The preset is declared on the creation meta so the Host composes it.
  assert.equal(calls.create.length, 1)
  const options = calls.create[0]
  assert.equal(options.meta.agentPreset, facts.preset)
  assert.equal(typeof options.setup, 'function')
  assert.equal(calls.setupCalls.length, 1)
  assert.equal(calls.setupCalls[0], options)

  // 2. The setup callback mounts the preset on the successor's own context.
  assert.equal(calls.mount.length, 1)
  assert.equal(calls.mount[0].id, facts.preset)

  // 3. The durable inheritance events are appended to the successor session.
  const agent = calls.agents[0]
  assert.ok(agent, 'no successor agent recorded')
  const selected = appendedEvent(agent, 'agent-preset/selected')
  assert.ok(selected, 'agent-preset/selected event missing')
  assert.equal(selected.data.agentPreset, facts.preset)

  const presetEvent = appendedEvent(agent, 'permission/preset')
  assert.ok(presetEvent, 'permission/preset event missing')
  assert.equal(presetEvent.data.preset, facts.permission.preset)

  const sandboxEvent = appendedEvent(agent, 'sandbox/mode')
  assert.ok(sandboxEvent, 'sandbox/mode event missing')
  assert.equal(sandboxEvent.data.mode, facts.permission.sandbox)
  assert.equal(sandboxEvent.data.source, 'delegation')

  const approvalEvent = appendedEvent(agent, 'approval/policy')
  assert.ok(approvalEvent, 'approval/policy event missing')
  assert.equal(approvalEvent.data.policy, facts.permission.approval)
  assert.equal(approvalEvent.data.source, 'delegation')

  // 4. The returned successor reports the inherited facts (same source facts).
  assert.equal(result.successor.agent_preset, facts.preset)
  assert.ok(result.successor.permission && typeof result.successor.permission === 'object')
  assert.equal(result.successor.permission.preset, facts.permission.preset)
  assert.equal(result.successor.permission.sandbox, facts.permission.sandbox)
  assert.equal(result.successor.permission.approval, facts.permission.approval)
})

test('handoff：setup 中 preset mount 抛错 → 交接仍成功，warnings + preset_error 可追溯', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const facts = installInheritance(services, calls, { mountThrows: 'boom-preset-mount' })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Preset mount failure' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(await exists(result.handoff_path), true)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.mount.length, 1)
  assert.equal(calls.mount[0].id, facts.preset)
  const warnings = Array.isArray(result.warnings) ? result.warnings.join(' | ') : ''
  const degraded = typeof result.degraded === 'string' ? result.degraded : ''
  assert.ok(
    /preset|mount|inherit/i.test(warnings) || /preset|mount|inherit/i.test(degraded),
    `failure not surfaced (warnings=${JSON.stringify(result.warnings)}, degraded=${JSON.stringify(result.degraded)})`,
  )
  // Traceability: the original contract asks for `successor.preset_error`, and
  // the merged implementation reports it there (plus the same text in warnings).
  assert.match(String(result.successor.preset_error), /boom-preset-mount/)
  assert.match(String(result.successor.preset_error), /not inherited/)
  assert.match(warnings, /not inherited/)
  const traceable = [
    result.successor.preset_error === undefined ? '' : String(result.successor.preset_error),
    ...(Array.isArray(result.warnings) ? result.warnings : []),
  ]
    .filter(Boolean)
    .join(' | ')
  assert.match(traceable, /boom-preset-mount/)
})

test('handoff：workspace attach 抛错 → 交接仍成功，warnings + workspace.reason 可追溯', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const facts = installInheritance(services, calls, { attachThrows: 'boom-workspace-attach' })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Workspace attach failure' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(await exists(result.handoff_path), true)
  assert.equal(calls.attach.length, 1)
  const workspace = result.successor.workspace
  assert.ok(workspace && typeof workspace === 'object')
  assert.equal(workspace.attached, false)
  // A failed attach reports the reason; it does not claim workspace identity.
  assert.match(String(workspace.reason), /boom-workspace-attach/)
  assert.match(String(workspace.reason), /workspace-attach-failed/)
  const warnings = Array.isArray(result.warnings) ? result.warnings.join(' | ') : ''
  const degraded = typeof result.degraded === 'string' ? result.degraded : ''
  assert.ok(
    /workspace|attach|inherit/i.test(warnings) || /workspace|attach|inherit/i.test(degraded),
    `failure not surfaced (warnings=${JSON.stringify(result.warnings)}, degraded=${JSON.stringify(result.degraded)})`,
  )
})

test('handoff：兄弟路径参数不回归、返回源会话 agent_preset/permission，且不 attach workspace', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls, parentAgent } = makeServices()
  const facts = installInheritance(services, calls)
  const session = makeSession({ cwd, parentSession: PARENT_ID, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Sibling inheritance' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(calls.create.length, 0)
  assert.equal(calls.startActivation.length, 1)

  const spec = calls.startActivation[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.request.parent, parentAgent)
  assert.equal(spec.request.cwd, cwd)
  assert.equal(spec.request.prompt.length, 1)
  assert.equal(spec.request.prompt[0].type, 'text')
  assert.ok(spec.request.prompt[0].text.includes(result.handoff_path))
  assert.match(spec.request.prompt[0].text, /read the handoff file/i)

  // Sibling successors are delegated under the live parent, so the handoff
  // itself must not attach a workspace (that path belongs to the parent). The
  // registry may still be queried to name the Sidebar workspace in the recap
  // file, so only the attach is asserted here.
  assert.equal(calls.attach.length, 0, JSON.stringify(calls.attach))
  const workspace = result.successor.workspace
  assert.ok(workspace && typeof workspace === 'object')
  assert.equal(workspace.attached, false)
  assert.match(String(workspace.reason), /sibling/i)

  // The sibling result reports source-session facts, not guessed values.
  assert.equal(result.successor.kind, 'sibling')
  assert.equal(result.successor.agent_preset, facts.preset)
  assert.ok(result.successor.permission && typeof result.successor.permission === 'object')
  assert.equal(result.successor.permission.preset, facts.permission.preset)
  assert.equal(result.successor.permission.sandbox, facts.permission.sandbox)
  assert.equal(result.successor.permission.approval, facts.permission.approval)
})

test('handoff：setup 中 workingDirectory.set 抛错 → 交接仍成功，warnings + working_directory_error 可追溯', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  installInheritance(services, calls, { workingDirectorySetThrows: 'boom-working-directory' })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Working directory failure' }, makeExec(session))

  assert.equal(result.status, 'handed-off')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.workingDirectorySet.length, 1)
  assert.equal(calls.workingDirectorySet[0].path, cwd)
  assert.match(String(result.successor.working_directory_error), /boom-working-directory/)
  const warnings = Array.isArray(result.warnings) ? result.warnings.join(' | ') : ''
  assert.match(warnings, /workingDirectory\.set failed/i)
})

// ===========================================================================
// Interface language: the successor kickoff message follows DSH's Language row
// ===========================================================================

/** A `services.get` stand-in exposing a Loader whose `locale` entry has `preference`. */
function loaderWithPreference(preference) {
  return (name) =>
    name === 'loader'
      ? { resolve: (id) => (id === 'locale' ? { options: { config: { preference } } } : undefined) }
      : undefined
}

/** Remove DSH_PROFILE_DIR for a test so the environment cannot leak a preference. */
function withoutProfileDir(t) {
  const previous = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE_DIR
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })
}

test('interface language: locale.preference=zh-CN (Loader) → status lang=zh and Chinese kickoff prompt', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices({ get: loaderWithPreference('zh-CN') })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))
  assert.equal(status.interface_language, 'zh')
  const statusText = HANDOFF_TOOL.output.render({ action: 'status' }, status)[0].text
  assert.match(statusText, /lang=zh/)

  const result = await execute({ action: 'handoff', summary: 'Chinese handoff' }, makeExec(session))
  assert.equal(result.status, 'handed-off')
  assert.equal(result.interface_language, 'zh')
  const kickoff = calls.followup[0].message.content[0].text
  assert.ok(kickoff.includes('接替会话'), 'kickoff prompt must speak Chinese')
  assert.ok(kickoff.includes('请先读取交接文件'))
  assert.ok(kickoff.includes(result.handoff_path))
  const file = await fsp.readFile(result.handoff_path, 'utf8')
  assert.ok(file.includes('请先读取交接文件'), 'the recap file repeats the same language')
})

test('interface language: a volatile preference reference is unwrapped', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services } = makeServices({
    get: loaderWithPreference({ get: () => 'zh' }),
  })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const status = await execute({ action: 'status' }, makeExec(session))
  assert.equal(status.interface_language, 'zh')
})

test('interface language: preference=ja falls back to English (the DSH fallback)', async (t) => {
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices({ get: loaderWithPreference('ja') })
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Fallback handoff' }, makeExec(session))
  assert.equal(result.interface_language, 'en')
  assert.match(calls.followup[0].message.content[0].text, /You are the successor session/)
})

test('interface language: no stored preference → English prompt (previous behavior)', async (t) => {
  withoutProfileDir(t)
  const cwd = await makeWorkspace(t)
  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)

  const result = await execute({ action: 'handoff', summary: 'Default handoff' }, makeExec(session))
  assert.equal(result.interface_language, 'en')
  const kickoff = calls.followup[0].message.content[0].text
  assert.match(kickoff, /You are the successor session/)
  assert.match(kickoff, /read the handoff file/i)
})

test('interface language: profile cordis.patch.yml preference is honored without a Loader service', async (t) => {  const cwd = await makeWorkspace(t)
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-profile-'))
  t.after(async () => {
    await fsp.rm(profile, { recursive: true, force: true })
  })
  await fsp.writeFile(
    path.join(profile, 'cordis.patch.yml'),
    [
      '- id: other',
      '  name: "@deepseek-ai/other"',
      '  config:',
      '    preference: en',
      '- id: locale',
      '  name: "@deepseek-ai/dsh-client-locale"',
      '  config:',
      '    preference: zh',
      '',
    ].join('\n'),
    'utf8',
  )
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  })

  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)
  const result = await execute({ action: 'handoff', summary: 'Profile-driven handoff' }, makeExec(session))

  assert.equal(result.interface_language, 'zh')
  assert.ok(calls.followup[0].message.content[0].text.includes('接替会话'))
})

test('interface language: profile files in process.cwd() are honored (host cwd = profile dir)', async (t) => {
  const cwd = await makeWorkspace(t)
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-profile-cwd-'))
  await fsp.writeFile(
    path.join(profile, 'cordis.patch.yml'),
    ['- id: locale', '  name: "@deepseek-ai/dsh-client-locale"', '  config:', '    preference: zh', ''].join('\n'),
    'utf8',
  )
  const previousCwd = process.cwd()
  process.chdir(profile)
  t.after(async () => {
    process.chdir(previousCwd)
    await fsp.rm(profile, { recursive: true, force: true })
  })

  const { services, calls } = makeServices()
  const session = makeSession({ cwd, config: DEFAULT_CONFIG })
  const execute = makeExecute(services)
  const result = await execute({ action: 'handoff', summary: 'Cwd profile handoff' }, makeExec(session))

  assert.equal(result.interface_language, 'zh')
  assert.ok(calls.followup[0].message.content[0].text.includes('接替会话'))
})

