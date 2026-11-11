---
name: session-handoff
description: '会话自交接：长任务推进到接近上下文上限（上下文约 50%）时，先 session_handoff {action:"status"} 读真实占用与继承事实，再 session_handoff {action:"handoff"} 把任务/进度/下一步写进 HANDOFF-<id>-<时间>.md 并启动同层级接替会话（继承同工作区、同 Agent 预设/工作模式、同权限模式、同模型与思考等级），新会话读交接文件继续干；不是总结心得，是交棒。也用于「继续干」「快到上限了」「上下文 50%」「交接给新会话」「长任务接力」「让新会话接着干」「handoff」等请求。English triggers: continue, keep going, running out of context, running low on context, hand off to a fresh session, new session, around 50 percent, handoff.'
whenToUse: '用户说「继续干」「接着做」「快到上限了」「上下文 50% 了」「交接给新会话」「长任务接力」「让新会话接着干」「handoff」；一轮对话已经很长、读了很多大文件、工具输出堆满，你感觉上下文接近上限；一个任务必须跨多个会话完成；你即将停止但工作还没完；需要把当前结论/决策/下一步交给后继会话而不是让它重新摸索；任何层级会话（根会话 / tree 指挥官 / worker / 普通子会话）在上下文达到 50% 时。English speakers may say: continue, keep going, running out of context, running low on context, hand off to a fresh session, new session, around 50 percent, handoff.'
---

# 会话自交接（Session Handoff）

> 上下文有硬上限。交接 = 把这轮工作写成一个**可验证的文件** + 启动**同层级**新会话，让它读文件接着干。
> 交接不是写感想，是交棒：结论、文件、下一步、坑，都要能直接被下一个人执行。

工具：`session_handoff`（会话树包 `@orphiczhou/dsh-session-tree`，与 `tree_send` 同 bundle）。两种 action：`status`（只读）/ `handoff`（写文件、起接替会话）。

## 0. 三条硬规则（先记）

1. **先 status，再 handoff**。不知道 `context_pct` 就不交接；`status` 是唯一权威读数（不要自己猜百分比）。
2. **`context_pct >= 50` → 必须交接**（缺省阈值 50；等价参数 `threshold_pct:50`）。低于 50 会被工具拒绝；只有用户明确说「现在就交接」才用 `force:true`。
3. **交接成功 ≠ 只看到 `handed-off`**。还要验收：接替会话真的读到了 HANDOFF 文件并继续；继承事实（工作区/预设/权限/模型）没有降级。

## 1. 什么时候检查

- 新接一个长任务 / 被派发到长任务，先 `status` 存个基线。
- 每完成一个里程碑、每次大段工具输出之后，再 `status`。
- 用户说「继续干」「接着做」「快到上限了」「上下文 50% 了」「交接给新会话」「让新会话接着干」。
- 你自己感觉：对话很长、读过很多大文件、历史工具输出堆满 → 用 `status` 确认，别猜。
- 长任务若还有 tree-engine 的竹节接力（worker 自报 pct≥42），本技能是会话层的兜底机制（见 §8）。

## 2. 第一步：status（完整命令样例）

```json
{ "action": "status" }
```

返回是**一行文本**（模型面渲染，≤400 字符截断；完整对象见工具返回值）。样例（随宿主版本可能变化，别把整行格式当契约）：

```
session_handoff status: context=18.7% (threshold 50%) pressure=186666/1000000 model=opencode-go/deepseek-v4.1-flash effort=max preset=standard permission=danger-full-access/danger-full-access/never successor=sibling next=continue
```

逐段读法：

| 片段 | 含义 | 怎么用 |
|---|---|---|
| `context=NN.N%` | 上下文占用 | **≥50 必须交接**；`unavailable` 表示服务给不出测量（不是 0） |
| `(threshold 50%)` | 当前阈值 | 可用 `threshold_pct` 参数改；改高了等于更晚交接 |
| `pressure=已用/窗口` | token 绝对值 | 判断真实余量 |
| `model=provider/model` | 当前模型 | 接替会话继承它 |
| `effort=...` | 思考等级 | 接替会话继承它 |
| `preset=...` | Agent 预设（工作模式，决定工具集） | 接替会话继承它 |
| `permission=preset/sandbox/approval` | 权限模式（沙箱+审批） | 接替会话继承它 |
| `successor=sibling\|root\|unavailable` | 缺省接替层级 | 交接前确认路线（见 §4） |
| `next=continue\|handoff` | 工具建议 | 与 50% 规则一致；`unavailable` 时它只能给 continue |

