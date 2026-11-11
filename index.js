/**
 * Host half of the session-tree bundle.
 *
 * The tree itself is pure Client rendering (see `client.js`). The Host side
 * registers two tools:
 *
 *   - `tree_send`  — deliver a message to a subagent session that is NOT the
 *                    caller's direct parent or direct child.
 *   - `session_handoff` — hand this session off to a fresh successor before its
 *                    context budget fills; the successor continues at the same
 *                    level (root -> new root, child -> sibling) with the same
 *                    model, reasoning effort, agent preset (composition), and
 *                    permission preset, and is attached to the same Workspace.
 *
 * `session_handoff` started as the standalone `@local/dsh-session-handoff`
 * package (v0.1.0) and was merged here in v1.2.0: a bundle is one installable
 * unit, so shipping both tools from one Host half removes a second install
 * spec and guarantees the two capabilities travel together. The merge also
 * fixed two inheritance gaps found in the real-machine audit of 2026-11-11:
 *
 *   1. A root successor was created with the right `cwd` but never attached to
 *      the Workspace that owns that directory, so the sidebar showed it under
 *      "Ungrouped". Root/degraded successors are now attached through
 *      `workspaceRegistry.resolveByPath(cwd)` + `Workspace.attachSession`.
 *   2. `agents.create({ meta:{cwd}, agentOptions })` alone does not mount an
 *      Agent preset composition and starts with the deployment's default
 *      permission preset. A successor therefore ran a narrower tool set
 *      (no file/terminal tools) with workspace-write/ask. The successor is now
 *      created with `meta.agentPreset` and a `setup(agentCtx, agent)` callback
 *      that mounts the same preset composition and appends the source session's
 *      `permission/preset`, `sandbox/mode` and `approval/policy` facts
 *      (`source:'delegation'`, the pattern `@deepseek-ai/dsh-subagent` uses for
 *      in-process children) before the Agent is published.
 *
 * Both tools are registered as plain objects in the shape `defineTool()` itself
 * produces (JSON-Schema `parameters` / `output.schema`), and no
 * `@deepseek-ai/*` package is imported, so the bundle declares no
 * `peerDependencies` — the only compatibility field DSH enforces.
 *
 * `tree_send` — why the tool exists: `ctx.subagents.sendMessage(sender, target,
 * ...)` authorizes by an exact live sender and therefore enforces direct
 * parent/child adjacency, so sibling-to-sibling messaging has no path through
 * it. But `ctx.subagents.prompt(request, signal)` authorizes by the durable
 * parent address instead, and is callable from the Host. That is the primitive
 * used here.
 *
 * Consequences, stated plainly:
 *   - The target must be a *continuable* child (`mode: 'continuable'`).
 *   - The target's **direct parent must be live**, otherwise the service throws
 *     `subagent/parent-unavailable`.
 *   - The call returns acceptance only (a message id); it never waits for or
 *     returns a reply.
 *   - Two top-level sessions that share no parent address still have no path.
 */
import { promises as fsp, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'session-tree'

/** Read a failure the way the Harness reports it (RemoteError carries `code`). */
function reasonOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = error && error.code ? `${error.code}: ` : ''
  return `${code}${(error && error.message) || String(error)}`
}

// ---------------------------------------------------------------------------
// Shared value helpers
// ---------------------------------------------------------------------------

/** Marker returned instead of guessing a value a service could not provide. */
const UNAVAILABLE = 'unavailable'
const DEFAULT_THRESHOLD_PCT = 50
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000
/** Spawn backend used for the sibling case (same provider as the `subagent` tool). */
const SUCCESSOR_PROVIDER = 'spawn'
/** Bounds that keep both the tool result and the written recap file bounded. */
const MAX_ARRAY_ITEMS = 50
const MAX_ITEM_CHARS = 1000
const MAX_TEXT_CHARS = 8000

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Read one optional Host service without letting a missing/scoped service crash
 * the call. Cordis contexts throw on absent service accessors, so prefer the
 * safe `ctx.get(name)` lookup and fall back to property access (plain-object
 * service mocks in the offline tests).
 */
function requestedService(services, key) {
  if (!services) return undefined
  try {
    if (typeof services.get === 'function') {
      const found = services.get(key)
      if (found !== undefined) return found
    }
  } catch {
    // fall through to property access
  }
  try {
    return services[key]
  } catch {
    return undefined
  }
}

/** Bound free text; a truncated value is marked so the successor knows. */
function normalizeText(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed
}

