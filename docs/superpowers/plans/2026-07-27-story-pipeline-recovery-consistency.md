# Story Pipeline Recovery Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外接故事编排器能够安全对账 Forge Case、接纳已批准产物、关闭悬空 Attempt，并在模板身份变化或上游替换时保持幂等、可恢复、可追溯。

**Architecture:** Forge 继续负责 Case 内容生成、审核、返修和交付门禁；外接编排器只负责阶段身份、依赖、状态投影、文件证据、产物传递与失效传播。恢复前先从 Forge 的不可变 Case 身份获得事实快照，再按 Stage 分组仲裁候选，最后通过带 run 级 CAS 锁的 Manifest 事务提交。

**Tech Stack:** Node.js 20、TypeScript 5.5、Vitest 2、Forge CLI、SQLite、JSON Manifest、SHA-256。

## Global Constraints

- 不把人物逻辑、仿写程度、文风、对白授权、篇幅质量等内容判断迁入外接编排器；这些规则属于对应 Forge Case。
- 编排器只做接口门禁：Case 身份、gate 与 artifact version 绑定、artifact 类型/状态、Stage 输入/父版本身份、结构化文件和 SHA-256。
- Manifest 历史事件只追加，不删除、不改写；历史 invalidation 通过补偿或新版本恢复，禁止直接删除记录。
- 对账、接纳、Attempt 关闭、模板兼容声明和 replacement 提交必须幂等。
- 身份无法证明一致时 fail closed；多个同等候选时要求显式选择，禁止“取最新一个”。
- 现有 `schema_version: "2.0"` 运行目录必须可原地迁移；不得删除 Forge DB 或重新生成已经合格的故事内容。
- 所有 Manifest 写入必须持有 run 级写锁并执行 CAS；Stage 锁不能替代 Manifest 写锁。
- 单元测试不得调用真实模型；进程、CLI、SQLite 和 Windows 信号边界必须另有 FakePi 集成测试。

---

## 对抗审查结论

独立子 Agent 已对初稿和真实仓库做对抗审查。以下问题被确认为必须修正：

1. 当前 `forge case stop` 拒绝停止 `running` Case，且 `apps/cli/bin.js` 使用同步包装进程；仅修改外部编排器无法可靠收束 Windows 进程树。
2. 当前 `case status` 不返回 Case 输入哈希、不可变 scenario 身份、执行模板身份及 gate 对应的 artifact version，无法安全自动接纳。
3. 真实 Manifest 已把 `outline-v1`、`packet-b001-v1` 失效；不先恢复父血缘就无法接纳正文并进入 ledger。
4. `draft-b001-a4` 与 `draft-b001-a5` 都可能是 approved 候选，逐 Attempt 接纳会产生同一 Stage 多个有效版本。
5. Stage 锁只防重复执行，不能防两个进程覆盖同一个 Manifest。
6. 哈希算法迁移不能证明模板内容没变化；无法复算时只能记录显式兼容声明，不能伪装为密码学等价。

因此，本计划仍以修复外部编排器为主，但增加两个最小 Forge 协议前置任务：**不可变身份查询**和**带执行租约的 abort**。没有这两个接口，只能做人工恢复，不能宣称自动恢复安全可靠。

## 当前真实证据

运行目录：`data/story-runs/gaokao-zero-real-003`

| 对象 | Forge 事实 | Manifest 投影 |
|---|---|---|
| `case_ed9f0a14c4a74388` | approved，`chapter_draft v9` delivered，gate pass | `draft-b001-a5 = interrupted` |
| `case_4088d1ec10ed4dcf` | 也存在 approved/delivered 证据 | `draft-b001-a4 = running` |
| `case_a067d4b0c28f484f` | stopped | `draft-b001-a6 = running` |
| `case_140cf7e5f05343a2` | stopped | `outline-a2 = running` |
| `outline-v1` | 历史 delivered | 已被 `inv-1` 失效 |
| `packet-b001-v1` | 历史 delivered | 已被 `inv-2` 失效 |

