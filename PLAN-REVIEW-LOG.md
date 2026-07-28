# Plan Review Log: Forge UI 产品化与本地运行链路重建
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Round 1 — Codex

The plan is not yet safe to implement. Material gaps remain:

1. **Loopback is not an authorization boundary.** Binding to `127.0.0.1` while omitting CSRF/source protection allows malicious websites or DNS rebinding to attempt local state-changing requests.  
   Fix: Require exact `Host`/`Origin` or Fetch-Metadata validation, JSON-only mutation requests, side-effect-free GETs, and reject cross-origin requests without inventing a user-account system.

2. **Migration quiescence is underspecified and race-prone.** A single-instance UI lock does not exclude detached or orphaned Workers already writing the database, so checkpoint, backup, or DDL can race them.  
   Fix: Before migration, verify both databases have no live Worker heartbeat/lease, drain authenticated Workers, close every connection, acquire an OS-level data-root lock, and abort rather than migrate if any writer cannot be disproved.

3. **Two-database upgrades can leave a split-version installation.** Production may migrate successfully and test fail, but the plan defines neither restoration nor whether a mixed-schema UI may start.  
   Fix: Preflight and back up both databases first, then require both to reach the target version or restore the first from its verified backup and refuse startup.

4. **Shared template CAS garbage collection has a cross-database race.** Production and test reference one shared CAS without cross-database foreign keys; a collector can declare an object orphaned while the other database is about to reference it.  
   Fix: Disable CAS deletion in P0, or introduce a global import/GC lock with mark generations and a second reference check immediately before deletion.

5. **Critical artifact invariants are only described at the application layer.** The current schema has no foreign keys, status checks, unique artifact version number, or database enforcement that `current_valid_version_id` belongs to the same Artifact and that only one version is delivered.  
   Fix: Rebuild the affected tables with foreign keys/checks plus partial unique indexes or guarded triggers, enable `PRAGMA foreign_keys`, and test concurrent approval attempts.

6. **Historical Turn compatibility remains an open risk instead of an executable migration rule.** Old incomplete Turns lack Journal phases, request hashes, action identities, and generations, so the new recovery code cannot safely infer whether Pi or a tool ran.  
   Fix: Persist an `execution_protocol_version`, keep completed legacy Cases read-only, and move every legacy incomplete Turn to an explicit fail-closed recovery state rather than attempting mixed-executor continuation.

7. **Tool idempotency identity is not defined strongly enough.** The current unique key `(turn_id, provider_tool_call_id)` permits multiple `NULL` values and assumes Pi call IDs survive replay or resume.  
   Fix: Persist a non-null deterministic action ordinal/identity before side effects, enforce a unique constraint on it, and prove ID stability across callback replay and Session recovery.

8. **Task startup puts external validation inside an allegedly atomic transaction.** Real-time Pi availability checks and template filesystem verification can block or fail outside SQLite’s control, recreating the long-transaction problem the Journal work is meant to remove.  
   Fix: Perform bounded external preflight first, capture catalog/template generations, then use a short transaction that CAS-validates those generations before freezing and enqueueing.

9. **The SSE contract is incomplete, especially for `all` across two databases.** No global-versus-per-environment cursor model, retention duration, heartbeat interval, batch limit, backpressure policy, or slow-client behavior is specified.  
   Fix: Define a composite `{environment, sequence}` cursor or a single authoritative event stream, plus fixed retention/cap, heartbeat, batching, replay-gap, and slow-consumer disconnect rules.

10. **Worker control secrets are likely to remain exposed through process environment.** The current Worker requires `FORGE_RUNNER_TOKEN` from its environment; “restricted IPC” and a stored hash do not address environment inspection, replay, or pipe impersonation.  
    Fix: Pass the raw secret through an inherited restricted handle/pipe, ACL runtime endpoints to the current user SID, and use nonce-bound challenge-response without placing secrets in argv, environment, files, or logs.

11. **SQLite backups do not restore the state required by the recovery claims.** The database backup excludes template CAS objects and Pi Session files, yet acceptance requires recovery with the original template and Session.  
    Fix: Explicitly label migration backups as database-only and add a separately verified recovery bundle/manifest covering DB, referenced CAS, configuration, and required Session material.

12. **Regression scope is materially too small.** The plan says to retain proof from “two scenarios,” but the repository ships seven scenario directories plus an external multi-Case story pipeline with recovery and invalidation rules.  
    Fix: Make every shipped scenario and the story-pipeline recovery/invalidation integration suite mandatory before-and-after migration gates.

13. **Required protocol decisions were never actually frozen in the plan.** API versioning, route table, error-code map, pagination semantics, sanitizer field classification, redaction placeholders, and historical-data handling are all deferred even though the technical requirements say the implementation plan must specify them.  
    Fix: Add explicit contract tables and acceptance tests for each protocol before schema or UI implementation begins.

14. **Operational observability is insufficient for the proposed recovery system.** There is no required correlation chain or alertable signal for stuck commands, expired leases, lock contention, SSE lag, redaction failure, or Worker/Supervisor disagreement.  
    Fix: Require structured correlation by environment, command, Case, Turn, Worker instance, and lease generation, with metrics/events for queue age, heartbeat age, lock waits, Pi latency, SSE lag, and sanitizer failure.

VERDICT: REVISE

### Claude's response

采纳第 2–10、12–14 项的核心问题，并修改 `PLAN.md`：

- 迁移前必须排空并证明不存在 writer；production/test 先共同预检和备份，任一失败则恢复并拒绝 split-version 启动。
- P0/P1 禁止 CAS 删除，避免跨库 GC race。
- Artifact 关键不变量下沉到 SQLite foreign key、CHECK、partial unique index/trigger。
- 增加 `execution_protocol_version`，legacy completed 只读，legacy incomplete fail closed。
- 工具幂等身份改为非空确定性 action identity，不再信任 nullable Provider call ID。
- 任务启动改为外部有界预检 + generation/revision CAS 短事务。
- 明确 per-environment SSE cursor、保留窗口、heartbeat、batch 和 backpressure。
- raw runner secret 改由受限 inherited pipe/handle 传递并执行 nonce challenge。
- 所有已发布 Scenario 与 story-pipeline 恢复/失效传播进入强制回归。
- 增加 `/api/v1` Route 家族、错误码、分页和脱敏基线。
- 增加本地结构化相关链及卡住命令、租约、锁、Pi、SSE 和脱敏失败诊断。

部分采纳第 11 项：明确 migration backup 只是数据库回滚，且迁移不修改 CAS/Session；不增加完整灾备 bundle，因为整机灾备是冻结范围外。

拒绝第 1 项中重新加入来源认证的建议：用户在 Act 1 明确拒绝额外 CSRF/权限复杂度。计划保留 loopback、同源、无 CORS、JSON-only mutation 和无副作用 GET，并明确接受残余风险，但不增加自定义 CSRF/Host/Origin/Fetch-Metadata 框架。

拒绝第 14 项中的远程告警扩张：个人本地工具只实现结构化本地健康与诊断，不建设监控/告警平台。
