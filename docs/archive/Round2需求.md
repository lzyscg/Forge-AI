# Forge AI Round 2 需求规格（定稿）

> 经过 5 轮对抗性审查（grill-me）收敛。所有会让开发 agent 卡住或建错东西的歧义、矛盾、假 API 假设、铁律冲突均已挖出并由用户拍板定清。本文档是交给开发 agent（通过 harness）执行的最终规格。

## 总目标

把 MVP 从"能跑通一次"升级为**可操作的系统**。验收线 = **可操作**（人/agent 能通过 CLI/UI 跑 case 并查看结果）。"agent 自动迭代"留到后续（依赖质量反馈闭环，本轮不做）。

## 决策汇总

| 项 | 决定 |
|---|---|
| 运行终止 | 最大 Turn 数，默认 20，`--max-turns` 可覆盖；达到上限 case 标 `stopped`、`success=false` |
| JSON 返回 | 至少含最终产物（内容+位置）+ case 是否成功；完整 schema 见 Feature 1 |
| create/run | 分开；`case run` 默认 `--wait`（阻塞返回 JSON）；**`--no-wait` 本轮砍掉**（UI 用 spawn 已异步） |
| 并发 | 单 case；`case run`/`resume` 若另一 case 处于 `running` 则拒绝并提示 |
| 路由逻辑 | main.ts 路由决策（auto-route/eval-fail 消息/scope_violation 续修）**原样抽进 core，保留行为，本轮不挪进配置**（硬约束） |
| waiting_human | **纳入 round 2**：显式 `forge case resume <id> --answer` 恢复，走 runTurnLoop 不 recover |
| Skill | Pi 原生 resourceLoader（Path A）+ read 工具 + access 白名单；5+1 工具口径；验收改机制验证 |
| UI 运行 | UI 直接调 CLI（detached spawn）+ 直连 SQLite 读 |
| e2e | 改用 CLI（spawn --wait + 轮询 status JSON + taskkill），不解析 stdout |
| CLI 调用 | `npx forge ...`（package.json bin，JS shim，非 tsx shebang） |
| 路径基准 | 包根（`import.meta.url`），非 process.cwd()；任意 cwd 可跑 |
| 待办 3 | **不做**（连续异常 Turn 停汇报）；现有 consecutiveErrors 逻辑原样搬迁，单次 run 内累加 |

---

## Feature 1 · CLI 操作系统（最优先）

### 入口与命令面
- `package.json` 加 `"bin": {"forge": "./apps/cli/bin.js"}`。bin 是 **JS shim**（`#!/usr/bin/env node`），用 tsx programmatic API（`./esm/api`）跑 TS 入口。**不用 tsx shebang**（Windows 不认）。
- CLI 实现放 `apps/cli/`。命令解析用 `commander` 依赖。
- 路径解析基准 = **包根**（`import.meta.url` 定位 package.json 目录）。scenarios/data/.env 都相对包根。`--db` 可覆盖 data 路径。

命令：
- `forge template list` - 扫 `scenarios/` 下含 `scenario.yaml` 的子目录
- `forge template show <name>` - 读 `scenarios/<name>/scenario.yaml` 打印结构
- `forge template validate <yaml>` - **新增运行时 typebox schema** parse ScenarioConfig + 检查引用的 prompt/脚本文件存在
- `forge case create --template <name|path> --input '<json>' [--db] [--mode] [--title]` -> `{case_id}` JSON（name 解析为 `scenarios/<name>/scenario.yaml`，path 直接用）
- `forge case run <id> [--wait] [--max-turns N] [--db] [--mode]` - 跑到终态。默认 `--wait`
- `forge case status <id> [--db]` - 完整运行信息 JSON
- `forge case list [--db]` - 所有 case 摘要
- `forge case resume <id> --answer '<text>' [--db] [--mode]` - 注入人工答案恢复 waiting_human case
- `forge case stop <id>` - 标非终态非 running 的 linger case 为 `stopped`
- `forge artifact get <case_id> [--version N] [--db]` - 产物内容
- `forge diff <case_id> [--db]` - 版本 diff（含 editable/frozen/violation）
- `forge gate <case_id> [--db]` - 门禁逐项结果

输出：默认 JSON；`--human` 给人看。

