# Plan: Forge UI 产品化与本地运行链路重建
_Locked via grill — by Claude + user_

## Goal

在不破坏 Forge 现有领域规则、追加式证据和真实 Pi 能力的前提下，把当前“CLI/单 Worker + 只读回放页”重建为面向个人内容生产操作者的本地 Web 产品：用户通过 `forge ui` 启动一套可恢复的 BFF、Supervisor 和独立 Case Worker，能够创建与管理生产任务、选择并冻结每个 Agent 的真实 Provider/Model、观察 Agent 生产过程、查看产物演进、处理人工介入以及安全暂停、恢复和停止。P0 必须以真实持久化、真实 Pi、真实进程强杀和可运行证据验收；P1 在同一架构上补齐冻结产品需求中的工作台、模板、诊断和体验能力。Electron 仅保留未来封装边界，本计划不实现 Electron。

## Approach

1. **固定基线与建立可重复验收入口**
   - 记录当前 Node、npm、Pi 包、SQLite Schema、production/test DB 解析规则和现有测试结果。
   - 为后续迁移准备脱敏旧库 fixture；把仓库内每个已发布 Scenario Bundle 及外部 story-pipeline 的恢复/失效传播集成测试纳入迁移前后回归，不只抽测 songwriting/copywriting。
   - 把 `npm run check`、Vitest、Fake Pi E2E、真实 Pi E2E 的命令与证据输出格式固定下来。
   - 在任何 UI 美化前先建立“未完成能力清单”，禁止用 Fake Pi、静态页面或文字说明替代真实链路。

2. **先验证三项高风险外部假设**
   - 用当前 `@earendil-works/pi-*` 公开 API 验证 Provider/Model 目录枚举、可用性检查和认证状态的准确接口；不读取 Pi 私有配置。
   - 验证 `createAgentSession`/`resumeSession` 能按 Agent 接收并恢复准确 `provider_id + model_id`，并确认 Session 持久化中可用于崩溃核对的公开身份。
   - 验证 Windows 下 Worker 进程身份、心跳、受限 IPC 握手和 Supervisor 重启接管方式；PID 仅作诊断，不作为所有权。
   - 若任一 Pi 假设不成立，先更新 Adapter Contract 和技术文档，不在实现中静默回退到硬编码 Provider、全局模型或私有目录扫描。

3. **建立显式迁移系统，再修改业务 Schema**
   - 在 adapters 层增加版本化 migration runner、`schema_migrations`、checksum 校验、OS 级数据根目录迁移锁、WAL checkpoint 和 SQLite Backup API。
   - 迁移前停止 Supervisor 领取命令，要求 production/test 两库都不存在有效 Worker 心跳或租约，关闭 BFF/Supervisor/Worker 的全部连接；无法排除任一活跃 writer 时中止迁移。
   - 把当前 `SqliteRepository` 构造函数中的零散 `ALTER TABLE` 迁出；应用声明最低/最高支持 Schema。
   - 先完成 production/test 两库的全部空间预检和已验证数据库备份，再开始任一迁移；两库必须共同到达目标版本，否则用备份恢复已成功的第一库并拒绝启动，绝不运行 split-version UI。
   - 明确 migration backup 只覆盖 SQLite；迁移过程不得修改共享 CAS 与 Pi Session，因此数据库回滚复用原有 CAS/Session。整机丢失后的完整灾备导出不属于本计划。
   - 测试空库、历史 fixture、重复运行、checksum 被改、中途失败、磁盘不足、并发连接和备份恢复。

