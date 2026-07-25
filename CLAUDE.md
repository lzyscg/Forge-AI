# CLAUDE.md — Forge AI MVP

> 给接手开发的 Agent：本文档是项目入口。先读这里，再按"先读这些"读详细文档。

## 这是什么

Forge AI 是一个**让多个 AI Agent 协作完成一次内容生产任务的运行平台**。核心不是"模型多强"，而是**在多个 Agent 之间搭一个可靠的中间层**：让它们安全交接工作成果，并让系统始终独立掌握"现在生产到哪了、哪些成果有效、什么问题没解决"。

典型链路（歌词场景）：总控派任务 → 生成写初稿 v1 → 审核挑出问题 → 总控下发"只改第 4 行、其余冻结"的返修 → 生成改出 v2 → 复审通过 → 总控申请交付 → **系统独立核对门禁** → 正式交付。歌词只是示例，换"文案+质检"骨架不变。

## 先读这些（按顺序）

1. `AGENTS.md` — 六条铁律 + 已知失败模式提醒（**必读，不可违反**）
2. `Forge_AI_MVP_需求文档.md` — 为什么 + 完整规格（四支柱、数据模型、工具接口、状态机、验收标准）
3. `PLAN.md` — 工程决策 + 执行步骤
4. `交付标准.md` — MVP 终点线（逐项 pass/fail 清单）
5. `返修清单.md` — 历史审查发现（P0/P1，**已全部修复**，见下"当前状态"）

## 四根支柱（每个功能必须服务至少一根）

1. **中间层接管工程，模型只管内容**（P1）：模型不生成 ID/版本/时间戳/路由/JSON，只调工具，系统补齐工程数据。
2. **产物与问题是第一等对象，系统独立核实交付**（P2/P3/P4，**灵魂**）：交付由系统门禁决定，不是 Agent 说了算。`claimed_fixed` 不算关闭，只有 `verified` 算。
3. **受控返修**（P5）：editable/frozen 范围，越界修改的版本 `rejected`，不进复审。
4. **配置驱动，不写死业务**（P7）：平台代码零业务分支，新场景只写 YAML。

## 架构（铁律 5：单向依赖）

```
contracts  ->  domain  ->  application  ->  adapters  ->  apps
```

| 层 | 职责 | 关键文件 |
|---|---|---|
| `packages/contracts` | typebox 数据契约 + 端口接口（PiPort/RepositoryPort/ClockPort/IdGeneratorPort/ConfigLoaderPort） | `ports.ts`, `tools.ts`, `scenario.ts` |
| `packages/domain` | 纯状态机 + 门禁 + 越界校验（**可纯内存单测，不碰 DB/Pi**） | `issue-state.ts`, `delivery-gate.ts`, `scope-validator.ts`, `state-transitions.ts` |
| `packages/application` | Turn 编排 + 工具执行 + 上下文构建 + 崩溃恢复 | `turn-executor.ts`, `tool-executor.ts`, `context-builder.ts`, `recovery.ts`, `case-service.ts` |
| `packages/adapters` | SQLite + Fake Pi + Real Pi + 基础适配器 | `sqlite-repository.ts`, `fake-pi.ts`, `pi-adapter.ts`, `base-adapters.ts` |
| `apps/worker` | 唯一启动 Pi Session 的入口，跑 Agent 循环 | `src/main.ts` |
| `apps/web` | 只读回放页（Next.js，轮询，不调 Pi） | `app/page.tsx`, `lib/db.ts` |

**4+1 工具**（支柱一落地，参数只留最小字段）：`publish_artifact` / `submit_evaluation` / `route_message` / `approve_delivery` + `request_human_input`（降级，Case 停 `waiting_human`）。`approve_delivery` 不许模型传版本号（铁律 2），系统自动定位。

**交付门禁 5 项**（铁律 3 灵魂，`domain/delivery-gate.ts`）：版本有效 / 该版审核通过（不继承旧版）/ 所有 blocking Issue `verified` / 无运行中返修 / 无未完成 Turn。