/** Bound a string list (item count and item length) and drop empties. */
function normalizeList(value) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const raw of value) {
    if (raw === null || raw === undefined) continue
    const text = String(raw).trim()
    if (!text) continue
    items.push(text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…` : text)
    if (items.length >= MAX_ARRAY_ITEMS) break
  }
  return items
}

function normalizeThreshold(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return isNumber(number) && number >= 0 && number <= 100 ? number : DEFAULT_THRESHOLD_PCT
}

/** `kind` input: root / sibling force the layer; anything else means auto. */
function normalizeKind(value) {
  const kind = String(value || '').trim()
  return kind === 'root' || kind === 'sibling' ? kind : 'auto'
}

function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session || typeof session !== 'object') {
    throw new Error(
      'session_handoff: no calling session (exec.agent.session is unavailable; this tool is session-scoped)',
    )
  }
  return session
}

/** The live calling Agent, when the executor exposes one (needed for preset/effort facts). */
function agentOf(exec) {
  const agent = exec && exec.agent
  return agent && typeof agent === 'object' ? agent : undefined
}

/** `HANDOFF-<短id>-<yyyyMMdd-HHmmss>.md` — the short id is filesystem-safe. */
function shortSessionId(sessionId) {
  const cleaned = String(sessionId || '')
    .replace(/^session-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
  return cleaned.slice(0, 8) || 'session'
}

function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * A detached AbortSignal: never aborted, so the successor outlives the handing-
 * off turn. Cancellation of the old turn only stops the call before the
 * successor exists.
 */
function detachedSignal() {
  return new AbortController().signal
}

// ---------------------------------------------------------------------------
// tree_send (merged from the original Host half, unchanged)
// ---------------------------------------------------------------------------

const TREE_SEND = {
  name: 'tree_send',
  description:
    'Send a message to one subagent session anywhere in the session tree, including a sibling that is ' +
    "neither your direct child nor your direct parent. Delivery goes through the target's direct parent " +
    'address, so that parent session must be live and the target must be a continuable subagent. ' +
    'Returns acceptance only; it never waits for or returns a reply.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: {
        type: 'string',
        description: 'Session id of the continuable subagent to message.',
      },
      message: {
        type: 'string',
        description: 'The message text to deliver.',
      },
      delivery: {
        type: 'string',
        enum: ['steer', 'queue'],
        description:
          "steer delivers at the target's nearest step boundary (default); queue targets a later turn.",
      },
      parent: {
        type: 'string',
        description: 'Direct parent session id. Omit to resolve it from the target session log.',
      },
    },
    required: ['target', 'message'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string' },
        parent: { type: 'string' },
        delivery: { type: 'string' },
      },
      required: ['messageId', 'parent', 'delivery'],
    },
    render: (args, value) => [
      {
        type: 'text',
        text: `tree_send: delivered to ${args.target} (parent ${value.parent}, ${value.delivery})`,
      },
    ],
  },
}

function makeTreeSendExecute(services) {
  return async function execute(args, exec) {
    const target = String((args && args.target) || '').trim()
    const text = String((args && args.message) || '')
    if (!target) throw new Error('tree_send: "target" is required')
    if (!text.trim()) throw new Error('tree_send: "message" must not be empty')
    const delivery = args && args.delivery === 'queue' ? 'queue' : 'steer'

    let parent = args && args.parent ? String(args.parent).trim() : ''
    if (!parent) {
      let records
      try {
        records = await services.sessionQuery.filterSessions(
          [{ kind: 'id', values: [target] }],
          exec.signal,
        )
      } catch (error) {
        throw new Error(`tree_send: cannot read session ${target} — ${reasonOf(error)}`)
      }
      const header = records && records[0] && records[0].header
      parent = (header && header.parentSession) || ''
      if (!parent) {
        throw new Error(
          `tree_send: ${target} is not a subagent session (its log has no parentSession), ` +
            'so it cannot be addressed this way.',
        )
      }
    }

    try {
      const receipt = await services.subagents.prompt(
        {
          requestId: `session-tree-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          parentSessionId: parent,
          childSessionId: target,
          mode: 'continuable',
          delivery,
          content: [{ type: 'text', text }],
        },
        exec.signal,
      )
      return {
        messageId: String((receipt && receipt.messageId) || ''),
        parent,
        delivery,
      }
    } catch (error) {
      throw new Error(`tree_send: delivery rejected — ${reasonOf(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// session_handoff (merged from @local/dsh-session-handoff v0.1.0)
// ---------------------------------------------------------------------------

/**
 * Collect every fact the tool reasons about, marking missing values with
 * `undefined` (rendered as `unavailable` at the tool boundary — never guessed).
 *
 * Beyond identity/route/workspace this also reads the two facts the 2026-11-11
 * audit found missing on the successor: the Agent preset (which composition —
 * and therefore which tool set — the session runs) and the permission preset
 * knobs (durable `permission/preset`, `sandbox/mode`, `approval/policy` state).
 */
function collectFacts(services, session, agent) {
  const notes = []
  const header = session && typeof session.header === 'object' ? session.header : {}
  const sessionId = String(session && session.id ? session.id : header.id || '')
  const parentSession = header.parentSession ? String(header.parentSession) : ''

  let pressure
  const tokenMeter = requestedService(services, 'tokenMeter')
  if (tokenMeter && typeof tokenMeter.contextPressure === 'function') {
    try {
      pressure = tokenMeter.contextPressure(session)
    } catch (error) {
      notes.push(`tokenMeter.contextPressure failed: ${reasonOf(error)}`)
    }
    if (!pressure || (!isNumber(pressure.pressureTokens) || !isNumber(pressure.contextWindow))) {
      notes.push(
        'context pressure unavailable: the session log has no usable pressureTokens/contextWindow yet',
      )
    }
  } else {
    notes.push('tokenMeter service unavailable: context percentage is unavailable')
  }
  const pressureTokens = pressure && isNumber(pressure.pressureTokens) ? pressure.pressureTokens : undefined
  const contextWindow = pressure && isNumber(pressure.contextWindow) ? pressure.contextWindow : undefined
  const pct =
    isNumber(pressureTokens) && isNumber(contextWindow) && contextWindow > 0
      ? (pressureTokens / contextWindow) * 100
      : undefined

  let config
  try {
    if (typeof session.requestHeader === 'function') {
      const epoch = session.requestHeader()
      config = epoch && typeof epoch === 'object' ? epoch.config : undefined
    }
  } catch (error) {
    notes.push(`session.requestHeader failed: ${reasonOf(error)}`)
  }
  const provider = config && typeof config.provider === 'string' ? config.provider : ''
  const model = config && typeof config.model === 'string' ? config.model : ''
  const reasoningEffort =
    config && typeof config.reasoningEffort === 'string' ? config.reasoningEffort : ''
  const maxTokens = config && isNumber(config.maxTokens) ? config.maxTokens : undefined

  let cwd = typeof header.cwd === 'string' && header.cwd.trim() ? header.cwd : ''
  let cwdSource = cwd ? 'session.header.cwd' : ''
  if (!cwd) {
    const workingDirectory = requestedService(services, 'workingDirectory')
    if (workingDirectory && typeof workingDirectory.get === 'function') {
      try {
        const fallback = workingDirectory.get(session)
        if (typeof fallback === 'string' && fallback.trim()) {
          cwd = fallback
          cwdSource = 'workingDirectory.get'
        }
      } catch (error) {
        notes.push(`workingDirectory.get failed: ${reasonOf(error)}`)
      }
    }
  }

  const agentPreset = collectAgentPreset(services, session, agent, header)
  const permission = collectPermissionState(services, session)

  return {
    sessionId,
    parentSession,
    cwd,
    cwdSource,
    pressureTokens,
    contextWindow,
    pct,
    provider,
    model,
    reasoningEffort,
    maxTokens,
    agentPreset,
    permission,
    notes: notes.slice(0, 4),
  }
}

/**
 * Read the Agent preset (the session's composition identity, called the "work
 * mode" in the product UI) without guessing.
 *
 * Order: the live Agent's bound composition (authoritative — it is what the
 * running tools were mounted from), then the committed `agentPreset`
 * projection, then the durable header field.
 */
function collectAgentPreset(services, session, agent, header) {
  const presets = requestedService(services, 'agentPresets')
  if (presets) {
    try {
      if (agent && agent.ctx && typeof presets.composedPreset === 'function') {
        const composed = presets.composedPreset(agent.ctx)
        if (typeof composed === 'string' && composed) return composed
      }
    } catch {
      // the calling Agent may not be bound to a preset generation
    }
    try {
      if (typeof presets.presetForSession === 'function') {
        const recorded = presets.presetForSession(session)
        if (typeof recorded === 'string' && recorded) return recorded
      }
    } catch {
      // no projection yet (brand new session) — fall through to the header
    }
  }
  const fromHeader = header && typeof header.agentPreset === 'string' ? header.agentPreset : ''
  return fromHeader || ''
}

/**
 * Read the durable permission knobs to seed into the successor:
 * `{preset, sandbox, approval}` from the permission-presets projection, with a
 * per-owner fallback when that service is absent. A fully-empty state returns
 * `undefined` — nothing to inherit, so the successor takes the deployment
 * default exactly like a new session does.
 */
function collectPermissionState(services, session) {
  const permissionPresets = requestedService(services, 'permissionPresets')
  if (permissionPresets && typeof permissionPresets.permissionState === 'function') {
    try {
      const state = permissionPresets.permissionState(session)
      if (state && typeof state === 'object') {
        const knobs = {
          preset: typeof state.preset === 'string' ? state.preset : null,
          sandbox: typeof state.sandbox === 'string' ? state.sandbox : null,
          approval: typeof state.approval === 'string' ? state.approval : null,
        }
        if (knobs.preset || knobs.sandbox || knobs.approval) return knobs
        return undefined
      }
    } catch {
      // projection not ready — fall through to the individual owners
    }
  }

  let sandbox = null
  let approval = null
  const sandboxPolicy = requestedService(services, 'sandboxPolicy')
  if (sandboxPolicy && typeof sandboxPolicy.overrideOf === 'function') {
    try {
      const mode = sandboxPolicy.overrideOf(session)
      if (typeof mode === 'string') sandbox = mode
    } catch {
      // ignore: fallbacks below
    }
  }
  const approvalService = requestedService(services, 'approval')
  if (approvalService && typeof approvalService.overrideOf === 'function') {
    try {
      const policy = approvalService.overrideOf(session)
      if (typeof policy === 'string') approval = policy
    } catch {
      // ignore: fallbacks below
    }
  }
  if (!sandbox) {
    const shell = requestedService(services, 'shell')
    if (shell && typeof shell.sandboxMode === 'string') sandbox = shell.sandboxMode
  }
  if (!approval) {
    const configured =
      approvalService && approvalService.config && typeof approvalService.config.policy === 'string'
        ? approvalService.config.policy
        : ''
    if (configured) approval = configured
  }
  if (!sandbox && !approval) return undefined
  return { preset: null, sandbox, approval }
}

/**
 * Resolve the Workspace that owns `cwd`, read-only (no record is created or
 * mutated). Returns `undefined` when no Workspace owns the directory or the
 * registry is unavailable.
 */
async function resolveWorkspace(services, cwd) {
  if (!cwd) return undefined
  const registry = requestedService(services, 'workspaceRegistry')
  if (!registry || typeof registry.resolveByPath !== 'function') return undefined
  try {
    const workspace = await registry.resolveByPath(cwd)
    if (!workspace || typeof workspace.id !== 'string') return undefined
    return { workspace_id: workspace.id, path: typeof workspace.path === 'string' ? workspace.path : cwd }
  } catch {
    return undefined
  }
}

/**
 * Attach a freshly created successor to the Workspace that owns its cwd, so the
 * sidebar groups it with the handing-off session instead of "Ungrouped".
 * Returns a structured, always-serializable outcome; a failure is reported, not
 * swallowed (the successor still exists).
 */
async function attachToWorkspace(services, cwd, sessionId) {
  if (!cwd) return { attached: false, reason: 'cwd-unavailable' }
  const registry = requestedService(services, 'workspaceRegistry')
  if (!registry || typeof registry.resolveByPath !== 'function') {
    return { attached: false, reason: 'workspace-registry-unavailable' }
  }
  let workspace
  try {
    workspace = await registry.resolveByPath(cwd)
  } catch (error) {
    return { attached: false, reason: `workspace-resolve-failed: ${reasonOf(error)}` }
  }
  if (!workspace || typeof workspace.attachSession !== 'function') {
    return { attached: false, reason: 'no-workspace-owns-cwd' }
  }
  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    return { attached: false, reason: `workspace-attach-failed: ${reasonOf(error)}` }
  }
  return {
    attached: true,
    workspace_id: typeof workspace.id === 'string' ? workspace.id : UNAVAILABLE,
    path: typeof workspace.path === 'string' ? workspace.path : cwd,
  }
}

/**
 * Resolve the successor plan without acting on it.
 *
 * Matrix (frozen by the feature spec):
 *   - child with a LIVE parent and the subagents service → sibling under that parent
 *   - anything else (root, or child whose parent is gone, or `kind:"root"`) → new
 *     root session; a child that degrades to root reports `degraded` explicitly
 *   - no `agents` service → unavailable (the tool reports it, never guesses)
 *
 * `kind` may force the layer: `root` always builds a top-level session; `sibling`
 * requests a sibling and degrades to root when that is impossible.
 */
function planSuccessor(services, facts, requestedKind = 'auto') {
  const parentSession = facts.parentSession
  const agents = requestedService(services, 'agents')
  const subagents = requestedService(services, 'subagents')

  let liveParent
  if (parentSession && agents && typeof agents.get === 'function') {
    try {
      liveParent = agents.get(parentSession)
    } catch {
      liveParent = undefined
    }
  }
  const siblingCapable = Boolean(
    parentSession &&
      liveParent &&
      subagents &&
      typeof subagents.startActivation === 'function',
  )

  if (requestedKind !== 'root' && siblingCapable) {
    return { kind: 'sibling', available: true, parentSession, parentAgent: liveParent, degraded: '' }
  }
  if (agents && typeof agents.create === 'function') {
    const degraded =
      requestedKind !== 'root' && parentSession
        ? !liveParent
          ? 'parent-inactive'
          : 'subagents-unavailable'
        : ''
    return { kind: 'root', available: true, parentSession, parentAgent: undefined, degraded }
  }
  return {
    kind: 'root',
    available: false,
    parentSession,
    parentAgent: undefined,
    degraded: '',
    reason: 'agents service unavailable',
  }
}

/** Model/effort/workspace inheritance payload for the successor Agent. */
function buildAgentOptions(facts) {
  const options = {}
  if (facts.provider) options.provider = facts.provider
  if (facts.model) options.model = facts.model
  if (facts.reasoningEffort) options.reasoningEffort = facts.reasoningEffort
  if (isNumber(facts.maxTokens)) options.maxTokens = facts.maxTokens
  return options
}

function inheritanceLabel(facts) {
  return facts.provider && facts.model ? 'session-route' : 'provider-default'
}

/**
 * Append the captured permission facts onto the successor's own log exactly the
 * way `@deepseek-ai/dsh-subagent` seeds an in-process child: the events are the
 * store, `source:'delegation'` marks them as inherited, and they land inside
 * `setup` before the Agent is published so the permission-presets
 * `agent/created` pin sees them instead of installing deployment defaults.
 */
function appendInheritedPolicy(agent, permission) {
  if (!permission || !agent || !agent.session || typeof agent.session.append !== 'function') return
  const session = agent.session
  if (permission.preset) session.append('permission/preset', { preset: permission.preset })
  if (permission.sandbox) session.append('sandbox/mode', { mode: permission.sandbox, source: 'delegation' })
  if (permission.approval) session.append('approval/policy', { policy: permission.approval, source: 'delegation' })
}

/**
 * Build the pre-publication setup used by the root/degraded successor: mount the
 * source Agent preset composition (the "work mode" — same system-prompt
 * sections, skills and tool set), record the preset selection, seed the
 * inherited permission facts, and pin the working directory.
 *
 * Every step is individually guarded: a preset that no longer exists must not
 * prevent the successor from existing, but the failure is returned in `notes`
 * so the tool result and the recap file state it explicitly.
 */
function buildSuccessorSetup({ presetId, permission, cwd, notes, errors }) {
  return async function setup(agentCtx, agent) {
    const presets = requestedService(agentCtx, 'agentPresets')
    if (presetId) {
      if (!presets || typeof presets.mount !== 'function') {
        const message = `agent preset "${presetId}" not inherited: agent-presets service unavailable`
        notes.push(message)
        errors.presetError = message
      } else {
        try {
          const mounted = await presets.mount(agentCtx, presetId)
          const mountedId = mounted && typeof mounted.id === 'string' ? mounted.id : presetId
          if (agent && agent.session && typeof agent.session.append === 'function') {
            agent.session.append('agent-preset/selected', { agentPreset: mountedId })
          }
        } catch (error) {
          const message = `agent preset "${presetId}" not inherited: ${reasonOf(error)}`
          notes.push(message)
          errors.presetError = message
        }
      }
    }
    try {
      appendInheritedPolicy(agent, permission)
    } catch (error) {
      const message = `permission inheritance failed: ${reasonOf(error)}`
      notes.push(message)
      errors.permissionError = message
    }
    const workingDirectory = requestedService(agentCtx, 'workingDirectory')
    if (workingDirectory && typeof workingDirectory.set === 'function' && cwd) {
      try {
        await workingDirectory.set(agent, cwd, detachedSignal())
      } catch (error) {
        const message = `workingDirectory.set failed: ${reasonOf(error)}`
        notes.push(message)
        errors.workingDirectoryError = message
      }
    }
  }
}

function buildStatus(services, session, agent, thresholdPct) {
  return (async () => {
    const facts = collectFacts(services, session, agent)
    const plan = planSuccessor(services, facts)
    const workspace = await resolveWorkspace(services, facts.cwd)
    return {
      action: 'status',
      context_pct: isNumber(facts.pct) ? round1(facts.pct) : UNAVAILABLE,
      pressure_tokens: isNumber(facts.pressureTokens) ? facts.pressureTokens : UNAVAILABLE,
      context_window: isNumber(facts.contextWindow) ? facts.contextWindow : UNAVAILABLE,
      threshold_pct: thresholdPct,
      provider: facts.provider || UNAVAILABLE,
      model: facts.model || UNAVAILABLE,
      reasoning_effort: facts.reasoningEffort || UNAVAILABLE,
      agent_preset: facts.agentPreset || UNAVAILABLE,
      permission: facts.permission
        ? {
            preset: facts.permission.preset || UNAVAILABLE,
            sandbox: facts.permission.sandbox || UNAVAILABLE,
            approval: facts.permission.approval || UNAVAILABLE,
          }
        : UNAVAILABLE,
      cwd: facts.cwd || UNAVAILABLE,
      session_id: facts.sessionId || UNAVAILABLE,
      parent_session: facts.parentSession || UNAVAILABLE,
      workspace: workspace
        ? { workspace_id: workspace.workspace_id, path: workspace.path }
        : { workspace_id: UNAVAILABLE, path: UNAVAILABLE },
      successor_available: plan.available,
      successor_kind: plan.kind,
      recommended_action:
        isNumber(facts.pct) && facts.pct >= thresholdPct ? 'handoff' : 'continue',
      interface_language: resolveSuccessorPromptLanguage(services),
      notes: facts.notes,
    }
  })()
}

function buildSuccessorPrompt({ facts, handoffPath, language = 'en' }) {
  if (language === 'zh') {
    const origin = facts.sessionId || '上一个会话'
    return [
      `你是 ${origin} 的接替会话。上一个会话因上下文预算接近上限而把工作交棒给你。`,
      '',
      `请先读取交接文件：${handoffPath}`,
      '',
      '文件中记录了任务、当前状态、决策、变更文件、下一步与未决问题。',
      '请从「下一步」继续推进：不要重做文件中已记为完成的工作，保持相同的工作目录与',
      '模型/思考等级，并用一小段话说明你接下来要做什么。',
    ].join('\n')
  }
  const origin = facts.sessionId || 'the previous session'
  return [
    `You are the successor session for ${origin}, which handed off because its context budget is nearly full.`,
    '',
    `First read the handoff file at: ${handoffPath}`,
    '',
    'It records the task, current status, decisions, changed files, next steps and open questions.',
    'Then continue advancing the work from its next steps: do not redo work the handoff records',
    'as done, keep the same working directory and model/effort, and begin by stating in one short',
    'paragraph what you will do next.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Interface language
// ---------------------------------------------------------------------------

/**
 * The successor kickoff message is the first thing a new session reads, so it
 * speaks the language of the DSH interface instead of always English.
 *
 * Source of truth, in order:
 *   1. the live Loader entry `locale` (the package that owns the Language row):
 *      `options.config.preference` or the running fiber's effective config; a
 *      volatile reference is unwrapped through `get()`;
 *   2. the profile files `cordis.patch.yml` / `cordis.yml` (the durable layer
 *      the browser writes `locale.preference` into), so a composition without a
 *      Loader service still follows the stored preference;
 *   3. `en` — the documented DSH fallback and the historical behavior.
 */
const LOCALE_ENTRY_ID = 'locale'
const LOCALIZED_PROMPT_LANGUAGES = new Set(['zh', 'en'])
const PROFILES_CONFIG_FILES = ['cordis.patch.yml', 'cordis.yml']

/** Map a BCP 47-style id to a prompt language; unknown ids fall back to English. */
function normalizePromptLanguage(value) {
  if (typeof value !== 'string') return null
  const primary = value.trim().toLowerCase().split(/[-_]/)[0]
  if (!primary) return null
  return LOCALIZED_PROMPT_LANGUAGES.has(primary) ? primary : 'en'
}

/** Scan a Cordis config file for the `locale` entry's `preference` (YAML subset). */
function scanLocalePreference(text) {
  const lines = String(text).split(/\r?\n/)
  let inLocaleEntry = false
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      // A new top-level list item ends the previous entry.
      inLocaleEntry =
        /^-\s+id:\s*['"]?locale['"]?\s*(?:#.*)?$/.test(line) ||
        /^-\s+name:\s*['"]?@deepseek-ai\/dsh-client-locale['"]?\s*(?:#.*)?$/.test(line)
      continue
    }
    if (!inLocaleEntry) continue
    const match = /^\s+preference:\s*(.*)$/.exec(line)
    if (!match) continue
    const raw = match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    if (raw) return raw
  }
  return null
}

/** Read the DSH interface language preference, or `null` when none is stored. */
function readLocalePreference(services) {
  try {
    const loader =
      typeof services?.get === 'function' ? services.get('loader') : services?.loader
    if (loader && typeof loader.resolve === 'function') {
      const candidates = []
      try {
        candidates.push(loader.resolve(LOCALE_ENTRY_ID))
      } catch {
        // The entry may live inside a bundle subtree; scan by package name below.
      }
      if (typeof loader.entries === 'function') {
        for (const entry of loader.entries()) {
          if (entry?.options?.name === '@deepseek-ai/dsh-client-locale') candidates.push(entry)
        }
      }
      for (const entry of candidates) {
        const raw = entry?.options?.config
        let preference = raw?.preference
        if (preference && typeof preference.get === 'function') preference = preference.get()
        if (typeof preference === 'string' && preference.trim()) return preference.trim()
        let effective = entry?.fiber?.effectiveConfig?.preference
        if (effective && typeof effective.get === 'function') effective = effective.get()
        if (typeof effective === 'string' && effective.trim()) return effective.trim()
      }
    }
  } catch {
    // The loader service is not composed in every deployment; fall through.
  }
  // The Host process runs with the profile directory as its cwd (tree-engine's
  // relative dataDir proves it), and this app does not export DSH_PROFILE_DIR.
  const profileDirs = []
  if (process.env.DSH_PROFILE_DIR) profileDirs.push(process.env.DSH_PROFILE_DIR)
  profileDirs.push(process.cwd())
  for (const profileDir of profileDirs) {
    for (const fileName of PROFILES_CONFIG_FILES) {
      try {
        const preference = scanLocalePreference(readFileSync(path.join(profileDir, fileName), 'utf8'))
        if (preference) return preference
      } catch {
        // The file is optional; try the next source.
      }
    }
  }
  return null
}

/** Prompt language for the successor kickoff: DSH interface language → `zh`/`en`. */
function resolveSuccessorPromptLanguage(services) {
  return normalizePromptLanguage(readLocalePreference(services)) ?? 'en'
}

function bulletList(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['_(none recorded)_']
}

function numberedList(items) {
  return items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`) : ['_(none recorded)_']
}

