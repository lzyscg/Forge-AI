/**
 * Issue 状态机（最关键）
 * open → repairing → claimed_fixed → verified
 *                         ↑              |
 *                     reopened ←─────────┘（复审又发现问题）
 *
 * 铁律 3：claimed_fixed 不能作为交付的关闭依据。只有 verified 才算关闭。
 */

import type { IssueStatus } from '@forge-ai/contracts';

const VALID_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ['repairing'],
  repairing: ['claimed_fixed'],
  claimed_fixed: ['verified', 'reopened'],
  verified: [],
  reopened: ['repairing'],
};

export function canTransitionIssue(from: IssueStatus, to: IssueStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionIssue(from: IssueStatus, to: IssueStatus): IssueStatus {
  if (!canTransitionIssue(from, to)) {
    throw new Error(`Invalid issue state transition: ${from} → ${to}`);
  }
  return to;
}

/**
 * 判断 Issue 是否已关闭（只有 verified 才算关闭）
 */
export function isIssueClosed(status: IssueStatus): boolean {
  return status === 'verified';
}

/**
 * 判断 Issue 是否阻断交付
 * blocking 级且非 verified 的 issue 阻断交付
 */
export function isIssueBlockingDelivery(status: IssueStatus, severity: string): boolean {
  return severity === 'blocking' && status !== 'verified';
}