**状态机**：Issue `open->repairing->claimed_fixed->verified`（`claimed_fixed` 不关闭 blocking）；RevisionInstruction `issued->in_progress->submitted->(verified|scope_violation)`；Turn 原子事务（`queued->running->completed`，整个 Turn + 副作用在同一事务内 commit）。

**两个场景**：`scenarios/songwriting`（supervisor/generator/reviewer，3 Agent，产物 lyrics）+ `scenarios/copywriting`（writer/qc，2 Agent，产物 copy）— 后者证伪"平台写死了业务"。

## 当前状态（截至 2026-07-25）

依赖已修复，返修清单 P0/P1 全部应用并验证，崩溃恢复与 claimed_fixed 缺陷已修复。对照交付标准：

| 条款 | 状态 | 证据 |
|---|---|---|
| 4.1 check/test | ✅ | `npm run check` 0 错误；`npm run test` 9 文件 78 passed |
| 2.1 Fake Pi 歌词全链路 | ✅ | 7 Turn→approved，门禁 5 项全 pass，blocking Issue=verified，generator persistent/reviewer cold_per_version，v1 superseded+v2 delivered |
| 2.3 崩溃恢复 | ✅ 已修 | `scripts/crash-recovery-e2e.cjs` 8 项断言全 YES（见下） |
| 2.4 第二场景零代码 | ✅ | copywriting：writer/qc、artifact_type=copy、门禁 pass |
| 2.5 职责边界 | ✅ | 门禁独立、越界拦截、claimed_fixed 阻断门禁 |
| 2.6 Web 回放页 | ✅ | `next dev` HTTP 200，显示 Case/版本diff/Issue/门禁 |
| 3.1 事务原子性 / 3.2 幂等键 / 3.3 上下文快照 / 3.4 WAL | ✅ | WAL+busy_timeout=5000 |
| 铁律 4 issue_events 完整 | ✅ 已修 | created→repairing→claimed_fixed→verified |
| **2.2 真实 Pi 全链路** | ❌ 待验证 | **需 `DEEPSEEK_API_KEY` / `PI_MODEL_ID` 凭证**，MVP 最高风险项 |

## 标准命令

```bash
npm run check            # tsc --noEmit（0 错误）
npm run test             # vitest 单元 + 集成（78 passed）
npm run test:integration # 真实 PG（本项目用 SQLite，此命令可能为空配置）
npm run dev              # tsx apps/worker/src/main.ts（默认 Fake Pi + songwriting）
```

## 如何运行 / 测试

**跑 Fake Pi 场景**（默认 songwriting）：
```bash
PI_MODE=fake DB_PATH=./data/song.db SCENARIO_PATH=./scenarios/songwriting/scenario.yaml npm run dev
# 第二场景（证伪硬编码）：
SCENARIO_PATH=./scenarios/copywriting/scenario.yaml DB_PATH=./data/copy.db npm run dev
```

**崩溃恢复端到端测试**（worker 跑 3 Turn 后停止 + 重启续跑）：
```bash
node scripts/crash-recovery-e2e.cjs
```

**Web 回放页**：
```bash
cd apps/web && DB_PATH=<绝对路径到*.db> npx next dev -p 3137
# 浏览器打开 http://localhost:3137
```

**真实 Pi**（待凭证）：`PI_MODE=real DEEPSEEK_API_KEY=... PI_MODEL_ID=deepseek-v4-flash npm run dev`

## 关键约束 / 坑（务必记住）