4. **扩充 Contract 与权威持久化模型**
   - 在 `packages/contracts` 定义 TypeBox DTO、稳定错误码、action descriptor、幂等请求、修订/CAS、Query 游标和 UI 事件 Contract。
   - 新增生产任务、任务来源、标签、不可变模板修订/资源清单、模型选择来源、持久化命令、命令租约、UI outbox 事件、配置修订和 Worker 实例身份。
   - 扩充 Case 状态机以支持 `paused`，保存可恢复的暂停前状态/检查点；排队状态只从命令事实投影，不写入 Case。
   - 修正 Artifact 当前有效指针：候选版本不替换有效版本，批准事务原子完成旧版 supersede、新版 approve、指针切换和事件追加。
   - 重建关键 SQLite 表并启用 `PRAGMA foreign_keys=ON`：增加状态 `CHECK`、同 Artifact 版本号唯一索引、单 delivered 版本部分唯一索引，以及保证 `current_valid_version_id` 归属和状态合法的 guarded trigger；并发批准必须由数据库约束兜底。
   - 为 Turn Journal 和工具行为增加稳定身份、阶段、请求/响应哈希、租约 generation、结果未知、幂等字段和 `execution_protocol_version`。
   - 已完成 legacy Case 保持只读可查；legacy 未完成 Turn 不尝试由新执行器续跑，迁移后明确进入 fail-closed `waiting_recovery` 并要求创建新任务或使用受控历史恢复流程。
   - 在开始 Schema/UI 实现前冻结 `/api/v1` HTTP Contract、错误码、action descriptor、分页和脱敏分类，具体基线见步骤 10。

5. **实现应用数据目录、配置和模板 CAS**
   - 增加平台路径 Adapter：production 默认 `%LOCALAPPDATA%\ForgeAI`，CLI 参数和 `FORGE_DATA_DIR` 按既定优先级覆盖；开发与自动化测试使用隔离目录。
   - 建立 `db/`、`sessions/`、`templates/`、`logs/`、`backups/`、`runtime/`、`cache/` 结构和安全路径校验。
   - 实现带 `schema_version`/revision 的非敏感 `config.json`，TypeBox 严格校验、原子替换、最近有效备份和热更新/重启边界。
   - 实现模板 staging、Bundle 校验、文件 CAS、SHA-256 去重、原子移动和数据库元数据事务。
   - Runtime 只按冻结模板清单加载并复核对象哈希；草稿、Case 或证据引用的修订不可删除。
   - P0/P1 禁止自动删除任何 CAS 对象，包括孤立对象；只记录可回收诊断。真正 GC 必须以后另行设计跨 production/test 的全局锁、mark generation 和删除前二次引用检查。

6. **建立 application Query/Command 边界**
   - 新增 ProductionTask、TemplateRegistry、ModelCatalog、Settings、CommandQueue 和 UI Query 应用服务。
   - 保存草稿使用完整快照、`expected_revision` 和幂等键。
   - 启动任务先在事务外执行有界 Pi 实时校验与模板对象复核，捕获目录 snapshot generation、模板修订/hash 和草稿 revision；随后短事务以 CAS 重新验证这些 generation/revision 未变化，再完成配置冻结、Case 创建、任务绑定、运行命令与 UI 事件追加。
   - production/test 写操作显式选库；`all` 只用只读 Repository 合并任务摘要并拒绝命令。
   - Query 统一计算任务状态、当前有效/最新创建/交付产物、待办原因和合法动作，BFF/前端不重写状态规则。
   - 所有诊断写入前经过 `SecretSanitizer`；Query、复制和下载再执行防御性脱敏，隐藏思维链永不采集。

7. **用分阶段 Turn Journal 替换跨 `await` 长事务**
   - 先用短事务提交 Turn intent、上下文引用和 `model_running`，再在事务外调用 Pi。
   - 由于 Pi Agent Runtime 可能在模型调用期间内联执行工具，Adapter 必须在每次工具回调前持久化非空、确定性的 action identity（Case/Turn attempt、工具调用序号、工具名和规范化参数哈希），再在短事务中原子提交 Forge 内部副作用与工具完成记录；`provider_tool_call_id` 仅作附加证据，不能作为唯一幂等身份。
   - 数据库对确定性 action identity 建唯一约束；Fake/Real Pi 恢复测试必须证明回调重放和 Session 恢复得到同一身份。
   - Pi 最终响应返回后持久化响应引用并完成 Turn/路由；已完成工具行为再次调用只返回原结果引用。
   - 恢复器按 Journal 证据判断继续模型核对、未完成工具、Turn 收尾或进入 `outcome_unknown`；不得盲目重放。
   - P0 只注册可与 Forge 事务一起提交，或具有幂等键与结果核对协议的工具。
   - 用确定性故障点覆盖每个阶段，证明没有重复产物、Issue、返修、门禁或工具行为。

