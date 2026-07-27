# Forge AI MVP

让多个 AI Agent 协作完成一次内容生产任务的运行平台。核心不是"模型多强"，而是在多个 Agent 之间搭一个可靠的中间层：让它们安全交接工作成果，并让系统始终独立掌握"现在生产到哪了、哪些成果有效、什么问题没解决"。

典型链路（歌词场景）：总控派任务 → 生成写初稿 v1 → 审核挑出问题 → 总控下发"只改第 4 行、其余冻结"的返修 → 生成改出 v2 → 复审通过 → 总控申请交付 → **系统独立核对门禁** → 正式交付。歌词只是示例，换"文案 + 质检"骨架不变。

> 入口文档顺序：`CLAUDE.md` → `AGENTS.md`（六条铁律）→ `Forge_AI_MVP_需求文档.md` → `PLAN.md` → `交付标准.md` → `返修清单.md`。

---

## 技术栈

- **Node v24 / npm 11**，TypeScript ^5.5，npm workspaces 单仓多包
- **SQLite**（better-sqlite3 11.x，WAL + busy_timeout=5000）作为唯一持久化
- **Pi SDK**：`@earendil-works/pi-coding-agent`@0.82（Agent Runtime，**不是** `pi-ai`）
- **typebox**@1.1.38（数据契约）
- **vitest**（单测 + 集成），**Next.js 14**（只读回放页，轮询非 SSE），**tsx**（worker 运行）

分层（铁律 5：单向依赖）：
```
contracts  ->  domain  ->  application  ->  adapters  ->  apps
```
- `packages/contracts`：typebox 数据契约 + 端口接口（PiPort/RepositoryPort/ClockPort/IdGeneratorPort/ConfigLoaderPort）
- `packages/domain`：纯状态机 + 门禁 + 越界校验（可纯内存单测，不碰 DB/Pi）
- `packages/application`：Turn 编排 + 工具执行 + 上下文构建 + 崩溃恢复
- `packages/adapters`：SQLite + Fake Pi + Real Pi + 基础适配器
- `apps/worker`：唯一启动 Pi Session 的入口
- `apps/web`：只读回放页（不调 Pi）

---

## 安装依赖

```bash
npm install
```

> **必须本机 `npm install`，不能从别处拷贝 `node_modules`**（坑 5）。仓库已带 `.npmrc`（`allow-scripts=true`），npm 11 默认拦 native 脚本，需要允许。安装后若 better-sqlite3 / esbuild 的 native 二进制缺失，补一次：

```bash
npm rebuild better-sqlite3 esbuild
```

环境要求：Node `>=20`（`engines` 写 `>=20`，实测 v24 可用），npm 11。

---

## 环境变量

复制 `.env.example` 为 `.env`（worker 不自动加载 `.env`，以下变量直接在命令前缀里传或 `export`）：

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `PI_MODE` | 是 | `fake` | `fake` 用脚本驱动；`real` 接真实 Pi + DeepSeek 模型 |
| `DB_PATH` | 否 | `data/production.db` | SQLite 文件路径（显式覆盖，优先级最高；自动创建父目录）。不设时按两库模型：`FORGE_ENV=test` -> `data/test.db`，否则 `data/production.db` |
| `FORGE_ENV` | 否 | `production` | 数据库环境选择（`production` / `test`），与 CLI `--env`、Web env 选择器共用同一配置 |
| `SCENARIO_PATH` | 是 | `./scenarios/songwriting/scenario.yaml` | 场景配置 YAML |
| `DEEPSEEK_API_KEY` | `PI_MODE=real` 时必需 | — | DeepSeek API Key（铁律 6：只走环境变量，不进日志/DB/前端） |
| `PI_MODEL_ID` | 否 | `deepseek-v4-flash` | 模型 ID（`deepseek-v4-flash` 或 `deepseek-v4-pro`） |
| `PI_SESSION_DIR` | 否 | `./data/pi-sessions` | persistent Pi Session 文件持久化目录 |
| `FORGE_INPUT` | 否 | - | 新 Case 的输入 payload（JSON 字符串），形状对应当前场景的 `input_fields` |
| `FORGE_INPUT_FILE` | 否 | - | 新 Case 输入 payload 的 JSON 文件路径（多行内容推荐用这个） |
| `MAX_TURNS` | 否 | `20` | 测试钩子：限制本轮执行的 Turn 数（模拟"跑到一半退出"，用于崩溃恢复测试） |

