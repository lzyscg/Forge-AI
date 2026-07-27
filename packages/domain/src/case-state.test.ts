import { describe, it, expect } from 'vitest';
import { canTransitionCase, transitionCase } from './case-state.js';

describe('Case 状态机', () => {
  it('created → running 合法', () => {
    expect(canTransitionCase('created', 'running')).toBe(true);
    expect(transitionCase('created', 'running')).toBe('running');
  });

  it('running → waiting_review 合法', () => {
    expect(canTransitionCase('running', 'waiting_review')).toBe(true);
  });

  it('running → repairing 合法', () => {
    expect(canTransitionCase('running', 'repairing')).toBe(true);
  });

  it('running → waiting_recovery 合法', () => {
    expect(canTransitionCase('running', 'waiting_recovery')).toBe(true);
  });

  it('running → waiting_human 合法', () => {
    expect(canTransitionCase('running', 'waiting_human')).toBe(true);
  });

  it('waiting_review → waiting_human 合法', () => {
    expect(canTransitionCase('waiting_review', 'waiting_human')).toBe(true);
  });

  it('repairing → waiting_human 合法', () => {
    expect(canTransitionCase('repairing', 'waiting_human')).toBe(true);
  });

  it('running → approved 合法', () => {
    expect(canTransitionCase('running', 'approved')).toBe(true);
  });

  it('waiting_recovery → running 合法（崩溃恢复后续跑）', () => {
    expect(canTransitionCase('waiting_recovery', 'running')).toBe(true);
  });

  it('waiting_human → running 合法', () => {
    expect(canTransitionCase('waiting_human', 'running')).toBe(true);
  });

  it('allows waiting_human → running (resume)', () => {
    expect(canTransitionCase('waiting_human', 'running')).toBe(true);
    expect(transitionCase('waiting_human', 'running')).toBe('running');
  });

  it('approved 是终态，不能转换', () => {
    expect(canTransitionCase('approved', 'running')).toBe(false);
    expect(() => transitionCase('approved', 'running')).toThrow();
  });

  it('stopped 是终态', () => {
    expect(canTransitionCase('stopped', 'running')).toBe(false);
  });

  it('failed 是终态', () => {
    expect(canTransitionCase('failed', 'running')).toBe(false);
  });

  it('created 不能直接到 approved', () => {
    expect(canTransitionCase('created', 'approved')).toBe(false);
  });

  it('非法转换抛出异常', () => {
    expect(() => transitionCase('created', 'approved')).toThrow('Invalid case state transition');
  });
});
