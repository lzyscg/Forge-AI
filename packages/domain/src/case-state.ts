/**
 * Case 状态机
 * created → running → (waiting_review | repairing | waiting_recovery | waiting_human) → approved
 * 异常：stopped、failed
 */

import type { CaseStatus } from '@forge-ai/contracts';

const VALID_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  created: ['running', 'failed', 'stopped'],
  running: ['waiting_review', 'repairing', 'waiting_recovery', 'waiting_human', 'approved', 'failed', 'stopped'],
  waiting_review: ['running', 'repairing', 'waiting_human', 'approved', 'failed', 'stopped'],
  repairing: ['running', 'waiting_review', 'waiting_human', 'failed', 'stopped'],
  waiting_recovery: ['running', 'failed', 'stopped'],
  waiting_human: ['running', 'failed', 'stopped'],
  approved: [],
  stopped: [],
  failed: [],
};

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionCase(from: CaseStatus, to: CaseStatus): CaseStatus {
  if (!canTransitionCase(from, to)) {
    throw new Error(`Invalid case state transition: ${from} → ${to}`);
  }
  return to;
}