正确恢复顺序必须是：

1. 关闭悬空 Attempt。
2. 验证并恢复 outline 血缘。
3. 验证并恢复 packet 血缘。
4. 对 a4/a5 做候选仲裁，显式接纳唯一正文。
5. 确认 `next_stage = ledger-b001`。

## 文件结构

### Forge 最小协议扩展

- Modify: `packages/contracts/src/result.ts`
- Modify: `packages/application/src/case-runner.ts`
- Modify: `apps/cli/src/commands/case.ts`
- Modify: `packages/domain/src/case-state.ts`
- Modify: `packages/adapters/src/sqlite-repository.ts`
- Test: `packages/application/src/case-identity.test.ts`
- Test: `apps/cli/src/case-abort.integration.test.ts`

### 外接编排器

- Create: `orchestrators/story-pipeline/src/manifest.ts`
- Create: `orchestrators/story-pipeline/src/forge-client.ts`
- Create: `orchestrators/story-pipeline/src/reconciliation.ts`
- Create: `orchestrators/story-pipeline/src/run-lock.ts`
- Modify: `orchestrators/story-pipeline/src/template-hash.ts`
- Modify: `orchestrators/story-pipeline/src/invalidation.ts`
- Modify: `orchestrators/story-pipeline/src/quality.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`
- Modify: `orchestrators/story-pipeline/README.md`
- Test: corresponding `*.test.ts` files under `orchestrators/story-pipeline/src/`

---

### Task 1: Manifest 2.1、模板身份模型和 run 级 CAS

**Files:**
- Create: `orchestrators/story-pipeline/src/manifest.ts`
- Create: `orchestrators/story-pipeline/src/manifest.test.ts`
- Modify: `orchestrators/story-pipeline/src/template-hash.ts`
- Modify: `orchestrators/story-pipeline/src/template-hash.test.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`

**Interfaces:**

```ts
export interface TemplateIdentity {
  algorithm: 'legacy-unversioned-v1' | 'source-tree-sha256-v2';
  content_sha256: string;
  equivalence: 'verified' | 'operator_attested' | 'unknown';
}

export interface StageAttemptV21 {
  attempt_id: string;
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  template: string;
  expected_artifact_type: string;
  input_sha256: string;
  parent_record_ids: string[];
  template_identity: TemplateIdentity;
  runner_token_sha256: string | null;
  runner_credential_path: string | null;
  outcome: AttemptOutcome;
  // 保留现有路径和时间字段
}

export interface PipelineManifestV21 {
  schema_version: '2.1';
  revision: number;
  previous_manifest_sha256: string | null;
  attempts: StageAttemptV21[];
  stages: StageRecordV21[];
  invalidations: InvalidationRecord[];
  reinstatements: ReinstatementRecord[];
  replacements: ReplacementRecord[];
  events: ManifestEventV21[];
}

export interface ManifestFsOps {
  rename(from: string, to: string): void;
  fsyncFile(path: string): void;
  remove(path: string): void;
}

export function loadManifest(path: string): PipelineManifestV21;
export function saveManifestCas(
  path: string,
  expectedRevision: number,
  mutate: (latest: PipelineManifestV21) => void,
  fsOps?: ManifestFsOps,
): PipelineManifestV21;
```

实现规则：

- 读取 2.0 时，把旧 `template_sha256` 标记为 `legacy-unversioned-v1 + unknown`，不能直接改写成新算法身份。
- `saveManifestCas` 必须获取 `<run-dir>/.locks/manifest.lock`，锁内重新读取最新 Manifest，核对 `revision` 和末尾 `event_sha256`，再追加事件、写临时文件、fsync、rename。
- rename 失败时保留正式文件并清理临时文件。
- 事件使用结构化字段，至少记录 `attempt_id`、before/after outcome、case/artifact/version identity 和 reason；文档称其为“带哈希事件日志”，不宣称完整 event sourcing。
- `identifyTemplateDirectory()` 继续忽略 `__pycache__`、`.pyc` 等运行文件。
- runner 明文 token 不得进入 Manifest；它写入 run 目录内权限受限的独立凭据文件，Manifest 只记录 token SHA-256 和相对凭据路径。Case 到达终态后删除凭据文件并清空路径。

