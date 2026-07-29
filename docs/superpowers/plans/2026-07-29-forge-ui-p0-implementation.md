# Forge UI P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个本机可真实使用的 Forge UI P0：操作者无需 CLI 即可选择模板与 Agent 模型、启动任务、观察真实进度、处理人工介入或安全恢复、阅读当前有效产物，并以真实 Pi、持久化命令和进程级崩溃恢复证据完成验收。

**Architecture:** 保持 `contracts → domain → application → adapters → apps` 单向依赖。Next.js 只做同源 BFF 与 UI，application 提供 Query/Command 用例，SQLite 保存任务、命令、outbox、Turn Journal 和全部权威证据，常驻 Supervisor 为每个 Case 启动独立 Worker；浏览器通过 REST 提交命令、通过 SSE 失效 Query，不维护第二套生产状态。

**Tech Stack:** Node.js `>=22.19.0`、TypeScript 5.5、TypeBox、Vitest、SQLite/better-sqlite3、`@earendil-works/pi-ai@0.82.0`、`@earendil-works/pi-coding-agent@0.82.0`、Next.js 14 App Router、React 18、TanStack Query、React Hook Form、Radix UI、CSS Modules、Playwright。

## Global Constraints

- 依赖只能为 `contracts → domain → application → adapters → apps`，domain/application 不依赖 SQLite、Next.js、Electron 或 Pi SDK。
- 全仓、CI、README 和发布门禁统一使用 Node.js `>=22.19.0`；Pi 依赖精确锁定为 `0.82.0`，可重复安装使用 `npm ci`。
- 平台代码不得按业务角色名、阶段名或产物名分支；全部来自冻结模板修订。
- 生产证据追加而不覆盖；交付只由系统门禁判定；UI 不得直接改写 Case、Issue、版本或门禁状态。
- API Key、Token、Authorization Header、Cookie、Provider 凭据路径和隐藏思维链不得进入日志、数据库业务表、API、SSE 或 UI。
- P0 默认最多并发运行 `1` 个 Case；提高并发不在本计划范围。
- P0 本地服务只监听 `127.0.0.1`；不建设账号、鉴权、权限、多用户、Electron 或局域网访问。
- 任务启动后冻结输入、模板修订、环境和每个 Agent 的 `provider_id + model_id`；恢复不得静默替换。
- 真实 Pi 和进程级崩溃恢复门禁通过前，只实现功能性 UI，不做视觉打磨。
- 任何 Provider/文件/进程 IPC 等外部 I/O 都不得发生在业务写事务内；唯一例外是 Task 2 已隔离全部业务 Writer 的离线迁移维护窗口，其中 SQLite Backup API 属于被测试的维护协议。
- 所有 Worker 业务写必须携带 `worker_instance_id + lease_generation` 并在同一 SQL 事务中验证当前租约；失效 Worker 只能得到 `LEASE_LOST` 后退出。
- `execution_lease` 是 Worker 运行及业务写的唯一权威租约；命令在交接前只有短暂的 Supervisor dispatch claim，交接后不得再维护第二套命令租约。
- application 的跨聚合原子用例只依赖 `TransactionScopePort`；SQLite Adapter 的 `SqliteUnitOfWork` 用同一连接和 branded transaction context 实现它，Repository 自己不得打开隐式写连接。
- 日志、Pi Session、数据库诊断和 Query 共用一套前置 `SecretSanitizer`；任何持久化 sink 不得自建宽松规则。
- 每项实现使用 TDD；一次任务只提交本任务文件，禁止夹带无关改动。

---

## File Map

### Contracts

- `packages/contracts/src/api.ts`：统一 REST 成功包、错误包、分页与 action descriptor。
- `packages/contracts/src/model-catalog.ts`：Provider/Model 目录、Agent 模型选择和冻结模型 Contract。
- `packages/contracts/src/production-task.ts`：生产任务、草稿、任务—Case 绑定与命令 Contract。
- `packages/contracts/src/task-workspace.ts`：任务工作区、泳道节点/边、Agent 会话和产物摘要 DTO。
- `packages/contracts/src/commands.ts`：持久化命令、幂等键、控制命令与状态。
- `packages/contracts/src/ui-events.ts`：SSE/outbox 事件与游标。
- `packages/contracts/src/config.ts`：版本化本地配置和数据目录相关 Contract。
- `packages/contracts/src/progress.ts`：模板 `presentation.progress` 的通用 evidence Schema 与归并结果。
- `packages/contracts/src/ports.ts`：声明 `TransactionScopePort` 及任务、命令、查询、目录和 Journal 所需端口；application 只依赖这些抽象，后续任务逐步收窄调用面。
- `packages/contracts/src/health.ts`：脱敏健康快照、readiness 与固定阈值 Contract。

### Domain / Application

- `packages/domain/src/production-task-state.ts`：草稿、冻结、归档和回收站规则。
- `packages/domain/src/artifact-version-selection.ts`：当前有效、最新创建与交付版本统一选择规则。
- `packages/domain/src/command-state.ts`：命令状态迁移与可领取判定。
- `packages/domain/src/turn-journal-state.ts`：Turn Journal 阶段迁移。
- `packages/application/src/task-command-service.ts`：保存草稿、启动、暂停、恢复、停止、人工回答。
- `packages/application/src/task-query-service.ts`：任务列表与工作区投影。
- `packages/application/src/agent-session-query-service.ts`：按需 Agent 会话浮窗投影。
- `packages/application/src/artifact-query-service.ts`：正文、版本和 Diff 查询。
- `packages/application/src/model-catalog-service.ts`：Pi 目录发现、快照和实时校验。
- `packages/application/src/template-registry-service.ts`：Bundle 校验、不可变修订注册与读取。
- `packages/application/src/supervisor-service.ts`：命令领取、并发调度与 Worker 生命周期。
- `packages/application/src/turn-journal-service.ts`：短事务阶段提交与恢复决策。
- `packages/application/src/secret-sanitizer.ts`：写入前与查询前共用的脱敏规则。
- `packages/application/src/progress-projector.ts`：只基于通用持久化证据计算离散进度。
- `packages/application/src/ui-event-service.ts`：事件回放、水位、保留和清理用例。
- `packages/application/src/health-query-service.ts`：聚合脱敏健康快照，不让 BFF 读取 Adapter。

### Adapters / Apps

- `packages/adapters/src/migrations/*`：显式前向迁移与 checksum。
- `packages/adapters/src/database-connection.ts`：统一 SQLite 连接工厂、外键和 busy timeout。
- `packages/adapters/src/database-bootstrap.ts`：唯一迁移后打开入口。
- `packages/adapters/src/sqlite-unit-of-work.ts`：跨 Repository 共享连接与事务上下文。
- `packages/adapters/src/sqlite-*.ts`：按职责拆分任务、命令、查询、模板、目录、Journal Repository。
- `packages/adapters/src/backup-manager.ts`：SQLite Backup API、校验和保留。
- `packages/adapters/src/disk-space-guard.ts`：迁移/启动/导入的空间门禁。
- `packages/adapters/src/structured-logger.ts`：脱敏结构化日志、关联 ID 和轮转。
- `packages/adapters/src/sanitized-session-manager.ts`：Pi JSONL 所有 entry 类型的唯一白名单序列化 sink。
- `packages/adapters/src/template-cas.ts`：模板资源 CAS。
- `packages/adapters/src/pi-model-catalog.ts`：Pi 公共模型目录 Adapter。
- `packages/adapters/src/pi-adapter.ts`：按 Session 接收准确 Provider/Model。
- `packages/adapters/src/process-host.ts`：Supervisor/Worker 跨平台进程宿主。
- `apps/supervisor/src/main.ts`：常驻 Supervisor 入口。
- `apps/worker/src/main.ts`：单 Case Worker 协议入口，不再承担命令行任务创建。
- `apps/web/app/api/v1/**/route.ts`：类型化 REST/SSE BFF。
- `apps/web/app/tasks/**`、`apps/web/app/templates/**`：功能性 UI。
- `apps/web/components/**`：任务工作区、纵向泳道、左右抽屉和 Agent 会话浮窗。
- `apps/launcher/src/main.ts`：`forge ui` 单实例启动、健康检查与 draining。
- `scripts/process-fault-matrix.cjs`、`scripts/release-realpi-e2e.cjs`：发布门禁。

---

### Task 1: 冻结共享 Contract、错误码与 REST 路由

