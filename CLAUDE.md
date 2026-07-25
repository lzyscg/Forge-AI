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

**5+1 工具**（支柱一落地，参数只留最小字段）：`publish_artifact` / `submit_evaluation` / `route_message` / `approve_delivery` + `request_human_input`（降级，Case 停 `waiting_human`）+ `read`（受限，仅 skills 目录白名单）。`approve_delivery` 不许模型传版本号（铁律 2），系统自动定位。

**交付门禁 5 项**（铁律 3 灵魂，`domain/delivery-gate.ts`）：版本有效 / 该版审核通过（不继承旧版）/ 所有 blocking Issue `verified` / 无运行中返修 / 无未完成 Turn。

**状态机**：Issue `open->repairing->claimed_fixed->verified`（`claimed_fixed` 不关闭 blocking）；RevisionInstruction `issued->in_progress->submitted->(verified|scope_violation)`；Turn 原子事务（`queued->running->completed`，整个 Turn + 副作用在同一事务内 commit）。

**两个场景**：`scenarios/songwriting`（supervisor/generator/reviewer，3 Agent，产物 lyrics）+ `scenarios/copywriting`（writer/qc，2 Agent，产物 copy）— 后者证伪"平台写死了业务"。

## 当前状态（截至 2026-07-25）

依赖已修复，返修清单 P0/P1 全部应用并验证，崩溃恢复与 claimed_fixed 缺陷已修复。对照交付标准：

| 条款 | 状态 | 证据 |
|---|---|---|
| 4.1 check/test | ✅ | `npm run check` 0 错误；`npm run test` 9 文件 78 passed |
| 2.1 Fake Pi 歌词全链路 | ✅ | 7 Turn→approved，门禁 5 项全 pass，blocking Issue=verified，generator persistent/reviewer cold_per_version，v1 superseded+v2 delivered |
| 2.3 崩溃恢复 | ✅ 已修（Fake + Real Pi 双验证） | Fake Pi：`scripts/crash-recovery-e2e.cjs` 8 项全 YES。**Real Pi kill -9**：`scripts/crash-recovery-realpi-e2e.cjs` 9 项全 YES（taskkill /F 真实 kill、从 Turn N+1 续跑、已完成 Turn 哈希不变、persistent session `.jsonl` 跨进程 7->23 历史续跑、context_snapshot 含崩溃前产物、最终 approved+门禁 pass） |
| 2.4 第二场景零代码 | ✅ | copywriting：writer/qc、artifact_type=copy、门禁 pass |
| 2.5 职责边界 | ✅ | 门禁独立、越界拦截、claimed_fixed 阻断门禁 |
| 2.6 Web 回放页 | ✅ | `next dev` HTTP 200，显示 Case/版本diff/Issue/门禁 |
| 3.1 事务原子性 / 3.2 幂等键 / 3.3 上下文快照 / 3.4 WAL | ✅ | WAL+busy_timeout=5000 |
| 铁律 4 issue_events 完整 | ✅ 已修 | created→repairing→claimed_fixed→verified |
| **2.2 真实 Pi 全链路** | ✅ 已验证 | 16 个真实 Pi Case（9 approved / 7 stopped）。**含完整返修闭环**：v1->reviewer 挑出 blocking->supervisor 发 editable/frozen 返修->generator v2->reviewer approve->issue `created->repairing->claimed_fixed->verified`->门禁 5 项 pass->v2 delivered/v1 superseded。凭证 `deepseek_config.txt`，模型 `deepseek-v4-flash`/`pro`（推理模型，见下“坑 8”）。DB `data/real-pi-multi.db`。详见下“最近的改动”。|
| **Round 2 CLI 操作系统** | ✅ | `npx forge --help` 可用；Fake Pi CLI 全链路 approved；stdout 双阶段协议；e2e 8/8 |
| **Round 2 Skill 注入** | ✅ | SDK 探针通过；PiPort 扩展；read 白名单安全单测 9 项；rhyme skill 配置 |
| **Round 2 UI 操作系统** | ✅ | API routes detached spawn；前端选模板/填输入/跑 case/恢复 waiting_human；next build 成功 |

## 标准命令

```bash
npm run check            # tsc --noEmit（0 错误）
npm run test             # vitest 单元 + 集成（78 passed）
npm run test:integration # 真实 PG（本项目用 SQLite，此命令可能为空配置）
npm run dev              # tsx apps/worker/src/main.ts（默认 Fake Pi + songwriting）
```

## 工作流（提交规则·用户明确要求）

