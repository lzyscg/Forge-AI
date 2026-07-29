# Plan Review Log: Forge UI P0

Act 1 (grill) complete — product and technical decisions were locked with the user across the Forge UI requirement review. MAX_ROUNDS=5.

Current source model:

- `AGENTS.md`：铁律、安全与架构依赖；
- `docs/Forge_UI_需求文档.md`：产品语义和 P0/P1 边界；
- `docs/Forge_UI_技术需求文档.md`：技术协议和运行拓扑；
- `docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`：不违反前三者的逐 Task 执行清单；
- `docs/specs/Forge_UI_P0_自主开发交接_Spec.md` 与 `docs/specs/Forge_UI_P0_交接记录.md`：交接、外部输入、授权和停止规则。

`PLAN.md` 只做摘要；本文件只做审查追溯。历史轮次中的“规范性文件”或已被后续修订废止的方案，不得覆盖上述当前来源。

## Round 1 — Codex

结论：计划尚不适合直接实施。以下问题会导致旧库风险、重复副作用、恢复失真或发布链路无法成立。

1. **运行时基线错误。** 计划声明 Node 20+，但 Pi 0.82 实际要求 Node `>=22.19.0`。
   Fix: 全仓、CI、README 和发布门禁统一到 Node `>=22.19.0`，精确锁定 Pi 版本并使用 `npm ci`。
2. **异步模型校验被错误放入 SQLite 原子事务。** `ModelRuntime.getAvailable()` 是异步外部 I/O，不能在 better-sqlite3 写事务内执行。
   Fix: 事务外取得带目录哈希和时效的验证凭证，事务内只 CAS 草稿、目录快照并冻结。
3. **迁移缺少安全措施。** Task 2 没有 SQLite Backup API、WAL checkpoint、恢复演练、磁盘阈值或独占迁移锁。
   Fix: 独占锁下 checkpoint/关闭旧连接，使用 Backup API 创建并校验备份，并测试活跃 WAL、空间不足、回滚和双进程竞态。
4. **旧库兼容假设过窄。** 现有构造器曾形成多个合法中间 schema。
   Fix: 为每个已发布 schema 建立真实 fixture/指纹和确定性升级路径，并验证证据行数、内容哈希和身份不变。
5. **外键不会自动生效。** 计划未要求 `PRAGMA foreign_keys=ON`、孤儿检查或 `foreign_key_check`。
   Fix: 引入统一连接工厂，重建前后执行孤儿检查、`foreign_key_check` 和 `integrity_check`。
6. **Task 2 会暂时破坏现有入口。** 移除 Repository 构造器建表时没有同步 Worker、CLI、Web 和测试。
   Fix: Task 2 同时引入唯一 `DatabaseBootstrap`，一次迁移所有入口为“迁移后打开”。
7. **租约 generation 没有成为真正写栅栏。** 失效旧 Worker 仍可能迟到写入。
   Fix: 所有 Worker 写携带 generation 与 worker identity，以 SQL CAS 验证当前租约；旧 generation 返回 `LEASE_LOST`。
8. **Turn Journal 仍允许双写和重复副作用。** 缺少 head/revision CAS、Case 内 Turn 序号唯一约束、参数哈希冲突和原子 outbox。
   Fix: 增加 journal head CAS、唯一约束，让 action ID、参数校验、领域副作用、结果和事件原子提交。
9. **实施顺序会先启用不安全恢复。** Supervisor 先于 Journal，产物有效指针修复也过晚。
   Fix: 先落地版本写入不变量与 Turn Journal，再允许 Supervisor 执行生产命令。
10. **Supervisor 崩溃后的命令所有权未闭合。** 没定义 Worker 如何独立完成命令及唯一 reconciliation。
    Fix: 命令启动时把执行所有权原子交给 Worker，并按 `command_id + generation` 补全命令及唯一完成事件。
11. **Pi 调用缺少可核对身份。** 相同输入哈希不能证明响应属于哪次调用。
    Fix: 持久化并传递唯一 invocation ID；Runtime 无法核对时，`model_running` 崩溃必须进入 `outcome_unknown`。
12. **隐藏推理可能进入 Pi Session 文件。** SDK 会把包含 `thinking` block 的完整 assistant message 持久化，扫描却未覆盖 `sessions/` JSONL。
    Fix: 前置探针验证 JSONL，将整个数据根、备份和浏览器存储纳入泄漏测试；若持久化 thinking，先实现可恢复的脱敏会话存储。
13. **loopback 被误当成请求来源保护。** 恶意网页或 DNS rebinding 仍可调用写接口。
    Fix: 强制允许的 Host、同源 Origin 和 `application/json`，拒绝跨域/CORS，加入 hostile-origin 与 DNS-rebinding 测试。
14. **公共 Contract 有任意数据逃逸口且输入无界。** `latest_projection?: unknown` 和无长度限制可能泄漏或耗尽资源。
    Fix: 使用逐操作白名单冲突 DTO，固定错误消息，增加 body、字符串、数组和分页上限及 `413` 测试。