**Files:**
- Create: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/model-catalog.ts`
- Create: `packages/contracts/src/production-task.ts`
- Create: `packages/contracts/src/commands.ts`
- Create: `packages/contracts/src/ui-events.ts`
- Create: `packages/contracts/src/task-workspace.ts`
- Create: `packages/contracts/src/progress.ts`
- Create: `packages/contracts/src/health.ts`
- Create: `packages/application/src/secret-sanitizer.ts`
- Test: `packages/contracts/src/api-contracts.test.ts`
- Test: `packages/application/src/secret-sanitizer.test.ts`
- Modify: `packages/contracts/src/scenario.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: root `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `ApiSuccessSchema<T>`, `ApiErrorSchema`, `ForgeErrorCodeSchema`, `ProductionTaskSchema`, `TaskWorkspaceSchema`, `AgentSessionDetailSchema`, `ArtifactVersionSchema`, `ArtifactDiffSchema`, `CommandSchema`, `UiEventSchema`, `SseStreamResetSchema`, `AgentModelSelectionSchema`, `ProgressPresentationSchema`, `HealthSnapshotSchema`, and the shared `SecretSanitizer`.
- Consumes: existing TypeBox and scenario/Case/artifact/Issue contracts.

- [ ] **Step 1: Write failing Contract tests**

  Assert with `Check` that valid DTOs pass and that unknown fields, missing IDs, invalid environment, duplicate Agent model entries, invalid command transitions and secrets in public diagnostic fields fail. Freeze these error codes:

  ```ts
  export const ForgeErrorCodes = [
    'VALIDATION_FAILED',
    'NOT_FOUND',
    'OBJECT_SCOPE_MISMATCH',
    'REVISION_CONFLICT',
    'STATE_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'MODEL_CATALOG_UNAVAILABLE',
    'MODEL_UNAVAILABLE',
    'MODEL_CONFIGURATION_DRIFT',
    'TEMPLATE_REVISION_INVALID',
    'COMMAND_REJECTED',
    'SUPERVISOR_UNAVAILABLE',
    'RECOVERY_UNSAFE',
    'DISK_SPACE_LOW',
    'SCHEMA_INCOMPATIBLE',
    'LEGACY_SECRET_DETECTED',
    'MIGRATION_PROCESS_ACTIVE',
    'LEASE_LOST',
    'CURSOR_AHEAD',
    'PAYLOAD_TOO_LARGE',
    'INTERNAL_ERROR',
  ] as const;
  ```

  Change root `engines.node` to `>=22.19.0`, replace Pi caret ranges with exact `0.82.0`, refresh the lockfile under Node 22.19+, and document `npm ci` as the supported installation command. Add a preflight test that fails on an older Node or resolved Pi version drift.

- [ ] **Step 2: Run the tests and verify failure**

  Run: `npx vitest run packages/contracts/src/api-contracts.test.ts`
  Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement exact public DTO boundaries**

  Use TypeBox with `additionalProperties: false`. Define:

  ```ts
  type ApiSuccess<T> = { ok: true; data: T; request_id: string };
  type ApiError = {
    ok: false;
    error: {
      code: ForgeErrorCode;
      message: string;
      field_path?: string;
      diagnostic_ref?: string;
      conflict?: DraftConflictSchema | StateConflictSchema;
    };
    request_id: string;
  };
  type AgentModelSelection = {
    agent_key: string;
    provider_id: string;
    model_id: string;
    source: 'template' | 'task_override';
  };
  ```

  `TaskWorkspace` must contain `task`, `status_summary`, `progress`, `legal_actions`, `configuration`, `lanes`, paged `nodes`, paged `edges`, `artifact_panel`, `source_event_seq`, and `projection_revision`. `AgentSessionDetail` must contain `session`, paged ordered `turns`, optional `focus_turn_id`, and sanitized per-Turn `input`, `public_reasoning_summary`, `tool_actions`, `output`, `system_results`.

  Freeze finite bounds in every public schema: IDs/idempotency keys `1..128` chars; labels/titles `1..200`; public diagnostic text `2 KiB`; input, answer and model output `1 MiB`; sanitized tool arguments/result `256 KiB` each; at most `100` input fields, `100` Agents and `100` tool actions per Turn. Task/template/model collections page at `1..100`; Agent Session turns page at `1..100`; one workspace graph page carries at most `500` nodes and `1,000` edges with opaque cursor and `has_more`; template resource manifests carry at most `1,000` bounded entries. Progress contains at most `16` stages and `64` total steps; Workspace embeds at most `20` newest round summaries total plus `round_count` and `rounds_truncated`, while complete round history remains P1. Inline artifact text is at most `5 MiB`; larger text returns metadata plus `download_required`. Diff requires explicit `from_version_id` and `to_version_id` from the same task/artifact/environment, is capped at `50,000` lines or `2 MiB`, and on truncation returns `truncated` plus the two stable scoped version-download actions for offline comparison; it does not claim to provide a full diff download. HTTP JSON bodies are at most `2 MiB`. Public errors use fixed messages; operation-specific conflict DTOs contain only white-listed task revision/status/action fields.

  Extend the existing `ScenarioSchema` with optional `presentation.progress`. Stage/step keys are unique and ordered; selectors permit only `case_status | agent_turn | artifact_version | evaluation | issue | revision_instruction | human_input | delivery_gate`, with stable template-local keys and referenced Agent/artifact identities. `evaluation` identifies immutable structured `evaluation_evidence` and maps its enum result to waiting/blocked/completed without reading prose. Template registration validates every Agent/artifact reference and the stage/step bounds. Aggregation priority is `blocked > waiting > in_progress > completed > not_started`; repeated Issue/revision/evaluation evidence creates bounded newest-round summaries. A template without this block falls back only to non-prunable Case, Turn, artifact, Issue, revision, human-request and gate facts; prunable UI events are invalidation hints and never progress evidence.

  `HealthSnapshotSchema` exposes only `instance_id`, `release_id`, schema version, `runtime_adapter_id`, `test_hooks_enabled`, `ready: boolean`, `status: healthy | degraded | unhealthy`, named reason codes and bounded counters/timestamps. Adapter identity is a fixed implementation/version label, not configuration. It never exposes paths, credentials, process command lines or raw errors.

- [ ] **Step 4: Implement the shared sanitizer before any new sink**

  One pure application service owns key-name, structured-value and text-pattern redaction. It fail-closes on unsupported/cyclic values and emits a bounded redaction marker/count. Contract errors, logger fields, Pi Session entries, DB diagnostics and Query output must all call this same service; tests inject credentials, headers, cookies, Provider errors and hidden reasoning.

- [ ] **Step 5: Add the versioned route table to the test**

  Freeze:

  ```tex
  GET    /api/v1/tasks
  POST   /api/v1/tasks
  GET    /api/v1/tasks/:taskId
  PUT    /api/v1/tasks/:taskId/draf
  POST   /api/v1/tasks/:taskId/star
  POST   /api/v1/tasks/:taskId/commands
  POST   /api/v1/tasks/:taskId/human-requests/:actionId/answer
  GET    /api/v1/tasks/:taskId/workspace
  GET    /api/v1/tasks/:taskId/sessions/:sessionId
  GET    /api/v1/tasks/:taskId/artifacts/:artifactId/versions/:versionId
  GET    /api/v1/tasks/:taskId/artifacts/:artifactId/versions/:versionId/download
  GET    /api/v1/tasks/:taskId/artifacts/:artifactId/diff
  GET    /api/v1/templates
  GET    /api/v1/models
  POST   /api/v1/models/refresh
  GET    /api/v1/events?env=:environment&after=:eventSeq
  GET    /api/v1/health
  ```

- [ ] **Step 6: Run checks and commit**

  Run: `npm ci && npx vitest run packages/contracts/src/api-contracts.test.ts packages/application/src/secret-sanitizer.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(contracts): define Forge UI P0 API contracts`

### Task 2: 建立显式迁移、应用数据目录与兼容保护

**Files:**
- Create: `packages/contracts/src/config.ts`
- Modify: `packages/contracts/src/ports.ts`
- Create: `packages/adapters/src/data-root.ts`
- Create: `packages/adapters/src/migrations/types.ts`
- Create: `packages/adapters/src/migrations/001-baseline.ts`
- Create: `packages/adapters/src/migrations/002-ui-control-plane.ts`
- Create: `packages/adapters/src/migrations/003-turn-journal.ts`
- Create: `packages/adapters/src/migration-runner.ts`
- Create: `packages/adapters/src/database-connection.ts`
- Create: `packages/adapters/src/database-bootstrap.ts`
- Create: `packages/adapters/src/sqlite-unit-of-work.ts`
- Create: `packages/adapters/src/backup-manager.ts`
- Create: `packages/adapters/src/disk-space-guard.ts`
- Create: `packages/adapters/src/structured-logger.ts`
- Create: `packages/adapters/src/legacy-process-probe.ts`
- Test: `packages/adapters/src/migration-runner.test.ts`
- Test: `packages/adapters/src/database-bootstrap.integration.test.ts`
- Test: `packages/adapters/src/sqlite-unit-of-work.test.ts`
- Test: `packages/adapters/src/backup-manager.test.ts`
- Test: `packages/adapters/src/disk-space-guard.test.ts`
- Test: `packages/adapters/src/structured-logger.test.ts`
- Test: `packages/adapters/src/legacy-process-probe.integration.test.ts`
- Modify: `packages/adapters/src/sqlite-repository.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/cli/src/setup.ts`
- Modify: existing Web read bootstrap and all tests that instantiate `SqliteRepository`

**Interfaces:**
- Produces: `resolveDataRoot(options): DataRootPaths`, `DatabaseBootstrap.openWritable/openReadonly`, `MigrationRunner.migrate(dbPath)`, `SqliteUnitOfWork.run()`, schema versions `1..3`, safe backup/disk/logging foundations.
- Consumes: Node filesystem/path, better-sqlite3, config Contract.

- [ ] **Step 1: Write migration failure tests**

  Cover empty DB, every committed legacy schema fixture, repeated migration, checksum mismatch, injected failure rollback, DB newer than supported version, active WAL, insufficient disk, backup restore, two-process migration race, a full legacy Worker that ignores the new data-root lock, production/test path isolation and path normalization. For every fixture assert evidence row counts and content hashes are unchanged. A pre-identity fixture receives one new `db_instance_id` exactly once and keeps it on the second open; fixtures that already contain identity must retain the original value.

- [ ] **Step 2: Run the focused test**

  Run: `npx vitest run packages/adapters/src/migration-runner.test.ts`
  Expected: FAIL because `MigrationRunner` does not exist.

- [ ] **Step 3: Implement migration 001 and legacy adoption**

  Migration 001 creates `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`. Check in one immutable fixture and schema fingerprint for each historically committed shape: pre-identity schema, identity columns partially added, and current full schema. Each known fingerprint gets one deterministic upgrade path; unknown/ambiguous partial schemas fail with `SCHEMA_INCOMPATIBLE`. Do not recreate or rewrite core evidence merely to adopt it.

- [ ] **Step 4: Implement migration 002 control-plane schema**

  Create, with foreign keys and indexes:

  ```sql
  production_tasks(task_id PK, title, environment, lifecycle, template_revision_id,
    draft_input_json, draft_revision, draft_hash, source_task_id, archived_at,
    trashed_at, frozen_at, created_at, updated_at)
  production_task_cases(task_id, case_id UNIQUE, environment, bound_at,
    PRIMARY KEY(task_id, case_id))
  task_agent_models(task_id, agent_key, provider_id, model_id, source,
    catalog_snapshot_id, selection_config_fingerprint,
    PRIMARY KEY(task_id, agent_key))
  template_revisions(template_revision_id PK, scenario_id, scenario_version,
    parent_revision_id, bundle_sha256 UNIQUE, config_snapshot, resource_manifest,
    source_kind, source_ref, validation_json, created_at)
  template_resource_refs(template_revision_id, resource_path, object_sha256,
    byte_size, media_type, PRIMARY KEY(template_revision_id, resource_path))
  model_catalog_snapshots(snapshot_id PK, snapshot_sha256 UNIQUE, catalog_sha256,
    provider_model_fingerprint_map_json, payload_json,
    refreshed_at, expires_at, created_at)
  commands(command_id PK, environment, task_id, case_id, command_type,
    payload_json, payload_hash, idempotency_key, expected_revision, expected_case_status,
    status, priority, dispatch_owner, dispatch_generation, dispatch_expires_at,
    worker_instance_id, execution_lease_generation, related_run_command_id,
    recovery_target_kind, recovery_for_turn_id, recovery_for_journal_revision,
    recovery_for_owning_run_command_id, recovery_for_worker_instance_id,
    recovery_for_lease_generation, attempt_count, available_at,
    result_json, error_code, created_at,
    updated_at, completed_at,
    UNIQUE(environment, task_id, command_type, idempotency_key))
  ui_events(event_seq INTEGER PRIMARY KEY AUTOINCREMENT, environment, event_type,
    object_type, object_id, object_revision, created_at)
  ui_event_watermarks(environment PRIMARY KEY, low_watermark, high_watermark, updated_at)
  maintenance_leases(environment, lease_type, owner_id, generation, expires_at,
    PRIMARY KEY(environment, lease_type))
  ui_event_maintenance_state(environment PRIMARY KEY, last_attempt_at,
    last_success_at, last_failure_at, last_failure_code)
  evaluation_evidence(evaluation_id PK, environment, case_id, turn_id,
    evaluator_agent_key, subject_type, subject_id, result, round_key,
    detail_json, created_at)
  mutation_idempotency(environment, scope_type, scope_id, operation,
    idempotency_key, payload_hash, response_json, created_at, expires_at,
    PRIMARY KEY(environment, scope_type, scope_id, operation, idempotency_key))
  supervisor_instances(environment PRIMARY KEY, supervisor_instance_id,
    generation, state, heartbeat_at, started_at, exited_at)
  ```

  Add indexes for task updated time/lifecycle, command status/priority/available time, dispatch-claim expiry and UI event object/sequence.

- [ ] **Step 5: Implement migration 003 execution schema**

  Rebuild affected tables where SQLite cannot add constraints safely. Add `paused` to allowed Case semantics in Contract/domain, `provider_id` and `model_id` to `agent_sessions`, `generation`, `worker_instance_id` and `expires_at` to execution leases, and create:

  ```sql
  turn_journal_heads(turn_id PRIMARY KEY, revision, phase, invocation_id,
    owning_run_command_id, lease_generation, updated_at)
  turn_journal_events(journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id, case_id, revision, phase, invocation_id, request_hash,
    response_ref, detail_json, owning_run_command_id,
    worker_instance_id, lease_generation, created_at,
    UNIQUE(turn_id, revision))
  tool_action_attempts(attempt_id PK, action_id UNIQUE, idempotency_key UNIQUE, arguments_hash,
    outcome, result_ref, lease_generation, created_at,
    CHECK(length(arguments_hash) = 64))
  worker_instances(worker_instance_id PK, environment, case_id, command_id,
    pid, state, lease_generation, heartbeat_at, started_at, exited_at)
  ```

  Rebuild `turns` with `UNIQUE(case_id, sequence)`. Internal tool identity is stable from `turn_id + provider_tool_call_id`; the same identity with a different argument hash fails closed.

- [ ] **Step 6: Implement safe migration orchestration**

  After all old processes are proven stopped and before backup, run the shared fail-closed detector over the complete legacy data root: logical DB columns/JSON, raw DB pages/freelist, WAL/SHM, Pi JSONL, logs, backups, cache and runtime files. If a probable credential, Authorization/Cookie value or plaintext thinking is found—or any surface cannot be read safely—fail with `LEGACY_SECRET_DETECTED`, quarantine the old root outside the new active root, create no copied backup inside it and require a fresh data root or an explicit future forensic migration tool. Automatic migration never rewrites evidence to hide this finding.

  Preserve the existing production/test isolation: each environment owns `db/<environment>/active.json` and `db/<environment>/generations/<generation_id>/forge.sqlite`; one launcher/Web/Supervisor instance opens exactly one explicit environment, and `all` remains read-only CLI aggregation only. Generation IDs and directories are never reused, while the active SQLite contents remain writable.

  Before migration, stop every known child and use the platform process/handle probe to prove no Forge Worker, Pi Session writer or tool process still references that environment's data root; then acquire the environment migration lock. If absence cannot be proven, fail `MIGRATION_PROCESS_ACTIVE` and require the user to close Forge/reboot or use a fresh root—publishing while an old Worker may still call Provider/tools or write JSONL is forbidden. Under that condition: open the legacy/current generation → checkpoint WAL → acquire and continuously hold `BEGIN EXCLUSIVE` → create and verify a SQLite Backup API snapshot → migrate that snapshot into a new generation → verify it → atomically replace that environment's `active.json` containing generation ID, schema, DB identity and an `initial_image_sha256` migration-provenance hash → only then release the source barrier. Later starts validate generation, internal DB identity and Schema; they do not compare the initial-image hash after normal writes.

  A process test starts the full legacy Worker, including Pi JSONL and a synthetic tool side effect, and proves migration remains blocked until that process and its descendants exit. A separate legacy DB Writer with a `busy_timeout` longer than migration proves the SQLite barrier, but is not accepted as the complete process-safety proof. After publication, assert every new Writer resolves only its environment's pointer and never the other environment or an older generation. Unknown/tampered pointers, identities or generations fail `SCHEMA_INCOMPATIBLE`. If the chosen better-sqlite3 Backup API cannot be proven to preserve the source barrier, Task 2 is blocked until a tested native Backup adapter does; raw file copy is not accepted. Require free space `2 × DB size + 512 MiB`; on failure retain source and verified backup without publishing the new pointer.

- [ ] **Step 7: Introduce the only database bootstrap**

  `database-connection.ts` enables `foreign_keys=ON`, WAL and busy timeout on every writable connection; readonly connections verify schema without migrating. `DatabaseBootstrap` is the only constructor path and every Worker/CLI/Web/test call site is migrated in this same task. `SqliteRepository` no longer executes schema DDL or opportunistic `ALTER TABLE`.

  Task 2 adds `TransactionScopePort` to `packages/contracts/src/ports.ts`; its callback is synchronous (`run<T>(work: (tx: TransactionContext) => T): T`) because better-sqlite3 transactions must not span an `await`. `SqliteUnitOfWork` implements it, owns the single writable connection and passes an opaque branded transaction context into participating Adapter repositories. Application code never imports the SQLite type. A Repository method that participates in a cross-aggregate write requires that context and refuses another connection or nested implicit transaction. Tests deliberately combine two Repository instances from different connections and assert rejection before any row changes.

- [ ] **Step 8: Implement operational safety before first new persistent feature**

  `StructuredLogger` accepts only named fields and delegates every value to Task 1's `SecretSanitizer`; correlation fields are `request_id`, `task_id`, `command_id`, `case_id`, `worker_instance_id`, `turn_id`, `invocation_id`. Rotate at 14 days/100 MiB. `DiskSpaceGuard` blocks migration below `2 × DB + 512 MiB`, task start/import below `512 MiB`, and marks disk degraded below `1 GiB`. `BackupManager` retains 3 verified migration backups and never deletes the only recoverable backup. The Adapter exposes bounded metrics for schema, disk, backup count/latest verification, command lag, lease churn, sanitizer serialization failures and `outcome_unknown`; Task 8 turns them into the public Health Query.

- [ ] **Step 9: Run integration checks and commit**

  Run: `npx vitest run packages/adapters/src/migration-runner.test.ts packages/adapters/src/database-bootstrap.integration.test.ts packages/adapters/src/sqlite-unit-of-work.test.ts packages/adapters/src/backup-manager.test.ts packages/adapters/src/disk-space-guard.test.ts packages/adapters/src/structured-logger.test.ts packages/adapters/src/legacy-process-probe.integration.test.ts packages/adapters/src/sqlite-readonly-snapshot.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(adapters): add explicit Forge schema migrations`

### Task 3: 生产任务聚合、不可变模板修订与 CAS

**Files:**
- Create: `packages/domain/src/production-task-state.ts`
- Create: `packages/application/src/template-registry-service.ts`
- Create: `packages/application/src/progress-projector.ts`
- Create: `packages/adapters/src/template-cas.ts`
- Create: `packages/adapters/src/sqlite-task-repository.ts`
- Create: `packages/adapters/src/sqlite-template-repository.ts`
- Test: `packages/domain/src/production-task-state.test.ts`
- Test: `packages/application/src/template-registry-service.test.ts`
- Test: `packages/application/src/progress-projector.test.ts`
- Test: `packages/adapters/src/template-cas.test.ts`
- Modify: package index files.

**Interfaces:**
- Produces: `ProductionTaskState`, `TemplateRegistryService.registerBundle()`, immutable `TemplateRevision`, task draft CRUD.
- Consumes: migration v2 tables, existing scenario validation and bundle identity.

- [ ] **Step 1: Write failing state and CAS tests**

  Verify drafts can change, started tasks cannot; only unstarted drafts can enter trash; started tasks can archive; copying creates a new draft without Case/evidence. CAS tests reject absolute paths, `..`, symlink escape, ADS/device names on Windows, duplicate normalized paths and hash mismatch. Progress tests reject duplicate stage/step keys and unknown Agent/artifact references; map each allowed evidence selector to a discrete step state; apply the frozen priority order; create repeat rounds keyed by persisted Issue/revision/evaluation identity; and fall back only to non-prunable domain facts when `presentation.progress` is absent.

- [ ] **Step 2: Run focused tests**

  Run: `npx vitest run packages/domain/src/production-task-state.test.ts packages/application/src/template-registry-service.test.ts packages/application/src/progress-projector.test.ts packages/adapters/src/template-cas.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement CAS staging and immutable registration**

  Store bytes at `templates/objects/<sha256>` only after size/hash verification and atomic rename. Validate `presentation.progress` against the same frozen Scenario snapshot before saving revision metadata. Save revision metadata only after every object is durable. Re-importing the same Bundle hash returns the existing revision.

