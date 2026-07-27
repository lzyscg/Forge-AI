# Forge AI Round 2 交付标准

> 本文件是 Round 2 的**终点线**。开发 agent 完成开发计划全部阶段后，必须逐项对照本标准自查，确认所有条款满足，才能声明 Round 2 完成。
>
> **核心原则：任何一项标为"硬指标"的条款没有通过，整个 Round 2 都不算完成。** 与 MVP 的 `交付标准.md` 同构。

---

## 如何使用本文件

1. 开发 agent 逐项执行下面的验收条款。
2. 每执行完一项，在该项末尾标注：
   - `PASS`（通过，附证据：命令输出 / 文件路径 / DB dump）
   - `FAIL`（未通过，附阻塞原因）
   - `N/A`（明确不在 Round 2 范围）
3. 全部条款为 `PASS` 或 `N/A` 后，把整份填好的文件连同证据一起提交给用户。
4. **不得写"基本完成""大体满足""测试覆盖率较高"--每项只有"满足/不满足"两种状态。**

---

## 第一章：Feature 1 · CLI 操作系统（全为硬指标）

### 验收 1.1：forge CLI 可执行

**通过标准**
- [ ] `package.json` 有 `bin` 入口指向 `apps/cli/bin.js`（JS shim，`#!/usr/bin/env node`，非 tsx shebang）。
- [ ] `npx forge --help` 在 Windows 上能正常输出命令列表（bin shim 用 tsx programmatic API 跑 TS，不依赖 shebang）。
- [ ] 路径解析基于包根（`import.meta.url`），在任意 cwd 跑 `npx forge template list` 都能列出 `scenarios/` 下的模板。

**验证方式**
```bash
npx forge --help
cd /tmp && npx forge template list   # 任意 cwd 都能跑
```

**失败情形**
- bin 用 tsx shebang（Windows 不认）
- 路径解析用 process.cwd()，非项目根跑 forge 找不到 scenarios

---

### 验收 1.2：CLI 跑通 Fake Pi 全链路（硬指标）

**通过标准**
- [ ] `forge case create --template songwriting --input '<json>'` 返回 `{case_id}` JSON。
- [ ] `forge case run <id> --wait` 跑通 Fake Pi 歌词全链路，末行输出结果 JSON 含 `success:true` + `final_artifact`（type/version/status/content）+ `gate.status:"pass"`。
- [ ] Case 最终 `approved`，门禁 5 项全 pass。

**验证方式**
```bash
npx forge case create --template songwriting --input "$(cat scenarios/songwriting/input.example.json)" --db ./data/r2-song.db
npx forge case run <id> --wait --db ./data/r2-song.db
# 末行 JSON 解析：success=true, gate.status=pass
```

**失败情形**
- 末行不是合法 JSON / 缺 success / 缺 final_artifact / gate 未 pass
- Case 没 approved

---

### 验收 1.3：CLI 切 copywriting 模板跑通

**通过标准**
- [ ] `forge case run` 用 `--template copywriting`（或 create 时指定）跑通，产物类型是 copy（不是 lyrics），agent 是 writer/qc。

**验证方式**
```bash
npx forge case create --template copywriting --input "$(cat scenarios/copywriting/input.example.json)" --db ./data/r2-copy.db
npx forge case run <id> --wait --db ./data/r2-copy.db
```

**失败情形**
- copywriting 跑不通 / 产物类型仍是 lyrics / agent 不对

---

### 验收 1.4：真实 Pi CLI 全链路（最高风险硬指标）

**通过标准**
- [ ] `forge case run <id> --wait --mode real`（配 DEEPSEEK_API_KEY）跑通真实 DeepSeek 歌词全链路。
- [ ] Case 最终 `approved`（系统门禁自然通过，不是手动标）。
- [ ] 末行结果 JSON 含真实模型触发的工具调用、产物 v2 delivered、门禁 pass。
- [ ] 保留 SQLite DB + `data/case-<id>.log` 作为证据。

**验证方式**
```bash
DEEPSEEK_API_KEY=sk-xxxx npx forge case create --template songwriting --input '...' --db ./data/r2-real.db --mode real
DEEPSEEK_API_KEY=sk-xxxx npx forge case run <id> --wait --mode real --db ./data/r2-real.db
```

**失败情形**
- 没有真实 Pi 运行证据（只用 Fake Pi 顶替 = 第五章声明失败）
- Case 没到 approved / 缺门禁记录
- CLI 凭证加载链路坏（.env 没加载 / 缺 KEY 没报错）

