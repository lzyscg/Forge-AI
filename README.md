# Forge AI

> 多 Agent 协作内容生产平台。在多个 AI Agent 之间搭一个可靠的中间层：让它们安全交接工作成果，系统独立掌握"生产到哪了、哪些成果有效、什么问题没解决"，交付由系统门禁决定而非 Agent 自说自话。

## 这是什么

Forge AI 不是"模型多强"，而是**中间层接管工程、模型只管内容**。典型链路（歌词场景）：

```
总控派任务 → 生成 v1 → 审核挑刺 → 总控下发定点返修(editable/frozen) → 生成 v2 → 复审通过 → 申请交付 → 系统门禁核对 → approved
```

歌词只是示例，换"文案+质检"或"故事大纲+章节"骨架不变（配置驱动，零代码改场景）。

## 四根支柱

| 支柱 | 含义 |
|---|---|
| **中间层接管工程** | 模型只调工具，系统补齐 ID/版本/时间戳/路由/JSON。模型不碰工程数据。 |
| **产物与问题是第一等对象** | 交付由系统门禁决定，不是 Agent 说了算。`claimed_fixed` ≠ 关闭，只有 `verified` 算。 |
| **受控返修** | editable/frozen 行级范围，越界版本 `rejected` 不进复审。 |
| **配置驱动** | 平台代码零业务分支，新场景只写 YAML + 提示词。 |

## 架构（单向依赖：`contracts → domain → application → adapters → apps`）

| 层 | 职责 | 关键文件 |
|---|---|---|
| **contracts** | typebox 数据契约 + 端口接口（PiPort/RepositoryPort/ClockPort/ConfigLoaderPort）+ ResultJson | `packages/contracts/src/{scenario,ports,tools,result}.ts` |
| **domain** | 纯状态机 + 门禁 + 越界校验（纯内存单测，不碰 DB/Pi） | `packages/domain/src/{case-state,issue-state,delivery-gate,scope-validator,state-transitions}.ts` |
| **application** | Turn 编排 + 工具执行 + 上下文构建 + 崩溃恢复 + **CaseRunner**（核心） | `packages/application/src/{case-runner,turn-executor,tool-executor,recovery,context-builder}.ts` |
| **adapters** | SQLite + Fake Pi + Real Pi + 路径/两库配置 | `packages/adapters/src/{sqlite-repository,fake-pi,pi-adapter,paths}.ts` |
| **apps** | 三入口：worker（薄封装）/ cli（`forge`，主入口）/ web（人操作台） | `apps/{worker,cli,web}` |

## 运行时模型

```
Case（一次生产任务）
 └─ Turn 循环（CaseRunner.runTurnLoop，每个 Agent 一轮）
     ├─ 取/建 Pi Session（persistent 跨轮记忆 / cold_per_version 每轮新开）
     ├─ ContextBuilder 组装上下文（system prompt + context_rules）
     ├─ 调 Pi（真实模型 / Fake 脚本）→ 模型调工具
     ├─ ToolExecutor 执行工具（事务内）→ 改 Issue/产物/指令状态
     └─ 路由决策（publish→reviewer / eval-fail→返修 / gate-fail→start_agent）
```

**5+1 工具**：`publish_artifact` / `submit_evaluation` / `route_message` / `approve_delivery` + `request_human_input`（降级停 waiting_human）+ `read`（受限，仅可读 `scenarios/<name>/skills/`，铁律 6 白名单）。

**交付门禁 5 项**（domain 层，Agent 调 `approve_delivery` ≠ 交付）：版本有效 / 该版审核通过 / 所有 blocking Issue `verified` / 无运行中返修 / 无未完成 Turn。

**返修机制**：supervisor 划 editable/frozen 范围，`scope-validator` 逐行校验，越界 `rejected` + 自动重发指令；issue 必须走到 `verified` 才能过门禁。

## 三个操作面

| 入口 | 定位 |
|---|---|
| **CLI `forge`** | 主入口，agent 友好。`forge case create/run/status/list/resume/stop` + `template/artifact/diff/gate`。默认 JSON 输出。 |
| **Web UI** | 人操作台（Next.js）。泳道+箭头/diff/issue/门禁/敏感诊断折叠 + 创建跑 Case / waiting_human 恢复。 |
| **Worker `npm run dev`** | 薄封装，一次性建+跑。 |

三者复用同一个 **CaseRunner**（application 层）。

## 两库模型

