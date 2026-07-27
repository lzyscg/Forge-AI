# 外接故事编排器恢复一致性 Spec

**状态：** 待用户确认  
**日期：** 2026-07-27  
**对应实施计划：** `docs/superpowers/plans/2026-07-27-story-pipeline-recovery-consistency.md`

## 1. 背景

Forge AI 已能在单个 Case 内完成故事产物生成、审核、Issue 返修和 delivery gate。外接故事编排器负责把大纲、章节包、正文、账本和终审拆成多个 Case 串行执行，并保存结构化产物、依赖和哈希证据。

真实运行 `gaokao-zero-real-003` 暴露了跨系统状态不一致：

- Forge Case 已 approved，但对应 Attempt 仍是 interrupted。
- Forge Case 已 stopped，但对应 Attempt 仍是 running。
- 模板哈希算法升级被误判为模板内容变化，导致已交付父产物失效。
- 同一正文 Stage 存在多个 approved 候选，当前编排器没有仲裁规则。
- 父记录失效后，编排器不能安全接纳已批准正文并继续 ledger。

这些问题阻断的是跨 Case 接续，不是正文 Case 的内容审核能力。

## 2. 设计决策

采用“外部编排器主导恢复 + Forge 最小事实协议”。

### 2.1 选择该方案的原因

外部编排器拥有 Stage、父子依赖、运行目录和 Manifest，因此由它负责：

- Stage 调度和恢复顺序；
- Attempt 与 Forge 状态对账；
- approved 候选仲裁；
- 产物接纳和文件证据；
- Manifest 并发控制；
- replacement 与下游失效传播。

Forge 拥有 Case 输入、scenario snapshot、实际执行模板、artifact version 和 gate，因此只有 Forge 能提供：

- 不可变 Case 身份；
- gate 与最终 artifact version 的绑定；
- 实际执行 bundle 身份；
- 对 running Case 的安全 abort 权限。

### 2.2 未采用方案

**纯外部修复：** 不采用。当前 `case status` 缺少输入和执行身份，`case stop` 又拒绝 running；外部无法安全补齐事实。

**把跨 Case 编排迁入 Forge：** 不采用。改动面过大，违反外接编排器不侵入现有 Case 系统的目标。

## 3. 目标

系统必须实现：

1. Forge approved Case 即使 Manifest 标为 interrupted，也能在身份一致后被接纳。
2. Forge stopped/failed Case 对应的悬空 Attempt 能被关闭。
3. 同一 Stage 多个 approved Case 不被自动误选。
4. 模板哈希算法变化不再自动等同于模板内容变化。
5. 已失效历史父记录可以通过追加式新版本恢复，不能删除旧 invalidation。
6. 中断时能够收束完整 Windows 进程树、Forge Case、Attempt 和锁。
7. 并发进程不能覆盖彼此的 Manifest 更新。
8. 恢复操作可 dry-run、可审计、可重复执行且不产生重复记录。
9. 当前真实运行恢复后，下一阶段为 `ledger-b001`，不重新生成 outline、packet 或 draft。

## 4. 非目标

- 不修改故事模板的内容质量规则。
- 不让外部编排器判断人物逻辑、爽点、文风、仿写质量、对白授权或情绪曲线。
- 不删除历史 Attempt、event、invalidation 或失败证据。
- 不自动认定无法证明的旧模板与新模板密码学等价。
- 不自动选择多个同等 approved 候选中的“最新一个”。
- 本次恢复不运行真实 ledger、后续章节或终审模型；代码验收与恢复验收完成后再单独启动生产。

## 5. 职责边界

### 5.1 Forge 是以下事实的唯一来源

- Case 的真实状态；
- Case 创建时的输入 payload；
- Case 的 scenario snapshot；
- run/resume 实际使用的 template bundle；
- artifact version 状态；
- delivery gate 结果；
- gate 对应的 artifact version；
- Case 执行租约。

### 5.2 外部编排器是以下事实的唯一来源