15. **冻结路由与实现清单不一致。** 缺产物版本与 Diff Route；源码扫描命令会误命中 manifest/config。
    Fix: 补齐 routes，移除 Web 直接 DB 依赖，把扫描限定为源码 import。
16. **SSE 连续性和资源生命周期未闭合。** 缺游标、低水位、清理竞态、环境隔离、背压与断连清理协议。
    Fix: 按环境持久化高低水位，定义重放/resync 边界，加入分页、AbortSignal、背压、连接上限和无缓存响应头。
17. **构建和测试假设不成立。** 缺 Next standalone、脱离源码 smoke；Radix 没有 Drawer primitive；Web 测试缺 jsdom。
    Fix: 固化 standalone 打包清单，用 Radix Dialog 实现抽屉，增加 jsdom Web 测试配置。
18. **运维与可观测性切片缺失。** 缺关联日志、轮转、备份保留、磁盘门禁和恢复相关健康指标。
    Fix: 首个持久化任务前实现结构化脱敏 logger、关联 ID、健康字段、日志轮转、备份保留和磁盘门禁。
19. **progress 与 IndexedDB 冲突语义没有真正实施。**
    Fix: 冻结通用 progress evidence Schema 与归并规则，完整实现恢复日志清理、重开提示、多标签冲突和新草稿分叉。
20. **进程架构对本机 P0 过重且缺交付证明。**
    Fix: 补齐端到端进程/打包设计，或简化为一个本地 control-plane HTTP 进程加每 Case Worker。

VERDICT: REVISE

### Codex 的处理

- 接受 1–19，并修改规范性施工清单：运行时提高到 Node `>=22.19.0`；模型实时校验改为事务外短期票据；补齐迁移备份/外键/旧库 fixture/统一 Bootstrap；所有 Worker 写加入 generation 栅栏；Journal 增加 head CAS、invocation ID 和原子工具结果；把产物不变量与 Journal 提前到 Supervisor 之前；补齐命令交接、Pi JSONL 脱敏、Host/Origin、Contract 上限、Artifact Route、SSE 水位、standalone/jsdom、可观测性、progress 和 IndexedDB 协议。
- 不采纳第 20 项的“简化掉独立 Supervisor”选项。独立 Supervisor、每 Case Worker 隔离和 Supervisor 崩溃后 Worker 继续运行是技术需求 0.41 已冻结的恢复边界；若改为单 control-plane 进程会重新打开架构决策。作为回应，Task 11 增加脱离仓库源码的完整 standalone 打包 smoke test，使该进程架构必须以可交付证据成立。

## Round 2 — Codex

结论：第一轮风险已被显式覆盖，但多组协议仍彼此冲突，不能直接开工。

1. 离线迁移的文件锁无法阻止不认识新协议的旧进程继续写库。
2. pre-identity fixture 不可能保持原本不存在的 `db_instance_id`。
3. 拆分 Repository 后缺少共享连接/事务上下文，跨聚合原子性没有落点。
4. `UNIQUE(action_id,idempotency_key)` 仍允许同一 action 换幂等键重复执行。
5. command lease 与 execution lease 形成两套 liveness 权威。
6. pause/stop 在活跃 Worker、无 Worker 和恢复中的领取主体未闭合。
7. Supervisor 补齐终态命令与旧 generation 写栅栏冲突。
8. spawn throw、ready/ack 丢失和首个 heartbeat 延迟可能产生幽灵 owner。
9. 模型目录快照没有 Repository、并发 CAS 或任务引用。
10. 同一 Provider/Model ID 的底层配置可能在排队/恢复前变化。
11. Pi Session 脱敏只覆盖 message，没有覆盖工具、自定义 entry、Provider error 和 compaction。
12. Logger、Session 与 DB/Query 脱敏器出现顺序不一致。
13. Host/Origin 防护只保护 mutation，读接口和 SSE 仍暴露给 hostile Host。
14. SSE retention/replay 只写在 Web Route，缺 application/adapter 边界。
15. 初始 SSE 没有使用 Workspace 的 `source_event_seq`，且全局序号的跨环境空洞被误判为丢事件。
16. 轮询把 `projection_revision` 错当成 `event_seq`。
17. Workspace、Session、Artifact、Diff、模板资源等公共集合和正文仍有无界字段。
18. `presentation.progress` 没有进入现有 `ScenarioSchema`，工作区也没有明确调用 projector。
19. IndexedDB 恢复日志缺少 writer/sequence，跨标签清理可能丢草稿。
20. standalone smoke 没有真实 runtime build、dist exports 或 package 命令。
21. 真实 Pi 门禁没有消费 Fake Pi 已验证的同一不可变发布包。
22. Health 只有字段清单，没有 application Query、判定阈值或实例身份绑定。

VERDICT: REVISE

### Codex 的处理