**每完成一处改动（代码或文档），自动 `git commit` + `git push origin main`，无需每次问用户。** 这是用户 2026-07-25 明确授予的 standing authorization，覆盖之前"推送前确认"的谨慎做法。

细则：
- 直接提交到 `main`（沿用本项目 direct-to-main 模式，无 PR 流程）。
- 一处改动 = 一个有意义的单元（一个 fix / 一个 feature / 一组相关 doc），不要把半成品/未编译通过的中间状态提交上去。改动后先 `npm run check` 确认 0 错误再提交。
- 提交信息用 conventional commit（`feat:` / `fix:` / `docs:`），中文描述，结尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- push 走本仓库已配的 `http.proxy=127.0.0.1:10808`（坑 3）。代理失效时（`Connection reset` / 超时）先排查代理是否在跑，别误认为是代码问题。
- 仅以下情况仍需先问用户：force-push、改写已推送的历史、删除分支、涉及密钥/敏感数据的提交。
- `data/`（*.db / pi-sessions）、`node_modules/`、`.env*`、`.claude/` 已 gitignore，不会被提交。

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
3. **Git 版本控制状态**：`Forge-AI-main/` **已是独立 git 仓库**（与父目录 `C:\Users\13863\Desktop\zhihu\Forge AI` 的旧项目仓库隔离）。当前在 `main` 分支（direct-to-main，无 PR 流程）。`.gitignore` 已排除 `node_modules/`、`data/`、`*.db`、`.env*`、`deepseek_config.txt`、`.claude/`。**remote `origin = https://github.com/lzyscg/Forge-AI.git`**（用户自有仓库），本仓库配了 `http.proxy=127.0.0.1:10808` 走本地 V2Ray 代理访问 GitHub（国内网络必需）。**每处改动自动 commit + push（见上"工作流"），无需逐次问用户。** 最新提交历史见 `git log --oneline`。
4. **不要读旧仓库代码**：父目录的旧 TS monorepo 和 `pi-pipline-main` Python 项目是失败品，只保留"分层约定"思路，不复用一行实现。唯一允许借用的旧事实是 Pi 包名/仓库地址。
5. **依赖安装**：`node_modules` 必须本机 `npm install`，不能从别处拷贝（之前拷贝损坏：native 二进制缺失、包空壳）。已加 `.npmrc` 设 `allow-scripts=true`（npm 11 默认拦 native 脚本）；重装后需 `npm rebuild better-sqlite3 esbuild` 生成 native 二进制。
6. **环境**：Node v24 / npm 11 / TS ^5.5 / better-sqlite3 11.x（通过 N-API prebuild 支持 Node 24）。`engines` 写 `>=20`。
7. **Pi SDK**：`@earendil-works/pi-coding-agent`@0.82（Agent Runtime），**不是** `pi-ai`（那只是模型库）。`pi-adapter.ts` 必须用 `createAgentSession`/`SessionManager`/`defineTool`，不自建 Agent 循环。`typebox`@1.1.38 是正确依赖（pi-coding-agent 也用它）。
8. **崩溃恢复的设计要点**（P0-3 与 2.3 曾冲突）：Turn 是事务化原子提交的，崩溃 Turn 会回滚**不残留** `running` Turn。所以 `findCasesNeedingRecovery` 不能依赖 incomplete turn，要看 Case 是否处于运行中状态（running/waiting_review/repairing）。Fake Pi 续跑时需 `setTurnCounter` 对齐脚本。
9. **deepseek 是推理模型**：`deepseek-v4-flash`/`pro` 经 Pi 的 openai-completions 适配会返回 `thinking` block（`thinkingSignature:"reasoning_content"`），与 `text`/`tool_use` 并存。`pi-adapter.executeTurn` 只从 `message_end` 的 `text` block 取 finalContent、从 `tool_execution_start` 取工具调用；若模型只产出 thinking 没产出 text/tool_use（flash 在 cold_per_version 复审返修版时偶发），会被判空响应。已加空响应重试（最多 3 次，追加 nudge）。
10. **cold_per_version session 别名坑**（已修）：`turn-executor` 用 DB `session_id`（`sess_`）调 `executeTurn`，但 adapter 内部 map 用 `pi_session_ref`（`pi_`）做 key，靠 `registerSession` 建别名。旧实现按 agentKey 循环找现有 state 做别名，cold 复用时 closeSession 只删 `pi_session_ref` 主键、残留 `sess_` 别名指向已 dispose 的死 state，新 Turn 会在死 session 上 prompt 返回空。现改为 `registerSession(sessionId, piSessionRef)` 显式别名 + `closeSession` 清除该 state 的所有 key。
11. **返修状态机闭环**（已修）：generator 发返修版时 worker 只在 `status==='running'` 才转 `waiting_review`，但返修后 case 在 `repairing`，导致复审后 supervisor 再发返修触发 `repairing->repairing` 非法转换。现已允许 `repairing->waiting_review`。
12. **支柱一：系统补齐 issue_ids**（已修）：真实模型下 supervisor 偶尔只在 route_message 指令文本里提 issue ID、漏填结构化 `scope.issue_ids`，导致不创建 revision_instruction、Issue 卡在 `open`、门禁永远拦。`tool-executor.routeMessage` 现在在 supervisor 发返修（带 editable/frozen scope）却漏填 issue_ids 时，自动补齐为当前 Case 的 open blocking issues。
13. **scope_violation 续修**（已修）：返修越界后旧指令进 `scope_violation` 终态，generator 同 Turn 内的合规重试版本会因无 active instruction 被当成 draft，Issue 卡在 `repairing`。`publishArtifact` 现在越界后自动重发一份同 scope/issue_ids 的新指令（`issued`，仍 active）；且父本取"最后一个非 rejected 版本"，避免与被拒版本比 diff 导致 scope 校验错乱。
14. **完成声明必须有可运行证据**：禁止只写"已修复"。每项声明附测试输出/日志。真实 Pi 全链路是硬指标，不能只用 Fake Pi 顶替。
15. **worker recovery 路径未接 RealPi resumeSession**（已修，2.3 硬指标）：进程重启后 `RealPiAdapter` 内存 `sessions` map 为空，`main.ts` 复用 persistent session 时只调 `registerSession(sessionId, pi_session_ref)`，而 `registerSession` 内部 `this.sessions.get(pi_session_ref)` 返回 undefined → 别名建不上（no-op）→ 随后 `executeTurn({session_ref: sessionId})` 报 `Session not found`、连续 3 次 → Case 被标 `failed`。修复：`main.ts` persistent 复用分支先 `await pi.resumeSession(pi_session_ref)` 从磁盘加载回内存，再 `registerSession`。`resumeSession` 幂等（同进程已加载则直接返回）。
16. **resumeSession 不能用 continueRecent**（已修）：旧 `resumeSession` 用 `SessionManager.continueRecent(cwd, sessionDir)`，它在找不到 .jsonl / cwd 不匹配 / 读盘竞态时会**静默新建空 session**，历史丢失却不报错 → 违反 2.3"persistent session 续跑后上下文含历史"。改为显式 `readdirSync` 定位 sessionRef 目录下 mtime 最新的 `.jsonl`，用 `SessionManager.open(file, dir, cwd)` 打开；找不到文件就抛错（fail loud，不静默丢历史）。每个 sessionRef 目录正常只有 1 个 `.jsonl`（create 时生成）。
17. **恢复消息不能太模糊**（已修）：旧 fallback 恢复消息是"系统崩溃恢复后续跑。请检查当前进度并决定下一步。"，真实模型收到后停滞（实测卡在 `waiting_review`，supervisor 不路由）。改为 `buildResumeContextMessage`：附 Case 状态 + 各产物类型最新版本 + 待处理 Issue + 活跃返修指令摘要（全配置驱动，铁律 1），让 start_agent 据实决定路由审核/返修/交付。修复后 Real Pi kill-9 测试 supervisor 续跑 Turn 3-5 一路到 approved。
18. **Case 输入硬编码是铁律 1 残留**（已修）：旧 `main.ts` 把新 Case 输入写死为歌词（`reference_lyrics`/`fixed_phrase`="你是我的山歌"）+ 歌词语义首条消息（"参考歌词：…固定金句：…"）+ 写死 title "歌词生产"。导致 copywriting 场景收到歌词形状的输入（它声明的是 `product_name`/`promotion_info`），2.4 验收过的只是"结构不同"但输入内容无意义。改为 `resolveInputPayload`（优先级 `FORGE_INPUT` JSON > `FORGE_INPUT_FILE` 路径 > `<scenario 目录>/input.example.json` > fail loud）+ 按 `scenario.input_fields` 校验字段齐全 + `renderInputMessage` 按 field label 通用渲染 + title 用 `scenario.name`。两场景各补一份 `input.example.json` 示例输入。
19. **CLI stdout 协议**（Round 2）：`case run` 第 1 行必须是 `{"case_id":"..."}`（`fs.writeSync` 同步 flush），末行是结果 JSON。fatal 错误也写 stdout errorJson + exit 非 0（不只 console.error）。API route 读 stdout 第 1 行后立即 `child.unref()`。
20. **read 工具白名单**（Round 2，铁律 6）：`createReadTool` 的 `access` 用 `realpathSync` + `path.relative` 检查路径在 `scenarios/<id>/skills/` 内。symlink 逃逸被拦截。单测覆盖 `.env*`/`data/*.db`/源码/`../`/绝对路径。
21. **next dev caveat**（Round 2）：热重载可能杀 detached 子进程，被杀的 case 留 running 状态。验收用 `next start`，被杀的 case 可用 CLI `forge case run <id>` 续跑。

