# dsh-session-tree

**English** | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b5563.svg)](https://github.com/orphiczhou/dsh-session-tree)
[![Topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0ea5e9.svg)](https://github.com/topics/dsh-plugin)

A DeepSeek Harness profile bundle that turns the left sidebar into a **session tree**: every session plus its nested subagent descendants, expandable to arbitrary depth, each node one click away from its multi-turn conversation. It also adds two Host tools: `tree_send`, which lets an agent message **any** continuable subagent session in the tree — including a sibling, which the built-in messaging APIs cannot reach — and `session_handoff`, which hands the current session off to a fresh successor at the **same level** before its context budget fills, carrying the same workspace, Agent preset, permission preset, model and reasoning effort.

<!-- Screenshot placeholder: add a screenshot of the left sidebar tree here once one exists.
     Do not reference an image file that is not in the repository. -->
<!-- ![Session tree in the left sidebar](docs/screenshot.png) -->

## Features

| Feature | What it does |
|---|---|
| Tree view | Renders every session, with `origin: 'subagent'` children nested under their durable parent (`parentId`), to arbitrary depth. |
| Workspace grouping | Sessions are grouped under the workspaces the Host reports, one collapsible header per workspace showing its name, path, and — when collapsed — its session count. Membership follows `workspace.sessionIds`, exactly as the shipped browser decides it. Sessions no workspace accounts for collect under **Ungrouped**, always rendered last. |
| Workspace order & hiding | Workspace groups are ordered by their **most recently active member session** by default, or by the Host's own order. Any workspace can be hidden from its own row menu, and hidden workspaces are listed in a collapsible **Hidden workspaces (N)** section at the end of the tree — or as the only content — where they can be restored. Both choices are client-side and survive a page refresh. |
| Lazy expansion | Nodes start collapsed. Expanding one builds its subtree; indentation grows 13 px per depth level (8 levels maximum). |
| Bounded fan-out | A node renders at most 300 child rows per level; the remainder is reported as an explicit `N more omitted` notice instead of being dropped silently. |
| Four-state status dot | Per row: running (blue, pulsing), completed but not viewed yet (green), completed and viewed (gray), waiting for your answer (orange). Colours come from DSH theme tokens and follow the light/dark theme. |
| View options | Header `…` menu: order by last updated or title (pinned sessions always lead), archived sessions hidden / shown / archived-only, expand all, collapse all, reload titles. |
| Per-row `…` menu | Pin / unpin, rename (inline input: Enter commits, Esc cancels, blur commits), Fork, archive / unarchive. |
| `↗` open aside | Opens a subagent conversation in the right sidebar as a `subagentchat` resource, in its own pane. |
| New session | A `+` button in the header, which compensates for the shadowed built-in browser's own entry point. |
| Search box | Filters rows by label or session id. While filtering, matches stay grouped under their workspace headers. |
| Collapsed-sidebar rail | When the sidebar is collapsed to its icon rail, renders a `≡` button that expands it again. |
| `tree_send` tool | Host-side tool that delivers a message to any continuable subagent session in the tree, including a sibling. |
| `session_handoff` tool | Host-side tool that writes a `HANDOFF-*.md` recap and starts a fresh successor at the same level — a sibling under the same live parent for a child session, a new root session for a root (or when the parent is gone). The successor inherits the same working directory, sidebar workspace membership, Agent preset (`work mode`, and therefore the same tool set), permission preset (sandbox + approval), model and reasoning effort. |
| `SessionTree` inspect provider | Read-only Cordis Inspect provider that reports what the sidebar **actually rendered** — row order, level, indentation, geometry and computed styles — so an agent can inspect the live tree through `cordis_inspect_query` instead of asking you to read the screen. |
| Bundled Skill (`session-handoff`) | Ships `skills/session-handoff/SKILL.md` and mounts it through the deployment's filesystem Skill provider, so a fresh agent discovers the handoff discipline (status → 50% threshold → recap file → successor → verification) from the Skill catalog instead of being told tool names. |

## Install

DSH has **no central plugin marketplace** — there is no in-app store, no plugin index, and no publish API. A plugin is distributed as an ordinary package and discovered through its README; the install command below is the whole distribution mechanism. This repository *is* the listing.

DSH installs plugins as **profile bundles**. The app's Plugins page (**Add plugin**) accepts four spec kinds: an npm package name, a Git URL, a tarball, or an absolute local path. This bundle ships as plain ESM with no build step, so any of the following works as-is.

### From the GUI

1. Open the **Plugins** page in the sidebar.
2. Choose **Add plugin**.
3. Paste the repository URL as the spec:

   ```
   https://github.com/orphiczhou/dsh-session-tree
   ```

4. Confirm. The bundle is added to the current profile; the sidebar switches to the tree without a restart.

### From the CLI

```sh
dsh plugin add orphiczhou/dsh-session-tree
```

`owner/repo` is GitHub shorthand; `github:orphiczhou/dsh-session-tree` and the full clone URL are equivalent, and adding `--profile <name>` targets a profile other than the default one. `dsh plugin <args...>` forwards its arguments to pnpm inside the profile directory, so this is an ordinary pnpm install of the repository plus one entry in the profile's `dsh.profile.bundles`.

A **git** install fetches sources rather than built artifacts, and pnpm ≥ 10 refuses to run a dependency's build script until the user allowlists it. This package contains no build script and no build step, so no allowance is needed and no prompt appears.

### From a local checkout

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-session-tree
```

The path must be absolute; pnpm records it as a `link:` dependency.

### Verify it worked

- Switch to a profile where the bundle is enabled and open DSH. The left sidebar header now reads **Sessions** (or **会话树** in a Chinese UI) — that is this plugin, not the shipped browser.
- Expand any row that shows a child count. Subagent rows appear nested underneath.
- If the sidebar still looks exactly like the shipped session list, check the **Plugins** page: the row named `session-tree` must be enabled. If it is enabled and the sidebar is unchanged, see [Troubleshooting](#troubleshooting).

Optional: confirm the Host half is mounted by asking an agent to list its tools; `tree_send` and `session_handoff` appear in the list. (`tree_send` is registered when the `tools`, `subagents`, and `sessionQuery` services are all present; `session_handoff` when `tools`, `subagents`, `agents`, and `tokenMeter` are. In a composition without them the plugin still loads and simply offers the tools it can support.) A fresh session's Skill catalog should also list `session-handoff`; if the bundle patch row cannot mount the filesystem Skill provider in your composition, the tools still work and only the catalog entry is missing.

## Usage

### Expanding and opening

- Click the **▶** twisty on a row to expand or collapse it. Rows without children show no twisty.
- A collapsed row that has children shows its child count on the right.
- Click anywhere else on a row to open that session. Top-level sessions open through the shipped navigation (`openSession(sessionId)`); subagent rows open through `openSession({ parentSessionId, childSessionId, mode })`, so a **continuable** subagent shows its multi-turn history and accepts your follow-up prompts. A finished **one-shot** subagent opens read-only — that is DSH's own behaviour, not this plugin's.
- The `↗` button on a subagent row opens the same conversation in the **right sidebar** as a separate `subagentchat` pane, leaving the left sidebar where it is.
- The `+` button in the header starts a new session.

### View options

The `…` button in the header opens:

- **Order by** — *Last updated* or *Title*. Pinned sessions lead the list in either order.
- **Workspace order** — *Most recent activity* (default: newest member activity first) or *Host order*. Ungrouped always stays last.
- **Archived sessions** — *Hide archived* (default), *Show archived*, or *Archived only*.
- **Hidden workspaces** — *Hide* (default), *Show as section*, or *Only hidden*.
- **Expand all** / **Collapse all**.
- **Reload titles** — re-reads every session's current title from the Host (see [How it works](#how-it-works)).
- **Workspace actions** — workspace headers have their own `…` button on hover: **Hide this workspace**, and **Restore this workspace** inside the hidden section.

### Workspace order, hiding and recall

Workspace order and workspace hiding are **client-side view state**: neither is written back to the Host, and both are mirrored into `localStorage` (order under `session-tree:workspaceOrder`, hidden ids under `session-tree:hiddenWorkspaces`, the section mode under `session-tree:hiddenWorkspacesMode`). If `localStorage` is unavailable — a private window, an embedding page — everything still works for the current page and simply does not survive a refresh.

- **Order.** By default workspace groups are ordered by their most recently active member session (newest first, falling back to the session's creation time when it has no update time). Pick **Workspace order → Host order** in the header `…` menu to get the Host's order back. **Ungrouped** always stays last either way.
- **Hide a workspace.** Hover a workspace header, click its `…` button, then **Hide this workspace**. The workspace and its sessions leave the tree; the choice is remembered. Hiding never deletes or archives anything on the Host — it is a view filter.
- **Recall a hidden workspace.** The header `…` menu's **Hidden workspaces** section has three states: *Hide* (hidden workspaces are not listed at all), *Show as section* (they appear in a **Hidden workspaces (N)** section at the end of the tree), *Only hidden* (only that section is listed). Inside the section, each hidden workspace keeps its own `…` button with **Restore this workspace**.
- **Search reach.** While the section is shown, a search that matches a hidden workspace's **name** also reveals that workspace, carrying a `hidden` tag, so a hidden workspace is never lost. Archived sessions stay searchable too: with **Archived sessions → Show archived / Archived only**, the search box covers them like any other row and their row `…` menu offers **Unarchive**.
- **Ungrouped** is synthetic and can never be hidden.

### Per-row actions

The `…` button on a row (visible on hover) opens: **Pin** / **Unpin**, **Rename**, **Fork session**, **Archive** / **Unarchive**. Rename edits in place — Enter commits, Esc cancels, losing focus commits. Fork is offered for ordinary sessions only; subagent rows do not show it.

### `tree_send`

`tree_send` delivers a message to a subagent session that is **not** your direct parent or direct child. The built-in `send_message` authorizes by an exact *live sender* and therefore enforces direct parent/child adjacency, so sibling-to-sibling messaging has no path through it. `tree_send` authorizes by the target's **durable parent address** instead, which is what makes siblings reachable.

| Parameter | Required | Meaning |
|---|---|---|
| `target` | yes | Session id of the continuable subagent to message. |
| `message` | yes | The message text to deliver. |
| `delivery` | no | `steer` (default) delivers at the target's nearest step boundary; `queue` targets a later turn. |
| `parent` | no | The target's direct parent session id. Omit it and the tool resolves it from the target's own session log. |

It returns acceptance only — a message id — and never waits for or returns a reply:

```json
{ "messageId": "…", "parent": "session-1d637ac2-…", "delivery": "steer" }
```

#### Worked example

Consider one root session `A` with two continuable subagent children `B` and `C`, and a grandchild `D` under `B`:

```
A  (top-level session, runs the tree_send tool)
├── B  (continuable subagent)
│   └── D  (continuable subagent)
└── C  (continuable subagent)
```

**Sibling → sibling.** The agent inside `B` wants to hand a finding to `C`. It runs:

```json
{ "target": "C", "message": "The schema you asked about is in packages/session/session-title/src/types.ts.", "delivery": "steer" }
```

`parent` is omitted, so the tool reads `C`'s log, finds its `parentSession` (`A`), and delivers through that address. `A` is live, so the delivery is accepted. This is the case the built-in APIs cannot express, because `B` is not `C`'s parent.

**Parent → child.** `A` messaging `B` or `C` is the same call with `target` set to the child, and resolves the same way — `B`'s own log names `A` as its parent, which is exactly the address the delivery uses.

**Root → grandchild is not a path.** `A` messaging `D` would require delivering through `D`'s direct parent address (`B`), and `D` is not that parent's own child from the tool's point of view — the request is refused with `subagent/parent-unavailable`. Chain two sends: `A` → `B`, then `B` → `D`.

#### Exact limits

- The target must be a **continuable** subagent (`mode: 'continuable'`). A one-shot child is refused as not resumable.
- The target's **direct parent session must be live**. If it is not, the call fails with `subagent/parent-unavailable`.
- The call **returns acceptance only** (a message id). It never waits for, and never returns, a reply.
- A target whose log has no `parentSession` is not a subagent session and cannot be addressed this way. Passing `parent` explicitly is what decides the delivery address; if you pass a wrong one, the delivery is rejected by the service.
- **Two unrelated top-level sessions still cannot reach each other.** They share no parent address, so there is no path — `tree_send` extends who can be *addressed*, not who is *reachable*.

Failures are reported as thrown errors with a `tree_send:` prefix, for example `tree_send: delivery rejected — subagent/parent-unavailable: …`.

### `session_handoff`

`session_handoff` hands the **current** session off to a fresh successor before its context budget fills (the project convention is to hand off around 50% of the context window). It has two actions:

| Action | What it does |
|---|---|
| `status` (read-only) | Reports the current context percentage, the session's route (`provider`/`model`/`reasoning_effort`), its Agent preset and permission preset, the sidebar workspace that owns its `cwd`, and the successor plan (`root` or `sibling`). |
| `handoff` | Writes `HANDOFF-<id>-<timestamp>.md` into the session working directory and, unless `spawn:false`, starts the successor and sends it a first message telling it to read that file and continue. |

The successor level follows the caller's level:

| Caller | Successor |
|---|---|
| Root session (no `parentSession`) | A new **root** session. |
| Child session whose parent Agent is live | A **sibling** under that same parent (`degraded` is not set). |
| Child session whose parent Agent is gone | An ordinary session whose durable `parentSession` still records the lineage — the runtime no longer requires a live parent. Reported as `degraded:"parent-inactive"`. |

`kind` can force the layer: `root` always builds a top-level session; `sibling` requests a sibling and falls back to root with an explicit `degraded` field.

**What the successor inherits.** A handoff keeps the working context continuous, so the successor starts with the same:

| Fact | How it is carried |
|---|---|
| Working directory | `meta.cwd` on the new session + `workingDirectory.set` in the pre-publication setup. |
| Sidebar workspace | A root successor is attached to the Workspace that owns the `cwd` (`workspaceRegistry.resolveByPath` + `Workspace.attachSession`), so it appears under the same workspace group instead of **Ungrouped**. |
| Agent preset (work mode) | `meta.agentPreset` + the preset composition is mounted in the pre-publication setup, so the successor runs the same system-prompt sections, skills and **tool set**. |
| Permission preset | The source session's `permission/preset`, `sandbox/mode` and `approval/policy` facts are appended to the successor's own log with `source:'delegation'` before the Agent is published — exactly how in-process subagents inherit their delegation scope. |
| Model & thinking level | `agentOptions` carries `provider`, `model`, `reasoningEffort` and `maxTokens` from the handing-off session's current route. |

A sibling successor inherits the preset composition and permission scope through the normal in-process subagent delegation path instead (`subagents.startActivation` under the same live parent), which is why it needs no workspace attach: the sidebar renders it under that parent, at the same depth as the session that handed off.

`threshold_pct` (default 50) refuses an early handoff unless `force:true` is passed; a second handoff in the same session within five minutes is also refused (`force:true` bypasses both guards). Escape hatches are explicit, never silent:

- `spawn:false` writes the recap file and starts nothing.
- A spawn failure keeps the already-written file and returns `spawn_error`.
- A preset that can no longer be mounted, a permission event that cannot be recorded, or a workspace attach that fails keep the handoff successful but surface `successor.preset_error` / `permission_error` / `workspace.reason` plus a human-readable `warnings[]` entry.

### Bundled Skill

The package ships one Skill, `skills/session-handoff/SKILL.md`, and its `cordis.patch.yml` mounts the deployment's filesystem Skill provider (`@deepseek-ai/dsh-skill-filesystem`, `providerName: session-tree`, `includeDefaultRoots: false`) on that directory. The Skill's `whenToUse` is written for the way users actually talk — "continue", "running out of context", "hand off to a fresh session", "around 50%" — so a newly started agent finds the discipline in its Skill catalog without being handed a tool list. It covers the status check, the 50% rule, the parameter template for the recap, the root/sibling matrix, what the successor inherits, how to verify the handoff, and how to read `degraded`/`warnings`.

Skills are part of the plugin package, so they version and ship together with the tools: `package.json.files` includes `skills`, and the same bundle patch layer that makes `session_handoff` available is what registers the Skill provider. A profile that composes no `@deepseek-ai/dsh-skill-filesystem` row still loads the plugin and the tools; only the catalog entry is absent.

## How it works

- **Seat.** The plugin occupies `sidebar.workspaces`, the left sidebar's single-occupant slot, at priority **-100**. The slot system elects the *lowest* priority for a single slot, and registering at an already-taken priority throws at load, which is why a distinct priority is required. The shipped `WorkspaceBrowser` sits at priority 0, so this plugin wins the seat while the built-in entry stays registered — disabling the plugin restores the built-in sidebar untouched.
- **Data.** Everything comes from slot props (`useSessions`), not from Host RPC: `state.byId` gives one row per session, and `state.projectionsBySession` gives projection snapshots. Those rows already carry the lineage (`parentId` plus `origin: 'subagent'`) because the shipped sidebar deliberately hides `origin: 'subagent'` rows — the whole nested tree is already in the store, and this plugin simply stops hiding it. `subagentCatalog` is used as a supplement for children that have no row of their own.
- **Workspaces.** The workspace list comes from the same standard prop the shipped browser reads, `useWorkspaces` → `state.items` (the Host's ordered workspace records). Membership is decided by `workspace.sessionIds` — **not** by `cwd`, which only gates attaching a session to a workspace — and sessions no workspace accounts for collect in a synthetic **Ungrouped** group, always last. That is the shipped browser's own grouping rule. Two deliberate differences: groups start **expanded** rather than collapsed, because the workspace level here is an added distinction rather than a gate you must open before seeing any session; and a session whose parent is present in the store is always rendered under that parent, never as a group root, which is what keeps a subagent that no workspace lists from flattening the view. With no workspace list (Host baseline not ready) the tree falls back to the previous flat layout instead of inventing a group.
- **Titles.** The newest title is read from the Host on mount through `remote.session.list({})`, which reads every session fresh and carries each session's current `projections.values.title`. That matters because the client store's projection snapshot is loaded once per connection and can keep an early `fallback` title forever; the client-side `refreshProjections` is a no-op once that baseline is ready. Titles are re-read when you pick **Reload titles**.
- **Opening.** Clicking a node reuses the shipped navigation (`openSession`), so the opened conversation is the ordinary one, with the ordinary header and composer.
- **The Host half** registers two tools, `tree_send` and `session_handoff`. Both definitions are plain objects in the shape `defineTool()` produces, so `@deepseek-ai/dsh-tools` is not imported and is not a dependency; neither Host half imports any `@deepseek-ai/*` package.
- **Inspect provider (`SessionTree.snapshot`).** The client half registers one read-only Cordis Inspect provider, so an agent can read back the tree that is on screen: every rendered row in document order with its identity (`data-key`), kind, level, computed `paddingLeft`, colour, background, font weight and bounding-box geometry, plus `groupCount` / `rowCount`. Rows carry `data-key`, `data-kind` and `data-depth` for exactly that reason — the snapshot reports what was drawn rather than recomputing it from state, so a rendering regression cannot hide behind a green test suite. `cordisInspect` belongs to the client runner and is **not** part of every composition, so it is requested with an **optional** injection (`ctx.inject(['cordisInspect'], cb)`): where the service is absent the callback never runs and the sidebar renders exactly as before. It is deliberately not in the plugin's declared `inject` list, where one missing service would stop the whole plugin from loading.

## Compatibility & version policy

This bundle declares **no `peerDependencies`**.

That is deliberate. The only compatibility field DSH enforces is `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, semver-matched against the running runtime version; every declared range must match or the bundle is skipped at load. **Missing DSH peers impose no constraint**, so declaring none means this plugin does not hard-fail on a runtime upgrade.

That is a statement about the compatibility *gate*, not a promise that every future DSH version works with this code. The plugin talks to public client services (`slots`, `sessions`, `uiWorkspace`, `sidebarRight`, `locale`) and to `subagents.prompt` / `sessionQuery.filterSessions` / `agents.create` / `tokenMeter.contextPressure` / `agentPresets` / `permissionPresets` / `workspaceRegistry` on the Host; if a future DSH changes those surfaces, the affected feature will break even though the install still succeeds. Pin a commit (`github:orphiczhou/dsh-session-tree#<sha>`) if you need a reproducible install.

## Disable / uninstall

Disabling restores the shipped sidebar immediately; no restart is required.

- **GUI:** on the **Plugins** page, turn off the plugin row whose id is `session-tree`.
- **CLI:** `dsh plugin --profile <name> remove @orphiczhou/dsh-session-tree` removes both the dependency and the bundle layer.

Uninstalling also removes `tree_send` and `session_handoff` from the tool list after the next restart (see below). The handoff feature used to be a separate `@local/dsh-session-handoff` bundle; as of v1.2.0 it ships in this bundle, so the two capabilities cannot drift apart or be installed in mismatched versions.

## Troubleshooting

**The sidebar is empty, or the plugin fails to load with a slot error.**
`sidebar.workspaces` is a single-occupant slot: only one registrant can hold it, and registering at a priority that is already taken **throws at load**. Do not install this plugin alongside another plugin that also claims `sidebar.workspaces` — one of them will fail. If you already have such a pair, disable one of them on the Plugins page.

**I edited the code and the sidebar did not change.**
The client bundle is served as a file whose revision is derived from its size and modification time, so a code change is picked up on the next **page refresh**. Reload the browser window after editing `client.js`. (Automatic rebuild-without-refresh needs a source checkout with the web dev watcher running; from an installed package, refresh.)

**I enabled or disabled the plugin and the sidebar did not change.**
Enabling and disabling is applied to the page live. If the change does not appear, refresh the page once.

**I changed the Host half (`index.js`) and the tool did not change.**
The Loader caches already-imported Host modules **by package name**, and a plain file save does not re-evaluate them — even when the package lives under the profile's `hmr.root` (measured 2026-11-11). Disable and re-enable the plugin row (`session-tree` on the Plugins page, or `plugin_manager set_plugin enabled:false` → `true` for the `include:session-tree` entry); that reload loads the new Host module. Restarting DSH also works. The same applies to bundle-patch changes such as the Skill provider row. The client half is unaffected and only needs a page refresh.

**A row shows a label that is not the session title.**
That is intended, and it matches the rest of the app. For a subagent, what DSH displays in the main-window header crumb and in the right-sidebar tab is the subagent's **descriptor label** — the delegation label it was created with — not `session/title`. This plugin renders the same label so that a row and the conversation it opens agree. The session's own title is kept as secondary information: it appears after a dash in the row's tooltip (`label — title`). Ordinary (non-subagent) rows show the durable session title.

**A row's label is dimmed and its tooltip says the title is not loaded yet.**
No displayable label was available for that session — neither a descriptor label nor a Host title — so the row falls back to something like a folder name or the short session id, displayed at reduced opacity to make clear it is not the string the app itself would show. Use **Reload titles** in the view options menu, or expand the parent so its children's projections get requested.

**A parent shows no expansion arrow even though it has subagents.**
Its child catalog has not been loaded yet. Expanding requests the parent's projections (best effort); if the catalog still never arrives, the children are simply unknown to the client and no arrow is shown.

## Development

The repository is plain ESM; nothing is compiled.

```
dsh-session-tree/
├── index.js                 # Host half: the tree_send and session_handoff tools
├── client.js                # Client half: the whole sidebar UI (browser bundle)
├── cordis.patch.yml         # the two Cordis rows this bundle contributes (plugin + Skill provider)
├── package.json             # manifest: dsh.bundle, dsh.client, exports
├── locale/{en,zh}.json      # display metadata for the Plugins page
├── skills/session-handoff/SKILL.md  # bundled Skill: handoff discipline (loaded via patch row 2)
├── icon.svg                 # bundle icon
├── scripts/verify-bundle.mjs  # manifest self-check
├── test/render.test.cjs     # headless render test
├── test/handoff.test.js     # Host-half tests for session_handoff (node:test)
├── LICENSE
├── README.md                # this file
└── README.zh.md             # Chinese README
```

Run the render test:

```sh
node test/render.test.cjs
```

It loads the **real** `client.js` in a Node sandbox (stubbing `window.__ModuleLoader__` and React) and drives it with a session map rebuilt from live session data, then asserts the row structure it produces: default collapsed state, per-level row counts after expanding, indentation per depth, key uniqueness, tolerant handling of malformed rows, and that clicking a top-level session and a subagent row navigate with the correct addresses.

Run the Host-half tests (handoff level matrix, inheritance facts, workspace attribution, guards, recap file):

```sh
node test/handoff.test.js
```

They use `node:test` with plain service mocks — no real session is created and no `@deepseek-ai/*` package is loaded; files are written to a throw-away temp directory.

Check the bundled Skill's packaging (frontmatter parses, `package.json.files` publishes it, and the bundle patch mounts the filesystem Skill provider on it):

```sh
node test/skills.test.cjs
```

Check the manifest against the rules DSH applies before it installs a bundle (patch file present and resolvable, `exports["./client"]` plus `dsh.client.platform`, the client module id equal to the package name, icon size, locale files, and the declared DSH peers):

```sh
node scripts/verify-bundle.mjs
```

## License

[MIT](LICENSE) © orphiczhou

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). DSH, Cordis, and the shipped `@deepseek-ai/dsh-*` packages are the work of their respective authors; this bundle only occupies a client slot and registers two Host tools.