---

### 验收 1.5：stdout 双阶段协议（硬指标）

**通过标准**
- [ ] `forge case run` stdout 第 1 行是 `{"case_id":"..."}`（case 创建后立即 flush，用 `fs.writeSync(1, ...)` 同步写）。
- [ ] stdout 末行是完整结果 JSON。
- [ ] stdout 中间无任何杂质（所有进度走 stderr + 文件 logger）。
- [ ] 单 case 拒绝时 stdout 第 1 行是 `{"error":"...","blocking_case_id":"..."}` + exit 非 0。
- [ ] runCase 中途 fatal 也 `fs.writeSync(1, errorJson)` 末行 + exit 非 0（不只 console.error）。

**验证方式**
```bash
npx forge case run <id> --wait --db ... 2>/dev/null | head -1   # 第1行 case_id JSON
npx forge case run <id> --wait --db ... 2>/dev/null | tail -1   # 末行结果 JSON
```

**失败情形**
- 第 1 行不是 case_id JSON（块缓冲没 flush）
- stdout 中间混进进度日志（[Turn X] 等）
- fatal 只走 stderr（API route stderr ignore 会丢）

---

### 验收 1.6：命令面齐全 + 行为正确

**通过标准**
- [ ] `forge template list / show / validate` 均可用；`validate` 用 typebox runtime schema 校验。
- [ ] `forge case status <id>` 返回完整 JSON（turns/issues/gate/diff/final_artifact）。
- [ ] `forge case list` 列出所有 case + 状态。
- [ ] `forge artifact get <id> [--version N]` / `forge diff <id>` / `forge gate <id>` 均可用。
- [ ] `forge case run <id>` 对终态 case 幂等返回当前 JSON（不报错）。
- [ ] `forge case run <id>` 对 waiting_human case 返回 JSON + `action_required:"use 'forge case resume <id> --answer'"`，exit 0。
- [ ] `forge case stop <id>` 标非 running 的 linger case 为 stopped；对 running case 拒绝。
- [ ] `forge case resume <id> --answer '<text>'` 注入答案恢复 waiting_human case 并跑到终态。
- [ ] 单 case 强制：有 running case 时 `case run`/`resume` 拒绝并提示。
- [ ] 默认 JSON 输出，`--human` flag 给人看。

**验证方式**
```bash
npx forge case status <id> --db ...
npx forge case list --db ...
npx forge case run <终态id> --db ...      # 幂等
npx forge case stop <linger_id> --db ...
npx forge case resume <wh_id> --answer '...' --db ...
```

**失败情形**
- 任一命令缺失或返回非 JSON
- 终态 case run 报错 / waiting_human run 不返回 hint
- stop 对 running case 不拒绝 / resume 不跑到终态

---

### 验收 1.7：CaseRunner 抽取 + 不破坏现有能力（硬指标）

**通过标准**
- [ ] `packages/application/src/case-runner.ts` 存在，含 `createCase` / `runCase` / `runTurnLoop`(私有) / `resumeCaseWithHumanInput`。
- [ ] `apps/worker/src/main.ts` 降为薄封装（调 CaseRunner），`npm run dev` 行为不变（不带 case_id 时用 FORGE_INPUT/input.example.json 建新 case + 跑）。
- [ ] 路由决策（publish 后自动找 reviewer / eval-fail 构造返修消息 / scope_violation 续修 / 门禁未过回 start_agent）**原样搬迁不改语义**。
- [ ] `npm run dev` Fake Pi 全链路仍跑通（含崩溃恢复续跑：alignTurnCounter 正确对齐）。
- [ ] 现有 78 个测试无回归（`npm test`）。

**验证方式**
```bash
npm run dev   # Fake Pi songwriting 仍 7 Turn approved
npm test      # 78 passed
```

**失败情形**
- main.ts 没降薄封装 / CaseRunner 没抽出来
- 路由逻辑被悄悄改（diff 行为变化）
- Fake Pi 崩溃恢复续跑错位（alignTurnCounter 没对齐）
- 78 测试有回归

---

### 验收 1.8：e2e 改 CLI + 2.3 硬指标保留

