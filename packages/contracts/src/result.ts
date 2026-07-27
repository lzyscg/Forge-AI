/**
 * CLI / CaseRunner 运行结果 JSON schema（Round2 Feature 1）
 */
export interface ResultArtifact {
  type: string;
  version: number;
  status: string;
  content: string;
  artifact_id: string;
  version_id: string;
}

export interface ResultTurnItem {
  seq: number;
  agent: string;
  tools: string[];
  produced: string[];
}

export interface ResultIssue {
  id: string;
  severity: string;
  status: string;
  problem: string;
}

export interface ResultGateCheck {
  name: string;
  passed: boolean;
}

export interface ResultGate {
  status: 'pass' | 'fail';
  artifact_version_id: string;
  checks: ResultGateCheck[];
}

export interface ResultCaseIdentity {
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

export interface ResultExecutionIdentity {
  template_bundle_sha256: string;
  artifact_version_id: string;
}

export interface ResultLegacyCaseEvidence {
  scenario_id: string;
  scenario_snapshot_sha256: string;
  input_payload_sha256: string;
  created_at: string;
  protocol_identity_absent: true;
}

export interface ResultDiff {
  from_version: number;
  to_version: number;
  changed: number[];
  frozen: number[];
  violations: string[];
}

export interface ResultJson {
  case_id: string;
  status: string;
  success: boolean;
  final_artifact: ResultArtifact | null;
  case_identity: ResultCaseIdentity | null;
  execution_identity: ResultExecutionIdentity | null;
  legacy_case_evidence?: ResultLegacyCaseEvidence | null;
  turns: { count: number; items: ResultTurnItem[] };
  issues: ResultIssue[];
  gate: ResultGate | null;
  diff: ResultDiff | null;
  action_required: string | null;
  error: string | null;
}
