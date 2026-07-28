# Plan: Forge UI 产品化与本地运行链路重建
_Locked via grill — by Claude + user_

## Goal

在不破坏 Forge 现有领域规则、追加式证据和真实 Pi 能力的前提下，把当前“CLI/单 Worker + 只读回放页”重建为面向个人内容生产操作者的本地 Web 产品：用户通过 `forge ui` 启动一套可恢复的 BFF、Supervisor 和独立 Case Worker，能够创建与管理生产任务、选择并冻结每个 Agent 的真实 Provider/Model、观察 Agent 生产过程、查看产物演进、处理人工介入以及安全暂停、恢复和停止。P0 必须以真实持久化、真实 Pi、真实进程强杀和可运行证据验收；P1 在同一架构上补齐冻结产品需求中的工作台、模板、诊断和体验能力。Electron 仅保留未来封装边界，本计划不实现 Electron。

## Approach

1. **固定基线与建立可重复验收入口**
   - 记录当前 Node、npm、Pi 包、SQLite Schema、production/test DB 解析规则和现有测试结果。
   - 为后续迁移准备脱敏旧库 fixture；确认现有两场景继续证明平台无业务硬编码。
   - 把 `npm run check`、Vitest、Fake Pi E2E、真实 Pi E2E 的命令与证据输出格式固定下来。
   - 在任何 UI 美化前先建立“未完成能力清单”，禁止用 Fake Pi、静态页面或文字说明替代真实链路。

2. **先验证三项高风险外部假设**
   - 用当前 `@earendil-works/pi-*` 公开 API 验证 Provider/Model 目录枚举、可用性检查和认证状态的准确接口；不读取 Pi 私有配置。
   - 验证 `createAgentSession`/`resumeSession` 能按 Agent 接收并恢复准确 `provider_id + model_id`，并确认 Session 持久化中可用于崩溃核对的公开身份。
   - 验证 Windows 下 Worker 进程身份、心跳、受限 IPC 握手和 Supervisor 重启接管方式；PID 仅作诊断，不作为所有权。
   - 若任一 Pi 假设不成立，先更新 Adapter Contract 和技术文档，不在实现中静默回退到硬编码 Provider、全局模型或私有目录扫描。

3. **建立显式迁移系统，再修改业务 Schema**
   - 在 adapters 层增加版本化 migration runner、`schema_migrations`、checksum 校验、独占迁移锁、WAL checkpoint 和 SQLite Backup API。
   - 把当前 `SqliteRepository` 构造函数中的零散 `ALTER TABLE` 迁出；应用声明最低/最高支持 Schema。
   - 为 production/test 两库分别执行预检、备份、迁移和失败回滚；旧应用遇到新 Schema 时拒绝写入。
   - 测试空库、历史 fixture、重复运行、checksum 被改、中途失败、磁盘不足、并发连接和备份恢复。

4. **扩充 Contract 与权威持久化模型**
   - 在 `packages/contracts` 定义 TypeBox DTO、稳定错误码、action descriptor、幂等请求、修订/CAS、Query 游标和 UI 事件 Contract。
   - 新增生产任务、任务来源、标签、不可变模板修订/资源清单、模型选择来源、持久化命令、命令租约、UI outbox 事件、配置修订和 Worker 实例身份。
   - 扩充 Case 状态机以支持 `paused`，保存可恢复的暂停前状态/检查点；排队状态只从命令事实投影，不写入 Case。
   - 修正 Artifact 当前有效指针：候选版本不替换有效版本，批准事务原子完成旧版 supersede、新版 approve、指针切换和事件追加。
   - 为 Turn Journal 和工具行为增加稳定身份、阶段、请求/响应哈希、租约 generation、结果未知和幂等字段；迁移历史 Turn 时不改写正文和既有证据。

5. **实现应用数据目录、配置和模板 CAS**
   - 增加平台路径 Adapter：production 默认 `%LOCALAPPDATA%\ForgeAI`，CLI 参数和 `FORGE_DATA_DIR` 按既定优先级覆盖；开发与自动化测试使用隔离目录。
   - 建立 `db/`、`sessions/`、`templates/`、`logs/`、`backups/`、`runtime/`、`cache/` 结构和安全路径校验。
   - 实现带 `schema_version`/revision 的非敏感 `config.json`，TypeBox 严格校验、原子替换、最近有效备份和热更新/重启边界。
   - 实现模板 staging、Bundle 校验、文件 CAS、SHA-256 去重、原子移动、孤立对象宽限清理和数据库元数据事务。
   - Runtime 只按冻结模板清单加载并复核对象哈希；草稿、Case 或证据引用的修订不可删除。