- [ ] **Step 4: Implement task draft revision rules**

  `saveDraft(taskId, snapshot, expectedRevision, idempotencyKey)` uses `mutation_idempotency` in the same transaction as the draft CAS. The scoped key stores canonical payload hash and bounded response; exact replay returns the stored response even after ACK loss, while a changed hash returns `IDEMPOTENCY_CONFLICT`. A revision mismatch returns `REVISION_CONFLICT` with the latest safe draft projection; no force overwrite endpoint exists. Retention never removes a key while a matching IndexedDB recovery record may still be retried; P0 keeps draft keys for at least 30 days.

- [ ] **Step 5: Verify and commit**

  Run: `npx vitest run packages/domain/src/production-task-state.test.ts packages/application/src/template-registry-service.test.ts packages/application/src/progress-projector.test.ts packages/adapters/src/template-cas.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(tasks): add production tasks and immutable templates`

### Task 4: Pi 模型目录与每 Agent 真实模型绑定

**Files:**
- Create: `packages/adapters/src/pi-model-catalog.ts`
- Create: `packages/adapters/src/sanitized-session-manager.ts`
- Create: `packages/adapters/src/sqlite-model-catalog-repository.ts`
- Create: `packages/application/src/model-catalog-service.ts`
- Test: `packages/application/src/model-catalog-service.test.ts`
- Test: `packages/adapters/src/pi-model-catalog.test.ts`
- Test: `packages/adapters/src/sqlite-model-catalog-repository.test.ts`
- Test: `packages/adapters/src/sanitized-session-manager.test.ts`
- Modify: `packages/contracts/src/ports.ts`
- Modify: `packages/adapters/src/pi-adapter.ts`
- Modify: `packages/adapters/src/pi-adapter.probe.test.ts`
- Modify: `packages/application/src/case-runner.ts`
- Modify: `apps/worker/src/main.ts`