- run/story/stage/chapter 身份；
- Stage 依赖图；
- Attempt 投影；
- Stage Record 和文件证据；
- 当前 active、pending replacement 和 invalidated 版本；
- 恢复候选仲裁结果；
- 下一个待执行 Stage。

### 5.3 内容门禁

Forge Case 内的 scenario validator 是内容门禁。外部编排器只验证：

- artifact type 与状态；
- Case/gate/artifact version 身份绑定；
- 输入和父记录身份；
- 文件存在性、编码、结构化载体与 SHA-256。

现有外部 `validateDraft` 中对白授权、篇幅质量、原文重叠等内容规则不得继续作为接纳阻断条件。

## 6. Forge 身份协议

`forge case status` 必须返回：

```ts
interface ResultCaseIdentity {
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

interface ResultExecutionIdentity {
  template_bundle_sha256: string;
  artifact_version_id: string;
}

interface ResultGate {
  status: 'pass' | 'fail';
  artifact_version_id: string;
  checks: ResultGateCheck[];
}
```

规范要求：

- `case status` 必须基于 Case 的不可变 scenario snapshot，不得优先读取当前磁盘 scenario。
- Case 创建时必须保存 `input_payload_sha256` 和结构化 `run_binding`。
- 每次 run/resume 必须计算实际 scenario、prompt、skill、validator bundle SHA-256。
- 最终 artifact version 和 gate 必须绑定同一个 execution identity。
- gate、execution identity、final artifact 返回的 `artifact_version_id` 必须相同。

## 7. Forge 执行租约

长时间运行的 Case 使用执行租约：

```ts
interface ExecutionLease {
  runner_token_sha256: string;
  runner_pid: number;
  runner_started_at: string;
  heartbeat_at: string;
}
```

CLI：

```text
forge case run <id> --runner-token <uuid>
forge case abort <id> --runner-token <uuid>
forge case transfer-lease <id> --old-runner-token <uuid> --new-runner-token <uuid>
```

规范要求：

- run 原子获取租约；第二个 runner 不得覆盖。
- abort 只有 token 匹配时才能把非终态 Case 转为 stopped。
- approved、failed、stopped 等终态不得重新 abort。
- `waiting_human`、`waiting_review`、`repairing` 返回时保留租约。
- resume 复用原租约；更换执行者必须显式 transfer。
- 只有 Case 到达终态时才清理租约。
- runner 明文 token 不写入 Manifest 或事件。

## 8. Manifest 2.1

Manifest 增加：

```ts
interface PipelineManifestV21 {
  schema_version: '2.1';
  revision: number;
  previous_manifest_sha256: string | null;
  stages: StageRecordV21[];
  attempts: StageAttemptV21[];
  invalidations: InvalidationRecord[];
  reinstatements: ReinstatementRecord[];
  replacements: ReplacementRecord[];
  events: ManifestEventV21[];
}
```

Attempt 必须持久化：

- stage、chapter、template、expected artifact type；
- input SHA-256；
- parent record IDs；
- template identity；
- runner token SHA-256；
- 权限受限凭据文件的相对路径；
- outcome 和时间。

### 8.1 事件

事件数组是带 SHA-256 的追加日志，不宣称完整 event sourcing。状态变更事件必须包含结构化 before/after、Attempt、Case、artifact/version、原因和操作者声明。

### 8.2 Manifest 写入

所有写入必须：

1. 获取 run 级 `manifest.lock`；
2. 锁内重新读取最新文件；
3. 校验 `revision` 和末尾 event hash；
4. 应用变更；
5. 写同目录临时文件并 fsync；
6. 原子 rename；
7. 失败时保留原文件并清理临时文件。

Stage 锁只防同一 Stage 重复运行，不能替代 Manifest 写锁。

## 9. 模板身份

```ts
interface TemplateIdentity {
  algorithm: 'legacy-unversioned-v1' | 'source-tree-sha256-v2';
  content_sha256: string;
  equivalence: 'verified' | 'operator_attested' | 'unknown';
}
```

比较规则：

