# Plan: Forge AI MVP —— 最小可行的多 Agent 协作生产平台
_Locked via grill — by Claude + user_

## Goal

在一个全新的工作目录中，用 TypeScript/Node.js 实现 Forge AI 的最小可行版本：一个由"总控 / 生成 / 审核"三个 Agent 组成的歌词生产闭环，验证"中间层接管工程格式 + 产物与问题状态系统由系统独立核实交付"这套核心机制在真实 Pi 模型下是否成立，同时用第二个零代码改动的场景证明平台没有硬编码任何业务角色。完整的问题背景、四根支柱推导、数据模型、工具接口、状态机与验收标准见随附的 `Forge_AI_MVP_需求文档.md`；本计划只补充该文档未覆盖的具体工程决策，作为实施与 Codex 评审的执行依据。

## Approach

1. 在新工作目录初始化 TypeScript/Node monorepo，采用 `contracts → domain → application → adapters → apps` 五层结构（npm workspaces），配套 vitest 单测和 `dev/check/test/test:integration/test:e2e` 等标准命令脚本。
2. 交付一份精简版 `AGENTS.md`：只包含"先读 `Forge_AI_MVP_需求文档.md` 和 `PLAN.md`""六条铁律（不硬编码业务角色 / 模型不碰工程数据 / 交付是系统决定 / 一切追加不覆盖 / 分层依赖单向 / 不泄密：API Key、Token、Authorization Header、隐藏思维链不得进入日志、数据库或前端）""不要读取或复用任何旧仓库代码"，再加一段"已知失败模式提醒"（概括自一次已归档的失败尝试，不含任何代码或实现细节）：**上一轮尝试的领域模型、状态机和分层架构本身被证明是合理的，真正导致失败的是纪律问题——把"Fake Pi 驱动的内存态演示 + UI"做完就在文档里宣称"整体完成"，而真正高风险的部分（真实 Worker、真实持久化运行链路、真实 Pi 验收、进程级崩溃恢复、幂等键的真实生效)从未做到、也未如实记录未完成。本项目必须避免同样的模式。**
3. 实现 domain 层核心状态机（Artifact Version、Issue、Revision Instruction、交付门禁判断、行级越界校验），要求可纯内存单测，不依赖数据库 / Pi。
4. 实现 application 层编排：Case / Turn 生命周期、Context Builder（静态包含规则 + 快照落库）、4 个工具的执行逻辑（`publish_artifact` / `submit_evaluation` / `route_message` / `approve_delivery`）+ `request_human_input` 降级处理（Case 停在 `waiting_human`）。
5. 实现 adapters：SQLite 持久化（启用 WAL 模式 + busy-timeout，因为 worker 写、web 回放页轮询读会同时访问同一个数据库文件）+ Fake Pi（确定性脚本化响应，零成本、行为可预测）+ 真实 Pi adapter。Pi 的真实来源已知：SDK 包 `@earendil-works/pi-coding-agent`，源码仓库 `https://github.com/earendil-works/pi.git`；开发 Agent 应直接从该仓库学习/探测真实接口（阅读其文档、按需拉取），用户会另外提供模型调用的 API Key/URL。**不得**阅读或复用本项目旧 `packages/pi-adapter`、`pi:probe`、`pi:smoke` 里的任何实现代码——只借用"包名/仓库地址"这一个事实。
6. 用 Fake Pi 打通全链路（配置加载 → Case → Turn 循环 → 4 工具 → 产物 / Issue 落库 → 交付门禁），先在零 Token 成本下验证机制自洽。**每个 Turn 的状态翻转与其产生的全部副作用（产物版本、Issue、工具调用记录）必须在同一个数据库事务内提交**，避免"Turn 已标记完成但产物没写进去"的不可恢复数据丢失。
7. 由开发 Agent 自行构造一个"已知需要返修"的歌词测试案例（参考歌词、固定金句、预期审核问题）和三个 Agent 的初版提示词（从零编写，不参考任何旧代码）。
8. 接入真实 Pi，跑通一次完整闭环：初稿 → 审出问题 → 定点返修（原 persistent Session 恢复）→ 冷 Session 复审 → `verified` → 系统交付门禁通过 → `approved`。按需调用，优先在 Fake Pi 验证通过后才动用真实 Pi；连续 3 次真实 Pi Turn 出现异常/不符合预期的行为时必须停下汇报用户，不得无限自动重试（这是异常检测，不是预算约束）。
9. 补崩溃恢复测试：流程跑到一半 kill 进程，重启后断言 Case 先短暂进入 `waiting_recovery` 状态、再回到 `running` 并从最后完成 Turn 续跑；断言已完成产物版本未被重新生成（可用 `tool_actions` 上的 `provider_tool_call_id` 唯一约束或产物内容哈希双重校验)。
10. 由开发 Agent 自由选定第二个业务场景（不同于歌词的 Agent 数量 / 角色 / 路由），只写新 YAML + 对应 Fake Pi 脚本，零代码改动跑通，证明平台未硬编码任何角色。该验收默认用 Fake Pi 完成，不额外消耗真实 Pi 调用。
11. 实现只读回放 Web 页面（Next.js，轮询刷新，不做 SSE / 连线动画）：按 Agent 分列消息卡片、产物版本 Diff、Issue 状态、交付门禁逐项结果。
12. 交付：源码、迁移脚本、Fake Pi 实现（含第二场景脚本）、工具定义、场景 Schema、两份场景 YAML + 提示词、单元 / 集成 / 端到端测试、运行说明。