- 接受 1–22。迁移改为在同一数据库级排他屏障内完成 Backup API、迁移和验证，并用忽略新文件锁的旧 Writer 进程测试；修正 pre-identity 身份断言。
- 引入单连接 `SqliteUnitOfWork`；稳定 action ID 与幂等键分别唯一；execution lease 成为交接后的唯一权威。子进程先 ready、再原子授予租约，并覆盖全部 spawn/ack/heartbeat 窗口。
- 控制命令由当前 Worker 或经过 Journal 分类的恢复 Worker领取；终态 Journal、Case、租约、run command 和 outbox 原子闭合，Supervisor 只允许执行无业务写的遗留 reconciliation CAS。
- 模型快照加入持久化端口、任务引用和非敏感配置指纹，Worker 打开/恢复 Pi Session 前再次实时核对。Pi JSONL 改为全 entry 类型的唯一白名单 sink，共用前置 `SecretSanitizer`。
- 所有 API 校验精确本地 authority；SSE/retention/health 增加 application 与 adapter 边界。SSE 从 Workspace 的 `source_event_seq` 起步并允许跨环境数字空洞，轮询独立使用 ETag。
- 为所有公共正文、数组和历史集合冻结分页/大小上限与 Artifact Diff Contract；把可选 `presentation.progress` 接入 Scenario 注册与 Workspace projector；IndexedDB 使用 task+writer+sequence 隔离。
- 增加 runtime `tsc -b`、dist exports、不可变 release manifest 和真正的 package smoke；Fake 与真实 Pi 门禁必须运行 Task 11 产生的同一发布目录。Health 冻结 `ready/status`、阈值、application Query 和 `instance_id + release_id` 绑定。

## Round 3 — Codex

结论：Round 2 多数问题已实质闭合，但迁移后的旧 Writer、Worker 交接、抽象依赖和若干边界语义仍需收口。

1. 旧 Writer 可能在排他锁释放后按旧协议继续写新 Schema。
2. 旧库/迁移备份可能已有未脱敏 Provider Error，与全数据根泄漏门禁冲突。
3. 预启动 Worker 尚无 lease，却被要求从 CLI 接收 generation。
4. 诊断 command timestamp 的失败被错误解释为 `LEASE_LOST`。
5. Journal 未冻结唯一 `owning_run_command_id`，reconciliation 可能完成错命令。
6. 死亡 Worker 后 pending stop 到 recovery Worker 的关联与 CAS 未定义。
7. 新 Supervisor 无法接管旧父子 IPC，live Worker handshake 不可交付。
8. application 直接命名 SQLite Unit of Work，违反分层依赖。
9. 全目录 Provider 指纹会让无关 Provider 变化阻断某个 Agent。
10. progress 要求 evaluation round，但 selector 列表没有 evaluation。
11. progress fallback 使用可清理 UI Event，长期任务可能回退。
12. UI Event prune 没有唯一生产 owner。
13. SSE 同时收到 query `after` 与 `Last-Event-ID` 时优先级不明，low watermark 定义也不精确。
14. 截断 Diff 声称有下载 action，但只有单版本下载 Route。
15. 复制标签页可能克隆 writer identity 并互删 IndexedDB 记录。
16. release ID 与包含自身的 manifest 哈希形成自指。
17. 发布包没有确定性收集非 Next 进程的完整生产依赖闭包。
18. Health 阈值存在 15 秒重叠，备份年龄和累计 sanitizer/outcome 指标无法恢复。
19. Pi 全入口 Session sink 可行性探针位置过晚。

VERDICT: REVISE

### Codex 的处理

- 接受 1–19。迁移改为新建不可变 DB generation 并原子切换 `active.json`；长超时旧 Writer 在释放锁后也只能写旧 generation。升级前先扫描历史敏感字段，命中时拒绝自动迁移且不复制到活动数据根。
- Worker 预启动参数移除 generation；唯一 execution lease 在 ready 后授予，诊断时间戳不再影响所有权。Journal 冻结 exact owning run command，stop 本身作为带 run/revision 关联的 recovery dispatch unit。
- 删除 Supervisor 重启后的 IPC 接管承诺，改为只观察 DB lease；application 依赖抽象 `TransactionScopePort`，SQLite Unit of Work 仅作为 Adapter 实现。
- 模型指纹缩小到 provider/model selection；progress 增加 evaluation selector，fallback 只依赖不可裁剪领域证据。Supervisor 成为带维护租约的唯一 event-prune owner。
- `Last-Event-ID` 在重连时优先，low watermark 定义为 last-pruned ID；截断 Diff 只提供两个版本下载链接，不虚假承诺完整 Diff 下载。
- 每个 document 初始化生成并 claim 新 writer ID；release manifest 明确排除自身，以规范化 payload manifest 计算 ID，并从锁文件收集全部生产依赖闭包。
- Health 使用无重叠窗口和可清除/滑动指标；Pi 0.82 全入口 sink-hook 探针前移为 Task 4 第一项阻断门禁。

## Round 4 — Codex

结论：Round 3 的主要闭环成立，但双库拓扑、完整旧进程隔离、恢复目标唯一性和若干跨任务依赖仍未冻结。