- [ ] 写失败测试：2.0 迁移不丢事件；算法变化返回 `migration_required`；两个并发 revision 只有一个提交成功；rename 失败不破坏正式文件且清理临时文件。
- [ ] 运行：

```powershell
npx vitest run orchestrators/story-pipeline/src/manifest.test.ts orchestrators/story-pipeline/src/template-hash.test.ts
```

Expected: FAIL。

- [ ] 实现上述接口，并把 `index.ts` 中 Manifest 类型、事件、保存和链验证迁出。
- [ ] 运行同一测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add orchestrators/story-pipeline/src/manifest.ts orchestrators/story-pipeline/src/manifest.test.ts orchestrators/story-pipeline/src/template-hash.ts orchestrators/story-pipeline/src/template-hash.test.ts orchestrators/story-pipeline/src/index.ts
git commit -m "refactor(story-pipeline): add versioned manifest identity and CAS"
```

---

### Task 2: Forge 不可变 Case 身份协议

**Files:**
- Modify: `packages/contracts/src/case.ts`
- Modify: `packages/contracts/src/ports.ts`
- Modify: `packages/contracts/src/result.ts`
- Modify: `packages/application/src/case-service.ts`
- Modify: `packages/application/src/case-runner.ts`
- Modify: `packages/application/src/tool-executor.ts`
- Modify: `packages/application/src/turn-executor.ts`
- Modify: `packages/adapters/src/sqlite-repository.ts`
- Create: `packages/adapters/src/scenario-bundle-identity.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `apps/cli/src/commands/case.ts`
- Modify: `apps/cli/src/setup.ts`
- Create: `packages/application/src/case-identity.test.ts`
- Create: `packages/adapters/src/scenario-bundle-identity.test.ts`

**Interfaces:**

```ts
export interface ResultCaseIdentity {
  db_instance_id: string;
  scenario_id: string;
  scenario_snapshot_sha256: string;
  input_payload_sha256: string;
  run_binding: {
    run_id: string | null;
    story_id: string | null;
    stage_key: string | null;
    chapter_id: string | null;
  };
}

export interface ResultExecutionIdentity {
  template_bundle_sha256: string;
  artifact_version_id: string;
}

export interface ResultGate {
  status: 'pass' | 'fail';
  artifact_version_id: string;
  checks: ResultGateCheck[];
}
```

实现规则：

- Case 创建时由编排器把 `run_id/story_id/stage_key/chapter_id` 作为结构化 binding 写入 Case；不得只编码在 title。
- Case 创建时保存输入 payload SHA-256 和不可变 scenario snapshot SHA-256。
- 每次 run/resume 对实际使用的 scenario、prompt、skill、validator bundle 计算 `template_bundle_sha256`。
- artifact version 和 delivery gate 保存该 bundle 身份；status 返回最终 artifact version 对应的执行身份。
- `case status` 必须基于 Case 的不可变 snapshot 构造结果，不能优先用当前磁盘 scenario 解释历史 Case。
- SQLite 必须原地迁移旧数据库：为 Case、artifact version 和 gate 增加身份字段，并用单行 metadata 记录稳定、不可暴露路径的 `db_instance_id`；旧记录缺失身份时返回 `null/unknown`，不得伪造。
- bundle 身份由 Adapter 对 scenario 目录源文件计算，Application 只接收字符串身份，不反向依赖文件系统。

- [ ] 写失败测试：

```ts
it('returns immutable input and scenario identity after the template directory changes', () => {
  expect(status.case_identity.input_payload_sha256).toBe(createdInputHash);
  expect(status.case_identity.scenario_snapshot_sha256).toBe(createdSnapshotHash);
  expect(status.execution_identity.artifact_version_id).toBe(status.final_artifact?.version_id);
  expect(status.gate?.artifact_version_id).toBe(status.final_artifact?.version_id);
});
```

