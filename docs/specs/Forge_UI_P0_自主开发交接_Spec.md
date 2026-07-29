# Forge UI P0 自主开发交接 Spec

> 规范状态：已冻结（五轮零上下文对抗审查通过）；只有 `docs/specs/Forge_UI_P0_交接记录.md` 为 `READY` 时才可开工
> 日期：2026-07-29
> 适用范围：Forge UI P0 本地 Web、真实 Pi 运行链路、持久化、进程恢复与最终视觉实现
> 不适用范围：Forge UI P1、预定义流程编排器、Electron、鉴权/多用户和远程部署
> 配套模板：`docs/specs/Forge_UI_P0_用户提供清单.md`
> 唯一交接事实记录：`docs/specs/Forge_UI_P0_交接记录.md`

## 1. 文档目的

本 Spec 用于把 **Forge UI P0** 交给一个没有此前对话上下文的开发 Agent。它不授权开发 Agent 宣称“完整 Forge 项目”“Forge UI 1.0/P1”或“编排器”已经完成。该 Agent 不需要重新发掘 P0 产品需求，也不需要逐 Task 等待用户做技术判断；在交接记录达到 `READY` 后，它应当按照测试、Harness、故障驱动器和发布门禁自主完成开发。

本 Spec 不是第二份施工计划。精确文件、接口、SQL、测试命令、Task 顺序和提交边界，以：

`docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`

为唯一规范性逐 Task 执行清单；它不得覆盖更高层的产品语义、技术协议和铁律。

## 2. 开发 Agent 的任务

把当前 Forge 工程升级为内容生产操作者可在本机真实使用的 Forge UI P0：

- 用户可以创建生产任务、选择不可变模板修订和每个 Agent 的真实 Provider/Model；
- 用户可以在同一个任务工作区观察从左到右排列的 Agent 泳道，以及从上到下推进的 Turn 时间；
- 用户可以打开完整但经过脱敏的 Agent 会话浮窗；
- 用户可以查看当前有效产物、版本、Diff、Issue、返修与门禁状态；
- 用户可以执行启动、暂停、恢复、停止和人工回答；
- 系统使用持久化命令、Supervisor、独立 Case Worker、SQLite 短事务和租约写栅栏；
- 系统在崩溃后不得重复调用无法确认结果的 Pi attempt，也不得重复提交工具副作用；
- 完成声明必须具有真实 Pi、真实持久化、真实进程和进程级故障恢复证据。

## 3. 必读顺序与来源优先级

开发 Agent 在进行任何写操作、安装依赖或启动 Task 0 前，必须按以下顺序阅读：

1. 根目录 `AGENTS.md`
2. `docs/specs/Forge_UI_P0_交接记录.md`
3. 本 Spec
4. `docs/Forge_UI_需求文档.md`，当前版本必须为 `1.5`
5. `docs/Forge_UI_技术需求文档.md`，当前冻结版本必须为 `0.44`
6. `docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`
7. `docs/specs/Forge_UI_P0_用户提供清单.md`
8. `PLAN.md`
9. `PLAN-REVIEW-LOG.md`
10. 与当前 Task 直接相关的现有代码和测试

开始前必须机械校验交接记录中的 `spec_baseline_commit` 可解析并包含上述同版文档；当前 `HEAD` 必须是 baseline 的直接子提交，且相对 baseline 只修改交接记录和可选参考图；当前目标分支授权明确且工作树干净。交接记录不是 `READY` 时，只能做只读缺项检查，不得自行把推荐值当授权。

权威来源按职责划分，不能互相越权：