| env | DB | 用途 |
|---|---|---|
| `production` | `data/production.db` | 正式生产 Case（默认） |
| `test` | `data/test.db` | 测试 / 临时验证 |
| `all` | 聚合两库 | 只读查看 |

CLI `--env production|test|all`（写操作拒 `all`），Web topbar 下拉切换，`FORGE_ENV` 切默认。

## 快速开始

### 安装

```bash
npm install
# 若 better-sqlite3 native 二进制缺失：
npm rebuild better-sqlite3 esbuild
```

需要 Node ≥ 20（实测 v24）、npm 11。

### 跑 Fake Pi（不花钱，几秒）

```bash
npx forge case create --template songwriting --db ./data/song.db
npx forge case run <case_id> --wait --db ./data/song.db
# 末行 JSON: success:true + final_artifact + gate.status:pass
```

### 换场景（证配置驱动）

```bash
npx forge case create --template copywriting --db ./data/copy.db
npx forge case run <id> --wait --db ./data/copy.db
```

### 真实 Pi

```bash
DEEPSEEK_API_KEY=sk-xxxx npx forge case run <id> --wait --mode real --db ./data/real.db
```

## 知乎短故事仿写生产

故事仿写不是把多个 `forge case` 手工串起来，而是使用仓库内的外部多 Case 编排器。它把内容生产拆成多个独立场景，并负责输入、父版本、Case 身份、Manifest、文件哈希、恢复和下游失效传播；每个 Case 自己负责故事内容的生成、审核和质量门禁。

完整链路：

```text
故事输入 → zhihu-story-outline → zhihu-chapter-packet
  → zhihu-chapter-draft → zhihu-story-ledger → zhihu-story-final
```

生产 Agent 必须先阅读：

- [外部编排器说明](orchestrators/story-pipeline/README.md)
- [从头生产使用说明](orchestrators/story-pipeline/外部编排器从头生产使用说明.md)

### 从头运行真实故事

前置条件：Node.js ≥ 20、依赖已安装、仓库根目录 `.env` 中存在 `DEEPSEEK_API_KEY`，以及一份可读取的原始故事文件。密钥只能放在环境变量中，不得写入命令、日志、Manifest 或 Git。

生产配置可参考 [单章配置示例](orchestrators/story-pipeline/examples/imitation-one-chapter.json)。`data/` 被 Git 忽略，因此新环境不能假定存在真实生产配置；可以从该示例复制一份，再填写当前故事的 `run_id`、`story_id`、`title`、`source_file`、`requirements` 和 `chapters`。真实生产必须使用新的运行目录和 Forge DB；`data/story-runs/gaokao-zero-real-003` 仅是历史恢复验收目录，不得复用。

```powershell
# 从受跟踪的示例复制配置（若本机已有生产配置，也只能复制配置文件，不能复制旧 run 目录）
New-Item -ItemType Directory -Force data/story-runs | Out-Null
Copy-Item orchestrators/story-pipeline/examples/imitation-one-chapter.json data/story-runs/gaokao-zero-fresh-001-config.json

$configPath = "data/story-runs/gaokao-zero-fresh-001-config.json"
$config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
$config.run_id = "gaokao-zero-fresh-001"
# 按当前输入填写 source_file、story_id、title、requirements 和 chapters
$config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $configPath

npx tsx orchestrators/story-pipeline/src/index.ts run `
  --config data/story-runs/gaokao-zero-fresh-001-config.json `
  --mode real `
  --run-dir data/story-runs/gaokao-zero-fresh-001 `
  --db data/story-runs/gaokao-zero-fresh-001/forge.db
```

不要增加阶段停止参数、手工接力或手工修改 Manifest。正常情况下编排器会自动运行到 `final`。如果进程意外退出，使用同一组参数重跑；如果出现 `ambiguous`、模板身份不一致或 `fail-closed`，停止并报告，不要绕过门禁。

只有命令退出码为 0、输出包含 `success: true` 和 `final_artifact`，且 Manifest 中 outline、packet、draft、ledger、final 均有 delivered 记录、正式产物和校验报告齐全时，才能报告整条链路完成。终稿必须以编排器落盘的 `final_artifact_path` 为准。

### Web 操作台