- [ ] 运行 `npx vitest run packages/application/src/case-identity.test.ts`，Expected: FAIL。
- [ ] 实现身份持久化和 status 输出。
- [ ] 运行测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add packages/contracts/src/result.ts packages/application/src/case-runner.ts apps/cli/src/commands/case.ts packages/application/src/case-identity.test.ts
git commit -m "feat(forge): expose immutable case and delivery identity"
```

---

### Task 3: Forge 执行租约与可授权 abort

**Files:**
- Modify: `packages/domain/src/case-state.ts`
- Modify: `packages/adapters/src/sqlite-repository.ts`
- Modify: `apps/cli/src/commands/case.ts`
- Create: `apps/cli/src/case-abort.integration.test.ts`

**Interfaces:**

```text
forge case run <id> --runner-token <uuid> ...
forge case abort <id> --runner-token <same-uuid> --db <path>
forge case transfer-lease <id> --old-runner-token <uuid> --new-runner-token <uuid> --db <path>
```

Case 运行记录：

```ts
interface ExecutionLease {
  runner_token_sha256: string;
  runner_pid: number;
  runner_started_at: string;
  heartbeat_at: string;
}
```

规则：

- `run` 原子获取执行租约；同一 Case 不能被两个 runner 获取。
- `abort` 只有 token 哈希匹配时才能把 `running/repairing/waiting_review/waiting_human` 原子转为 `stopped`。
- token 不匹配、Case 已 approved 或 failed 时拒绝。
- 只有 Case 到达 `approved/failed/stopped` 终态时才清理租约；`waiting_human/waiting_review/repairing` 返回时保留租约。
- resume 默认复用原租约；必须更换执行者时，通过显式 `case transfer-lease` 原子校验旧 token 后换发新 token，禁止静默覆盖。
- 外部编排器把明文 token 保存在 Task 1 定义的权限受限凭据文件；Manifest 和事件只保存 token 哈希及凭据相对路径。

- [ ] 写真实 CLI + FakePi 集成测试：错误 token 被拒绝；正确 token 能收束 running；approved 不能 abort；重复 abort 幂等返回 stopped；非终态保留租约；transfer-lease 必须验证旧 token。
- [ ] 运行：

```powershell
npx vitest run apps/cli/src/case-abort.integration.test.ts
```

Expected: FAIL。

- [ ] 实现租约和 abort。
- [ ] 运行测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add packages/domain/src/case-state.ts packages/adapters/src/sqlite-repository.ts apps/cli/src/commands/case.ts apps/cli/src/case-abort.integration.test.ts
git commit -m "feat(forge): add leased case abort"
```

---

### Task 4: 可取消的异步 Forge Client

**Files:**
- Create: `orchestrators/story-pipeline/src/forge-client.ts`
- Create: `orchestrators/story-pipeline/src/forge-client.test.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`

**Interfaces:**

```ts
export interface ForgeClient {
  createCase(request: CreateCaseRequest, signal?: AbortSignal): Promise<string>;
  runCase(caseId: string, request: RunCaseRequest, signal?: AbortSignal): Promise<ForgeCaseSnapshot>;
  getCaseStatus(caseId: string, dbPath: string): Promise<ForgeCaseSnapshot>;
  abortCase(caseId: string, dbPath: string, runnerToken: string): Promise<void>;
}
```

规则：

- 长 Case 不再通过同步包装器 `apps/cli/bin.js` 启动；直接 spawn：

```ts
spawn(process.execPath, [
  '--import',
  'tsx/esm',
  join(repoRoot, 'apps', 'cli', 'src', 'index.ts'),
  ...args,
], { shell: false, windowsHide: true });
```

