/**
 * Client half of the session-tree bundle.
 *
 * Renders the workspace's sessions as a tree in the LEFT SIDEBAR by occupying
 * the `sidebar.workspaces` single-slot seat at priority -100.
 *
 * The tree is grouped by WORKSPACE, which is what the shipped browser does and
 * what this plugin restores. `useWorkspaces` exposes the Host's ordered
 * `WorkspaceView[]` as `state.items`; a session belongs to the workspace whose
 * `sessionIds` lists it (NOT by `cwd` — that only gates attaching a session to
 * a workspace), and sessions no workspace accounts for collect in a synthetic
 * "Ungrouped" group rendered last. See `groupByWorkspace` in
 * `dsh-client-ui-workspace/lib/client.js:420-439`. Where the shipped browser
 * hides every `origin:'subagent'` row and shows a running-child count instead
 * (`:358`), this plugin keeps the descendants nested under their parent.
 *
 * Why -100: `dsh-client-ui-slots` elects the LOWEST priority for a `single`
 * slot (`lib/index.js:168-172`), and registering at an already-taken priority
 * THROWS at load. The shipped `WorkspaceBrowser` sits at priority 0, so -100
 * shadows it; disabling/unloading the plugin restores it untouched.
 *
 * Data comes entirely from slot props — no Host RPC:
 *   useSessions(sel) -> state.byId                : one row per Session
 *                       state.projectionsBySession : live projection snapshots
 * Those rows carry the lineage (`parentId` + `origin:'subagent'`), and the
 * shipped sidebar deliberately hides `origin:'subagent'` rows — so the whole
 * nested tree is already in the store; this plugin only stops hiding it.
 * `subagentCatalog` (projection) is used as a supplement for children whose
 * row is not in `byId`.
 *
 * Both row shapes are normalised: the client store row
 * (`{id, displayTitle, parentId, projectionValues, ...}`) and the Host
 * `SessionSummary` (`{sessionId, parentSessionId, projections:{values}}`).
 *
 * Opening reuses shipped navigation:
 *   root session -> ctx.uiWorkspace.openSession(sessionId)
 *   subagent     -> ctx.uiWorkspace.openSession({parentSessionId, childSessionId, mode})
 * An opened subagent renders the ordinary Conversation, so a continuable child
 * shows its multi-turn history and accepts human follow-up prompts.
 */
