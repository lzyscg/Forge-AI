/**
 * DeliveryGateResult 类型定义
 * 铁律 3：交付是系统的决定，不是 Agent 的声明。
 */

export interface DeliveryGateResultRecord {
  gate_result_id: string;
  case_id: string;
  artifact_version_id: string;
  status: 'pass' | 'fail';
  checks: string; // JSON: GateCheckResult[]
  blocking_issue_ids: string | null; // JSON array
  created_at: string;
}