**Interfaces:**
- Produces: `ModelCatalogPort.list()`, `ModelCatalogSnapshotPort`, `ModelCatalogService.getCatalog()/refresh()/validateSelections()`, `ModelValidationTicket`, `PiSessionOptions.model`, stable `invocation_id`.
- Consumes: Pi `ModelRuntime.getProviders/getModels/getAvailable`, task Agent model selections.

- [ ] **Step 1: Run the blocking Pi 0.82 Session sink-hook feasibility probe**

  Before catalog or binding implementation, instrument the real installed SDK and exercise message, Provider error, tool call/result, custom entry, branch summary, compaction and reopen paths against a sink spy. Prove production persistence can be routed through exactly one controllable serializer without plaintext thinking. This probe requires no Provider credential because entry fixtures are synthetic. If any SDK path bypasses the hook, stop Task 4 and G1 as technically blocked; do not build a partial wrapper.

- [ ] **Step 2: Write tests proving the current global-model behavior is rejected**

  Create two Agents with different Provider/Model selections; assert `createSession` receives each exact selection, resume receives the frozen original selection and selected-model fingerprint, unavailable or drifted models fail before Case creation/Session open, unrelated Provider changes do not block it, and no credential fields enter returned catalog DTO. `executeTurn` receives a persisted unique `invocation_id`; the same input hash under another invocation is not treated as the same call.

- [ ] **Step 3: Run tests and observe failure**

  Run: `npx vitest run packages/application/src/model-catalog-service.test.ts packages/adapters/src/pi-model-catalog.test.ts packages/adapters/src/pi-adapter.probe.test.ts`
  Expected: FAIL because `RealPiAdapter` still fixes Provider to `deepseek`.

- [ ] **Step 4: Extend the Pi port**

  Use:

  ```ts
  interface FrozenModelRef { provider_id: string; model_id: string }
  interface PiSessionOptions {
    scenarioId?: string;
    scenarioSkillsPath?: string;
    agentSkills?: string[];
    model: FrozenModelRef;
  }
  interface PiInvocation {
    invocation_id: string;
    request_hash: string;
  }
  ```

  Remove the global model fallback from session creation and resume. Missing model is a validation error, not a default.

- [ ] **Step 5: Implement catalog snapshot semantics**

  Startup/manual/TTL refreshes coalesce through one in-flight Promise. After external discovery succeeds, persist one sanitized immutable catalog snapshot through `TransactionScopePort`; a snapshot contains Provider/Model identity, normalized selected-model descriptors/capabilities and a map of non-sensitive provider/model-scoped fingerprints. Each scoped fingerprint covers that selection's endpoint/type/routing plus model compatibility fields, capabilities, context limits and descriptor version, never credentials or credential paths. `snapshot_sha256` covers canonical catalog content plus the fingerprint map; concurrent equal snapshot hashes converge to one row, while a changed scoped fingerprint creates a new snapshot. Failed refresh returns the last successful snapshot with `stale: true`.

  Task start and every Worker create/resume path call live validation outside any database transaction and never substitute a model. A successful validation returns a short-lived `ModelValidationTicket` containing `snapshot_id`, selection hash, catalog hash, the selected provider/model-scoped fingerprint, issued/expiry time and no credential. The frozen Agent row references that exact snapshot and scoped fingerprint. Immediately before opening a Pi Session, the Worker compares only that Agent's fresh scoped fingerprint with its frozen value; changes to unrelated Providers do not block it. Drift yields `MODEL_CONFIGURATION_DRIFT + waiting_recovery` before any model call.

- [ ] **Step 6: Implement and prove Pi Session storage is safe**

  Run thinking-capable synthetic responses, Provider errors, tool calls/results, custom entries, branch summaries and compaction through a persistent SessionManager and scan its JSONL. `SanitizedSessionManager` is the only session serialization sink: every SDK entry type passes Task 1's sanitizer and an explicit allowlist before append/replace/compaction, plaintext `thinking` is removed, only provider-required opaque signature metadata is retained, and unsupported entry types or sanitizer failure reject the write. No SDK path may write the production JSONL behind this adapter; prove this with a sink-spy test.

  Reopen the same logical Session and prove tool/result continuation plus compaction recovery works. If Pi offers no hook that covers every persistence path, or the selected Provider requires plaintext reasoning for continuation, the integration is P0-incompatible and G1 remains blocked; do not persist the raw block.

- [ ] **Step 7: Run a real non-content probe**

  With local Pi configuration available, list Provider/Model IDs and create then close one session without storing credentials. This probe may be skipped only when credentials are absent, and the later release gate remains blocked.

- [ ] **Step 8: Verify and commit**

  Run: `npx vitest run packages/application/src/model-catalog-service.test.ts packages/adapters/src/pi-model-catalog.test.ts packages/adapters/src/sqlite-model-catalog-repository.test.ts packages/adapters/src/sanitized-session-manager.test.ts packages/adapters/src/pi-adapter.probe.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(pi): bind exact model per Agent session`

### Task 5: 产物不变量、持久化命令、启动冻结与 outbox

**Files:**
- Create: `packages/domain/src/command-state.ts`
- Create: `packages/domain/src/artifact-version-selection.ts`
- Create: `packages/application/src/task-command-service.ts`
- Create: `packages/adapters/src/sqlite-command-repository.ts`
- Create: `packages/adapters/src/sqlite-event-repository.ts`
- Test: `packages/application/src/task-command-service.test.ts`
- Test: `packages/domain/src/artifact-version-selection.test.ts`
- Test: `packages/adapters/src/sqlite-command-race.test.ts`
- Test: `packages/adapters/src/sqlite-event-repository.test.ts`
- Modify: `packages/application/src/tool-executor.ts`
- Modify: package index files.

**Interfaces:**
- Produces: correct current-valid/latest/delivered write rules, `TaskCommandService`, command CAS/dispatch-claim methods, transactional `UiEvent`.
- Consumes: `TransactionScopePort`, task/template/model ports, short-lived `ModelValidationTicket` and existing CaseService.

- [ ] **Step 1: Write failing invariant, transaction and race tests**

  Cover candidate publication not moving the valid pointer, atomic approval/supersede, immutable delivery, duplicate start, same idempotency key/different payload, crash after command insert, two dispatch claimers racing, stale expected revision/status, duplicate human answer, repositories accidentally bound to different Unit-of-Work connections and `all` environment writes. Event tests prove every append and the selected environment's `high_watermark` advance in the same `TransactionScopePort` transaction; injected failure rolls both back.