- Windows 中断使用精确 PID 调用 `taskkill.exe /PID <pid> /T /F` 收束进程树；POSIX 使用独立进程组。
- 等子进程退出后，以同一 runner token 调用 `case abort`，随后查询 status。
- stdout JSON Lines 有界解析；stderr 有界缓存。

- [ ] 写 fake child 单测：JSON Lines、AbortSignal、token 传递、子进程退出后 abort。
- [ ] 写 Windows/FakePi 集成测试：确认包装层和孙进程均不存在、DB Case 为 stopped。
- [ ] 运行测试，Expected: FAIL。
- [ ] 实现异步 client 并把 `runPipeline/executeStage/main` 改为 async。
- [ ] 运行相关测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add orchestrators/story-pipeline/src/forge-client.ts orchestrators/story-pipeline/src/forge-client.test.ts orchestrators/story-pipeline/src/index.ts
git commit -m "refactor(story-pipeline): make Forge execution cancellable"
```

---

### Task 5: 按 Stage 对账、候选仲裁和幂等接纳

**Files:**
- Create: `orchestrators/story-pipeline/src/reconciliation.ts`
- Create: `orchestrators/story-pipeline/src/reconciliation.test.ts`
- Modify: `orchestrators/story-pipeline/src/quality.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`

**Interfaces:**

```ts
export interface StagePlan {
  run_id: string;
  story_id: string;
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  expected_artifact_type: string;
  input_sha256: string;
  parent_record_ids: string[];
  template_identity: TemplateIdentity;
}

export type ReconciliationAction =
  | { action: 'adopt'; stage_key: string; attempt_id: string; case_id: string }
  | { action: 'close'; attempt_id: string; outcome: AttemptOutcome; reason: string }
  | { action: 'resume'; attempt_id: string; case_id: string }
  | { action: 'ambiguous'; stage_key: string; candidates: string[] }
  | { action: 'reject'; attempt_id: string; reason: string };

export function reconcileStage(
  plan: StagePlan,
  attempts: StageAttemptV21[],
  snapshots: Map<string, ForgeCaseSnapshot>,
  explicitCaseId?: string,
): ReconciliationAction[];
```

接纳条件必须全部满足：

1. Forge `case_identity.run_binding` 与 StagePlan 完全一致。
2. Forge `input_payload_sha256 === StagePlan.input_sha256`。
3. scenario、执行 bundle、artifact type 与 StagePlan 兼容。
4. `status=approved`、`success=true`、`gate=pass`、artifact=`delivered`。
5. gate `artifact_version_id`、execution identity `artifact_version_id`、final artifact `version_id` 三者相同。
6. 父记录全部有效，或已通过 Task 8 的新版本血缘恢复。

候选规则：

- 先按 `stage_key + input_sha256 + parent identity` 分组。
- 恰好一个完全匹配候选：允许接纳。
- 多个完全匹配候选：返回 ambiguous，必须传 `--adopt-case <id>`。
- `case_ed9...` 不能因为时间较新而自动胜过 `case_4088...`。

幂等唯一键：

```ts
sha256(canonicalJson({
  run_id,
  stage_key,
  input_sha256,
  parent_record_ids,
  case_id,
  artifact_version_id,
}));
```

内容职责修正：

- 正常交付和恢复接纳使用同一个 `materializeDeliveredArtifact()`。
- 该函数只验证传输合同、artifact type/status、结构化文件可写和 SHA-256。
- `validateDraft` 中对白授权、连续重叠、篇幅质量等内容规则不得作为外部接纳门禁；Case gate 已负责这些判断。

- [ ] 写失败测试：a4/a5 同时合格时 ambiguous；显式选择 a5 后只生成一个 active Stage Record；错误输入/父版本/gate-version 绑定均 reject；重复接纳返回同一记录。
- [ ] 运行 `npx vitest run orchestrators/story-pipeline/src/reconciliation.test.ts`，Expected: FAIL。
- [ ] 实现 Stage 分组仲裁、身份验证和幂等物化。
- [ ] 运行测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add orchestrators/story-pipeline/src/reconciliation.ts orchestrators/story-pipeline/src/reconciliation.test.ts orchestrators/story-pipeline/src/quality.ts orchestrators/story-pipeline/src/index.ts
git commit -m "feat(story-pipeline): reconcile Forge cases by stage identity"
```

