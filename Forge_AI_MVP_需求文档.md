# Forge AI —— MVP 需求文档

版本：MVP-0.1
读者：本文档的读者是一个**没有任何项目上下文的开发 Agent**。
写作原则：本文档自包含。你不需要、也不应该去参考仓库里任何已有的代码、计划或其他文档——那些是上一轮失败的产物，可能会误导你。请只以本文档为准。

---

## 第 0 部分：怎么读这份文档

这份文档分两大块：

- **第一块（第 1–5 章）讲"为什么"**：这个项目要解决什么真实问题，我们为什么把 MVP 收敛成现在这个样子，每一个功能是从哪个具体问题推导出来的。你必须先理解这部分，否则你会在实现时做出看似合理、实则违背核心目标的决策。
- **第二块（第 6–14 章）讲"做什么"**：MVP 的确切范围、数据模型、工具接口、验收标准、构建顺序。这部分是你实际动手的依据。

请完整读完第一块再开始设计。这个项目最容易犯的错误不是写错代码，而是**误解了目标，把力气花在错误的地方**。

---

## 第 1 部分：这个项目是什么

### 1.1 一句话描述

Forge AI 是一个**让多个 AI Agent 协作完成一次内容生产任务的运行平台**。它的核心不是"生成内容的模型有多强"，而是**在多个 Agent 之间搭一个可靠的中间层，让它们能安全地交接工作成果，并且让系统始终清楚地知道"现在生产到什么程度了、哪些成果是有效的、还有什么问题没解决"**。

### 1.2 一个具体的例子（先建立直觉）

想象一个内容生产任务：写一首符合特定要求的歌词。参与的不是一个模型，而是一个"AI 团队"：

- **总控 Agent**：理解用户要什么，把任务派给生成 Agent，收到审核意见后决定怎么返修，最后决定能不能交付。
- **生成 Agent**：真正写歌词的人。写初稿，收到返修意见后改。
- **审核 Agent**：独立审查歌词，指出具体问题（比如"第 4 行词序不自然"）。

一次典型的运行是这样的：

```
用户输入
  → 总控把任务给生成 Agent
  → 生成 Agent 写出歌词 v1
  → 审核 Agent 审查，发现第 4 行有问题
  → 总控收到问题，发出"只改第 4 行、其他冻结"的返修指令
  → 生成 Agent 改出歌词 v2
  → 审核 Agent 重新审查，通过
  → 总控申请交付
  → 系统核对一切无误，正式交付
```

Forge AI 就是承载这整个过程的平台。**注意：歌词只是一个例子。** 换成"营销文案 + 质检"、"研究报告 + 交叉审核"，参与的 Agent 数量、角色、提示词都不一样，但这套"生产—审核—返修—交付"的协作骨架是相同的。平台要做的是承载这个骨架，而不是写死"歌词"这件事。

### 1.3 术语表（先记住这几个词）

| 术语 | 含义 |
|---|---|
| **Case** | 一次完整的生产任务。上面那个歌词例子从头到尾就是一个 Case。 |
| **Agent** | 团队里的一个角色（总控/生成/审核）。它背后是一次 AI 模型调用。 |
| **Turn** | 一个 Agent 的一次完整调用（输入 → 思考 → 输出）。 |
| **Message** | Agent 之间、或系统与 Agent 之间传递的一条消息。 |
| **Artifact（产物）** | 生产出来的业务成果，比如"歌词"。产物会有多个版本（v1、v2……）。 |
| **Issue（问题）** | 审核发现的一个具体问题，有自己的生命周期（提出 → 修复 → 验证关闭）。 |
| **中间层 / Middleware** | 平台本身。它坐在 Agent 之间，负责消息传递、格式处理、状态记录、持久化。 |
| **场景模板 / 配置** | 一份配置文件，定义"这个 Case 有哪些 Agent、各自什么职责、怎么协作"。 |
| **Pi** | 我们用来实际调用 AI 模型的底座（Agent Runtime）。你不需要重新实现它，直接调用即可。 |

---

## 第 2 部分：这个项目要解决的真实问题

在做这个平台之前，已经存在一个能跑的"歌词生产系统"。它证明了"生成 Agent + 审核 Agent + 返修闭环"这套东西是可行的。但它有一批严重的问题，正是这些问题定义了 Forge AI 要解决什么。**下面每一个问题，后面都会对应到一个 MVP 功能。请记住它们的编号。**