- [ ] **Step 2: Run focused tests**

  Run: `npx vitest run packages/domain/src/artifact-version-selection.test.ts packages/application/src/task-command-service.test.ts packages/adapters/src/sqlite-command-race.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Fix artifact write semantics before enabling new execution**

  Publishing `draft/under_review` never changes `current_valid_version_id` or supersedes the old approved version. Approval updates the new version, old approved version, valid pointer and outbox in one transaction. Delivery moves the current approved version to `delivered` once.

- [ ] **Step 4: Implement two-phase atomic task start**

  Outside any DB transaction, live-validate all Agent selections and receive a `ModelValidationTicket`. Inside one short `TransactionScopePort.run`: CAS the latest draft revision → verify the ticket is unexpired and its `snapshot_id`/catalog/selection/scoped fingerprints match the persisted successful snapshot → freeze task → bind each Agent to that snapshot/fingerprint → create Case with frozen template/model evidence → bind task/Case → append `run_case` command → append UI events. Snapshot/ticket drift returns `STATE_CONFLICT`; the caller may obtain a new ticket and retry with the same user intent. No network/file I/O occurs in the transaction.

- [ ] **Step 5: Implement command result protocol**

  Short commands return `200`; asynchronous run/control commands return `202` with `{command_id,status}`. Duplicate keys return the original command. A duplicate key with a different canonical payload hash returns `IDEMPOTENCY_CONFLICT`.

  Freeze command states as `queued → dispatching → running → completed | failed | cancelled`. `dispatching` is a short Supervisor-only claim with owner/generation/deadline. The atomic Worker handoff clears dispatch fields and stores `worker_instance_id + execution_lease_generation`; from `running` onward the execution lease is the only liveness/write authority and command heartbeat fields are diagnostic only.

- [ ] **Step 6: Verify and commit**

  Run: `npx vitest run packages/domain/src/artifact-version-selection.test.ts packages/application/src/task-command-service.test.ts packages/adapters/src/sqlite-command-race.test.ts packages/adapters/src/sqlite-event-repository.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(application): enforce artifacts and persistent commands`

### Task 6: Turn Journal、租约写栅栏、工具幂等与恢复判定

**Files:**
- Create: `packages/domain/src/turn-journal-state.ts`
- Create: `packages/application/src/turn-journal-service.ts`
- Create: `packages/adapters/src/sqlite-turn-journal-repository.ts`
- Test: `packages/domain/src/turn-journal-state.test.ts`
- Test: `packages/application/src/turn-journal-service.test.ts`
- Modify: `packages/application/src/turn-executor.ts`
- Modify: `packages/application/src/recovery.ts`
- Modify: `packages/application/src/tool-executor.ts`
- Modify: `packages/contracts/src/case.ts`

**Interfaces:**
- Produces: journal phases `prepared | model_running | response_recorded | actions_applying | completed | failed | outcome_unknown`, journal head CAS, deterministic `RecoveryDecision`, mandatory lease fencing.
- Consumes: Pi port, execution lease generation, command/outbox repositories.

- [ ] **Step 1: Write failing phase and recovery tests**

  Cover every allowed/forbidden transition and crash windows: before Pi, during Pi, after response, after one tool effect, after Turn completion. Assert no SQLite write transaction spans the Pi `await`; two writers cannot advance one journal head; `UNIQUE(case_id,sequence)` prevents duplicate Turn; stale `worker_instance_id/lease_generation` gets `LEASE_LOST`.

- [ ] **Step 2: Write secret leakage fixtures**

  Reuse Task 1's sanitizer fixtures with Provider errors, tool arguments/results and diagnostic payloads. Assert every Journal/tool/DB write calls the shared sanitizer, DB/API-safe values contain explicit redaction markers and never the originals, and the isolated full data root including `sessions/`, backups and logs has no synthetic secret.

- [ ] **Step 3: Run focused tests**

  Run: `npx vitest run packages/domain/src/turn-journal-state.test.ts packages/application/src/turn-journal-service.test.ts packages/application/src/secret-sanitizer.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Replace the long transaction**

  Commit each phase by CAS on `turn_journal_heads.revision` through `TransactionScopePort`. The first prepared transaction freezes `owning_run_command_id` only after verifying that command has the same environment/task/Case, type `run_case | resume`, status `running`, and exact Worker/lease generation; later head/event/lease writes must match it. Add relational uniqueness/foreign-key or trigger constraints for the same command scope so application validation is not the only defense. Persist unique `invocation_id`, response/tool call identities and argument hashes before applying tools. Every Case/Turn/message/tool/artifact/Issue/revision/gate/evaluation/command write verifies the one current execution lease owner, generation and expiry in the same transaction. Structured evaluation tools append immutable `evaluation_evidence` with enum result `passed | failed | needs_revision | inconclusive`; related Issue/evaluation/outbox writes commit atomically. `action_id` itself is unique; `idempotency_key` is a separately unique alias. The same action or idempotency key with another argument hash fails closed; an already completed action returns its stored result. Internal domain effect, action completion and outbox append commit atomically.

  When a run reaches a terminal/safe-checkpoint result (`completed`, `failed`, `paused`, `stopped`, `waiting_human`, or `waiting_recovery`), the final Journal head, Case state, execution-lease release, exact `owning_run_command_id` completion and one UI outbox event commit in the same fenced transaction. Therefore a new “terminal Journal / pending run command” state cannot be produced. Legacy/injected inconsistent rows are repaired only by a separate reconciliation CAS over exact `owning_run_command_id + terminal journal revision + lease generation`, requiring no valid execution lease; it changes that command/outbox only and never invents business evidence.

  If Pi cannot confirm an in-flight invocation, append `outcome_unknown`, move the Case to `waiting_recovery`, and never call Pi again automatically.

- [ ] **Step 5: Implement paused Case semantics**

  Control commands are intents for a Case, not requests to spawn a second Worker. With an active Worker, that Worker atomically claims the highest-priority pending intent under its execution lease only after a completed Turn; ordering is `stop > pause > resume`, then creation order. It applies the control transition, completes the control command and—when exiting—completes the owning run command in the same fenced transaction. Pausing appends checkpoint evidence, sets `paused`, releases the lease and exits.

  With no valid Worker: `resume` may be handed to a new Worker only from a persisted safe checkpoint; `pause` on an already paused Case completes idempotently. A queued `stop` row already is the recovery dispatch unit—no second derived command is created. For a Journal target it stores `related_run_command_id`, `recovery_target_kind='journal'`, exact `recovery_for_turn_id + recovery_for_journal_revision + recovery_for_owning_run_command_id`; Supervisor may CAS that same stop command into `dispatching` only while the execution lease is absent/expired and all three links still match. The recovery Worker acquires the sole lease, rechecks all links, classifies the Journal, applies the safe terminal transition and atomically completes stop plus the exact related run command when appropriate.

  A stop before the first `prepared` event uses `recovery_target_kind='no_journal'` with Journal target fields null. Before handoff, it may complete only when the related run command is `queued | dispatching` and no execution lease or Journal exists; one CAS cancels the run command, completes stop and appends the event. After handoff, the stop freezes the related `running` command's exact `recovery_for_worker_instance_id + recovery_for_lease_generation`; it may dispatch a recovery Worker only after that exact lease is absent/expired and no Journal exists. The recovery Worker acquires the next sole lease, rechecks the frozen old binding and absence of Journal, then atomically stops the Case, completes stop and the related run command, and releases its lease. Tests cover stop before spawn, during pre-ready, after handoff but before first prepared, old-lease expiry, and the race where prepared wins; if a valid lease exists or Journal appears, the no-Journal CAS loses and the command is retargeted from a fresh authoritative read.

  An expired/ambiguous active Journal first converges to `waiting_recovery`; Supervisor never writes a business pause/stop result itself. Forced termination during a pause request converges to `waiting_recovery`, not `paused`. Tests cover simultaneous run/pause/stop, duplicate controls, a dead Worker followed by stop end-to-end, revision change during dispatch, Worker death before claim and Worker death after claim. Automatic recovery remains feature-disabled until Task 7's process ownership tests pass.

- [ ] **Step 6: Verify and commit**

  Run: `npx vitest run packages/domain/src/turn-journal-state.test.ts packages/application/src/turn-journal-service.test.ts packages/application/src/secret-sanitizer.test.ts packages/application/src/crash-recovery.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(recovery): add durable Turn journal`

### Task 7: Supervisor、独立 Case Worker、命令交接与安全关闭

**Files:**
- Create: `apps/supervisor/package.json`
- Create: `apps/supervisor/tsconfig.json`
- Create: `apps/supervisor/src/main.ts`
- Create: `packages/application/src/supervisor-service.ts`
- Create: `packages/adapters/src/process-host.ts`
- Create: `packages/adapters/src/local-worker-ipc.ts`
- Test: `packages/application/src/supervisor-service.test.ts`
- Test: `apps/supervisor/src/main.integration.test.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: root `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `SupervisorService.tick()`, Worker handshake/heartbeat/exit protocol, command ownership reconciliation, `npm run supervisor`.
- Consumes: Tasks 5–6 persistent commands, artifact invariants, fenced leases and Turn Journal.

- [ ] **Step 1: Write failing scheduling and ownership tests**

  Verify default concurrency 1, fenced per-environment Supervisor heartbeat/takeover, control priority over new runs, FIFO within priority, dispatch-claim expiry, no second Worker under a valid Case lease, Supervisor restart while a live Worker continues only through DB heartbeat, Worker completing its command while Supervisor is down, legacy terminal-Journal reconciliation and no PID-only process termination. Add explicit process windows for spawn throw, child ready timeout, ready message lost, transfer committed/ack lost, delayed first heartbeat, Supervisor death during handoff and a late old Worker after generation changed.

- [ ] **Step 2: Run the tests**

  Run: `npx vitest run packages/application/src/supervisor-service.test.ts apps/supervisor/src/main.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement atomic command-to-Worker handoff**

  Supervisor CAS-claims a command into `dispatching`, creates `worker_instance_id + one-time handoff_nonce` and spawns a child that initially has no lease, no generation and no write authority. After the child returns `ready(worker_instance_id, handoff_nonce)` before a fixed 10-second deadline, Supervisor uses one `TransactionScopePort` call to acquire the Case execution lease, increment its generation, bind command/Worker to that generation and clear the dispatch claim; only then does it send `lease_granted(generation)`. The Worker reads back and verifies the exact binding before its first business write.

  Spawn throw, pre-ready exit or deadline expiry marks that worker attempt abandoned and requeues the command without ever creating an execution lease. If transfer commits but `lease_granted` is lost, the child may recover only by reading its exact persisted worker/generation binding; a late child from an abandoned attempt has no binding and exits. From handoff onward the execution-lease CAS alone decides ownership. Command timestamps are best-effort diagnostics in the same transaction when possible; their absence/failure never grants or revokes authority. The Worker may finish its command while Supervisor is offline.

- [ ] **Step 4: Implement Supervisor loop and reconciliation**

  On startup, Supervisor CAS-claims the per-environment `supervisor_instances` row, increments generation and writes a 5-second heartbeat through a short fenced transaction; an old generation cannot renew or schedule. Each tick reaps children it actually spawned, observes all Worker liveness through persisted execution-lease heartbeats, claims eligible run/resume/recovery commands with CAS and starts at most the configured number of Workers. Pause/stop intents for an active Case are left for that Worker; when no Worker is valid, only Task 6's exact recovery-target rule may dispatch a recovery Worker. On Supervisor restart there is no parent-IPC takeover: a still-live Worker continues renewing DB lease and completing work; the new Supervisor merely refrains from spawning until the lease expires or the command closes. It expires abandoned dispatch attempts and runs terminal-Journal reconciliation only after proving no valid execution lease. Never start a second Worker while ownership can still be valid, and never use PID as identity or proof of death.

  Task 7 does not import the not-yet-created UI event service. It exposes only a generic 10-minute maintenance scheduling hook and the Task 2 maintenance-lease repository; Task 8 wires the concrete prune use case after that service exists. BFF routes never own maintenance.

- [ ] **Step 5: Refactor Worker CLI protocol**

  Pre-start Worker accepts only `--environment --case-id --command-id --worker-instance-id --handoff-endpoint --handoff-nonce --data-dir`; generation is forbidden on the process command line. It receives generation only from `lease_granted` or the exact persisted binding after an ack loss. It loads frozen task/Case evidence; it must not create a task or choose a model. A `LEASE_LOST` write result ends the Worker immediately.

- [ ] **Step 6: Implement draining**

  Draining stops new `run_case` claims, persists safe-pause commands for active Cases and waits for confirmed Turn boundaries. Timeout reports unresolved Cases; it never marks them paused or stopped without Worker evidence.

- [ ] **Step 7: Verify and commit**

  Run: `npx vitest run packages/application/src/supervisor-service.test.ts apps/supervisor/src/main.integration.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(worker): add fenced persistent command supervisor`

### Task 8: 权威 Query 投影与工作区图数据

**Files:**
- Create: `packages/application/src/task-query-service.ts`
- Create: `packages/application/src/agent-session-query-service.ts`
- Create: `packages/application/src/artifact-query-service.ts`
- Create: `packages/application/src/ui-event-service.ts`
- Create: `packages/application/src/health-query-service.ts`
- Create: `packages/adapters/src/sqlite-query-repository.ts`
- Create: `packages/adapters/src/sqlite-ui-event-repository.ts`
- Create: `packages/adapters/src/sqlite-health-metrics.ts`
- Test: `packages/application/src/task-query-service.test.ts`
- Test: `packages/application/src/agent-session-query-service.test.ts`
- Test: `packages/application/src/ui-event-service.test.ts`
- Test: `packages/application/src/health-query-service.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `apps/supervisor/src/main.ts`

