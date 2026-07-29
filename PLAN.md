# Plan: Forge UI P0
_Locked via grill — by Codex + user_

## Goal

把 Forge 从工程回放页面升级为内容生产操作者可在本机真实使用的 Web 产品：用户可以选择不可变模板修订与每个 Agent 的实际模型，创建并运行生产任务，在统一任务工作区观察纵向 Agent 泳道和产物演进，处理人工介入、安全暂停或崩溃恢复，并获得由系统门禁确认的交付结果。完成声明必须同时具有真实 Pi、真实持久化、真实 Supervisor/Worker 进程和进程级崩溃恢复证据。

## Approach

1. 把运行时统一到 Node `>=22.19.0` 与精确锁定的 Pi `0.82.0`，冻结有界 TypeBox API Contract、稳定错误码、REST 路由和 SSE 事件协议。
2. 保留 production/test 双库隔离，对每个环境用独立 SQLite 排他维护窗口和不可复用的数据库 generation 完成显式前向迁移：确认全部旧 Worker 已退出后，Backup/迁移/验证并原子切换该环境的 active pointer；后续跨表写由抽象事务端口和同连接 SQLite Unit of Work 实现，所有持久化 sink 复用同一脱敏器。
3. 通过 Pi 公共目录发现 Provider/Model，把准确的 `provider_id + model_id + catalog_snapshot_id + 非敏感配置指纹` 逐 Agent 冻结；Worker 创建或恢复 Session 前再次实时核对，禁止静默替换。
4. 在事务外生成短期模型验证票据，在事务内以目录快照、配置指纹和草稿 revision CAS 原子完成任务冻结、Case 创建、任务绑定、命令和事件追加。
5. 先修复当前有效产物写入不变量，再用带 head CAS、invocation ID 和租约写栅栏的短事务 Turn Journal 替换跨 Pi 调用的长事务；工具副作用按稳定 ID/参数哈希幂等，未知结果 fail closed。
6. 用常驻 Supervisor 做短暂 dispatch，子进程 ready 后才把唯一 execution lease 交给独立 Case Worker；控制命令由当前或恢复 Worker 在安全 Turn 边界领取。Supervisor 重启不接管旧父子 IPC，只依据数据库租约避免重复启动；Worker 可离线闭合 Journal、Case、命令和事件。
7. 从权威事实按需生成有界任务、工作区、Agent 会话、产物、事件与健康投影；Next.js BFF 只映射 application Query/Command，SSE 从 Workspace 的 `source_event_seq` 起步，轮询单独使用 ETag。
8. 浏览器通过精确本地 authority 的 REST + SSE 使用正式链路；任务详情默认进入三栏工作区，Agent 从左到右分列、时间从上到下，Turn 浮窗按需读取完整脱敏会话。
9. 先生成不依赖源码的不可变发布目录，以该同一目录完成 Fake Pi 浏览器/进程故障门禁和真实 Pi 三项强杀门禁。
10. 真实运行与恢复通过后，才按暖色编辑器方向完成 1024/1280/1440/1920 视觉与宽屏适配。

施工级任务、文件、接口、SQL、测试命令和提交边界以
`docs/superpowers/plans/2026-07-29-forge-ui-p0-implementation.md`
为规范性执行清单；本文件与该清单必须一起评审。

## Key decisions & tradeoffs

- 生产任务与 Case 分离：草稿/标签/归档属于任务，运行事实仍属于 Case；避免 UI 状态污染状态机。
- Next.js 是同源 BFF，不再直接查询 SQLite 或拉起 CLI；当前个人本地规模不新增独立 API 服务。
- 使用持久化命令 + Supervisor + 独立 Case Worker，接受实现复杂度以换取进程隔离、可恢复性和真实幂等。
- 保留独立 Supervisor 是已冻结的故障隔离边界；计划必须用脱离源码、带完整文件哈希的不可变发布目录证明四层生命周期可交付，Fake 与真实 Pi 门禁必须消费同一目录。
- P0 默认单 Case 并发，暂不为团队级规模、远程部署或多租户增加基础设施。
- Turn 只在完整 Pi Turn 边界暂停；不虚假承诺模型请求内即时取消或 Provider 费用 exactly-once。
- Agent 泳道边只来自持久化引用，不按显示顺序猜测信息流；缺少证据时宁可不画箭头。
- Agent 浮窗展示完整脱敏业务输入/输出、工具与系统结果；公开推理摘要仅在 Runtime 明确提供时显示，隐藏思维链永不采集。
- UI 功能链在 Fake Pi 下成立后，还不能宣布完成；真实 Pi 与进程故障门禁是硬条件。
- Electron、鉴权、流程编排、人工改产物等明确延后，避免个人本地项目失控扩张。

## Risks / open questions

- Pi Runtime 是否能对“模型已处理但响应未持久化”的窗口提供稳定响应核对能力，必须在 Task 6/13 实测；不能核对时固定收敛为 `outcome_unknown + waiting_recovery`。
- Pi SessionManager 有消息、工具、自定义 entry 和 compaction 等多个持久化入口；Task 4 必须证明全部入口都经过唯一白名单 sink，JSONL 不含明文 thinking 且仍可恢复，否则对应 Provider/Model 不得进入 P0。
- 当前 SQLite 旧库没有迁移表；首次迁移必须在 Windows 真实进程测试中证明全部旧 Forge Worker 已退出，再在每环境独立屏障内完成 Backup API、迁移和验证；无法证明时拒绝采用旧 data root。
- Supervisor 重启后只依据数据库 execution-lease heartbeat 观察存活 Worker，绝不接管旧父子 IPC；Windows 进程测试必须证明不会重复启动，PID 只能用于诊断。
- 真实 Provider 凭据不进入仓库；如果本机没有可用凭据，实施可以推进到 Fake Pi 门禁，但 P0 不得标记完成。

## Out of scope

- Electron、安装器、签名、更新和桌面原生能力。
- 预定义流程编排 UI 与自由拖拽流程设计器。
- 人工修改产物、鉴权、多用户、通知、手机端、Provider 凭据管理。
- 团队级并发、大规模搜索、物化 UI 投影和复杂性能基础设施。
- P1 的完整历史传播高亮、高级诊断、归档回收站和模板版本体验。