---

### Task 6: `reconcile` 命令、运行前恢复和安全锁

**Files:**
- Create: `orchestrators/story-pipeline/src/run-lock.ts`
- Create: `orchestrators/story-pipeline/src/run-lock.test.ts`
- Create: `orchestrators/story-pipeline/src/recovery-integration.test.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`

**CLI:**

```text
story-pipeline reconcile
  --config <production-config.json>
  --run-dir <dir>
  --db <file>
  (--dry-run | --apply)
  [--adopt-case <case-id>]
  [--attest-template-compatibility]
  [--attest-legacy-case-binding <case-id>:<stage-key>]
```

`--config` 必须提供。当前 Manifest 不足以重建 StagePlan，禁止仅凭 run-dir 猜测 artifact 类型和父关系。

参数解析改用 Commander 或显式布尔 flag 解析：

- `--dry-run` 与 `--apply` 必须二选一。
- `--adopt-case`、`--attest-template-compatibility`、`--attest-legacy-case-binding` 只能与 `--apply` 使用。
- 未知参数报错。

锁规则：

- 所有 Manifest 写入使用 Task 1 的 `manifest.lock + CAS`。
- 每个 Stage 另用哈希文件名：

```ts
const lockFile = `${sha256(`${runId}\0${stageKey}`)}.lock`;
```

- 锁内容记录 PID、进程启动时间、host、nonce、owner token hash。
- stale 回收必须原子 rename；PID 相同但启动时间不同视为陈旧。
- 所有锁路径经过 `ensureInsideRunDir`。

固定恢复顺序：

1. 构建 StagePlan。
2. 对账所有非终态 Attempt。
3. 关闭 stopped/failed/orphaned Attempt。
4. 按 Stage 仲裁 approved 候选。
5. 恢复可 resume 的原 Case。
6. 最后才允许创建新 Case。

- [ ] 写失败测试：dry-run 零写入；两个独立 Node 进程竞争 Manifest 时无丢事件；同 Stage 第二个进程被拒绝；布尔 flag 解析正确。
- [ ] 运行相关测试，Expected: FAIL。
- [ ] 实现 CLI、锁和运行前自动 reconcile。
- [ ] 顶层 `AbortController` 只负责发出取消；最终 Attempt 状态必须在 Forge abort/status 后通过同一 reconciliation 规则落盘。
- [ ] 运行测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add orchestrators/story-pipeline/src/run-lock.ts orchestrators/story-pipeline/src/run-lock.test.ts orchestrators/story-pipeline/src/recovery-integration.test.ts orchestrators/story-pipeline/src/index.ts
git commit -m "feat(story-pipeline): reconcile safely before execution"
```

---

### Task 7: 两阶段 replacement 和下游失效提交

**Files:**
- Modify: `orchestrators/story-pipeline/src/invalidation.ts`
- Modify: `orchestrators/story-pipeline/src/invalidation.test.ts`
- Modify: `orchestrators/story-pipeline/src/manifest.ts`
- Modify: `orchestrators/story-pipeline/src/index.ts`

**Interfaces:**

```ts
export interface ReplacementRecord {
  replacement_id: string;
  stage_key: string;
  old_record_id: string;
  expected_input_sha256: string;
  expected_template_identity: TemplateIdentity;
  expected_parent_record_ids: string[];
  attempt_id: string | null;
  status: 'pending' | 'committed' | 'cancelled';
  candidate_record: StageRecordV21 | null;
  reason: string;
}

