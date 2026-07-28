# Forge UI 技术需求文档

> 状态：技术需求拷问进行中
> 当前版本：0.10
> 首次建立：2026-07-29
> 对应产品需求：`docs/Forge_UI_需求文档.md`

## 1. 文档定位

本文档记录 Forge UI 产品需求冻结之后的技术需求、架构决策、约束、风险和待确认问题。

当前阶段只进行技术需求发现和方案收敛，不实施代码。全部技术分支确认后，再生成实施计划并进行只读对抗评审。

技术设计必须继续遵守：

- `contracts → domain → application → adapters → apps` 单向依赖；
- 通用平台不写死业务角色、阶段或产物类型；
- 模型不接触工程元数据；
- 交付由系统门禁决定；
- 产物和事件只追加、不覆盖；
- UI 不产生第二套生产状态；
- API Key、Token、Authorization Header 和模型隐藏思维链不得进入 UI、日志或业务数据；
- P0 必须通过真实 Pi、真实持久化和真实崩溃恢复验收。

## 2. 已确认架构方向

### TD-001 Next.js UI 与 BFF

保留现有 Next.js 应用，但重建其服务端边界：

- 浏览器只调用类型化 HTTP API；
- Next.js 服务端作为轻量 BFF，通过 application 层的查询服务和命令服务访问 Forge；
- Web 不再自行定义并执行 SQLite 业务查询；
- Web 不再通过拉起 CLI 子进程完成创建、运行或恢复；
- Worker 继续作为独立执行进程承担长时间 Agent 运行；
- 当前阶段不新增独立 Fastify 等 API 服务；
- 未来若出现远程部署、多用户或独立扩缩容需求，可以从 BFF 后拆出独立服务。

### TD-002 Electron 后续封装约束

Electron 是后续桌面交付形态，本轮先保证架构可封装，不立即建设 Electron 应用。

推荐封装方式：

- Electron 主进程启动随应用打包的 Next.js standalone 本地服务；
- Next 服务只绑定 loopback 地址和动态或受控本地端口；
- `BrowserWindow` 加载该本地地址；
- Electron 主进程统一管理 Next 服务、Forge Worker 和应用窗口的启动、健康检查、异常退出与关闭；
- 用户只需启动桌面应用，不需要手工执行 Web 或 Worker 启动命令；
- 不采用 Next.js 静态导出，因为 Forge UI 需要 BFF、SQLite、Worker 控制和其他 Node 服务端能力；
- Renderer 保持沙箱和上下文隔离，不开启 Node.js 集成；桌面原生能力只通过最小化 preload API 暴露；
- SQLite、Pi Session、日志和用户配置使用可配置的应用数据目录，不能依赖仓库工作目录；
- 打包时需要处理 `better-sqlite3` 等原生模块与 Electron ABI 的兼容和重建；
- Electron 退出前必须安全处理正在运行的 Worker，不能因窗口关闭而直接破坏生产证据。

该方向与 Next.js 官方 standalone 自托管能力、Electron 主进程和 Renderer 进程模型一致：

- [Next.js Self-Hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Next.js output 配置](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output)
- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)

### TD-003 Worker Supervisor 与 Case 进程隔离

采用“常驻 Supervisor + 持久化命令 + 每个 Case 独立 Worker 进程”的执行模型：

- BFF 只向 application 层提交运行、暂停、恢复和停止等命令，不直接创建 Worker 或 CLI 子进程；
- 命令在数据库中持久化，并具有稳定命令 ID、幂等键、状态、创建时间和处理结果；
- 常驻 Worker Supervisor 领取命令，并按照可配置的并发上限调度；
- 每个正在执行的 Case 使用独立 Worker 子进程，单个 Case 的 Provider、Pi Session 或未捕获异常不应直接击穿其他 Case；
- Worker 子进程必须继续使用现有执行租约、runner token 哈希和心跳机制确认执行所有权；
- Supervisor 只负责命令领取、进程生命周期和可观测性，不替代 Case 状态机，也不伪造业务状态；
- 子进程异常退出后，由持久化证据和 RecoveryService 判定 Case 是否可以恢复，不能由 Supervisor 直接标记成功或强制重跑；
- 同一命令被重复提交、Supervisor 重启或领取后崩溃时，必须依靠幂等与租约机制避免重复执行；
- Web 部署时 Supervisor 作为独立后台进程运行；Electron 封装后由 Electron 主进程启动和监控；
- 应用关闭、升级和系统关机时的排空、暂停、强制终止和恢复语义留待后续专项确认。