## Key decisions & tradeoffs

- **全新目录，不复用旧仓库任何代码**：旧的 TS monorepo 骨架和 `pi-pipline-main` Python 项目均视为失败品，只保留"分层约定"这一思路，不复用一行实现代码。`PLAN.md` 和 `Forge_AI_MVP_需求文档.md` 会由用户直接放进一个全新的、不含旧 `apps/packages/contracts/docs/pi-pipline-main` 的文件夹，开发 Agent 从这个干净目录启动会话，不存在旧内容被自动加载的风险。取舍：牺牲已有骨架的时间投入，换取新 Agent 不被旧逻辑污染。
- **Pi 的来源已知，但真实调用细节仍需现场确认**：Pi SDK 包名为 `@earendil-works/pi-coding-agent`，源码仓库 `https://github.com/earendil-works/pi.git`。开发 Agent 应直接从该仓库获取真实接口信息（不是从本项目旧 `pi-adapter` 代码里抄），用户会另外提供模型调用的 API Key/URL。取舍：省去了"从零盲猜 Pi 接口形状"的风险，但认证方式、Session API 的具体调用细节仍要等真实凭证到位后才能最终确认。
- **`approve_delivery` 不得要求模型提供产物版本号**：原始需求文档 §8.4 的参数示例（模型传 `artifact_version`）直接违反铁律 2（模型不碰工程数据）。MVP 修正为：Agent 只传 `artifact_type`（或不传任何定位参数），由系统自动解析当前 under_review/approved 的目标版本；存在歧义时拒绝申请，不允许猜测——与 §8.1 `publish_artifact` 的"不得猜测依赖"原则保持一致。
- **技术栈选 TypeScript/Node.js**，弃用 Python（尽管 `pi-pipline-main` 证明过 Python 路线可行）。理由：与既定的分层架构描述天然契合，且是"全新开始"后的默认选择而非路径依赖。
- **`tool_actions` 增加幂等键**：新增 `provider_tool_call_id` 字段，配合 `(turn_id, provider_tool_call_id)` 唯一索引；`publish_artifact` / `submit_evaluation` 处理器对已记录过的同一次调用直接短路返回，不重复创建产物版本或 Issue。理由：Pi SDK 侧的重试、或崩溃恢复重放一个未完成 Turn 时，如果没有幂等键，可能悄悄产生重复的产物/问题记录，违反"一切追加不覆盖"铁律的精神（重复本身就是一种数据损坏）。**如果 Pi 不暴露稳定的单次调用 ID，退化方案是用系统自己生成的幂等键**（`turn_id` + 系统分配的本轮工具调用序号），不能让去重机制硬性依赖一个尚未验证存在的 Pi 特性。
- **SQLite 启用 WAL 模式 + busy-timeout**：worker（写者）和 web 回放页（轮询读者）会并发访问同一个数据库文件，默认锁模式在此场景下容易报 "database is locked"。这是一个明确的工程决定，不留给实现阶段随意选择。
- **`skills` 字段在 MVP 场景 Schema 中标记为保留字段，本阶段不解析、不执行**：Pi 和"Skill"的关系目前不完全清楚（不同于本 MVP 从零撰写的提示词方式），为避免开发 Agent 卡在这个未定义概念上，MVP 明确不处理它。
- **Issue 状态机与 Revision Instruction 状态机需要一张明确的事件 → 跨状态机迁移映射表**，在实现 domain 层前必须写清楚并配单测，例如：`route_message` 携带 `issue_ids` 时，登记 Revision Instruction 为 `issued` 并把对应 Issue 移到 `repairing`；返修方对一个 `in_progress` 的 Revision Instruction 调用 `publish_artifact` 时，Issue 移到 `claimed_fixed`、Instruction 移到 `submitted`；随后的 `submit_evaluation` 决定 Issue 进入 `verified` 或 `reopened`。理由：这两台状态机独立定义但必须保持同步，不写清楚触发规则，验收流程（12.1 步骤 3–7）隐含依赖的行为就无法保证被正确实现。
- **真实 Pi 全链路验证是 MVP 硬指标，不能只用 Fake Pi 顶替**。这是全项目风险最高的假设（模型在最小结构化 + 中间层组装上下文下能否稳定协作），必须在 MVP 阶段证实或证伪。
- **单 Case 顺序执行，不做并发调度**：MVP 验证目标是机制是否成立，不是吞吐量。worker 可以是最简单的顺序循环。
- **只读回放页用 Next.js**：便于未来演化，即便 MVP 阶段只需要轮询刷新的静态展示。
- **不设真实 Pi 调用次数 / 预算硬上限**，只要求开发 Agent 遵循"先 Fake Pi 跑通，再动用真实 Pi"的软约束，按需调用。
- **测试案例与提示词均由开发 Agent 自行构造 / 撰写**，不依赖用户额外提供业务素材或复用旧提示词，避免新旧内容混淆。
- **第二验证场景内容自由选择**，只要满足"不同 Agent 数量 / 角色 / 路由、零代码改动跑通"这个验证目的即可，具体业务不重要。
- **两份文档并行交付**：`Forge_AI_MVP_需求文档.md`（为什么 + 完整规格）+ `PLAN.md`（具体工程决策 + 执行步骤），后者引用前者作为背景，避免内容重复膨胀。
- **完成声明必须有可运行证据，禁止只写文字声明**：任何阶段/里程碑标记"完成"，必须附带可复现的命令输出（测试跑过的记录、真实 Pi 调用日志等）；不允许在没有实际验证的情况下把"部分完成"写成"完成"。理由：已归档的一次失败尝试就是在真实 Worker、真实 Pi 验收、崩溃恢复都未完成的情况下，文档宣称"M0-M5 全部完成"，这是导致失败被延迟发现的根本原因，必须显式禁止重演。
- **幂等键（`provider_tool_call_id`）必须有真实的重复调用回归测试**：需要一个测试真实发送两次相同的工具调用，断言只产生一条产物版本/Issue 记录；只在数据库加字段而不接通去重逻辑视为未完成。理由：这正是已归档失败尝试里翻车的具体缺陷类型（声称有 Idempotency-Key 机制，实测同一个 Key 连续请求两次却产生了两个不同 Case）。
- **在真实 Pi 全链路（第 8 步）和崩溃恢复（第 9 步）验证通过、并留有证据之前，只读回放页（第 11 步）不允许打磨超过最基础可用程度**：即先能显示消息卡片、产物版本、Issue 状态、门禁结果这些必需信息即可，不做样式/交互精修。理由：防止重复"先做完看得见的 UI，再也没精力碰真正高风险的部分"这个已经在历史上验证过的失败路径。