1. `AGENTS.md` 决定六条铁律、架构单向依赖、安全底线和旧失败仓库禁用范围；
2. `docs/Forge_UI_需求文档.md` 1.5 决定 P0 产品语义和 P0/P1 边界；
3. `docs/Forge_UI_技术需求文档.md` 0.44 决定技术协议与运行拓扑；
4. 实施计划决定不违反前三项的文件、接口、SQL、Task 顺序和机械验收；
5. 本 Spec 决定交接、停止和完成声明规则；`Forge_UI_P0_交接记录.md` 只提供本次非秘密输入和操作授权；
6. `PLAN.md` 只做摘要，`PLAN-REVIEW-LOG.md` 只做历史审查追溯；
7. `README.md`、`CLAUDE.md` 和当前代码只用于识别改造前基线，不得覆盖上述来源，也不提供 Git 权限。

“旧失败仓库”仅指当前仓库之外的旧 TS monorepo 骨架和 `pi-pipline-main`；开发 Agent 必须检查并改造当前 `Forge-AI-main` 基线，不能把当前仓库也误判为禁止读取。当前 `README.md` 与 `CLAUDE.md` 中 Node `>=20`、Pi persistent JSONL Session、Web 直读 SQLite、跨 Pi 长事务或自动 commit/push 等描述均是历史基线，不是 P0 目标或授权。

## 4. 不得重新讨论的冻结决策

除非用户明确重新打开需求评审，开发 Agent不得改变以下决策：

- 架构依赖只能为 `contracts → domain → application → adapters → apps`；
- 平台代码不得按具体业务角色、阶段、产物类型或场景名分支；
- Next.js 只做同源 BFF 和 UI，不直接访问 SQLite、不拉起 CLI；
- P0 是本机个人使用项目，不建设鉴权、多用户、远程部署或复杂权限；
- P0 不做 Electron，只保留未来封装与 native module rebuild 边界；
- P0 默认单 Case 并发；
- production/test 物理分库；每个 Launcher/Web/Supervisor 实例只绑定一个显式环境，`all` 仅允许只读聚合；
- Supervisor 重启后只通过数据库命令、execution lease 和 heartbeat 观察仍存活的 Worker，不接管旧父子 IPC，也不因无法重建 IPC 而重复启动 Worker；
- 任务启动后冻结模板修订、输入、环境和每个 Agent 的 Provider/Model；
- Pi 只使用公共 `SessionManager.inMemory(cwd, { id: logical_session_id })` 创建固定 logical ID 的 in-memory Session；
- Forge 只保存脱敏后的公开有序消息证据和原位 opaque signature；
- plaintext hidden thinking 不采集、不持久化、不返回；
- P0 关闭 Pi auto-compaction，达到上下文上限后安全停止；
- 一个 `agent_run_attempt_id` 最多执行一次 Forge 外层 `AgentSession.prompt()`；
- Provider hooks 只做 best-effort telemetry，不能作为恢复屏障；
- P0 写工具强制顺序执行；
- Action 事务 A 提交 `prepared + arguments_hash`；
- Action 事务 B 原子提交 domain effect、completed 和 outbox；
- 事务 B 回滚时保留 prepared，另外三项必须不存在；
- attempt 已 started 但没有明确终态时，一律进入 `outcome_unknown + waiting_recovery`；
- 外部非事务副作用工具不进入 P0；
- SQLite 旧库迁移必须严格离线，不证明任意未知 Windows 进程不存在；
- 本地发布包绑定 OS、arch、Node major 和 `process.versions.modules`；
- 真实 Pi 和进程恢复门禁通过前不进行视觉打磨。

## 5. 自主开发范围

在交接记录达到 `READY` 后，以下工作必须由开发 Agent 和 Harness 自主完成，不应逐项询问用户：

- Task 0 Pi 0.82 公共 API 与概念性两事务可行性探针；
- Contract、状态机、Repository、migration、Unit of Work 和恢复协议实现；
- migration fixture、临时数据根、Fake Pi、浏览器测试和故障注入数据；
- P0 模型目录发现、模型冻结和漂移检查；
- in-memory Session 重建、消息证据脱敏和 signature 兼容性测试；
- Agent Run、Turn Journal、Action Journal、租约和命令幂等；
- Supervisor/Worker 交接、draining 和进程故障矩阵；
- Query/BFF/SSE/轮询降级；
- 功能性 Web UI、IndexedDB 恢复、URL 状态和宽屏布局；
- 不依赖源码的本地发布包、manifest 和 native ABI 校验；
- Fake Pi 全链路、真实 Pi 发布门禁和脱敏验收报告；
- Task 14 之前的全部客观测试；
- 测试失败后的诊断、最小修复、回归验证和文档同步。