1. 摘要风险段仍残留“Supervisor 接管旧 IPC”的相反表述。
2. `active.json` 若持续校验可写 SQLite 文件哈希，首次正常写入后就会失效。
3. DB generation 不能阻止旧 Worker 写 Pi JSONL 或继续 Provider/tool 副作用。
4. Legacy secret 检测没有覆盖原始 DB/WAL、Pi JSONL、日志与备份。
5. 现有 production/test 双库与新单一 active pointer、全局事件序号假设冲突。
6. Task 2 使用 `TransactionScopePort`，文件清单却到 Task 4 才修改 port。
7. Stop recovery 只有局部 Journal revision，没有唯一 Turn/owning command。
8. 首个 prepared 之前的正常 stop 没有 no-Journal 路径。
9. Journal owning command 没有校验 environment/task/Case/type/status/lease 归属。
10. Task 7 调用 Task 8 才创建的 `UiEventService`，逐任务不可编译。
11. Prune maintenance lease 与失败状态没有持久化 Schema。
12. Event append 没有同事务推进 high watermark。
13. Progress stage/step/round 仍无公共上限。
14. Evaluation selector 没有权威、不可变的结构化 evidence。
15. IndexedDB 旧 writer snapshot 恢复后无法安全清理旧记录。
16. SSE reset 没有终止帧和 close→reload→单次重连协议。
17. 模型指纹 Schema 仍是单数旧字段，且没有覆盖 capability/context 漂移。
18. 同一发布物的 Fake/Real 启动能力与测试钩子隔离未冻结。
19. Health 没定义 heartbeat 缺失，真实 Pi 故障门禁也没校验最终健康收敛。

VERDICT: REVISE

### Codex 的处理

- 接受 1–19。删除旧 IPC 接管残句；把 generation 指针中的哈希改为仅用于迁移来源证明的 `initial_image_sha256`，后续只验证 generation、DB identity 与 Schema。
- 保留 production/test 双库，每环境使用独立 pointer/generation/event cursor；一个运行实例只绑定一个环境，`all` 仅保留只读 CLI 聚合。迁移必须用完整旧 Worker/子进程与文件句柄探针证明其已经退出，否则 `MIGRATION_PROCESS_ACTIVE` 阻断采用旧 data root。
- Legacy detector 扩展到完整旧数据根和 DB 原始页/WAL/SHM；Task 2 显式修改 ports 并冻结同步事务回调。Stop recovery 使用 target kind 与 `turn_id + revision + owning_run_command_id` 联合 CAS，并加入 no-Journal 竞争路径；prepared 事务校验 owning command 的完整归属。
- Prune wiring 后移到 Task 8，Task 2 增加维护租约和持久化结果；event append 与 high watermark 同事务。Progress 固定 stage/step/round 上限，新增不可变 `evaluation_evidence`。
- IndexedDB 增加用户授权的旧 writer adoption/tombstone 原子协议；SSE 增加 `stream_reset` 终止帧和单次重连熔断。模型指纹改为 provider/model map，并纳入 descriptor、capabilities、context 与 compatibility。
- 发布包冻结正常 real-Pi 入口和 capability-bound test-driver；正常入口拒绝 Fake/checkpoint 参数，真实门禁证明 `test_hooks_enabled=false`。缺失 heartbeat 明确 unhealthy，所有真实故障窗口和最终状态都校验 readiness/status/reason allowlist。

## Round 5 — Codex

结论：Round 4 的绝大多数问题已闭合，最终仍有 6 个阻断性矛盾。

1. Worker 已交接、run command 已是 `running`，但首个 Journal 前崩溃时 no-Journal stop 只允许 `queued | dispatching`。
2. Health 依赖 Supervisor heartbeat，迁移 Schema 却只有 Worker heartbeat。
3. `saveDraft` 要求幂等键，但服务端和 IndexedDB 都没有持久化 key/payload hash/response 以覆盖 ACK 丢失。
4. Task 5 创建 event append repository，Task 8 才要求同事务推进 high watermark，任务归属过晚。
5. Task 7/11 新增 workspace 却没有同步更新 `package-lock.json`，后续 `npm ci` 会失败。
6. Task 11 smoke 使用只允许真实 Pi 的正式 launcher，却又要求创建 Fake Pi 任务。

VERDICT: REVISE

### Codex 的最终处理

- 接受 1–6。No-Journal stop 新增 exact old worker/lease generation 栅栏，并允许在该租约失效后由 recovery Worker 安全闭合 `running` 命令。
- Task 2 新增每环境 `supervisor_instances`；Task 7 用 generation CAS 领取并按 5 秒心跳更新，Task 8 Health 只读取该权威记录。
- Task 2 新增 scoped `mutation_idempotency`；草稿事务保存 payload hash 与 bounded response，IndexedDB 恢复记录保存并复用同一 key/hash 直到精确 ACK 清理。
- Event append 与 high watermark 的原子测试和实现前移到 Task 5；Task 7/11 明确修改 lockfile。
- Task 11 smoke 先证明正式入口拒绝测试 capability，再通过 packaged test-driver 运行 Fake 链路。
- 同时修正最终扫描发现的残留：`source_event_seq` 明确为当前环境序号，Task 1 冻结 `SseStreamResetSchema`，Task 2 文件清单补入完整旧进程/句柄探针。