**问题 P1：模型的注意力被工程格式消耗掉了。**
旧系统为了让内容在 Agent 之间流转，要求模型输出大量结构化的中间数据（JSON、字段、版本号、路由信息等）。结果是模型明明已经写出了可用的内容，却因为附带的 JSON 格式不对而无法流转；模型花在"拼格式"上的注意力，本该花在"内容本身"上。

**问题 P2：产物状态是一团糨糊。**
一次复杂生产里有输入、大纲、正文、审核意见、成品等多种成果，每种还有多个版本。旧系统只有一个模糊的"当前内容"概念，根本表达不清楚"现在到底有哪些成果、哪个版本是有效的、每一轮 Agent 到底改了什么"。Agent 接手工作时，看不清现状。

**问题 P3：审核意见只是聊天记录里的一句话。**
审核 Agent 说"第 4 行有问题"，这句话就飘在对话里。它没有一个稳定的 ID，没有绑定"是哪一版产物的问题"，没有记录"后来改了没有、验证了没有"。于是没人能可靠地回答"这个问题到底解决了吗"。

**问题 P4：谁都可以说"没问题了"，但没人核实。**
旧系统里，Agent 说"审核通过"或"已修复"，系统就信了。但 Agent 可能审漏了、可能返修时改错了地方、可能修好一个问题又引入新问题。**系统本身没有独立的核实能力**，最终"交付"只是某个 Agent 的一句话，不可信。

**问题 P5：返修会越界。**
让生成 Agent"只改第 4 行"，它可能顺手把第 8 行也改了，把本来审核通过的内容改坏。旧系统拦不住这种越界。

**问题 P6：整个系统对人是黑箱。**
业务人员想知道系统跑到哪了，只能找开发人员看日志、查数据库。业务人员无法自己观察、无法自己判断、离不开开发人员。

**问题 P7：一切都写死在代码里。**
Agent 的数量、角色名、提示词、协作关系全部硬编码。想做一个新的生产场景（比如从歌词换成文案），就得改代码。业务人员不可能自己配置一个新场景。

**问题 P8：崩溃就前功尽弃。**
进程中途挂掉，重启后不知道跑到哪了，容易把已经完成的、花了真实 Token 的工作重新做一遍。

---

## 第 3 部分：核心需求（从问题推导出来的机制）

把上面 8 个问题归拢，会浮现出四根支柱。**这四根支柱就是 Forge AI 的核心需求，MVP 的每一个功能都必须服务于其中至少一根。**

### 支柱一：中间层接管工程，模型只管内容（解决 P1）

模型（Agent）应该只负责：理解任务、生成内容、审核内容、指出问题、完成返修、做业务判断。

模型**不应该**负责：生成任何 ID、维护版本号、写时间戳、拼路由信息、拼大段传输用的 JSON、控制状态机、处理重试和恢复。

这些工程性的活儿，全部由中间层（平台）承担。Agent 通过极少数几个"工具"来表达它想做的动作，工具的参数只保留最必要的字段，剩下的一切由系统补齐。

> 推导：这是 P1 的直接解药。如果 MVP 里你发现自己在让模型输出 case_id、version 之类的东西，就是走错了方向。

### 支柱二：产物与问题是"第一等对象"，系统独立掌握真相（解决 P2、P3、P4）

平台要同时维护两套状态，共享同一批底层数据：

1. **对话状态**：回答"发生了什么"——谁给谁发了什么消息。
2. **生产状态**：回答"现在什么是有效的"——有哪些产物、哪个版本有效、还有哪些问题没关。

关键点，也是这个项目最容易被低估的一点：**产物和问题系统不只是"给 Agent 看的上下文"，它更是"系统用来独立核实结果"的依据。**

- 产物用追加版本记录，永不覆盖历史。每一版都能追溯到是哪个 Turn、由哪条消息产生的。（解决 P2）
- 每一条审核意见都登记成一个独立的 **Issue**，有稳定 ID、绑定具体产物版本、带证据、有自己的状态机。（解决 P3）
- **交付不是任何 Agent 说了算，是系统说了算。** 只有当系统亲自核对过"产物有效、所有阻断问题都已 `verified`（验证关闭，而不是仅仅'声称修复'）"，Case 才能进入已交付状态。（解决 P4）