1. **不要读旧仓库代码**：父目录的旧 TS monorepo 和 `pi-pipline-main` Python 项目是失败品，只保留"分层约定"思路，不复用一行实现。唯一允许借用的旧事实是 Pi 包名/仓库地址。
2. **`docs/HANDOFF.md` 是过时的**：它描述旧 PostgreSQL/Kysely/Next16/SSE/Playwright 项目，与当前 SQLite/pi-coding-agent 代码**完全不符**，已被错误带进本仓库。**不要依据它判断当前状态**。
3. **Git 版本控制状态**：`Forge-AI-main/` **当前未纳入 git**。父目录 `C:\Users\13863\Desktop\zhihu\Forge AI` 是旧项目的 git 仓库，`Forge-AI-main` 只是其中一个 untracked 目录（`git ls-files` 在此为空）。本目录下的代码没有任何 commit 历史。**接手后建议先为 `Forge-AI-main` 初始化独立 git 仓库并提交当前状态**，再开始改动。
4. **不要读旧仓库代码**：父目录的旧 TS monorepo 和 `pi-pipline-main` Python 项目是失败品，只保留"分层约定"思路，不复用一行实现。唯一允许借用的旧事实是 Pi 包名/仓库地址。
5. **依赖安装**：`node_modules` 必须本机 `npm install`，不能从别处拷贝（之前拷贝损坏：native 二进制缺失、包空壳）。已加 `.npmrc` 设 `allow-scripts=true`（npm 11 默认拦 native 脚本）；重装后需 `npm rebuild better-sqlite3 esbuild` 生成 native 二进制。
6. **环境**：Node v24 / npm 11 / TS ^5.5 / better-sqlite3 11.x（通过 N-API prebuild 支持 Node 24）。`engines` 写 `>=20`。
7. **Pi SDK**：`@earendil-works/pi-coding-agent`@0.82（Agent Runtime），**不是** `pi-ai`（那只是模型库）。`pi-adapter.ts` 必须用 `createAgentSession`/`SessionManager`/`defineTool`，不自建 Agent 循环。`typebox`@1.1.38 是正确依赖（pi-coding-agent 也用它）。
8. **崩溃恢复的设计要点**（P0-3 与 2.3 曾冲突）：Turn 是事务化原子提交的，崩溃 Turn 会回滚**不残留** `running` Turn。所以 `findCasesNeedingRecovery` 不能依赖 incomplete turn，要看 Case 是否处于运行中状态（running/waiting_review/repairing）。Fake Pi 续跑时需 `setTurnCounter` 对齐脚本。
9. **完成声明必须有可运行证据**：禁止只写"已修复"。每项声明附测试输出/日志。真实 Pi 全链路是硬指标，不能只用 Fake Pi 顶替。

## 待办（新 Agent 接手后优先）

1. **真实 Pi 全链路验证（2.2）**：用户提供 `DEEPSEEK_API_KEY` / `PI_MODEL_ID` 后，跑 `PI_MODE=real npm run dev` 完整闭环，留日志/SQLite dump 证据。若模型行为不稳定（不服从 editable/frozen、审核证据不可靠），如实记录并调整提示词/工具定义后重验--暴露不稳定比掩盖严重。
2. 真实 Pi 下做真正的 `kill -9` 崩溃恢复测试 + persistent session 续跑后上下文含历史断言（Fake Pi 无状态，无法验证后者）。
3. 真实 Pi 连续 3 次异常 Turn 需停下汇报（异常检测软规则，不是预算约束）。

## 最近的改动（2026-07-25，均未纳入 git）

- 修复依赖（重装 + `.npmrc` allow-scripts + rebuild native）
- 修 `tool-executor.ts`：`publish_artifact` 返修时补 `claimed_fixed` issue_event（铁律 4）
- 修 `recovery.ts`：放宽 `findCasesNeedingRecovery` + `recoverCase` 状态转换，让事务化下崩溃恢复能触发
- 修 `fake-pi.ts`：加 `setTurnCounter`；`main.ts`：恢复时对齐脚本 + `MAX_TURNS` 测试钩子
- 新增 `issue-lifecycle.test.ts`、重写 `crash-recovery.test.ts`、新增 `scripts/crash-recovery-e2e.cjs`
- 新增本 `CLAUDE.md`
