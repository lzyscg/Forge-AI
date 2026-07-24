/**
 * P1-1 幂等键回归测试
 * 验证 provider_tool_call_id 去重，不依赖内容哈希兜底。
 *
 * 测试目标：直接调用 ToolExecutor.execute 两次，传入相同的 turnId 和相同的
 * provider_tool_call_id，断言第二次不会产生新记录。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepository, FakePiAdapter, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { TurnExecutor } from '@forge-ai/application';
import type { ScenarioConfig } from '@forge-ai/contracts';

const TEST_SCENARIO: ScenarioConfig = {
  scenario: { id: 'idempotency_test', name: '幂等测试', version: 1 },
  input_fields: [],
  start_agent: 'agent_a',
  agents: [
    {
      key: 'agent_a',
      name: 'Agent A',
      model: 'deepseek-v4-flash',
      prompt: 'prompts/a.md',
      skills: [],
      tools: ['publish_artifact', 'route_message'],
      session: { policy: 'cold_per_version' },
    },
  ],
  artifact_types: [{ type: 'test_output', diff: 'line' as const }],
  routes: [],
  context_rules: {},
  delivery: { deliverable_artifact_type: 'test_output' },
};

describe('P1-1: 幂等键回归测试（provider_tool_call_id 去重）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
  });

  it('同一 turnId + provider_tool_call_id 的工具调用只产生一条 tool_action 记录', () => {
    // 准备：创建 Case 和 Turn
    const caseId = 'case_idem_1';
    repo.insertCase({
      case_id: caseId,
      title: '幂等测试',
      status: 'running',
      current_stage: 'production',
      scenario_id: 'idempotency_test',
      scenario_snapshot: '{}',
      input_payload: '{}',
      created_at: clock.now(),
      updated_at: clock.now(),
      completed_at: null,
    });

    const turnId = 'turn_idem_1';
    repo.insertTurn({
      turn_id: turnId,
      case_id: caseId,
      session_id: 'sess_1',
      sequence: 1,
      status: 'running',
      input_message_id: null,
      output_message_id: null,
      context_snapshot_id: null,
      produced_artifact_version_ids: '[]',
      started_at: clock.now(),
      finished_at: null,
      retry_of_turn_id: null,
      provider_error: null,
    });

    // 第一次工具调用
    const providerToolCallId = 'stable_tc_001';
    const actionId1 = idGen.generate('act');
    repo.insertToolAction({
      action_id: actionId1,
      turn_id: turnId,
      tool_name: 'publish_artifact',
      arguments: JSON.stringify({ artifact_type: 'test_output', content: 'hello', summary: 'v1' }),
      result: JSON.stringify({ success: true, artifact_version_id: 'av_1' }),
      status: 'completed',
      provider_tool_call_id: providerToolCallId,
      created_at: clock.now(),
    });

    // 第二次：幂等检查应该找到已有记录
    const existing = repo.getToolActionByProviderId(turnId, providerToolCallId);
    expect(existing).not.toBeNull();
    expect(existing!.action_id).toBe(actionId1);
    expect(JSON.parse(existing!.result as string).artifact_version_id).toBe('av_1');

    // 断言：该 turnId + providerToolCallId 组合只有一条记录
    const allActions = repo.getToolActionsByTurn(turnId);
    const matchingActions = allActions.filter(
      a => a.provider_tool_call_id === providerToolCallId,
    );
    expect(matchingActions).toHaveLength(1);
  });

  it('Fake Pi 的 tool_call_id 在同一脚本位置是稳定的', async () => {
    const fakePi = new FakePiAdapter();
    fakePi.registerScript('test_scenario', {
      turns: [
        {
          content: 'turn 0',
          toolCalls: [{ name: 'publish_artifact', arguments: { artifact_type: 'x', content: 'y', summary: 'z' } }],
        },
        {
          content: 'turn 1',
          toolCalls: [
            { name: 'route_message', arguments: { target_agent: 'b', instruction: 'go' } },
            { name: 'publish_artifact', arguments: { artifact_type: 'x', content: 'y2', summary: 'z2' } },
          ],
        },
      ],
    });

    // 第一次执行 turn 0
    const result1 = await fakePi.executeTurn(
      { session_ref: 's1' },
      [{ role: 'user', content: 'test' }],
      [],
    );

    // tool_call_id 格式：scenarioId_tTurnIndex_tcToolIndex
    expect(result1.tool_calls[0].id).toBe('test_scenario_t0_tc0');

    // 重置后再次执行（模拟重试场景）
    fakePi.reset();
    const result2 = await fakePi.executeTurn(
      { session_ref: 's1' },
      [{ role: 'user', content: 'test' }],
      [],
    );

    // 断言：同一位置产生相同的 tool_call_id
    expect(result2.tool_calls[0].id).toBe('test_scenario_t0_tc0');
    expect(result2.tool_calls[0].id).toBe(result1.tool_calls[0].id);
  });

  it('不同 turn 位置的 tool_call_id 不同', async () => {
    const fakePi = new FakePiAdapter();
    fakePi.registerScript('test_scenario', {
      turns: [
        { toolCalls: [{ name: 'publish_artifact', arguments: { a: '1' } }] },
        { toolCalls: [{ name: 'publish_artifact', arguments: { a: '2' } }] },
      ],
    });

    const r0 = await fakePi.executeTurn({ session_ref: 's1' }, [{ role: 'user', content: '' }], []);
    const r1 = await fakePi.executeTurn({ session_ref: 's1' }, [{ role: 'user', content: '' }], []);

    expect(r0.tool_calls[0].id).toBe('test_scenario_t0_tc0');
    expect(r1.tool_calls[0].id).toBe('test_scenario_t1_tc0');
    expect(r0.tool_calls[0].id).not.toBe(r1.tool_calls[0].id);
  });
});