说明：

- `unavailable` 是**诚实缺省**，不是 0：新会话/首轮还没积累 usage 事件时 `context_pct` 可能 missing。此时阈值守卫无法评估，`handoff` 会带 `warnings` 继续——不要把它当 0 继续猛干，按会话长度估计并在下个里程碑再查。
- 想看更细的机器字段（`pressure_tokens` / `context_window` / `cwd` / `session_id` / `parent_session` / `workspace` / `notes`）时以工具返回对象为准；模型面只渲染上面那一行。

## 3. 第二步：handoff（完整命令样例）

```json
{
  "action": "handoff",
  "summary": "我在给订单服务补「退款重试」：重试状态机与单测已完成，集成测试还差支付网关的 mock；没有未决的设计问题。",
  "next_steps": [
    "先读 HANDOFF 文件确认现状，再跑一遍现有单测确认基线",
    "补 tests/integration/refund-retry.test.ts 的支付网关 mock 分支",
    "跑全量测试并汇报结果；不要重写已经通过的模块"
  ],
  "files": [
    "src/refund/retry.ts",
    "tests/unit/refund-retry.test.ts"
  ],
  "open_questions": ["支付网关超时是否要计入重试次数？"],
  "note": "只改上述两个模块与新增测试，不动发布配置。"
}
```

> 路径是示例——换成你自己的。`summary` 必填非空，其余建议尽量填：`files` / `next_steps` 就是接替会话的地图。

### 参数规范

| 参数 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | `status` / `handoff` |
| `summary` | handoff 必填 | 一段话：**任务是什么、现在做到哪、还差什么**。写结论不写过程 |
| `next_steps` | 建议 | 有序数组；第 1 条是接替会话开工第一件事；命令/路径写全，不要写「继续推进」 |
| `files` | 建议 | 本会话创建/修改的文件 + 状态（新建/修改/已提交/未提交）；只读参考也可列出 |
| `open_questions` | 建议 | 只留**会改变判断**的未知；不要凑数 |
| `note` | 建议 | 决策与约束：为什么这样选、哪些不要重做/不要碰 |
| `kind` | 可选 | `auto`（缺省）/ `root` / `sibling`，见 §4 |
| `spawn` | 可选 | 缺省 `true`；`false` = 只写文件不起接替会话（宿主 API 故障或用户只要文件时用） |
| `threshold_pct` | 可选 | 0–100，缺省 50 |
| `force` | 可选 | 同时绕过阈值守卫与 5 分钟防重复；**只在用户明确要求时** |

## 4. 层级矩阵（root vs sibling）

缺省 `kind:"auto"`：

| 当前会话 | 接替方式 | 结果层级 |
|---|---|---|
| 根会话（无 parent） | 新根会话 | 同层；被挂进**同一侧栏工作区** |
| 子会话且父会话活着 | 同父兄弟 | 同层；出现在父会话下 |
| 子会话但父会话不活 | 根级 + `degraded=parent-inactive` | **降级**（如实标注，不假装同层） |
| 子会话且 subagents 服务不可用 | 根级 + `degraded=subagents-unavailable` | 降级 |
| 任何会话但 agents 服务缺失 | 只写文件 + `spawn_error` | 没有接替会话 |

强制层级：

- `kind:"root"`：即使在子会话里也强制建根级（不标 degraded）。
- `kind:"sibling"`：请求兄弟；父不活 → 降级根级 + `degraded=parent-inactive`；根会话请求 `sibling` → 回退根级（根本身即同层，不标降级）。

`degraded` 是事实不是失败：接替会话仍可用，但不再与你是同一父层级——在树任务里这会改变协调方式（见 §8）。

## 5. 继承事实与验收（交接完必须查）

接替会话应继承：