**Interfaces:**
- Produces: `TaskListQuery.execute`, `TaskWorkspaceQuery.execute`, `AgentSessionDetailQuery.execute`, `ArtifactQuery.execute`, `UiEventService.getWindow/replay/prune`, `HealthQueryService.execute`.
- Consumes: consistent SQLite read snapshot and all authoritative records.

- [ ] **Step 1: Write projection tests from authoritative fixtures**

  Assert current valid/latest created/delivered are distinct; legal actions come from application rules; `TaskWorkspaceQuery` calls `ProgressProjector` with the frozen template presentation and persisted evidence; graph edges exist only for persisted message/route/artifact/Issue references; graph/session/history limits expose opaque cursors without splitting an edge from its referenced node; an unrelated Session/Turn/version/diff pair is rejected with `OBJECT_SCOPE_MISMATCH`.

- [ ] **Step 2: Add Agent session privacy tests**

  Assert the work area contains summaries only; opening a Session returns bounded sanitized business input/output and ordered tool cards; public reasoning is `null` when Pi did not supply an explicit public summary; Context Snapshot and hidden reasoning are absent. Artifact tests cover explicit same-scope `from/to`, oversized inline bodies, truncation and download metadata.

  Event tests freeze one independently increasing `event_seq` per environment database; production and test cursors are different opaque domains and are never compared. `low_watermark` means the greatest pruned sequence in that environment (`0` when none); replay returns rows `> after`, `after < low_watermark` yields `resync_required`, and prune plus watermark update commit atomically. Every event append advances that environment's `high_watermark` in the same business transaction, so a crash cannot leave a committed event above the stored high watermark.

  Health tests read only the selected environment's fenced `supervisor_instances` row and define `ready=false/status=unhealthy` for incompatible schema, active/failed migration, Supervisor heartbeat missing/not yet observed or `>=15s`, or free disk `<256 MiB`. Otherwise the process is ready; status is `degraded` for heartbeat `>=10s && <15s`, free disk `<1 GiB`, oldest queued command `>30s`, lease churn `>=3` in a rolling 10-minute window, sanitizer serialization failures in the last 10 minutes, active `outcome_unknown` Cases, or persisted `EVENT_PRUNE_FAILED` since the last successful prune. Successful prune atomically advances maintenance success and clears its failure reason; resolving the affected Case clears the outcome gauge; time-window metrics expire naturally. Migration-only backups have no age warning when no migration is pending; health reports count/latest verification, and a required backup failure makes migration unhealthy. Task-start remains independently blocked below `512 MiB`. Thresholds are configurable only through versioned local config and are echoed as reason codes, not raw diagnostics.