function normalizeDetails(args) {
  return {
    summary: normalizeText(args.summary),
    nextSteps: normalizeList(args.next_steps),
    files: normalizeList(args.files),
    openQuestions: normalizeList(args.open_questions),
    note: normalizeText(args.note),
  }
}

/** Deterministic recap template: task / status / decisions / files / next / open questions / origin. */
function renderHandoffFile({ facts, details, handoffPath, stamp, nowIso, thresholdPct, workspace, language = 'en' }) {
  const contextLine = isNumber(facts.pct)
    ? `${round1(facts.pct)}% of ${facts.contextWindow} tokens (threshold ${thresholdPct}%)`
    : UNAVAILABLE
  const modelLine = facts.provider && facts.model ? `${facts.provider}/${facts.model}` : UNAVAILABLE
  const effortLine = facts.reasoningEffort || UNAVAILABLE
  const permissionLine = facts.permission
    ? `${facts.permission.preset || 'custom'} · sandbox=${facts.permission.sandbox || UNAVAILABLE} · approval=${facts.permission.approval || UNAVAILABLE}`
    : UNAVAILABLE
  const workspaceLine = workspace
    ? `\`${workspace.workspace_id}\` (\`${workspace.path}\`)`
    : UNAVAILABLE
  return [
    `# Session handoff — ${stamp}`,
    '',
    '> Generated by the `session_handoff` tool. Read this file first, then continue the work it records.',
    '',
    '## Task',
    details.summary || '_(not recorded)_',
    '',
    '## Current status',
    `- Session: \`${facts.sessionId || UNAVAILABLE}\``,
    `- Parent session: \`${facts.parentSession || UNAVAILABLE}\``,
    `- Workspace: \`${facts.cwd || UNAVAILABLE}\``,
    `- Handoff file: \`${handoffPath}\``,
    `- Context: ${contextLine}`,
    `- Model: ${modelLine} · reasoning effort: ${effortLine}`,
    `- Agent preset (work mode): ${facts.agentPreset || UNAVAILABLE}`,
    `- Permission preset: ${permissionLine}`,
    `- Sidebar workspace: ${workspaceLine}`,
    '',
    '## Decisions',
    details.note || '_(not recorded)_',
    '',
    '## Changed files',
    ...bulletList(details.files),
    '',
    '## Next steps',
    ...numberedList(details.nextSteps),
    '',
    '## Open questions',
    ...bulletList(details.openQuestions),
    '',
    '## Original session',
    `- session_id: \`${facts.sessionId || UNAVAILABLE}\``,
    `- parent_session: \`${facts.parentSession || UNAVAILABLE}\``,
    `- provider: ${facts.provider || UNAVAILABLE}`,
    `- model: ${facts.model || UNAVAILABLE}`,
    `- reasoning_effort: ${effortLine}`,
    `- agent_preset: ${facts.agentPreset || UNAVAILABLE}`,
    `- permission_preset: ${permissionLine}`,
    `- cwd: \`${facts.cwd || UNAVAILABLE}\``,
    `- generated_at: ${nowIso}`,
    '',
    '## Successor instructions',
    buildSuccessorPrompt({ facts, handoffPath, language }),
    '',
  ].join('\n')
}