6. **建立 application Query/Command 边界**
   - 新增 ProductionTask、TemplateRegistry、ModelCatalog、Settings、CommandQueue 和 UI Query 应用服务。
   - 保存草稿使用完整快照、`expected_revision` 和幂等键；启动事务完成草稿校验、模板/模型冻结、Case 创建、任务绑定、运行命令与 UI 事件追加。
   - production/test 写操作显式选库；`all` 只用只读 Repository 合并任务摘要并拒绝命令。
   - Query 统一计算任务状态、当前有效/最新创建/交付产物、待办原因和合法动作，BFF/前端不重写状态规则。
   - 所有诊断写入前经过 `SecretSanitizer`；Query、复制和下载再执行防御性脱敏，隐藏思维链永不采集。

7. **用分阶段 Turn Journal 替换跨 `await` 长事务**
   - 先用短事务提交 Turn intent、上下文引用和 `model_running`，再在事务外调用 Pi。
   - 由于 Pi Agent Runtime 可能在模型调用期间内联执行工具，Adapter 必须在每次工具回调前持久化稳定 `tool_action_id` 和参数哈希，再在短事务中原子提交 Forge 内部副作用与工具完成记录；不能假设所有工具清单一定在副作用前一次返回。
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
   - Supervisor 崩溃时健康 Worker 继续；新 Supervisor 通过 DB 证据与受限 IPC 握手接管监控，不能仅凭 PID 强杀或重复启动。
   - 暂停/停止是持久化命令。Worker 在完整 Pi Turn 后检查：暂停成功保存检查点并退出；停止原子进入终态。
   - 暂停强杀进入 `waiting_recovery`；停止强杀经证据核对后收敛为 `stopped`，未知外部结果不自动重试。

10. **实现类型化 REST BFF、持久化 SSE 与本地启动器**
    - 重建 `apps/web` 服务端 composition root，只调用 application Query/Command；删除页面直读 SQLite和 API Route 拉 CLI。
    - REST 写请求携带幂等键和预期修订/状态；异步命令返回 `202 + command_id`。
    - 在业务事务中追加轻量 outbox/UI 事件；SSE 支持 `Last-Event-ID`、保留窗口、`resync_required` 和轻量轮询降级。
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
    - Vitest 覆盖 domain、application、迁移、命令、CAS、Turn Journal、模型冻结和恢复不变量。
    - React Testing Library 覆盖表单、冲突、错误、合法动作和交互组件。
    - Playwright 启动真实 BFF/Supervisor/Worker/SQLite + Fake Pi，跑完整操作者路径和少量稳定视觉回归。
    - 进程级测试真实终止子进程并使用原数据目录恢复，覆盖七个冻结故障窗口。
    - 运行秘密泄漏扫描，检查数据库、日志、REST、SSE、复制、下载和验收报告。

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
- **个人本地规模优先**：不预建虚拟列表、全文索引、复杂 Diff 服务、权限体系或分布式基础设施。
- **真实 Pi 与强杀门禁前不抛光 UI**：避免再次出现“Fake 演示 + UI 完成但真实运行未完成”的失败模式。

## Risks / open questions

- 当前 Pi 0.82 公开目录 API、模型选择参数和 Session 核对能力的准确形态需要在步骤 2 用可运行探针证明；若能力缺失，必须先调整 Contract，不能读取 Pi 私有文件兜底。
- Pi Agent Runtime 可能在一次模型调用中内联多次工具执行，Turn Journal 必须通过工具回调生命周期记录 intent/effect，而不能依赖“完整响应先于全部工具”的理想顺序。
- Windows 上 Supervisor 崩溃后对存活 Worker 的重新握手需要证明不会误认 PID、不会泄露 runner token，也不会因终端关闭意外杀死整个进程树。
- 从现有跨 await Turn 事务迁移到 Journal 时，历史 Case 和新 Case 的恢复路径必须有明确 Schema/版本边界；不支持混用两种执行器继续同一未完成 Turn。
- 模板 CAS 与数据库元数据无法依靠单个 SQLite 事务覆盖文件系统，需要用 staging、原子 rename、提交顺序和孤立对象回收保证“数据库不引用缺失对象”。
- 真实 Provider 调用在缺少上游幂等协议时无法保证费用 exactly-once；Forge 只承诺业务副作用不重复，并对未知调用结果 fail closed。
- 这些项目是需要用 spike 和测试关闭的实施风险，不是授权扩大产品范围的开放需求。

## Out of scope

- Electron 主进程、preload、安装器、签名和自动更新。
- 预定义多 Case 流程 UI、自由拖拽流程设计器和新编排器实现。
- 人工修改产物、人工修订版本和多人批注。
- 账号、鉴权、角色、权限、多用户、远程或局域网部署。
- Provider 凭据管理；凭据继续由 Pi 管理。
- 通知、邮件、系统托盘提醒。
- Word/PDF 转换、二进制原始文件、批量下载或批量任务。
- 深色模式、完整移动端、手机操作体验。
- 项目/工作空间层级、标签管理后台和生产证据永久清理。
- 分布式队列、远程数据库、全文搜索集群、大规模性能设施。