达到 `MAX_ROUNDS=5` 后不再开启新一轮外部审查；主 Agent 仅对上述已报告阻断项执行逐条闭环与本地一致性校验，不再扩张方案范围。

## 实施阻塞专项审查 — Codex + 用户

日期：2026-07-29

范围：Task 2 SQLite 迁移协议、Pi 0.82 Session/Agent 循环、Turn/Action Journal、进程故障门禁与本地发布包。

方式：先验证用户报告的 Backup API 阻塞，再对修订方案进行五轮只读反证审查；不修改业务代码。

### 已确认的原计划阻塞

1. 同一个 SQLite connection 持有 `BEGIN EXCLUSIVE` 时运行 Backup API 的协议不可满足，替换 native Adapter 不能改变该 C API 边界。
2. Pi `SessionManager` 没有可替换的公开持久化 sink，`SanitizedSessionManager` JSONL 包装方案不可交付。
3. Pi 原生 `prompt()` 内包含模型—工具—模型循环，原线性 `model_running → response_recorded → actions_applying` Journal 无法准确覆盖。
4. Pi extension/provider hook 的 handler 异常会被 Runtime 吸收，不能充当 fail-closed 持久化屏障。
5. 自定义工具虽然支持 async，但默认批次可以并行；P0 写工具不显式 sequential 会破坏 SQLite Action 顺序。
6. 当前 Adapter 的 `MAX_ATTEMPTS` 会在一个 `executeTurn` 内静默调用多次外层 `prompt()`，与 unknown 后禁止重调冲突。
7. Pi 默认启用 auto-compaction；只回放普通消息不能重建压缩后的有效上下文。
8. `prompt()` 正常 resolve 仍可能产生 `stopReason=error | aborted`，不能把 Promise resolve 当作成功。
9. Windows 无法可靠证明任意未知旧进程都没有引用数据根；把该证明作为迁移前置条件会永久阻塞。
10. 发布包允许多个 Node major，却直接携带 `better-sqlite3` native binary，缺少 ABI 绑定。
11. 计划还包含 `/draf`、`/star`、`npm tes`、Web Vitest config 和 workspace exports 等机械错误。

### 用户接受并冻结的修订

- Task 2 改为严格离线迁移：维护锁只协调新 Forge；只确认 Forge 登记子进程退出；不可信数据根要求重启后先迁移或使用新根。checkpoint/关闭连接后，以独立源/目标连接完成 Backup API，再迁移验证备份并切换新 generation。
- 新增 Task 0 可行性硬门禁，只证明 Pi 0.82 公共 API、in-memory replay、顺序工具、abort、终态分类和概念性两事务协议；不得引用为生产恢复证据。
- Pi P0 Session 全部改为 `SessionManager.inMemory()`；Forge 保存固定 `logical_session_id`、有序公开内容块和原位 opaque signature，不持久化 plaintext hidden thinking 或生产 Pi JSONL。
- P0 关闭 auto-compaction，以冻结模型 `contextWindow` 做调用前硬限流；P1 再设计脱敏 compaction evidence。
- 一个 `agent_run_attempt_id` 最多调用一次 Forge 外层 `AgentSession.prompt()`；删除 Adapter 的空响应/nudge 重试。
- attempt 前短事务提交 `started`；attempt 内同步 listener 只写内存 transcript buffer；settled 后统一脱敏校验，并在短事务中原子提交完整消息证据和明确 outcome。
- Action 使用两事务：A 提交 `prepared + arguments_hash`；B 原子提交 domain effect、completed、outbox。B 回滚时 prepared 保留，其他三者不存在，并通过 `ctx.abort() + throw + fatal flag` 阻止成功。
- `succeeded`、`known_failed` 和 `outcome_unknown` 明确分离；started 后没有分类终态的崩溃一律进入 `waiting_recovery`，不自动重调 Pi。
- Provider hooks 降级为 best-effort telemetry；外部非事务副作用工具不进入 P0。
- Task 6 用最终 Schema/Repository 重跑生产协议测试；Task 12 用真实 Worker/进程驱动器重跑崩溃窗口。
- 真实 Pi kill 只证明 Agent Run 已 started 且尚无完成证据，不虚假声称观测到 HTTP 正处于网络 in-flight。
- 本地 release manifest 绑定 OS、arch、Node major 和 `process.versions.modules`；未来 Electron 单独 rebuild native module。

### 最终裁决

五轮专项反证审查在合并上述修订后得到：

`VERDICT: APPROVED`

未发现剩余材料级 blocker。上下文估算算法、具体列类型与测试夹具属于各实施 Task 内可自然细化事项，不改变冻结协议。

## 零上下文全局交接审查

日期：2026-07-29