function successorUserMessage(prompt) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }
}

/**
 * Send the handoff prompt to the new root Agent. `followup` is the documented
 * primitive; `send` is the same inbox path and is kept as a defensive fallback
 * for a Host build that renames/removes the alias.
 */
async function sendFirstMessage(agent, message) {
  if (typeof agent.followup === 'function') {
    await agent.followup(message)
    return
  }
  if (typeof agent.send === 'function') {
    await agent.send(message)
    return
  }
  throw new Error('successor agent exposes neither followup() nor send()')
}

/** The inheritance facts every successor reports, whichever layer it runs at. */
function inheritanceFacts(facts) {
  return {
    agent_preset: facts.agentPreset || UNAVAILABLE,
    permission: facts.permission
      ? {
          preset: facts.permission.preset || UNAVAILABLE,
          sandbox: facts.permission.sandbox || UNAVAILABLE,
          approval: facts.permission.approval || UNAVAILABLE,
        }
      : UNAVAILABLE,
    model: facts.model || UNAVAILABLE,
    reasoning_effort: facts.reasoningEffort || UNAVAILABLE,
    max_tokens: isNumber(facts.maxTokens) ? facts.maxTokens : UNAVAILABLE,
  }
}

/**
 * Start the successor session. Throws on every failure path; the caller keeps
 * the already-written handoff file and reports `spawn_error` instead.
 *
 * `notes` collects non-fatal inheritance failures (preset mount, workspace
 * attach, working directory) so they travel back in `warnings` instead of being
 * hidden behind a success status.
 */
