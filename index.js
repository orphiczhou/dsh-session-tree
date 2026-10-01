/**
 * Host half of the session-tree bundle.
 *
 * The tree itself is pure Client rendering (see `client.js`); the only Host-side
 * operation is the `tree_send` tool registered here.
 *
 * Why both halves ship in one package: a bundle is one installable unit. The
 * profile's `dsh.profile.bundles` gains one entry, the patch contributes one
 * row, and the Loader imports `index.js` for the Host half while the browser
 * fetches `exports["./client"]` for the Client half. Splitting them would cost
 * the user a second install spec for no benefit.
 *
 * The row is a function/namespace plugin: it exports `name` / `apply` and no
 * default export. A stray `export default` would make the Loader's
 * `unwrapExports` collapse the module and drop `inject`.
 *
 * `tree_send` — deliver a message to a subagent session that is NOT the caller's
 * direct parent or direct child.
 *
 * Why the tool exists: `ctx.subagents.sendMessage(sender, target, ...)`
 * authorizes by an exact live sender and therefore enforces direct parent/child
 * adjacency, so sibling-to-sibling messaging has no path through it. But
 * `ctx.subagents.prompt(request, signal)` authorizes by the **durable parent
 * address** instead, and is callable from the Host. That is the primitive used
 * here.
 *
 * Consequences, stated plainly:
 *   - The target must be a *continuable* child (`mode: 'continuable'`).
 *   - The target's **direct parent must be live**, otherwise the service throws
 *     `subagent/parent-unavailable`.
 *   - The call returns acceptance only (a message id); it never waits for or
 *     returns a reply.
 *   - Two top-level sessions that share no parent address still have no path.
 *
 * No DSH package is imported: the tool is registered as a plain object in the
 * shape `defineTool()` itself produces (JSON-Schema `parameters` / `output.schema`),
 * so `@deepseek-ai/dsh-tools` is not a dependency and the bundle declares no
 * `peerDependencies` — which is the only compatibility field DSH enforces, so
 * declaring none keeps the plugin installable across DSH versions.
 */
export const name = 'session-tree'

/** Read a failure the way the Harness reports it (RemoteError carries `code`). */
function reasonOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = error.code ? `${error.code}: ` : ''
  return `${code}${error.message || String(error)}`
}

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

function makeExecute(services) {
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

export function apply(ctx) {
  // Optional services: the tool simply stays unregistered in a composition that
  // lacks them instead of failing the whole plugin.
  ctx.inject(['tools', 'subagents', 'sessionQuery'], (scoped) => {
    const services = scoped || ctx
    services.tools.register({ ...TREE_SEND, execute: makeExecute(services) })
  })
}