## Guardrail: no silent architecture substitution

开发 Agent 在实现过程中，如果发现某个已锁定的关键决策（尤其是本计划"Key decisions & tradeoffs"里列出的条目，例如 Pi 的真实来源、Session 策略、approve_delivery 的参数形状）在实践中难以落地，**必须先停下来向用户报告偏离原因和替代方案，获得明确确认后才能采用替代实现**；不允许在没有报备的情况下自行简化或替换掉一个已经写进本计划的架构决策。

具体到 Pi 集成：`真实 Pi adapter` 必须真正对接 `@earendil-works/pi-coding-agent`（`https://github.com/earendil-works/pi.git`），先做一次不消耗 Token 的能力探针（读取该仓库文档、确认 Session create/resume、工具注册、模型配置方式），再决定 `persistent`/`cold_per_version` 这套 Session 策略具体怎么映射到 Pi 的真实接口上。**不允许绕开 Pi、直接用某个模型的 OpenAI 兼容接口自己实现一套 Session/上下文管理来替代"对接 Pi"这件事**——这样做会让"真实 Pi 全链路验证"这个 MVP 最高风险项失去验证意义（验证的是别的东西，不是我们要验证的东西）。至于 Pi 底层实际使用哪个模型（是否为 DeepSeek），取决于 Pi 自身是否支持配置第三方模型，这一点需要开发 Agent 先读 Pi 的真实文档确认，不能假设。