普通编译错误、类型错误、测试失败、接口不匹配或实现细节不是用户决策点。开发 Agent 应当依据冻结协议自行解决。

## 6. 仅允许人工介入的边界

### 6.1 真实 Pi 外部条件

完整 P0 发布验收需要至少一个本机 Pi 已配置的 Provider/Model。用户只提供或确认：

- Pi 已在本机完成认证；
- 发布验收所用 Provider ID 和 Model ID；
- 允许真实测试产生的有限 API 费用；
- 网络可访问对应 Provider。

凭据不得通过聊天、Issue、代码、fixture、日志或验收报告传递。Harness 只读取 Pi 已配置状态。

交接时可以且不得暴露凭据内容，但交接记录必须在开工前明确 Provider/Model、网络、真实调用和费用边界；缺少任一项时交接保持 `NOT_READY`。若这些已经确认的外部条件在执行途中失效，开发 Agent 最多完成 Task 0–3，必须停在 Task 4，不得继续模型目录真实兼容性、UI 或后续 Gate，也不得用 Fake Pi 代替。

### 6.2 实际旧数据迁移

开发和自动测试默认使用隔离临时目录、fixture 或全新数据根，不需要用户数据。

只有用户要求迁移真实旧数据，且出现以下任一情况时，才允许请求用户选择：

- 数据根来源不明；
- 存在无法确认的运行标记或未知旧 Writer；
- 检测到历史凭据、Authorization/Cookie 或 plaintext thinking；
- Schema 指纹不在已知迁移集合；
- 磁盘空间不足；
- 用户需要保留的历史数据与安全迁移规则冲突。

允许向用户提供的选择只能是：

1. 重启后，在启动 Forge 前执行严格离线迁移；
2. 使用全新数据根；
3. 保留旧根不动，等待未来专用 forensic migration。

不得建议手工修改数据库、Manifest、JSONL 或生产证据来绕过门禁。

### 6.3 最终视觉主观确认

Harness 必须自动验证 1024、1280、1440、1920 宽度、焦点、键盘、Drawer/Dialog、截断、无障碍和截图回归。

视觉输入只能是交接记录中的 `none_use_frozen_direction`，或当前交接 HEAD 内唯一一张经过普通文件、magic bytes、`1 byte <= reference_image_bytes <= 20 MiB` 和 SHA-256 校验的 allowlisted 仓库图片。外部绝对路径、URL、下载目录或未哈希附件不能让交接达到 `READY`；Task 14 使用前还要复核同一 hash。

Task 14 客观测试通过后，系统先记录 `G7_AUTOMATED_READY + exact release_id`。用户只需要对该精确发布物进行一次整体视觉确认；接受后才是 `P0_ACCEPTED`。任何视觉修改都会生成新 commit/release，并重跑完整 G7。视觉偏好不应阻塞 Task 0–13，也不应在开发过程中反复询问。

### 6.4 产品运行期的人工作业

以下属于产品功能，不属于开发 Agent 被阻塞：

- Case 进入 `waiting_human` 后由内容生产操作者回答；
- Case 进入 `outcome_unknown + waiting_recovery` 后由操作者选择安全恢复或停止；
- 交付门禁不通过时由正常 Agent/Issue/返修流程继续。

测试 Harness 必须模拟这些用户动作，但不得伪造 `approved`、`verified` 或 `delivered`。

## 7. Task 与门禁执行协议

开发 Agent 必须严格顺序执行：