async function spawnSuccessor({ services, plan, facts, prompt, notes, errors }) {
  const agentOptions = buildAgentOptions(facts)
  const inherited = inheritanceLabel(facts)

  if (plan.kind === 'sibling') {
    const subagents = requestedService(services, 'subagents')
    const activation = await subagents.startActivation({
      provider: SUCCESSOR_PROVIDER,
      label: `handoff ${shortSessionId(facts.sessionId)}`,
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: plan.parentAgent,
        cwd: facts.cwd,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      },
      signal: detachedSignal(),
      delivery: 'parent',
    })
    const childId = activation && activation.childId
    if (!childId) throw new Error('subagents.startActivation returned no childId')
    return {
      session_id: String(childId),
      kind: 'sibling',
      parent_session: plan.parentSession || UNAVAILABLE,
      ...inheritanceFacts(facts),
      inherited,
      inherited_by: 'subagent-delegation',
      workspace: {
        attached: false,
        reason: 'sibling-appears-under-its-parent (no workspace attach needed)',
      },
    }
  }

  const agents = requestedService(services, 'agents')
  const sessionId = `session-${randomUUID()}`
  const setup = buildSuccessorSetup({
    presetId: facts.agentPreset,
    permission: facts.permission,
    cwd: facts.cwd,
    notes,
    errors,
  })
  const meta = {
    cwd: facts.cwd,
    ...(facts.agentPreset ? { agentPreset: facts.agentPreset } : {}),
  }
  // A child whose parent Agent is gone stays a durable child (same lineage) but
  // is created as an ordinary session: `parentSession` records the lineage, and
  // omitting `parentAgent` is what keeps the runtime from requiring a live parent.
  if (plan.degraded === 'parent-inactive' && plan.parentSession) meta.parentSession = plan.parentSession

  const handle = await agents.create({
    sessionId,
    meta,
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    setup,
    signal: detachedSignal(),
  })
  const agent = handle && handle.agent
  if (!agent) throw new Error('agents.create returned no agent handle')
  const successorId = String(agent.id || sessionId)

  // Same-workspace attribution: the sidebar groups by `workspace.sessionIds`
  // membership, not by cwd, so an unattached successor would show as Ungrouped.
  const workspace = await attachToWorkspace(services, facts.cwd, successorId)
  if (!workspace.attached && workspace.reason !== 'workspace-registry-unavailable') {
    notes.push(`successor not attached to a sidebar workspace: ${workspace.reason}`)
  }

  await sendFirstMessage(agent, successorUserMessage(prompt))
  return {
    session_id: successorId,
    kind: 'root',
    parent_session: plan.degraded === 'parent-inactive' ? plan.parentSession || UNAVAILABLE : UNAVAILABLE,
    ...inheritanceFacts(facts),
    inherited,
    inherited_by: 'agent-create+setup',
    workspace,
    ...(errors.presetError ? { preset_error: errors.presetError } : {}),
    ...(errors.permissionError ? { permission_error: errors.permissionError } : {}),
    ...(errors.workingDirectoryError ? { working_directory_error: errors.workingDirectoryError } : {}),
  }
}