## 待办（新 Agent 接手后优先）

1. ~~**真实 Pi 全链路验证（2.2）**~~ ✅ 已完成（见上"当前状态"表 + 坑 9-13）。凭证在 `deepseek_config.txt`，DB `data/real-pi-multi.db`（16 Case）。`npm run check` 0 错误、`npm run test` 78 passed、Fake Pi songwriting 7 Turn approved 无回归。
2. ~~**真实 Pi kill -9 崩溃恢复 + persistent session 跨进程历史续跑（2.3 硬指标）**~~ ✅ 已完成（2026-07-25 续，见下"最近的改动"）。`scripts/crash-recovery-realpi-e2e.cjs` 9 项全 YES：真实 `taskkill /F /T`、从 Turn N+1 续跑、已完成 Turn/产物哈希不变（铁律 4）、persistent supervisor session `.jsonl` 7->23（跨进程历史续跑）、续跑后 context_snapshot 含崩溃前产物、最终 approved + 门禁 pass。修复要点：worker recovery 路径接上 `RealPiAdapter.resumeSession`（坑 15）、`resumeSession` 改用 `SessionManager.open` 显式定位文件 fail-loud（坑 16）、恢复消息附 Case 状态摘要（坑 17）。
3. 真实 Pi 连续 3 次异常 Turn 需停下汇报（异常检测软规则，不是预算约束）。空响应重试已加（3 次），但连续异常 Turn 计数与停汇报尚未实现。