> 推导：P4 是这个项目和"旧系统 + 好看的 UI"之间的本质区别。如果去掉系统的独立核实能力，即使界面做得再漂亮，交付依然不可信。所以 Issue 的状态机和交付门禁是 MVP 不可省略的灵魂，哪怕其他产物功能可以做得很薄。

### 支柱三：受控返修（解决 P5）

返修时必须明确"哪些部分可以改（editable）、哪些部分冻结（frozen）"。系统在返修后自动比对改动，**越界修改的版本不允许进入复审**。

> 推导：这是 P5 的直接解药，也是支柱二"信任"的一部分——不受控的返修会破坏已通过的内容，让"审核通过"这件事失去意义。

### 支柱四：配置驱动，不写死任何业务（解决 P7）

Agent 的数量、角色、职责、提示词、协作关系、产物类型，全部来自一份**场景配置**，而不是代码里的分支。平台代码里**绝对不允许**出现 `if role == "生成"`、`if 场景 == "歌词"` 这种东西。想加一个新场景，只需要写一份新配置，不改一行平台代码。

> 推导：这是 P7 的直接解药。它有一条铁律（见第 5 章），违反了整个平台就退化回旧系统。

### 关于 P6（可观察）和 P8（崩溃恢复）

- **P6（黑箱）** 由一个只读的回放界面解决：业务人员打开就能看到整个协作过程。但注意它的定位——它是给**人**看的，不是核心机制。核心机制是前四根支柱。
- **P8（崩溃恢复）** 由"每个 Turn 都立即持久化"来解决：进程随时可能挂，但重启后必须能从最后一个完成的 Turn 继续，绝不重跑已完成的内容。

---

## 第 4 部分：为什么 MVP 是现在这个范围（收敛过程）

完整的产品设想非常庞大（配置可视化编辑器、产物依赖图与级联失效、多审核仲裁、预算熔断、批量生产、实时泳道动画等等）。但 MVP 的目标**不是把完整产品做小一号**，而是：

> **用最小的投入，验证"支柱一 + 支柱二"这套机制到底成不成立——即：当中间层接管了所有工程格式、并维护起可信的产物/问题状态后，AI Agent 能不能稳定地跑通一次带返修的完整生产闭环。**

围绕这个验证目标，我们做了如下取舍。**理解取舍的理由，比记住取舍的结论更重要**，因为你在实现时会遇到无数"要不要顺手多做一点"的诱惑。

### 4.1 保留的，和为什么保留

| 功能 | 为什么必须在 MVP | 服务哪根支柱 |
|---|---|---|
| 4 个最小工具 | 这是支柱一的物理体现。没有它，模型就得自己拼 JSON。 | 一 |
| Case 级配置快照冻结 | 成本极低（存个 JSON），但它是"状态不漂移"的地基。 | 四 |
| 产物追加版本 + 行级 Diff | 支柱二的一半。没有版本，就说不清"改了什么"。 | 二 |
| Issue 完整状态机 + 交付门禁 | 支柱二的灵魂（解决 P4）。这是本项目区别于旧系统的本质。 | 二 |
| 行级冻结范围校验 | 支柱三。行级比对只是几十行代码，但验证了"受控返修"这个核心概念。 | 三 |
| 上下文快照 + 哈希 | 成本低（一张表 + 一个 hash），换来完整可审计和可复现。 | 二 |
| Turn 级持久化 + 崩溃恢复 | 解决 P8。且它是"信任"的一部分——不能因为崩溃就重跑烧钱。 | 二 |
| YAML 配置 + 零代码第二场景 | 支柱四。第二个场景存在的唯一目的就是**证伪"平台偷偷写死了业务"**。 | 四 |
| 只读回放页 | 解决 P6。但刻意做到最薄。 | （辅助） |

### 4.2 砍掉/推迟的，和为什么可以砍