8. **接通真实 Pi 模型目录与按 Agent 模型运行**
   - `RealPiAdapter` 通过公开运行时 API实现目录扫描、TTL/手动刷新、最近成功非敏感快照和启动前实时校验。
   - 模板默认模型、草稿覆盖来源和启动时实际 `provider_id + model_id` 全程可追溯。
   - Worker 创建/恢复每个 Agent Session 时传入冻结模型；原模型不可用时 fail closed，不静默替换。
   - 删除 `deepseek` 与全局 `PI_MODEL_ID` 作为业务默认的硬编码路径；环境变量只保留兼容诊断或显式启动覆盖，不替代任务事实。
   - 用至少一个真实 Provider/Model 验证新建、返修、暂停后恢复和崩溃恢复仍使用原 Session/模型。

9. **实现持久化命令队列、Supervisor 与独立 Worker**
   - 增加常驻 Supervisor composition root；按默认全局并发 1、命令优先级、FIFO/防饥饿和 Provider 限制领取命令。
   - 每个 Case 启动独立 Worker；Worker 持有 Case 租约、runner token 哈希、generation、心跳和 `worker_instance_id`。
   - raw runner secret 不放入 argv、环境变量、持久化文件或日志；Supervisor 通过当前用户 SID 限制的继承 pipe/handle 交付一次性 secret，并用 Worker nonce、Case ID、instance ID 和 lease generation 完成 challenge-response。
   - Supervisor 崩溃时健康 Worker 继续；新 Supervisor 通过 DB 证据与受限 IPC 握手接管监控，不能仅凭 PID 强杀或重复启动。
   - 暂停/停止是持久化命令。Worker 在完整 Pi Turn 后检查：暂停成功保存检查点并退出；停止原子进入终态。
   - 暂停强杀进入 `waiting_recovery`；停止强杀经证据核对后收敛为 `stopped`，未知外部结果不自动重试。

10. **实现类型化 REST BFF、持久化 SSE 与本地启动器**
    - 重建 `apps/web` 服务端 composition root，只调用 application Query/Command；删除页面直读 SQLite和 API Route 拉 CLI。
    - HTTP 固定使用 `/api/v1`。Query Route 家族为 tasks/task-overview/timeline/artifacts/templates/models/settings/commands/health；Command Route 家族为 draft-save/start/clone/archive/trash、pause/resume/stop/human-answer、template-import/model-default、catalog-refresh/settings-update。每个具体 Route 在 `contracts/http-v1.ts` 中静态列出，不提供通用 CRUD。
    - REST 写请求只接受 JSON，携带幂等键和预期修订/状态；GET 无副作用；异步命令返回 `202 + command_id`。
    - 错误码基线及 HTTP 映射：`validation_failed(400)`、`not_found(404)`、`revision_conflict/state_conflict/idempotency_mismatch(409)`、`model_unavailable/template_invalid/storage_low/recovery_required/outcome_unknown(422)`、`supervisor_unavailable(503)`、`internal_error(500)`；响应只带用户消息和可选脱敏 diagnostic reference。
    - 任务列表使用 opaque `(created_at, task_id)` 游标，默认 50、最大 100；本地单 Case timeline/versions 按需整组读取，若以后测得真实卡顿再新增游标，不预建复杂分页。
    - 脱敏基线：已知 DTO/工具字段使用 allowlist；未知文本检测 credential/header/cookie/connection-string 模式；占位符统一为 `[REDACTED:<TYPE>]`；解析失败丢弃正文并记录 `redaction_failed`；历史数据 Query 时重脱敏但不原地覆盖。
    - 每个环境在自己的 DB 中维护单调 `event_seq`，暴露独立 SSE；`all` 页面同时维护 production/test 两个 `{environment, sequence}` 游标，不伪造跨库全局序号。
    - UI 事件至少保留 7 天且始终保留最近 10,000 条/环境；SSE 每 15 秒 heartbeat，单批最多 100 条，单连接待发送缓冲最多 1 MiB。超限或游标缺口时断开并要求 `resync_required`，客户端重新 Query。
    - 实现 `forge ui`：解析数据目录、单实例锁、迁移、Supervisor、Next standalone、健康检查、自动打开浏览器和 draining。
    - 本地服务只监听 `127.0.0.1`；不实现账号、角色、权限或额外本地认证体系。