## Risks / open questions

- **Pi 真实调用细节仍待现场确认**：包名和源码仓库已知（`@earendil-works/pi-coding-agent`，`https://github.com/earendil-works/pi.git`），风险已从"完全未知"降为"细节未知"——认证方式、Session API 的具体调用形状、模型 / Thinking 参数名仍要等用户提供的 API Key/URL 到位后才能最终确认，存在返工风险，但风险面比最初小。
- **真实模型行为稳定性未知**：这是全项目风险最高的假设——如果真实 Pi 在最小结构化工具约束下表现不稳定（比如经常不服从 editable/frozen 范围、审核证据不稳定），可能需要回头调整工具接口或上下文策略。构建顺序已把这一步安排在早期（Fake Pi 全链路打通后立刻做）以尽早暴露此风险。
- **崩溃恢复与 Session 策略抽象依赖 Pi 真实能力，尚未验证**：`persistent`/`cold_per_version` 这套 Session 策略假设 Pi 支持"创建/恢复一个具名 Session 并保留历史"这种模型；如果 Pi 真实 API 更接近"无状态 + 不透明续传 token"，这套抽象本身（不只是参数命名）可能需要调整。必须在拿到真实 Pi 接口细节后尽早验证，不要等到实现后期才发现。
- **AGENTS.md 精简版的具体内容边界**：本计划未逐字定稿新仓库 AGENTS.md 的完整文本，将在实现阶段由开发 Agent 依据 `Forge_AI_MVP_需求文档.md` 第 5 章铁律起草，风险较低。

## Out of scope

- 复用旧仓库（TS monorepo 骨架 + `pi-pipline-main`）任何实现代码或文档；仅允许获知"Pi 包名/源码仓库地址"这一个事实，不允许阅读或复制旧 `packages/pi-adapter`、`pi:probe`、`pi:smoke` 的实现。
- 可视化配置编辑器、产物依赖 DAG 与级联失效、多审核仲裁、段落 / 句子 / JSON 级 Diff 锚点、分叉对照运行、批量生产、实时 SSE 泳道与跨泳道连线动画、短故事等多产物重模板（均见 `Forge_AI_MVP_需求文档.md` 第 4.2 节，理由已在该文档说明）。
- 多 Case 并发调度。
- 对真实 Pi 调用设置硬性预算 / 次数上限（仅保留"连续 3 次异常 Turn 需停下汇报"这一条异常检测软规则，不是预算约束）。
- 第二验证场景的真实 Pi 验证（默认 Fake Pi 即可）。
- 业务人员可用的人机交互界面（`request_human_input` 只需让 Case 停在 `waiting_human` 状态）。
- 对 `waiting_recovery` 状态之外更细粒度的恢复保证（MVP 只需证明该状态在崩溃恢复流程中被正确经过一次）。
