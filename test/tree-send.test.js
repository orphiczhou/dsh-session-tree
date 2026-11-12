/**
 * Offline tests for `tree_send` v1.4.0 — same-tree delivery only.
 *
 * The security contract pinned here:
 *   1. the `parent` argument is gone from the schema and an explicit value is
 *      rejected by the executor (the Host resolves the address);
 *   2. the caller identity is ambient (`exec.agent.session.id`) and never comes
 *      from arguments;
 *   3. the caller and target parent chains are both walked to their roots and
 *      delivery is allowed only when the roots match (same session tree:
 *      ancestors, siblings, and any other member of that one tree);
 *   4. cross-tree delivery, a missing caller, a self-send, and any unreadable /
 *      broken / cyclic / incomplete parent chain fail closed (`E_*` codes);
 *   5. `delivery: steer|queue`, the `{messageId,parent,delivery}` result and the
 *      one-line render text are unchanged.
 *
 * Host services are faked at the two seams the tool consumes:
 * `sessionQuery` (both the shipped `traceSession` ancestry primitive and the
 * per-hop `filterSessions` fallback) and `subagents.prompt`. No @deepseek-ai
 * package is loaded and no real session is created.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, makeTreeSendExecute, TREE_SEND } from '../index.js'

// ---------------------------------------------------------------------------
// Fixture tree: A(root) → MID → {LEAF_A1, LEAF_A2}; LEAF_A1 → GRAND.
// A second, unrelated tree B(root) → CHILD_B. Id forms mirror the real Host
// (root sessions carry the `session-` prefix, subagent children do not).
// ---------------------------------------------------------------------------
const ROOT_A = 'session-root-aaaaaaaa'
const MID_A = 'mid-aaaaaaaa'
const LEAF_A1 = 'leaf-aaaaaaaa-1'
const LEAF_A2 = 'leaf-aaaaaaaa-2'
const GRAND_A = 'grand-aaaaaaaa'
const ROOT_B = 'session-root-bbbbbbbb'
const CHILD_B = 'child-bbbbbbbb'

/** Durable store: session id → direct parent id (`null` marks a root). */
function treeA() {
  return {
    [ROOT_A]: null,
    [MID_A]: ROOT_A,
    [LEAF_A1]: MID_A,
    [LEAF_A2]: MID_A,
    [GRAND_A]: LEAF_A1,
  }
}

function treeB() {
  return { [ROOT_B]: null, [CHILD_B]: ROOT_B }
}

/** Both trees in one session store — the cross-tree scenario. */
function bothTrees() {
  return { ...treeA(), ...treeB() }
}

/**
 * Fake Host services plus a call log.
 *
 * By default only `filterSessions` is exposed, so every test exercises the
 * per-hop fallback — the seam this suite is asked to cover. `trace: true` adds
 * the shipped `traceSession` primitive and makes the tool prefer it (the
 * production path on the tested DSH build); `filterThrows` / `traceThrows` /
 * `promptThrows` inject the failure paths.
 */
