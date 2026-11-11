# dsh-session-tree

[English](README.md) | **中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4b5563.svg)](https://github.com/orphiczhou/dsh-session-tree)
[![Topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0ea5e9.svg)](https://github.com/topics/dsh-plugin)

一个 DeepSeek Harness 的 profile bundle：把左侧栏换成**会话树**——每个会话下面挂着它的 subagent 后代，可逐层展开、层数不限，点任意节点就能打开该会话的多轮对话。它还注册两个宿主工具：`tree_send` 让智能体能给树里**任意**一个可续聊的子会话发消息，包括内置通讯 API 够不到的**兄弟会话**；`session_handoff` 则让当前会话在上下文将满时自我交接给**同层级**的新会话，并继承同一个工作区、Agent 预设（工作模式）、权限模式、模型与思考等级。

**当前版本：v1.3.6。** 随包 `session-handoff` Skill 自 **v1.3.0** 起；接替提示语跟随 DSH 界面语言自 **v1.3.1** 起（见 [releases](https://github.com/orphiczhou/dsh-session-tree/tags)）。

<!-- 截图占位：有截图后再放到这里。
     不要引用仓库里并不存在的图片文件。 -->
<!-- ![左侧栏会话树](docs/screenshot.png) -->

## 功能

| 功能 | 说明 |
|---|---|
| 树形视图 | 显示全部会话，`origin: 'subagent'` 的子会话按持久化的父子关系（`parentId`）嵌在父会话下，层数不限。 |
| 工作区分组 | 按宿主上报的 workspace 分组，每个工作区一个可折叠的组头，显示名称、路径，折叠时还显示会话数。归属判定用 `workspace.sessionIds`，与自带浏览器完全一致；不属于任何工作区的会话收进**未分组**，固定排在最后。 |
| 工作区排序与隐藏 | 工作区默认按**成员会话最近活动**倒序（也可切回 Host 顺序）。任意工作区都可以在它自己的行菜单里隐藏；被隐藏的工作区收进树末尾可折叠的**已隐藏工作区 (N)** 分区——也可以只显示它们——随时可以恢复。两项都是客户端视图状态，刷新页面后仍然生效。 |
| 按需展开 | 初始全部折叠；展开某个节点才构建它的子树，缩进每层加 13 px（最多 8 层）。 |
| 渲染上限 | 每层最多渲染 300 个子行，其余以明确的“另有 N 个未显示”提示给出，不静默丢弃。 |
| 四态状态圆点 | 每行一个：进行中（蓝、带呼吸动画）、已完成但还没看过（绿）、已完成且已看过（灰）、正在等你回应（橙）。颜色取自 DSH 主题 token，随明暗主题变化。 |
| 视图选项 | 标题栏 `…` 菜单：按最近更新或按名称排序（置顶会话始终在前）、已归档会话「隐藏 / 显示 / 仅显示」、展开全部、全部折叠、重新加载标题。 |
| 每行 `…` 菜单 | 置顶 / 取消置顶、重命名（行内编辑：回车提交、Esc 取消、失焦提交）、Fork、归档 / 取消归档。 |
| `↗` 在右侧栏打开 | 把子会话的对话以 `subagentchat` 资源的形式打开在右侧栏，单独占一个窗格。 |
| 新建会话 | 标题栏的 `+` 按钮——接管左栏后自带浏览器的新建入口被遮蔽，这里补上。 |
| 搜索框 | 按标签或会话 id 过滤；过滤时结果仍留在各自的工作区分组下。 |
| 折叠后的侧栏 | 左栏被折叠成图标条时渲染一个 `≡` 按钮，点击即可展开侧栏。 |
| `tree_send` 工具 | 宿主半工具：向树里任意可续聊的子会话投递消息，兄弟会话也可以。 |
| `session_handoff` 工具 | 宿主半工具：写下 `HANDOFF-*.md` 交接文件，并启动**同层级**接替会话——子会话在同一个活着的父会话下生成兄弟，根会话（或父已不在）生成新根会话。接替会话继承同一个工作目录与侧栏工作区归属、同一个 Agent 预设（工作模式，因此工具集相同）、同一个权限模式（沙箱 + 审批）、同一个模型与思考等级。 |
| 接替提示跟随界面语言 | 接替会话读到的第一条指令跟随 DSH 界面语言（**设置 → 通用 → 语言**，`locale.preference`）：`zh` 用中文、`en` 用英文；其它已存语言与未存偏好时回退英文。交接文件正文保持英文规范文档，但其中的「Successor instructions」块与提示语同语言；`status`/`handoff` 渲染行尾带 `lang=zh\|en`，返回对象含 `interface_language`，脚本可不解析接替会话日志直接断言。 |
| `SessionTree` 检视 provider | 只读的 Cordis Inspect provider：回报左栏**实际渲染成了什么**——行序、层级、缩进、几何与计算样式——让 agent 用已有的 `cordis_inspect_query` 自己看真实应用里的树，而不必让你念屏幕。 |
| 随包 Skill（`session-handoff`） | 包内自带 [`skills/session-handoff/SKILL.md`](skills/session-handoff/SKILL.md)，并通过宿主的 filesystem Skill provider 挂载：新会话从 Skill 目录就能发现交接纪律（status → 50% 阈值 → 写交接文件 → 启动接替 → 验收），不需要别人先把工具名喂给它。 |

## 安装

DSH **没有中心化的插件市场**——没有应用内商店、没有插件索引、也没有发布 API。插件就是一个普通包，靠 README 被人发现；下面这条安装命令就是全部的传播方式。**这个仓库本身就是那份“上架信息”。**

DSH 以 **profile bundle** 的形式安装插件。应用的 Plugins 页面（**Add plugin**）接受四种 spec：npm 包名、**Git URL**、tarball、绝对本地路径。本 bundle 是纯 ESM、不需要构建，下面几种方式都可以直接用。

> **让 AI Agent 来装？** 看 [AGENT-INSTALL.md](AGENT-INSTALL.md)：两条安装路线（本仓 vs 仅 monorepo 可得的 `tree-engine` 全栈）、重载语义、验收清单、排障矩阵。
> **要装完整树体系？** `tree-engine`（9 个 `tree_*` 工具 + 2 个 Skill）不在本仓发布——见源码仓的[安装指南](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/guides/install-guide.md)。

### 图形界面安装

1. 打开左侧栏的 **Plugins** 页面。
2. 选择 **Add plugin**。
3. 把仓库地址粘进 spec 输入框：

   ```
   https://github.com/orphiczhou/dsh-session-tree
   ```

4. 确认。bundle 会装进当前 profile，左栏立即变成会话树，无需重启。

### 命令行安装

```sh
dsh plugin add orphiczhou/dsh-session-tree
```

`owner/repo` 是 GitHub 简写，`github:orphiczhou/dsh-session-tree` 与完整 clone 地址等价；加 `--profile <name>` 可以指定默认之外的 profile。`dsh plugin <args...>` 只是把参数转发给 profile 目录里的 pnpm，所以这就是一次普通的 pnpm 安装，外加在 profile 的 `dsh.profile.bundles` 里追加一条。

**git** 安装拉取的是源码而不是构建产物，而 pnpm ≥ 10 默认拒绝执行依赖的构建脚本，除非用户显式放行。本包没有任何构建脚本、也不需要构建，因此不会出现放行提示。

### 从本地 checkout 安装

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-session-tree
```

路径必须是绝对路径；pnpm 会把它记成 `link:` 依赖。

### 确认装好了

- 切到启用了本 bundle 的 profile 打开 DSH：左栏标题应当变成 **会话树**（英文界面下是 **Sessions**）——这说明当前渲染的是本插件，而不是自带的会话浏览器。
- 展开任意一个右侧带子会话数量的行，子会话会嵌套显示在下面。
- 如果左栏和自带的会话列表一模一样，去 **Plugins** 页面确认 id 为 `session-tree` 的那一行是启用状态。已启用但仍无变化，见[疑难排查](#疑难排查)。

可选：让智能体列一下自己的工具，`tree_send` 与 `session_handoff` 在列表里就说明宿主半挂上了。（`tree_send` 需要 `tools`、`subagents`、`sessionQuery` 三个服务都存在；`session_handoff` 需要 `tools`、`subagents`、`agents`、`tokenMeter`。缺服务的组合里插件照常加载，只是不提供它无法支持的工具。）新会话的 Skill 目录里还应当能看到 `session-handoff`；若你的组合无法挂载 filesystem Skill provider，工具照常工作，只是少这一条目录项。

## 使用

### 展开与打开

- 点行首的 **▶** 展开或折叠；没有子会话的行不显示这个三角。
- 折叠状态下有子会话的行，右侧会显示子会话数量。
- 点行的其他位置打开该会话。顶层会话走自带导航 `openSession(sessionId)`；子会话行走 `openSession({ parentSessionId, childSessionId, mode })`，所以**可续聊**的子会话会显示多轮历史并接受你的后续提问，而已经结束的**一次性**子会话打开后是只读的——这是 DSH 自带的行为，不是本插件造成的。
- 子会话行上的 `↗` 会把同一个对话打开到**右侧栏**，单独占一个 `subagentchat` 窗格，左栏不受影响。
- 标题栏的 `+` 新建会话。

### 视图选项

标题栏的 `…` 按钮打开菜单：

- **排序方式**——*最近更新* 或 *按名称*。两种排序下置顶会话都在最前。
- **工作区排序**——*最近活动*（默认：成员会话最新活动在前）或 *Host 顺序*。未分组始终最后。
- **已归档会话**——*隐藏已归档*（默认）、*显示已归档*、*仅显示已归档*。
- **已隐藏工作区**——*隐藏*（默认）、*显示为分区*、*仅显示已隐藏*。
- **展开全部** / **全部折叠**。
- **重新加载标题**——从宿主重新读取每个会话的当前标题（见[实现要点](#实现要点)）。
- **工作区操作**——工作区组头悬停时出现自己的 `…` 按钮：**隐藏此工作区**；在隐藏分区内则是**恢复显示**。

### 工作区排序、隐藏与召回

工作区排序与隐藏都是**客户端视图状态**：不写回宿主，镜像到 `localStorage`（排序在 `session-tree:workspaceOrder`，已隐藏 id 在 `session-tree:hiddenWorkspaces`，分区三态在 `session-tree:hiddenWorkspacesMode`）。如果 `localStorage` 不可用——隐私窗口、被嵌入的页面——当前页面照常工作，只是刷新后不保留。

- **排序。** 工作区分组默认按成员会话的最近活动时间倒序（取不到更新时间时回退到会话创建时间）。在标题栏 `…` 菜单选 **工作区排序 → Host 顺序** 可以切回宿主自己的顺序；无论哪种模式，**未分组**都固定最后。
- **隐藏工作区。** 悬停工作区组头，点它的 `…` 按钮，选 **隐藏此工作区**。该工作区及其会话从树里移出，选择会被记住。隐藏不会删除或归档宿主上的任何东西——它只是一个视图过滤。
- **召回已隐藏工作区。** 标题栏 `…` 菜单的 **已隐藏工作区** 分区有三态：*隐藏*（完全不列出隐藏工作区）、*显示为分区*（在树末尾渲染 **已隐藏工作区 (N)** 分区）、*仅显示已隐藏*（只列出该分区）。在分区内，每个隐藏工作区保留自己的 `…` 按钮，可点 **恢复显示**。
- **搜索可达性。** 分区显示时，搜索命中某个隐藏工作区的**名称**也会把它显示出来，并带上 `已隐藏` 标记，隐藏工作区不会失联。已归档会话同样可检索：选择 **已归档会话 → 显示已归档 / 仅显示已归档** 后，搜索框会像其他行一样覆盖它们，行 `…` 菜单里提供 **取消归档**。
- **未分组** 是合成的工作区，不能被隐藏。

### 每行操作

行上的 `…` 按钮（悬停时出现）打开：**置顶 / 取消置顶**、**重命名**、**Fork 分支会话**、**归档 / 取消归档**。重命名是行内编辑——回车提交、Esc 取消、失焦提交。Fork 只对普通会话提供，子会话行不显示。

### `tree_send`

`tree_send` 用来给**不是**你直接父会话、也不是你直接子会话的子会话投递消息。自带的 `send_message` 按“活的发送者”授权，因此强制邻接关系，兄弟之间没有路径可走；`tree_send` 改按目标的**持久化父地址**授权，这正是兄弟能被寻址的原因。

| 参数 | 必填 | 含义 |
|---|---|---|
| `target` | 是 | 目标子会话（可续聊）的 session id。 |
| `message` | 是 | 要投递的正文。 |
| `delivery` | 否 | `steer`（默认）在目标最近的一个 step 边界投递；`queue` 投给之后的某个 turn。 |
| `parent` | 否 | 目标的直接父会话 id。省略时由工具从目标自己的会话日志里读出。 |

它只返回“已受理”（messageId），**不等待、也不返回回复**：

```json
{ "messageId": "…", "parent": "session-1d637ac2-…", "delivery": "steer" }
```

#### 一个完整的例子

一个顶层会话 `A`，两个可续聊的子会话 `B`、`C`，以及挂在 `B` 下面的孙会话 `D`：

```
A  （顶层会话，由它来调用 tree_send）
├── B  （可续聊子会话）
│   └── D  （可续聊子会话）
└── C  （可续聊子会话）
```

**兄弟 → 兄弟。** `B` 里的智能体要把一个发现交给 `C`，它调用：

```json
{ "target": "C", "message": "你问的那个 schema 在 src/session/title/types.ts。", "delivery": "steer" }
```

省略了 `parent`，工具于是去读 `C` 的日志，取出它的 `parentSession`（也就是 `A`），再从那个地址投递。`A` 在线，投递被受理。**这正是内置 API 表达不了的情况**——`B` 并不是 `C` 的父会话。

**父 → 子。** `A` 给 `B` 或 `C` 发消息，就是同一个调用换个 `target`，解析方式也一样——`B` 自己的日志里写着父会话是 `A`，那正是投递用的地址。

**顶层 → 孙会话仍然没有路径。** `A` 给 `D` 发消息需要经由 `D` 的直接父地址（`B`）投递，而从工具的授权角度看 `D` 并不是 `B` 的孩子，请求会以 `subagent/parent-unavailable` 被拒。请分两步：`A` → `B`，再 `B` → `D`。

#### 明确的边界

- 目标必须是**可续聊**（`mode: 'continuable'`）的子会话；一次性的子会话会以"不可恢复"被拒。
- 目标的**直接父会话必须在线**，否则调用失败：`subagent/parent-unavailable`。
- 调用**只返回受理结果**（message id），既不等待回复也不返回回复。
- 日志里没有 `parentSession` 的目标不是子会话，无法这样寻址。显式传入 `parent` 就等于指定投递地址；传错会被服务拒绝。
- **两个互不相关的顶层会话之间依然没有路径。** 它们没有共同的父地址——`tree_send` 扩展的是“谁可以被寻址”，不是“谁可以被触达”。

失败会以抛错形式报告，带 `tree_send:` 前缀，例如 `tree_send: delivery rejected — subagent/parent-unavailable: …`。

### `session_handoff`

`session_handoff` 在**当前**会话的上下文将满时，把它交接给一个全新的接替会话（项目约定在上下文约 50% 时交接）。两个动作：

| 动作 | 做什么 |
|---|---|
| `status`（只读） | 报告当前上下文百分比、会话路由（`provider`/`model`/`reasoning_effort`）、Agent 预设与权限模式、拥有其 `cwd` 的侧栏工作区，以及接替方案（`root` 或 `sibling`）。 |
| `handoff` | 在会话工作目录写 `HANDOFF-<id>-<timestamp>.md`，并在 `spawn:false` 之外的情况下启动接替会话、发首条指令让它读交接文件并继续。 |

接替层级跟随调用者所在层级：

| 调用者 | 接替会话 |
|---|---|
| 根会话（无 `parentSession`） | 新的**根**会话。 |
| 子会话且父 Agent 活着 | 同一父会话下的**兄弟**（不设 `degraded`）。 |
| 子会话但父 Agent 已不在 | 普通会话，但持久化 `parentSession` 仍记录血缘——运行时不再要求父会话活着。返回 `degraded:"parent-inactive"`。 |

`kind` 可以强制层级：`root` 总是新建顶层会话；`sibling` 请求兄弟，做不到时回退为根并显式带 `degraded` 字段。

**接替会话继承什么。** 交接要保持上下文连续，因此接替会话以相同的这些事实启动：

| 事实 | 如何携带 |
|---|---|
| 工作目录 | 新会话的 `meta.cwd` + 发布前 setup 里的 `workingDirectory.set`。 |
| 侧栏工作区 | 根接替会话会被挂到拥有该 `cwd` 的 workspace（`workspaceRegistry.resolveByPath` + `Workspace.attachSession`），因此出现在同一个工作区分组下，而不是**未分组**。 |
| Agent 预设（工作模式） | `meta.agentPreset` + 在发布前 setup 里挂载同一个预设组成，因此接替会话运行相同的 system-prompt 段、skills 和**工具集**。 |
| 权限模式 | 源会话的 `permission/preset`、`sandbox/mode`、`approval/policy` 事实以 `source:'delegation'` 追加到接替会话自己的日志，且发生在 Agent 发布之前——与进程内子会话继承委派范围的方式完全一致。 |
| 模型与思考等级 | `agentOptions` 携带交接会话当前路由的 `provider`、`model`、`reasoningEffort`、`maxTokens`。 |

兄弟接替会话改走正常的进程内子会话委派路径，继承预设组成与权限范围，因此不需要工作区挂载：侧栏会把它渲染在父会话下面、与交接会话同层。

**接替提示语的语言。** 接替会话读到的第一条指令跟随 DSH 界面语言，而不是写死的英文模板。工具读取 **设置 → 通用 → 语言** 存入的 `locale.preference`——先经活体 Loader 的 `locale` 条目，再经 profile 的 `cordis.patch.yml` / `cordis.yml`（宿主进程以 profile 目录为 cwd）——归一化到主语言子标签，对 `zh` 与 `en` 本地化提示语；其它已存语言回退英文，未存偏好时同样英文。交接文件正文保持英文规范文档，但「Successor instructions」块与提示语同语言，因此接替会话始终有一份稳定、可机检的文件。`status` / `handoff` 的渲染行尾带 `lang=zh|en`，返回对象含 `interface_language`——可直接断言这两处；独立验收脚本（源码仓 dsh-tree-harness：[verify-kickoff-language.mjs](https://github.com/orphiczhou/dsh-tree-harness/blob/master/scripts/e2e/verify-kickoff-language.mjs)，不随本插件包发布）会进一步解码接替会话首条 `user/message`，确认新会话实际读到什么。

`threshold_pct`（默认 50）在未传 `force:true` 时拒绝过早交接；同一会话五分钟内的第二次交接也会被拒（`force:true` 同时绕过两道闸）。逃生口是显式的，绝不静默：

- `spawn:false` 只写交接文件，不启动任何会话。
- 启动失败保留已经写好的文件，返回 `spawn_error`。
- 预设无法再挂载、权限事件无法记录、或工作区挂载失败时，交接仍然成功，但会通过 `successor.preset_error` / `permission_error` / `workspace.reason` 以及人类可读的 `warnings[]` 明确暴露。

**调用样例。**

```jsonc
// 工具调用：session_handoff
{
  "action": "handoff",
  "summary": "退款重试：状态机与单测已完成，集成测试还差支付网关的 mock。",
  "next_steps": ["先跑一遍现有单测确认基线", "补 tests/integration/refund-retry.test.ts 的网关 mock 分支"],
  "files": ["src/refund/retry.ts", "tests/unit/refund-retry.test.ts"],
  "open_questions": ["网关超时是否计入重试次数？"],
  "note": "只改上面两个文件与新增测试。"
}
```

```text
// 返回渲染（单行、有界；完整对象在工具返回值里）
session_handoff: wrote <cwd>\HANDOFF-<短id>-<时间>.md; successor <id> kind=root preset=standard inherited=session-route lang=zh
```

| 参数 | 必填 | 含义 |
|---|---|---|
| `summary` | **是** | 一段话：任务是什么、现在到哪、还剩什么。接替会话最先读它。 |
| `next_steps[]` | 建议 | 有序的下一步；接替会话从这里继续。 |
| `files[]` | 建议 | 改动过的或最该先看的文件。 |
| `open_questions[]` | 可选 | 接替会话必须带着的未决问题。 |
| `note` | 可选 | 自由补充（约束、护栏、链接）。 |
| `kind` | 可选 | `root` / `sibling` / `auto`（缺省，按调用者层级）。 |
| `spawn` | 可选 | `false` 只写交接文件，不启动会话。 |
| `threshold_pct` | 可选 | 默认 50。 |
| `force` | 可选 | 绕过阈值闸与 5 分钟防重复——只在用户明确要求提前交接时用。 |

**新会话里的冒烟测试。** 全新会话上下文远低于 50%，直接 `handoff` 被 `below-threshold` 拒绝是**预期行为**，这次拒绝本身就证明工具已挂载。想看一次完整路径：加 `force:true`（会启动接替会话）。只想写交接文件不启动会话：传 `spawn:false`——**这个干跑不被阈值闸拦**（低于 50% 也会写 `HANDOFF-*.md`）；防重复闸仍然生效，5 分钟内第二次会返回 `recent-handoff`。只想确认工具在：`session_handoff {action:"status"}` 无副作用。

### 随包技能（Bundled Skill）

本包自带一个 Skill：`skills/session-handoff/SKILL.md`；`cordis.patch.yml` 的第二条 insert 把宿主的 filesystem Skill provider（`@deepseek-ai/dsh-skill-filesystem`，`providerName: session-tree`，`includeDefaultRoots: false`）挂到该目录。Skill 的 `whenToUse` 按用户真实说法编写——「继续干」「快到上限了」「交接给新会话」「上下文 50%」——所以**新开的 agent 从 Skill 目录就能发现交接纪律**，不需要别人先把工具名喂给它。正文覆盖：status 检查、50% 规则、交接文件参数模板、root/sibling 层级矩阵、接替会话继承什么、如何验收、`degraded`/`warnings` 怎么读。

Skill 是插件包的一部分，与工具同版本发布：`package.json.files` 包含 `skills`，注册 Skill provider 的正是本 bundle 的 patch 行。若某个组合根本没有 `@deepseek-ai/dsh-skill-filesystem` 这一行，插件与工具照常工作，只是 Skill 目录里少这一条。

#### 怎么用这个随包 Skill

1. **安装**：Plugins → Add plugin → Git URL `https://github.com/orphiczhou/dsh-session-tree`；宿主半或 patch 行有变化时，对 bundle 条目做一次 disable→enable。
2. **确认目录**：**新开**一个会话（Skill 目录在会话启动时注入，已开的会话不会刷新），问「你看到的 Skill 有哪些」，应含 `session-handoff`。filesystem Skill provider（`@deepseek-ai/dsh-skill-filesystem`）**随 DSH 桌面版内置，不要单独安装**；机检可用源码仓脚本 [collect-skills.mjs](https://github.com/orphiczhou/dsh-tree-harness/blob/master/scripts/skill-e2e/collect-skills.mjs) 读会话日志。
3. **用人话触发**（不必点名工具）：
   - 「继续干，快到上限就交接」/「上下文 50% 了，交接给新会话」→ 先 `status`，≥50% 再 `handoff`；
   - 「写个交接文件，让新会话接着干」→ 写交接文件并启动同层级接替；
   - 「交接完验收一下」→ 按 Skill 的验收清单核对（`preset=`/`permission=`、接替首轮读文件、无 `degraded`、`warnings` 为空）。
   - 先看上面的**冒烟测试**：把 `below-threshold` / `recent-handoff` 当故障是新手最常见的误会。
4. **语言**：接替会话首条消息跟随 DSH 界面语言（设置 → 通用 → 语言）。`zh` → 中文提示语，`en` → 英文，其它已存语言与未设置 → 英文；`status`/`handoff` 行尾带 `lang=zh|en`，返回对象含 `interface_language`。
5. **排障**：目录里没有 Skill → 确认 bundle patch 行已重载（disable→enable）且会话是**新开**的；provider 本身内置。`unknown tool session_handoff` → bundle 未启用。完整用户指南（含配套 `tree-commander` / `tree-worker`，来自 `@local/dsh-tree-engine`）见源码仓 [`docs/guides/skills-usage.md`](https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/guides/skills-usage.md)（不随本插件包发布）。

## 实现要点

- **席位。** 插件占用 `sidebar.workspaces`——左栏那个单占用（single）席位，优先级 **-100**。single 席位取**优先级最低**的注册者渲染，而在已被占用的优先级上注册会**在加载时抛错**，所以必须用一个不同的优先级。自带的 `WorkspaceBrowser` 是 0，于是本插件拿到席位，而自带那一行仍然留在册——停用本插件，自带侧栏原样回来。
- **数据。** 全部来自槽位 props（`useSessions`），不走宿主 RPC：`state.byId` 给出每个会话一行，`state.projectionsBySession` 给出投影快照。这些行本来就带血缘信息（`parentId` 加 `origin: 'subagent'`）——因为自带侧栏刻意**隐藏**了 `origin: 'subagent'` 的行，整棵嵌套树其实早就在 store 里，本插件只是不再隐藏它。子会话自己没有对应行时，用 `subagentCatalog` 补上。
- **工作区。** 工作区列表取自自带浏览器读的同一个标准 prop：`useWorkspaces` → `state.items`（宿主给的有序工作区记录）。归属由 `workspace.sessionIds` 决定，**不是** `cwd`——后者只决定会话能否挂到某个工作区；不属于任何工作区的会话收进合成的**未分组**组，固定排最后。这就是自带浏览器自己的分组规则。两处有意的差异：分组默认**展开**而不是折叠，因为这里的工作区层级是额外加的一层区分，而不是「必须先点开才能看到任何会话」的闸门；另外，只要父会话在 store 里，子会话就一定渲染在父会话下面、不会变成分组根行——这正是「没被任何工作区收录的子会话会把视图摊平」的防线。宿主基线未就绪（没有工作区列表）时退回原来的扁平布局，而不是凭空造一个分组。
- **标题。** 最新标题在挂载时通过 `remote.session.list({})` 从宿主读取——那是每次现读、覆盖全部会话、并带上各自当前 `projections.values.title` 的接口。客户端 store 里的投影快照**每个连接只加载一次基线**，之后 `refreshProjections` 就是空操作，因此 store 里可能永远停在一个早期的 `fallback` 标题上。选 **重新加载标题** 可以再读一次。
- **打开会话。** 点击节点复用自带导航（`openSession`），所以打开的就是普通的对话界面、普通的标题栏和输入区。
- **宿主半**注册两个工具：`tree_send` 与 `session_handoff`。两个定义都直接写成 `defineTool()` 产出的纯对象形状，因此不导入 `@deepseek-ai/dsh-tools`，它也不是依赖；宿主半不导入任何 `@deepseek-ai/*` 包。
- **检视 provider（`SessionTree.snapshot`）。** 客户端半边注册一个只读的 Cordis Inspect provider，让 agent 能读回屏幕上那棵树：按文档顺序的每一行，含身份（`data-key`）、类型、层级、计算出的 `paddingLeft`、颜色、背景、字重、包围盒几何，以及 `groupCount` / `rowCount`。每一行带 `data-key` / `data-kind` / `data-depth` 正是为了这个：快照报告的是**画出来的东西**，而不是从 state 重算的结果，所以渲染回归藏不到全绿的测试套件后面。`cordisInspect` 由 client runner 提供，并非每种组合都有，因此用**可选注入**（`ctx.inject(['cordisInspect'], cb)`）请求：服务缺席时回调根本不会被调用，左栏照常渲染。它**绝不**进插件声明的 `inject` 数组——那里少一个服务会让整个插件不加载。

## 兼容性与版本策略

本 bundle **不声明任何 `peerDependencies`**。

这是刻意的。DSH 唯一强制检查的兼容字段，就是 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 上的 `peerDependencies`，它会拿正在运行的运行时版本做 semver 匹配，任何一个范围不匹配就跳过该 bundle。**没有声明 DSH peer 就不构成任何约束**，所以不声明意味着运行升级时本插件不会硬失败。

这句话说的是兼容**闸门**，不是“以后每个 DSH 版本都能用”的承诺。插件使用的客户端服务是 `slots`、`sessions`、`uiWorkspace`、`sidebarRight`、`locale`，宿主侧用的是 `subagents.prompt`、`sessionQuery.filterSessions`、`agents.create`、`tokenMeter.contextPressure`、`agentPresets`、`permissionPresets`、`workspaceRegistry`；另外 bundle patch 还插入一行 `@deepseek-ai/dsh-skill-filesystem` 来挂载随包 Skill（该包缺席时工具照常、只是没有 Skill 目录项）。如果将来的 DSH 改动了这些接口，相应功能会失效，尽管安装依然成功。需要可复现的安装就钉住一个 commit（`github:orphiczhou/dsh-session-tree#<sha>`）。

## 停用 / 卸载

停用即刻还原自带侧栏，不需要重启。

- **图形界面：** 在 **Plugins** 页面关掉 id 为 `session-tree` 的那一行。
- **命令行：** `dsh plugin --profile <name> remove @orphiczhou/dsh-session-tree`，依赖与 bundle 层一起移除。

完全卸载后，`tree_send` 与 `session_handoff` 会在下一次重启后从工具列表里消失（原因见下）。会话自交接能力在 v1.2.0 之前是独立的 `@local/dsh-session-handoff` bundle，现已并入本 bundle——两个能力不会再各自漂移或装成不匹配的版本。

**从 1.2.0 之前的版本升级。** 先停用或移除旧的独立 `@local/dsh-session-handoff` bundle，**再**启用本 bundle。不要两个同时跑：它们注册同名的 `session_handoff` 工具与同名的 `session-handoff` Skill，先加载的那个生效——正是「旧实现遮蔽新实现」的陷阱。

## 疑难排查

**左栏空白，或者加载时报了席位（slot）相关的错。**
`sidebar.workspaces` 是单占用席位：只能有一个注册者，而在已被占用的优先级上注册会**在加载时抛错**。不要和另一个同样占用 `sidebar.workspaces` 的插件一起装——两者必有一个加载失败。已经装成这样了，就在 Plugins 页面停用其中一个。

**改了代码，侧栏没变化。**
客户端 bundle 是按文件大小与修改时间派生版本来提供的，所以代码改动要在**刷新页面**后才生效。改完 `client.js` 请刷新浏览器窗口。（要做到“改完不刷新就自动重建”，得是带 web dev watcher 的源码 checkout；装的是已发布的包时，刷新即可。）

**启用/停用之后侧栏没变化。**
启用与停用是即时作用于当前页面的。若没看到变化，刷新一次页面。

**改了宿主半（`index.js`），工具没变化。**
Loader 对已导入的宿主模块是**按包名缓存**的，单纯保存文件不会让它重新求值——即使包在 profile 的 `hmr.root` 内（2026-11-11 实测）。请把插件行停用再启用（Plugins 页面的 `session-tree`，或对 `include:session-tree` 条目执行 `plugin_manager set_plugin enabled:false` → `true`），这一次重载才会加载新的宿主模块；重启 DSH 同样有效。bundle patch（例如 Skill provider 行）的改动同理。客户端半不受此影响，刷新页面即可。

**Skill 在目录里，但 agent 不用它。**
Skill 靠意图命中、由模型**自己选择**，不点名工具。用日常说法（「交接给新会话」「continue, I'm running low on context」）比说「用 session_handoff」更容易命中；要确定性就直接说「用 session-handoff Skill」。很短的会话可能确实还不需要它。

**升级了插件，但行为还是旧的（没有 Skill / 接替首条仍是英文）。**
版本相关：随包 Skill 自 **v1.3.0** 起，接替提示语本地化自 **v1.3.1** 起。到 Plugins 行或 `node_modules/@orphiczhou/dsh-session-tree/package.json` 核对版本；低于这些版本时旧行为是预期的。升级后重载 bundle 条目（disable→enable）并**新开**会话。若还启用着旧的独立 `@local/dsh-session-handoff` bundle，请先停用它（见「停用 / 卸载」）。

**某一行显示的文字不是会话标题。**
这是有意为之，而且与应用其他地方保持一致。对子会话来说，DSH 在主窗口标题栏和右侧栏标签里显示的本来就是子智能体的**描述符标签**（创建它时的委派标签），**不是** `session/title`。本插件渲染同一个字符串，正是为了让行上的文字和点开后看到的东西对得上。会话自身的标题作为次要信息保留：以 `标签 — 标题` 的形式出现在该行的 tooltip 里。普通（非子会话）行显示的是持久化的会话标题。

**某一行的标签是灰的，tooltip 说标题尚未加载。**
该会话既没有可用的描述符标签、也没有宿主标题，于是这一行退化成了目录名或短 id 之类的东西，用降低不透明度明确表示“这不是应用自己会显示的那个字符串”。可以在视图选项里点 **重新加载标题**，或者展开它的父节点，让子会话的投影被请求一次。

**父节点明明有子智能体，却没有展开箭头。**
它的子会话目录还没加载。展开时会（尽力）请求该父会话的投影；如果目录始终没来，客户端就不知道有哪些子会话，也就不会有箭头。

## 开发

仓库是纯 ESM，不需要编译。

```
dsh-session-tree/
├── index.js                 # 宿主半：tree_send 与 session_handoff 工具
├── client.js                # 客户端半：整个侧栏 UI（浏览器 bundle）
├── cordis.patch.yml         # 本 bundle 贡献的两条 Cordis 行（插件 + Skill provider）
├── package.json             # 清单：dsh.bundle、dsh.client、exports
├── locale/{en,zh}.json      # Plugins 页面的展示元数据
├── skills/session-handoff/SKILL.md  # 随包 Skill：交接纪律（由 patch 第二行挂载）
├── icon.svg                 # bundle 图标
├── scripts/verify-bundle.mjs  # 清单自检
├── test/render.test.cjs     # headless 渲染测试
├── test/handoff.test.js     # 宿主半 session_handoff 测试（node:test）
├── test/skills.test.cjs     # 随包 Skill 打包回归（frontmatter/files/patch 行）
├── LICENSE
├── README.md                # 英文 README
└── README.zh.md             # 本文件
```

跑渲染测试：

```sh
node test/render.test.cjs
```

它在 Node 沙箱里加载**真实的** `client.js`（stub 掉 `window.__ModuleLoader__` 和 React），用按实时会话数据重建的会话表驱动它，然后断言产出的行结构：默认是否全折叠、逐级展开后的行数、各层缩进、key 是否唯一、畸形行是否被容错处理，以及点击顶层会话与子会话行是否用正确的寻址方式导航。

跑宿主半测试（交接的层级矩阵、继承事实、工作区归属、闸门、交接文件）：

```sh
node test/handoff.test.js
```

它们用 `node:test` 与纯服务 mock——不创建真实会话、不加载任何 `@deepseek-ai/*` 包；文件写到一次性临时目录。

检查随包 Skill 的打包正确性（frontmatter 可解析、`package.json.files` 会发布它、bundle patch 把 filesystem Skill provider 挂到该目录）：

```sh
node test/skills.test.cjs
```

按 DSH 安装 bundle 时实际执行的规则自检清单（patch 文件存在且可解析、`exports["./client"]` 与 `dsh.client.platform`、客户端模块 id 与包名一致、图标大小、locale 文件、以及声明了哪些 DSH peer）：

```sh
node scripts/verify-bundle.mjs
```

## 许可证

[MIT](LICENSE) © orphiczhou

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 而做。DSH、Cordis 以及自带的 `@deepseek-ai/dsh-*` 包均为各自作者的作品；本 bundle 只是占用了一个客户端席位、注册了两个宿主工具。