- 工作目录 `cwd`；
- 侧栏工作区归属（root/degraded 路径）；
- Agent 预设（工作模式 → 工具集）；
- 权限模式（permission preset：sandbox + approval）；
- 模型 `provider/model`；
- 思考等级 `reasoningEffort`；
- `maxTokens`（**只在 handoff 成功返回对象的 `successor.max_tokens` 里可见**；`status` 行不报它）。
- **接替提示语语言 = DSH 界面语言**（Settings → General → Language，`locale.preference`）：`zh` 时首条消息是「你是 <源会话> 的接替会话……请先读取交接文件：<绝对路径>」，`en` 时是 "You are the successor session … First read the handoff file at: <path>"；其它语言回退英文。`status`/`handoff` 渲染行尾带 `lang=zh|en`，返回对象的 `interface_language` 同值——这就是核对接替语种的直接证据，不必去猜。

验收三步：

1. **看交接返回行**（示意，字段以实际渲染为准）：
   ```
   session_handoff: wrote <cwd>\HANDOFF-<短id>-<yyyyMMdd-HHmmss>.md; successor <id> kind=root preset=<预设> workspace=<工作区id> inherited=session-route
   ```
   - `status` 行的 `preset=` / `permission=` 应为真实值（不是 `unavailable`）；
   - root 路径应出现 `workspace=`（宿主装配了 workspaceRegistry 时）；出现 `degraded=` 说明层级降级；
   - `inherited=session-route` = 模型/effort 来自本会话；`inherited=provider-default` = 原会话读不到模型配置，新会话用了部署默认（要告知用户，不能当成继承成功）。
2. **看接替会话首轮**：它收到的首条消息必含交接文件的**绝对路径**，措辞随界面语言（中文「请先读取交接文件：<路径>」/ 英文「First read the handoff file at: <路径>」，见 §5 首条语言说明）。打开/轮询该会话，确认它**真的读了这个文件**并开始推进，而不是只回一句 READY/OK。若它没有读文件能力或没读——说明预设/权限继承不完整，按 §6 处理。
3. **查结构化失败字段**：工具返回对象里还有 `warnings[]`、`successor.preset_error` / `permission_error` / `working_directory_error`、`successor.workspace.reason`。模型面渲染行是精简版，**不一定显示这些**；因此看到以下任一情况都按「继承不完整」处理并向用户报告：
   - `preset=unavailable` 或 `permission=unavailable`；
   - root 路径没有 `workspace=`；
   - 虚线 `degraded=...`；
   - 接替会话首轮没有读文件动作。

## 6. 失败与降级处理（逐项对照）

| 返回 / 现象 | 含义 | 动作 |
|---|---|---|
| `status=rejected`，`reason=below-threshold` | 还没到阈值 | 继续干活；只有用户明确要求才 `force:true` |
| `status=rejected`，`reason=recent-handoff` | 同一会话 5 分钟内已交接过 | 用上次 `handoff_path`；不要反复刷交接 |
| `spawn_error` | 文件已写成功，但接替会话没起来 | 文件仍在；把绝对路径交给用户 / 手动新开会话并让新会话先读它；常见根因是 agents/subagents 服务不可用。**注意**：文件写成功即计入 5 分钟防重复，立即重试会被 `recent-handoff` 拒——需等 5 分钟或用户明确要求时 `force:true`；重试前先排除服务问题 |
| `degraded=parent-inactive` | 父会话已不在，降级根级 | 可用但不同层；树任务要向 commander/上级报告（§8） |
| `warnings[]` / `preset_error` / `permission_error` / `working_directory_error` / `workspace.reason` | 非致命继承失败 | **必须查**：工具集可能变窄、权限不同、侧栏未分组；向用户报告，必要时重新交接 |
| 工具整体报错（文件写失败） | 没写文件、没起会话 | 检查会话 cwd 是否可写；修正后重试 |
| `unknown tool` / 找不到 `session_handoff` | 会话树 bundle 未启用 | 不要编造调用、不要自行改 profile；告诉用户检查 `@orphiczhou/dsh-session-tree` bundle |

另外两条纪律：

- **交接成功后你这层会话让位**：不要一边交接一边继续开新步骤（会和接替会话重复干活）。先把结论写进文件，然后停止新增工作。
- 交接文件是运行时产物（`HANDOFF-*.md`，本项目 `.gitignore` 已忽略）。需要长期留存的结论整理进 `docs/` 或 `agent.md`，不要只留在交接文件里。

