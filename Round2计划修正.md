# Round 2 开发计划修正

> 这是给开发 agent 的计划修正，基于对《Forge AI Round 2 开发计划》的评审。需求规格见 [Round2需求.md](Round2需求.md)（5 轮对抗审查定稿，含 6 个实现提醒）。**先按本文件改计划，再开工。**

## 修正 1 · ordering blocker：PiPort 的 FakeFi 扩展挪到阶段 1

开发计划把 PiPort 接口扩展全放在**阶段 4.2**（Skill），但其中 `registerContextResolver` 和 `alignTurnCounter` 是 FakeFi 用的，**阶段 1 CaseRunner 提取时就需要**。

### 问题
现在 `apps/worker/src/main.ts` 用 `if (fakePi instanceof FakePiAdapter)` 调 `setTurnCounter` / `setContextResolver` 对齐 Fake Pi 脚本计数器 + 解析 `PLACEHOLDER_ISSUE_ID`（崩溃恢复续跑必须）。CaseRunner 搬进 `packages/application` 后**不能 import FakePiAdapter**（铁律 5：application -> adapters 单向）。不先扩 PiPort，要么破铁律 5、要么 Fake Pi e2e 续跑错位--**阶段 1.6 验收"78 测试无回归 + npm run dev Fake Pi 全链路"必挂**（Fake Pi e2e 的"从 Turn N+1 续跑"断言全挂）。

> 这是子 agent 第 2 轮审查挖出的坑（Round2需求.md 决策汇总已记录：PiPort 扩 `registerContextResolver` + `alignTurnCounter`）。

### 要做的
- **阶段 1.1 CaseRunner 提取之前**，先在 `PiPort`（`packages/contracts/src/ports.ts`）加两个 optional 方法：
  ```ts
  registerContextResolver?(fn: () => Record<string, string>): void;
  alignTurnCounter?(scenarioId: string, sequence: number): void;
  ```
- `FakePiAdapter` 实现两者（搬现有 `setTurnCounter` / `setContextResolver` 逻辑），`RealPiAdapter` 不实现（undefined）。
- `CaseRunner` 用 `pi.alignTurnCounter?.(...)` / `pi.registerContextResolver?.(closure)` 可选链调，RealPi 自动跳过。
- 阶段 1.1 搬迁清单**补上** `setTurnCounter` / `setContextResolver` 的搬迁（经 PiPort 接口，不走 `instanceof`）。
- `createSession` / `resumeSession` 的 options 和 `getSkills` **留在阶段 4**（Skill 专用），不挪。

## 修正 2 · 小 nit（落地时注意，非 blocker）

1. **`resolveInputPayload` 留 CLI 层**：它读 `FORGE_INPUT` / `FORGE_INPUT_FILE` 环境变量，是 CLI 关注点，不该进 CaseRunner（application 层不该依赖 CLI env 解析）。CLI 解析出 payload 再传 `CaseRunner.createCase`。`renderInputMessage` 可留 CaseRunner（按 config 渲染）。
2. **`paths.ts` 别放 `packages/application`**：`import.meta.url` 定位包根是运行时/基础设施关注点，放 application 层破铁律 5 边界。放 `adapters` 或独立 util。
3. **阶段 2.3 stdout 协议补 fatal 场景**：runCase 中途 fatal 也要 `fs.writeSync(1, errorJson + '\n')` 末行 + exit 非 0，不能只 `console.error`（API route stderr ignore 会丢）。见 Round2需求.md 实现提醒 #6。
4. **阶段 2.2 命令清单补 `--human` flag**：默认 JSON，`--human` 给人看。
5. **阶段 4.2 扩 `createSession` 签名后，`FakePi.createSession` 也要接受新 options**（用 `scenarioId` 查脚本，忽略 skills）。
6. **阶段 6.1 `npm run test:e2e` 项目没这条脚本**：项目 e2e 是 `node scripts/*.cjs` 直接跑。要么加 `test:e2e` 脚本，要么验收里写成直接 `node` 调用。

## 结论

修正 1 是 blocker（不改阶段 1 验收必挂），修正 2 是 nit。**先改计划再开工，别边改边写代码。** 改完计划后对照 Round2需求.md 的决策汇总 + 6 个实现提醒逐条确认。