**通过标准**
- [ ] `scripts/crash-recovery-e2e.cjs` 改用 CLI（spawn `forge case run --wait` + 轮询 `forge case status` JSON + `taskkill /F`），8 项全 YES。
- [ ] `scripts/crash-recovery-realpi-e2e.cjs` 同上，9 项全 YES（真实 kill + persistent session `.jsonl` 跨进程历史续跑 + 最终 approved）。
- [ ] e2e 不解析 worker stdout，用 status JSON 判 kill 时机。

**验证方式**
```bash
node scripts/crash-recovery-e2e.cjs           # 8/8 YES
DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs   # 9/9 YES
```

**失败情形**
- e2e 仍解析 stdout / 改后不是 8/8、9/9
- 真实 kill -9 用 MAX_TURNS 干净退出冒充（第五章声明失败）
- persistent session 历史续跑断（.jsonl 没增长）

---

## 第二章：Feature 2 · Skill 注入（全为硬指标）

### 验收 2.1：SDK 探针通过

**通过标准**
- [ ] `scripts/skill-probe.ts` 存在，零 token，验证 `noTools:'builtin' + customTools:[createReadTool(...), ...4plus1]` 能共存、customTools 数组接受 createReadTool。
- [ ] 探针通过（纳入 `npm run check`）。若不通，已尝试 Fallback 1（tools allowlist）；两条都不通则已上报用户（**不自动切 Path B**）。

**验证方式**
```bash
npx tsx scripts/skill-probe.ts
```

**失败情形**
- 探针不存在 / 不通且没上报用户 / 擅自切 Path B

---

### 验收 2.2：PiPort 扩展 + 三端装配

**通过标准**
- [ ] `PiPort` 加 `createSession(agentKey, policy, scopeKey?, options?: {scenarioId?, scenarioSkillsPath?, agentSkills?})` + `resumeSession` 同 options + `getSkills?(sessionRef): Skill[]` + `registerContextResolver?` + `alignTurnCounter?`。
- [ ] FakePiAdapter 实现 `registerContextResolver`/`alignTurnCounter`（搬现有逻辑）+ createSession/resumeSession 接受新 options（用 scenarioId 查脚本，忽略 skills）+ getSkills 返回空。
- [ ] RealPiAdapter 实现 skill 注入：`DefaultResourceLoader({additionalSkillPaths})` 传 createAgentSession + skillsOverride 过滤 + resumeSession 重建 resourceLoader（persistent 崩溃恢复 skill 仍在）+ SessionState 加 resourceLoader 字段 + getSkills 返回 loader.getSkills().skills。
- [ ] runTurnLoop 两个 session 分支（cold createSession / persistent resumeSession）都按 currentAgentKey 查 agentConfig.skills 传 options；closeSession 清理 resourceLoader。
- [ ] CaseRunner 用 `pi.alignTurnCounter?.()` / `pi.registerContextResolver?.()` 可选链，**不走 `instanceof FakePiAdapter`**（铁律 5）。

**验证方式**
- 代码审查 + 单测覆盖 PiPort 扩展方法
- `npm run check` 0 错误

**失败情形**
- CaseRunner 仍 instanceof FakePiAdapter（铁律 5 破）
- resumeSession 没重建 resourceLoader（persistent+skill 崩溃恢复 skill 丢，违反 2.3）
- 两个 session 分支漏传 options

---

### 验收 2.3：read 工具安全白名单（铁律 6 硬指标）

**通过标准**
- [ ] `createReadTool(cwd, {operations:{access: whitelistAccess}})` 作为 customTool（和 4+1 并列），保持 `noTools:'builtin'`。
- [ ] `whitelistAccess` 用 `fs.realpathSync` + `path.relative` 检查路径在 `scenarios/<scenarioId>/skills/` 前缀内。
- [ ] 工具单测：能读 `scenarios/songwriting/skills/rhyme/SKILL.md`（skill 可访问）。
- [ ] 安全单测：`deepseek_config.txt` / `.env*` / `data/*.db` / 源码 / `../` / 绝对路径 / symlink 经 read **不可读**（access 抛错）。
- [ ] 真实 Pi 跑一轮后，`context_snapshots` / `tool_actions` 扫描不含 `sk-`（铁律 6）。
- [ ] 工具口径文档更新为 5+1（含受限 read）。

**验证方式**
```bash
npm test -- <read-security-test>   # 越界路径全抛错
sqlite3 <r2-real.db> ".dump" | grep -i "sk-"   # 期望空
```