### run / status 返回 JSON schema
```jsonc
{
  "case_id": "case_xxx",
  "status": "approved|stopped|failed|waiting_human|...",
  "success": true,              // status === "approved"
  "final_artifact": {           // 最新版本（不论状态）；无版本则 null
    "type": "lyrics", "version": 2, "status": "delivered",
    "content": "...", "artifact_id": "art_xxx", "version_id": "av_xxx"
  },
  "turns": { "count": 7, "items": [ { "seq":1, "agent":"supervisor", "tools":["route_message"], "produced":[] } ] },
  "issues": [ { "id":"iss_xxx", "severity":"blocking", "status":"verified", "problem":"..." } ],
  "gate": { "status":"pass", "checks":[ { "name":"...", "passed":true } ] },  // 无 gate 结果则 null
  "diff": { "from_version":1, "to_version":2, "changed":[11,12], "frozen":[18], "violations":[] },  // <2 版本则 null
  "action_required": null,      // waiting_human 时填 "use 'forge case resume <id> --answer'"
  "error": null                 // stopped/failed 的原因；否则 null
}
```

### 命令行为
- **单 case 强制**：`case run`/`resume` 启动前 `SELECT COUNT(*) FROM cases WHERE status='running' AND case_id != <id>`，>0 拒绝并提示那个 case。崩溃 case（waiting_review/repairing/waiting_recovery，无进程）不阻塞；waiting_human 不阻塞。竞态（两 run 同时过检查）round 2 单用户可接受。
- **终态 case `run <id>`**：幂等返回当前 status JSON（不报错）。
- **waiting_human case `run <id>`**：返回当前 JSON（status=waiting_human）+ `action_required:"use 'forge case resume <id> --answer'"`，exit 0。
- **`stop <id>`**：仅允许非终态且非 running 的 case（waiting_review/repairing/waiting_recovery/waiting_human）。若 running 拒绝（round 2 无 pid 注册表）。turn-executor 入口加守卫防竞态（见横切）。
- **`npm run dev`**（薄封装，保留）：不带 case_id 时保留现有"用 FORGE_INPUT/input.example.json 建新 case + 跑"行为（向后兼容）。

### stdout 协议（双阶段，供 UI spawn 用）
- **第 1 行**（case 创建后立刻，或拒绝时）：`{"case_id":"..."}` 或 `{"error":"...","blocking_case_id":"..."}`（拒绝 exit 非 0）。
- **末行**：完整结果 JSON（schema 同上）。
- 用 `fs.writeSync(1, json + '\n')` **同步写强制 flush**（普通 console.log 在管道块缓冲下不 flush）。
- **stdout 纯净硬约束**：stdout 只有第 1 行 + 末行。所有进度走 stderr + 文件 logger，不得进 stdout。
- runCase 中途 fatal 也要 `fs.writeSync(1, errorJson)` 末行 + exit 非 0（不能只 console.error，API route stderr ignore 会丢）。

### 日志机制
- forge CLI 启动即建注入 logger 写 `data/case-<caseId>.log`（case 创建后用 case_id 命名；创建前的少量日志写 stderr）。
- CaseRunner/turn-executor/recovery 的 `console.log` 全部改为注入 logger（application 层接收 logger 注入，不直接 console.log——铁律 5 层职责）。
- API route 只读 stdout 第 1 行，**不 pipe 任何东西到文件**（forge 自管日志）。UI 按 case_id 直接读 `data/case-<caseId>.log`。

### 核心提取（CaseRunner）
把 `apps/worker/src/main.ts` 的"建 case + Turn 循环 + 崩溃恢复 + 路由决策"抽成 `packages/application` 里的 `CaseRunner`（可复用 service）。`main.ts` 降为薄封装。CLI/worker 进程内复用 CaseRunner；web 通过 spawn CLI 间接复用 + 直连 SQLite 读。

CaseRunner 形状：
- `createCase(input): string`
- `runCase(caseId, opts): ResultJson` - 终态?幂等返回 : waiting_human?幂等+hint : `RecoveryService.recoverCase(caseId)`（只恢复传入 caseId，不扫全表）+ `runTurnLoop(...)`
- `runTurnLoop(caseId, agentKey, message)` **私有** - 跑 Turn 循环到终态。路由决策原样搬（不改语义）。
- `resumeCaseWithHumanInput(caseId, answer): ResultJson` - transitionCase(waiting_human->running) + 找调用 request_human_input 的 agent（从最后 Turn 的 tool_actions）+ 注入答案 user message + **走 runTurnLoop（不 recover）**跑到终态。