### TD-004 生产任务与 Case 分离

新增独立的 `production_tasks` 产品聚合，不把草稿、标签、归档等产品字段继续塞入 `cases`：

- `production_tasks` 保存用户可管理的信息，包括标题、模板修订身份、草稿输入、Agent 模型覆盖、运行环境、标签、来源任务、归档、回收站和草稿修订号；
- 草稿阶段允许修改；任务启动后，输入、模板修订、环境和模型配置冻结；
- 启动操作必须在一个受控事务中冻结任务配置、创建 Case 并建立任务—Case 绑定，任何一步失败都不能留下“显示已启动但没有可运行 Case”的半成品；
- 当前单模板任务绑定一个 Case；未来预定义流程任务可以通过绑定关系关联多个 Case；
- `cases` 继续保存不可随意修改的执行事实、运行身份和证据；
- `cases.created` 表示已经创建但尚未执行的 Case，不再兼任 UI 草稿；
- 运行中、等待、失败、停止和交付等任务状态从绑定的 Case 或未来流程运行投影得出，不在 `production_tasks` 中复制维护第二套运行状态；
- 归档和回收站属于任务可见性元数据，不改变 Case 状态和执行证据；
- 回收站只允许未启动草稿进入；已启动任务只能归档；
- “基于此任务创建新任务”复制已允许的配置形成新草稿，并通过来源关系关联；不复制 Case、产物、Issue、返修、门禁或执行 ID；
- 草稿修订号用于后续自动保存的乐观并发控制，具体冲突体验继续单独确认。

### TD-005 文件创作源与不可变模板注册库

采用“文件系统 Scenario Bundle 作为创作和导入来源，Forge 模板注册库保存不可变修订”的混合模型：

- 现有 `scenario.yaml + prompts + skills + validators` 继续作为可移植的模板创作格式；
- Forge 发现或导入 Bundle 时先执行完整校验，成功后注册不可变模板修订；
- 每个模板修订具有稳定修订 ID、场景 ID、场景版本、配置快照、完整 Bundle 哈希、来源信息、资源清单、父修订 ID、导入时间和校验结果；
- 模板资源按 Bundle 哈希内容寻址，导入后放入受 Forge 管理的不可变存储目录；Electron 环境使用应用数据目录；
- 草稿绑定明确模板修订 ID，不因源目录内容变化或新修订出现而静默升级；
- 启动时把模板修订 ID、配置快照和 Bundle 哈希冻结到生产任务与 Case 证据；
- 恢复时必须加载完全相同的不可变修订；修订资源缺失、哈希不一致或校验失败时 fail closed；
- UI 修改 Agent 默认模型时，基于原修订创建派生模板修订，并重新校验；不得覆盖原 YAML、原修订或已启动任务；
- 从外部文件重新导入相同 Bundle 哈希时复用已有修订，避免生成内容完全相同的重复版本；
- 被草稿、任务、Case、产物或门禁证据引用的模板修订不得删除；
- 模板注册库保存元数据和身份，具体资源采用文件内容寻址存储还是数据库 BLOB 留到存储设计时确认，但 Runtime 不得继续依赖可变源目录。

### TD-006 Pi 模型目录发现与 Forge 策略叠加

Provider 的注册、认证和模型事实目录归 Pi 管理；Forge 通过 Pi 的公开模型目录能力发现可用 Provider/Model，并叠加产品策略：