window.__ModuleLoader__.load({
  id: '@orphiczhou/dsh-session-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useMemo, useCallback, useRef, useEffect } = React

    const MAX_CHILDREN = 300
    const MAX_DEPTH = 8
    const EMPTY = {}
    const EMPTY_ARR = []

    const CSS = `
.st-root{display:flex;flex-direction:column;min-height:0;height:100%;font-size:13px;color:var(--dsw-alias-label-primary)}
.st-head{display:flex;align-items:center;gap:6px;padding:8px 10px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}
.st-head-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-count{flex:none;opacity:.7}
/* Workspace group row: the level the shipped browser groups sessions under. */
.st-group{font-weight:600;color:var(--dsw-alias-label-secondary);cursor:pointer}
.st-group:hover{color:var(--dsw-alias-label-primary)}
.st-folder{flex:none;width:13px;height:13px;opacity:.8}
.st-group-path{flex:none;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;font-weight:400;font-size:11px}
.st-group-ungrouped{font-style:italic;font-weight:500}
.st-search{margin:0 8px 6px;flex:none}
.st-search input{width:100%;box-sizing:border-box;padding:4px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;outline:none}
.st-scroll{overflow:auto;min-height:0;flex:1;padding:0 6px 12px}
.st-row{display:flex;align-items:center;gap:5px;border-radius:var(--dsw-radius-sm);padding:3px 6px;min-height:24px;cursor:pointer;user-select:none;position:relative}
.st-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.st-twist{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);background:none;border:0;padding:0;cursor:pointer;transition:transform .12s;font-size:9px;line-height:1}
.st-twist.st-open{transform:rotate(90deg)}
.st-twist.st-empty{visibility:hidden}
.st-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.st-dot[data-state='idle']{background:var(--dsw-alias-state-idle-primary)}
.st-dot[data-state='ongoing']{background:var(--dsw-static-blue-500,#3b82f6);animation:st-pulse 1.6s ease-in-out infinite}
.st-dot[data-state='done']{background:var(--dsw-alias-state-success-primary)}
.st-dot[data-state='warning']{background:var(--dsw-alias-state-warn-primary)}
.st-dot[data-state='error']{background:var(--dsw-alias-state-error-primary)}
@keyframes st-pulse{0%,100%{opacity:1}50%{opacity:.4}}
@media (prefers-reduced-motion: reduce){.st-dot[data-state='ongoing']{animation:none}}
.st-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-label-fallback{opacity:.6}
.st-tag{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);opacity:.85;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:0 4px;line-height:15px}
.st-note{padding:3px 6px 3px 31px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.st-err{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.st-rail{display:flex;align-items:center;justify-content:center;height:100%;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:none;border:0;width:100%}
.st-new{flex:none;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;line-height:1;padding:0}
.st-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.st-aside{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;line-height:1;padding:0;opacity:.35}
.st-row:hover .st-aside{opacity:1}
.st-aside:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.st-head{position:relative}
.st-menu-backdrop{position:fixed;inset:0;z-index:40}
.st-menu{position:absolute;top:100%;right:6px;z-index:41;min-width:170px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px}
.st-menu-title{padding:5px 8px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.st-menu-item{display:flex;align-items:center;gap:6px;width:100%;text-align:left;background:none;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px;cursor:pointer}
.st-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.st-menu-check{width:12px;flex:none;color:var(--dsw-alias-brand-primary)}
.st-more{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0;opacity:0}
.st-row:hover .st-more,.st-more[aria-expanded='true']{opacity:1}
.st-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.st-rowmenu{position:absolute;right:4px;top:100%;z-index:41;min-width:150px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px}
.st-rename{flex:1;min-width:0;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:1px 4px;outline:none}
`

    const DICT = {
      en: {
        title: 'Sessions',
        search: 'Filter sessions…',
        empty: 'No sessions in this workspace',
        none: 'No matches',
        noChildren: 'No subagents',
        ungrouped: 'Ungrouped',
        subagent: 'sub',
        more: '{n} more omitted',
        expand: 'Expand sidebar',
        newSession: 'New session',
        openAside: 'Open in right sidebar',
        stOngoing: 'Running',
        stDone: 'Completed — not viewed yet',
        stIdle: 'Completed and viewed',
        stWarning: 'Waiting for your answer',
        viewOptions: 'View options',
        orderBy: 'Order by',
        orderUpdated: 'Last updated',
        orderTitle: 'Title',
        archivedBy: 'Archived sessions',
        archHide: 'Hide archived',
        archShow: 'Show archived',
        archOnly: 'Archived only',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        reloadTitles: 'Reload titles',
        rowMenu: 'Row actions',
        pin: 'Pin',
        unpin: 'Unpin',
        rename: 'Rename',
        fork: 'Fork session',
        archive: 'Archive',
        unarchive: 'Unarchive',
        titlePending: 'Title not loaded yet — showing a delegation label or folder name instead',
      },
      zh: {
        title: '会话树',
        search: '筛选会话…',
        empty: '此工作区暂无会话',
        none: '无匹配项',
        noChildren: '无子会话',
        ungrouped: '未分组',
        subagent: '子',
        more: '另有 {n} 个未显示',
        expand: '展开侧栏',
        newSession: '新建会话',
        openAside: '在右侧栏打开',
        stOngoing: '进行中',
        stDone: '已完成（还未看过）',
        stIdle: '已完成且已看过',
        stWarning: '正在等你回应',
        viewOptions: '视图选项',
        orderBy: '排序方式',
        orderUpdated: '最近更新',
        orderTitle: '按名称',
        archivedBy: '已归档会话',
        archHide: '隐藏已归档',
        archShow: '全部对话（显示已归档）',
        archOnly: '仅显示已归档',
        expandAll: '展开全部',
        collapseAll: '全部折叠',
        reloadTitles: '重新加载标题',
        rowMenu: '会话操作',
        pin: '置顶',
        unpin: '取消置顶',
        rename: '重命名',
        fork: 'Fork 分支会话',
        archive: '归档',
        unarchive: '取消归档',
        titlePending: '标题尚未加载——这里显示的是委派标签或目录名',
      },
    }

    function makeT(bound) {
      return function t(key, vars) {
        let s
        try {
          s = bound ? bound(key) : undefined
        } catch (e) {
          s = undefined
        }
        if (typeof s !== 'string' || s === key) s = DICT.zh[key] !== undefined ? DICT.zh[key] : key
        if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]))
        return s
      }
    }

    const shortId = (id) => String(id == null ? '' : id).replace(/^session-/, '').slice(0, 8)
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)

    /**
     * Display label for one `WorkspaceView`: its stored title, else the basename
     * of its path — the same fallback the shipped browser uses
     * (`dsh-client-ui-workspace/lib/client.js:268-272` `workspaceLabel`).
     */
    function workspaceLabel(w, fallback) {
      const title = w && typeof w.title === 'string' ? w.title.trim() : ''
      if (title) return title
      const p = w && typeof w.path === 'string' ? w.path : ''
      const parts = p.split(/[\\/]+/).filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
      return fallback
    }

    /** Client store row OR Host SessionSummary -> the fields the tree needs. */
    function norm(key, raw) {
      const r = raw || EMPTY
      const vals = r.projectionValues || (r.projections && r.projections.values) || null
      // The DURABLE title is what the opened conversation shows. `displayTitle`
      // is a display-only projection (api-session-controller service.js:45-52:
      // durable title -> **project cwd basename** -> raw id), and for catalog
      // children it degrades to the **delegation label**
      // (service.js:521 `title ?? child.label ?? childId`). Rendering
      // `displayTitle` as if it were the title is exactly why the tree text did
      // not match the opened session.
      const durable =
        (typeof r.title === 'string' && r.title.trim() && r.title) ||
        (vals && typeof vals.title === 'string' && vals.title.trim() && vals.title) ||
        null
      const display =
        (typeof r.displayTitle === 'string' && r.displayTitle.trim() && r.displayTitle) || null
      // A subagent's DISPLAYED identity is its descriptor label, not its session
      // title: the main-window header crumb renders the parent catalog's
      // `entry.label` (SubagentHeaderLineage), and the right-sidebar tab renders
      // `byId[child].projectionValues.subagent.label` (sidebar-chat). Both agree
      // because both are this same creation label.
      const subagentLabel =
        (vals &&
          vals.subagent &&
          typeof vals.subagent.label === 'string' &&
          vals.subagent.label.trim() &&
          vals.subagent.label) ||
        null
      return {
        id: r.id || r.sessionId || key,
        parentId: r.parentId || r.parentSessionId || null,
        origin: r.origin || null,
        title: durable,
        fallbackTitle: display,
        subagentLabel,
        catalogLabel: null,
        running: r.running === true,
        updatedAt: num(r.updatedAt),
        catalog: Array.isArray(vals && vals.subagentCatalog) ? vals.subagentCatalog : null,
        raw: r,
      }
    }

    /**
     * Map one session to the Harness status vocabulary, in the shipped priority
     * order (dsh-client-ui-workspace/lib/client.js:1386-1434 `sessionStatuses`):
     * pending interaction -> running -> completion-unread -> idle.
     *
     *  warning = waiting on a human (approval / plan review / question)  → orange
     *  ongoing = running                                                 → blue
     *  done    = finished but not viewed yet                             → green
     *  idle    = finished and already viewed                             → gray
     *
     * `statuses` is the `useSessionStatus` snapshot: a Map keyed by session id
     * whose values carry `running`, `completionUnread` and `pendingInteraction`.
     */
    function sessionState(statuses, id, fallbackRunning) {
      const status = statuses && typeof statuses.get === 'function' ? statuses.get(id) : undefined
      if (!status) return fallbackRunning === true ? 'ongoing' : 'idle'
      const kind = status.pendingInteraction && status.pendingInteraction.kind
      if (kind === 'approval' || kind === 'plan-review' || kind === 'question') return 'warning'
      if (status.running === true) return 'ongoing'
      if (status.completionUnread === true) return 'done'
      return 'idle'
    }

    const STATE_LABEL_KEY = {
      ongoing: 'stOngoing',
      done: 'stDone',
      idle: 'stIdle',
      warning: 'stWarning',
    }

    const fallbackSessions = (sel) => sel({ byId: EMPTY, projectionsBySession: EMPTY })
    const fallbackStatus = (sel) => sel(EMPTY)
    const fallbackWorkspaces = (sel) => sel(EMPTY)

    /**
     * Canonical Sidebar resource address for one subagent conversation.
     * Copied from the shipped owner of that resource
     * (dsh-client-ui-subagent/lib/client.js:698-704) — the query key names and
     * the allowed `mode` values are validated when the resource is resolved.
     */
    function subagentChatAddress(parentSessionId, childSessionId, mode) {
      const m = mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown'
      // Built without URLSearchParams so the module has no dependency on a
      // global beyond `window`; session ids are UUIDs, so the encodings agree.
      return (
        'dsh-resource://subagentchat/session/' +
        encodeURIComponent(String(childSessionId)) +
        '?parent=' +
        encodeURIComponent(String(parentSessionId)) +
        '&mode=' +
        m
      )
    }

    /** Build the flat row list the renderer walks. Pure; tolerant of malformed data. */
    function buildRows(byId, projectionsBySession, expandedIds, query, t, statuses, opts) {
      const out = []
      const keys = Object.keys(byId || EMPTY)
      if (keys.length === 0) return out

      const node = new Map()
      for (const k of keys) node.set(k, norm(k, byId[k]))

      // Children by durable lineage, plus catalog children with no row of their own.
      const kids = new Map()
      const addKid = (pid, child) => {
        const arr = kids.get(pid)
        if (arr) {
          if (!arr.some((x) => x.id === child.id)) arr.push(child)
        } else {
          kids.set(pid, [child])
        }
      }
      const roots = []
      for (const n of node.values()) {
        if (n.parentId && n.parentId !== n.id && node.has(n.parentId)) addKid(n.parentId, n)
        else roots.push(n)
      }
      const catalogOnly = new Map()
      for (const n of node.values()) {
        const cat = n.catalog || (projectionsBySession[n.id] && projectionsBySession[n.id].values && projectionsBySession[n.id].values.subagentCatalog)
        if (!Array.isArray(cat)) continue
        for (const e of cat) {
          if (!e || !e.id) continue
          if (node.has(e.id)) {
            // The child already reached us through `parentId`; take its mode from
            // the catalog, because `mode` decides whether the opened conversation
            // is continuable (human can keep prompting) or read-only one-shot.
            const arr = kids.get(n.id)
            const c = arr && arr.find((x) => x.id === e.id)
            if (c && !c.mode) c.mode = e.mode || 'unknown'
            // The catalog label is the identity the app displays for a subagent.
            if (c && !c.catalogLabel && e.label && String(e.label).trim()) {
              c.catalogLabel = String(e.label)
            }
            continue
          }
          if (childByIdHas(kids, n.id, e.id)) continue
          addKid(n.id, {
            id: e.id,
            parentId: n.id,
            origin: 'subagent',
            title: null,
            fallbackTitle: null,
            subagentLabel: null,
            catalogLabel: (e.label && String(e.label).trim()) || null,
            running: e.activity === 'running',
            updatedAt: num(e.createdAt),
            catalog: null,
            mode: e.mode || 'unknown',
            raw: null,
          })
          catalogOnly.set(e.id, true)
        }
      }
      // View options mirror the shipped browser's dropdown: pinned rows lead,      // then the chosen order; the archived filter comes from the workspace
      // snapshot's registry-global archive set.
      const pinned = (opts && opts.pinned) || null
      const archived = (opts && opts.archived) || null
      const archivedMode = (opts && opts.archivedMode) || 'hide'
      const byOrder = (a, b) => {
        if (pinned) {
          const pa = pinned.has(a.id) ? 0 : 1
          const pb = pinned.has(b.id) ? 0 : 1
          if (pa !== pb) return pa - pb
        }
        if (opts && opts.order === 'title') {
          return String(a.title || a.id).localeCompare(String(b.title || b.id))
        }
        return b.updatedAt - a.updatedAt
      }
      const keep = (id) => {
        if (!archived) return true
        const isArchived = archived.has(id)
        if (archivedMode === 'only') return isArchived
        if (archivedMode === 'hide') return !isArchived
        return true
      }
      roots.sort(byOrder)
      for (const arr of kids.values()) arr.sort(byOrder)

      // What the app displays decides the row text:
      //   subagent row -> descriptor label (main window + right sidebar agree on it)
      //   normal row   -> the durable title (Host's current value beats the store's)
      // The session title stays available as secondary text for subagent rows.
      const titles =
        opts && opts.titles && typeof opts.titles.get === 'function' ? opts.titles : null
      const hostTitle = (n) => (titles && titles.get(n.id)) || null
      const labelFor = (n) =>
        n.origin === 'subagent'
          ? n.subagentLabel || n.catalogLabel || hostTitle(n) || n.title || shortId(n.id)
          : hostTitle(n) || n.title || n.fallbackTitle || shortId(n.id)
      const secondaryFor = (n) => {
        if (n.origin !== 'subagent') return null
        const t = hostTitle(n) || n.title
        return t && t !== labelFor(n) ? t : null
      }
      // "Fallback" means: we are NOT showing the string the app itself shows for
      // this session — a subagent's descriptor label, or a normal session's title.
      const isFallbackFor = (n) =>
        n.origin === 'subagent' ? !(n.subagentLabel || n.catalogLabel) : !(hostTitle(n) || n.title)

      const q = String(query || '').trim().toLowerCase()
      const matches = (label, id) => q === '' || String(label).toLowerCase().includes(q) || String(id).toLowerCase().includes(q)

      /**
       * Workspace level, restored from the shipped browser.
       *
       * `useWorkspaces` exposes the Host's `WorkspaceView` list as `items`. The
       * shipped browser groups sessions by **`workspace.sessionIds` membership**
       * — not by `cwd`, which only gates attaching a session to a workspace —
       * and appends a synthetic Ungrouped bucket last for sessions no workspace
       * accounts for (`dsh-client-ui-workspace/lib/client.js:420-439`
       * `groupByWorkspace`; the bucket's label is `t("group.ungrouped")` at
       * `:1272`).
       *
       * This plugin keeps its own nested subagent descendants underneath, which
       * the shipped browser deliberately hides (`:358`). With no workspace list
       * — Host baseline not ready, or a composition that does not provide the
       * hook — the tree degrades to the previous flat layout rather than
       * inventing a group.
       */
      const wsList = (opts && Array.isArray(opts.workspaces) ? opts.workspaces : EMPTY_ARR).filter(
        (w) => w && w.workspaceId,
      )
      if (wsList.length > 0) {
        const collapsed = (opts && opts.collapsedGroups) || null
        // A session that has a parent IN THIS MAP is a descendant: it renders
        // under that parent, never as a group root. The shipped browser never
        // faces this because it hides every `origin:'subagent'` row (`:358`);
        // this plugin shows them, and treating an unlisted child as a root is
        // exactly what produced a 1000-row flat list before.
        const isChild = (n) => !!(n.parentId && n.parentId !== n.id && node.has(n.parentId))
        const groups = []
        const accounted = new Set()
        for (const w of wsList) {
          const ids = Array.isArray(w.sessionIds) ? w.sessionIds : EMPTY_ARR
          const members = []
          for (const id of ids) {
            const n = node.get(id)
            if (!n) continue
            // Accounted even when it is hidden by the archived filter or is a
            // descendant, so it never reappears in Ungrouped.
            accounted.add(id)
            if (isChild(n)) continue
            if (keep(id)) members.push(n)
          }
          // "Archived only" drops a workspace that would render empty; other
          // modes keep the bare header, exactly as the shipped browser does.
          if (archivedMode === 'only' && members.length === 0) continue
          groups.push({
            key: w.workspaceId,
            label: workspaceLabel(w, t('ungrouped')),
            path: typeof w.path === 'string' ? w.path : null,
            members,
            ungrouped: false,
          })
        }
        const ungroupedMembers = []
        for (const n of node.values()) {
          if (!isChild(n) && !accounted.has(n.id) && keep(n.id)) ungroupedMembers.push(n)
        }
        // Reachability over the FULL graph, ignoring expansion and the archived
        // filter — the same guard the flat layout uses. Marking only the members
        // that survived the filter would promote every filtered-out session into
        // a bogus Ungrouped root; marking from every top-level node leaves only
        // real parent cycles.
        const reachable = new Set()
        const markReach = (id) => {
          if (reachable.has(id)) return
          reachable.add(id)
          for (const c of kids.get(id) || EMPTY_ARR) markReach(c.id)
        }
        for (const n of node.values()) if (!isChild(n)) markReach(n.id)
        for (const n of node.values()) {
          if (reachable.has(n.id)) continue
          ungroupedMembers.push(n)
          markReach(n.id)
        }
        if (ungroupedMembers.length > 0) {
          groups.push({
            key: '',
            label: t('ungrouped'),
            path: null,
            members: ungroupedMembers,
            ungrouped: true,
          })
        }

        const out2 = []
        const seenG = new Set()
        const walkG = (n, depth, gkey, sink) => {
          if (!n || seenG.has(n.id) || depth > MAX_DEPTH + 1) return
          seenG.add(n.id)
          if (!keep(n.id)) return
          // Every descendant of a group root belongs to that root's group, even
          // when some other workspace also lists it: a node renders once.
          const children = kids.get(n.id) || EMPTY_ARR
          const expanded = expandedIds.has(n.id)
          sink.push({
            key: 'ws:' + gkey + '/' + n.id,
            kind: n.origin === 'subagent' ? 'subagent' : 'session',
            depth,
            id: n.id,
            parentId: n.parentId,
            mode: n.mode,
            label: labelFor(n),
            labelIsFallback: isFallbackFor(n),
            secondary: secondaryFor(n),
            running: n.running,
            state: sessionState(statuses, n.id, n.running),
            tag: n.origin === 'subagent' ? t('subagent') : null,
            expandable: children.length > 0,
            expanded,
            childCount: children.length,
          })
          if (!expanded) return
          if (children.length === 0) {
            if (catalogOnly.has(n.id) || n.catalog === null) return
            sink.push({
              key: 'ws:' + gkey + '/' + n.id + ':none',
              kind: 'note',
              depth: depth + 1,
              id: n.id + ':none',
              label: t('noChildren'),
            })
            return
          }
          let shown = 0
          for (const c of children) {
            if (shown >= MAX_CHILDREN) {
              sink.push({
                key: 'ws:' + gkey + '/' + n.id + ':more',
                kind: 'note',
                depth: depth + 1,
                id: n.id + ':more',
                label: t('more', { n: children.length - shown }),
              })
              break
            }
            shown++
            walkG(c, depth + 1, gkey, sink)
          }
        }

        for (const g of groups) {
          const isCollapsed = !!(collapsed && collapsed.has(g.key))
          out2.push({
            key: 'ws:' + g.key,
            kind: 'workspace',
            depth: 0,
            id: g.key,
            label: g.label,
            path: g.path,
            ungrouped: g.ungrouped,
            expanded: !isCollapsed,
            expandable: true,
            childCount: g.members.length,
          })
          if (isCollapsed) continue
          if (g.members.length === 0) {
            out2.push({
              key: 'ws:' + g.key + ':empty',
              kind: 'note',
              depth: 1,
              id: 'ws:' + g.key + ':empty',
              label: t('empty'),
            })
            continue
          }
          // Search stays shallow and grouped: matching member rows only.
          if (q !== '') {
            for (const m of g.members) {
              const label = labelFor(m)
              if (!matches(label, m.id)) continue
              out2.push({
                key: 'ws:' + g.key + '/' + m.id,
                kind: m.origin === 'subagent' ? 'subagent' : 'session',
                depth: 1,
                id: m.id,
                parentId: m.parentId,
                mode: m.mode,
                label,
                labelIsFallback: isFallbackFor(m),
                secondary: secondaryFor(m),
                running: m.running,
                state: sessionState(statuses, m.id, m.running),
                tag: m.origin === 'subagent' ? t('subagent') : null,
                expandable: false,
                expanded: false,
              })
            }
            continue
          }
          // Members are already top-level by construction (see `isChild`), so
          // each one is a root row of its group.
          g.members.sort(byOrder)
          for (const r of g.members) walkG(r, 1, g.key, out2)
        }
        return out2
      }

      // Filter mode: flat and predictable — no expansion, no deep loading.
      if (q !== '') {
        for (const n of roots) {
          if (!keep(n.id)) continue
          const label = labelFor(n)
          if (matches(label, n.id)) out.push({ key: n.id, kind: 'session', depth: 0, id: n.id, label, labelIsFallback: isFallbackFor(n), secondary: secondaryFor(n), expandable: false, expanded: false, state: sessionState(statuses, n.id, n.running) })
        }
        for (const n of node.values()) {
          for (const c of kids.get(n.id) || EMPTY_ARR) {
            if (!keep(c.id)) continue
            const label = labelFor(c)
            if (matches(label, c.id)) {
              out.push({ key: n.id + '/' + c.id, kind: 'subagent', depth: 1, id: c.id, parentId: n.id, mode: c.mode, label, labelIsFallback: isFallbackFor(c), secondary: secondaryFor(c), expandable: false, expanded: false, running: c.running, state: sessionState(statuses, c.id, c.running) })
            }
          }
        }
        return out
      }

      const seen = new Set()
      const walk = (n, depth) => {
        if (!n || seen.has(n.id) || depth > MAX_DEPTH) return
        seen.add(n.id)
        if (!keep(n.id)) return
        const children = kids.get(n.id) || EMPTY_ARR
        const expanded = expandedIds.has(n.id)
        out.push({
          key: n.id,
          kind: n.origin === 'subagent' ? 'subagent' : 'session',
          depth,
          id: n.id,
          parentId: n.parentId,
          mode: n.mode,
          label: labelFor(n),
          labelIsFallback: isFallbackFor(n),
          secondary: secondaryFor(n),
          running: n.running,
          state: sessionState(statuses, n.id, n.running),
          tag: n.origin === 'subagent' ? t('subagent') : null,
          expandable: children.length > 0,
          expanded,
          childCount: children.length,
        })
        if (!expanded) return
        if (children.length === 0) {
          if (catalogOnly.has(n.id) || n.catalog === null) return
          out.push({ key: n.id + ':none', kind: 'note', depth: depth + 1, id: n.id + ':none', label: t('noChildren') })
          return
        }
        let shown = 0
        for (const c of children) {
          if (shown >= MAX_CHILDREN) {
            out.push({ key: n.id + ':more', kind: 'note', depth: depth + 1, id: n.id + ':more', label: t('more', { n: children.length - shown }) })
            break
          }
          shown++
          walk(c, depth + 1)
        }
      }

      // Reachability over the FULL graph, ignoring expansion. It exists only to
      // find nodes no root can reach (a parent cycle), which are then shown as
      // extra roots. Walking every unseen node instead — the obvious shortcut —
      // wrongly promotes every unexpanded child to a depth-0 row, which turns
      // the default view into a thousands-row flat list.
      const reachable = new Set()
      const mark = (id) => {
        if (reachable.has(id)) return
        reachable.add(id)
        for (const c of kids.get(id) || EMPTY_ARR) mark(c.id)
      }
      for (const r of roots) mark(r.id)
      const extraRoots = []
      for (const n of node.values()) {
        if (!reachable.has(n.id)) {
          extraRoots.push(n)
          mark(n.id)
        }
      }

      for (const r of roots) walk(r, 0)
      for (const r of extraRoots) walk(r, 0)
      return out
    }

    // Local helper kept tiny: does this parent already list that child id?
    function childByIdHas(kids, pid, cid) {
      const arr = kids.get(pid)
      return !!arr && arr.some((x) => x.id === cid)
    }

    function TreeView(props) {
      const ctx = props.ctx
      const t = props.t
      const useS = typeof props.useSessions === 'function' ? props.useSessions : fallbackSessions
      const useSt = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : fallbackStatus
      const useW = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : fallbackWorkspaces

      const byId = useS((s) => (s && s.byId) || EMPTY) || EMPTY
      const projectionsBySession = useS((s) => (s && s.projectionsBySession) || EMPTY) || EMPTY
      const statuses = useSt((v) => v)
      // Registry-global archive/pin sets, exactly as the shipped browser reads
      // them: useWorkspaces((state) => state.archivedSessionIds) — see
      // dsh-client-ui-workspace/lib/client.js:2808-2809.
      const archivedIds = useW((s) => (s && s.archivedSessionIds) || EMPTY_ARR) || EMPTY_ARR
      const pinnedIds = useW((s) => (s && s.pinnedSessionIds) || EMPTY_ARR) || EMPTY_ARR
      // The Host's Workspace list — the ordered `WorkspaceView` array the shipped
      // browser groups sessions by. Absent it (baseline not ready), the tree
      // stays flat rather than inventing a group.
      const workspaceItems = useW((s) => (s && s.items) || EMPTY_ARR) || EMPTY_ARR

      const [order, setOrder] = useState('updated')
      const [archivedMode, setArchivedMode] = useState('hide')
      // Workspace groups start EXPANDED. Unlike the shipped browser — which
      // collapses every group and only auto-expands the current one — the
      // workspace level here is an added distinction, not a gate the operator
      // must open before seeing any session.
      const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
      const [menuOpen, setMenuOpen] = useState(false)
      const [rowMenu, setRowMenu] = useState(null)
      const [renameId, setRenameId] = useState(null)
      const [renameText, setRenameText] = useState('')

      /**
       * Authoritative current titles, straight from the Host.
       *
       * A session's title is REPLACED over its life (a `session/title` event with
       * source `fallback` = truncated first message, later replaced by `provider`
       * or `user`). The client store's `byId[id].title` can be a stale snapshot:
       * `refreshProjections` loads "a complete projection baseline ONCE PER
       * CONNECTION" and is a no-op afterwards
       * (api-session-controller manager.js:254-264), so catalog children can keep
       * the early `fallback` title forever.
       *
       * `remote.session.list({})` is a FRESH host read of every session
       * (`lib/index.js:1883-1906` "Read every visible attached and persisted
       * Session") and carries each session's current `projections.values.title`.
       * That is the same value the conversation header shows.
       */
      const [titleMap, setTitleMap] = useState(() => null)

      const loadTitles = useCallback(() => {
        try {
          const remote =
            (ctx && typeof ctx.get === 'function' && ctx.get('remote')) || (ctx && ctx.remote)
          const svc = remote && remote.session
          if (!svc || typeof svc.list !== 'function') {
            console.error('[session-tree] remote.session.list unavailable')
            return
          }
          Promise.resolve(svc.list({}))
            .then((res) => {
              const items = res && res.ok && res.value && res.value.items
              if (!Array.isArray(items)) return
              const m = new Map()
              for (const it of items) {
                if (!it || !it.sessionId) continue
                const t = it.projections && it.projections.values && it.projections.values.title
                if (typeof t === 'string' && t.trim()) m.set(it.sessionId, t)
              }
              setTitleMap(m)
            })
            .catch((e) => console.error('[session-tree] title load failed', e))
        } catch (e) {
          try {
            console.error('[session-tree] title load failed', e)
          } catch (_) {}
        }
      }, [ctx])

      useEffect(() => {
        loadTitles()
      }, [loadTitles])

      // Default-collapsed on purpose: the first paint is the ordinary session
      // list, each expandable node showing its child count, and the 1187-row
      // subtree is built only when the operator asks for it.
      const [expandedIds, setExpandedIds] = useState(() => new Set())
      const [query, setQuery] = useState('')
      const requested = useRef(new Set())

      const ensureLoaded = useCallback(
        (id) => {
          if (!id || requested.current.has(id)) return
          requested.current.add(id)
          try {
            const svc = ctx && ctx.sessions
            if (svc && typeof svc.refreshProjections === 'function') {
              const p = svc.refreshProjections(id)
              if (p && typeof p.catch === 'function') p.catch(() => {})
            }
          } catch (e) {
            /* best effort: lineage usually needs no extra load at all */
          }
        },
        [ctx],
      )

      /**
       * A child's durable title lives in its OWN projection store, which exists
       * only once the session has been observed (manager.js:529-531 returns
       * undefined otherwise). Without it the store row degrades to the
       * delegation label. Requesting the projection is what makes the tree text
       * equal the title the opened conversation shows. Bounded on purpose:
       * at most MAX_CHILDREN children per expansion (matching what can actually
       * be rendered), six per tick, deduped for the component's lifetime — so a
       * full workspace costs about one request per session, once.
       */
      const ensureChildTitles = useCallback(
        (parentId) => {
          const svc = ctx && ctx.sessions
          if (!parentId || !svc || typeof svc.refreshProjections !== 'function') return
          const ids = []
          for (const k of Object.keys(byId)) {
            const row = byId[k] || EMPTY
            if (row.parentId === parentId && !requested.current.has(k)) ids.push(k)
          }
          const pending = ids.slice(0, MAX_CHILDREN)
          if (pending.length === 0) return
          const step = () => {
            const batch = pending.splice(0, 6)
            if (batch.length === 0) return
            for (const id of batch) {
              requested.current.add(id)
              try {
                const p = svc.refreshProjections(id)
                if (p && typeof p.catch === 'function') p.catch(() => {})
              } catch (e) {}
            }
            try {
              setTimeout(step, 60)
            } catch (e) {}
          }
          step()
        },
        [ctx, byId],
      )

      const toggle = useCallback(
        (id) => {
          const willExpand = !expandedIds.has(id)
          setExpandedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
          ensureLoaded(id)
          if (willExpand) ensureChildTitles(id)
        },
        [expandedIds, ensureLoaded, ensureChildTitles],
      )

      /** Fold/unfold one workspace group. Groups are keyed by workspaceId. */
      const toggleGroup = useCallback((key) => {
        setCollapsedGroups((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      const openNode = useCallback(
        (row) => {
          try {
            const svc = ctx && ctx.uiWorkspace
            if (!svc || typeof svc.openSession !== 'function') {
              // Never fail silently again: a missing service here is exactly what
              // made every click a no-op before `inject` was declared.
              console.error('[session-tree] uiWorkspace.openSession unavailable', {
                hasCtx: !!ctx,
                hasUiWorkspace: !!(ctx && ctx.uiWorkspace),
              })
              return
            }
            if (row.kind === 'subagent' && row.parentId) {
              svc.openSession({
                parentSessionId: row.parentId,
                childSessionId: row.id,
                mode: row.mode === 'continuable' || row.mode === 'one-shot' ? row.mode : 'unknown',
              })
            } else {
              svc.openSession(row.id)
            }
          } catch (e) {
            try {
              console.error('[session-tree] open failed', e)
            } catch (_) {}
          }
        },
        [ctx],
      )

      /** Open one subagent conversation in the right Sidebar as a separate pane. */
      const openAside = useCallback(
        (row) => {
          try {
            const svc = ctx && ctx.sidebarRight
            if (!row.parentId || !svc || typeof svc.openResource !== 'function') {
              console.error('[session-tree] sidebarRight.openResource unavailable', {
                hasParentId: !!row.parentId,
                hasSidebarRight: !!(ctx && ctx.sidebarRight),
              })
              return
            }
            svc.openResource(subagentChatAddress(row.parentId, row.id, row.mode), {
              kind: 'subagentchat',
              preferNewPane: true,
            })
          } catch (e) {
            try {
              console.error('[session-tree] openResource failed', e)
            } catch (_) {}
          }
        },
        [ctx],
      )

      /**
       * Row actions, matching the shipped implementations:
       *   pin/unpin   -> ctx.remote.workspace.pinSession({sessionId})   (WorkspacePinSessionRequest)
       *   archive     -> ctx.uiWorkspace.archiveSession(id)
       *   unarchive   -> ctx.uiWorkspace.unarchiveSession(id)
       *   fork        -> ctx.uiWorkspace.forkSession(id, onCreated)
       *   rename      -> ctx.sessions.using(id, {source}, ref => ref.binding.session.rename(title))
       * Pin lives only on the Remote namespace (the uiWorkspace client service has no pin).
       */
      /**
       * `remote` is read optionally (`ctx.get`) rather than injected: a wrong
       * entry in the hard inject list would stop the whole plugin from loading
       * and silently revert the sidebar, while a missing namespace here only
       * disables pin/unpin. Two shipped packages do inject "remote"
       * (dsh-client-ui-workspace:4113), so this is belt-and-braces.
       */
      const remoteWorkspace = () => {
        try {
          if (ctx && typeof ctx.get === 'function') {
            const r = ctx.get('remote')
            if (r && r.workspace) return r.workspace
          }
        } catch (e) {}
        return (ctx && ctx.remote && ctx.remote.workspace) || null
      }

      const rowAction = useCallback(
        (row, action) => {
          setRowMenu(null)
          try {
            const ui = ctx && ctx.uiWorkspace
            if (action === 'pin' || action === 'unpin') {
              const ws = remoteWorkspace()
              const fn = ws && ws[action === 'pin' ? 'pinSession' : 'unpinSession']
              if (typeof fn !== 'function') {
                console.error('[session-tree] remote.workspace.' + action + 'Session unavailable')
                return
              }
              Promise.resolve(fn.call(ws, { sessionId: row.id })).catch((e) =>
                console.error('[session-tree] ' + action + ' failed', e),
              )
              return
            }
            if (action === 'archive' || action === 'unarchive') {
              const fn = ui && ui[action === 'archive' ? 'archiveSession' : 'unarchiveSession']
              if (typeof fn !== 'function') {
                console.error('[session-tree] uiWorkspace.' + action + 'Session unavailable')
                return
              }
              Promise.resolve(fn.call(ui, row.id)).catch((e) =>
                console.error('[session-tree] ' + action + ' failed', e),
              )
              return
            }
            if (action === 'fork') {
              if (!ui || typeof ui.forkSession !== 'function') {
                console.error('[session-tree] uiWorkspace.forkSession unavailable')
                return
              }
              Promise.resolve(ui.forkSession(row.id)).catch((e) =>
                console.error('[session-tree] fork failed', e),
              )
              return
            }
            if (action === 'rename') {
              setRenameId(row.id)
              setRenameText(row.label)
            }
          } catch (e) {
            try {
              console.error('[session-tree] row action failed', e)
            } catch (_) {}
          }
        },
        [ctx],
      )

      /** Commit an inline rename through the session's own binding. */
      const commitRename = useCallback(
        (row) => {
          const next = String(renameText || '').trim()
          setRenameId(null)
          if (!next || next === row.label) return
          try {
            const svc = ctx && ctx.sessions
            if (!svc || typeof svc.using !== 'function') {
              console.error('[session-tree] sessions.using unavailable; cannot rename')
              return
            }
            Promise.resolve(
              svc.using(row.id, { source: 'workspaceOperation' }, (reference) =>
                reference.binding.session.rename(next),
              ),
            ).catch((e) => console.error('[session-tree] rename failed', e))
          } catch (e) {
            try {
              console.error('[session-tree] rename failed', e)
            } catch (_) {}
          }
        },
        [ctx, renameText],
      )

      const archives = useMemo(() => new Set(archivedIds), [archivedIds])
      const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds])
      const rows = useMemo(
        () => buildRows(byId, projectionsBySession, expandedIds, query, t, statuses, {
          order,
          archived: archives,
          archivedMode,
          pinned,
          titles: titleMap,
          workspaces: workspaceItems,
          collapsedGroups,
        }),
        [byId, projectionsBySession, expandedIds, query, t, statuses, order, archives, archivedMode, pinned, titleMap, workspaceItems, collapsedGroups],
      )
      /** Every parent id in the current map — the bound for "expand all". */
      const idsWithChildren = useMemo(() => {
        const s = new Set()
        for (const k of Object.keys(byId)) {
          const p = (byId[k] || EMPTY).parentId
          if (p) s.add(p)
        }
        return s
      }, [byId])

      if (props.wide === false) {
        return h(
          'button',
          {
            className: 'st-rail',
            title: t('expand'),
            'aria-label': t('expand'),
            onClick: () => {
              try {
                if (typeof props.expandSidebar === 'function') props.expandSidebar()
              } catch (e) {}
            },
          },
          h('span', { style: { fontSize: 16, lineHeight: 1 } }, '\u2261'),
        )
      }

      /** One view-options row; picking it applies the value and closes the menu. */
      const menuItem = (label, active, onPick) =>
        h(
          'button',
          {
            className: 'st-menu-item',
            key: label,
            role: 'menuitemradio',
            'aria-checked': active ? 'true' : 'false',
            onClick: () => {
              onPick()
              setMenuOpen(false)
            },
          },
          h('span', { className: 'st-menu-check' }, active ? '\u2713' : ''),
          h('span', null, label),
        )

      /** One action row inside a session's "…" menu. */
      const rowMenuItem = (label, onPick) =>
        h(
          'button',
          {
            className: 'st-menu-item',
            key: label,
            role: 'menuitem',
            onClick: (ev) => {
              try {
                ev.stopPropagation()
              } catch (e) {}
              onPick()
            },
          },
          h('span', { className: 'st-menu-check' }, ''),
          h('span', null, label),
        )

      const rowMenuPanel = (row) =>
        h(
          'div',
          {
            className: 'st-rowmenu',
            role: 'menu',
            onClick: (ev) => {
              try {
                ev.stopPropagation()
              } catch (e) {}
            },
          },
          rowMenuItem(pinned.has(row.id) ? t('unpin') : t('pin'), () =>
            rowAction(row, pinned.has(row.id) ? 'unpin' : 'pin'),
          ),
          rowMenuItem(t('rename'), () => rowAction(row, 'rename')),
          row.kind !== 'subagent' ? rowMenuItem(t('fork'), () => rowAction(row, 'fork')) : null,
          rowMenuItem(archives.has(row.id) ? t('unarchive') : t('archive'), () =>
            rowAction(row, archives.has(row.id) ? 'unarchive' : 'archive'),
          ),
        )

      const body =
        rows.length === 0
          ? h('div', { className: 'st-note', style: { paddingLeft: 10 } }, query ? t('none') : t('empty'))
          : rows.map((row) => {
              if (row.kind === 'note') return h('div', { className: 'st-note', key: row.key }, row.label)
              if (row.kind === 'workspace') {
                return h(
                  'div',
                  {
                    className: 'st-row st-group' + (row.ungrouped ? ' st-group-ungrouped' : ''),
                    key: row.key,
                    role: 'treeitem',
                    'aria-expanded': row.expanded ? 'true' : 'false',
                    style: { paddingLeft: 6 + row.depth * 13 },
                    title: row.path || row.label,
                    onClick: () => toggleGroup(row.id),
                  },
                  h('span', { className: 'st-twist' + (row.expanded ? ' st-open' : '') }, '\u25B6'),
                  // Inline folder glyph: the shipped header uses a primitives icon,
                  // and client plugins are forbidden to import those. Drawing the
                  // same shape keeps the theme in charge via `currentColor`.
                  h(
                    'svg',
                    { className: 'st-folder', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
                    h('path', { d: 'M1.5 3.2h4.2l1.5 1.9h7.3v7.7h-13z', fill: 'currentColor' }),
                  ),
                  h('span', { className: 'st-label' }, row.label),
                  row.path && !row.ungrouped
                    ? h('span', { className: 'st-group-path' }, row.path)
                    : null,
                  !row.expanded ? h('span', { className: 'st-count' }, String(row.childCount)) : null,
                )
              }
              return h(
                'div',
                {
                  className: 'st-row',
                  key: row.key,
                  role: 'treeitem',
                  style: { paddingLeft: 6 + row.depth * 13 },
                  title: [row.label, row.secondary, row.labelIsFallback ? t('titlePending') : null]
                    .filter(Boolean)
                    .join(' — '),
                  onClick: () => openNode(row),
                },
                h(
                  'span',
                  {
                    className: 'st-twist' + (row.expanded ? ' st-open' : '') + (row.expandable ? '' : ' st-empty'),
                    onClick: (ev) => {
                      try {
                        ev.stopPropagation()
                      } catch (e) {}
                      if (row.expandable) toggle(row.id)
                    },
                  },
                  '\u25B6',
                ),
                h('span', {
                  className: 'st-dot',
                  'data-state': row.state || 'idle',
                  title: t(STATE_LABEL_KEY[row.state] || 'stIdle'),
                }),
                renameId === row.id
                  ? h('input', {
                      className: 'st-rename',
                      value: renameText,
                      autoFocus: true,
                      'aria-label': t('rename'),
                      onClick: (ev) => {
                        try {
                          ev.stopPropagation()
                        } catch (e) {}
                      },
                      onChange: (ev) => setRenameText(ev.target.value),
                      onKeyDown: (ev) => {
                        if (ev.key === 'Enter') commitRename(row)
                        else if (ev.key === 'Escape') setRenameId(null)
                      },
                      onBlur: () => commitRename(row),
                    })
                  : h(
                      'span',
                      { className: 'st-label' + (row.labelIsFallback ? ' st-label-fallback' : '') },
                      row.label,
                    ),
                row.tag ? h('span', { className: 'st-tag' }, row.tag) : null,
                row.expandable && !row.expanded ? h('span', { className: 'st-count' }, String(row.childCount)) : null,
                row.kind === 'subagent'
                  ? h(
                      'button',
                      {
                        className: 'st-aside',
                        title: t('openAside'),
                        'aria-label': t('openAside'),
                        onClick: (ev) => {
                          try {
                            ev.stopPropagation()
                          } catch (e) {}
                          openAside(row)
                        },
                      },
                      '\u2197',
                    )
                  : null,
                h(
                  'button',
                  {
                    className: 'st-more',
                    title: t('rowMenu'),
                    'aria-label': t('rowMenu'),
                    'aria-expanded': rowMenu === row.id ? 'true' : 'false',
                    onClick: (ev) => {
                      try {
                        ev.stopPropagation()
                      } catch (e) {}
                      setRowMenu(rowMenu === row.id ? null : row.id)
                    },
                  },
                  '\u22EF',
                ),
                rowMenu === row.id ? rowMenuPanel(row) : null,
              )
            })

      return h(
        'div',
        { className: 'st-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'st-head' },
          h('span', { className: 'st-head-label' }, t('title')),
          h(
            'button',
            {
              className: 'st-new',
              title: t('newSession'),
              'aria-label': t('newSession'),
              onClick: () => {
                try {
                  const svc = ctx && ctx.uiWorkspace
                  if (svc && typeof svc.startSession === 'function') svc.startSession()
                  else console.error('[session-tree] uiWorkspace.startSession unavailable')
                } catch (e) {
                  try {
                    console.error('[session-tree] startSession failed', e)
                  } catch (_) {}
                }
              },
            },
            '+',
          ),
          h(
            'button',
            {
              className: 'st-new',
              title: t('viewOptions'),
              'aria-label': t('viewOptions'),
              'aria-expanded': menuOpen ? 'true' : 'false',
              onClick: () => setMenuOpen((o) => !o),
            },
            '\u22EF',
          ),
          menuOpen
            ? h(
                'div',
                { className: 'st-menu', role: 'menu' },
                h('div', { className: 'st-menu-title' }, t('orderBy')),
                menuItem(t('orderUpdated'), order === 'updated', () => setOrder('updated')),
                menuItem(t('orderTitle'), order === 'title', () => setOrder('title')),
                h('div', { className: 'st-menu-title' }, t('archivedBy')),
                menuItem(t('archHide'), archivedMode === 'hide', () => setArchivedMode('hide')),
                menuItem(t('archShow'), archivedMode === 'show', () => setArchivedMode('show')),
                menuItem(t('archOnly'), archivedMode === 'only', () => setArchivedMode('only')),
                menuItem(t('expandAll'), false, () => {
                  setExpandedIds(new Set(idsWithChildren))
                  setCollapsedGroups(new Set())
                }),
                menuItem(t('collapseAll'), false, () => {
                  setExpandedIds(new Set())
                  setCollapsedGroups(
                    new Set(workspaceItems.map((w) => w && w.workspaceId).filter(Boolean)),
                  )
                }),
                menuItem(t('reloadTitles'), false, () => loadTitles()),
              )
            : null,
          menuOpen ? h('div', { className: 'st-menu-backdrop', onClick: () => setMenuOpen(false) }) : null,
        ),
        h(
          'div',
          { className: 'st-search' },
          h('input', {
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (ev) => setQuery(ev.target.value),
          }),
        ),
        h('div', { className: 'st-scroll', role: 'tree' }, body),
        rowMenu !== null
          ? h('div', { className: 'st-menu-backdrop', onClick: () => setRowMenu(null) })
          : null,
      )
    }

    class Boundary extends React.Component {
      constructor(p) {
        super(p)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err) {
        try {
          console.error('[session-tree] render failed', err)
        } catch (e) {}
      }
      render() {
        if (this.state.err) {
          const msg = (this.state.err && this.state.err.message) || String(this.state.err)
          return h('div', { className: 'st-err' }, 'session-tree: ' + msg)
        }
        return this.props.children
      }
    }

    return {
      // These MUST be declared. `apply`'s ctx only carries services that `inject`
      // resolves, so with `['slots']` alone `ctx.uiWorkspace` is undefined and
      // every click silently did nothing. The shipped client plugins declare the
      // same set (dsh-client-ui-subagent/lib/client.js:921-927).
      inject: ['slots', 'sessions', 'uiWorkspace', 'sidebarRight', 'locale'],
      apply(ctx) {
        let bound = null
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
            ctx.locale.register('session-tree', DICT)
            bound = ctx.locale.bind('session-tree')
          }
        } catch (e) {
          try {
            console.warn('[session-tree] locale registration failed; using built-in dictionary', e)
          } catch (_) {}
        }
        const t = makeT(bound)
        const Component = (props) => h(Boundary, null, h(TreeView, Object.assign({}, props, { ctx, t })))

        ctx.slots.inject('sidebar.workspaces', () =>
          ctx.slots.register({ name: 'sidebar.workspaces', priority: -100 }, Component),
        )
      },
    }
  },
})