关键搬迁约束：
- 路由决策（publish 后自动找 reviewer / eval-fail 构造返修消息带 issue 详情 / scope_violation 续修 / 门禁未过回 start_agent）**原样搬迁不改语义**（硬约束）。
- `buildResumeContextMessage` 从 main.ts 搬进 CaseRunner（application 层，只依赖 repo+config）。
- 启动时"自动扫全表恢复第一个非终态 case"的行为**移除**。recovery 只在 `runCase(caseId)` 内对传入的 caseId 触发。
- `consecutiveErrors` 原样搬进 runTurnLoop（单次 runTurnLoop 内累加，不跨 run 持久化）。待办 3 不做。
- scenarioConfig + scenarioPath 在 CaseRunner 作用域内（CaseRunner 接收 scenarioPath 参数，构造 `scenarioSkillsPath = path.resolve(dirname(scenarioPath), 'skills')`）。

### e2e 改造
- `crash-recovery-e2e.cjs` / `crash-recovery-realpi-e2e.cjs` 改用 CLI：spawn `forge case run <id> --wait`（长阻塞 P1），另起 `forge case status <id>`（JSON P2）轮询 `turns.count >= N`，达到后 `taskkill /F /T` P1（真实 kill，case 留 running，事务回滚），再 `forge case run <id>`（P3）从 Turn N+1 续跑。不解析 stdout，用 status JSON 判时机。
- e2e spawn forge 时 `cwd: 项目根`（包根）。
- 保留 2.3 硬指标（真实 kill + resume + persistent session 历史续跑）。

### 验收（Feature 1）
- `forge case create` + `forge case run` 跑通 Fake Pi 歌词全链路，拿到 `success:true` + `final_artifact` + `gate.status:pass` 的 JSON。
- CLI 切 copywriting 模板跑通。
- **真实 Pi CLI 全链路硬指标**：`forge case run --mode real` 跑通歌词全链路 -> approved + gate pass + JSON（凭证加载链路变了，必须重验，不得只验 Fake Pi）。
- `npm run dev` / web 页 / 现有 78 测试无回归；e2e 改造后仍 8/8、9/9。

---

## Feature 2 · Skill 注入

### 机制（Path A：Pi 原生 resourceLoader）
- 用 `DefaultResourceLoader({ additionalSkillPaths: [scenarioSkillsPath] })` 传给 `createAgentSession({ resourceLoader })`。Pi 做 progressive disclosure（描述进 Pi 内部 system prompt，模型按需 `read` 全文）。
- skill 文件放 `scenarios/<name>/skills/<skill-name>/SKILL.md`（frontmatter: name/description）。
- `AgentConfig.skills` 列 skill 名，用 `skillsOverride` 过滤到该 agent 声明的 skill 子集（每个 agent session 独立 resourceLoader）。

### read 工具 + 安全白名单（铁律 6）
- 启用 `createReadTool(cwd, { operations: { access: whitelistAccess } })` 作为 **customTool**（和 4+1 并列），保持 `noTools: 'builtin'`（禁所有内置，把 read 当 customTool 加回）。
- `whitelistAccess(absolutePath)`：`fs.realpathSync` 解析后 `path.relative` 检查结果在 `scenarios/<scenarioId>/skills/` 前缀内；越界（绝对路径/`../`/symlink 逃逸）抛错。只允许读 skills 目录。
- **"4+1 工具不变"作废** -> 变 **5+1**（+受限 read，仅可读 scenarios/<name>/skills/）。文档/交付标准口径更新。铁律 2 grep 不受影响（read 是 Pi 内置不在 tools.ts）。

### read customTool 的 SDK 不确定性（探针 + fallback）
- dev agent 先写 5-10 行 SDK 探针脚本（零 token，像 real-pi-probe.ts）验证 `noTools:'builtin' + customTools:[createReadTool(...), ...4plus1]` 能否共存、customTools 数组是否接受 createReadTool。探针纳入 check。
- Fallback 1：去掉 noTools，用 `tools` allowlist 启用 read + 验证 customTools（4+1）仍生效。
- **Fallback 2：若两条都不通，dev agent 上报（不自动切 Path B）**——Path A 是用户明确选的，切 Path B 要用户同意。
- 探针只验"配置不报错 + customTools 接受 createReadTool"，**不验模型实际调 read**。模型调 read 的行为验证在真实 Pi 全链路。