1. Task 0：Pi 0.82/SQLite 可行性
2. Tasks 1–3：Contract、严格离线迁移、任务/模板
3. Task 4：模型目录、实际模型绑定、in-memory Session 证据
4. Tasks 5–7：产物不变量、Agent Run/Action Journal、Supervisor/Worker
5. Tasks 8–10：Query、BFF、SSE、功能 UI
6. Task 11：不可变本地发布包与 ABI
7. Task 12：Fake Pi 浏览器和生产进程故障门禁
8. Task 13：真实 Pi 发布候选门禁
9. Task 14：视觉实现与最终验收

任何 Gate 失败时不得越过：

- G0 失败：停止全部生产实现；
- G1 严格离线迁移失败：不得在真实旧数据根上继续；
- G2 Provider/Session 重建失败：不得允许该模型启动可恢复任务；
- G3 生产 Journal/租约失败：不得进入 Query/BFF/UI；
- G5 Fake Pi 生产进程故障失败：不得运行真实 Pi 门禁；
- G6 真实 Pi 失败：不得视觉打磨或宣称 P0 完成；
- G7 最终命令集失败：不得交付。

## 8. Harness 证据要求

每个 Task 必须留下可重复运行的证据：

- 失败测试或探针证明当前缺口；
- 最小实现；
- 聚焦测试通过；
- `npm.cmd run check` 通过；
- 任务要求的集成、构建、打包或进程测试通过；
- 与 Task 对应的 commit；
- 不包含凭据、隐藏思维链或完整敏感业务内容的报告。

Task 0 只证明 SDK/API 和概念性 SQLite 协议，不能作为生产恢复证据。

Task 6 必须用最终 Schema、Repository 和 TurnExecutor 重跑：

- 一个 attempt 最多一次外层 prompt；
- `error/aborted` 正常 resolve 的终态分类；
- transcript 缺失或持久化失败不能成功；
- Action B 回滚只保留 prepared；
- Pi await 期间没有 SQLite 写事务。

Task 12 必须通过真实 Worker/Supervisor 进程重跑同一崩溃窗口。

Task 13 先提交真实 Pi Harness，要求 clean worktree，再从该 commit 构建新的 immutable release；package、Task 12 的 Fake/UI/fault Gate 与 Task 13 的 real Pi Gate 必须重新消费这一份精确 manifest，不能复用带旧 source commit 的候选物，也不能从源码直接运行。

## 9. 开发 Agent 的停止与上报规则

只有以下情况可以停止并请求用户：

1. 需要用户提供清单中的真实外部条件；
2. 冻结需求之间出现无法同时满足的新矛盾；
3. Pi 公共 API、SQLite 协议或平台能力经过最小复现后证明不可行；
4. 操作会触及真实用户数据且安全选择不唯一；
5. 需要扩大到明确 Out of Scope 的 P1、预定义流程编排器、Electron、鉴权、远程部署或外部副作用工具。

停止报告必须包含：

- 阻塞所在 Gate/Task；
- 最小复现命令；
- 实际输出或错误；
- 已排除的替代方案；
- 为什么 Harness 无法自行决定；
- 用户只需回答的一个最小问题。

不得因为工作量大、测试慢、普通实现困难或接近上下文上限而向用户请求技术设计决策。

## 10. 明确禁止

- 不复用旧失败仓库或 `pi-pipline-main` 的代码；
- 不把 Fake Pi 结果冒充真实 Pi；
- 不在真实 Pi 和恢复门禁前打磨 UI；
- 不手工伪造数据库成功状态、Issue verified、门禁 pass 或 delivered；
- 不覆盖历史产物、Issue 事件或已提交 Action；
- 不在 Pi await 期间持有 SQLite 写事务；
- 不使用 Pi 私有 API 绕过 Task 0；
- 不恢复生产 JSONL Session sink 方案；
- 不恢复 Forge Adapter 的空响应/nudge 外层重试；
- 不自动迁移来源不明的真实数据根；
- 不把 API Key、Token、Header、Cookie、凭据路径或 hidden thinking 写入任何证据；
- 不把 `prompt()` resolve 直接解释为成功；
- 不把 `agent_run_completed` 直接解释为 Case/Turn 成功。

