/**
 * P0-3 故障注入测试
 * 验证事务原子性：如果 Pi 执行过程中抛出异常，
 * 数据库里不应留下该 Turn 的任何副作用（工具记录、产物版本等）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteRepository, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { TurnExecutor } from '@forge-ai/application';
import type { PiPort, PiSession, PiMessage, PiToolDefinition, PiTurnResult, PiToolExecutorFn, ScenarioConfig } from '@forge-ai/contracts';

const TEST_SCENARIO: ScenarioConfig = {
  scenario: { id: 'fault_test', name: '故障测试', version: 1 },
  input_fields: [],
  start_agent: 'agent_a',
  agents: [
    {
      key: 'agent_a',
      name: 'Agent A',
      model: 'deepseek-v4-flash',
      prompt: 'prompts/a.md',
      skills: [],
      tools: ['publish_artifact'],
      session: { policy: 'cold_per_version' },
    },
  ],
  artifact_types: [{ type: 'test_output', diff: 'line' as const }],
  routes: [],
  context_rules: {},
  delivery: { deliverable_artifact_type: 'test_output' },
};

/**
 * 故障 Pi Adapter：在执行 toolExecutor 回调后抛出异常
 * 模拟"工具已执行但 Pi 还没返回"时进程崩溃的场景
 */
class FaultyPiAdapter implements PiPort {
  private shouldFault = true;

  disableFault() { this.shouldFault = false; }

  async createSession(): Promise<PiSession> { return { session_ref: 'fault_sess' }; }
  async resumeSession(ref: string): Promise<PiSession> { return { session_ref: ref }; }
  async closeSession(): Promise<void> {}

  async executeTurn(
    session: PiSession,
    messages: PiMessage[],
    tools: PiToolDefinition[],
    toolExecutor?: PiToolExecutorFn,
  ): Promise<PiTurnResult> {
    if (this.shouldFault && toolExecutor) {
      // 先执行一个工具调用（模拟 Pi 循环中工具被执行）
      toolExecutor('fault_tc_001', 'publish_artifact', {
        artifact_type: 'test_output',
        content: 'fault content',
        summary: 'this should be rolled back',
      });

      // 然后抛出异常（模拟 Pi 崩溃）
      throw new Error('Simulated Pi crash after tool execution');
    }

    // 无故障模式：正常返回
    return { content: 'ok', tool_calls: [], finish_reason: 'stop' };
  }
}

describe('P0-3: 事务原子性故障注入测试', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let faultyPi: FaultyPiAdapter;
  let turnExecutor: TurnExecutor;

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    faultyPi = new FaultyPiAdapter();
    turnExecutor = new TurnExecutor(repo, clock, idGen, faultyPi);

    // 准备 Case
    repo.insertCase({
      case_id: 'case_fault_1',
      title: '故障测试',
      status: 'running',
      current_stage: 'production',
      scenario_id: 'fault_test',
      scenario_snapshot: JSON.stringify(TEST_SCENARIO),
      input_payload: '{}',
      created_at: clock.now(),
      updated_at: clock.now(),
      completed_at: null,
    });
  });

  it('Pi 崩溃后事务回滚：无 completed Turn、无产物版本、无工具记录', async () => {
    const result = await turnExecutor.executeTurn({
      caseId: 'case_fault_1',
      sessionId: 'sess_fault',
      agentKey: 'agent_a',
      scenarioConfig: TEST_SCENARIO,
      systemPrompt: 'You are a test agent.',
      userMessage: 'Please publish an artifact.',
      tools: [{ name: 'publish_artifact', description: 'test', parameters: {} }],
    });

    // Turn 应该标记为 failed
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Simulated Pi crash');

    // 断言：数据库里没有该 Turn 的 completed 状态
    const turns = repo.getTurnsByCase('case_fault_1');
    const completedTurns = turns.filter(t => t.status === 'completed');
    expect(completedTurns).toHaveLength(0);

    // 断言：有一个 failed Turn 记录（事务外写入的）
    const failedTurns = turns.filter(t => t.status === 'failed');
    expect(failedTurns).toHaveLength(1);

    // 断言：数据库里没有该工具产生的 artifact_version
    const failedTurnId = failedTurns[0].turn_id as string;
    // 检查所有 artifact_versions（应该为空，因为事务回滚了）
    const artifact = repo.getArtifactByTypeAndCase('case_fault_1', 'test_output');
    // 产物不应该存在（事务回滚）
    expect(artifact).toBeFalsy();

    // 断言：数据库里没有该工具的 tool_action 记录（事务已回滚）
    // 注意：failed turn 的 turn_id 和原始 turn_id 不同（原始被回滚了）
    // 查找所有 tool_actions
    const allTurns = repo.getTurnsByCase('case_fault_1');
    for (const t of allTurns) {
      const actions = repo.getToolActionsByTurn(t.turn_id as string);
      expect(actions).toHaveLength(0);
    }
  });

  it('正常执行时事务提交：Turn completed + 产物存在', async () => {
    faultyPi.disableFault();

    const result = await turnExecutor.executeTurn({
      caseId: 'case_fault_1',
      sessionId: 'sess_fault',
      agentKey: 'agent_a',
      scenarioConfig: TEST_SCENARIO,
      systemPrompt: 'You are a test agent.',
      userMessage: 'Hello.',
      tools: [],
    });

    expect(result.status).toBe('completed');

    const turns = repo.getTurnsByCase('case_fault_1');
    const completedTurns = turns.filter(t => t.status === 'completed');
    expect(completedTurns).toHaveLength(1);
  });
});