> 若 `FORGE_INPUT` / `FORGE_INPUT_FILE` 都未设置，worker 会读 `<scenario 目录>/input.example.json` 作为示例输入；都没有则 fail loud。每个场景自带一份 `input.example.json`（songwriting 歌词、copywriting 产品信息）。

---

## 启动 Worker

### Fake Pi 场景（默认歌词）

```bash
PI_MODE=fake DB_PATH=./data/song.db SCENARIO_PATH=./scenarios/songwriting/scenario.yaml npm run dev
```

跑完后 `./data/song.db` 里会有一个 `approved` 的 Case：7 Turn、v1 superseded / v2 delivered、blocking Issue `created→repairing→claimed_fixed→verified`、门禁 5 项全 pass。

### 第二场景（证伪硬编码）

```bash
SCENARIO_PATH=./scenarios/copywriting/scenario.yaml DB_PATH=./data/copy.db npm run dev
```

不修改任何平台源代码，只换 YAML，Agent 变成 writer/qc、产物类型变成 copy。

### 真实 Pi 场景

```bash
PI_MODE=real DEEPSEEK_API_KEY=sk-xxxx PI_MODEL_ID=deepseek-v4-flash \
  DB_PATH=./data/real.db SCENARIO_PATH=./scenarios/songwriting/scenario.yaml npm run dev
```

> deepseek 是推理模型，会返回 `thinking` block。adapter 已做空响应重试（最多 3 次）。真实 Pi 全链路较慢（每个 Turn 一次真实 API 调用）。

---

## CLI 操作系统（Round 2 新增）

```bash
# 查看帮助
npx forge --help

# Fake Pi 全链路
npx forge case create --template songwriting --input '{"reference_lyrics":"...","fixed_phrase":"..."}' --db ./data/cli.db
npx forge case run <case_id> --wait --db ./data/cli.db

# 真实 Pi
DEEPSEEK_API_KEY=sk-xxxx npx forge case run <case_id> --wait --mode real --db ./data/cli.db
```

完整命令见 `使用说明.md` 第 11 章。

---

## 启动 Web 回放页

```bash
cd apps/web && DB_PATH=<绝对路径到 *.db> npx next dev -p 3137
# 浏览器打开 http://localhost:3137
```

页面只读连接 SQLite，不调 Pi。功能：Agent 泳道 + 路由箭头、产物版本行级 diff（editable/frozen 标记）、Issue 生命周期、交付门禁逐项结果、Turn 三层折叠（含"敏感诊断·默认折叠"的模型实际输入）。轮询刷新（非 SSE）。

---

## 测试

```bash
npm run check             # tsc --noEmit，0 错误
npm run test              # vitest 单元 + 集成（78 passed）
npm run test:integration  # 真实 PG 配置（本项目用 SQLite，可能为空）
npm run test:e2e          # 端到端（若配置）
```

### 崩溃恢复端到端测试

Fake Pi（进程级 kill + 重启，非内存模拟）：

```bash
node scripts/crash-recovery-e2e.cjs
```

真实 Pi kill + 重启 + persistent session 历史续跑断言：

```bash
DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs
```

---

## 场景配置

新场景只写 YAML + 提示词 + Fake Pi 脚本，不碰平台代码（支柱四）：

- `scenarios/songwriting/`：supervisor/generator/reviewer，产物 lyrics
- `scenarios/copywriting/`：writer/qc，产物 copy

每个场景含 `scenario.yaml`（agents/routes/context_rules/artifact_types/delivery）、`prompts/*.md`、`fake-pi-script.json`。

---

## 关键约束（摘要）

详见 `AGENTS.md`（六条铁律）与 `CLAUDE.md`（坑 1-13）。最重要的几条：

1. **不把业务写死进平台**：平台代码零业务分支，新场景只写 YAML。
2. **模型不碰工程数据**：模型只调工具，系统补齐 ID/版本/时间戳/路由。
3. **交付是系统的决定**：`approve_delivery` 不等于交付，系统独立核对 5 项门禁；`claimed_fixed` 不算关闭，只有 `verified` 算。
4. **一切追加，绝不覆盖**：产物版本追加不覆盖，Issue 状态以事件追加。
5. **架构单向依赖**：`contracts → domain → application → adapters → apps`。
6. **不泄密**：API Key 只走环境变量，不进日志/DB/前端；thinking 默认折叠。

> **不要读旧仓库代码**：父目录的旧 TS monorepo 和 `pi-pipline-main` Python 项目是失败品，只保留"分层约定"思路，不复用一行实现。`docs/HANDOFF.md` 已过时，不要依据它判断当前状态。