## 11. 完成定义

只有以下条件全部满足，才可以声明 Forge UI P0 完成：

- Task 0–14 全部完成；
- G0–G7 全部通过；
- exact Pi `0.82.0` 与 Node `>=22.19.0`；
- production/test 数据隔离；
- migration、Unit of Work、Agent Run/Action Journal 和租约测试通过；
- Web 不直接访问 SQLite 或 CLI；
- Fake Pi 浏览器/进程故障矩阵通过；
- 至少一个真实 Provider/Model 的 Session 重建和真实 Pi 发布门禁通过；
- 同一个 release ID 完成 package、Fake、fault、real Pi 和最终 UI 验收；
- 完整数据根、HTTP/SSE、日志、浏览器存储和验收报告通过秘密/hidden thinking 扫描；
- 1024/1280/1440/1920 视觉与无障碍检查通过；
- README 只记录真实可运行命令和证据；
- 自动门禁先达到 `G7_AUTOMATED_READY`，用户再接受同一未过期 `release_id`，状态才达到 `P0_ACCEPTED`。

若真实 Pi 条件缺失、实际 Provider 未验证、真实进程门禁未通过或用户尚未接受 exact release，只能报告实际达到的 Task/Gate 或 `G7_AUTOMATED_READY`，不能报告 `P0_ACCEPTED`，更不能报告整个 Forge 项目完成。

## 12. 交付报告格式

开发 Agent 最终交付时必须给出：

1. 完成到哪个 Task/Gate；
2. 修改文件和关键架构变化；
3. 实际运行的验证命令；
4. 每条命令的通过/失败结果；
5. immutable release ID；
6. Fake Pi 和真实 Pi 报告路径；
7. 剩余未完成项；
8. 是否需要用户进行真实数据迁移或视觉确认；
9. 当前是 `G7_AUTOMATED_READY` 还是 `P0_ACCEPTED`；
10. 没有被测试证据支持的内容不得写成已完成。

## 13. 可直接复制给开发 Agent 的启动指令

```text
你将负责实现 Forge UI P0。你没有此前对话上下文，必须先按顺序完整阅读：

1. AGENTS.md
2. docs/specs/Forge_UI_P0_交接记录.md
3. docs/specs/Forge_UI_P0_自主开发交接_Spec.md
4. docs/Forge_UI_需求文档.md
5. docs/Forge_UI_技术需求文档.md
6. docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md
7. docs/specs/Forge_UI_P0_用户提供清单.md
8. PLAN.md
9. PLAN-REVIEW-LOG.md

先校验交接记录为 READY、其中 spec_baseline_commit 可解析、当前 HEAD 是只含交接输入的 baseline 直接子提交且工作树干净；否则只列缺项并停止。通过后，以实施计划为逐 Task 执行清单，从 Task 0 开始，不得跳 Gate。普通技术问题、测试失败和实现细节由你根据冻结协议和 Harness 自主解决。只有 Spec 第 9 节允许的情况才能请求用户输入。

本次范围只有 Forge UI P0，不包含 P1、预定义流程编排器或 Electron。不得使用当前仓库之外的旧失败仓库代码，不得用 Fake Pi 冒充完成，不得在真实 Pi 和进程恢复门禁前打磨 UI，不得泄露凭据或 hidden thinking，不得在 unknown 结果后自动重调 Pi。

每完成一个 Task，都运行该 Task 的聚焦测试和 npm.cmd run check，并按已达到 READY 的交接记录创建独立本地 commit；`allow_task_commits` 不是可选项。只有交接记录明确允许时才 push 或创建 PR。Task 0–14、G0–G7、真实 Pi 发布门禁全部通过只产生 G7_AUTOMATED_READY；用户接受 exact release 后才可声明 P0_ACCEPTED，不得声明整个 Forge 项目完成。
```