- 新 Provider、认证方式和凭据在 Pi 中添加，不在 Forge 中重复实现；
- Forge 通过受控 Adapter 调用 Pi `ModelRuntime` 的 `getProviders()`、`getModels()`、`getAvailable()` 和认证状态接口；
- “扫描 Pi 目录”指调用 Pi 的公开运行时 API，不读取或解析 Pi 的私有配置文件、缓存目录或内部数据库；
- Pi 返回 Provider、模型、能力和可用性事实；Forge 只维护允许列表、禁用规则、默认值、显示名称和顺序等产品策略；
- application 层的模型目录查询服务合并 Pi 事实与 Forge 策略，再向 BFF 返回脱敏 DTO；
- UI 可以查看 Provider/Model 和非敏感连接状态，并从允许且可用的模型中选择；
- Forge 不返回认证类型细节、凭据路径、API Key、Token 或 Header；
- 草稿保存每个 Agent 的 `provider_id + model_id` 以及“跟随模板”或“任务覆盖”来源；
- 启动时再次通过 Pi 校验模型存在且可用，然后把每个 Agent 的准确 Provider/Model 冻结到任务、Case 和 Session 证据；
- `RealPiAdapter` 必须按 Agent 接收准确 Provider/Model，不再固定 `deepseek` 或只读全局 `PI_MODEL_ID`；
- 恢复必须使用原 Provider/Model；原模型缺失或不可用时 fail closed，不允许静默替换；
- Provider/Model 目录的刷新、缓存和失效体验继续单独确认。

### TD-007 模型目录刷新与失效处理

Forge 对 Pi 模型目录采用“启动扫描 + 手动刷新 + TTL 后台刷新 + 最近成功快照”：

- BFF 或模型目录服务启动时异步扫描 Pi 公开目录接口，并设置明确超时；
- UI 提供显式刷新入口，新增 Provider 或模型后无需重启 Forge；
- 使用可配置 TTL 触发后台刷新，不监听或轮询 Pi 私有文件；
- 只持久化最近一次成功的非敏感目录快照、目录版本/哈希和刷新时间；
- 扫描失败时可以用最近成功快照支持查看和草稿编辑，但必须显示“目录可能已过期”和最近成功刷新时间；
- 没有成功快照时，模型选择器进入不可用状态并提供刷新与诊断入口；
- 任务启动前必须绕过缓存，通过 Pi 实时校验所有已选 Provider/Model；
- 实时校验失败时保持草稿，不创建 Case、不提交运行命令，并返回可操作错误；
- 已启动 Case 恢复时同样实时校验冻结模型；不可用时进入可解释的阻塞或恢复失败状态，不选择替代模型；
- 并发刷新需要合并，避免多个页面或请求同时触发重复网络刷新；
- 目录快照不包含 API Key、Token、Header、凭据路径或其他认证材料。

### TD-008 application Query/Command 与类型化 REST BFF

采用轻量 CQRS 边界，由 application 层向 Next.js BFF 提供明确的查询服务和命令服务：

- Query Service 返回面向 UI 的只读投影，包括任务列表、任务概览、执行记录、产物阅读、产物演进链、模板目录和模型目录；
- Command Service 承担保存草稿、启动、基于已有任务创建、归档、恢复草稿、暂停、恢复、停止、人工回答和刷新目录等用例；
- Query/Command 输入输出在 `contracts` 中使用 TypeBox 定义并进行运行时校验；
- BFF 使用明确的 REST Route 映射 application 用例，不引入 GraphQL、tRPC 或通用 CRUD；
- BFF 不直接暴露 `RepositoryPort`，不返回 SQLite 行、领域内部对象或任意字段更新能力；
- 普通短命令返回明确结果；需要 Supervisor 异步处理的长时间命令返回 HTTP `202`、稳定 `command_id` 和当前命令状态；
- API 错误使用稳定错误码、用户可理解信息和可选脱敏诊断引用，前端不得解析异常字符串判断行为；
- DB 路径、runner token、租约所有权、进程 PID、凭据和其他内部控制字段不得进入普通浏览器响应；
- Query Service 可以为了 UI 读取多个持久化对象并形成投影，但业务规则和状态判定必须复用 domain/application 能力，不能在 BFF 重写；
- application 服务不依赖 Next.js、HTTP、SQLite 或 Electron；BFF 只负责协议适配、身份无关的输入校验和响应映射；
- API 版本、分页游标、错误码表和具体 Route 结构在实施计划中固化。