## 7. 交接文件写作要求（写成可执行的地图）

工具会按固定模板生成文件：`Task`（summary）→ `Current status`（会话/父/工作区/文件路径/上下文/模型/预设/权限，自动填）→ `Decisions`（note）→ `Changed files`（files）→ `Next steps`（next_steps 编号列表）→ `Open questions` → `Original session` → `Successor instructions`。

写作纪律：

1. **结论要可验证**：写「已跑 `node test/handoff.test.js` → 34/34 通过」，不要写「测试应该没问题」。
2. **下一步有序可执行**：第 1 条就是接班第一件事；命令、路径、工作目录写全。
3. **不要重做已完成工作**：明确列出已完成项和「不要重做」。
4. **files 写状态**：新建 / 修改 / 未提交 / 已提交要区分。
5. **关键产物必须落盘**：结论不要只写在 summary 里——落进文件或 files 引用的产物；交接文件本身可能被清理。
6. `open_questions` 只留会改变判断的未知；`note` 写决策与约束（为什么这样选、哪些不要碰），不是流水账。

## 8. 全层级纪律（重要）

**每一层会话都必须会做这件事**，交接不是根会话专属：

| 层级 | 谁 | 交接后 |
|---|---|---|
| 根会话 | 用户主会话 | 新根会话接替，同一侧栏工作区 |
| 指挥官（tree commander） | 树节点会话 | 兄弟接替；tree-engine 的 leaf owner 仍是旧会话，需要按 tree-commander SKILL 的协调规则上报，由 commander 用 `tree_node {action:"set-session"}` 重绑（见 tree-worker SKILL §4.3） |
| worker（tree worker） | 树节点执行会话 | 同上；且 tree-engine 还有竹节接力（pct≥42 自报 → 引擎换会话），**先按竹节，50% 仍未等到接力再自主交接**（见 tree-worker SKILL） |
| 普通子会话 | subagent / teammate | 同父兄弟接替，父会话可见 |

- **不需要上级批准**：`context_pct >= 50` 就是授权。
- 交接一次就够，不要连环交接（5 分钟防重复会拦住；`force` 不能解决「该继续干活」的问题）。
- `session_handoff` **不会**自动迁移 tree-engine 的 leaf owner（leaf owner 是会话 id）——树任务里的交接协调规则见 tree-commander / tree-worker SKILL。**注意**：`tree-commander` / `tree-worker` 由另一个包 `@local/dsh-tree-engine` 提供，不随本插件包发布；完整说明见源码仓 `dsh-tree-harness` 的 `docs/skills-usage.md`（https://github.com/orphiczhou/dsh-tree-harness/blob/master/docs/skills-usage.md）。

## 9. 最小自检清单

- [ ] 已 `status` 读到真实 `context_pct`（不是猜的）
- [ ] `context_pct >= 50`（或用户明确要求），否则继续干活
- [ ] `summary` 一段话说清任务 / 进度 / 剩余
- [ ] `next_steps` 有序可执行，第一条是接班第一件事
- [ ] `files` 列出已改文件 + 状态
- [ ] `open_questions` 只留关键未知；`note` 写了决策/约束
- [ ] 返回 `handed-off` 且 `handoff_path` 文件存在
- [ ] 继承验收：`preset=` / `permission=`（root 还有 `workspace=`）；首轮真的读了 HANDOFF 文件
- [ ] 有 `warnings` / `degraded` / `spawn_error` 时已向用户报告
- [ ] 交接后已停止新步骤，让接替会话继续

## 10. 一图流

```
长任务 / 用户说继续干 / 感觉快满
  → session_handoff {action:"status"}          ← 唯一权威 pct
  → context_pct >= 50 ?
      否 → 继续干活（下个里程碑再查）
      是 → 写 summary / next_steps / files / open_questions / note
           → session_handoff {action:"handoff"}（kind 缺省 auto）
           → 文件写出 + 同层级接替会话启动
           → 验收：preset= / permission= / workspace=、首轮读 HANDOFF、warnings
           → 停止新步骤，交棒
```