| 推迟的功能 | 为什么 MVP 不需要它 |
|---|---|
| 可视化配置编辑器 | YAML 已经能定义场景。配置 UI 是"好用"，不是"能不能成立"。验证机制不需要它。 |
| 产物依赖 DAG + 级联失效 | MVP 首个验证场景（歌词类）是单产物，依赖图是退化的（线性父子），做了完整 DAG 也测不到效果。留到有多产物场景（如短故事）时再做。 |
| 多审核仲裁 | MVP 用单审核就能跑通闭环。多审核冲突处理是叠加复杂度，不影响机制验证。 |
| 段落/句子/JSON 级 Diff 锚点 | 行级 Diff 已足够验证"受控返修"概念。其他粒度是精度问题，不是有无问题。 |
| 预算熔断、分叉对照运行 | 属于运行保护和高级调试。机制成立后再加。 |
| 批量生产 | MVP 只需单 Case 跑通。批量是规模问题。 |
| 实时 SSE 泳道 + 跨泳道连线动画 | 只读 + 轮询刷新就能让人看懂过程。实时推送和连线绘制是前端重投入，与机制验证无关。 |
| 短故事等多产物重模板 | MVP 用"三 Agent 单产物"验证机制，用"两 Agent 轻场景"验证配置化。多产物重模板留到下一阶段。 |

### 4.3 一条重要的原则：肉可以少，骨架必须对

MVP 允许代码量很小、功能很薄，但**有一件"重"的事不能省：架构的形状**（见第 5 章）。原因很实际：MVP 之后要加的所有东西（依赖图、配置 UI、批量），都是在现有骨架上扩展。如果 MVP 把"调用模型"、"判断路由"、"写数据库"全搅在一起，下一阶段等于重写。

---

## 第 5 部分：不可违反的铁律

无论如何都不能违反下面几条。违反其中任何一条，都意味着这一轮又变成失败品。

### 铁律 1：不把任何业务写死进平台

- 平台代码里不允许出现 `总控`、`生成`、`审核`、`歌词`、`山歌` 这类业务名词作为枚举值或条件分支。
- 平台不允许假设"一定有 3 个 Agent"或"审核不通过就打回最后一个 Agent"。这些都来自配置。
- 判断标准：**只写一份新的 YAML、不改任何平台代码，就能跑起一个 Agent 数量和角色都不同的新场景。** 这是 MVP 验收硬指标（见第 12.3）。

### 铁律 2：模型不碰工程数据

- 模型的输出里不应包含 case_id、session_id、version、时间戳、路由边、数据库字段。
- 这些一律由系统在处理工具调用时补齐。
- 如果发现你在设计一个需要模型返回版本号的工具，停下来，重新设计。

### 铁律 3：交付是系统的决定，不是 Agent 的声明

- Agent 调用"申请交付"工具，**不等于**交付成功。
- 系统必须独立核对：产物有效、所有阻断级 Issue 状态为 `verified`、没有运行中的返修、没有未完成的 Turn。全部通过才进入已交付状态。
- `claimed_fixed`（声称已修复）**绝对不能**当作 Issue 关闭。只有 `verified`（经复审验证）才算关闭。

### 铁律 4：一切追加，绝不覆盖

- 产物新版本追加，不覆盖旧版本。
- Issue 的状态变化以事件追加记录，不覆盖原始审核意见。
- 崩溃恢复不允许覆盖任何已经成功持久化的结果。

### 铁律 5：架构依赖只能单向

代码分层，依赖只能从左指向右，不能反向：

```
contracts  →  domain  →  application  →  adapters  →  apps
```

- `contracts`：纯数据契约/类型定义，不依赖任何东西。
- `domain`：核心业务规则（产物状态机、Issue 状态机、交付门禁判断、冻结范围校验逻辑）。**绝不允许**依赖数据库、Pi、Web 框架、进程环境。domain 必须能在纯内存里被单元测试。
- `application`：编排流程。它通过"端口"（接口）去调用 Pi、数据库、时钟、ID 生成、事件发布，自己不直接碰这些实现。
- `adapters`：实现上面那些端口（真正连 SQLite、真正连 Pi）。adapter 里**不允许**出现业务角色名的分支。
- `apps`：可执行入口。有两个：`worker`（跑 Agent 的后台进程）和 `web`（只读回放界面）。