审查会话：`019fae16-433f-7433-ae56-fc189b4998dd`

范围：当前权威来源、P0 产品追踪、技术协议、逐 Task 计划、外部输入、发布证据与零上下文启动说明。
约束：只读对抗审查；同一会话内修订后复审。

### Round 1 — Codex

结论：`VERDICT: NEEDS_REVISION`

1. 用户清单仍是空白模板，文档未提交，不能据此证明授权基线；
2. 权威来源冲突，技术需求仍保留 Supervisor IPC 接管和跨环境可写调度，而计划采用无接管、单环境实例；
3. `CLAUDE.md` 的旧 JSONL/nudge/自动 push 描述可能覆盖 P0；
4. Fake 故障矩阵包含运行时不可能产生的“终态已提交、命令未闭合”窗口；
5. Task 5 没有声明 `CaseService`、端口和旧 Repository 的跨聚合事务改造；
6. migration fixture、FK、完整性和来源证明不足以机械执行；
7. 若干错误、健康和 launcher reason code 未声明；
8. P0 缺少工作台筛选、模板详情、来源任务复制、正文复制与完整 Issue 链的可追踪证据，并混入 P1；
9. lockfile、Playwright 浏览器和 PowerShell 命令不可复现；
10. clean commit、source tree 与同一 immutable release 证据不可强制；
11. Provider/Model 和费用条件被要求得过晚，最终视觉确认也没有与自动 readiness 分阶段。

已实施的修订：

- 新增只读填写模板与唯一 `Forge_UI_P0_交接记录.md`，明确 `NOT_READY/READY` 算法、Git/Harness/Pi/迁移/视觉输入和无秘密规则；交接采用“冻结 baseline commit + 只含记录/可选参考图的直接子提交”，不把提交 SHA 写入自身形成自指；
- 统一来源优先级，`CLAUDE.md` 降为历史基线；技术需求升级到 0.43，冻结无 IPC 接管、每实例单环境拓扑；
- 把终态窗口改为“原子终态提交后、UI/SSE 消费前”，遗留不一致只通过显式 fixture 验证；
- 补齐跨聚合 `TransactionContext` 所有权、CaseService 参与文件、逐写入失败回滚测试；
- 固化历史 Schema fixture manifest、生成程序、FK RESTRICT、integrity/FK/orphan/identity/hash 检查；
- 封闭 public error、health reason 和 launcher exit code；
- 产品需求 1.5、Task 路由/UI/E2E 和 15 行追踪矩阵覆盖全部 P0；验收条目显式标记 P0/P1，文件下载、归档/回收站等不再进入 P0；
- Tasks 10/12 拥有 lockfile，固定 Playwright 与浏览器 preflight，Windows 验收统一使用 `.cmd` 入口；
- 发布流程先提交 source/harness，再从 clean commit 构建显式 manifest，所有 package/Fake/fault/real/visual Gate 记录同一 source commit、tree hash 和 release ID；
- Pi 非秘密选择和费用边界前移到交接；自动完成状态为 `G7_AUTOMATED_READY`，同一 release 经一次用户视觉接受后才是 `P0_ACCEPTED`。

Round 1 不能作为通过结论；必须在同一审查会话中复核上述修订。

### Round 2 — Codex

结论：`VERDICT: REVISE`

审查确认原 11 项中的 9 项已经材料级闭环：

| 原问题 | 状态 | 复核结果 |
|---|---|---|
| 1 交接清单/基线 | 已闭环 | baseline + direct-child 协议成立；当前 `NOT_READY`/dirty 是预交接 fail-closed 状态 |
| 2 权威拓扑 | 未完全闭环 | 主拓扑已统一，但技术需求仍残留第二套所有权措辞 |
| 3 `CLAUDE.md` | 已闭环 | 已明确降为历史基线，不能覆盖权威来源 |
| 4 不可达窗口 | 已闭环 | 运行时窗口可达，遗留终态/命令不一致仅由 fixture 验证 |
| 5 Task 5 事务所有权 | 已闭环 | branded context、文件归属、同连接校验与逐写入回滚明确 |
| 6 migration 机械定义 | 已闭环 | 历史 fixture、manifest、FK、integrity/orphan/generation 规则明确；另有真实数据动作缺陷见下 |
| 7 枚举 | 已闭环 | public/health/Agent-run/launcher code 与映射已冻结 |
| 8 P0 追踪 | 已闭环 | 产品、Route、UI、E2E、15 行矩阵与 P1 排除一致 |
| 9 Windows/lockfile/Playwright | 已闭环 | lockfile 所有权、固定版本、preflight 与 `.cmd` 成立 |
| 10 release provenance | 未完全闭环 | 构建候选已修正，但 Task 14 验收后 commit 会使来源失效 |
| 11 Pi/视觉时点 | 已闭环 | Pi 前移到 Task 4 前，自动 readiness 与人工签收已分离 |

剩余材料级问题：

