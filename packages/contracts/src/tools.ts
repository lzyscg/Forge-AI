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
  /** 5.2：机器可读错误码。NO_ACTIVE_INSTRUCTION / AMBIGUOUS_ACTIVE_INSTRUCTION
   * 表示无法确定唯一活跃返修指令，拒绝发布模糊归属的返修版本。 */
  error_code?: string;
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
  /** 5.1：机器可读错误码。PARTIAL_REVISION_INCOMPLETE 表示存在无法在本次
   * approve 中关闭的 submitted 指令（其关联 Issue 仍未 claimed_fixed/verified），
   * approve 不应产生半批准状态。 */
  error_code?: string;
  /** 5.1：无法关闭的 submitted 指令 ID 列表，便于定位。 */
  incomplete_instruction_ids?: string[];
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
  /** 5.3：机器可读错误码。INVALID_ISSUE_REFERENCE 表示 scope.issue_ids 中存在
   * 不合法的引用（不存在 / 不属于当前 Case / 状态不在 open|reopened）。
   * 此时不会写入 Revision Instruction，也不会改变任何 Issue 状态。 */
  error_code?: string;
  /** 5.3：不合法的 issue_id 列表。 */
  invalid_issue_ids?: string[];
  /** 5.2：当发布返修版本时无法确定唯一活跃指令（0 条或多于 1 条）时使用。 */
  ambiguous_instruction_ids?: string[];
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
  /** 5.6：true 表示系统对“Issue 已全 verified、指令仍 submitted”的生命周期不一致
   * 执行了一致性修复（把陈旧 submitted 指令关闭为 verified）。 */
  consistency_repaired?: boolean;
  /** 5.6：门禁失败时确定性路由提示。若设置，case-runner 应据此路由，而不是把
   * 门禁文本原样丢给 start agent。 */
  route_to?: string;
  route_reason?: string;
  /** 5.6：内部错误码。INTERNAL_STATE_INCONSISTENT 表示一致性修复后仍无法通过门禁。 */
  error_code?: string;
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
