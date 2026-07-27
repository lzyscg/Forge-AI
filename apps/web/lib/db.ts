/**
 * 数据库访问层（只读）
 * 铁律 6：不返回 API Key 等敏感信息
 *
 * 支持两库（生产/测试）+ all 聚合：
 * - getCases(env)：按 env 解析 1 或 2 个库路径，聚合 Case 列表，每条带 dbPath 来源标签。
 * - 详情函数（getCase/getTurns/...）：加 dbPath 参数，查指定库，不跨库 join。
 */

import Database from 'better-sqlite3';
import { resolveDbPaths, type DbEnv } from '@forge-ai/adapters/paths';
import { existsSync } from 'node:fs';

/** 解析 URL ?env= 参数为 DbEnv（非法值默认 production） */
export function parseEnvParam(env?: string): DbEnv {
  if (env === 'production' || env === 'test' || env === 'all') return env;
  return 'production';
}

/** 每个 DB 路径对应一个缓存的只读连接 */
const dbCache = new Map<string, Database.Database>();

function getDb(dbPath: string): Database.Database {
  let db = dbCache.get(dbPath);
  if (!db) {
    db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    dbCache.set(dbPath, db);
  }
  return db;
}

export interface CaseRecord {
  case_id: string;
  title: string;
  status: string;
  current_stage: string;
  scenario_snapshot: string;
  input_payload: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** 来源库绝对路径（聚合视图标明来自哪个库；详情查询用它定位库） */
  dbPath: string;
}

export interface MessageRecord {
  message_id: string;
  case_id: string;
  source_agent: string | null;
  target_agent: string | null;
  message_type: string;
  content: string;
  created_at: string;
}

export interface ArtifactVersionRecord {
  artifact_version_id: string;
  artifact_id: string;
  version: number;
  content: string;
  summary: string;
  parent_version_id: string | null;
  diff: string | null;
  content_hash: string;
  status: string;
  approved_at: string | null;
  created_at: string;
}

export interface IssueRecord {
  issue_id: string;
  case_id: string;
  severity: string;
  anchor: string;
  problem: string;
  evidence: string;
  status: string;
  resolution_artifact_version_id: string | null;
  verified_by_evaluation_id: string | null;
}

export interface DeliveryGateResultRecord {
  gate_result_id: string;
  case_id: string;
  artifact_version_id: string | null;
  status: string; // 'pass' | 'fail'
  checks: string;
  blocking_issue_ids: string | null;
  created_at: string;
}

/**
 * 列出 Case（env=all 时聚合两库，每条带 dbPath 标签；按 created_at 倒序）。
 * 跳过不存在的库文件（不创建空库）。
 */
export function getCases(env: DbEnv = 'production'): CaseRecord[] {
  const dbPaths = resolveDbPaths(env);
  const all: CaseRecord[] = [];
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const db = getDb(dbPath);
    const rows = db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all() as CaseRecord[];
    for (const r of rows) {
      r.dbPath = dbPath;
      all.push(r);
    }
  }
  all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return all;
}

/** 取单个 Case（从指定库读，不跨库） */
export function getCase(dbPath: string, caseId: string): CaseRecord | null {
  const db = getDb(dbPath);
  const r = db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as CaseRecord | null;
  if (r) r.dbPath = dbPath;
  return r;
}

export function getMessages(dbPath: string, caseId: string): MessageRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as MessageRecord[];
}

export function getArtifactVersions(dbPath: string, caseId: string): ArtifactVersionRecord[] {
  const db = getDb(dbPath);
  return db.prepare(`
    SELECT av.* FROM artifact_versions av
    JOIN artifacts a ON av.artifact_id = a.artifact_id
    WHERE a.case_id = ?
    ORDER BY av.version ASC
  `).all(caseId) as ArtifactVersionRecord[];
}

export function getIssues(dbPath: string, caseId: string): IssueRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM evaluation_issues WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as IssueRecord[];
}

export function getDeliveryGateResults(dbPath: string, caseId: string): DeliveryGateResultRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM delivery_gate_results WHERE case_id = ? ORDER BY created_at DESC').all(caseId) as DeliveryGateResultRecord[];
}

export interface TurnRecord {
  turn_id: string;
  case_id: string;
  sequence: number;
  status: string;
  session_id: string;
  agent_key: string;
  session_policy: string;
  input_message_id: string | null;
  output_message_id: string | null;
  produced_artifact_version_ids: string; // JSON array
  started_at: string | null;
  finished_at: string | null;
  provider_error: string | null;
}

export function getTurns(dbPath: string, caseId: string): TurnRecord[] {
  const db = getDb(dbPath);
  return db.prepare(`
    SELECT t.turn_id, t.case_id, t.sequence, t.status, t.session_id,
           t.input_message_id, t.output_message_id, t.produced_artifact_version_ids,
           t.started_at, t.finished_at, t.provider_error,
           s.agent_key, s.session_policy
    FROM turns t
    JOIN agent_sessions s ON t.session_id = s.session_id
    WHERE t.case_id = ?
    ORDER BY t.sequence ASC
  `).all(caseId) as TurnRecord[];
}

export interface RouteEdgeRecord {
  route_id: string;
  case_id: string;
  source_message_id: string;
  target_message_id: string | null;
  source_agent: string;
  target_agent: string;
  reason: string | null;
  created_at: string;
}

export function getRouteEdges(dbPath: string, caseId: string): RouteEdgeRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM route_edges WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as RouteEdgeRecord[];
}

export interface ToolActionRecord {
  action_id: string;
  turn_id: string;
  tool_name: string;
  arguments: string; // JSON
  result: string | null; // JSON
  status: string;
  created_at: string;
}

export function getToolActions(dbPath: string, caseId: string): ToolActionRecord[] {
  const db = getDb(dbPath);
  return db.prepare(`
    SELECT ta.action_id, ta.turn_id, ta.tool_name, ta.arguments, ta.result, ta.status, ta.created_at
    FROM tool_actions ta
    WHERE ta.turn_id IN (SELECT turn_id FROM turns WHERE case_id = ?)
    ORDER BY ta.created_at ASC
  `).all(caseId) as ToolActionRecord[];
}

export interface RevisionInstructionRecord {
  revision_instruction_id: string;
  case_id: string;
  target_agent: string;
  target_artifact_version_id: string | null;
  issue_ids: string; // JSON array
  editable_anchors: string; // JSON array of "line:N"
  frozen_anchors: string; // JSON array of "line:N"
  status: string;
  source_message_id: string | null;
  created_at: string;
}

export function getRevisionInstructions(dbPath: string, caseId: string): RevisionInstructionRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM revision_instructions WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as RevisionInstructionRecord[];
}

export interface ContextSnapshotRecord {
  context_snapshot_id: string;
  case_id: string;
  session_id: string | null;
  turn_id: string | null;
  included_refs: string | null;
  rendered_context: string;
  context_hash: string;
  created_at: string;
}

export function getContextSnapshots(dbPath: string, caseId: string): ContextSnapshotRecord[] {
  const db = getDb(dbPath);
  return db.prepare('SELECT * FROM context_snapshots WHERE case_id = ?').all(caseId) as ContextSnapshotRecord[];
}