## 最近的改动（2026-07-25，均未纳入 git）

### 早期修复（依赖 + Fake Pi 链路）
- 修复依赖（重装 + `.npmrc` allow-scripts + rebuild native）
- 修 `tool-executor.ts`：`publish_artifact` 返修时补 `claimed_fixed` issue_event（铁律 4）
- 修 `recovery.ts`：放宽 `findCasesNeedingRecovery` + `recoverCase` 状态转换，让事务化下崩溃恢复能触发
- 修 `fake-pi.ts`：加 `setTurnCounter`；`main.ts`：恢复时对齐脚本 + `MAX_TURNS` 测试钩子
- 新增 `issue-lifecycle.test.ts`、重写 `crash-recovery.test.ts`、新增 `scripts/crash-recovery-e2e.cjs`
- 新增本 `CLAUDE.md`

### 真实 Pi 全链路验证（2.2）+ 5 个真实 bug 修复（2026-07-25 续）
跑 16 个真实 Pi Case 过程中暴露并修复（`npm run check` 0 错误 / `npm run test` 78 passed / Fake Pi 无回归）：

1. **`pi-adapter.ts` registerSession 别名 bug**（坑 10）：cold_per_version 复用时新 session 被指向已 dispose 的旧 state，导致复审 Turn 6 稳定返回空响应。改为显式 `(sessionId, piSessionRef)` 别名 + closeSession 清所有 key。
2. **`pi-adapter.ts` 空响应重试**（坑 9）：deepseek 推理模型偶发只产出 thinking、无 text/tool_use。加最多 3 次重试（追加 nudge 迫使调工具）。
3. **`main.ts` 返修状态机闭环**（坑 11）：generator 发返修版时允许 `repairing->waiting_review`，避免 `repairing->repairing` 非法转换 fatal。
4. **`tool-executor.ts` routeMessage 自动补齐 issue_ids**（坑 12，支柱一）：supervisor 漏填结构化 issue_ids 时系统自动关联当前 open blocking issues。
5. **`tool-executor.ts` publishArtifact scope_violation 续修**（坑 13）：越界后自动重发同 scope 返修指令 + 父本取最后非 rejected 版本，让 generator 合规重试能关联返修、Issue 走到 verified。
6. **`scenarios/songwriting/prompts/reviewer.md`** 重写为严格清单审核（6 项 blocking 检查 + 怀疑默认立场），让 reviewer 真实挑出破韵等问题。
7. **`scenarios/songwriting/prompts/generator.md`** 加"返修不增删行、只替换 editable 行文字"约束，降低 scope_violation 触发。
8. **`scenarios/songwriting/scenario.yaml` + `copywriting/scenario.yaml`**：加 `to_supervisor`/qc 的 `target_issues` 上下文规则。
9. **`main.ts`** 返修消息补 issue 详情（problem/anchor/evidence），让 supervisor 能构造 editable/frozen 范围。

