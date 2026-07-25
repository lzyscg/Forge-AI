import { describe, it, expect } from 'vitest';
import { evaluateDeliveryGate, type DeliveryGateInput } from './delivery-gate.js';

describe('交付门禁', () => {
  const passingInput: DeliveryGateInput = {
    artifactVersion: { status: 'approved' },
    artifactVersionApproved: true,
    blockingIssues: [],
    revisionInstructions: [],
    incompleteTurns: [],
  };

  it('全部通过时门禁通过', () => {
    const result = evaluateDeliveryGate(passingInput);
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.blockingIssueIds).toHaveLength(0);
  });

  it('产物版本不存在时拒绝', () => {
    const result = evaluateDeliveryGate({ ...passingInput, artifactVersion: null });
    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].check).toBe('artifact_version_valid');
  });

  it('产物版本状态为 invalidated 时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      artifactVersion: { status: 'invalidated' },
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
  });

  it('产物版本状态为 superseded 时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      artifactVersion: { status: 'superseded' },
    });
    expect(result.passed).toBe(false);
  });

  it('该版本未经审核通过时拒绝（approve 不继承）', () => {
    const result = evaluateDeliveryGate({ ...passingInput, artifactVersionApproved: false });
    expect(result.passed).toBe(false);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[1].check).toBe('artifact_version_approved');
  });

  it('存在 blocking + open 的 Issue 时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      blockingIssues: [{ issueId: 'issue_1', status: 'open', severity: 'blocking' }],
    });
    expect(result.passed).toBe(false);
    expect(result.checks[2].passed).toBe(false);
    expect(result.blockingIssueIds).toContain('issue_1');
  });

  it('存在 blocking + claimed_fixed 的 Issue 时拒绝（铁律 3）', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      blockingIssues: [{ issueId: 'issue_1', status: 'claimed_fixed', severity: 'blocking' }],
    });
    expect(result.passed).toBe(false);
    expect(result.checks[2].passed).toBe(false);
    expect(result.blockingIssueIds).toContain('issue_1');
  });

  it('存在 blocking + repairing 的 Issue 时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      blockingIssues: [{ issueId: 'issue_1', status: 'repairing', severity: 'blocking' }],
    });
    expect(result.passed).toBe(false);
  });

  it('blocking + verified 的 Issue 不阻断', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      blockingIssues: [{ issueId: 'issue_1', status: 'verified', severity: 'blocking' }],
    });
    expect(result.passed).toBe(true);
    expect(result.checks[2].passed).toBe(true);
  });

  it('major 级 Issue 不阻断交付', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      blockingIssues: [{ issueId: 'issue_1', status: 'open', severity: 'major' }],
    });
    expect(result.passed).toBe(true);
  });

  it('存在未完成的返修指令时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      revisionInstructions: [{ id: 'ri_1', status: 'in_progress' }],
    });
    expect(result.passed).toBe(false);
    expect(result.checks[3].passed).toBe(false);
    expect(result.checks[3].check).toBe('no_active_revision');
  });

  it('返修指令 issued 状态也阻断', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      revisionInstructions: [{ id: 'ri_1', status: 'issued' }],
    });
    expect(result.passed).toBe(false);
  });

  it('返修指令 submitted 状态也阻断', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      revisionInstructions: [{ id: 'ri_1', status: 'submitted' }],
    });
    expect(result.passed).toBe(false);
  });

  it('返修指令 verified 不阻断', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      revisionInstructions: [{ id: 'ri_1', status: 'verified' }],
    });
    expect(result.passed).toBe(true);
  });

  it('返修指令 scope_violation 不阻断（已终止）', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      revisionInstructions: [{ id: 'ri_1', status: 'scope_violation' }],
    });
    expect(result.passed).toBe(true);
  });

  it('存在未完成的 Turn 时拒绝', () => {
    const result = evaluateDeliveryGate({
      ...passingInput,
      incompleteTurns: [{ turnId: 'turn_1', status: 'running' }],
    });
    expect(result.passed).toBe(false);
    expect(result.checks[4].passed).toBe(false);
    expect(result.checks[4].check).toBe('no_incomplete_turns');
  });

  it('多项同时不通过时全部报告', () => {
    const result = evaluateDeliveryGate({
      artifactVersion: null,
      artifactVersionApproved: false,
      blockingIssues: [{ issueId: 'issue_1', status: 'open', severity: 'blocking' }],
      revisionInstructions: [{ id: 'ri_1', status: 'issued' }],
      incompleteTurns: [{ turnId: 'turn_1', status: 'queued' }],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => !c.passed)).toHaveLength(5);
  });
});
