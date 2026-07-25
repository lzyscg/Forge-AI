import { describe, it, expect } from 'vitest';
import {
  canTransitionIssue,
  transitionIssue,
  isIssueClosed,
  isIssueBlockingDelivery,
} from './issue-state.js';

describe('Issue 状态机', () => {
  it('open → repairing 合法', () => {
    expect(canTransitionIssue('open', 'repairing')).toBe(true);
    expect(transitionIssue('open', 'repairing')).toBe('repairing');
  });

  it('repairing → claimed_fixed 合法', () => {
    expect(canTransitionIssue('repairing', 'claimed_fixed')).toBe(true);
  });

  it('claimed_fixed → verified 合法（复审通过）', () => {
    expect(canTransitionIssue('claimed_fixed', 'verified')).toBe(true);
  });

  it('claimed_fixed → reopened 合法（复审又发现问题）', () => {
    expect(canTransitionIssue('claimed_fixed', 'reopened')).toBe(true);
  });

  it('reopened → repairing 合法（重新进入返修循环）', () => {
    expect(canTransitionIssue('reopened', 'repairing')).toBe(true);
  });

  it('verified 是终态', () => {
    expect(canTransitionIssue('verified', 'open')).toBe(false);
    expect(canTransitionIssue('verified', 'reopened')).toBe(false);
  });

  it('open 不能直接到 claimed_fixed', () => {
    expect(canTransitionIssue('open', 'claimed_fixed')).toBe(false);
  });

  it('非法转换抛出异常', () => {
    expect(() => transitionIssue('open', 'verified')).toThrow();
  });

  describe('isIssueClosed', () => {
    it('只有 verified 算关闭', () => {
      expect(isIssueClosed('verified')).toBe(true);
      expect(isIssueClosed('open')).toBe(false);
      expect(isIssueClosed('repairing')).toBe(false);
      expect(isIssueClosed('claimed_fixed')).toBe(false);
      expect(isIssueClosed('reopened')).toBe(false);
    });

    it('claimed_fixed 不算关闭（铁律 3）', () => {
      expect(isIssueClosed('claimed_fixed')).toBe(false);
    });
  });

  describe('isIssueBlockingDelivery', () => {
    it('blocking + open 阻断交付', () => {
      expect(isIssueBlockingDelivery('open', 'blocking')).toBe(true);
    });

    it('blocking + repairing 阻断交付', () => {
      expect(isIssueBlockingDelivery('repairing', 'blocking')).toBe(true);
    });

    it('blocking + claimed_fixed 阻断交付（铁律 3：claimed_fixed 不能当关闭）', () => {
      expect(isIssueBlockingDelivery('claimed_fixed', 'blocking')).toBe(true);
    });

    it('blocking + reopened 阻断交付', () => {
      expect(isIssueBlockingDelivery('reopened', 'blocking')).toBe(true);
    });

    it('blocking + verified 不阻断交付', () => {
      expect(isIssueBlockingDelivery('verified', 'blocking')).toBe(false);
    });

    it('major + open 不阻断交付（只有 blocking 级阻断）', () => {
      expect(isIssueBlockingDelivery('open', 'major')).toBe(false);
    });

    it('minor + open 不阻断交付', () => {
      expect(isIssueBlockingDelivery('open', 'minor')).toBe(false);
    });
  });
});
