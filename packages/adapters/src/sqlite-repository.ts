/**
 * SQLite 持久化 Adapter
 * 启用 WAL 模式 + busy-timeout（worker 写、web 回放页轮询读会同时访问同一个数据库文件）
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { RepositoryPort } from '@forge-ai/contracts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL DEFAULT 'init',
  scenario_id TEXT,
  scenario_snapshot TEXT NOT NULL,
  input_payload TEXT NOT NULL,
  scenario_snapshot_sha256 TEXT,
  input_payload_sha256 TEXT,
  run_id TEXT,
  story_id TEXT,
  stage_key TEXT,
  chapter_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  session_policy TEXT NOT NULL,
  scope_key TEXT,
  pi_session_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_message_id TEXT,
  output_message_id TEXT,
  context_snapshot_id TEXT,
  produced_artifact_version_ids TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT,
  retry_of_turn_id TEXT,
  provider_error TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  session_id TEXT,
  source_agent TEXT,
  target_agent TEXT,
  parent_message_id TEXT,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  artifact_version_refs TEXT,
  issue_refs TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_edges (
  route_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  target_message_id TEXT,
  source_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  reason TEXT,
  context_snapshot_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  scope_key TEXT,
  current_valid_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_version_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  source_message_id TEXT,
  source_turn_id TEXT,
  parent_version_id TEXT,
  diff TEXT,
  content_hash TEXT NOT NULL,
  template_bundle_sha256 TEXT,
  status TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation_issues (
  issue_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  evaluation_message_id TEXT,
  severity TEXT NOT NULL,
  anchor TEXT,
  problem TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL,
  resolution_artifact_version_id TEXT,
  verified_by_evaluation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS issue_events (
  issue_event_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  message_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revision_instructions (
  revision_instruction_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  target_artifact_version_id TEXT,
  issue_ids TEXT NOT NULL DEFAULT '[]',
  editable_anchors TEXT NOT NULL DEFAULT '[]',
  frozen_anchors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  context_snapshot_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  included_refs TEXT,
  rendered_context TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_gate_results (
  gate_result_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  template_bundle_sha256 TEXT,
  status TEXT NOT NULL,
  checks TEXT NOT NULL,
  blocking_issue_ids TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_actions (
  action_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL,
  provider_tool_call_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS database_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  db_instance_id TEXT NOT NULL UNIQUE
);

-- 幂等键唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_actions_idempotent
  ON tool_actions(turn_id, provider_tool_call_id);

-- 常用查询索引
CREATE INDEX IF NOT EXISTS idx_turns_case ON turns(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_issues_case ON evaluation_issues(case_id);
CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);
CREATE INDEX IF NOT EXISTS idx_revision_instructions_case ON revision_instructions(case_id);
`;

export class SqliteRepository implements RepositoryPort {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // 启用 WAL 模式 + busy-timeout
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.migrateIdentitySchema();
  }

  close(): void {
    this.db.close();
  }

  // === 事务支持 ===
  beginTransaction(): void {
    this.db.exec('BEGIN');
  }

  commitTransaction(): void {
    this.db.exec('COMMIT');
  }

  rollbackTransaction(): void {
    this.db.exec('ROLLBACK');
  }

  runInTransaction<T>(fn: () => T): T {
    const transaction = this.db.transaction(() => fn());
    return transaction();
  }

  // === Cases ===
  getDbInstanceId(): string {
    const row = this.db.prepare(
      'SELECT db_instance_id FROM database_metadata WHERE singleton = 1',
    ).get() as { db_instance_id: string } | undefined;
    if (!row) throw new Error('Database identity metadata is missing');
    return row.db_instance_id;
  }

  insertCase(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO cases (
        case_id, title, status, current_stage, scenario_id,
        scenario_snapshot, input_payload, scenario_snapshot_sha256,
        input_payload_sha256, run_id, story_id, stage_key, chapter_id,
        created_at, updated_at, completed_at
      )
      VALUES (
        @case_id, @title, @status, @current_stage, @scenario_id,
        @scenario_snapshot, @input_payload, @scenario_snapshot_sha256,
        @input_payload_sha256, @run_id, @story_id, @stage_key, @chapter_id,
        @created_at, @updated_at, @completed_at
      )
    `).run({
      scenario_id: null,
      scenario_snapshot_sha256: null,
      input_payload_sha256: null,
      run_id: null,
      story_id: null,
      stage_key: null,
      chapter_id: null,
      ...record,
    });
  }

  updateCase(caseId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE cases SET ${sets} WHERE case_id = @case_id`).run({ ...fields, case_id: caseId });
  }

  getCase(caseId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as Record<string, unknown> | null;
  }

  getCasesByStatus(status: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM cases WHERE status = ?').all(status) as Record<string, unknown>[];
  }

  // === Turns ===
  insertTurn(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO turns (turn_id, case_id, session_id, sequence, status, input_message_id, output_message_id, context_snapshot_id, produced_artifact_version_ids, started_at, finished_at, retry_of_turn_id, provider_error)
      VALUES (@turn_id, @case_id, @session_id, @sequence, @status, @input_message_id, @output_message_id, @context_snapshot_id, @produced_artifact_version_ids, @started_at, @finished_at, @retry_of_turn_id, @provider_error)
    `).run(record);
  }

  updateTurn(turnId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE turns SET ${sets} WHERE turn_id = @turn_id`).run({ ...fields, turn_id: turnId });
  }

  getTurn(turnId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as Record<string, unknown> | null;
  }

  getTurnsByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM turns WHERE case_id = ? ORDER BY sequence').all(caseId) as Record<string, unknown>[];
  }

  getIncompleteTurns(caseId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM turns WHERE case_id = ? AND status NOT IN ('completed')").all(caseId) as Record<string, unknown>[];
  }

  getLastCompletedTurn(caseId: string): Record<string, unknown> | null {
    return this.db.prepare("SELECT * FROM turns WHERE case_id = ? AND status = 'completed' ORDER BY sequence DESC LIMIT 1").get(caseId) as Record<string, unknown> | null;
  }

  // === Messages ===
  insertMessage(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO messages (message_id, case_id, session_id, source_agent, target_agent, parent_message_id, message_type, content, artifact_version_refs, issue_refs, created_at)
      VALUES (@message_id, @case_id, @session_id, @source_agent, @target_agent, @parent_message_id, @message_type, @content, @artifact_version_refs, @issue_refs, @created_at)
    `).run(record);
  }

  getMessage(messageId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId) as Record<string, unknown> | null;
  }

  getMessagesByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  // === Sessions ===
  insertSession(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO agent_sessions (session_id, case_id, agent_key, session_policy, scope_key, pi_session_ref, status, opened_at, closed_at)
      VALUES (@session_id, @case_id, @agent_key, @session_policy, @scope_key, @pi_session_ref, @status, @opened_at, @closed_at)
    `).run(record);
  }

  updateSession(sessionId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE agent_sessions SET ${sets} WHERE session_id = @session_id`).run({ ...fields, session_id: sessionId });
  }

  getSession(sessionId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | null;
  }

  getActiveSession(caseId: string, agentKey: string, scopeKey?: string): Record<string, unknown> | null {
    if (scopeKey) {
      return this.db.prepare("SELECT * FROM agent_sessions WHERE case_id = ? AND agent_key = ? AND scope_key = ? AND status = 'active'").get(caseId, agentKey, scopeKey) as Record<string, unknown> | null;
    }
    return this.db.prepare("SELECT * FROM agent_sessions WHERE case_id = ? AND agent_key = ? AND status = 'active'").get(caseId, agentKey) as Record<string, unknown> | null;
  }

  closeSessionsByCase(caseId: string): void {
    this.db.prepare("UPDATE agent_sessions SET status = 'closed', closed_at = datetime('now') WHERE case_id = ?").run(caseId);
  }

  // === Artifacts ===
  insertArtifact(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO artifacts (artifact_id, case_id, artifact_type, scope_key, current_valid_version_id, status, created_at)
      VALUES (@artifact_id, @case_id, @artifact_type, @scope_key, @current_valid_version_id, @status, @created_at)
    `).run(record);
  }

  updateArtifact(artifactId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE artifacts SET ${sets} WHERE artifact_id = @artifact_id`).run({ ...fields, artifact_id: artifactId });
  }

  getArtifact(artifactId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as Record<string, unknown> | null;
  }

  getArtifactByTypeAndCase(caseId: string, artifactType: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM artifacts WHERE case_id = ? AND artifact_type = ?').get(caseId, artifactType) as Record<string, unknown> | null;
  }

  // === Artifact Versions ===
  insertArtifactVersion(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO artifact_versions (
        artifact_version_id, artifact_id, version, content, summary,
        source_message_id, source_turn_id, parent_version_id, diff, content_hash,
        template_bundle_sha256, status, approved_at, created_at
      )
      VALUES (
        @artifact_version_id, @artifact_id, @version, @content, @summary,
        @source_message_id, @source_turn_id, @parent_version_id, @diff, @content_hash,
        @template_bundle_sha256, @status, @approved_at, @created_at
      )
    `).run({ template_bundle_sha256: null, ...record });
  }

  updateArtifactVersion(versionId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE artifact_versions SET ${sets} WHERE artifact_version_id = @artifact_version_id`).run({ ...fields, artifact_version_id: versionId });
  }

  getArtifactVersion(versionId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_version_id = ?').get(versionId) as Record<string, unknown> | null;
  }

  getVersionsByArtifact(artifactId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version').all(artifactId) as Record<string, unknown>[];
  }

  getLatestVersion(artifactId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1').get(artifactId) as Record<string, unknown> | null;
  }

  getVersionByContentHash(artifactId: string, contentHash: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND content_hash = ?').get(artifactId, contentHash) as Record<string, unknown> | null;
  }

  // === Issues ===
  insertIssue(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO evaluation_issues (issue_id, case_id, artifact_version_id, evaluation_message_id, severity, anchor, problem, evidence, status, resolution_artifact_version_id, verified_by_evaluation_id, created_at, updated_at, closed_at)
      VALUES (@issue_id, @case_id, @artifact_version_id, @evaluation_message_id, @severity, @anchor, @problem, @evidence, @status, @resolution_artifact_version_id, @verified_by_evaluation_id, @created_at, @updated_at, @closed_at)
    `).run(record);
  }

  updateIssue(issueId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE evaluation_issues SET ${sets} WHERE issue_id = @issue_id`).run({ ...fields, issue_id: issueId });
  }

  getIssue(issueId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM evaluation_issues WHERE issue_id = ?').get(issueId) as Record<string, unknown> | null;
  }

  getIssuesByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM evaluation_issues WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  getBlockingIssuesByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM evaluation_issues WHERE case_id = ? AND severity = 'blocking'").all(caseId) as Record<string, unknown>[];
  }

  // === Issue Events ===
  insertIssueEvent(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO issue_events (issue_event_id, issue_id, event_type, actor, message_id, detail, created_at)
      VALUES (@issue_event_id, @issue_id, @event_type, @actor, @message_id, @detail, @created_at)
    `).run(record);
  }

  getIssueEvents(issueId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at').all(issueId) as Record<string, unknown>[];
  }

  // === Revision Instructions ===
  insertRevisionInstruction(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO revision_instructions (revision_instruction_id, case_id, target_agent, target_artifact_version_id, issue_ids, editable_anchors, frozen_anchors, status, source_message_id, created_at)
      VALUES (@revision_instruction_id, @case_id, @target_agent, @target_artifact_version_id, @issue_ids, @editable_anchors, @frozen_anchors, @status, @source_message_id, @created_at)
    `).run(record);
  }

  updateRevisionInstruction(id: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE revision_instructions SET ${sets} WHERE revision_instruction_id = @revision_instruction_id`).run({ ...fields, revision_instruction_id: id });
  }

  getRevisionInstruction(id: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM revision_instructions WHERE revision_instruction_id = ?').get(id) as Record<string, unknown> | null;
  }

  getActiveRevisionInstructions(caseId: string): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM revision_instructions WHERE case_id = ? AND status IN ('issued', 'in_progress', 'submitted')").all(caseId) as Record<string, unknown>[];
  }

  getRevisionInstructionsByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM revision_instructions WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  // === Context Snapshots ===
  insertContextSnapshot(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO context_snapshots (context_snapshot_id, case_id, session_id, turn_id, included_refs, rendered_context, context_hash, created_at)
      VALUES (@context_snapshot_id, @case_id, @session_id, @turn_id, @included_refs, @rendered_context, @context_hash, @created_at)
    `).run(record);
  }

  getContextSnapshot(id: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM context_snapshots WHERE context_snapshot_id = ?').get(id) as Record<string, unknown> | null;
  }

  // === Delivery Gate Results ===
  insertDeliveryGateResult(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO delivery_gate_results (
        gate_result_id, case_id, artifact_version_id, template_bundle_sha256,
        status, checks, blocking_issue_ids, created_at
      )
      VALUES (
        @gate_result_id, @case_id, @artifact_version_id, @template_bundle_sha256,
        @status, @checks, @blocking_issue_ids, @created_at
      )
    `).run({ template_bundle_sha256: null, ...record });
  }

  getDeliveryGateResults(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM delivery_gate_results WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  // === Tool Actions ===
  insertToolAction(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO tool_actions (action_id, turn_id, tool_name, arguments, result, status, provider_tool_call_id, created_at)
      VALUES (@action_id, @turn_id, @tool_name, @arguments, @result, @status, @provider_tool_call_id, @created_at)
    `).run(record);
  }

  updateToolAction(actionId: string, fields: Record<string, unknown>): void {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE tool_actions SET ${sets} WHERE action_id = @action_id`).run({ ...fields, action_id: actionId });
  }

  getToolActionByProviderId(turnId: string, providerToolCallId: string): Record<string, unknown> | null {
    return this.db.prepare('SELECT * FROM tool_actions WHERE turn_id = ? AND provider_tool_call_id = ?').get(turnId, providerToolCallId) as Record<string, unknown> | null;
  }

  getToolActionsByTurn(turnId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM tool_actions WHERE turn_id = ? ORDER BY created_at').all(turnId) as Record<string, unknown>[];
  }

  // === Route Edges ===
  insertRouteEdge(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO route_edges (route_id, case_id, source_message_id, target_message_id, source_agent, target_agent, reason, context_snapshot_id, created_at)
      VALUES (@route_id, @case_id, @source_message_id, @target_message_id, @source_agent, @target_agent, @reason, @context_snapshot_id, @created_at)
    `).run(record);
  }

  getRouteEdgesByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM route_edges WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  // === Control Events ===
  insertControlEvent(record: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO control_events (event_id, case_id, event_type, actor, detail, created_at)
      VALUES (@event_id, @case_id, @event_type, @actor, @detail, @created_at)
    `).run(record);
  }

  getControlEventsByCase(caseId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM control_events WHERE case_id = ? ORDER BY created_at').all(caseId) as Record<string, unknown>[];
  }

  private migrateIdentitySchema(): void {
    const addColumn = (table: string, column: string, declaration: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      }
    };

    const migrate = this.db.transaction(() => {
      addColumn('cases', 'scenario_id', 'TEXT');
      addColumn('cases', 'scenario_snapshot_sha256', 'TEXT');
      addColumn('cases', 'input_payload_sha256', 'TEXT');
      addColumn('cases', 'run_id', 'TEXT');
      addColumn('cases', 'story_id', 'TEXT');
      addColumn('cases', 'stage_key', 'TEXT');
      addColumn('cases', 'chapter_id', 'TEXT');
      addColumn('artifact_versions', 'template_bundle_sha256', 'TEXT');
      addColumn('delivery_gate_results', 'template_bundle_sha256', 'TEXT');
      this.db.prepare(`
        INSERT OR IGNORE INTO database_metadata (singleton, db_instance_id)
        VALUES (1, ?)
      `).run(randomUUID());
    });
    migrate();
  }
}