/** One-line, bounded render for the calling model (never the recap body). */
function renderSummary(args, value) {
  const action = (args && args.action) || (value && value.action) || ''
  if (!value || typeof value !== 'object') return `session_handoff: ${action || 'done'}`
  const oneLine = (text) => String(text).replace(/\s+/g, ' ').slice(0, 400)
  if (action === 'status') {
    const permission =
      value.permission && typeof value.permission === 'object'
        ? `${value.permission.preset}/${value.permission.sandbox}/${value.permission.approval}`
        : value.permission
    return oneLine(
      `session_handoff status: context=${value.context_pct}` +
        `${value.context_pct === UNAVAILABLE ? '' : '%'} (threshold ${value.threshold_pct}%)` +
        ` pressure=${value.pressure_tokens}/${value.context_window}` +
        ` model=${value.provider}/${value.model} effort=${value.reasoning_effort}` +
        ` preset=${value.agent_preset} permission=${permission}` +
        ` successor=${value.successor_available ? value.successor_kind : 'unavailable'}` +
        ` next=${value.recommended_action} lang=${value.interface_language}`,
    )
  }
  if (value.status === 'rejected') {
    return oneLine(
      value.reason === 'below-threshold'
        ? `session_handoff rejected: context ${value.context_pct}% is below threshold ${value.threshold_pct}% (pass force:true to override)`
        : `session_handoff rejected: a handoff already succeeded in this session (${value.last_handoff_at}); pass force:true to override`,
    )
  }
  if (value.status === 'file-only') {
    return oneLine(
      `session_handoff: wrote ${value.handoff_path} (no successor spawned; lang=${value.interface_language})`,
    )
  }
  if (value.status === 'handed-off') {
    const successor = value.successor || {}
    const workspace =
      successor.workspace && successor.workspace.attached
        ? ` workspace=${successor.workspace.workspace_id}`
        : ''
    return oneLine(
      `session_handoff: wrote ${value.handoff_path}; successor ${successor.session_id} ` +
        `kind=${successor.kind}${value.degraded ? ` degraded=${value.degraded}` : ''} ` +
        `preset=${successor.agent_preset}${workspace} inherited=${successor.inherited} ` +
        `lang=${value.interface_language}`,
    )
  }
  if (value.spawn_error) {
    return oneLine(
      `session_handoff: wrote ${value.handoff_path}; successor FAILED: ${value.spawn_error}`,
    )
  }
  return oneLine(`session_handoff: ${value.status || 'done'}`)
}