- [ ] **Step 3: Run focused tests**

  Run: `npx vitest run packages/application/src/task-query-service.test.ts packages/application/src/agent-session-query-service.test.ts packages/application/src/ui-event-service.test.ts packages/application/src/health-query-service.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement consistent read projections**

  Use one read transaction/snapshot per projection. Return opaque `projection_revision` for conditional Query caching and the selected environment's latest visible `source_event_seq` for SSE startup; they are different types and never substituted. `TaskWorkspaceQuery` invokes `ProgressProjector`, builds lane order from frozen template Agents, node order from persisted sequence/time and edges only from authoritative references.

  `UiEventService` owns replay, low/high-watermark and retention semantics through its port; `sqlite-ui-event-repository.ts` owns SQL and pruning. Task 8 wires the Supervisor's generic maintenance hook to `UiEventService.prune`: acquire the persisted per-environment maintenance lease, run once after startup recovery and every 10 minutes, retain events on failure, persist bounded attempt/success/failure state, and retry next interval. Retention deletes every event older than 7 days and then, if needed, the oldest excess rows so at most 100,000 remain; one transaction deletes rows and advances `low_watermark` to the greatest deleted sequence. `HealthQueryService` combines Adapter metrics into `HealthSnapshot`, includes the launcher's non-secret `instance_id` and `release_id`, and exposes no paths/raw errors.

- [ ] **Step 5: Verify and commit**

  Run: `npx vitest run packages/application/src/task-query-service.test.ts packages/application/src/agent-session-query-service.test.ts packages/application/src/ui-event-service.test.ts packages/application/src/health-query-service.test.ts packages/application/src/delivery-validator.test.ts && npm run check`
  Expected: PASS.
  Commit: `feat(query): project authoritative task workspace`

### Task 9: 类型化 Next.js BFF、SSE 与轮询降级

**Files:**
- Create: `apps/web/lib/application-container.ts`
- Create: `apps/web/lib/http.ts`
- Create: `apps/web/app/api/v1/tasks/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/draft/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/start/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/commands/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/human-requests/[actionId]/answer/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/workspace/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/sessions/[sessionId]/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/artifacts/[artifactId]/versions/[versionId]/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/artifacts/[artifactId]/versions/[versionId]/download/route.ts`
- Create: `apps/web/app/api/v1/tasks/[taskId]/artifacts/[artifactId]/diff/route.ts`
- Create: `apps/web/app/api/v1/templates/route.ts`
- Create: `apps/web/app/api/v1/models/route.ts`
- Create: `apps/web/app/api/v1/models/refresh/route.ts`
- Create: `apps/web/app/api/v1/events/route.ts`
- Create: `apps/web/app/api/v1/health/route.ts`
- Test: `apps/web/src/bff.integration.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/next.config.mjs`
- Delete after parity: old `apps/web/app/api/case/**`, `apps/web/app/api/template/**`, `apps/web/lib/db.ts`

**Interfaces:**
- Produces: the route table from Task 1 and SSE `id/event/data` frames.
- Consumes: application Query/Command services only.

- [ ] **Step 1: Write BFF integration tests**

  Validate request and response Contracts, status mapping (`200/201/202/304/400/404/409/413/422/503`), bounded artifact read/download/diff routes, no raw SQLite rows, no CLI spawn, duplicate idempotency behavior, object-scope rejection and `2 MiB` request-body rejection.

  The launcher passes the exact authority `127.0.0.1:<chosenPort>` into the Web process. Every `/api/v1/**` request, including GET, download and EventSource, must match that exact `Host`; reject `localhost`, DNS names, hostile/missing/mismatched Host and DNS-rebinding hostnames. Every mutation additionally requires exact same-origin `Origin` and `Content-Type: application/json`; reject hostile/missing Origin, cross-origin requests and CORS preflight. Minimal health contains only the bounded `HealthSnapshot` and still uses exact Host. These are local authority checks, not an account/auth system.

- [ ] **Step 2: Write SSE replay tests**

  Verify initial `?after=<workspace.source_event_seq>`, `Last-Event-ID`, both present with different values, independently increasing IDs per environment, empty stream, future cursor, environment isolation, paged replay, heartbeat, reconnect, concurrent pruning, below-low-watermark → typed reset, AbortSignal cleanup, bounded backpressure/connection count, `Cache-Control: no-store, no-transform`, and identity/version-only payloads. Test the client closes a rejected stream, reloads Workspace, and opens exactly one fresh stream instead of automatically retrying the rejected cursor. Workspace tests send `If-None-Match: "<projection_revision>"` and receive `304` only when that projection is unchanged.

- [ ] **Step 3: Run focused tests**

  Run: `npx vitest run apps/web/src/bff.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement the BFF adapter**

  Routes validate with shared TypeBox schemas, call one application use case, map stable errors and attach `request_id`. Artifact Diff requires explicit `from_version_id` and `to_version_id`; download uses attachment-safe filename and streams only the already-scoped immutable text version. No route imports better-sqlite3, CLI commands or Worker process APIs.

- [ ] **Step 5: Implement SSE**

  The client must first load Workspace and open the initial stream with that response's environment-scoped `source_event_seq`; a missing cursor is invalid except for an explicitly empty/new environment. On the first connection `?after` supplies the cursor. On EventSource reconnect, a valid `Last-Event-ID` is authoritative and the stale bootstrap query parameter is ignored; malformed header does not fall back. Replay batches at most 100 through `UiEventService`. IDs increase only within the selected environment database. `low_watermark` is that environment's greatest pruned ID; only `after < low_watermark` is stale, while `after > high_watermark` is ahead.

  Freeze the terminal protocol for stale, ahead or malformed cursors: send one typed `event: stream_reset` frame with bounded data `{reason: 'RESYNC_REQUIRED' | 'CURSOR_AHEAD' | 'INVALID_CURSOR'}` and then close the response. The browser handler must synchronously call `EventSource.close()`, invalidate and reload Workspace, and create exactly one new EventSource from the fresh `source_event_seq`; a per-reload circuit breaker prevents an automatic retry loop. A normal EventSource `error` without a reset frame uses bounded reconnect backoff and keeps its last accepted ID.

  Send a comment heartbeat every 15 seconds, apply Task 8's exact age-then-count retention algorithm, cap connections at 5 for the local instance, stop work on AbortSignal, and close slow clients instead of buffering beyond 256 KiB. Polling fallback requests the Workspace every 5 seconds with `If-None-Match: "<projection_revision>"`; `304` means unchanged. `projection_revision` is an opaque Query validator and is never sent as an event cursor.

- [ ] **Step 6: Remove old direct access after parity**

  Remove `better-sqlite3` from `apps/web/package.json`. Configure `output: 'standalone'`.
  `rg -n "from ['\\\"]better-sqlite3|from ['\\\"]node:child_process|apps/web/lib/db" apps/web/app apps/web/components apps/web/lib` must return no matches.

- [ ] **Step 7: Verify and commit**

  Run: `npx vitest run apps/web/src/bff.integration.test.ts && npm run check && npm --workspace @forge-ai/web run build`
  Expected: PASS.
  Commit: `feat(web): add typed Forge BFF and SSE`

### Task 10: 功能性 Web UI 主路径（暂不视觉打磨）

**Files:**
- Create: `apps/web/app/providers.tsx`
- Create: `apps/web/lib/api-client.ts`
- Create: `apps/web/lib/query-keys.ts`
- Create: `apps/web/lib/url-state.ts`
- Create: `apps/web/lib/draft-recovery-store.ts`
- Create: `apps/web/app/tasks/page.tsx`
- Create: `apps/web/app/tasks/new/page.tsx`
- Create: `apps/web/app/tasks/[taskId]/page.tsx`
- Create: `apps/web/app/templates/page.tsx`
- Create: `apps/web/components/task-list.tsx`
- Create: `apps/web/components/task-create-wizard.tsx`
- Create: `apps/web/components/task-workspace.tsx`
- Create: `apps/web/components/config-drawer.tsx`
- Create: `apps/web/components/agent-swimlanes.tsx`
- Create: `apps/web/components/artifact-drawer.tsx`
- Create: `apps/web/components/agent-session-dialog.tsx`
- Create: `apps/web/components/task-actions.tsx`
- Test: `apps/web/src/url-state.test.ts`
- Test: `apps/web/src/task-workspace.test.tsx`
- Test: `apps/web/src/draft-recovery-store.test.ts`
- Create: `vitest.web.config.ts`
- Modify: `apps/web/package.json`
- Replace: `apps/web/app/page.tsx`, `apps/web/app/globals.css`

**Interfaces:**
- Produces: `/tasks`, `/tasks/new`, `/tasks/[taskId]`, `/templates`.
- Consumes: BFF only through `api-client.ts`.

- [ ] **Step 1: Install only the frozen UI dependencies**

  Add TanStack Query, React Hook Form, Radix Dialog, Lucide and Testing Library. Implement drawers with the Radix Dialog primitive plus side-panel styling; Radix has no separate Drawer primitive. Do not add Redux/Zustand, React Flow, GraphQL, tRPC, Storybook or a second component framework. `vitest.web.config.ts` uses jsdom and includes `apps/web/src/**/*.test.ts(x)`.

- [ ] **Step 2: Write URL and component tests**

  Test direct open/refresh/back-forward for `agent`, `session`, `turn`, `artifact`, `version`, `compare`; invalid IDs produce local empty states. Test default left drawer closed/right drawer open at 1440, both overlay at 1024, Dialog focus return and historical selection protection during SSE updates.

- [ ] **Step 3: Run tests and observe failure**

  Run: `npx vitest run apps/web/src/url-state.test.ts apps/web/src/task-workspace.test.tsx`
  Expected: FAIL.

- [ ] **Step 4: Implement the create-and-run path**

  Three steps: template → input → configuration. Each document initialization generates a fresh in-memory `page_instance_id`/`writer_id`; it is never restored from cloneable `sessionStorage`. The page atomically claims that writer ID in IndexedDB and rotates on the impossible-but-tested collision, so duplicating a tab cannot share identity. Each writer maintains a monotonic per-task `sequence`. Before sending a complete snapshot, IndexedDB appends `{task_id, writer_id, sequence, base_revision, base_hash, content_hash, idempotency_key, payload_hash, snapshot}`. Retries and crash recovery reuse that exact key/payload pair until the server returns its stored exact response. Success may delete only entries for that same `task_id + writer_id` through the acknowledged sequence/key/hash; it never deletes another writer's records and never orders by wall-clock time.

  Reopen compares base revision/hash and offers recovery or fork, never auto-overwrites. Recovering a snapshot from an old writer requires explicit user selection and one IndexedDB transaction that tombstones the exact old `{task_id,writer_id,sequence,content_hash}` record and copies it into a new record owned by the current writer; it never silently adopts the old writer identity. After the server ACKs the current record's exact sequence/hash, one IndexedDB transaction deletes that current record, its adoption tombstone and only the exact old record referenced by the tombstone. Failure leaves all three retryable; a fork uses the same exact-reference cleanup rule.

  A `409` broadcasts `{task_id, conflict_revision, conflict_hash}` through `BroadcastChannel`; every tab marks that task conflicted and stops new writes until the user reloads server state or forks one selected local snapshot into a new draft. Cleanup after fork is writer-scoped and explicit. There is no force overwrite or field merge. Tests interleave two tabs, duplicate a tab, force a writer collision, reorder acknowledgements, recover/tombstone an old writer snapshot, crash between each adoption/ACK cleanup phase and broadcast simultaneous conflict. Start flushes save first and reuses one idempotency key per user intent.

- [ ] **Step 5: Implement the work area**

  Use CSS Grid and SVG paths without a graph framework. Agent columns run left-to-right; time runs top-to-bottom. Render only query-provided nodes and edges. Clicking a Turn writes `session`/`turn` to URL and lazily fetches the Agent Session Dialog. Clicking an artifact reference selects the right drawer object.

- [ ] **Step 6: Implement state-driven actions**

  Render only application `legal_actions`; `202` shows command accepted/queued, not completed. Human answers bind the exact action ID and preserve text on failure. Stop uses a confirmation Dialog; pause/recover do not.

- [ ] **Step 7: Verify functional UI and commit**

  Run: `npx vitest run --config vitest.web.config.ts apps/web/src/url-state.test.ts apps/web/src/task-workspace.test.tsx apps/web/src/draft-recovery-store.test.ts && npm --workspace @forge-ai/web run build`
  Expected: PASS.
  Commit: `feat(ui): implement Forge production workspace`

### Task 11: `forge ui` 本地启动器、配置与健康检查

**Files:**
- Create: `apps/launcher/package.json`
- Create: `apps/launcher/tsconfig.json`
- Create: `apps/launcher/src/main.ts`
- Create: `apps/launcher/src/package-layout.ts`
- Create: `apps/test-driver/package.json`
- Create: `apps/test-driver/tsconfig.json`
- Create: `apps/test-driver/src/main.ts`
- Create: `scripts/package-local.cjs`
- Create: `tsconfig.build.json`
- Create/Modify: each runtime workspace `tsconfig.build.json` and `package.json`
- Create: `packages/adapters/src/instance-lock.ts`
- Create: `packages/adapters/src/local-config.ts`
- Test: `apps/launcher/src/main.integration.test.ts`
- Test: `apps/launcher/src/standalone-smoke.integration.test.ts`
- Test: `packages/adapters/src/instance-lock.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: root `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `forge ui [--data-dir]`, `/api/v1/health`, single-instance and draining lifecycle.
- Consumes: migrations, Supervisor and Next standalone.

- [ ] **Step 1: Write lifecycle tests**

  Cover a clean start, existing healthy instance, stale lock with mismatched process identity, migration failure, port conflict, Supervisor health failure, readiness/degraded/unhealthy thresholds, health `instance_id` mismatch, first Ctrl+C draining and timeout with truthful unresolved Cases.

- [ ] **Step 2: Run tests**

  Run: `npx vitest run apps/launcher/src/main.integration.test.ts packages/adapters/src/instance-lock.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement startup order**

  Resolve/validate one explicit environment (`production` by default; `test` only for the isolated test driver) and its data root → create random non-secret `instance_id` and single-instance lock → disk/schema preflight → migrations → Supervisor → Next standalone on `127.0.0.1` → poll exact-authority health until it returns the same `instance_id + release_id` and `ready` → open browser. The normal launcher is statically wired to real Pi and rejects test environment injection, Fake Adapter and checkpoint flags. The lock records instance identity, PID, start time and port; a PID match alone is insufficient. Runtime port and IPC data live under `runtime/` and never become recovery facts.

  Add a real production pipeline:

  ```tex
  npm run build:runtime   # tsc -b tsconfig.build.json
  npm run build:web       # next build with output=standalone
  npm run package:local   # scripts/package-local.cjs
  npm run test:package
  ```

  Every runtime workspace emits `dist/**/*.js`, declarations and source maps from a dedicated build config; its production `exports`, `main` and `bin` point to `dist`, never `src`. `package:local` resolves the complete dependency closure for Launcher, isolated test driver, Supervisor and Worker from the exact lockfile—not only Next's trace—and copies every pure-JS dependency, Pi dynamic Provider asset and platform native module into staging alongside compiled workspace output, Next standalone/static/public and migrations. The normal launcher exports no test-driver module. The test-driver binary requires a fresh capability file bound to its temporary root; only it may inject Fake Pi/checkpoint IPC. Tests clear `NODE_PATH`, prepend no repository `node_modules`, and fail any module resolved outside staging.

  Build a canonical payload manifest containing the hash/mode/relative path of every payload file but excluding `release-manifest.json` itself. `release_id = sha256(canonical_payload_manifest)`. Then write `release-manifest.json` containing that payload plus `release_id`, atomically rename staging to `releases/<release_id>`, reopen it and recompute all payload hashes and the ID. The manifest never claims to hash itself; any extra/missing/changed file fails verification. Production start must not invoke `tsx`, resolve workspace source exports or read repository TypeScript/source paths.

- [ ] **Step 4: Implement safe close**

  Browser close changes nothing. First Ctrl+C drains; a second explicit interrupt exits the launcher but reports that incomplete Cases will be recovered from leases/journal. Never mark business state from process exit alone.