function makeHarness(store, options = {}) {
  const calls = { filterSessions: [], traceSession: [], prompt: [] }

  const headerFor = (id) => {
    if (!Object.prototype.hasOwnProperty.call(store, id)) return undefined
    const parent = store[id]
    return parent ? { id, parentSession: parent } : { id }
  }
  const recordFor = (id) => ({ header: headerFor(id), live: true, persisted: true })

  const query = {
    async filterSessions(filters, signal) {
      calls.filterSessions.push({ filters, signal })
      if (options.filterThrows) throw new Error(options.filterThrows)
      const ids = []
      for (const filter of filters || []) {
        if (filter && filter.kind === 'id' && Array.isArray(filter.values)) ids.push(...filter.values)
      }
      return ids.map(recordFor).filter((record) => record.header !== undefined)
    },
  }

  if (options.trace === true) {
    query.traceSession = async (sessionId, signal) => {
      calls.traceSession.push({ sessionId, signal })
      if (options.traceThrows) {
        const error = new Error(options.traceThrows)
        error.code = options.traceThrowsCode || 'SESSION_QUERY_UNAVAILABLE'
        throw error
      }
      if (!Object.prototype.hasOwnProperty.call(store, sessionId)) {
        const error = new Error(`session "${sessionId}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      const ancestors = []
      const seen = new Set([sessionId])
      let current = store[sessionId] || ''
      let unresolvedParentId
      while (current) {
        if (seen.has(current)) {
          const error = new Error(`session lineage contains a cycle at "${current}"`)
          error.code = 'SESSION_QUERY_INVALID_LINEAGE'
          throw error
        }
        seen.add(current)
        if (!Object.prototype.hasOwnProperty.call(store, current)) {
          unresolvedParentId = current
          break
        }
        ancestors.push(recordFor(current))
        current = store[current] || ''
      }
      const target = recordFor(sessionId)
      if (unresolvedParentId) {
        return { target, ancestors, descendants: [], complete: false, unresolvedParentId }
      }
      return {
        target,
        ancestors,
        descendants: [],
        complete: true,
        root: ancestors.length > 0 ? ancestors[ancestors.length - 1] : target,
      }
    }
  }

  const subagents = {
    async prompt(request, signal) {
      calls.prompt.push({ request, signal })
      if (options.promptThrows) {
        const error = new Error(options.promptThrows)
        error.code = options.promptThrowsCode || 'subagent/parent-unavailable'
        throw error
      }
      return { messageId: options.messageId || 'message-accepted-1' }
    },
  }

  return { services: { sessionQuery: query, subagents }, calls }
}

/** An executor context carrying the ambient calling session (never an arg). */
function makeExec(sessionId) {
  if (sessionId === undefined) return {}
  return { agent: { session: { id: sessionId } }, signal: new AbortController().signal }
}

// ===========================================================================
// Schema: the removed parameter and the preserved result shape
// ===========================================================================

test('schema：parent 入参已移除，delivery 仍为 steer|queue，required 不变', () => {
  assert.equal(TREE_SEND.name, 'tree_send')
  const params = TREE_SEND.parameters
  assert.equal(params.type, 'object')
  assert.equal(params.additionalProperties, false)
  assert.deepEqual(Object.keys(params.properties).sort(), ['delivery', 'message', 'target'])
  assert.equal(Object.prototype.hasOwnProperty.call(params.properties, 'parent'), false)
  assert.deepEqual(params.required, ['target', 'message'])
  assert.deepEqual(params.properties.delivery.enum, ['steer', 'queue'])
  assert.match(TREE_SEND.description, /own session tree/i)
  // The result contract is unchanged: messageId/parent/delivery.
  assert.deepEqual(TREE_SEND.output.schema.required, ['messageId', 'parent', 'delivery'])
  const rendered = TREE_SEND.output.render(
    { target: LEAF_A2 },
    { messageId: 'm-1', parent: MID_A, delivery: 'steer' },
  )
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, `tree_send: delivered to ${LEAF_A2} (parent ${MID_A}, steer)`)
})

test('apply：tree_send 以同一份 schema 注册，execute 可用', () => {
  const registered = []
  const fakeCtx = {
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    inject: (deps, callback) => callback(fakeCtx),
  }
  apply(fakeCtx)
  const tool = registered.find((definition) => definition.name === 'tree_send')
  assert.ok(tool, `tree_send not registered: ${JSON.stringify(registered.map((d) => d.name))}`)
  assert.deepEqual(tool.parameters, TREE_SEND.parameters)
  assert.equal(typeof tool.execute, 'function')
  // Both Host tools still come from one bundle.
  assert.ok(registered.some((definition) => definition.name === 'session_handoff'))
})

// ===========================================================================
// Same-tree delivery is allowed (filterSessions fallback path)
// ===========================================================================

test('同树兄弟：caller=LEAF_A1 → target=LEAF_A2 允许，经共同直接父 MID_A 投递', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  const result = await execute(
    { target: LEAF_A2, message: '你问的 schema 在 src/session/title/types.ts。' },
    makeExec(LEAF_A1),
  )

  assert.deepEqual(result, {
    messageId: 'message-accepted-1',
    parent: MID_A,
    delivery: 'steer',
  })
  assert.equal(calls.prompt.length, 1)
  const { request, signal } = calls.prompt[0]
  assert.equal(request.parentSessionId, MID_A)
  assert.equal(request.childSessionId, LEAF_A2)
  assert.equal(request.mode, 'continuable')
  assert.equal(request.delivery, 'steer')
  assert.deepEqual(request.content, [
    { type: 'text', text: '你问的 schema 在 src/session/title/types.ts。' },
  ])
  assert.match(request.requestId, /^session-tree-/)
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
})

test('同树祖先：root → 孙会话允许（同根），投递地址仍是目标的直接父 LEAF_A1', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  const result = await execute({ target: GRAND_A, message: 'root 给孙会话' }, makeExec(ROOT_A))

  assert.equal(result.parent, LEAF_A1)
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].request.parentSessionId, LEAF_A1)
  assert.equal(calls.prompt[0].request.childSessionId, GRAND_A)
})

test('同树中间层 → 孙会话允许（caller 是祖先但不一定是根）', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  const result = await execute({ target: GRAND_A, message: '中间层给孙会话' }, makeExec(MID_A))

  assert.equal(result.parent, LEAF_A1)
  assert.equal(calls.prompt.length, 1)
})

test('同树向上：孙会话 → 其祖先 MID_A 允许（同根即可，不要求邻接）', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  const result = await execute({ target: MID_A, message: '向上回报' }, makeExec(GRAND_A))

  assert.equal(result.parent, ROOT_A)
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].request.childSessionId, MID_A)
})

test('delivery=queue 原样透传，返回 {messageId,parent,delivery}', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  const result = await execute(
    { target: LEAF_A2, message: '下个 turn 再看', delivery: 'queue' },
    makeExec(LEAF_A1),
  )

  assert.equal(result.delivery, 'queue')
  assert.equal(calls.prompt[0].request.delivery, 'queue')
})

// ===========================================================================
// Cross-tree delivery is refused
// ===========================================================================

test('跨树拒绝：caller 在树 A、target 在树 B → E_CROSS_TREE_SEND（含 caller/target/两个根）', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: CHILD_B, message: '跨树注入' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /^tree_send: E_CROSS_TREE_SEND: /)
      assert.equal(error.code, 'E_CROSS_TREE_SEND')
      for (const expected of [LEAF_A1, CHILD_B, ROOT_A, ROOT_B]) {
        assert.ok(error.message.includes(expected), `error must name ${expected}: ${error.message}`)
      }
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('跨树拒绝：root caller 向另一棵树的子会话投递同样被拒', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: CHILD_B, message: 'x' }, makeExec(ROOT_A)),
    /E_CROSS_TREE_SEND/,
  )
  assert.equal(calls.prompt.length, 0)
})

// ===========================================================================
// Removed `parent` argument / caller identity are enforced
// ===========================================================================

test('显式 parent 参数被拒（E_PARENT_REMOVED），且不做任何投递', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  for (const parent of [MID_A, '', 'session-forged-parent']) {
    await assert.rejects(
      execute({ target: LEAF_A2, message: 'x', parent }, makeExec(LEAF_A1)),
      (error) => {
        assert.match(error.message, /^tree_send: E_PARENT_REMOVED: /)
        assert.equal(error.code, 'E_PARENT_REMOVED')
        assert.match(error.message, /not accepted|removed in v1\.4\.0/)
        return true
      },
    )
  }
  assert.equal(calls.prompt.length, 0)
})

test('caller 缺失/不可解析 → E_CALLER_REQUIRED，不投递', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  for (const exec of [
    {},
    { agent: {} },
    { agent: { session: {} } },
    { agent: { session: { id: '   ' } } },
    { agent: { session: { id: 42 } } },
  ]) {
    await assert.rejects(
      execute({ target: LEAF_A2, message: 'x' }, exec),
      (error) => {
        assert.match(error.message, /^tree_send: E_CALLER_REQUIRED: /)
        assert.equal(error.code, 'E_CALLER_REQUIRED')
        assert.match(error.message, /no calling session/)
        return true
      },
    )
  }
  assert.equal(calls.prompt.length, 0)
})

test('caller 与 target 相同 → E_SEND_TO_SELF', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: LEAF_A1, message: 'self' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /^tree_send: E_SEND_TO_SELF: /)
      assert.equal(error.code, 'E_SEND_TO_SELF')
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

// ===========================================================================
// Fail-closed lineage handling (unverifiable tree never means "same tree")
// ===========================================================================

test('target 不是子会话（日志无 parentSession）→ 保持原错误', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: ROOT_A, message: 'x' }, makeExec(LEAF_A1)),
    /is not a subagent session \(its log has no parentSession\)/,
  )
  assert.equal(calls.prompt.length, 0)
})

test('target 不在会话库 → E_LINEAGE_UNRESOLVED fail-closed', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: 'ghost-session-id', message: 'x' }, makeExec(LEAF_A1)),
    /E_LINEAGE_UNRESOLVED/,
  )
  assert.equal(calls.prompt.length, 0)
})

test('parent 链读取失败（sessionQuery 抛错）→ E_LINEAGE_UNRESOLVED fail-closed', async () => {
  const { services, calls } = makeHarness(bothTrees(), { filterThrows: 'boom-session-store' })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: LEAF_A2, message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /^tree_send: E_LINEAGE_UNRESOLVED: /)
      assert.match(error.message, /boom-session-store/)
      assert.match(error.message, /fail-closed/)
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('parent 链断在中途 → fail-closed（断链不能被当作同树）', async () => {
  const store = { ...bothTrees(), [GRAND_A]: 'missing-grandparent' }
  const { services, calls } = makeHarness(store)
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: GRAND_A, message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /broken at missing-grandparent/)
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('parent 链成环 → fail-closed', async () => {
  const store = { ...bothTrees(), loopA: 'loopB', loopB: 'loopA' }
  const { services, calls } = makeHarness(store)
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: 'loopA', message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /cyclic/)
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('sessionQuery 服务缺失 → E_LINEAGE_UNRESOLVED fail-closed', async () => {
  const services = { subagents: { prompt: async () => ({ messageId: 'never' }) } }
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: LEAF_A2, message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /sessionQuery service is unavailable/)
      return true
    },
  )
})

test('投递服务拒绝时错误格式保持不变（tree_send: delivery rejected — <code>: …）', async () => {
  const { services } = makeHarness(bothTrees(), {
    promptThrows: 'parent session is not live',
    promptThrowsCode: 'subagent/parent-unavailable',
  })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: LEAF_A2, message: 'x' }, makeExec(LEAF_A1)),
    /tree_send: delivery rejected — subagent\/parent-unavailable: parent session is not live$/,
  )
})

// ===========================================================================
// Production path: the shipped sessionQuery.traceSession ancestry primitive
// ===========================================================================

test('traceSession 路径：同树兄弟放行，两棵树各解析一次且不退化到 filterSessions', async () => {
  const { services, calls } = makeHarness(bothTrees(), { trace: true })
  const execute = makeTreeSendExecute(services)

  const result = await execute({ target: LEAF_A2, message: 'x' }, makeExec(LEAF_A1))

  assert.deepEqual(result, { messageId: 'message-accepted-1', parent: MID_A, delivery: 'steer' })
  assert.equal(calls.traceSession.length, 2)
  assert.deepEqual(
    calls.traceSession.map((call) => call.sessionId).sort(),
    [LEAF_A1, LEAF_A2].sort(),
  )
  assert.equal(calls.filterSessions.length, 0)
})

test('traceSession 路径：跨树拒绝 → E_CROSS_TREE_SEND', async () => {
  const { services, calls } = makeHarness(bothTrees(), { trace: true })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: CHILD_B, message: 'x' }, makeExec(ROOT_A)),
    /E_CROSS_TREE_SEND/,
  )
  assert.equal(calls.prompt.length, 0)
})

test('traceSession 路径：complete=false（祖先不可读）→ E_LINEAGE_UNRESOLVED fail-closed', async () => {
  const store = bothTrees()
  delete store[LEAF_A1] // GRAND_A's chain now ends at the unresolved parent
  const { services, calls } = makeHarness(store, { trace: true })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: GRAND_A, message: 'x' }, makeExec(LEAF_A2)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /incomplete/)
      assert.match(error.message, new RegExp(LEAF_A1))
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('traceSession 路径：SESSION_QUERY_SESSION_NOT_FOUND 被映射为 E_LINEAGE_UNRESOLVED', async () => {
  const { services, calls } = makeHarness(bothTrees(), { trace: true })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: 'ghost-session-id', message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /SESSION_QUERY_SESSION_NOT_FOUND/)
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

test('traceSession 路径：traceSession 抛错 → fail-closed，可操作错误含原因', async () => {
  const { services, calls } = makeHarness(bothTrees(), {
    trace: true,
    traceThrows: 'corpus listing failed',
  })
  const execute = makeTreeSendExecute(services)

  await assert.rejects(
    execute({ target: LEAF_A2, message: 'x' }, makeExec(LEAF_A1)),
    (error) => {
      assert.match(error.message, /E_LINEAGE_UNRESOLVED/)
      assert.match(error.message, /corpus listing failed/)
      return true
    },
  )
  assert.equal(calls.prompt.length, 0)
})

// ===========================================================================
// Input validation (pre-existing behaviour, pinned so it cannot regress)
// ===========================================================================

test('参数校验：target/message 缺失报原错误，不触达任何服务', async () => {
  const { services, calls } = makeHarness(bothTrees())
  const execute = makeTreeSendExecute(services)

  await assert.rejects(execute({ message: 'x' }, makeExec(LEAF_A1)), /"target" is required/)
  await assert.rejects(
    execute({ target: LEAF_A2, message: '   ' }, makeExec(LEAF_A1)),
    /"message" must not be empty/,
  )
  await assert.rejects(execute({ target: '  ', message: 'x' }, makeExec(LEAF_A1)), /"target" is required/)
  assert.equal(calls.prompt.length, 0)
})
