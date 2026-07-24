/**
 * Issue、IssueEvent、RevisionInstruction 类型定义
 * 铁律 3：claimed_fixed 绝对不能当作 Issue 关闭，只有 verified 才算关闭。
 */

export type IssueSeverity = 'blocking' | 'major' | 'minor';

export type IssueStatus =
  | 'open'
  | 'repairing'
  | 'claimed_fixed'
  | 'verified'
  | 'reopened';

export interface IssueRecord {
  issue_id: string;
  case_id: string;
  artifact_version_id: string; // 被审的那一版
  evaluation_message_id: string | null;
  severity: IssueSeverity;
  anchor: string | null; // JSON: { type: "line", value: "4" }
  problem: string;
  evidence: string | null;
  status: IssueStatus;
  resolution_artifact_version_id: string | null; // 在哪一版被修
  verified_by_evaluation_id: string | null; // 被哪次复审验证
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueEventRecord {
  issue_event_id: string;
  issue_id: string;
  event_type: string;
  actor: string | null;
  message_id: string | null;
  detail: string | null;
  created_at: string;
}

export type RevisionInstructionStatus =
  | 'issued'
  | 'in_progress'
  | 'submitted'
  | 'verified'
  | 'scope_violation';

export interface RevisionInstructionRecord {
  revision_instruction_id: string;
  case_id: string;
  target_agent: string;
  target_artifact_version_id: string;
  issue_ids: string; // JSON array
  editable_anchors: string; // JSON array
  frozen_anchors: string; // JSON array
  status: RevisionInstructionStatus;
  source_message_id: string | null;
  created_at: string;
}
