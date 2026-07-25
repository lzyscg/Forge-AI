/**
 * 交付门禁（支柱二的灵魂）
 * 铁律 3：交付是系统的决定，不是 Agent 的声明。
 *
 * 5 项独立检查，任何一项不通过就拒绝交付：
 * 1. 申请交付的产物版本存在且状态有效
 * 2. 该产物所需的审核已通过（针对的是这一版）
 * 3. 所有 blocking 级 Issue 的状态都是 verified
 * 4. 没有运行中的返修（revision_instruction 处于未完成状态）
 * 5. 没有未完成的 Turn（非 completed）
 */

import type { GateCheckResult } from '@forge-ai/contracts';
import type { ArtifactVersionStatus } from '@forge-ai/contracts';
import type { IssueStatus } from '@forge-ai/contracts';
import type { RevisionInstructionStatus } from '@forge-ai/contracts';
import type { TurnStatus } from '@forge-ai/contracts';
import { isIssueBlockingDelivery } from './issue-state.js';
import { isRevisionInstructionActive } from './revision-instruction-state.js';

export interface DeliveryGateInput {
  artifactVersion: {
    status: ArtifactVersionStatus;
  } | null;
  artifactVersionApproved: boolean; // 该版本是否经过审核通过
  blockingIssues: { issueId: string; status: IssueStatus; severity: string }[];
  revisionInstructions: { id: string; status: RevisionInstructionStatus }[];
  incompleteTurns: { turnId: string; status: TurnStatus }[];
}

export interface DeliveryGateOutput {
  passed: boolean;
  checks: GateCheckResult[];
  blockingIssueIds: string[];
}

export function evaluateDeliveryGate(input: DeliveryGateInput): DeliveryGateOutput {
  const checks: GateCheckResult[] = [];
  const blockingIssueIds: string[] = [];

  // 检查 1：产物版本存在且状态有效
  const versionValid =
    input.artifactVersion !== null &&
    input.artifactVersion.status !== 'invalidated' &&
    input.artifactVersion.status !== 'superseded';
  checks.push({
    check: 'artifact_version_valid',
    passed: versionValid,
    detail: versionValid
      ? `产物版本状态为 ${input.artifactVersion!.status}，有效`
      : input.artifactVersion === null
        ? '未找到目标产物版本'
        : `产物版本状态为 ${input.artifactVersion.status}，无效`,
  });

  // 检查 2：该产物版本审核已通过
  checks.push({
    check: 'artifact_version_approved',
    passed: input.artifactVersionApproved,
    detail: input.artifactVersionApproved
      ? '该版本已通过审核'
      : '该版本尚未通过审核（approve 不继承自旧版）',
  });

  // 检查 3：所有 blocking 级 Issue 都是 verified
  const unresolvedBlocking = input.blockingIssues.filter((issue) =>
    isIssueBlockingDelivery(issue.status, issue.severity),
  );
  for (const issue of unresolvedBlocking) {
    blockingIssueIds.push(issue.issueId);
  }
  checks.push({
    check: 'all_blocking_issues_verified',
    passed: unresolvedBlocking.length === 0,
    detail:
      unresolvedBlocking.length === 0
        ? '所有 blocking 级 Issue 均已 verified'
        : `存在 ${unresolvedBlocking.length} 个未关闭的 blocking Issue: ${unresolvedBlocking.map((i) => `${i.issueId}(${i.status})`).join(', ')}`,
  });

  // 检查 4：没有运行中的返修
  const activeInstructions = input.revisionInstructions.filter((ri) =>
    isRevisionInstructionActive(ri.status),
  );
  checks.push({
    check: 'no_active_revision',
    passed: activeInstructions.length === 0,
    detail:
      activeInstructions.length === 0
        ? '没有运行中的返修指令'
        : `存在 ${activeInstructions.length} 个未完成的返修指令: ${activeInstructions.map((ri) => `${ri.id}(${ri.status})`).join(', ')}`,
  });

  // 检查 5：没有未完成的 Turn
  checks.push({
    check: 'no_incomplete_turns',
    passed: input.incompleteTurns.length === 0,
    detail:
      input.incompleteTurns.length === 0
        ? '所有 Turn 均已完成'
        : `存在 ${input.incompleteTurns.length} 个未完成的 Turn: ${input.incompleteTurns.map((t) => `${t.turnId}(${t.status})`).join(', ')}`,
  });

  const passed = checks.every((c) => c.passed);

  return { passed, checks, blockingIssueIds };
}
