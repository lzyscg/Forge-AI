/**
 * 返修生命周期回归测试（任务书 7.1-7.3, 7.6）
 *
 * 7.1 多轮返修最终批准：3 条 submitted 指令 + 各自 claimed_fixed Issue，
 *    approve 时必须一并关闭全部指令（旧代码只关第一条 -> 失败）。
 * 7.2 部分指令不可验证：一条 Issue 仍 repairing，approve 不得产生半批准状态。
 * 7.3 非法 issue_ids：不存在 / Revision Instruction ID / 跨 Case / 已 verified。
 * 7.6 崩溃窗口幂等：恢复后不重复创建版本/指令，状态一致。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepository, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { ToolExecutor } from '@forge-ai/application';
import { RecoveryService } from '@forge-ai/application';
import { repairStaleSubmittedInstructions } from '@forge-ai/application';
import type { ScenarioConfig } from '@forge-ai/contracts';

const SCENARIO: ScenarioConfig = {
  scenario: { id: 'rev_test', name: '返修测试', version: 1 },
  input_fields: [],
  start_agent: 'supervisor',
  agents: [
    { key: 'supervisor', name: '总控', model: 'm', prompt: 'p.md', skills: [], tools: ['route_message', 'approve_delivery'], session: { policy: 'persistent' } },
    { key: 'generator', name: '生成', model: 'm', prompt: 'p.md', skills: [], tools: ['publish_artifact'], session: { policy: 'persistent' } },
    { key: 'reviewer', name: '审核', model: 'm', prompt: 'p.md', skills: [], tools: ['submit_evaluation'], session: { policy: 'cold_per_version' } },
  ],
  artifact_types: [{ type: 'lyrics', diff: 'line' as const }],
  routes: [
    { from: 'supervisor', to: ['generator'] },
    { from: 'generator', to: ['reviewer'] },
    { from: 'reviewer', to: ['supervisor'] },
  ],
  context_rules: {},
  delivery: { deliverable_artifact_type: 'lyrics' },
};

const anchor = (line: string) => JSON.stringify({ type: 'line', value: line });

function seedVersion(repo: SqliteRepository, clock: SystemClock, caseId: string, artifactId: string, vId: string, version: number, status: string, parent: string | null = null) {
  repo.insertArtifactVersion({
    artifact_version_id: vId, artifact_id: artifactId, version,
    content: 'line1\nline2\nline3', summary: `v${version}`,
    source_message_id: null, source_turn_id: null, parent_version_id: parent,
    diff: null, content_hash: `hash_${vId}`, status, approved_at: null, created_at: clock.now(),
  });
}

function seedIssue(repo: SqliteRepository, clock: SystemClock, caseId: string, issueId: string, vId: string, status: string, severity: 'blocking' | 'major' | 'minor' = 'blocking') {
  repo.insertIssue({
    issue_id: issueId, case_id: caseId, artifact_version_id: vId, evaluation_message_id: 'msg_eval',
    severity, anchor: anchor('2'), problem: 'p', evidence: 'e', status,
    resolution_artifact_version_id: status === 'claimed_fixed' ? vId : null,
    verified_by_evaluation_id: null, created_at: clock.now(), updated_at: clock.now(), closed_at: null,
  });
}

function seedInstruction(repo: SqliteRepository, clock: SystemClock, caseId: string, riId: string, targetVersion: string, issueIds: string[], status: string) {
  repo.insertRevisionInstruction({
    revision_instruction_id: riId, case_id: caseId, target_agent: 'generator',
    target_artifact_version_id: targetVersion, issue_ids: JSON.stringify(issueIds),
    editable_anchors: JSON.stringify(['line:2']), frozen_anchors: JSON.stringify(['line:1', 'line:3']),
    status, source_message_id: 'msg_route', created_at: clock.now(),
  });
}

describe('7.1 多轮返修最终批准（5.1：approve 一并关闭全部 submitted 指令）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_multi';
  const artifactId = 'art_multi';
  const v2 = 'av_v2';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, artifactId, v2, 2, 'under_review', 'av_v1');
    // 3 个 claimed_fixed Issue，各绑一条 submitted 指令
    seedIssue(repo, clock, caseId, 'issue_A', v2, 'claimed_fixed');
    seedIssue(repo, clock, caseId, 'issue_B', v2, 'claimed_fixed');
    seedIssue(repo, clock, caseId, 'issue_C', v2, 'claimed_fixed');
    seedInstruction(repo, clock, caseId, 'ri_1', v2, ['issue_A'], 'submitted');
    seedInstruction(repo, clock, caseId, 'ri_2', v2, ['issue_B'], 'submitted');
    seedInstruction(repo, clock, caseId, 'ri_3', v2, ['issue_C'], 'submitted');
  });

  it('approve 把 3 条 submitted 指令全部关闭、3 个 Issue 全部 verified、版本 approved', () => {
    const result = toolExecutor.execute(
      'submit_evaluation',
      { verdict: 'approve', issues: [], summary: '全部通过' },
      { caseId, turnId: 'turn_apv', sessionId: 'sess', agentKey: 'reviewer', messageId: 'msg_apv', scenarioConfig: SCENARIO },
    );

    expect(result.success).toBe(true);
    expect(repo.getIssue('issue_A')?.status).toBe('verified');
    expect(repo.getIssue('issue_B')?.status).toBe('verified');
    expect(repo.getIssue('issue_C')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_1')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_2')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_3')?.status).toBe('verified');
    expect(repo.getArtifactVersion(v2)?.status).toBe('approved');
    // 事件可追溯
    expect(repo.getIssueEvents('issue_A').some((e) => e.event_type === 'verified')).toBe(true);
  });

  it('approve 幂等：已 approved 时再次调用不重复迁移', () => {
    toolExecutor.execute(
      'submit_evaluation',
      { verdict: 'approve', issues: [], summary: '通过' },
      { caseId, turnId: 't1', sessionId: 'sess', agentKey: 'reviewer', messageId: 'm1', scenarioConfig: SCENARIO },
    );
    const result2 = toolExecutor.execute(
      'submit_evaluation',
      { verdict: 'approve', issues: [], summary: '再次通过' },
      { caseId, turnId: 't2', sessionId: 'sess', agentKey: 'reviewer', messageId: 'm2', scenarioConfig: SCENARIO },
    );
    expect(result2.success).toBe(true);
    // 仍只有一个 verified 事件（第二次是幂等 no-op）
    const verifiedEvents = repo.getIssueEvents('issue_A').filter((e) => e.event_type === 'verified');
    expect(verifiedEvents).toHaveLength(1);
  });
});

describe('7.2 部分指令不可验证（5.1：approve 不得产生半批准状态）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_partial';
  const v2 = 'av_p2';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_p', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_p', v2, 2, 'under_review', 'av_p1');
    // ri_1 的 Issue 已 claimed_fixed；ri_2 的 Issue 仍 repairing
    seedIssue(repo, clock, caseId, 'issue_A', v2, 'claimed_fixed');
    seedIssue(repo, clock, caseId, 'issue_B', v2, 'repairing');
    seedInstruction(repo, clock, caseId, 'ri_1', v2, ['issue_A'], 'submitted');
    seedInstruction(repo, clock, caseId, 'ri_2', v2, ['issue_B'], 'submitted');
  });

  it('approve 返回结构化错误、不批准产物、状态保持一致', () => {
    const result = toolExecutor.execute(
      'submit_evaluation',
      { verdict: 'approve', issues: [], summary: '通过' },
      { caseId, turnId: 'turn_apv', sessionId: 'sess', agentKey: 'reviewer', messageId: 'msg_apv', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('PARTIAL_REVISION_INCOMPLETE');
    expect(result.incomplete_instruction_ids).toEqual(['ri_2']);
    // 产物未 approved
    expect(repo.getArtifactVersion(v2)?.status).toBe('under_review');
    // Issue 状态不变
    expect(repo.getIssue('issue_A')?.status).toBe('claimed_fixed');
    expect(repo.getIssue('issue_B')?.status).toBe('repairing');
    // 指令状态不变
    expect(repo.getRevisionInstruction('ri_1')?.status).toBe('submitted');
    expect(repo.getRevisionInstruction('ri_2')?.status).toBe('submitted');
  });
});

describe('7.3 非法 issue_ids（5.3：route_message 校验引用完整性）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_route';
  const otherCaseId = 'case_other';
  const v1 = 'av_r1';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    repo.insertCase({
      case_id: caseId, title: 't', status: 'running', current_stage: 'production',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertCase({
      case_id: otherCaseId, title: 't', status: 'running', current_stage: 'production',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_r', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: v1, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_r', v1, 1, 'under_review');
    // 当前 Case 的 open issue
    seedIssue(repo, clock, caseId, 'issue_open', v1, 'open');
    // 当前 Case 的已 verified issue
    seedIssue(repo, clock, caseId, 'issue_verified', v1, 'verified');
    // 另一个 Case 的 open issue
    seedIssue(repo, clock, otherCaseId, 'issue_other_case', v1, 'open');
  });

  const callRoute = (issueIds: string[]) =>
    toolExecutor.execute(
      'route_message',
      {
        target_agent: 'generator',
        instruction: '修一下',
        scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'], issue_ids: issueIds },
        reason: '返修',
      },
      { caseId, turnId: 'turn_route', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_route', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

  it('不存在的 Issue ID -> 失败，不建指令', () => {
    const before = repo.getRevisionInstructionsByCase(caseId).length;
    const result = callRoute(['issue_nonexistent']);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_ISSUE_REFERENCE');
    expect(result.invalid_issue_ids).toEqual(['issue_nonexistent']);
    expect(repo.getRevisionInstructionsByCase(caseId).length).toBe(before);
  });

  it('Revision Instruction ID 当作 issue_id -> 失败', () => {
    const result = callRoute(['ri_33f61daddd59401c']);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_ISSUE_REFERENCE');
    expect(result.invalid_issue_ids).toEqual(['ri_33f61daddd59401c']);
    expect(repo.getRevisionInstructionsByCase(caseId).length).toBe(0);
  });

  it('其他 Case 的 Issue ID -> 失败', () => {
    const result = callRoute(['issue_other_case']);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_ISSUE_REFERENCE');
    expect(result.invalid_issue_ids).toEqual(['issue_other_case']);
  });

  it('已 verified 的 Issue ID -> 失败（状态不在 open|reopened）', () => {
    const result = callRoute(['issue_verified']);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_ISSUE_REFERENCE');
    expect(result.invalid_issue_ids).toEqual(['issue_verified']);
    // verified 状态不变
    expect(repo.getIssue('issue_verified')?.status).toBe('verified');
  });

  it('合法 issue_ids -> 成功创建指令并迁移 Issue 到 repairing', () => {
    const result = callRoute(['issue_open']);
    expect(result.success).toBe(true);
    expect(result.revision_instruction_id).toBeTruthy();
    expect(repo.getIssue('issue_open')?.status).toBe('repairing');
    const ri = repo.getRevisionInstructionsByCase(caseId);
    expect(ri).toHaveLength(1);
    expect(ri[0].status).toBe('issued');
  });

  it('混合合法/非法 -> 整体失败，不写指令不改状态', () => {
    const result = callRoute(['issue_open', 'issue_nonexistent']);
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_ISSUE_REFERENCE');
    expect(repo.getRevisionInstructionsByCase(caseId).length).toBe(0);
    // 合法的 issue_open 状态不变（未迁移到 repairing）
    expect(repo.getIssue('issue_open')?.status).toBe('open');
  });
});

describe('7.6 崩溃窗口幂等（5.5/不变量 4.5）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
  });

  it('窗口1：版本已写入、Issue 尚未更新 -> 恢复不重复创建版本', () => {
    const caseId = 'case_w1';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_w1', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_w1_2', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_w1', 'av_w1_2', 2, 'under_review', 'av_w1_1');
    seedIssue(repo, clock, caseId, 'issue_w1', 'av_w1_2', 'repairing');

    const versionsBefore = repo.getVersionsByArtifact('art_w1').length;
    const issuesBefore = repo.getIssuesByCase(caseId).length;

    new RecoveryService(repo, clock).recoverCase(caseId);

    // 恢复不创建新版本/新 Issue
    expect(repo.getVersionsByArtifact('art_w1').length).toBe(versionsBefore);
    expect(repo.getIssuesByCase(caseId).length).toBe(issuesBefore);
    // Case 经 waiting_recovery 回到 running
    expect(repo.getCase(caseId)?.status).toBe('running');
    // 事件可追溯
    expect(repo.getControlEventsByCase(caseId).some((e) => e.event_type === 'recovery_started')).toBe(true);
  });

  it('窗口2：Issue 已 verified、指令仍 submitted -> 恢复不重复创建，状态保留（一致性修复交给门禁）', () => {
    const caseId = 'case_w2';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_w2', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_w2_2', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_w2', 'av_w2_2', 2, 'approved', 'av_w2_1');
    seedIssue(repo, clock, caseId, 'issue_w2', 'av_w2_2', 'verified');
    seedInstruction(repo, clock, caseId, 'ri_w2', 'av_w2_2', ['issue_w2'], 'submitted');

    const instrBefore = repo.getRevisionInstructionsByCase(caseId).length;
    new RecoveryService(repo, clock).recoverCase(caseId);

    // 恢复不重复创建指令
    expect(repo.getRevisionInstructionsByCase(caseId).length).toBe(instrBefore);
    // Issue 仍 verified、指令仍 submitted（恢复不篡改已持久化结果，铁律 4）
    expect(repo.getIssue('issue_w2')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_w2')?.status).toBe('submitted');
    expect(repo.getCase(caseId)?.status).toBe('running');

    // 续跑到终态：approve_delivery 触发 5.6 一致性修复（陈旧 submitted 指令 -> verified，门禁通过）。
    // 这步在旧代码（无 5.6 一致性修复）上会因 no_active_revision 失败，使本测试满足"旧代码失败/新代码通过"。
    const toolExecutor = new ToolExecutor(repo, clock, idGen);
    const result = toolExecutor.execute(
      'approve_delivery',
      { summary: '交付' },
      { caseId, turnId: 'turn_deliver', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_deliver', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.gate_passed).toBe(true);
    expect(result.consistency_repaired).toBe(true);
    // 陈旧 submitted 指令被一致性修复为 verified
    expect(repo.getRevisionInstruction('ri_w2')?.status).toBe('verified');
    // 版本 delivered
    expect(repo.getArtifactVersion('av_w2_2')?.status).toBe('delivered');
  });

  it('窗口3：指令已 verified、Case 尚未 approved -> 恢复后可继续到交付（不重复创建）', () => {
    const caseId = 'case_w3';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'running', current_stage: 'production',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_w3', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_w3_1', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_w3', 'av_w3_1', 1, 'approved');
    seedIssue(repo, clock, caseId, 'issue_w3', 'av_w3_1', 'verified');
    seedInstruction(repo, clock, caseId, 'ri_w3', 'av_w3_1', ['issue_w3'], 'verified');

    const versionsBefore = repo.getVersionsByArtifact('art_w3').length;
    const instrBefore = repo.getRevisionInstructionsByCase(caseId).length;

    // 重复恢复：幂等，不重复
    new RecoveryService(repo, clock).recoverCase(caseId);
    new RecoveryService(repo, clock).recoverCase(caseId);

    expect(repo.getVersionsByArtifact('art_w3').length).toBe(versionsBefore);
    expect(repo.getRevisionInstructionsByCase(caseId).length).toBe(instrBefore);
    // 状态最终一致：版本 approved、Issue verified、指令 verified
    expect(repo.getArtifactVersion('av_w3_1')?.status).toBe('approved');
    expect(repo.getIssue('issue_w3')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_w3')?.status).toBe('verified');
  });

  it('5.6 一致性修复：Issue 全 verified + 指令 submitted -> approve_delivery 自动关闭陈旧指令并通过门禁', () => {
    const caseId = 'case_consistency';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'running', current_stage: 'production',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_c', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_c_1', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_c', 'av_c_1', 1, 'approved');
    seedIssue(repo, clock, caseId, 'issue_c', 'av_c_1', 'verified');
    // 陈旧 submitted 指令：关联 Issue 已 verified（生命周期不一致）
    seedInstruction(repo, clock, caseId, 'ri_stale', 'av_c_1', ['issue_c'], 'submitted');

    const toolExecutor = new ToolExecutor(repo, clock, idGen);
    const result = toolExecutor.execute(
      'approve_delivery',
      { summary: '交付' },
      { caseId, turnId: 'turn_deliver', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_deliver', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    // 一致性修复后门禁通过
    expect(result.success).toBe(true);
    expect(result.gate_passed).toBe(true);
    expect(result.consistency_repaired).toBe(true);
    // 陈旧指令被关闭为 verified
    expect(repo.getRevisionInstruction('ri_stale')?.status).toBe('verified');
    // 版本 delivered
    expect(repo.getArtifactVersion('av_c_1')?.status).toBe('delivered');
    // 一致性修复事件可追溯
    expect(repo.getControlEventsByCase(caseId).some((e) => e.event_type === 'consistency_repair')).toBe(true);
  });
});

describe('验收补充（4 项修复：恢复清理 / publish 排除 submitted / delivered 门禁）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
  });

  it('1: 恢复路径清理 2 条 stale submitted（issue 全 verified）', () => {
    const caseId = 'case_rc_cleanup';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_rc', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_rc_1', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_rc', 'av_rc_1', 1, 'approved');
    seedIssue(repo, clock, caseId, 'issue_rc1', 'av_rc_1', 'verified');
    seedIssue(repo, clock, caseId, 'issue_rc2', 'av_rc_1', 'verified');
    seedInstruction(repo, clock, caseId, 'ri_rc1', 'av_rc_1', ['issue_rc1'], 'submitted');
    seedInstruction(repo, clock, caseId, 'ri_rc2', 'av_rc_1', ['issue_rc2'], 'submitted');

    const repaired = repairStaleSubmittedInstructions(repo, clock, idGen, caseId, 'recovery_cleanup');
    expect(repaired.length).toBe(2);
    expect(repo.getRevisionInstruction('ri_rc1')?.status).toBe('verified');
    expect(repo.getRevisionInstruction('ri_rc2')?.status).toBe('verified');
    expect(repo.getControlEventsByCase(caseId).some((e) => e.event_type === 'consistency_repair')).toBe(true);
  });

  it('2: publish 不绑定 submitted 指令（待审核轮次不当返修任务，返回 NO_ACTIVE_INSTRUCTION）', () => {
    const caseId = 'case_pub_excl';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_p', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_p_1', status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, caseId, 'art_p', 'av_p_1', 1, 'under_review');
    seedIssue(repo, clock, caseId, 'issue_p', 'av_p_1', 'repairing');
    // 仅一条 submitted 指令（上一轮返修已发布待审核），无 issued/in_progress
    seedInstruction(repo, clock, caseId, 'ri_p_sub', 'av_p_1', ['issue_p'], 'submitted');

    const toolExecutor = new ToolExecutor(repo, clock, idGen);
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'lyrics', content: 'line1\nline2changed\nline3', summary: 'v2' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'generator', messageId: 'msg_p', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    // 旧代码：submitted 在候选里 -> 绑定 + scope 校验（会成功，误把待审核轮次当返修任务）。
    // 新代码：submitted 排除 -> 0 候选 -> NO_ACTIVE_INSTRUCTION。
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('NO_ACTIVE_INSTRUCTION');
    // submitted 指令未被误关/误绑
    expect(repo.getRevisionInstruction('ri_p_sub')?.status).toBe('submitted');
  });

  it('4: delivered 版本（已交付未 approved 的崩溃窗口）门禁 artifact_version_approved 通过', () => {
    const caseId = 'case_delivered';
    repo.insertCase({
      case_id: caseId, title: 't', status: 'running', current_stage: 'production',
      scenario_id: 'rev_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_d', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_d_1', status: 'active', created_at: clock.now(),
    });
    // 版本已 delivered（approve_delivery 在 turn 事务内置 delivered），Case 尚未 approved（崩溃窗口）
    seedVersion(repo, clock, caseId, 'art_d', 'av_d_1', 1, 'delivered');
    seedIssue(repo, clock, caseId, 'issue_d', 'av_d_1', 'verified');

    const toolExecutor = new ToolExecutor(repo, clock, idGen);
    const result = toolExecutor.execute(
      'approve_delivery',
      { summary: '交付' },
      { caseId, turnId: 'turn_d', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_d', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    // 旧代码 artifact_version_approved 只认 'approved'，delivered 失败 -> 门禁拦 -> 循环。
    // 新代码接受 delivered，门禁通过。
    expect(result.success).toBe(true);
    expect(result.gate_passed).toBe(true);
  });
});