/**
 * Model-facing tool definition. Wording follows the repository's agent-
 * experience convention: when to use first, parameter rules on the parameters,
 * bounded one-line results.
 */
export const HANDOFF_TOOL = {
  name: 'session_handoff',
  description:
    'Hand off this session to a fresh successor session before its context fills. Call with action "status" ' +
    'when context is near 50% to read the current context pressure, the facts the successor will inherit, and ' +
    'the successor plan; call action "handoff" at or above the threshold (default 50%) or when the user asks to ' +
    'hand off. handoff writes a HANDOFF-<id>-<timestamp>.md recap into the session working directory and, unless ' +
    'spawn:false, starts a same-level successor: a sibling under the same live parent when this session is a ' +
    'child, otherwise a new root session. The successor inherits the same provider/model/reasoning effort, the ' +
    'same Agent preset (work mode, and therefore the same tools), the same permission preset (sandbox + approval) ' +
    'and working directory, and a root successor is attached to the same sidebar workspace. The successor is ' +
    'told to read the handoff file and continue. Returns bounded JSON: handoff_path, successor identity and the ' +
    'inherited facts, degraded/spawn_error/warnings when applicable; a below-threshold or repeated call is ' +
    'rejected with its current percentage.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'handoff'],
        description: 'status reads only; handoff writes the recap file and may start the successor.',
      },
      kind: {
        type: 'string',
        enum: ['root', 'sibling', 'auto'],
        description:
          'handoff only. auto (default) uses sibling when this session is a child whose parent is live, else root. ' +
          'root forces a new top-level session; sibling requests a sibling and degrades to root with ' +
          'degraded:"parent-inactive" when the parent is gone.',
      },
      summary: {
        type: 'string',
        description:
          'handoff only, required. One-paragraph task recap written into the file\'s Task section.',
      },
      next_steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'handoff only. Ordered remaining steps for the successor.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'handoff only. Files this session created or modified.',
      },
      open_questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'handoff only. Unresolved questions the successor must keep in view.',
      },
      note: {
        type: 'string',
        description: 'handoff only. Decisions and constraints worth preserving.',
      },
      spawn: {
        type: 'boolean',
        description:
          'handoff only. false writes the recap file and skips the successor session; default true.',
      },
      threshold_pct: {
        type: 'number',
        description:
          'handoff guard and status reference: minimum context percentage required without force, 0-100, default 50.',
      },
      force: {
        type: 'boolean',
        description:
          'handoff only. Bypass both the threshold guard and the 5-minute duplicate guard; default false.',
      },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object' },
    render: (args, value) => [{ type: 'text', text: renderSummary(args, value) }],
  },
}

/**
 * Build the tool executor. Exported for offline tests; `apply` wires it to the
 * real Host services. `options.state` (Map of session id → last handoff) is the
 * in-memory duplicate guard; `options.now` and `options.duplicateWindowMs` let
 * tests control time.
 */