**失败情形**
- read 能读到凭证文件 / .env / data/*.db（铁律 6 破 = 第五章声明失败）
- 没处理 symlink 逃逸
- DB 里出现 `sk-`

---

### 验收 2.4：Skill 验收样例（真实 Pi only）

**通过标准**
- [ ] `scenarios/songwriting/skills/rhyme/SKILL.md` 存在（frontmatter name/description + 押韵指导）。
- [ ] songwriting `scenario.yaml` 中 generator 的 `AgentConfig.skills: [rhyme]`。
- [ ] 真实 Pi 跑一轮 generator，`pi.getSkills(sessionRef)` 含 rhyme skill（发现验证）。
- [ ] **Feature 2 验收只验真实 Pi**（FakePi 不实现 skill 注入）。

**验证方式**
```bash
DEEPSEEK_API_KEY=sk-xxxx npx forge case run <id> --wait --mode real --db ./data/r2-skill.db
# 断言 pi.getSkills(sessionRef) 含 rhyme
```

**失败情形**
- 用 Fake Pi 顶替 Feature 2 验收（第五章声明失败）
- getSkills 不含 rhyme / skill 文件不存在

**注意**：Path A 下 `context_snapshot.rendered_context` **不显示** skill（Pi 注入内部 prompt）--这是固有后果，不作为失败。"agent 行为受影响"也不作硬验收（progressive disclosure 不稳定）。

---

## 第三章：Feature 3 · UI 操作系统（全为硬指标）

### 验收 3.1：API routes + detached spawn

**通过标准**
- [ ] `apps/web/app/api/case/run/route.ts` 存在，spawn `forge case run <id> --wait`（`{detached:true, stdio:['ignore','pipe','ignore'], cwd:项目根}`），读 stdout 第 1 行返回前端，不 pipe 到文件。
- [ ] `apps/web/app/api/case/resume/route.ts` 存在，spawn `forge case resume <id> --answer`。
- [ ] 单 case 拒绝时 API route 返回 `{"error":"...","blocking_case_id":"..."}` 给前端。

**验证方式**
- 代码审查 + `curl` 调 API route 验证返回 case_id

**失败情形**
- stdio 误用 `stderr:'pipe'` 不读（缓冲满阻塞）/ pipe 到文件（和 forge 自写日志重复）
- 拿不到 case_id / 拒绝时前端无提示

---

### 验收 3.2：前端写操作 + waiting_human 恢复

**通过标准**
- [ ] UI 能选模板、填 input_fields、跑 case、轮询 status 展示进度、看结果。
- [ ] waiting_human 的 case 在 UI 提交答案后恢复并跑到终态。
- [ ] `waiting_human -> running` domain 转换合法 + `case-state.test` 补测。

**验证方式**
```bash
cd apps/web && npm run build && npm run start   # 用 next start 跑验收（稳定）
# 浏览器：选模板 -> 填输入 -> 跑 -> 看结果
# waiting_human case -> 填答案 -> 恢复 -> 终态
```

**失败情形**
- UI 不能一键跑 case / waiting_human 不能恢复
- 用 next dev 跑验收（热重载杀 detached 子进程，验收无效）

**注意**：next dev 仅 dev 用，文档注明 caveat（热重载可能杀 detached 子进程，被杀的 case 留 running 可用 CLI 续跑）。

---

## 第四章：横切与工程约束（全为硬指标）

### 验收 4.1：六铁律遵守

**通过标准**
- [ ] **铁律 1**：平台代码零业务分支；路由逻辑原样搬迁（不挪进配置，但也不硬编码新分支）；新增 skill 走配置（AgentConfig.skills）。
- [ ] **铁律 2**：4+1 工具参数不含 ID 字段（read 是 Pi 内置不在 tools.ts，不影响 grep）。
- [ ] **铁律 5**：CaseRunner 不 import FakePiAdapter（走 PiPort 可选链）；paths.ts 放 adapters 不放 application。
- [ ] **铁律 6**：API Key 只走 env；read 白名单挡凭证；DB/日志不含 `sk-`。
- [ ] **铁律 4**：崩溃恢复不覆盖已持久化结果（e2e 9/9 验证）。

**验证方式**
```bash
grep -r "instanceof FakePiAdapter" packages/application/   # 期望空
grep -r -i "sk-653f14ac\|sk-[a-f0-9]\{20,\}" packages/ apps/ scripts/   # 期望空（除 .env.example 占位）
```

**失败情形**
- CaseRunner instanceof FakePiAdapter / 路由逻辑被改 / read 能读凭证 / DB 含密钥

---

### 验收 4.2：工程细节

**通过标准**
- [ ] `scenario.ts` 改 typebox `Type.Object` + `Static` 派生，类型形状不变（现有 import 不破），新增 `validateScenario` 运行时 parse。
- [ ] `turn-executor.executeTurn` 入口事务外（beginTransaction 前）查 case status，终态抛错不 insertTurn。
- [ ] `ResultJson` 类型定义在 `packages/contracts/src/result.ts`。
- [ ] `resolveInputPayload` 在 CLI 层（不进 CaseRunner/application），CLI 解析出 payload 传 createCase。
- [ ] CaseRunner/turn-executor/recovery 的 console.log 改为注入 logger（application 层不直接 console.log）。
- [ ] forge 自写 `data/case-<caseId>.log`；case 创建前日志写 stderr。
- [ ] 每处改动按 CLAUDE.md 工作流自动 commit + push。

**验证方式**
- 代码审查 + `npm run check` 0 错误

**失败情形**
- scenario.ts typebox 改动破坏现有 import / turn-executor 守卫在事务内残留 failed Turn / resolveInputPayload 进了 application 层

---

## 第五章：交付物完整性

### 验收 5.1：代码与测试

**通过标准**
- [ ] `npm run check` 0 错误。
- [ ] `npm run test` 全绿（78 + 新增的 read 安全单测、PiPort 扩展单测、case-state waiting_human->running 测试等，无 skipped/todo 无说明）。
- [ ] e2e：`node scripts/crash-recovery-e2e.cjs` 8/8 + `node scripts/crash-recovery-realpi-e2e.cjs` 9/9。
- [ ] 真实 Pi CLI 全链路（验收 1.4）通过。
- [ ] `npm run dev` Fake Pi 全链路无回归。
- [ ] web 回放页正常（`next build && next start`，HTTP 200，显示 Case/版本diff/Issue/门禁）。

**验证方式**
```bash
npm run check && npm run test
node scripts/crash-recovery-e2e.cjs
DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs
```

**失败情形**
- 任一命令非零退出 / 测试有 skipped 没说明 / web 页打不开

---

### 验收 5.2：文档

**通过标准**
- [ ] `使用说明.md` 更新（CLI 命令、UI 操作、next dev caveat）。
- [ ] `交付标准.md`（MVP 的）口径更新为 5+1 工具（含受限 read）。
- [ ] `README.md` 更新（forge CLI 用法、环境变量）。
- [ ] `CLAUDE.md` 更新 Round 2 完成状态 + 新增坑（如有）。

**失败情形**
- 文档没更新 / 口径仍是"4+1 工具不变"

---

## 第六章：不可接受的"完成"声明

以下情况出现时，即使其他条款全过，也**不得声明 Round 2 完成**：

1. **没有 CLI 真实运行证据**（Fake Pi 歌词 + 真实 Pi 全链路 + e2e 8/8+9/9，至少有 DB/log/输出截图）。
2. **Feature 2 用 Fake Pi 顶替**（skill 注入必须真实 Pi 验证，FakePi 不实现 skill）。
3. **e2e 用 MAX_TURNS 干净退出冒充 kill -9**（必须是真实 `taskkill /F` + 重启续跑）。
4. **read 白名单没测越界**（铁律 6：必须证明 deepseek_config.txt/.env/data 不可读）。
5. **CaseRunner 用 `instanceof FakePiAdapter`**（铁律 5：必须走 PiPort 可选链）。
6. **路由逻辑被悄悄改**（必须原样搬迁，行为 diff 为零；多产物场景的路由局限不暴露也不动）。
7. **测试有大量 skipped/todo 没说明原因**。
8. **交付报告中存在"后续优化""待完善""基本完成"等模糊措辞**。

---

## 签字栏（开发 agent 填写）

> 我确认已逐项执行上述交付标准，所有条款均为 PASS 或明确标注 N/A，并附带了对应的可运行证据。

- 开发 Agent ID：____________
- 完成日期：____________
- CLI 真实运行证据位置（Fake Pi DB + 真实 Pi DB/log）：____________
- e2e 证据位置（8/8 + 9/9 输出）：____________
- read 安全单测证据位置：____________
- 全部测试通过截图/日志位置：____________

---

> **最终用户确认**：收到交付标准签字栏和全部证据后，用户会独立运行 `npm run check` / `npm run test` / `npx forge case run --mode real` / e2e 脚本进行复核，确认无误后 Round 2 才算最终完成。