export function activeForConsumption(manifest: PipelineManifestV21, stageKey: string): StageRecordV21 | null;
export function replacementTarget(manifest: PipelineManifestV21, stageKey: string): ReplacementRecord | null;
```

状态机：

- 检测到真实模板/输入/父版本变化时创建 pending replacement，但不立即失效旧记录。
- pending 时旧记录仍可审计和读取，但新的下游启动被阻止。
- 新产物先写文件并保存在 `candidate_record`，不得提前加入 active stages。
- committed 必须在一次 Manifest CAS 中完成：旧记录及 descendants 失效、新记录进入 active、replacement committed、事件追加。
- failed/stopped/validation failure 将 replacement cancelled；旧记录不失效。
- 重启时恢复同一个 pending attempt，不创建第二个 replacement。

- [ ] 写失败测试：pending 不立即失效；pending 时执行目标不是旧 active；成功 commit 原子切换；停止后 cancel；重启恢复同一 attempt。
- [ ] 运行 `npx vitest run orchestrators/story-pipeline/src/invalidation.test.ts`，Expected: FAIL。
- [ ] 实现状态机并删除 `existingStage()` 中“发现变化立即失效”的逻辑。
- [ ] 运行测试及 `npm run check`，Expected: PASS。
- [ ] 提交：

```powershell
git add orchestrators/story-pipeline/src/invalidation.ts orchestrators/story-pipeline/src/invalidation.test.ts orchestrators/story-pipeline/src/manifest.ts orchestrators/story-pipeline/src/index.ts
git commit -m "fix(story-pipeline): commit invalidation with replacement"
```

---

### Task 8: 真实历史血缘恢复与最终验收

**Files:**
- Modify: `orchestrators/story-pipeline/README.md`
- Runtime evidence only: `data/story-runs/gaokao-zero-real-003/manifest.json`

禁止删除 `inv-1`、`inv-2`。采用“重新接纳为新 Stage Record”的补偿方式：

```ts
interface ReinstatementRecord {
  reinstatement_id: string;
  old_record_id: string;
  new_record_id: string;
  case_id: string;
  evidence_sha256: string;
  compatibility: 'verified' | 'operator_attested';
  reason: string;
}
```

恢复顺序：

1. 备份原 Manifest。
2. `reconcile --dry-run` 输出悬空 Attempt、模板身份未知和候选冲突。
3. 验证历史 outline Case、输入、artifact、gate 和文件证据，重新接纳为 `outline-v2`。
4. 验证 packet 输入中的 blueprint 内容哈希等于 `outline-v2` artifact，重新接纳为 `packet-b001-v2`，父记录指向 outline-v2。
5. 对 draft a4/a5 做仲裁；若都满足身份，显式选择 `case_ed9f0a14c4a74388`。
6. 验证 draft 输入中的 packet 内容哈希等于 packet-b001-v2 artifact，接纳为 `draft-b001-v1`。
7. 确认下一阶段为 ledger-b001。

模板兼容声明规则：

- 能用已知旧算法在历史源快照上复算并匹配时，记为 `verified`。
- 没有历史源快照、无法证明纯算法变化时，只能通过 `--attest-template-compatibility` 写 `operator_attested`。
- 声明事件必须写明旧身份、新身份、record/case、操作者提供的 reason；不得改写历史 template identity。

历史 Case 绑定迁移规则：

- a4/a5 等旧 Case 创建时没有新协议中的 `run_binding` 与 `template_bundle_sha256`，因此不能直接满足 Task 5 的严格自动接纳条件。
- `reconcile --apply` 增加显式参数：

```text
--attest-legacy-case-binding <case-id>:<stage-key>
```

- 该声明必须同时记录 `run_id/story_id/stage_key/chapter_id`、Case 原始输入文件哈希、历史 Attempt 事件、operator reason 和声明时间。
- 历史 execution bundle 无法密码学复原时，记录为 `operator_attested` 或 `unknown`；禁止伪装成 `verified`。
- 新协议上线后创建的 Case 不允许使用 legacy binding 声明，必须严格比较 Forge 返回的不可变身份。

- [ ] 运行全部自动测试：

```powershell
npm test
npm run check
```

- [ ] 执行只读诊断：

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts reconcile `
  --config data/story-runs/gaokao-zero-real-003-config.json `
  --run-dir data/story-runs/gaokao-zero-real-003 `
  --db data/story-runs/gaokao-zero-real-003/forge.db `
  --dry-run
```

