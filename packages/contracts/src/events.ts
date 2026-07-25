/**
 * ControlEvent、ContextSnapshot 类型定义
 */

export interface ControlEventRecord {
  event_id: string;
  case_id: string;
  event_type: string;
  actor: string | null;
  detail: string | null;
  created_at: string;
}

export interface ContextSnapshotRecord {
  context_snapshot_id: string;
  case_id: string;
  session_id: string | null;
  turn_id: string | null;
  included_refs: string | null; // JSON array
  rendered_context: string; // 实际发给 Pi 的完整上下文
  context_hash: string;
  created_at: string;
}
