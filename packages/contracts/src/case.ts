/**
 * Case、Turn、Message 类型定义
 */

export type CaseStatus =
  | 'created'
  | 'running'
  | 'waiting_review'
  | 'repairing'
  | 'waiting_recovery'
  | 'waiting_human'
  | 'approved'
  | 'stopped'
  | 'failed';

export interface CaseRunBinding {
  run_id: string | null;
  story_id: string | null;
  stage_key: string | null;
  chapter_id: string | null;
}

export interface CaseRecord {
  case_id: string;
  title: string;
  status: CaseStatus;
  current_stage: string;
  scenario_id: string | null;
  scenario_snapshot: string; // 整份配置快照 JSON
  input_payload: string; // 用户输入 JSON
  scenario_snapshot_sha256: string | null;
  input_payload_sha256: string | null;
  run_id: string | null;
  story_id: string | null;
  stage_key: string | null;
  chapter_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TurnRecord {
  turn_id: string;
  case_id: string;
  session_id: string;
  sequence: number;
  status: TurnStatus;
  input_message_id: string | null;
  output_message_id: string | null;
  context_snapshot_id: string | null;
  produced_artifact_version_ids: string; // JSON array
  started_at: string | null;
  finished_at: string | null;
  retry_of_turn_id: string | null;
  provider_error: string | null;
}

export type MessageType =
  | 'user_input'
  | 'agent_output'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'route';

export interface MessageRecord {
  message_id: string;
  case_id: string;
  session_id: string | null;
  source_agent: string | null;
  target_agent: string | null;
  parent_message_id: string | null;
  message_type: MessageType;
  content: string;
  artifact_version_refs: string | null; // JSON array
  issue_refs: string | null; // JSON array
  created_at: string;
}

export interface RouteEdgeRecord {
  route_id: string;
  case_id: string;
  source_message_id: string;
  target_message_id: string | null;
  source_agent: string;
  target_agent: string;
  reason: string | null;
  context_snapshot_id: string | null;
  created_at: string;
}

export interface AgentSessionRecord {
  session_id: string;
  case_id: string;
  agent_key: string;
  session_policy: 'persistent' | 'cold_per_version';
  scope_key: string | null;
  pi_session_ref: string | null;
  status: 'active' | 'closed';
  opened_at: string;
  closed_at: string | null;
}
