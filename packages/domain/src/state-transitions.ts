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
 * 一条 Revision Instruction 的纯数据引用（用于跨状态机判定）。
 * issueIds 为已解析的 Issue ID 列表（不再依赖 JSON 字符串）。
 */
export interface InstructionRef {
  id: string;
  status: RevisionInstructionStatus;
  issueIds: string[];
}

/**
 * submit_evaluation 决定 Issue 进入 verified（复审通过）
 *
 * 5.1 修复：审核通过时，必须在同一事务内关闭“所有”与当前 claimed_fixed Issue
 * 绑定的 submitted 指令——不再只关闭第一条。
 *
 * 判定规则：
 * - 所有 claimed_fixed Issue -> verified；
 * - 每条 submitted 指令，若其关联 Issue 全部“可视为已解决”
 *   （= 正在被验证的 claimed_fixed，或此前已 verified），则 -> verified；
 * - 若某条 submitted 指令存在 Issue 仍处于 repairing/open/reopened，
 *   它不会被这里关闭——调用方应先用 findUnresolvableSubmittedInstructions
 *   检测并返回结构化错误，避免出现半批准状态。
 *
 * 这样设计同时支持：
 * - 多轮返修产生多条 submitted 指令，approve 时一并关闭；
 * - 旧 bug 残留的“Issue 已 verified、指令仍 submitted”一致性问题在审核时自愈。
 */
export function applyEvaluationVerify(
  issueIds: string[],
  currentIssueStatuses: Map<string, IssueStatus>,
  instructions: InstructionRef[],
): CrossStateResult {
  const issueTransitions: CrossStateResult['issueTransitions'] = [];

  for (const issueId of issueIds) {
    const current = currentIssueStatuses.get(issueId);
    if (current && current === 'claimed_fixed') {
      const to = transitionIssue(current, 'verified');
      issueTransitions.push({ issueId, from: current, to });
    }
  }

  // 正在被验证的 Issue（claimed_fixed -> verified）+ 此前已 verified 的 Issue
  const resolvingIssueIds = new Set<string>();
  for (const t of issueTransitions) resolvingIssueIds.add(t.issueId);
  for (const [id, st] of currentIssueStatuses) {
    if (st === 'verified') resolvingIssueIds.add(id);
  }

  const instructionTransitions: CrossStateResult['instructionTransitions'] = [];
  for (const instr of instructions) {
    if (instr.status !== 'submitted') continue;
    if (instr.issueIds.length === 0) continue;
    const allResolved = instr.issueIds.every((id) => resolvingIssueIds.has(id));
    if (allResolved) {
      const to = transitionRevisionInstruction('submitted', 'verified');
      instructionTransitions.push({ instructionId: instr.id, from: 'submitted', to });
    }
  }

  return { issueTransitions, instructionTransitions };
}

/**
 * 检测无法在本次 approve 中关闭的 submitted 指令：
 * 即存在关联 Issue 既不是 claimed_fixed、也不是 verified（仍处于
 * repairing/open/reopened）。出现这种指令说明最新版本只解决了部分问题，
 * approve 不应产生半批准状态，调用方应返回结构化错误。
 */
export function findUnresolvableSubmittedInstructions(
  instructions: InstructionRef[],
  currentIssueStatuses: Map<string, IssueStatus>,
): string[] {
  const unresolvable: string[] = [];
  for (const instr of instructions) {
    if (instr.status !== 'submitted') continue;
    if (instr.issueIds.length === 0) continue;
    const allResolved = instr.issueIds.every((id) => {
      const st = currentIssueStatuses.get(id);
      return st === 'claimed_fixed' || st === 'verified';
    });
    if (!allResolved) unresolvable.push(instr.id);
  }
  return unresolvable;
}

/**
 * 检测"生命周期不一致"的 submitted 指令：
 * 即其全部关联 Issue 已 verified，但指令本身仍 submitted。
 * 这类指令可由系统一致性修复直接关闭（5.6），不应让 Agent 重新建返修。
 */
export function findStaleSubmittedInstructions(
  instructions: InstructionRef[],
  currentIssueStatuses: Map<string, IssueStatus>,
): string[] {
  const stale: string[] = [];
  for (const instr of instructions) {
    if (instr.status !== 'submitted') continue;
    if (instr.issueIds.length === 0) continue;
    const allVerified = instr.issueIds.every((id) => currentIssueStatuses.get(id) === 'verified');
    if (allVerified) stale.push(instr.id);
  }
  return stale;
}

/**
 * 检测"孤儿"活跃指令（issued/in_progress/submitted）：其所有 issue_id 都不是
 * "真实且未 verified 的 Issue"（即全为已 verified，或引用了不存在的 ID--如历史脏数据
 * 把 Revision Instruction ID 当 issue_id 写入）。这类指令无法导向有效返修，应被
 * 一致性修复关闭，否则它们会匹配版本、触发 AMBIGUOUS_ACTIVE_INSTRUCTION 或阻塞门禁。
 *
 * 比-findStaleSubmittedInstructions 更广：覆盖任意活跃状态 + 无效引用，用于恢复路径
 * 清理历史脏指令（验收 issue 1）。
 */
export function findOrphanedInstructions(
  instructions: InstructionRef[],
  currentIssueStatuses: Map<string, IssueStatus>,
): string[] {
  const orphaned: string[] = [];
  for (const instr of instructions) {
    if (instr.issueIds.length === 0) continue;
    // 存在任一"真实且未 verified"的 Issue -> 不是孤儿（还有有效返修工作）
    const hasRealOpenIssue = instr.issueIds.some((id) => {
      const st = currentIssueStatuses.get(id);
      return st !== undefined && st !== 'verified';
    });
    if (!hasRealOpenIssue) orphaned.push(instr.id);
  }
  return orphaned;
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
