# Forge UI 技术需求文档

> 状态：技术需求拷问进行中
> 当前版本：0.2
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

1. application 层查询服务与命令服务边界；
2. 生产任务、草稿、归档、标签和来源关系的数据模型；
3. Agent Provider/Model 目录、冻结和恢复；
4. 实时更新协议；
5. 并发命令、幂等和前端一致性；
6. 当前有效产物、阶段与进度的投影模型；
7. 自动保存与草稿冲突；
8. 脱敏和诊断数据边界；
9. SQLite 迁移与兼容策略；
10. 测试、真实 Pi 和崩溃恢复验收；
11. Electron 打包、数据目录、升级和进程生命周期。

## 5. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.2 | 2026-07-29 | 确认常驻 Supervisor、持久化命令和每个 Case 独立 Worker 进程的执行模型。 |
| 0.1 | 2026-07-29 | 建立技术需求文档；确认 Next.js BFF 方向和 Electron 后续封装约束。 |
