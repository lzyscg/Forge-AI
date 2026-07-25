/**
 * Issue 生命周期回归测试（铁律 4：状态变化以事件追加记录）
 *
 * 验证 publish_artifact 返修时 issue 从 repairing -> claimed_fixed，
 * 且 claimed_fixed 这一步被记进 issue_events 表（之前只 updateIssue 漏记事件）。
 *
 * 需求文档 §11 状态机：open -> repairing -> claimed_fixed -> verified
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepository, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { ToolExecutor } from '@forge-ai/application';
import type { ScenarioConfig } from '@forge-ai/contracts';

const SCENARIO: ScenarioConfig = {
  scenario: { id: 'lifecycle_test', name: '生命周期测试', version: 1 },
  input_fields: [],
  start_agent: 'generator',
  agents: [
    {
      key: 'generator',
      name: '生成',
      model: 'm',
      prompt: 'p.md',
      skills: [],
      tools: ['publish_artifact'],
      session: { policy: 'persistent' },
    },
  ],
  artifact_types: [{ type: 'lyrics', diff: 'line' as const }],
  routes: [],
  context_rules: {},
  delivery: { deliverable_artifact_type: 'lyrics' },
};

describe('Issue lifecycle: claimed_fixed 事件记录（铁律 4）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let toolExecutor: ToolExecutor;

  const caseId = 'case_life';
  const artifactId = 'art_life';
  const v1Id = 'av_v1';
  const issueId = 'issue_life';
  const riId = 'ri_life';

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    toolExecutor = new ToolExecutor(repo, clock, idGen);

    repo.insertCase({
      case_id: caseId, title: 't', status: 'repairing', current_stage: 'repairing',
      scenario_id: 'lifecycle_test', scenario_snapshot: '{}', input_payload: '{}',
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: v1Id, status: 'active', created_at: clock.now(),
    });
    repo.insertArtifactVersion({
      artifact_version_id: v1Id, artifact_id: artifactId, version: 1,
      content: 'line1\nline2\nline3', summary: 'v1',
      source_message_id: null, source_turn_id: null, parent_version_id: null,
      diff: null, content_hash: 'hash_v1', status: 'under_review', approved_at: null, created_at: clock.now(),
    });
    repo.insertIssue({
      issue_id: issueId, case_id: caseId, artifact_version_id: v1Id, evaluation_message_id: 'msg_eval',
      severity: 'blocking', anchor: JSON.stringify({ type: 'line', value: '2' }),
      problem: 'p', evidence: 'e', status: 'repairing',
      resolution_artifact_version_id: null, verified_by_evaluation_id: null,
      created_at: clock.now(), updated_at: clock.now(), closed_at: null,
    });
    repo.insertRevisionInstruction({
      revision_instruction_id: riId, case_id: caseId, target_agent: 'generator',
      target_artifact_version_id: v1Id, issue_ids: JSON.stringify([issueId]),
      editable_anchors: JSON.stringify(['line:2']), frozen_anchors: JSON.stringify(['line:1', 'line:3']),
      status: 'in_progress', source_message_id: 'msg_route', created_at: clock.now(),
    });
  });

  it('publish_artifact 返修时把 issue 移到 claimed_fixed 并追加 issue_event', () => {
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'lyrics', content: 'line1\nline2-fixed\nline3', summary: '修了第2行' },
      { caseId, turnId: 'turn_life', sessionId: 'sess', agentKey: 'generator', messageId: 'msg_out', scenarioConfig: SCENARIO },
    );

    expect(result.success).toBe(true);

    // issue 状态 -> claimed_fixed
    const issue = repo.getIssue(issueId);
    expect(issue?.status).toBe('claimed_fixed');

    // issue_events 必须包含 claimed_fixed（铁律 4：状态变化以事件追加记录）
    const events = repo.getIssueEvents(issueId);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('claimed_fixed');

    // 事件 actor 是返修方 generator
    const claimedEvent = events.find((e) => e.event_type === 'claimed_fixed');
    expect(claimedEvent?.actor).toBe('generator');
  });

  it('越界返修不产生 claimed_fixed 事件（产物版本被 rejected）', () => {
    // 改了 frozen 的第 1 行 -> scope_violation
    const result = toolExecutor.execute(
      'publish_artifact',
      { artifact_type: 'lyrics', content: 'line1-changed\nline2\nline3', summary: '越界改第1行' },
      { caseId, turnId: 'turn_violation', sessionId: 'sess', agentKey: 'generator', messageId: 'msg_out2', scenarioConfig: SCENARIO },
    );

    expect(result.success).toBe(false);

    // issue 仍是 repairing（没到 claimed_fixed）
    const issue = repo.getIssue(issueId);
    expect(issue?.status).toBe('repairing');

    // 没有 claimed_fixed 事件
    const types = repo.getIssueEvents(issueId).map((e) => e.event_type);
    expect(types).not.toContain('claimed_fixed');
  });
});