- 同算法、同哈希：equal。
- 同算法、不同哈希：content_changed。
- 不同算法：migration_required，不能直接判定内容变化。

源树哈希忽略 `__pycache__`、`.pyc`、日志、临时文件和运行产物。

若能使用已知旧算法在历史源快照上复算并匹配，迁移标记为 `verified`。没有历史源快照时，只允许显式 `operator_attested` 兼容声明，并保留旧身份，禁止伪装为等价。

## 10. 对账与接纳

每次 run 前和 `reconcile` 命令中执行相同对账。

### 10.1 恢复顺序

1. 根据生产配置构建 StagePlan。
2. 查询所有非终态 Attempt 对应的 Forge Case。
3. 关闭 Forge 已 stopped/failed 的 Attempt。
4. 按 Stage 对 approved 候选分组。
5. 接纳唯一完全匹配候选，或报告 ambiguous。
6. 恢复可继续的原 Case。
7. 以上都不存在时才创建新 Case。

### 10.2 自动接纳条件

全部满足时才允许自动接纳：

1. Forge run binding 与 StagePlan 完全相同。
2. Forge input payload hash 与 StagePlan input hash 相同。
3. scenario 与 execution bundle 身份兼容。
4. Case approved、success=true。
5. gate pass。
6. artifact delivered。
7. gate、execution identity、final artifact 指向同一 version。
8. 父记录全部有效。

### 10.3 候选仲裁

候选按以下身份分组：

```text
run_id
+ stage_key
+ input_sha256
+ ordered parent_record_ids
+ expected artifact type
```

- 唯一完全匹配候选：接纳。
- 多个完全匹配候选：返回 ambiguous。
- ambiguous 只能通过 `--adopt-case <id>` 解决。
- 显式选择仍必须满足其余身份和 gate 条件。

### 10.4 幂等

接纳唯一键：

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

同一键重复接纳必须返回原 Stage Record，不增加 Manifest revision。

## 11. 历史 Case 迁移

旧 Case 没有新协议中的 run binding 和 template bundle 身份，不得假装满足严格身份条件。

允许显式声明：

```text
--attest-legacy-case-binding <case-id>:<stage-key>
--attest-template-compatibility
```

声明必须记录：

- run/story/stage/chapter；
- 原始 Attempt 和 input 文件 SHA-256；
- Case ID；
- 旧、新模板身份；
- operator reason；
- 声明时间；
- `operator_attested` 或 `unknown` 证明等级。

新协议上线后创建的 Case 禁止使用 legacy binding 豁免。

## 12. 历史父血缘恢复

历史 `inv-1`、`inv-2` 不得删除。

恢复采用新 Stage Record：

1. 验证历史 outline Case 和文件证据，重新接纳为 `outline-v2`。
2. 验证 packet 输入中的 blueprint 内容哈希等于 outline-v2 artifact，重新接纳为 `packet-b001-v2`。
3. draft 新记录引用 `packet-b001-v2`。

记录：

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

这样保留原 invalidation，同时建立新的有效血缘。

## 13. Replacement 与失效传播

检测到真实 template/input/parent 变化时：

1. 创建 pending replacement；
2. 旧记录仍可读取和审计；
3. 新下游启动被暂停；
4. 新产物先作为 candidate；
5. 成功后在一次 Manifest CAS 中启用新记录并失效旧记录及 descendants；
6. 失败或停止则取消 replacement，旧记录不失效。

pending 必须固化：

- expected input SHA-256；
- expected template identity；
- expected parent record IDs；
- Attempt ID；
- candidate record。

## 14. 进程与锁

### 14.1 Forge 子进程

外部编排器直接异步启动 CLI TypeScript 入口，不经过使用 `execFileSync` 的 `apps/cli/bin.js`。

Windows 使用精确 PID 的 `taskkill.exe /PID <pid> /T /F` 终止完整进程树；POSIX 使用独立进程组。子进程退出后使用原 runner token 调用 `case abort`，再通过 status 对账。

### 14.2 Stage 锁

锁文件名使用：