### PiPort 接口扩展
- `createSession(agentKey, policy, scopeKey?, options?: { scenarioId?, scenarioSkillsPath?, agentSkills? })`
- `resumeSession(sessionRef, options?: { scenarioId?, scenarioSkillsPath?, agentSkills? })` - **persistent skill 崩溃恢复时重建 resourceLoader**（2.3 交叉点：persistent+skill 的 case 崩溃恢复后 skill 仍在）。现在 resumeSession 只用 SessionManager.open 恢复对话，不重建 resourceLoader，要补。
- `registerContextResolver?(fn: () => Record<string,string>): void` - FakePi 实现（存 fn，executeTurn 内部调 fn 替换占位符），RealPi 不实现。CaseRunner 在 createSession 后调 `pi.registerContextResolver?.(closure)` 注册一次（闭包捕获 repo）。
- `alignTurnCounter?(scenarioId: string, sequence: number): void` - FakePi 实现（搬现有 setTurnCounter），RealPi 不实现。CaseRunner 用 `pi.alignTurnCounter?.(...)` 可选链调。
- `getSkills?(sessionRef): Skill[]` - **测试钩子，放 PiPort（optional）**，FakePi 返回空、RealPi 返回该 session 的 loader.getSkills().skills。SessionState 加 `resourceLoader` 字段存引用。避免测试 `instanceof RealPiAdapter` 破铁律 5。

### 数据流（runTurnLoop 两个 session 分支都要传 options）
- cold_per_version 关闭旧 session + `createSession` 新建：按 currentAgentKey 查 `agentConfig.skills` 传 options。
- persistent 复用 + `resumeSession`：同样按 currentAgentKey 查 skills 传 options。现在 main.ts L424 `resumeSession(ref)` 不传 options，必须改。
- `closeSession` 也要清理 SessionState.resourceLoader 引用。

### 验收（Feature 2，真实 Pi only）
- 验收样例：songwriting/generator 加 skill `rhyme`（押韵技巧）。建 `scenarios/songwriting/skills/rhyme/SKILL.md`（frontmatter name/description + 押韵指导），generator 的 `AgentConfig.skills: [rhyme]`。
- (1) `pi.getSkills(sessionRef)` 含 rhyme skill（发现验证，端到端验 RealPiAdapter 实际装配了 loader）。
- (2) read 工具单测：能读 `scenarios/<name>/skills/rhyme/SKILL.md`（skill 可访问）。
- (3) read 安全单测：`deepseek_config.txt` / `.env*` / `data/*.db` / 源码 / `../` / 绝对路径 / symlink 经 read 不可读（access 拒绝）。
- **"agent 行为受影响"不作硬验收**（progressive disclosure 不稳定，模型可能只看描述不 read 全文）。
- **注：context_snapshot 不显示 skill 是 Path A 的固有后果**（Pi 注入内部 prompt，不进 Forge 的 rendered_context）。若以后想 context_snapshot 可验得切 Path B（本轮不切）。
- FakePi 不实现 skill 注入（Feature 2 验收只验真实 Pi）。

---

## Feature 3 · UI 操作系统

### 读侧
保留现有回放页（泳道/箭头/diff/issue/门禁/敏感诊断折叠），直连 SQLite 读（现有 lib/db.ts，保留 @forge-ai/adapters 依赖）。

### 写侧（detached spawn CLI）
- Next.js API route（新增 `apps/web/app/api/`）spawn `forge case run <id> --wait`：`spawn('forge', [...], { detached:true, stdio:['ignore','pipe','ignore'], cwd:项目根 }).unref()`。**stdio `['ignore','pipe','ignore']`**（stdin ignore、stdout pipe 读第 1 行、stderr ignore 因 forge 自管文件日志；stderr 若 pipe 不读会缓冲满阻塞）。
- 读 stdout 第 1 行：`{"case_id":"..."}` -> `res.json({case_id})` 返回前端；`{"error":"...","blocking_case_id":"..."}` -> 返回错误。**不 pipe 到文件**（forge 自写 `data/case-<caseId>.log`）。
- 前端轮询 `forge case status <id>`。
- 单 case 拒绝时 forge exit 非 0 + stdout error JSON，API route 读到后返回前端提示"case X 在跑"。