补充两条：
- **只有 `worker` 允许启动/恢复 Pi Session。** `web` 绝不直接调用 Pi。
- **所有外部输入（Pi 的返回、配置文件、HTTP 请求）必须在边界处解析成契约类型**，内部不允许凭猜测读取任意 JSON 形状。

### 铁律 6：不泄密

API Key、Token、Authorization Header、模型的隐藏思维链，绝不能进入日志、数据库业务表、或返回给前端。前端只显示模型的最终文本和工具调用。

---

## 第 6 部分：MVP 技术形态

- **进程模型**：单进程 Worker（跑 Agent）+ 一个只读 Web 服务（看回放）。不引入消息队列中间件——消息总线用进程内的函数调用 + 数据库里的追加事件表实现即可。
- **存储**：SQLite。所有状态都在这里。
- **AI 底座**：Pi。直接调用，不重新实现模型调用循环。
- **Fake Pi**：必须提供一个假的 Pi 实现，行为可预测、不消耗真实 Token，供自动化测试和全链路联调使用（见第 13 章构建顺序）。
- **Session 策略**：MVP 只需支持两种：
  - `persistent`：同一个 Agent 在整个 Case 里复用同一个 Session（生成 Agent 用它，这样返修时能继承之前的创作上下文）。
  - `cold_per_version`：每处理一个新产物版本就开一个全新的冷 Session（审核 Agent 用它，这样每次审核都是独立的，不受上一版审核结论影响）。

---

## 第 7 部分：场景配置（YAML）

一个 Case 启动时，加载一份场景配置，并把它**完整快照**存进这个 Case（铁律：Case 运行中永远用启动时的快照，配置文件后来改了也不影响已在跑的 Case）。

配置至少要能表达：

```yaml
scenario:
  id: songwriting
  name: 歌词生产
  version: 1

input_fields:              # 这个场景需要用户输入什么
  - key: reference_lyrics
    label: 参考歌词
  - key: fixed_phrase
    label: 固定金句

agents:                    # 有哪些 Agent，各自什么配置
  - key: supervisor        # 注意：key 是配置里的名字，平台代码不许对它做分支判断
    name: 总控
    model: <模型标识>
    session: { policy: persistent }
    prompt: prompts/supervisor.md
    skills: []
    tools: [route_message, approve_delivery, request_human_input]

  - key: generator
    name: 生成
    model: <模型标识>
    session: { policy: persistent }
    prompt: prompts/generator.md
    skills: [content-compose, content-revise]
    tools: [publish_artifact, request_human_input]

  - key: reviewer
    name: 审核
    model: <模型标识>
    session: { policy: cold_per_version }
    prompt: prompts/reviewer.md
    skills: [content-review]
    tools: [submit_evaluation]

start_agent: supervisor    # Case 启动时先激活谁

routes:                    # 谁被允许把消息发给谁（只限定"允许关系"，不规定固定顺序）
  - from: supervisor
    to: [generator]
  - from: generator
    to: [reviewer]         # 产物发布后流向审核
  - from: reviewer
    to: [supervisor]       # 审核结论回到总控

context_rules:             # 每条路由发送时，允许把哪些内容放进目标 Agent 的上下文
  to_reviewer:
    include: [current_artifact_version, input_constraints]
  to_generator_repair:
    include: [current_artifact_version, target_issues, revision_scope]

artifact_types:            # 这个场景会产出哪些类型的产物
  - type: lyrics
    diff: line             # 用行级 Diff

delivery:
  deliverable_artifact_type: lyrics   # 最终交付物是哪种产物
```

第二个验收场景（见第 12.3）就是**另写一份这样的 YAML**——比如两个 Agent（文案生成 + 质检），完全不同的 key、提示词、路由——不改任何平台代码就能跑。

---

## 第 8 部分：Agent 工具接口（支柱一的落地）

只做这 4 个 + 1 个降级处理。工具由 Agent 调用、由系统执行。**参数只有最小必要字段，其余系统补齐。**

### 8.1 `publish_artifact` —— 发布/修订一个产物

Agent 提供：
```json
{
  "artifact_type": "配置里注册的产物类型，如 lyrics",
  "content": "业务内容本身",
  "summary": "这一轮做了什么"
}
```
系统自动补齐：Case、Session、产物的逻辑身份、追加式版本号、创建时间、来源消息、父版本、与上一版的行级 Diff。

