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
  checks: ResultGateCheck[];
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
  turns: { count: number; items: ResultTurnItem[] };
  issues: ResultIssue[];
  gate: ResultGate | null;
  diff: ResultDiff | null;
  action_required: string | null;
  error: string | null;
}