1. **Critical — 冻结技术协议仍有竞争所有权机制。** TD-003、TD-010、TD-017、TD-020、TD-022 仍出现命令租约 heartbeat、旧 IPC 握手与 runner token 所有权，和施工计划“唯一 execution lease”冲突。
   Correction：交接前只有无 heartbeat 的短期 dispatch claim；交接后只有 `execution_lease(worker_instance_id,generation)`；不与旧 Worker 建 IPC；runner token 如保留只能是从属认证因子。
2. **Critical — 自动迁移会在未授权时移动真实旧数据。** 计划在秘密扫描命中时要求把旧根 quarantine 到其他位置，但交接只授权停止和让用户选择。
   Correction：旧根内容和路径完全不动，只在 Harness 目录写脱敏诊断并停止；移动/重命名必须另有明确源、目标和破坏性操作授权。
3. **High — Task 14 形成 post-G7 provenance loop。** 自动 Gate 后修改 README/提交报告会改变 source tree，使已接受 release 失效。
   Correction：README 必须在候选 commit 前完成；验收后只允许一个明确 allowlist 的 evidence-report 子提交，并声明它不是 release source。
4. **High — 外部或可变参考图可造成 false READY。** 外部稳定路径没有可读性、类型、大小或 hash 保证。
   Correction：READY 只能选择不使用图片，或使用交接 HEAD 内已跟踪、allowlisted、普通文件、经过 MIME/magic bytes/大小/SHA-256 校验的唯一图片。

### 主 Agent 对 Round 2 的处理

- 接受 1：技术需求 0.43 明确唯一 execution lease、无 heartbeat dispatch claim、无旧 IPC 握手和 runner token 从属认证边界，并把旧“命令租约”版本记录标为历史。
- 接受 2：旧根扫描异常时路径和字节均保持不动；P0 不移动、重命名、删除或 quarantine 真实旧根。
- 接受 3：Task 14 把 README 前移到候选 commit；接受后只创建稳定 final report，报告不嵌入自身 commit SHA，最终命令读取当前 evidence commit。
- 接受 4：交接记录冻结 `none_use_frozen_direction | repository_asset`，禁止外部路径；仓库图片必须通过 path、tracked、普通文件、reparse、magic bytes、size、SHA-256 和可读性校验。

Round 2 仍不能作为通过结论；修订后继续在同一审查会话复核。

### Round 3 — Codex

结论：`VERDICT: REVISE`

当前 `NOT_READY` 状态是正确的 fail-closed 预交接状态，不是缺陷。Round 2 的四项中，Worker 所有权、旧数据迁移和 Task 14 provenance 已闭环；视觉参考的外部/可变路径风险已闭环，但仍有三处跨文档歧义：

1. **High — 冻结技术协议仍把 P1 功能写成 P0 强制项。** `TD-004` 的标签/归档/回收站字段，`TD-008` 的归档/恢复草稿命令，`TD-032` 的设置页视觉回归和 `TD-035` 的 `/settings`，与产品 P0/P1 矩阵和 P0 Route/UI 计划冲突。
   Correction：逐项标为 P1 且不进入 P0 Schema、Route、UI 或 Gate；P0 模板页和模型目录只保留追踪矩阵要求的上下文能力。
2. **Medium — 最高优先级产品文档仍假设必须提供截图。** 产品文档称第一版采用用户截图，而交接允许 `none_use_frozen_direction`。
   Correction：冻结文字方向始终为权威；只有选择 `repository_asset` 时才使用仓库内哈希校验图作为补充。
3. **Medium — 参考图大小规则不一致。** 交接记录和计划写 `1..20 MiB`，填写清单只写不超过 20 MiB，可能把普通小图误判为不合格。
   Correction：全部统一为 `1 byte <= reference_image_bytes <= 20 MiB`。

Round 2 四项复核：

| 项目 | Round 3 状态 | 证据 |
|---|---|---|
| 唯一 Worker ownership/liveness | 已闭环 | 唯一 `execution_lease(worker_instance_id,generation)`；dispatch claim 无 heartbeat；不接管旧 IPC；runner token 仅从属认证 |
| 旧数据安全迁移 | 已闭环 | 扫描异常时旧根字节和路径不动；无额外授权不备份、复制、移动、重命名、删除或隔离 |
| Task 14 provenance | 已闭环 | README/source 先于候选；同一 release 跑 G7；签收后仅允许非自指 evidence-only 直接子提交 |
| 视觉参考安全 | 部分闭环 | 外部/可变路径风险已闭环；仍需消除产品权威和大小规则歧义 |

其他已审查区域——TransactionContext、迁移 fixture/FK/integrity、错误码、崩溃窗口、Windows/Playwright、Task 4 时点、`G7_AUTOMATED_READY`/`P0_ACCEPTED`、停止语义和 P0 完成措辞——未发现新的材料级阻塞。

### 主 Agent 对 Round 3 的处理