export function makeExecute(services, options = {}) {
  const state = options.state instanceof Map ? options.state : new Map()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const duplicateWindowMs = isNumber(options.duplicateWindowMs)
    ? options.duplicateWindowMs
    : DUPLICATE_WINDOW_MS

  return async function execute(rawArgs, exec) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
    const action = String(args.action || '').trim()
    const session = sessionOf(exec)
    const agent = agentOf(exec)
    const thresholdPct = normalizeThreshold(args.threshold_pct)

    if (action === 'status') return buildStatus(services, session, agent, thresholdPct)
    if (action !== 'handoff') {
      throw new Error('session_handoff: "action" must be "status" or "handoff"')
    }

    const force = args.force === true
    // `spawn:false` is a dry run: it only writes the recap file, so the
    // threshold guard must not block it (a below-threshold session can still
    // produce a preview recap). The duplicate guard still applies to it.
    const fileOnly = args.spawn === false
    const requestedKind = normalizeKind(args.kind)
    const facts = collectFacts(services, session, agent)

    // 1. Threshold guard: refuse an accidental early handoff, returning the pct.
    if (!force && !fileOnly && isNumber(facts.pct) && facts.pct < thresholdPct) {
      return {
        action: 'handoff',
        status: 'rejected',
        reason: 'below-threshold',
        context_pct: round1(facts.pct),
        threshold_pct: thresholdPct,
        hint: 'Pass force:true only when the user explicitly wants to hand off before the threshold; spawn:false writes the recap without spawning and is not blocked by this guard.',
        warnings: [],
      }
    }

    if (!facts.cwd) {
      throw new Error(
        'session_handoff: cannot determine the session working directory ' +
          '(session.header.cwd and workingDirectory are both unavailable)',
      )
    }

    // 2. Duplicate guard: one successful handoff per session per 5 minutes.
    const nowMs = Number(now()) || Date.now()
    const previous = state.get(facts.sessionId)
    if (!force && previous && nowMs - previous.at < duplicateWindowMs) {
      return {
        action: 'handoff',
        status: 'rejected',
        reason: 'recent-handoff',
        last_handoff_at: new Date(previous.at).toISOString(),
        handoff_path: previous.path,
        context_pct: isNumber(facts.pct) ? round1(facts.pct) : UNAVAILABLE,
        threshold_pct: thresholdPct,
        hint: 'A handoff already succeeded in this session within the last 5 minutes; pass force:true to write another handoff file.',
        warnings: [],
      }
    }

    const details = normalizeDetails(args)
    if (!details.summary) {
      throw new Error('session_handoff: "summary" is required (non-empty) for action "handoff"')
    }

    const warnings = []
    if (!isNumber(facts.pct)) {
      warnings.push('context percentage unavailable: the threshold guard could not be evaluated')
    }
    // Only warn about missing inheritance facts when the owning service is
    // actually composed: a composition without agent-preset/permission services
    // has nothing to inherit, which is not a defect (and would be noise in
    // every minimal deployment).
    const presetsService = requestedService(services, 'agentPresets')
    if (!facts.agentPreset && presetsService) {
      warnings.push('agent preset unavailable: the successor composition may differ from this session')
    }
    const permissionService =
      requestedService(services, 'permissionPresets') ||
      requestedService(services, 'sandboxPolicy') ||
      requestedService(services, 'approval')
    if (!facts.permission && permissionService) {
      warnings.push('permission state unavailable: the successor takes the deployment default preset')
    }

    // 3. Write the durable recap first: a spawn failure must not lose it.
    const stamp = formatStamp(new Date(nowMs))
    const fileName = `HANDOFF-${shortSessionId(facts.sessionId)}-${stamp}.md`
    const handoffPath = path.resolve(facts.cwd, fileName)
    const language = resolveSuccessorPromptLanguage(services)
    const prompt = buildSuccessorPrompt({ facts, handoffPath, language })
    const workspace = await resolveWorkspace(services, facts.cwd)
    const content = renderHandoffFile({
      facts,
      details,
      handoffPath,
      stamp,
      nowIso: new Date(nowMs).toISOString(),
      thresholdPct,
      workspace,
      language,
    })
    try {
      await fsp.mkdir(facts.cwd, { recursive: true })
      await fsp.writeFile(handoffPath, content, 'utf8')
    } catch (error) {
      throw new Error(
        `session_handoff: could not write the handoff file at ${handoffPath} — ${reasonOf(error)}`,
      )
    }
    state.set(facts.sessionId, { at: nowMs, path: handoffPath })

    const response = {
      action: 'handoff',
      status: 'handoff-file-written',
      handoff_path: handoffPath,
      context_pct: isNumber(facts.pct) ? round1(facts.pct) : UNAVAILABLE,
      threshold_pct: thresholdPct,
      context_window: isNumber(facts.contextWindow) ? facts.contextWindow : UNAVAILABLE,
      cwd: facts.cwd,
      session_id: facts.sessionId || UNAVAILABLE,
      parent_session: facts.parentSession || UNAVAILABLE,
      agent_preset: facts.agentPreset || UNAVAILABLE,
      permission: facts.permission || UNAVAILABLE,
      workspace: workspace || { workspace_id: UNAVAILABLE, path: UNAVAILABLE },
      interface_language: language,
      warnings,
    }

    if (args.spawn === false) {
      response.status = 'file-only'
      response.successor = UNAVAILABLE
      response.spawn = 'skipped'
      return response
    }

    // 4. Start the successor. Any failure keeps the file and reports explicitly.
    const plan = planSuccessor(services, facts, requestedKind)
    if (!plan.available) {
      response.spawn_error = `no successor path available (${plan.reason || 'agents service unavailable'})`
      response.successor = UNAVAILABLE
      return response
    }
    const setupNotes = []
    const setupErrors = {}
    try {
      response.successor = await spawnSuccessor({
        services,
        plan,
        facts,
        prompt,
        notes: setupNotes,
        errors: setupErrors,
      })
      response.status = 'handed-off'
      if (plan.degraded) response.degraded = plan.degraded
      if (setupNotes.length > 0) response.warnings = [...warnings, ...setupNotes]
      if (
        response.successor.workspace &&
        response.successor.workspace.attached === false &&
        response.successor.workspace.reason !== 'workspace-registry-unavailable'
      ) {
        // Reported structurally on the successor and as a human warning.
        response.warnings = [
          ...response.warnings,
          `successor workspace attribution: ${response.successor.workspace.reason || 'not attached'}`,
        ]
      }
      return response
    } catch (error) {
      response.spawn_error = reasonOf(error)
      response.successor = UNAVAILABLE
      if (setupNotes.length > 0) response.warnings = [...warnings, ...setupNotes]
      return response
    }
  }
}

export function apply(ctx) {
  // Optional services: each tool stays unregistered in a composition that lacks
  // its required services instead of failing the whole plugin.
  ctx.inject(['tools', 'subagents', 'sessionQuery'], (scoped) => {
    const services = scoped || ctx
    services.tools.register({ ...TREE_SEND, execute: makeTreeSendExecute(services) })
  })
  ctx.inject(['tools', 'subagents', 'agents', 'tokenMeter'], (scoped) => {
    const services = scoped || ctx
    services.tools.register({ ...HANDOFF_TOOL, execute: makeExecute(services) })
  })
}