**验证证据**：`data/real-pi-multi.db` case `case_a0e2f9df46054bf8`（7 Turn approved）：Issue `created->repairing->claimed_fixed->verified`，RevisionInstruction `verified`（editable=line:11,12 / frozen=金句+其余），v1 superseded / v2 delivered，门禁 pass。日志 `data/case*.log`。

### 临时调试脚本（`scripts/`，throwaway，已纳入 check）
`finalize-cases.ts`（标非终态 case 为 stopped）、`dump-case.ts`、`verify-lifecycle.ts`、`inspect-issues.ts`、`repro-empty-review.ts`、`real-pi-probe.ts` 等。可保留供后续调试或删除。

### Real Pi kill -9 崩溃恢复 + persistent session 跨进程续跑（2.3 硬指标，2026-07-25 续）
跑 `scripts/crash-recovery-realpi-e2e.cjs`（真实 DeepSeek + `taskkill /F /T`）暴露并修复（`npm run check` 0 错误 / `npm run test` 78 passed / Fake Pi e2e 8 项无回归）：

1. **`main.ts` recovery 接 RealPi resumeSession**（坑 15）：persistent session 复用分支先 `await pi.resumeSession(pi_session_ref)` 再 `registerSession`，否则进程重启后 adapter 内存 map 空、`executeTurn` 报 `Session not found`。
2. **`pi-adapter.ts` resumeSession 改 `SessionManager.open`**（坑 16）：显式定位 `.jsonl` 文件，fail loud；弃用 `continueRecent`（会静默新建空 session 丢历史）。
3. **`main.ts` buildResumeContextMessage**（坑 17）：恢复消息附 Case 状态/产物版本/Issue/返修指令摘要，避免模型收到模糊"续跑"后停滞。
4. **`main.ts`** 评测失败消息去业务硬编码："派给 generator" -> "派给负责生成产物的 Agent"（铁律 1）。
5. 新增 `scripts/crash-recovery-realpi-e2e.cjs`：真实 kill -9 + 重启，9 项断言（含 persistent session `.jsonl` 跨进程条目增长、context_snapshot 含崩溃前产物）。
6. 新增 `README.md`（交付标准 4.2）：安装/启动 worker/启动 web/Fake Pi/真实 Pi/环境变量说明。

**验证证据**：`data/crash-realpi.db` case `case_258d56979d924d13`（5 Turn approved）。Phase 1 跑 2 Turn 后 `taskkill /F`，Phase 2 同 DB+同 session dir 重启续跑：Turn 1-2 哈希不变（铁律 4）、v1 `draft->delivered`（同 content_hash `b13f4594`）、persistent supervisor session `.jsonl` 7->23 条目（跨进程历史续跑）、recovery 控制事件 `recovery_started`+`recovery_completed`、门禁 `fail,pass`（首次未过、调整后过）、最终 `approved`。

### Case 输入配置驱动（铁律 1 收尾，2026-07-25 续）
修 `main.ts` 把新 Case 输入从硬编码歌词改为配置驱动（坑 18）：
- 新增 `resolveInputPayload`：`FORGE_INPUT`(JSON) > `FORGE_INPUT_FILE`(路径) > `<scenario 目录>/input.example.json` > fail loud；按 `scenario.input_fields` 校验字段齐全，缺字段 fail loud。
- 新增 `renderInputMessage`：按 field label 通用渲染首条消息（去掉"参考歌词/固定金句"歌词语义）。
- title 用 `scenario.name`（歌词生产/文案生产），不再写死"歌词生产"。
- 新增 `scenarios/songwriting/input.example.json`、`scenarios/copywriting/input.example.json` 示例输入。

**验证证据**：`npm run check` 0 错误 / `npm run test` 78 passed / Fake Pi songwriting e2e 8 项无回归。copywriting Fake Pi 实测：title "文案生产"、input_payload `{"product_name":...,"promotion_info":...}`、首条消息"产品名称:…促销信息:…"、最终 approved。`FORGE_INPUT` 环境变量覆盖实测生效；缺字段实测 fail loud（`输入缺少必填字段：fixed_phrase`）。