### waiting_human 恢复（C2，本轮做）
- UI 填答案 -> 调 `forge case resume <id> --answer '<text>'`（detached spawn 同上）。
- CaseRunner.resumeCaseWithHumanInput：transitionCase(waiting_human->running) + 找调用 request_human_input 的 agent（从最后 Turn 的 tool_actions）+ 取其 question 参数 + 渲染答案 user message（"用户对你提出的问题'{question}'的回答：\n{answer}"）+ runTurnLoop 跑到终态。
- domain 验证 waiting_human->running 合法（case-state.test 补测；waiting_recovery->running 已合法）。

### 验收（Feature 3）
- 用 `next build && next start`（稳定，无热重载杀子进程）跑验收。next dev 仅 dev 用，文档注明 caveat（热重载可能杀 detached 子进程，被杀的 case 留 running，可用 `forge case run <id>` 或 `stop <id>` 处理）。
- UI 选模板、填 input_fields、跑 case、看结果。
- waiting_human 的 case 在 UI 提交答案后能恢复并跑到终态。

---

## 横切约束

- **六条铁律全遵守**。核心提取保留行为（路由原样搬迁）；铁律 1 路由清理推迟。
- **共享 CaseRunner**，CLI/worker 进程内复用，web spawn CLI + 直连 SQLite 读。
- **turn-executor 守卫**：executeTurn 入口、**事务外**（beginTransaction 之前）查 case status，若终态（stopped/failed/approved）直接抛错，不 beginTransaction、不 insertTurn（无 failed Turn 残留）。runTurnLoop 循环入口的终态检查（原 main.ts L368）原样搬。接受 executeTurn 中途 case 被 stop 时当前 Turn 跑完（最多多跑一个 Turn）。
- **scenario.ts 改 typebox**：`Type.Object` 定义 schema，TS 类型用 `Static<typeof ScenarioSchema>` 派生（single source of truth，类型形状不变，import 不破）。新增 `validateScenario(config)` 运行时 parse。
- **凭证**：CLI 自动加载 `.env`（相对包根）；`--mode real` 缺 `DEEPSEEK_API_KEY` = fail loud 退出。
- 每功能可测；CLI 命令 JSON 输出可断言。
- 不破坏 MVP 已验证能力（Fake+Real Pi 全链路、崩溃恢复、门禁、配置驱动、输入配置驱动）。
- 每处改动按 CLAUDE.md 工作流自动 commit + push。

## 不在本轮
- 质量反馈闭环（evaluator/指标/自判）。
- 多 case 并发/队列、成本追踪、auth/多租户。
- Pi 内置工具 bash/edit/write/search（只开受限 read）。
- 铁律 1 路由逻辑配置化清理。
- `--no-wait` 模式。
- 待办 3（连续异常 Turn 停汇报）。

---

## 实现提醒（非 blocker，dev agent 容易漏，逐条对照）

1. **API route spawn stdio**：`['ignore','pipe','ignore']`。stdin ignore、stdout pipe 读第 1 行、stderr ignore（forge 自管文件日志）。若误用 stderr:'pipe' 但不读，pipe 缓冲满阻塞子进程。直接跑 forge 时 stderr 默认到终端。
2. **case 创建前日志**：`forge case run <id>` 续跑时 case_id 是命令行参数，启动即建 `case-<id>.log`；`forge case create+run` 或 `npm run dev` 新建时 case_id 创建后才知道，创建前日志写 stderr，创建后切文件 logger。
3. **read 探针验证范围**：探针零 token 只验"createAgentSession 配置不报错 + customTools 数组接受 createReadTool"，**不验模型实际调 read**。模型调 read 的行为验证在真实 Pi 全链路，且"agent 行为受影响"已不作硬验收。探针通过 ≠ Feature 2 真实跑通，但探针失败 = 阻塞要上报。
4. **runTurnLoop 两个 session 分支都传 options**：cold_per_version 关闭旧 session + `createSession` 新建（main.ts L388-394）和 persistent 复用 + `resumeSession`（L414-427）两个分支都要按 currentAgentKey 查 agentConfig.skills 传 options。`closeSession` 也要清理 SessionState.resourceLoader 引用。
5. **getSkills 测试钩子放 PiPort（optional）**，不放在 RealPiAdapter 特有——避免测试 `instanceof RealPiAdapter` 破铁律 5。FakePi 返回空数组。
6. **错误场景 stdout 协议**：runCase 中途 fatal error 时也要 `fs.writeSync(1, errorJson + '\n')` 输出末行 error JSON + exit 非 0，让 API route 能读到错误响应。不能只 `console.error` 到 stderr（API route stderr ignore 会丢）。