```bash
cd apps/web && npm run build && npm run start   # http://localhost:3000
# topbar 右侧下拉切 生产/测试/全部
```

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `PI_MODE` | 是 | `fake` | `fake` / `real` |
| `DB_PATH` | 否 | `data/production.db` | 显式覆盖库路径（优先级高于 `--env`） |
| `FORGE_ENV` | 否 | `production` | `production` / `test` |
| `SCENARIO_PATH` | 是 | `./scenarios/songwriting/scenario.yaml` | 场景 YAML |
| `DEEPSEEK_API_KEY` | `real` 时必需 | - | 只走环境变量，不进日志/DB/前端（铁律 6） |
| `PI_MODEL_ID` | 否 | `deepseek-v4-flash` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `FORGE_INPUT` | 否 | - | 新 Case 输入 JSON；不设则读 `<scenario>/input.example.json` |
| `MAX_TURNS` | 否 | `20` | 测试钩子：限制 Turn 数 |

## 命令速查

```bash
# 检查与测试
npm run check            # tsc --noEmit；若只报 docs/archive/forge-ai-mvp-report.canvas.tsx，属于历史归档文件问题
npm run test             # vitest，364 passed

# CLI（主入口）
npx forge case create --template songwriting --env production
npx forge case run <id> --wait --env production
npx forge case list --env all                    # 聚合两库
npx forge case status <id> --env production
npx forge case resume <id> --answer '...' --env test   # 恢复 waiting_human
npx forge case stop <id> --env production
npx forge template list / show <name> / validate <name>
npx forge artifact get <case_id> / diff <case_id> / gate <case_id>

# 崩溃恢复测试
node scripts/crash-recovery-e2e.cjs                        # Fake Pi 8/8
DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs   # 真实 kill-9

# Skill 装配验证（零 token）
npx tsx scripts/skill-verify-probe.ts
```

说明：`docs/archive/forge-ai-mvp-report.canvas.tsx` 是历史画布文件，不属于运行代码；如果 `npm run check` 只因该文件报错，不要把它误判为故事编排器或 Case 生产失败。生产验收仍以编排器命令退出码、Manifest、正式产物和 validation 证据为准。

## 场景（配置驱动，零代码）

| 场景 | Agent | 产物 |
|---|---|---|
| songwriting | supervisor/generator/reviewer | lyrics |
| copywriting | writer/qc | copy |
| zhihu-story-outline | outline-architect/outline-auditor | 大纲 |
| zhihu-chapter-packet | packet-compiler/packet-auditor | 执行包 |
| zhihu-chapter-draft | chapter-writer/chapter-auditor | 单章正文 |
| zhihu-story-final | manuscript-assembler | 终稿 |
| zhihu-story-ledger | ledger-updater | 账本 |

故事流水线编排器（`orchestrators/story-pipeline/`）在 Forge 平台之上编排多 Case 链：故事输入 → 大纲 → 执行包 → 单章正文 ×N → 终稿 + 账本。

## 项目结构

```
contracts/   数据契约 + 端口接口
domain/      纯状态机 + 门禁 + 越界校验（纯单测）
application/ CaseRunner + Turn/Tool/Context/Recovery 编排
adapters/    SQLite + Fake Pi + Real Pi + 路径/两库配置
apps/worker  薄封装入口（npm run dev）
apps/cli     forge CLI（主入口）
apps/web     Next.js 操作台
scenarios/   场景配置（YAML + 提示词 + skills + Fake Pi 脚本）
orchestrators/story-pipeline/  故事多 Case 编排器
scripts/     e2e 测试 + 探针 + 调试工具
docs/archive/  已完成的过程文档（历史归档）
```

## 核心概念

| 概念 | 含义 |
|---|---|
| **Case** | 一次生产任务。状态：running/waiting_review/repairing/waiting_human/approved/failed/stopped |
| **Turn** | 一个 Agent 一轮。事务化原子提交（queued→running→completed），崩溃回滚不残留 |
| **Issue** | 审核挑出的问题。`open→repairing→claimed_fixed→verified`（claimed_fixed 不关门禁） |
| **返修指令** | editable/frozen 行级范围。越界版本 `rejected`，单活跃约束 |
| **产物版本** | append 不覆盖。v1 superseded / v2 delivered |
| **交付门禁** | 5 项独立核对，全绿才 approved |

## 六条铁律

详见 `AGENTS.md`：①不写死业务 ②模型不碰工程数据 ③交付是系统决定 ④一切追加不覆盖 ⑤单向依赖 ⑥不泄密。

## 崩溃恢复

- Turn 事务化（崩溃回滚不残留 running Turn）。
- persistent session 文件持久化（`.jsonl`），跨进程恢复完整对话历史。
- `forge case run <id>` 对非终态 Case 续跑（recoverCase → 清孤儿 → decideResumeAgent 程序化路由）。
- 真实 kill-9 + 重启验证过（persistent session `.jsonl` 跨进程历史续跑）。