> 若信息有歧义无法判断该挂到哪个产物上，系统应拒绝并要求澄清，**绝不猜测**。

### 8.2 `submit_evaluation` —— 提交审核结论

Agent 提供：
```json
{
  "verdict": "approve | repair | regenerate | input_problem",
  "issues": [
    {
      "severity": "blocking | major | minor",
      "anchor": { "type": "line", "value": "4" },
      "problem": "第4行词序不自然",
      "evidence": "普通中文需要调整词序才成立"
    }
  ],
  "summary": "整体结论"
}
```
系统自动：把结论绑定到"本次被请求审核的那个明确产物版本"，为每个 issue 生成稳定 ID 并纳入状态机。

> 铁律：审核 approve 只对"被请求审核的那一版"生效。产生新版本后，旧版的 approve 不自动继承。

### 8.3 `route_message` —— 总控把任务/返修派给某个 Agent

Agent 提供：
```json
{
  "target_agent": "配置里的 agent key",
  "instruction": "只修改第4行",
  "scope": {
    "editable_anchors": ["line:4"],
    "frozen_anchors": ["line:1-3", "line:5-16"],
    "issue_ids": ["issue_xxx"]
  },
  "reason": "审核发现第4行词序不自然"
}
```
当这条消息用于返修时，系统把它固化成一条 **Revision Instruction** 记录（目标产物版本、目标 issue、可改范围、冻结范围）。返修完成后系统据此做行级越界校验。

### 8.4 `approve_delivery` —— 总控申请交付

Agent 提供：
```json
{ "artifact_version": "要交付的产物版本", "summary": "审核通过，可交付" }
```
**这只是申请。** 系统随后独立执行交付门禁核对（见第 10 章）。核对不通过就拒绝，Case 不进入已交付。

### 8.5 `request_human_input` —— 请求人工

出现无法自动判断的情况时调用。MVP 里的实现可以很简单：**让 Case 进入 `waiting_human` 状态并停下来**，不需要做真正的人机交互界面。

---

## 第 9 部分：数据模型（SQLite 表）

只列 MVP 需要的表和关键字段。所有表都遵循"追加、不覆盖"。

**cases**：case_id, title, status, current_stage, scenario_snapshot(整份配置快照 JSON), input_payload, created_at, updated_at, completed_at

**agent_sessions**：session_id, case_id, agent_key, session_policy(persistent|cold_per_version), scope_key, pi_session_ref, status(active|closed), opened_at, closed_at

**turns**：turn_id, case_id, session_id, sequence, status(queued|running|completed|failed), input_message_id, output_message_id, context_snapshot_id, produced_artifact_version_ids, started_at, finished_at, retry_of_turn_id, provider_error
> turns 是崩溃恢复的核心：开始前写 running，完成后立刻写 completed。恢复时扫描非 completed 的 turn。

**messages**：message_id, case_id, session_id, source_agent, target_agent, parent_message_id, message_type, content, artifact_version_refs, issue_refs, created_at

**route_edges**：route_id, case_id, source_message_id, target_message_id, source_agent, target_agent, reason, context_snapshot_id, created_at
> 这张表让回放页能画出"谁发给谁"。

**artifacts**：artifact_id, case_id, artifact_type, scope_key, current_valid_version_id, status, created_at
> 逻辑产物。多次修订进入下面的 versions 表。

**artifact_versions**：artifact_version_id, artifact_id, version, content, source_message_id, source_turn_id, parent_version_id, diff, content_hash, status(draft|under_review|approved|invalidated|superseded|delivered|rejected), approved_at, created_at

**evaluation_issues**：issue_id, case_id, artifact_version_id(被审的那一版), evaluation_message_id, severity(blocking|major|minor), anchor, problem, evidence, status(见 11 章), resolution_artifact_version_id(在哪一版被修), verified_by_evaluation_id(被哪次复审验证), created_at, updated_at, closed_at

**issue_events**：issue_event_id, issue_id, event_type, actor, message_id, detail, created_at
> Issue 的状态变化以事件追加记录，不覆盖。

**revision_instructions**：revision_instruction_id, case_id, target_agent, target_artifact_version_id, issue_ids, editable_anchors, frozen_anchors, status(见 11 章), source_message_id, created_at

