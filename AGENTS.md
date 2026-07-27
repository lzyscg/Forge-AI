# AGENTS.md — Forge AI MVP 开发规范

## 先读这些文档

按任务类型选择入口。任何故事生产任务都必须先读完前四项：

1. `README.md` — 项目总览、安装、场景和通用 CLI
2. `orchestrators/story-pipeline/README.md` — 外部多 Case 编排器的职责、产物和机械门禁
3. `orchestrators/story-pipeline/外部编排器从头生产使用说明.md` — 从输入故事到终稿的实际运行手册
4. 对应 `scenarios/zhihu-*` 目录中的 `scenario.yaml`、提示词和 `skills/` — 各 Case 的内容生成与审核规则
5. 历史需求和工程计划（仅在需要追溯决策时阅读）：
   - `docs/archive/Forge_AI_MVP_需求文档.md`
   - `docs/archive/PLAN.md`

根目录的 `CLAUDE.md` 是给接手 Agent 的补充入口；如果它与上述当前运行手册冲突，以代码、场景配置和外部编排器使用说明为准。

## 故事仿写生产入口

故事生产使用仓库外接的 `story-pipeline`，不是逐个手工运行 Forge Case。完整链路为：

```text
故事输入 → outline → packet → draft → ledger → final
```

外部编排器只负责 Case 串行编排、输入/父版本绑定、文件落盘、Manifest、哈希、恢复和下游失效传播；故事内容的生成、审核和质量门禁由各 Forge Case 及其 `skills/` 负责。不能为了让流程继续而手工伪造 `approved`、`delivered`、Issue 或校验结果。

从头生产时必须使用新的 `run_id`、`run-dir` 和 Forge DB；不得复用历史恢复目录，不得手工修改 `manifest.json`。准备 `.env`、复制配置、启动命令、验收标准和故障处理见：

`orchestrators/story-pipeline/外部编排器从头生产使用说明.md`

## 六条铁律

1. **不把任何业务写死进平台**：平台代码里不允许出现 `总控`、`生成`、`审核`、`歌词` 等业务名词作为枚举值或条件分支。只写一份新 YAML、不改任何平台代码，就能跑起一个新场景。

2. **模型不碰工程数据**：模型的输出里不应包含 case_id、session_id、version、时间戳、路由边、数据库字段。这些一律由系统在处理工具调用时补齐。

3. **交付是系统的决定，不是 Agent 的声明**：Agent 调用"申请交付"工具不等于交付成功。系统必须独立核对全部条件。`claimed_fixed` 绝对不能当作 Issue 关闭，只有 `verified` 才算。

4. **一切追加，绝不覆盖**：产物新版本追加不覆盖旧版本。Issue 状态变化以事件追加记录。崩溃恢复不允许覆盖已成功持久化的结果。

5. **架构依赖只能单向**：`contracts → domain → application → adapters → apps`。domain 绝不依赖数据库/Pi/Web 框架。adapter 里不允许出现业务角色名分支。

6. **不泄密**：API Key、Token、Authorization Header、模型隐藏思维链，绝不进入日志、数据库业务表、或返回给前端。

## 不要读取或复用任何旧仓库代码

旧的 TS monorepo 骨架和 `pi-pipline-main` Python 项目均视为失败品。只保留"分层约定"这一思路，不复用一行实现代码。

## 已知失败模式提醒

上一轮尝试的领域模型、状态机和分层架构本身被证明是合理的，真正导致失败的是纪律问题——把"Fake Pi 驱动的内存态演示 + UI"做完就在文档里宣称"整体完成"，而真正高风险的部分（真实 Worker、真实持久化运行链路、真实 Pi 验收、进程级崩溃恢复、幂等键的真实生效）从未做到、也未如实记录未完成。

**本项目必须避免同样的模式：**
- 完成声明必须有可运行证据（测试输出、调用日志），禁止只写文字声明
- 真实 Pi 全链路验证是 MVP 硬指标，不能只用 Fake Pi 顶替
- 在真实 Pi 和崩溃恢复验证通过前，不打磨 UI