### TD-009 SSE、持久化事件游标与轮询降级

实时更新采用单向 SSE，命令继续通过 REST 提交，不引入 WebSocket：

- application 在重要持久化变化的同一事务中追加轻量 UI 事件或事务性 outbox 记录；
- 事件只包含递增序号、事件类型、对象类型、对象 ID、发生时间和必要的版本引用，不复制产物正文、上下文或其他大型业务数据；
- Next.js BFF 提供 SSE 事件流，浏览器收到事件后按对象和版本失效或重新读取对应 Query 投影；
- 事件源必须来自持久化事件表，不能只使用进程内 `EventEmitter`，确保 BFF、Supervisor 和 Case Worker 跨进程一致；
- 浏览器断线重连时携带 `Last-Event-ID`，服务端从持久化游标之后继续发送；
- 游标早于事件保留窗口、事件出现缺口或服务端无法保证连续性时，发送 `resync_required`，客户端重新获取完整投影；
- SSE 连接失败或运行环境不支持时，降级为携带版本游标的轻量轮询，不再定时刷新整个页面；
- 事件至少覆盖任务、命令、Case、Turn、产物、Issue、返修、门禁、人工介入和模型目录变化；
- 当前页面位于最新位置时可以根据事件自动跟随；用户查看历史时只增加“有新进展”状态，不改变滚动或选中位置；
- SSE 事件不携带秘密或未脱敏诊断信息，客户端收到事件后仍需通过受控 Query 获取数据；
- 事件保留周期、清理方式、连接心跳和批量合并策略在实施计划中确定。

### TD-010 幂等键、乐观并发与数据库 CAS

所有写操作统一采用幂等请求协议，并根据对象类型使用修订号或预期状态进行并发保护：

- 每个用户意图生成稳定 `idempotency_key`，网络重试、页面重试和超时重试必须复用原键；
- 数据库对目标作用域、操作类型和幂等键建立唯一约束；
- 重复请求返回第一次请求的相同 `command_id`、当前状态或已完成结果，不重复产生副作用；
- 草稿写入携带 `expected_revision`，成功后原子递增修订号；
- 状态命令携带预期 Case 状态、控制版本或对应待处理行为 ID，并在事务中使用 CAS；
- 对象已经变化时返回 HTTP `409`、稳定冲突错误码和最新安全投影，前端不得自动覆盖；
- 启动任务在同一事务中完成草稿校验、配置冻结、Case 创建、任务—Case 绑定、运行命令追加和 UI 事件追加；
- 重复启动不能创建多个 Case；事务失败不能留下部分冻结或无绑定 Case；
- 人工回答绑定准确的 `request_human_input` 工具行为 ID，同一个请求只能成功回答一次；
- 暂停、恢复和停止必须同时验证目标状态、执行租约和已有控制命令，冲突时 fail closed；
- Supervisor 使用命令租约、心跳和 CAS 领取异步命令；领取者崩溃后允许安全重新领取，但不能重复执行业务副作用；
- 前端按钮禁用、loading 状态和防抖只用于改善体验，不能替代服务端幂等和并发校验；
- 幂等结果需要保留到相关任务和 Case 的数据保留周期结束，具体压缩策略在运维设计中确定。

### TD-011 权威事实按需生成 UI 投影