**context_snapshots**：context_snapshot_id, case_id, session_id, turn_id, included_refs, rendered_context(实际发给 Pi 的完整上下文), context_hash, created_at
> 每次调用 Pi 前冻结一份，用于审计和复现。

**delivery_gate_results**：gate_result_id, case_id, artifact_version_id, status(pass|fail), checks(每项检查的结果), blocking_issue_ids, created_at

**tool_actions**：action_id, turn_id, tool_name, arguments, result, status, created_at

**control_events**：event_id, case_id, event_type, actor, detail, created_at
> 人工操作、恢复、停止等都记这里。

---

## 第 10 部分：交付门禁（支柱二的灵魂，务必实现正确）

当总控调用 `approve_delivery` 后，系统**必须独立**执行以下全部检查，任何一项不通过就拒绝交付，并把结果写入 `delivery_gate_results`：

1. 申请交付的产物版本存在且状态有效（不是 invalidated / superseded）。
2. 该产物所需的审核已通过（针对的是**这一版**，不是旧版继承来的 approve）。
3. **所有 `blocking` 级 Issue 的状态都是 `verified`。** 存在任何 `open`、`repairing`、`claimed_fixed`、`reopened` 的 blocking issue，一律拒绝。
4. 没有运行中的返修（revision_instruction 处于未完成状态）。
5. 没有未完成的 Turn（非 completed）。

全部通过，才把产物版本置为 `delivered`，Case 状态置为 `approved`，关闭所有 Session。

> 再次强调铁律 3：这一整章的存在，就是为了让"交付"这件事由系统独立负责，而不是相信任何 Agent 的一句话。

---

## 第 11 部分：状态机

### Case 状态
`created → running → (waiting_review | repairing | waiting_recovery | waiting_human) → approved`
异常：`stopped`、`failed`

### Turn 状态
`queued → running → completed`
异常：`failed`（可 `retry_of_turn_id` 指向被重试的 turn）

### Artifact Version 状态
`draft → under_review → approved → delivered`
其他：`invalidated`（被上游变更作废）、`superseded`（被新版本取代）、`rejected`（返修越界被拒）

### Issue 状态（最关键）
```
open → repairing → claimed_fixed → verified
                        ↑              |
                    reopened ←─────────┘（复审又发现问题）
```
- `claimed_fixed`：返修方声称改好了。**不能作为交付的关闭依据。**
- `verified`：经复审验证确实解决。**只有它能关闭一个 blocking issue。**

### Revision Instruction 状态
`issued → in_progress → submitted → (verified | scope_violation)`
- `scope_violation`：返修改动越出了 editable 范围（改到了 frozen 的行）。系统拒绝该版本进入复审，产物版本置为 `rejected`。

---

## 第 12 部分：验收标准

MVP 完成的判定，不是"代码写完了"，而是下面每一条都能实际演示。

### 12.1 机制闭环（核心验证，用真实 Pi 跑）

用一个"已知需要返修"的真实歌词案例，完整演示：

1. 用户输入 → 总控派任务 → 生成 Agent 产出歌词 v1；
2. 审核 Agent（冷 Session）审出第 4 行问题，系统登记为一个 blocking Issue；
3. 审核拒绝先回到总控，总控发出"只改第 4 行、其余冻结"的返修指令；
4. 生成 Agent（**恢复原 persistent Session**，带着之前的创作上下文）产出歌词 v2；
5. 系统做行级 Diff，确认只有第 4 行变了（若改了别的行，判 `scope_violation` 并拒绝）；
6. 审核 Agent（**新开一个冷 Session**）重新审核 v2，通过；
7. 对应 Issue 经复审进入 `verified`；
8. 总控申请交付 → 系统交付门禁逐项通过 → Case 变 `approved`；
9. 全程每个 Turn 都能在数据库里查到，每次调用 Pi 的上下文快照都能查到。

### 12.2 崩溃恢复

在上面流程跑到一半（比如 v2 已产出但还没复审）时 kill 掉进程；重启后：
- 系统从最后一个完成的 Turn 继续；
- **断言：已经产出的 v1、v2 没有被重新生成**（内容哈希不变、没有新增重复版本）。

### 12.3 配置化（证伪"写死业务"）