```ts
sha256(run_id + '\0' + stage_key) + '.lock'
```

内容包含 PID、进程启动时间、host、nonce 和 owner token hash。判定 stale 时同时比较 PID 和启动时间；回收使用原子 rename。所有路径必须验证位于 run 目录内部。

## 15. CLI

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

规则：

- `--config` 必填，因为旧 Manifest 不足以安全重建 StagePlan。
- `--dry-run` 与 `--apply` 必须二选一。
- adopt/attest 参数只能与 apply 使用。
- 未知参数报错。
- dry-run 不写 Manifest、不写凭据、不改变 Forge Case。

## 16. 错误处理

| 情况 | 行为 |
|---|---|
| Forge status 查询失败 | 不改变 Attempt，返回可重试错误 |
| Case input 不匹配 | reject |
| gate/version 不绑定 | reject |
| 多个同等 approved 候选 | ambiguous |
| 父记录失效 | 先恢复父血缘 |
| Manifest CAS 冲突 | 重载后重算一次；再次冲突则退出 |
| replacement 失败 | cancelled，旧记录保留 |
| token 丢失 | 禁止 abort；报告需要租约恢复 |
| Windows 进程树无法确认终止 | 不释放 Stage 锁，标记需人工恢复 |
| operator attestation 缺少 reason | 拒绝执行 |

## 17. 安全要求

- runner token 明文只存于 run 目录下权限受限凭据文件。
- Manifest 和日志只记录 token SHA-256。
- Case 终态后删除凭据文件。
- 所有 Case/Stage/文件身份在接纳前重新计算。
- 所有运行目录路径使用 canonical path 并验证边界。
- 外部命令使用参数数组和 `shell: false`，不得拼接命令字符串。

## 18. 测试策略

### 18.1 单元测试

- Manifest 2.0→2.1 迁移；
- event hash 和 CAS；
- 原子保存失败；
- template identity 比较；
-候选仲裁；
- 接纳幂等；
- replacement 状态机；
- Stage 锁 stale 回收；
- CLI 参数约束。

### 18.2 FakePi 集成测试

- 真实 CLI create/run/status/abort；
- status 使用不可变 snapshot；
- gate 与 artifact version 绑定；
- 错误 token abort 被拒绝；
- waiting_human 保留租约；
- Windows Ctrl+C 后进程树、Case、Attempt 和锁收束；
- 两个 Node 进程竞争 Manifest 不丢事件；
- 两个 approved Case 对应同 Stage 时 fail closed。

### 18.3 真实运行恢复验收

恢复 `gaokao-zero-real-003` 时：

1. 不调用真实模型。
2. 先备份 Manifest。
3. 保留 `inv-1`、`inv-2`。
4. 新建 outline-v2、packet-b001-v2。
5. a4/a5 冲突必须显式选择。
6. 接纳 `case_ed9f0a14c4a74388`。
7. 关闭 a6、outline-a2 悬空 Attempt。
8. 再次执行 reconcile 得到零动作。
9. `next_stage` 必须为 `ledger-b001`。

## 19. 上线顺序

1. Manifest 2.1、模板身份和 CAS。
2. Forge 不可变身份协议。
3. Forge 执行租约和 abort。
4. 异步 Forge client。
5. Stage 对账、仲裁和接纳。
6. reconcile CLI、运行前恢复和安全锁。
7. replacement 两阶段提交。
8. FakePi 全量验收。
9. 真实 Manifest 备份和只读 dry-run。
10. 显式应用历史恢复。

## 20. 完成标准

只有以下条件全部满足，才能声称恢复链路修复完成：

- `npm test` 和 `npm run check` 通过；
- Windows FakePi 取消测试通过；
- 并发 Manifest 测试通过；
- approved Case 接纳测试覆盖唯一候选和冲突候选；
- 真实恢复没有调用模型；
- 历史事件和 invalidation 保留；
- 当前正文被接纳为有效 Stage Record；
- `next_stage = ledger-b001`；
- 重复 reconcile 为零动作。