- 接受 1：在技术需求 0.43 现行条款中，把标签/归档/回收站、对应命令、设置页视觉回归、`/settings` 及模板维护扩展明确标为 P1；P0 只保留追踪矩阵要求的任务、模板与上下文模型能力。
- 接受 2：产品视觉语言改为冻结文字方向始终有效，仓库参考图仅在 `repository_asset` 模式下作为补充。
- 接受 3：交接记录、填写模板、交接 Spec 和 Task 14 全部统一为 `1 byte <= reference_image_bytes <= 20 MiB`。

Round 3 仍不能作为通过结论；修订后继续在同一审查会话复核。

### Round 4 — Codex

结论：`VERDICT: REVISE`

当前 `NOT_READY` 和未提交状态是正确的审查前置状态，不计为缺陷。Round 2 的四项已经闭环；Round 3 的视觉权威来源和图片大小规则已经闭环，但仍有两处 High 级范围矛盾：

1. **High — 技术协议仍把 P1 设置和模板维护能力写成未限定条款。** TD-005 的模板默认模型维护、TD-026 的高级设置与安全清理入口、TD-029 的高级设置表单，以及 TD-030 的配置 Command/Query 与热更新，没有逐项限定为 P1；这与 TD-035、产品 P0/P1 矩阵和 P0 实施计划冲突。
   Correction：给上述 UI/维护能力统一加 `[P1]`，并明确 P0 只保留后台安全默认配置、创建任务上下文模型覆盖和只读模板详情。
2. **High — TD-041 把产品与实施计划要求的 P0 工作区能力误降为 P1。** 现行条款只保证 `Turn → 产物/Issue/返修` 单向定位，并把“完整泳道、全部跨对象联动”整体列为 P1；但产品与 Task 10 要求 P0 在当前任务内呈现完整 Agent 泳道、持久化边，以及泳道与产物链的双向定位。
   Correction：明确 P0 包含当前任务完整 Agent 泳道、持久化关系边及其与产物/Issue/返修/版本的双向定位；仅跨任务、完整历史轮次、完整传播分析和高级诊断属于 P1。

Round 3 闭环复核：

| 项目 | Round 4 状态 | 证据 |
|---|---|---|
| 标签/归档/回收站等 P1 切分 | 部分闭环 | 已修正的条款有效，但 TD-005/026/029/030 仍残留未限定 UI 能力 |
| 冻结书面视觉方向权威 | 已闭环 | 产品文档明确图片只在 `repository_asset` 模式下作为补充 |
| 图片大小规则 | 已闭环 | 四份有效协议统一为 `1 byte <= reference_image_bytes <= 20 MiB` |

### 主 Agent 对 Round 4 的处理

- 接受 1：技术需求升级到 0.44，把模板默认模型维护、设置/清理 UI、高级设置表单和配置 Command/Query/热更新逐项限定为 P1；P0 只保留安全默认配置、启动级覆盖、创建任务上下文模型覆盖与只读模板详情。
- 接受 2：TD-041 明确 P0 必须交付当前任务完整 Agent 泳道、持久化关系边，以及 Agent/Turn 与产物、Issue、返修和版本的双向定位；只有跨任务、完整历史轮次、完整传播分析和高级诊断属于 P1。
- 同步产品文档、总计划、实施计划、交接 Spec、填写清单和交接记录中的冻结技术版本为 0.44。

Round 4 仍不能作为通过结论；修订后继续在同一审查会话进行第 5 轮终审。

### Round 5 — Codex

结论：`VERDICT: APPROVED`

严重度复核结果：

- Critical：无；
- High：无；
- Medium：无；
- Low：无。

既往问题全部闭环：

- Round 2：唯一 Worker execution lease、旧数据根 fail-closed、Task 14 同一发布来源证明、视觉参考来源约束全部 `CLOSED`；
- Round 3：P0/P1 第一批技术条款、冻结书面视觉权威、统一图片大小规则全部 `CLOSED`；
- Round 4：模板/设置写能力的 P1 限定，以及当前任务完整泳道、持久化关系边和双向定位的 P0 要求全部 `CLOSED`；
- 技术需求标题、产品文档、总计划、实施计划、交接 Spec、填写清单和交接记录中的现行版本引用全部统一为 0.44；其他版本号只存在于明确的历史变更记录。

终审重新核对了来源优先级、单环境 Supervisor/Worker 拓扑、TransactionContext 所有权、严格离线迁移、真实 Pi Task 4/13 门禁、Windows `.cmd` 命令、Playwright/lockfile 责任、同一 release provenance、`G7_AUTOMATED_READY` 与人工签收分离，以及仅声明 P0 的完成措辞。历史迁移 fixture 所引用的三个提交均可解析，Task 0–14 均具备文件、接口、依赖、命令和证据边界。

当前旧 Node/Pi/package 配置属于明确记录的改造前基线，由 Task 0–1 负责机械升级，不构成隐藏前置阻塞。当前交接记录保持 `NOT_READY`、冻结文档仍未提交且工作树 dirty，是正确的 fail-closed 交接前状态；`APPROVED` 只表示文档包不存在材料级开发阻塞，不表示应用已实现、交接记录已 `READY` 或 Forge UI P0 已验收。