- 另写一份 YAML，定义一个**不同于歌词**的场景（比如两个 Agent：文案生成 + 质检），角色 key、数量、提示词、路由都不同；
- **不修改任何平台代码**，跑通一个完整 Case；
- 证明平台没有对具体角色名做任何硬编码。

### 12.4 职责边界（证明支柱一成立）

- 业务 Agent 的输出里没有 case_id / session_id / version / 时间戳 / 路由元数据；
- 格式问题不会导致整轮业务内容白白重生成；
- 交付由系统门禁决定，Agent 的 approve 单独不足以交付；
- 越界返修被系统拦截，进不了复审。

### 12.5 可观察（只读回放页）

打开某个 Case 的回放页，能看到：
- 按 Agent 分列的消息卡片，按时间排列；
- 每条消息标注了发给哪个 Agent、路由原因；
- 点开消息能看到完整输入、完整输出、以及那一次实际发给 Pi 的上下文快照；
- 能看到产物的各个版本和它们之间的行级 Diff（哪些行改了、哪些行是冻结的）；
- 能看到每个 Issue 的证据、当前状态、在哪一版被修、被哪次复审验证；
- 能看到交付门禁每一项为什么通过或不通过。

（实现方式：普通 Web 页面 + 轮询刷新即可。不做 SSE、不做跨泳道连线动画。）

---

## 第 13 部分：构建顺序（按风险从高到低）

请严格按这个顺序做。这个顺序的逻辑是：**把最可能推翻整个设计的风险最早暴露出来，避免在外围功能上浪费投入。**

1. **先搭骨架 + Fake Pi 打通全链路**：契约、domain 状态机、application 编排、SQLite adapter、Fake Pi adapter。用 Fake Pi（不烧 Token）跑通：配置加载 → 建 Case → Turn 循环 → 4 个工具 → 产物/Issue 落库 → 交付门禁。这一步产出一个"能在假模型下跑完整闭环"的系统。

2. **接真实 Pi 跑 12.1 主场景**：这是**全项目风险最高的假设**——"在这套最小结构化 + 中间层组装上下文的机制下，真实模型行为是否稳定"。越早证实或证伪越好。如果这里发现模型不稳定，需要调整工具接口或上下文策略，此时你还没在前端和外围上花过钱。

3. **崩溃恢复测试（12.2）**：跑到一半 kill 进程，重启续跑，断言不重生成。

4. **第二个 YAML 场景（12.3）**：证明配置化成立。

5. **只读回放页（12.5）**：最后做。机制已验证，前端只是把数据库里的东西显示出来。

---

## 第 14 部分：交付物

1. 后端源代码（分层遵守铁律 5）；
2. 只读回放 Web 页面；
3. SQLite 数据库迁移脚本；
4. Pi 集成模块 + Fake Pi 实现；
5. 4 个工具的定义与执行逻辑；
6. 场景配置的 Schema 定义；
7. 歌词场景 YAML（含提示词文件）；
8. 第二个验证场景 YAML（不同 Agent 构成）；
9. 本地启动/停止脚本；
10. 环境配置示例（**不含任何真实密钥**）；
11. 单元测试（domain 层状态机、交付门禁、行级越界校验必须覆盖）；
12. 端到端测试：至少覆盖 12.1 主闭环、12.2 崩溃恢复、12.3 配置化三条；
13. 一份运行说明（如何跑起来、如何跑两个验收场景）。

---

## 附录：给开发 Agent 的最后提醒

1. **先理解目标再动手。** 这个项目上一轮失败了。最大的风险不是技术难度，是方向跑偏。第 1–5 章比第 6–14 章更重要。
2. **遇到"要不要多做一点"的诱惑时，回到第 4 章。** 问自己：这个功能服务哪根支柱？是不是验证机制所必需？如果不是，推迟。
3. **domain 层必须纯净、可纯内存测试。** 交付门禁、Issue 状态机、行级越界校验这些核心规则写在 domain 里，用单元测试锁死。它们是这个系统可信的根基。
4. **默认用 Fake Pi。** 真实 Pi 只在明确需要验证"真实模型行为"时才用，且要能预见 Token 消耗。
5. **任何时候都不要为了让某条路径跑通，而在平台代码里写下业务角色名的分支。** 这是这个项目的生死线。
