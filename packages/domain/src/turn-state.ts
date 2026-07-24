/**
 * Turn 状态机
 * queued → running → completed
 * 异常：failed（可 retry_of_turn_id 指向被重试的 turn）
 */

import type { TurnStatus } from '@forge-ai/contracts';

const VALID_TRANSITIONS: Record<TurnStatus, TurnStatus[]> = {
  queued: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionTurn(from: TurnStatus, to: TurnStatus): TurnStatus {
  if (!canTransitionTurn(from, to)) {
    throw new Error(`Invalid turn state transition: ${from} → ${to}`);
  }
  return to;
}
