/**
 * 数据库访问层（只读）
 * 铁律 6：不返回 API Key 等敏感信息
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? resolve(process.cwd(), '../../data/forge.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export interface CaseRecord {
  case_id: string;
  title: string;
  status: string;
  scenario_id: string;
  created_at: string;
  updated_at: string;
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
  status: string;
  content_hash: string;
  diff: string | null;
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

export function getCases(): CaseRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all() as CaseRecord[];
}

export function getCase(caseId: string): CaseRecord | null {
  const db = getDb();
  return db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as CaseRecord | null;
}

export function getMessages(caseId: string): MessageRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as MessageRecord[];
}

export function getArtifactVersions(caseId: string): ArtifactVersionRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT av.* FROM artifact_versions av
    JOIN artifacts a ON av.artifact_id = a.artifact_id
    WHERE a.case_id = ?
    ORDER BY av.version ASC
  `).all(caseId) as ArtifactVersionRecord[];
}

export function getIssues(caseId: string): IssueRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM evaluation_issues WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as IssueRecord[];
}

export function getDeliveryGateResults(caseId: string): DeliveryGateResultRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM delivery_gate_results WHERE case_id = ? ORDER BY created_at DESC').all(caseId) as DeliveryGateResultRecord[];
}
