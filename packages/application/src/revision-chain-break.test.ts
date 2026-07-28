/**
 * P0 复现测试：返修版本链断裂导致 publish_artifact 永久阻塞
 *
 * 对应返修清单「验证方法 1」：用内存 SQLite Repository 构造
 * "RI 的 target_artifact_version_id 已 superseded 但 RI 仍活跃"的断裂状态，
 * 验证 publish_artifact 不再被 NO_ACTIVE_INSTRUCTION 永久阻塞。
 *
 * 覆盖（方案 A + B）：
 * - 缺陷 3（line ~150 匹配过严）：target 已 superseded 仍应匹配 +
 *   自动重定位 RI target 到当前父版本 + control_event 追加记录（铁律 4）。
 * - 缺陷 1（line ~212 scope_violation 重发）：重发 RI 的 target 指向当前父版本，
 *   不复制旧 RI 的过时 target。
 * - 缺陷 2（line ~542 route_message 合并）：合并 issue_ids/anchors 时同步把
 *   target_artifact_version_id 更新为当前最新版本。
 * - 约束：多条 superseded-target RI 仍返回 AMBIGUOUS（不引入新模糊）。
 * - 铁律 3：放宽匹配不影响 approve_delivery 门禁独立性（Issue 不被自动 verified）。
 *
 * 这些断言在未修复代码上应 FAIL（缺陷 3 直接返回 NO_ACTIVE_INSTRUCTION，
 * 缺陷 1/2 让重发/合并的 RI 残留过时 target），修复后 PASS。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepository, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { ToolExecutor } from '@forge-ai/application';
import type { ScenarioConfig } from '@forge-ai/contracts';

const SCENARIO: ScenarioConfig = {
  scenario: { id: 'chain_test', name: '返修版本链测试', version: 1 },
  input_fields: [],
  start_agent: 'supervisor',
  agents: [
    { key: 'supervisor', name: '总控', model: 'm', prompt: 'p.md', skills: [], tools: ['route_message', 'approve_delivery'], session: { policy: 'persistent' } },
    { key: 'writer', name: '写作', model: 'm', prompt: 'p.md', skills: [], tools: ['publish_artifact'], session: { policy: 'persistent' } },
    { key: 'auditor', name: '审核', model: 'm', prompt: 'p.md', skills: [], tools: ['submit_evaluation'], session: { policy: 'cold_per_version' } },
  ],
  artifact_types: [{ type: 'draft', diff: 'line' as const }],
  routes: [
    { from: 'supervisor', to: ['writer'] },
    { from: 'writer', to: ['auditor'] },
    { from: 'auditor', to: ['supervisor'] },
  ],
  context_rules: {},
  delivery: { deliverable_artifact_type: 'draft' },
};

const anchor = (line: string) => JSON.stringify({ type: 'line', value: line });

function seedVersion(
  repo: SqliteRepository,
  clock: SystemClock,
  artifactId: string,
  vId: string,
  version: number,
  status: string,
  content: string,
  parent: string | null = null,
) {
  repo.insertArtifactVersion({
    artifact_version_id: vId, artifact_id: artifactId, version,
    content, summary: `v${version}`, source_message_id: null, source_turn_id: null, parent_version_id: parent,
    diff: null, content_hash: `hash_${vId}`, status, approved_at: null, created_at: clock.now(),
  });
}

function seedIssue(
  repo: SqliteRepository,
  clock: SystemClock,
  caseId: string,
  issueId: string,
  vId: string,
  status: string,
  severity: 'blocking' | 'major' | 'minor' = 'blocking',
) {
  repo.insertIssue({
    issue_id: issueId, case_id: caseId, artifact_version_id: vId, evaluation_message_id: 'msg_eval',
    severity, anchor: anchor('2'), problem: 'p', evidence: 'e', status,
    resolution_artifact_version_id: null, verified_by_evaluation_id: null,
    created_at: clock.now(), updated_at: clock.now(), closed_at: null,
  });
}

function seedInstruction(
  repo: SqliteRepository,
  clock: SystemClock,
  caseId: string,
  riId: string,
  targetAgent: string,
  targetVersion: string | null,
  issueIds: string[],
  status: string,
  editable: string[] = ['line:2'],
  frozen: string[] = ['line:1', 'line:3'],
) {
  repo.insertRevisionInstruction({
    revision_instruction_id: riId, case_id: caseId, target_agent: targetAgent,
    target_artifact_version_id: targetVersion, issue_ids: JSON.stringify(issueIds),
    editable_anchors: JSON.stringify(editable), frozen_anchors: JSON.stringify(frozen),
    status, source_message_id: 'msg_route', created_at: clock.now(),
  });
}

function seedCase(repo: SqliteRepository, clock: SystemClock, caseId: string, status = 'repairing') {
  repo.insertCase({
    case_id: caseId, title: 't', status, current_stage: 'repairing',
    scenario_id: 'chain_test', scenario_snapshot: '{}', input_payload: '{}',
    created_at: clock.now(), updated_at: clock.now(), completed_at: null,
  });
}

describe('缺陷 3：RI target 已 superseded 时 publish 不再永久阻塞（返修清单验证方法 1）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_break';
  const artifactId = 'art_break';
  const v1 = 'av_b1';
  const v2 = 'av_b2';
  const v3 = 'av_b3';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    seedCase(repo, clock, caseId);
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'draft',
      scope_key: null, current_valid_version_id: v3, status: 'active', created_at: clock.now(),
    });
    // v1 superseded / v2 under_review / v3 under_review(当前)
    seedVersion(repo, clock, artifactId, v1, 1, 'superseded', 'line1\nline2\nline3');
    seedVersion(repo, clock, artifactId, v2, 2, 'under_review', 'line1\nline2X\nline3', v1);
    seedVersion(repo, clock, artifactId, v3, 3, 'under_review', 'line1\nline2Y\nline3', v2);
    seedIssue(repo, clock, caseId, 'issue_break', v1, 'repairing');
    // 断裂现场：RI 仍活跃但 target 指向已 superseded 的 v1
    seedInstruction(repo, clock, caseId, 'ri_break', 'writer', v1, ['issue_break'], 'issued');
  });

  it('writer 以 v3 为父本发布 -> 修复前 NO_ACTIVE_INSTRUCTION，修复后 success', () => {
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    // 修复前：success=false, error_code=NO_ACTIVE_INSTRUCTION -> 此断言 FAIL（bug 复现）
    // 修复后：success=true
    expect(result.success).toBe(true);
    expect(result.artifact_version_id).toBeTruthy();
  });

  it('匹配后自动把 RI 的 target 重定位到当前父版本 v3', () => {
    toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    );

    const ri = repo.getRevisionInstruction('ri_break');
    expect(ri?.target_artifact_version_id).toBe(v3);
    // 返修版本已发布待审核 -> submitted
    expect(ri?.status).toBe('submitted');
  });

  it('重定位以 control_event 追加记录（铁律 4：不静默改）', () => {
    toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    );

    const events = repo.getControlEventsByCase(caseId);
    const rebaseEvt = events.find((e) => e.event_type === 'revision_target_rebased');
    expect(rebaseEvt).toBeTruthy();
    const detail = JSON.parse(rebaseEvt!.detail as string);
    expect(detail.instruction_id).toBe('ri_break');
    expect(detail.from_target_version_id).toBe(v1);
    expect(detail.to_target_version_id).toBe(v3);
  });

  it('铁律 3：放宽匹配不绕过门禁 -- Issue 仅到 claimed_fixed，未被自动 verified', () => {
    toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    );

    // 返修方发布只把 Issue 推到 claimed_fixed（声称已修复），verified 必须由审核 Agent 复审。
    // 门禁仍会因 blocking Issue 未 verified 而拦截，独立性不受放宽匹配影响。
    expect(repo.getIssue('issue_break')?.status).toBe('claimed_fixed');
  });
});

describe('缺陷 1：scope_violation 重发 RI 的 target 指向当前父版本（不复制过时 target）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_scope';
  const artifactId = 'art_scope';
  const v1 = 'av_s1';
  const v2 = 'av_s2';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    seedCase(repo, clock, caseId);
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'draft',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, artifactId, v1, 1, 'superseded', 'line1\nline2\nline3');
    seedVersion(repo, clock, artifactId, v2, 2, 'under_review', 'line1\nline2Y\nline3', v1);
    seedIssue(repo, clock, caseId, 'issue_scope', v1, 'repairing');
    // RI target 指向已 superseded 的 v1（过时）
    seedInstruction(repo, clock, caseId, 'ri_scope', 'writer', v1, ['issue_scope'], 'issued');
  });

  it('越界后重发 RI 的 target = 当前父版本 v2（修复前会复制过时 v1）', () => {
    // 改 frozen 行 line:1 -> 越界
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'CHANGED1\nline2Y\nline3', summary: '越界版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/越界/);

    const instructions = repo.getRevisionInstructionsByCase(caseId);
    // 原指令进 scope_violation 终态
    const original = instructions.find((ri) => ri.revision_instruction_id === 'ri_scope');
    expect(original?.status).toBe('scope_violation');
    // 系统自动重发一条 issued 指令
    const retried = instructions.find((ri) => ri.status === 'issued');
    expect(retried).toBeTruthy();
    // ★ 修复前：retried.target = v1（复制旧 RI 过时 target）。
    // ★ 修复后：retried.target = v2（当前父版本/最新非 rejected 版本）。
    expect(retried?.target_artifact_version_id).toBe(v2);
  });
});

describe('缺陷 2：route_message 合并到现有 RI 时更新 target 到最新版本', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_merge';
  const artifactId = 'art_merge';
  const v1 = 'av_m1';
  const v2 = 'av_m2';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    seedCase(repo, clock, caseId, 'running');
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'draft',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, artifactId, v1, 1, 'superseded', 'line1\nline2\nline3');
    seedVersion(repo, clock, artifactId, v2, 2, 'under_review', 'line1\nline2Y\nline3', v1);
    // 两个 open Issue（同一审核消息 msg_eval2 创建）
    seedIssue(repo, clock, caseId, 'issue_A', v2, 'open');
    seedIssue(repo, clock, caseId, 'issue_B', v2, 'open');
    repo.updateIssue('issue_B', { evaluation_message_id: 'msg_route2' });
    // 现有活跃指令：target 指向已 superseded 的 v1（过时），已绑 issue_A
    seedInstruction(repo, clock, caseId, 'ri_merge', 'writer', v1, ['issue_A'], 'issued');
  });

  it('合并 issue_B 时同步把 target 更新到当前最新版本 v2', () => {
    const result = toolExecutor.execute(
      'route_message',
      {
        target_agent: 'writer',
        instruction: '追加修复 issue_B',
        scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'], issue_ids: ['issue_B'] },
        reason: '追加返修',
      },
      { caseId, turnId: 'turn_route', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_route2', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.revision_instruction_id).toBe('ri_merge');

    const ri = repo.getRevisionInstruction('ri_merge');
    // issue_ids 合并：A + B
    expect(JSON.parse(ri!.issue_ids as string)).toEqual(['issue_A', 'issue_B']);
    // ★ 修复前：target 仍为过时的 v1（合并时遗漏更新）。
    // ★ 修复后：target 更新到当前最新版本 v2。
    expect(ri?.target_artifact_version_id).toBe(v2);
    // 合并以 control_event 追加记录（铁律 4：不静默改）
    const events = repo.getControlEventsByCase(caseId);
    expect(events.some((e) => e.event_type === 'revision_target_rebased')).toBe(true);
  });
});

describe('约束：多条 superseded-target RI 仍返回 AMBIGUOUS（不引入新模糊）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_amb';
  const artifactId = 'art_amb';
  const v1 = 'av_a1';
  const v2 = 'av_a2';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    seedCase(repo, clock, caseId);
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'draft',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    seedVersion(repo, clock, artifactId, v1, 1, 'superseded', 'line1\nline2\nline3');
    seedVersion(repo, clock, artifactId, v2, 2, 'under_review', 'line1\nline2Y\nline3', v1);
    seedIssue(repo, clock, caseId, 'issue_amb1', v1, 'repairing');
    seedIssue(repo, clock, caseId, 'issue_amb2', v1, 'repairing');
    // 2 条 RI，target 都指向已 superseded 的 v1，同一 writer
    seedInstruction(repo, clock, caseId, 'ri_amb1', 'writer', v1, ['issue_amb1'], 'issued');
    seedInstruction(repo, clock, caseId, 'ri_amb2', 'writer', v1, ['issue_amb2'], 'issued');
  });

  it('2 条 RI 的 target 都 superseded -> AMBIGUOUS_ACTIVE_INSTRUCTION（不自动重定位）', () => {
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('AMBIGUOUS_ACTIVE_INSTRUCTION');
    // 模糊归属时不自动改任何 RI 的 target
    expect(repo.getRevisionInstruction('ri_amb1')?.target_artifact_version_id).toBe(v1);
    expect(repo.getRevisionInstruction('ri_amb2')?.target_artifact_version_id).toBe(v1);
  });
});

describe('缺陷 2 残留（LOW）：route_message 合并取最后非 rejected 版本，不指向 rejected 死分支', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;
  const caseId = 'case_merge_rej';
  const artifactId = 'art_merge_rej';
  const v1 = 'av_mr1';
  const v2 = 'av_mr2';
  const v3 = 'av_mr3'; // scope_violation 越界的 rejected 死分支（版本号最新）

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);
    seedCase(repo, clock, caseId, 'running');
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'draft',
      scope_key: null, current_valid_version_id: v2, status: 'active', created_at: clock.now(),
    });
    // v1 superseded / v2 under_review(最后非 rejected) / v3 rejected(越界死分支，版本号最新)
    seedVersion(repo, clock, artifactId, v1, 1, 'superseded', 'line1\nline2\nline3');
    seedVersion(repo, clock, artifactId, v2, 2, 'under_review', 'line1\nline2Y\nline3', v1);
    seedVersion(repo, clock, artifactId, v3, 3, 'rejected', 'line1\nline2OUT\nline3', v2);
    // 两个 open Issue（issue_B 由 supervisor 在合并 route_message 时追加，绑同一审核消息）
    seedIssue(repo, clock, caseId, 'issue_A', v2, 'open');
    seedIssue(repo, clock, caseId, 'issue_B', v2, 'open');
    repo.updateIssue('issue_B', { evaluation_message_id: 'msg_route2' });
    // 现有活跃指令：模拟越界后系统重发的 RI（缺陷1 修复：target=最后非 rejected=v2），已绑 issue_A
    seedInstruction(repo, clock, caseId, 'ri_merge_rej', 'writer', v2, ['issue_A'], 'issued');
  });

  it('合并 issue_B 时 target 不指向 rejected 死分支 v3，保持最后非 rejected v2', () => {
    const result = toolExecutor.execute(
      'route_message',
      {
        target_agent: 'writer',
        instruction: '追加修复 issue_B',
        scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'], issue_ids: ['issue_B'] },
        reason: '追加返修',
      },
      { caseId, turnId: 'turn_route', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_route2', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.revision_instruction_id).toBe('ri_merge_rej');

    const ri = repo.getRevisionInstruction('ri_merge_rej');
    // ★ 修复前（getLatestVersion 不过滤 rejected）：target 被更新到 v3（rejected 死分支）。
    // ★ 修复后（最后非 rejected）：target 保持 v2。
    expect(ri?.target_artifact_version_id).toBe(v2);
    expect(ri?.target_artifact_version_id).not.toBe(v3);
  });

  it('writer 随后以最后非 rejected 版本 v2 为父本合规发布 -> 成功（不 NO_ACTIVE_INSTRUCTION）', () => {
    toolExecutor.execute(
      'route_message',
      {
        target_agent: 'writer',
        instruction: '追加修复 issue_B',
        scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'], issue_ids: ['issue_B'] },
        reason: '追加返修',
      },
      { caseId, turnId: 'turn_route', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_route2', scenarioConfig: SCENARIO },
    );

    // writer 以 v2 为父本发布合规返修版本（只改 editable line:2）
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'line1\nline2FIXED\nline3', summary: '修复版本' },
      { caseId, turnId: 'turn_p', sessionId: 'sess', agentKey: 'writer', messageId: 'msg_p', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    // ★ 修复前：合并后 RI target=v3(rejected)，publish 时 parent=v2(最后非 rejected)，
    //   target!==parent 且 v3 非 superseded（缺陷3 放宽不覆盖 rejected）
    //   -> NO_ACTIVE_INSTRUCTION（原 P0 症状残留，永久阻塞）。
    // ★ 修复后：RI target=v2=parent -> 匹配 -> success。
    expect(result.success).toBe(true);
    expect(result.artifact_version_id).toBeTruthy();
  });

  it('现有 RI target 过时(v1) 时合并重定位到最后非 rejected v2（不指向 v3）+ control_event 记录', () => {
    // 改造为 stale-target 场景：RI target 指向已 superseded 的 v1
    repo.updateRevisionInstruction('ri_merge_rej', { target_artifact_version_id: v1 });

    const result = toolExecutor.execute(
      'route_message',
      {
        target_agent: 'writer',
        instruction: '追加修复 issue_B',
        scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'], issue_ids: ['issue_B'] },
        reason: '追加返修',
      },
      { caseId, turnId: 'turn_route', sessionId: 'sess', agentKey: 'supervisor', messageId: 'msg_route2', scenarioConfig: SCENARIO },
    ) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const ri = repo.getRevisionInstruction('ri_merge_rej');
    // ★ 修复前：target 重定位到 v3（rejected 死分支，getLatestVersion）。
    // ★ 修复后：target 重定位到 v2（最后非 rejected）。
    expect(ri?.target_artifact_version_id).toBe(v2);
    expect(ri?.target_artifact_version_id).not.toBe(v3);

    // 铁律 4：target 重定位以 control_event 追加记录（from v1 -> to v2，不是 to v3）
    const events = repo.getControlEventsByCase(caseId);
    const rebaseEvt = events.find((e) => e.event_type === 'revision_target_rebased');
    expect(rebaseEvt).toBeTruthy();
    const detail = JSON.parse(rebaseEvt!.detail as string);
    expect(detail.instruction_id).toBe('ri_merge_rej');
    expect(detail.from_target_version_id).toBe(v1);
    expect(detail.to_target_version_id).toBe(v2);
  });
});
