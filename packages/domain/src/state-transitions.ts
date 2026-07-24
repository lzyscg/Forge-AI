/**
 * 跨状态机事件映射表
 * Issue 状态机与 Revision Instruction 状态机独立定义但必须保持同步。
 * 本模块定义触发规则，确保两台状态机联动正确。
 */

import type { IssueStatus, RevisionInstructionStatus } from '@forge-ai/contracts';
import { transitionIssue } from './issue-state.js';
import { transitionRevisionInstruction } from './revision-instruction-state.js';

export interface CrossStateEvent {
  type: 'route_message_with_issues' | 'publish_artifact_repair' | 'submit_evaluation_verify' | 'submit_evaluation_reopen';
}

export interface CrossStateResult {
  issueTransitions: { issueId: string; from: IssueStatus; to: IssueStatus }[];
  instructionTransitions: { instructionId: string; from: RevisionInstructionStatus; to: RevisionInstructionStatus }[];
}

/**
 * route_message 携带 issue_ids 时：
 * - 登记 Revision Instruction 为 issued
 * - 对应 Issue 移到 repairing
 */
export function applyRouteMessageWithIssues(
  issueIds: string[],
  currentIssueStatuses: Map<string, IssueStatus>,
  instructionId: string,
): CrossStateResult {
  const issueTransitions: CrossStateResult['issueTransitions'] = [];

  for (const issueId of issueIds) {
    const current = currentIssueStatuses.get(issueId);
    if (current && (current === 'open' || current === 'reopened')) {
      const to = transitionIssue(current, 'repairing');
      issueTransitions.push({ issueId, from: current, to });
    }
  }

  return {
    issueTransitions,
    instructionTransitions: [], // instruction 刚创建就是 issued，无需转换
  };
}

/**
 * 返修方对一个 in_progress 的 Revision Instruction 调用 publish_artifact 时：
 * - Issue 移到 claimed_fixed
 * - Instruction 移到 submitted
 */
export function applyPublishArtifactRepair(
  issueIds: string[],
  currentIssueStatuses: Map<string, IssueStatus>,
  instructionId: string,
  currentInstructionStatus: RevisionInstructionStatus,
): CrossStateResult {
  const issueTransitions: CrossStateResult['issueTransitions'] = [];

  for (const issueId of issueIds) {
    const current = currentIssueStatuses.get(issueId);
    if (current && current === 'repairing') {
      const to = transitionIssue(current, 'claimed_fixed');
      issueTransitions.push({ issueId, from: current, to });
    }
  }

  const instructionTransitions: CrossStateResult['instructionTransitions'] = [];
  // issued → in_progress → submitted（合并为一步：当返修方发布产物时，指令直接到 submitted）
  if (currentInstructionStatus === 'in_progress') {
    const to = transitionRevisionInstruction(currentInstructionStatus, 'submitted');
    instructionTransitions.push({ instructionId, from: currentInstructionStatus, to });
  } else if (currentInstructionStatus === 'issued') {
    // issued → in_progress → submitted
    instructionTransitions.push({ instructionId, from: 'issued', to: 'in_progress' });
    instructionTransitions.push({ instructionId, from: 'in_progress', to: 'submitted' });
  }

  return { issueTransitions, instructionTransitions };
}

/**
 * submit_evaluation 决定 Issue 进入 verified（复审通过）
 */
export function applyEvaluationVerify(
  issueIds: string[],
  currentIssueStatuses: Map<string, IssueStatus>,
  instructionId: string | null,
  currentInstructionStatus: RevisionInstructionStatus | null,
): CrossStateResult {
  const issueTransitions: CrossStateResult['issueTransitions'] = [];

  for (const issueId of issueIds) {
    const current = currentIssueStatuses.get(issueId);
    if (current && current === 'claimed_fixed') {
      const to = transitionIssue(current, 'verified');
      issueTransitions.push({ issueId, from: current, to });
    }
  }

  const instructionTransitions: CrossStateResult['instructionTransitions'] = [];
  if (instructionId && currentInstructionStatus === 'submitted') {
    const to = transitionRevisionInstruction(currentInstructionStatus, 'verified');
    instructionTransitions.push({ instructionId, from: currentInstructionStatus, to });
  }

  return { issueTransitions, instructionTransitions };
}

/**
 * submit_evaluation 决定 Issue 进入 reopened（复审又发现问题）
 */
export function applyEvaluationReopen(
  issueIds: string[],
  currentIssueStatuses: Map<string, IssueStatus>,
): CrossStateResult {
  const issueTransitions: CrossStateResult['issueTransitions'] = [];

  for (const issueId of issueIds) {
    const current = currentIssueStatuses.get(issueId);
    if (current && current === 'claimed_fixed') {
      const to = transitionIssue(current, 'reopened');
      issueTransitions.push({ issueId, from: current, to });
    }
  }

  return { issueTransitions, instructionTransitions: [] };
}
