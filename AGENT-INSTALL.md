# AGENT-INSTALL.md — install & verify guide for AI agents

> **Audience**: an AI coding agent (DSH / any harness) asked to install, upgrade, verify or troubleshoot this plugin on a user's machine.
> **Repo role**: `orphiczhou/dsh-session-tree` is the **release mirror** of `packages/dsh-session-tree` in the source repo [orphiczhou/dsh-tree-harness](https://github.com/orphiczhou/dsh-tree-harness). Source of truth = the monorepo. Never edit this repo directly; changes are published from the monorepo by `scripts/release-plugin.mjs` (18 files, SHA-256 verified).
> **Snapshot**: `v1.4.0` · 2026-11-12 · tested on DSH desktop `0.2.2-rc.1` (Windows 11).

## 0. TL;DR decision tree

```
User wants…                                  → install path
├─ just the session tree (sidebar tree +     → §2 Route A: Git URL / local path (this repo)
│  tree_send + session_handoff + Skill)
├─ the full tree stack (adds tree-engine      → §2 Route B: monorepo local install
│  9 tree_* tools + 2 Skills + self_spec)      (tree-engine is NOT published here)
└─ to inspect what is already installed       → §5 Verification, then §7 Troubleshooting
```

## 1. What ships in this repo (and what does not)

| Capability | In this repo | Notes |
|---|---|---|
| Sidebar **session tree** (nested sessions / subagents, workspaces, hide/restore, search) | ✅ | browser half `client.js` |
| `tree_send` tool (message a continuable session in the caller's **own** session tree, incl. siblings; cross-tree refused, no `parent` argument) | ✅ | needs `tools` + `subagents` + `sessionQuery` |
| `session_handoff` tool (50% same-level handoff, workspace/preset/permission/model/effort inheritance, `lang=zh\|en`, `spawn:false` dry run) | ✅ | needs `tools` + `subagents` + `agents` + `tokenMeter` |
| Bundled Skill `session-handoff` | ✅ | mounted through `@deepseek-ai/dsh-skill-filesystem` (built into DSH) |
| `SessionTree` inspect provider | ✅ | consumed via `cordis_inspect_query` (inspector bundle, soft dependency) |
| `tree_plan` / `tree_node` / `tree_dispatch` / `tree_report` / `tree_status` / `tree_verify` / `tree_log` / `tree_maintain` / `tree_doctor` | ❌ | these live in **`@local/dsh-tree-engine`**, monorepo-only (not published, npm frozen) |
| Skills `tree-commander` / `tree-worker` | ❌ | same package as above |
| `self_spec` tool | ❌ | `@local/dsh-agent-introspect`, monorepo-only |

Do **not** promise the user a Git-URL install of `tree-engine`: there is no such repo. The only supported way is Route B (local link from the monorepo).

## 2. Installation

### Route A — session-tree only (Git URL, or local path)

**A1. GUI**: Plugins page → **Add plugin** → paste `https://github.com/orphiczhou/dsh-session-tree` → confirm. The sidebar becomes the tree without a restart.

**A2. CLI**:

```sh
dsh plugin add orphiczhou/dsh-session-tree                  # current profile
dsh plugin --profile <profile-name> add orphiczhou/dsh-session-tree
dsh plugin --profile <name> add /absolute/path/to/dsh-session-tree   # local checkout
```

`dsh plugin <args...>` forwards to pnpm inside the profile; a Git install fetches sources (plain ESM, no build step, so no pnpm build-script allowlist is needed).

**A3. Pin a version** (recommended for reproducibility): use a pnpm git ref, e.g. `github:orphiczhou/dsh-session-tree#v1.4.0` in the Add-plugin spec / profile dependency. Tag = `package.json.version` = what a community catalog indexes.

### Route B — full tree stack (session-tree + tree-engine + agent-introspect)

`tree-engine` and `agent-introspect` are `@local/*` packages inside the monorepo, so install by **linking the monorepo package directories** into the profile:

```powershell
# 1) clone the source repo once
git clone https://github.com/orphiczhou/dsh-tree-harness.git D:\Codes\dsh-tree-harness

# 2) profile cordis.patch.yml: add the packages dir to hmr.root (merge with existing entries)
#    - id: hmr
#      config:
#        root:
#          - "D:/Codes/dsh-tree-harness/packages"

# 3) profile package.json: add link dependencies (keep existing entries!)
#    { "dependencies": {
#        "@local/dsh-tree-engine": "link:D:/Codes/dsh-tree-harness/packages/dsh-tree-engine",
#        "@local/dsh-agent-introspect": "link:D:/Codes/dsh-tree-harness/packages/dsh-agent-introspect",
#        "@orphiczhou/dsh-session-tree": "link:D:/Codes/dsh-tree-harness/packages/dsh-session-tree"
#    } }

# 4) install in the profile directory
pnpm install

# 5) make the Loader pick up host halves (or restart DSH)
#    plugin_manager set_plugin include:tree-engine enabled:false → true
#    plugin_manager set_plugin include:session-tree enabled:false → true
#    plugin_manager set_plugin include:agent-introspect enabled:false → true

# 6) open a NEW session and verify (§5)
```

Non-Windows: same steps with POSIX paths; `link:/abs/path/to/...`.

> Profile files: back them up first (`package.json.bak-<date>`, `cordis.patch.yml.bak-<date>`). Prefer the Plugins page / `plugin_manager` over hand-editing a running profile. **HMR safety**: never overwrite `index.js`/patch files in place while DSH runs — HMR can read a half-written file and crash the host; write `.tmp` then atomic rename, or disable the bundle first.

## 3. Reload semantics (get this wrong and "nothing happened")

| Change | Required action |
|---|---|
| Host half `index.js`, `cordis.patch.yml`, new tool registration | **disable → enable** the bundle entry (`include:session-tree` / `include:tree-engine` / `include:agent-introspect`) or restart DSH. Loader caches host modules by package name — saving the file alone does nothing. |
| Client half `client.js` / locale / icon | refresh the browser page (client HMR does not re-evaluate host code) |
| `skills/*/SKILL.md` body | none for the next new session; **Skill catalog is injected at session start, so open a NEW session** |
| Skill provider patch row (e.g. new provider) | disable → enable the bundle (patch rows are host-side) |

## 4. Profile safety rules for agents

1. **Backup before profile edits**; never edit the profile while the user is mid-task without asking.
2. Do not remove/disable user-installed plugins unless the user explicitly asks.
3. Do not put tokens/credentials in files or URLs; both repos are public, no auth is needed for install.
4. Do not edit the mirror repo or push; installation is read-only.
5. After any profile edit, verify with §5 and report exactly what changed.

## 5. Verification checklist (all must pass or be explained)

Run these in a **new session** after install/reload:

| # | Check | How | Expected |
|---|---|---|---|
| 1 | Tools mounted | ask the agent to list its tools (or `plugin_manager list_plugins` / tool list) | `tree_send` + `session_handoff` present; full stack adds the 9 `tree_*` tools |
| 2 | Tool surface (tree-engine) | call `tree_doctor {action:"run"}` | `tree_doctor: 7 checks · pass=… · version=0.6.0`; no `FAIL` on `package`/`tool-count`/`skills` |
| 3 | Handoff tool | `session_handoff {action:"status"}` | one line with `context=…% (threshold 50%) … preset=… permission=… successor=… lang=zh\|en`; no side effects |
| 4 | Skill catalog | ask "what Skills do you see?" (new session!) | `session-handoff` (full stack also `tree-commander`, `tree-worker`) |
| 5 | Sidebar UI | open the left sidebar | header reads **Sessions** / **会话树**; child counts expand; subagent rows nest |
| 6 | Language | with a `zh` UI, handoff successor's first message | Chinese prompt; recap file keeps English body + localized `Successor instructions`; `lang=zh` |
| 7 | Version | `node -e` read `package.json`, or Plugins row | matches the tag you installed; `"version"` is what a catalog compares |

Quick reference for #1/#3: the render line of `status` is the cheapest machine-checkable evidence; `interface_language` is in the returned object.

## 6. Upgrade / uninstall / rollback

```sh
# upgrade (Git install)
dsh plugin remove orphiczhou/dsh-session-tree     # or disable in the Plugins page
dsh plugin add orphiczhou/dsh-session-tree#v1.4.0 # pinned
# then reload: disable → enable, open a new session

# uninstall
dsh plugin --profile <name> remove orphiczhou/dsh-session-tree
# full stack: remove the three profile link deps / bundles and the hmr.root entry, then pnpm install
```

Rollback = install the previous tag (`#v1.3.5`, …) or restore the backed-up profile files and restart. Never mix an old standalone `@local/dsh-session-handoff` with this package: both register the same `session_handoff` tool and Skill; disable/remove the old one first (v1.2.0 merged handoff into this package).

## 7. Troubleshooting matrix

| Symptom | Most likely cause | Fix |
|---|---|---|
| Tools/Skills "did not show up" at all | bundle not enabled; host module cache; wrong profile | enable `<profile>` bundle; disable→enable; verify the profile you installed into |
| `unknown tool session_handoff` | bundle disabled / not installed in this profile | install Route A; check Plugins row `session-tree` |
| Tools work but no `session-handoff` Skill | Skill catalog is per-session; or provider patch row not reloaded | open a **new** session; disable→enable bundle |
| Handoff refused `below-threshold` | context < 50% and no `force` | expected guard: use `force:true` only when the user wants to hand off early; `spawn:false` dry run is NOT blocked by this guard (still subject to the 5-minute duplicate guard) |
| Handoff refused `recent-handoff` | second handoff within 5 minutes | expected duplicate guard; pass `force:true` only if the user asks |
| Successor's first message is English on a Chinese UI | old plugin (<1.3.1) or unreadable `locale.preference` | upgrade to ≥1.3.6; check `lang=` in `status`; check profile `locale` config |
| Sidebar unchanged | another session-tree/standalone UI bundle enabled, or old plugin version | list plugins; disable duplicates; reload |
| `tree_*` tools missing after "full stack" install | tree-engine not linked/reloaded | re-check Route B steps 2–5; `inspect` the `include:tree-engine` entry |
| Host crashed after editing plugin source | HMR read a half-written host file | restart DSH; edit with bundle disabled or atomic writes |

## 8. Reporting back (what the parent agent/user needs)

Report: target profile, install route, resolved version + tag, reload actions performed, §5 checklist results (copy the render lines for #3/#4), any `FAIL`/`WARN` from `tree_doctor`, exact files changed in the profile, and backup paths. If something cannot be verified (no UI access, no new session), say so explicitly instead of claiming success.

## 9. Sources of truth (monorepo)

- Project map (rendered): [GitHub Pages](https://orphiczhou.github.io/dsh-tree-harness/project-map-2026-11-11.html)
- Human install guide: [docs/guides/install-guide.md](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/guides/install-guide.md)
- Skill usage guide: [docs/guides/skills-usage.md](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/guides/skills-usage.md)
- Publishing / release process: [docs/guides/publishing.md](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/guides/publishing.md)
- Full docs index: [docs/README.md](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/README.md)