11. **先交付无视觉抛光的 P0 纵向闭环**
    - 用最小页面跑通 `/tasks`、`/tasks/new`、`/tasks/[taskId]`、`/templates`、`/settings`。
    - 接入 TanStack Query、React Hook Form、IndexedDB 草稿恢复和 SSE Query 失效；不使用 Server Actions、Redux 或第二套状态机。
    - P0 覆盖：创建/自动保存、模板与 Agent 模型选择、启动/排队、Agent/Turn 过程、当前有效产物、人工输入、暂停/恢复/停止和错误恢复。
    - 在这一阶段只验证功能、可访问语义和真实数据，不进行最终视觉细节打磨。

12. **通过高风险运行门禁后完成 UI 产品化**
    - 真实 Pi 新建/返修/交付、真实 Worker 强杀、Supervisor 强杀接管和七个 Fake 故障窗口全部通过后，才进入视觉抛光。
    - 建立暖色 CSS 语义令牌、CSS Modules、Radix 无样式交互组件、Lucide 图标和系统中文字体栈。
    - 实现任务工作台、生产概览、Agent 泳道/时间线、右侧产物演进链、Issue/返修证据、模型目录、模板修订和高级诊断。
    - 1024–1279 px 使用产物抽屉，1280 px 以上固定侧栏；不建设移动端。
    - 使用安全 Markdown、结构化工具卡片、当前产物浏览器内搜索、Markdown 章节导航和双版本统一 Diff。

13. **完成 P1 冻结范围，不扩张到 P2**
    - 补齐状态摘要、组合筛选/排序、标签、归档、草稿回收站、来源任务、模板版本差异与升级提示。
    - 补齐完整 Provider/Model 目录状态、模板默认模型维护、任务模型差异标记和脱敏诊断复制。
    - 补齐 UTF-8 `.txt`/`.md`/允许文本原始类型下载、安全文件名、稳定深链接和刷新恢复。
    - 不加入人工正文编辑、通知、鉴权、批量任务、Word/PDF、深色模式、自由流程画布或 Electron。

14. **建立分层自动化证据**
    - Vitest 覆盖 domain、application、迁移、命令、CAS、Turn Journal、模型冻结和恢复不变量；所有已发布 Scenario Bundle 及 story-pipeline 恢复/失效传播测试是迁移前后强制回归门禁。
    - React Testing Library 覆盖表单、冲突、错误、合法动作和交互组件。
    - Playwright 启动真实 BFF/Supervisor/Worker/SQLite + Fake Pi，跑完整操作者路径和少量稳定视觉回归。
    - 进程级测试真实终止子进程并使用原数据目录恢复，覆盖七个冻结故障窗口。
    - 运行秘密泄漏扫描，检查数据库、日志、REST、SSE、复制、下载和验收报告。
    - 结构化本地诊断使用 `environment → command_id → case_id → turn_id → worker_instance_id → lease_generation` 关联链，记录 queue age、heartbeat age、SQLite lock wait、Pi latency、SSE lag 和 sanitizer failure；健康页对卡住/过期/不一致给出明确状态，但不建设远程告警平台。

15. **执行真实发布候选验收并如实收口**
    - 使用运行时发现的真实 Provider/Model 运行完整 P0 Case，并执行真实 Pi 的三项最小强杀矩阵。
    - 验证原 Case、Session、模板、模型继续使用，已提交证据哈希不变且无重复副作用。
    - 生成脱敏报告，包含 commit、Schema、模板修订、Pi 版本、Provider/Model ID、故障点和断言结果。
    - 只有 `npm run check`、完整测试、Fake 故障矩阵、Playwright 与真实 Pi 门禁全部有可运行证据时，才能声明 P0 完成；随后按同样标准验收 P1。

## Key decisions & tradeoffs