- [ ] **Step 5: Prove the packaged layout works without source**

  Copy the immutable release directory to a temporary path, make the repository source unavailable and verify the release manifest. First invoke the normal compiled launcher with the test capability and assert it rejects the capability/Fake/checkpoint controls before startup. Then invoke only the packaged `forge-test-driver` with a fresh temporary-root-bound capability, pass identity-bound health with `test_hooks_enabled=true`, create one Fake Pi task and shut down cleanly. Assert module resolution stays inside the release directory and native/Pi assets load from it. This is the Electron-compatible packaging boundary proof and produces the exact `release_dir + release_id` consumed by Tasks 12–13.

- [ ] **Step 6: Verify and commit**

  Run: `npm run build:runtime && npm run build:web && npm run package:local && npx vitest run apps/launcher/src/main.integration.test.ts apps/launcher/src/standalone-smoke.integration.test.ts packages/adapters/src/instance-lock.test.ts && npm run test:package && npm run check`
  Expected: PASS.
  Commit: `feat(cli): add unified local Forge UI launcher`

### Task 12: Fake Pi 浏览器 E2E 与七窗口进程故障矩阵

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/forge-ui-main-path.spec.ts`
- Create: `tests/e2e/forge-ui-reconnect.spec.ts`
- Create: `scripts/process-fault-matrix.cjs`
- Create: `tests/fixtures/p0-generic-scenario/**`
- Modify: root `package.json`

**Interfaces:**
- Produces: deterministic P0 browser proof and process-level recovery proof.
- Consumes: Task 11's immutable release directory; the complete launcher/BFF/Supervisor/Worker chain runs from that directory with only Pi replaced by Fake.

- [ ] **Step 1: Add a generic scenario fixture**

  Use neutral Agent/step/artifact names; include artifact publication, evaluation, repair, human request and delivery. No platform code may reference fixture names.

- [ ] **Step 2: Write browser E2E**

  Cover create draft, autosave, model selection, start, queue, SSE, Turn Dialog, current artifact, gate failure, human answer, pause/resume, stop, refresh and URL restoration. Do not intercept APIs or prewrite success rows.

- [ ] **Step 3: Write the seven-window process driver**

  The release contains two isolated compiled entry capabilities: the normal `forge-ui` entry is statically wired to the real Pi Adapter and rejects every Fake/checkpoint option; a non-exported `forge-test-driver` harness can inject Fake Pi and open test-only checkpoint IPC only when it receives a fresh capability file created in the temporary E2E root. The capability file is not accepted by the normal entry, is never copied into user data, and is deleted after the run. Adapter identity and `test_hooks_enabled` are exposed only in release-gate evidence/health reason metadata, not as user configuration.

  Start the copied immutable release through `forge-test-driver`, wait for explicit test-only IPC checkpoints, then terminate the actual Worker/Supervisor at every TD-022 window plus Task 7's spawn/handoff windows. Restart the same release with the same data root and assert Fake adapter identity, test hooks enabled only in the harness, original Case/Session/template/model snapshot/configuration fingerprint/invocation, legal state convergence, lease fencing and no duplicate Turn/message/artifact/Issue/revision/gate/evaluation/tool/event/command-completion.

- [ ] **Step 4: Run and fix until green**

  Run: `npm run test:e2e:ui && npm run test:e2e:faults`
  Expected: all P0 browser paths and all seven Fake Pi crash windows PASS.

- [ ] **Step 5: Run the full deterministic gate and commit**

  Run: `npm ci && npm test && npm run check && npm run test:e2e:ui && npm run test:e2e:faults`
  Expected: PASS.
  Scan the complete temporary data root (`db/`, WAL, `sessions/`, `templates/`, `logs/`, `backups/`, `runtime/`, `cache/`), captured HTTP/SSE, screenshots and IndexedDB fixtures for synthetic credentials and plaintext thinking. Assert health evidence includes command lag, lease churn, sanitizer hits and `outcome_unknown`.
  Commit: `test(e2e): prove Forge UI and crash recovery`

### Task 13: 真实 Pi 发布候选门禁

**Files:**
- Create: `scripts/release-realpi-e2e.cjs`
- Create: `scripts/write-release-evidence.cjs`
- Create: `docs/acceptance/README.md`
- Modify: root `package.json`

**Interfaces:**
- Produces: `npm run test:release:realpi` and a sanitized JSON/Markdown evidence report.
- Consumes: one locally configured Pi Provider/Model and the exact immutable `release_dir + release_id` produced and Fake-tested by Task 11/12; running from repository source is forbidden.

- [ ] **Step 1: Define evidence assertions**

  Verify `release-manifest.json` before launch and invoke only the normal `forge-ui` entry. Assert the health `release_id` equals that manifest, runtime adapter identity is exact real Pi `0.82.0`, `test_hooks_enabled=false`, and Fake/checkpoint flags are rejected; then assert exact frozen Provider/Model/snapshot/configuration fingerprint, original Case/Pi Session/template revision, tool behavior, state transitions, artifact/Issue/revision/gate identities, SSE resync and absence of duplicate side effects. Prove Pi dynamic Provider assets and native modules resolve inside the release directory. Never assert exact natural-language output.

- [ ] **Step 2: Implement three mandatory real-process kills**

  Kill Worker while Pi call is in flight; kill Worker after a nonterminal Turn transaction while the owning run command legitimately remains running; kill Supervisor while Worker continues, then restart Supervisor and prove the new Supervisor relies on DB lease heartbeat without IPC takeover. Separately inject a legacy terminal-Journal/pending-command row to test the exact reconciliation CAS—new runtime code must not be able to create that state. At every fault checkpoint assert the expected readiness/status/reason allowlist (temporary missing heartbeat may be unhealthy; a live Worker with restarted healthy Supervisor must recover), and after convergence require `ready=true`, `status=healthy` and no stale migration/prune/lease reason.

- [ ] **Step 3: Implement sanitized evidence output**

  Record commit, Node version, exact Pi versions, Schema version, template revision, Provider/Model IDs, invocation IDs, checkpoint names and assertion results. Scan the entire data root including Pi JSONL and backups, logs, captured HTTP/SSE and browser storage for credentials, headers and plaintext thinking; any match fails the gate.

- [ ] **Step 4: Run the release gate**

  Run: `npm run test:release:realpi`
  Expected: PASS with one timestamped report under `docs/acceptance/`; if local credentials are absent or any scenario fails, P0 remains explicitly unaccepted.

- [ ] **Step 5: Commit evidence tooling and the sanitized report**

  Commit: `test(release): add real Pi recovery gate`

### Task 14: P0 视觉实现与最终验收

**Files:**
- Create: `apps/web/styles/tokens.css`
- Create: `apps/web/components/*.module.css`
- Create: `tests/e2e/forge-ui-visual.spec.ts`
- Modify: `apps/web/app/globals.css`
- Modify: workspace components from Task 10.

**Interfaces:**
- Produces: approved warm editor visual direction at 1024/1280/1440/1920.
- Consumes: already verified real backend and UI semantics; no behavior changes.

- [ ] **Step 1: Write stable visual and accessibility assertions**

  Capture only stable shells/states. Assert keyboard navigation, visible focus, Dialog/Drawer focus behavior, semantic status text/icons and reduced-motion support.

- [ ] **Step 2: Implement semantic tokens**

  Define warm canvas, cream surfaces, charcoal text, coral accent, semantic success/warning/error/info, border, radius, shadow, spacing and motion variables. Components use variables, not scattered hard-coded colors.

- [ ] **Step 3: Implement wide-screen usage**

  At 1440/1920, app shell uses `width: calc(100vw - 32px)` with no narrow content max; right artifact panel uses its token width, central lanes consume remaining space, left config stays collapsed. At 1024–1279 both sides are overlay drawers.

- [ ] **Step 4: Run visual and full release checks**

  Run:

  ```tex
  npm tes
  npm run check
  npm run build:runtime
  npm run build:web
  npm run package:local
  npm run test:package
  npm run test:e2e:ui
  npm run test:e2e:faults
  npm run test:release:realpi
  ```

  Expected: all PASS against the one newly generated immutable `release_id`; visual screenshots cover 1024, 1280, 1440 and 1920 without unused side gutters or clipped Agent Dialog.

- [ ] **Step 5: Final truthful status update and commit**

  Update README only with commands and verified evidence links. Do not write “P0 complete” unless every command above passed on the same release candidate.
  Commit: `feat(ui): finish Forge UI P0 visual system`

---

## Dependency Gates

| Gate | Required before continuing | Blocks |
|---|---|---|
| G0 | Tasks 1–3 pass; legacy migration verified on a copy | Model/task runtime work |
| G1 | Task 4 proves exact per-Agent model binding and sanitized recoverable Pi Session storage | Task start and real recovery |
| G2 | Tasks 5–7 pass: artifact invariants, fenced Journal, command ownership and no long Pi transaction | Query/BFF/UI |
| G3 | Tasks 8–9 pass; Web has no direct SQLite/CLI writes | Functional UI |
| G4 | Tasks 10–12 pass on full Fake Pi process chain | Real Pi release gate |
| G5 | Task 13 passes with sanitized evidence | Visual polish and P0 completion claim |
| G6 | Task 14 full command set passes on one commit | P0 handoff |

## Explicitly Out of Scope

- Electron packaging, installer, signing, auto-update and desktop native APIs.
- Predefined workflow orchestration UI and free-form drag/drop workflow designer.
- Artifact editing or human-created revision versions.
- Authentication, roles, permissions, multi-user collaboration or LAN/remote exposure.
- Provider credential management in Forge.
- Notifications, mobile information architecture, Word/PDF conversion and batch packaging.
- P1 full historical cross-highlighting, advanced diagnostics, archive/recycle management and complete template version UX.

## Self-Review Resul

- Spec coverage: all P0 product slices map to Tasks 1–14; P1-only interaction depth remains explicitly out of scope.
- Placeholder scan: no unresolved implementation placeholder remains; commands, routes, errors, schema, transitions and release gates are named.
- Type consistency: `task_id`, `case_id`, `session_id`, `turn_id`, `invocation_id`, `artifact_id`, `version_id`, `command_id`, `event_seq`, `provider_id`, `model_id`, `worker_instance_id` and `lease_generation` remain stable across contracts, storage, BFF and UI.
- Architecture check: no planned Web direct DB/CLI path; all business rules stay in domain/application; Adapter code remains business-name agnostic.
- Truthfulness check: P0 completion is blocked by the real Pi report and process-level crash matrix, not by documentation or Fake Pi results.
