# Plan Review Log: Forge UI P0

Act 1 (grill) complete — product and technical decisions were locked with the user across the Forge UI requirement review. MAX_ROUNDS=5.

Normative files:

- `PLAN.md`
- `docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`

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
