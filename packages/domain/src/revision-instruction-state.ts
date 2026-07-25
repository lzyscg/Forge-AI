/**
 * Revision Instruction 状态机
 * issued → in_progress → submitted → (verified | scope_violation)
 * scope_violation：返修改动越出了 editable 范围，系统拒绝该版本进入复审。
 */

import type { RevisionInstructionStatus } from '@forge-ai/contracts';

const VALID_TRANSITIONS: Record<RevisionInstructionStatus, RevisionInstructionStatus[]> = {
  issued: ['in_progress'],
  in_progress: ['submitted'],
  submitted: ['verified', 'scope_violation'],
  verified: [],
  scope_violation: [],
};

export function canTransitionRevisionInstruction(
  from: RevisionInstructionStatus,
  to: RevisionInstructionStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionRevisionInstruction(
  from: RevisionInstructionStatus,
  to: RevisionInstructionStatus,
): RevisionInstructionStatus {
  if (!canTransitionRevisionInstruction(from, to)) {
    throw new Error(`Invalid revision instruction state transition: ${from} → ${to}`);
  }
  return to;
}

/**
 * 判断返修指令是否处于未完成状态（阻断交付）
 */
export function isRevisionInstructionActive(status: RevisionInstructionStatus): boolean {
  return status === 'issued' || status === 'in_progress' || status === 'submitted';
}
