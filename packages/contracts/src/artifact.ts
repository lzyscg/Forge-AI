/**
 * Artifact、ArtifactVersion 类型定义
 * 铁律 4：一切追加，绝不覆盖。产物新版本追加，不覆盖旧版本。
 */

export type ArtifactVersionStatus =
  | 'draft'
  | 'under_review'
  | 'approved'
  | 'delivered'
  | 'invalidated'
  | 'superseded'
  | 'rejected';

export interface ArtifactRecord {
  artifact_id: string;
  case_id: string;
  artifact_type: string;
  scope_key: string | null;
  current_valid_version_id: string | null;
  status: string;
  created_at: string;
}

export interface ArtifactVersionRecord {
  artifact_version_id: string;
  artifact_id: string;
  version: number;
  content: string;
  summary: string | null;
  source_message_id: string | null;
  source_turn_id: string | null;
  parent_version_id: string | null;
  diff: string | null; // 行级 Diff JSON
  content_hash: string;
  status: ArtifactVersionStatus;
  approved_at: string | null;
  created_at: string;
}