- **Next.js BFF 而非独立 API 服务**：当前本地个人工具减少一个部署单元，但 application Contract 保持可拆分。
- **本地 Web 先于 Electron**：先证明产品和运行链路，Electron 只复用 standalone、HTTP/SSE 和生命周期协议。
- **生产任务与 Case 分离**：产品草稿/归档/标签不污染执行事实，代价是新增聚合与绑定迁移。
- **production/test 物理分库，all 只读聚合**：沿用现有隔离，接受 application 层合并两个小型本地结果集。
- **文件 CAS + SQLite 元数据**：恢复使用冻结资源且数据库不被大文件膨胀，代价是需要跨文件/数据库的 staging 与孤立对象清理。
- **持久化命令 + 每 Case 独立 Worker**：增加进程编排复杂度，换取隔离、排队、恢复和未来 Electron 托管能力。
- **分阶段 Turn Journal 而非跨 await 长事务**：避免 SQLite 长写锁，代价是必须处理结果未知与每个工具的幂等核对。
- **Supervisor 不是正确性单点**：存活 Worker 可继续并被重接管，代价是需要实例身份、租约 generation 和 IPC 握手。
- **SSE + Query 失效而非 WebSocket/前端状态机**：足够支持单向本地更新，同时保持权威状态在 application/DB。
- **loopback 但无用户鉴权/CSRF 子系统**：这是用户明确接受的个人本地工具边界；仍保持同源、无 CORS、JSON 写请求和无副作用 GET，但不扩张为账号或来源认证项目。
- **个人本地规模优先**：不预建虚拟列表、全文索引、复杂 Diff 服务、权限体系或分布式基础设施。
- **真实 Pi 与强杀门禁前不抛光 UI**：避免再次出现“Fake 演示 + UI 完成但真实运行未完成”的失败模式。

## Risks / open questions

- 当前 Pi 0.82 公开目录 API、模型选择参数和 Session 核对能力的准确形态需要在步骤 2 用可运行探针证明；若能力缺失，必须先调整 Contract，不能读取 Pi 私有文件兜底。
- Pi Agent Runtime 可能在一次模型调用中内联多次工具执行，Turn Journal 必须通过工具回调生命周期记录 intent/effect，而不能依赖“完整响应先于全部工具”的理想顺序。
- Windows 上 Supervisor 崩溃后对存活 Worker 的重新握手需要证明不会误认 PID、不会泄露 runner token，也不会因终端关闭意外杀死整个进程树。
- 从现有跨 await Turn 事务迁移到 Journal 时，历史 Case 和新 Case 的恢复路径必须有明确 Schema/版本边界；不支持混用两种执行器继续同一未完成 Turn。
- 模板 CAS 与数据库元数据无法依靠单个 SQLite 事务覆盖文件系统，需要用 staging、原子 rename 和提交顺序保证“数据库不引用缺失对象”；P0/P1 保留孤立对象而不冒险回收。
- 真实 Provider 调用在缺少上游幂等协议时无法保证费用 exactly-once；Forge 只承诺业务副作用不重复，并对未知调用结果 fail closed。
- loopback 本身不能防止本机恶意网页尝试访问服务；用户已明确拒绝额外 CSRF/来源认证复杂度，本计划接受该残余风险且不允许绑定 LAN。
- migration backup 是数据库回滚机制，不是 CAS/Session/配置的整机灾备；完整灾备导出属于未来独立需求。
- 这些项目是需要用 spike 和测试关闭的实施风险，不是授权扩大产品范围的开放需求。

## Out of scope

- Electron 主进程、preload、安装器、签名和自动更新。
- 预定义多 Case 流程 UI、自由拖拽流程设计器和新编排器实现。
- 人工修改产物、人工修订版本和多人批注。
- 账号、鉴权、角色、权限、多用户、远程或局域网部署。
- 自定义 CSRF Token、Host/Origin/Fetch-Metadata 来源认证框架。
- Provider 凭据管理；凭据继续由 Pi 管理。
- 通知、邮件、系统托盘提醒。
- Word/PDF 转换、二进制原始文件、批量下载或批量任务。
- 深色模式、完整移动端、手机操作体验。
- 项目/工作空间层级、标签管理后台和生产证据永久清理。
- 分布式队列、远程数据库、全文搜索集群、大规模性能设施。
- CAS 垃圾回收和包含 DB/CAS/Session 的完整灾备导出。