P0 的任务列表、概览和关联摘要从权威持久化数据按需计算，不新增不可重建的 UI 状态表：

- `TaskListQuery` 和 `TaskOverviewQuery` 从 `production_tasks`、任务—Case 绑定、Case、Turn、产物、Issue、返修、门禁和控制事件组装 UI DTO；
- 任务运行状态从绑定的 Case 或未来流程运行计算，不在任务表复制；
- 当前有效产物由统一的 domain/application 选择策略计算，BFF 和前端不得自行按“最新版本”猜测；
- 待办、阻断原因、可执行动作和下一步由 application 规则生成；
- 同一次投影读取使用一致的 SQLite 读事务或等价快照，避免各卡片读取到不同时间点；
- 投影返回 `source_event_seq`、对象修订号或 ETag，支持 Query 缓存、SSE 失效和冲突检测；
- 列表只加载必要摘要；执行记录、长正文、版本历史、Diff 和诊断证据分别分页或按需读取；
- 不在 `production_tasks` 中复制 `running`、当前产物 ID、Issue 数量、门禁结果等派生事实；
- P1 只有在性能测试证明按需计算无法满足目标时才增加物化投影；
- 物化投影必须可丢弃、可重建、带来源游标，不能参与状态机、门禁、恢复或执行决策；
- 投影重建失败只能影响读取体验，不能修改权威业务数据。

## 3. 当前代码基线

- `apps/web` 使用 Next.js 14 App Router；
- 页面服务端组件通过 `apps/web/lib/db.ts` 直接读取 SQLite；
- 创建、运行、恢复 API Route 当前通过 CLI 子进程完成操作；
- Web 内重复定义了部分数据库记录类型和查询；
- `apps/worker` 当前是一次执行一个新 Case 或恢复一个 Case 的进程入口，不是常驻任务调度器；
- `RealPiAdapter` 当前统一使用 `deepseek` Provider 和全局 `PI_MODEL_ID`；
- `CaseRunner` 创建和恢复 Pi Session 时尚未把每个 Agent 的模型作为真实运行参数传入；
- SQLite 已持久化 Case、租约、Session、Turn、消息、路由、产物版本、Issue、返修、上下文、门禁、工具行为和控制事件。

## 4. 待继续拷问

1. 模板驱动的阶段与步骤定义；
2. 当前有效产物选择规则；
3. 自动保存与草稿冲突；
4. 脱敏和诊断数据边界；
5. SQLite 迁移与兼容策略；
6. 测试、真实 Pi 和崩溃恢复验收；
7. Electron 打包、数据目录、升级和进程生命周期。

## 5. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.10 | 2026-07-29 | 确认从权威事实按需生成 UI 投影，并将物化视图限制为可重建优化。 |
| 0.9 | 2026-07-29 | 确认所有写操作的幂等键、预期修订/状态、CAS、冲突返回和命令租约。 |
| 0.8 | 2026-07-29 | 确认 SSE、持久化事件游标、断线回放、全量重同步和轮询降级。 |
| 0.7 | 2026-07-29 | 确认 application Query/Command Service、共享 TypeBox Contract 和类型化 REST BFF。 |
| 0.6 | 2026-07-29 | 确认模型目录的启动、手动、TTL 刷新，最近成功快照和启动前实时校验。 |
| 0.5 | 2026-07-29 | 确认 Provider 在 Pi 注册、Forge 通过公开 API 发现目录并叠加允许策略。 |
| 0.4 | 2026-07-29 | 确认文件创作源、不可变模板注册修订、内容寻址和恢复引用规则。 |
| 0.3 | 2026-07-29 | 确认 production_tasks 与 Case 分离、启动冻结事务和状态投影边界。 |
| 0.2 | 2026-07-29 | 确认常驻 Supervisor、持久化命令和每个 Case 独立 Worker 进程的执行模型。 |
| 0.1 | 2026-07-29 | 建立技术需求文档；确认 Next.js BFF 方向和 Electron 后续封装约束。 |
