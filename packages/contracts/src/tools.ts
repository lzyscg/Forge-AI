/**
 * 4 个工具的输入/输出类型 + request_human_input
 * 铁律 2：模型不碰工程数据。工具参数只保留最必要的字段，其余由系统补齐。
 */

// === publish_artifact ===
export interface PublishArtifactInput {
  artifact_type: string;
  content: string;
  summary: string;
}

export interface PublishArtifactOutput {
  success: boolean;
  artifact_version_id?: string;
  version?: number;
  error?: string;
}

// === submit_evaluation ===
export type EvaluationVerdict = 'approve' | 'repair' | 'regenerate' | 'input_problem';

export interface EvaluationIssue {
  severity: 'blocking' | 'major' | 'minor';
  anchor: { type: string; value: string };
  problem: string;
  evidence: string;
}

export interface SubmitEvaluationInput {
  verdict: EvaluationVerdict;
  issues: EvaluationIssue[];
  summary: string;
}

export interface SubmitEvaluationOutput {
  success: boolean;
  issue_ids?: string[];
  error?: string;
}

// === route_message ===
export interface RouteScope {
  editable_anchors?: string[];
  frozen_anchors?: string[];
  issue_ids?: string[];
}

export interface RouteMessageInput {
  target_agent: string;
  instruction: string;
  scope?: RouteScope;
  reason?: string;
}

export interface RouteMessageOutput {
  success: boolean;
  revision_instruction_id?: string;
  error?: string;
}

// === approve_delivery ===
// 注意（PLAN.md 修正）：Agent 只传 artifact_type，系统自动定位版本
export interface ApproveDeliveryInput {
  artifact_type?: string;
  summary: string;
}

export interface ApproveDeliveryOutput {
  success: boolean;
  gate_result_id?: string;
  gate_passed?: boolean;
  checks?: GateCheckResult[];
  error?: string;
}

export interface GateCheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

// === request_human_input ===
export interface RequestHumanInputInput {
  reason: string;
  question?: string;
}

export interface RequestHumanInputOutput {
  success: boolean;
  message?: string;
}

// === 工具调用通用包装 ===
export type ToolName =
  | 'publish_artifact'
  | 'submit_evaluation'
  | 'route_message'
  | 'approve_delivery'
  | 'request_human_input';

export interface ToolCallRecord {
  action_id: string;
  turn_id: string;
  tool_name: ToolName;
  arguments: string; // JSON
  result: string | null; // JSON
  status: 'pending' | 'completed' | 'failed';
  provider_tool_call_id: string | null; // 幂等键
  created_at: string;
}