- [ ] 备份：

```powershell
Copy-Item `
  -LiteralPath data/story-runs/gaokao-zero-real-003/manifest.json `
  -Destination data/story-runs/gaokao-zero-real-003/manifest.pre-reconcile.json
```

- [ ] 先应用 Attempt 关闭与父血缘恢复；输出必须列出新旧 Record 对应关系。
- [ ] 对正文候选显式执行：

```powershell
npx tsx orchestrators/story-pipeline/src/index.ts reconcile `
  --config data/story-runs/gaokao-zero-real-003-config.json `
  --run-dir data/story-runs/gaokao-zero-real-003 `
  --db data/story-runs/gaokao-zero-real-003/forge.db `
  --apply `
  --adopt-case case_ed9f0a14c4a74388 `
  --attest-legacy-case-binding case_ed9f0a14c4a74388:draft-b001 `
  --attest-template-compatibility
```

- [ ] 再次 dry-run，Expected:

```json
{
  "actions": [],
  "ambiguous": [],
  "next_stage": "ledger-b001"
}
```

- [ ] 重复 apply，Expected: `actions: []`，Manifest revision 不因空操作增加。
- [ ] 运行 FakePi 中断验收：Windows 进程树不存在、Forge Case stopped、Attempt closed、Stage/Manifest 锁释放。
- [ ] 更新 README，说明事实边界、身份声明风险、候选冲突处理、replacement 和恢复命令。
- [ ] 仅提交代码与文档，不提交真实运行数据：

```powershell
git add orchestrators/story-pipeline/README.md
git commit -m "docs(story-pipeline): document safe recovery workflow"
```

---

## 最终验收矩阵

| 场景 | 预期 |
|---|---|
| Forge approved，Manifest interrupted | 身份全部匹配后接纳，不重新生成 |
| 同一 Stage 有两个 approved 候选 | ambiguous，要求 `--adopt-case` |
| Forge stopped，Manifest running | Attempt 关闭为 stopped |
| Forge running，外部收到 Ctrl+C | 终止完整进程树，以 token abort，Attempt 随后关闭 |
| Case 返回 waiting_human/repairing | 保留执行租约，resume 复用或显式转移 |
| Case input hash 与本地 Attempt 不同 | reject |
| 历史 Case 缺少 run binding | 仅允许显式 legacy binding 声明；新 Case 禁止豁免 |
| scenario/bundle 身份无法证明 | reject 或显式 compatibility attestation |
| gate version 与 final artifact version 不同 | reject |
| 父记录已失效 | 先恢复新父版本，禁止悬空接纳 |
| 同一 artifact 重复接纳 | 返回原 Stage Record |
| 两个进程并发写 Manifest | 一个 CAS 成功，另一个重载重试，不丢事件 |
| 新增 `__pycache__` | 模板源身份不变 |
| 仅哈希算法变化且可复算 | verified migration |
| 无历史源快照 | 只能 operator_attested，不冒充等价 |
| Prompt 内容真实变化 | pending replacement |
| replacement 失败 | 旧记录不失效，下游保持暂停 |
| replacement 成功 | 同一 CAS 切换 active 并传播失效 |
| Manifest rename 失败 | 正式文件保持可读，临时文件清理 |
| 恢复完成后再次执行 | 零动作、零重复记录 |

## 非目标

- 不修改故事正文、大纲、章节包、账本或终审模板的内容规则。
- 不让外部编排器重新判断故事质量。
- 不删除或改写历史 event、invalidation 或失败 Attempt。
- 不自动选择多个同等 approved Case。
- 不用模板兼容声明掩盖无法证明的模板内容变化。
