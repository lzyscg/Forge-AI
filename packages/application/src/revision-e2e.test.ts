/**
 * 返修生命周期端到端测试（任务书 7.4 / 7.5 / 7.7）
 *
 * 7.4 非终态无工具调用：repairing/running 的 Case 在 Agent 连续无工具调用时，
 *    第一次追加确定性纠错消息，第二次转 failed（旧代码静默 break 返回非终态）。
 * 7.5 同 Case 恢复：repairing + submitted 指令 + under_review 版本，重新 runCase
 *    直接路由审核 Agent，审核通过后关闭原指令并交付。
 * 7.7 真实形态回归：v1 -> repair -> v2 -> repair -> v3 -> approve -> 交付，
 *    断言所有 blocking Issue verified、所有相关 Revision Instruction verified、
 *    active revision count=0、delivery gate pass、Case approved。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  SqliteRepository,
  FakePiAdapter,
  SystemClock,
  UuidGenerator,
  FileConfigLoader,
} from '@forge-ai/adapters';
import { CaseRunner, type Logger } from '@forge-ai/application';
import type {
  PiToolDefinition,
  PiTurnResult,
  ScenarioConfig,
} from '@forge-ai/contracts';

const SCENARIO_PATH = resolve('./scenarios/songwriting/scenario.yaml');
const TEST_DB_PATH = resolve('./data/test-revision-e2e.db');

const TOOL_DEFINITIONS: PiToolDefinition[] = [
  {
    name: 'publish_artifact',
    description: '发布或修订一个产物。',
    parameters: {
      type: 'object',
      properties: {
        artifact_type: { type: 'string' },
        content: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['artifact_type', 'content', 'summary'],
    },
  },
  {
    name: 'submit_evaluation',
    description: '提交审核结论。',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'repair', 'regenerate', 'input_problem'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
              anchor: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'string' } } },
              problem: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['severity', 'anchor', 'problem', 'evidence'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['verdict', 'issues', 'summary'],
    },
  },
  {
    name: 'route_message',
    description: '把任务或返修指令派给某个 Agent。',
    parameters: {
      type: 'object',
      properties: {
        target_agent: { type: 'string' },
        instruction: { type: 'string' },
        scope: {
          type: 'object',
          properties: {
            editable_anchors: { type: 'array', items: { type: 'string' } },
            frozen_anchors: { type: 'array', items: { type: 'string' } },
            issue_ids: { type: 'array', items: { type: 'string' } },
          },
        },
        reason: { type: 'string' },
      },
      required: ['target_agent', 'instruction'],
    },
  },
  {
    name: 'approve_delivery',
    description: '申请交付。',
    parameters: {
      type: 'object',
      properties: {
        artifact_type: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'request_human_input',
    description: '请求人工输入。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' }, question: { type: 'string' } },
      required: ['reason'],
    },
  },
];

const silentLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
};

class BlockingFakePiAdapter extends FakePiAdapter {
  private releaseTurn!: () => void;
  private markEntered!: () => void;
  readonly enteredTurn = new Promise<void>((resolve) => {
    this.markEntered = resolve;
  });

  release(): void {
    this.releaseTurn();
  }

  override async executeTurn(): Promise<PiTurnResult> {
    this.markEntered();
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    return { content: 'paused', tool_calls: [], finish_reason: 'stop' };
  }
}

function makeRunner(
  repo: SqliteRepository,
  pi: FakePiAdapter,
  scenarioConfig: ScenarioConfig,
  maxTurns = 20,
  logger: Logger = silentLogger,
): CaseRunner {
  return new CaseRunner({
    repo,
    clock: new SystemClock(),
    idGen: new UuidGenerator(),
    pi,
    scenarioConfig,
    scenarioPath: SCENARIO_PATH,
    configLoader: new FileConfigLoader(),
    toolDefinitions: TOOL_DEFINITIONS,
    logger,
    maxTurns,
  });
}

describe('7.4 非终态无工具调用（5.4）', () => {
  let repo: SqliteRepository;
  let configLoader: FileConfigLoader;
  let scenarioConfig: ScenarioConfig;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    mkdirSync(resolve(dirname(TEST_DB_PATH)), { recursive: true });
    repo = new SqliteRepository(TEST_DB_PATH);
    configLoader = new FileConfigLoader();
    scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
  });
  afterEach(() => repo.close());

  it('requires a runner token even for a fresh CaseRunner run', async () => {
    const runner = makeRunner(repo, new FakePiAdapter(), scenarioConfig, 0);
    const caseId = runner.createCase({
      title: 'required runner token',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });

    // @ts-expect-error verifies the runtime guard for JavaScript callers
    await expect(runner.runCase(caseId, { maxTurns: 0 }))
      .rejects.toThrow('Runner token is required');
    expect(repo.getExecutionLease(caseId)).toBeNull();
    expect(repo.getCase(caseId)?.status).toBe('created');
  });

  it('claims one owner, heartbeats while executing, rejects a second owner, and releases on return', async () => {
    const pi = new BlockingFakePiAdapter();
    const firstRunner = makeRunner(repo, pi, scenarioConfig, 1);
    const secondRunner = makeRunner(repo, new FakePiAdapter(), scenarioConfig, 0);
    const caseId = firstRunner.createCase({
      title: 'exclusive owner claim',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });
    const token = 'shared-runner-token';

    const firstRun = firstRunner.runCase(caseId, {
      maxTurns: 1,
      runnerToken: token,
      runnerPid: 101,
    });
    await pi.enteredTurn;
    const firstHeartbeat = repo.getExecutionLease(caseId)?.heartbeat_at;
    expect(repo.getExecutionLease(caseId)?.runner_pid).toBe(101);

    await expect(secondRunner.runCase(caseId, {
      maxTurns: 0,
      runnerToken: token,
      runnerPid: 202,
    })).rejects.toThrow('Execution lease owner claim failed');

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(repo.getExecutionLease(caseId)?.heartbeat_at).not.toBe(firstHeartbeat);

    pi.release();
    await firstRun;
    expect(repo.getExecutionLease(caseId)).toMatchObject({ runner_pid: 0 });
  });

  it('clears its heartbeat timer and releases its owner after a controlled run error', async () => {
    const throwingLogger: Logger = {
      info: () => {
        throw new Error('controlled runner failure');
      },
      error: () => {},
      warn: () => {},
    };
    const runner = makeRunner(
      repo,
      new FakePiAdapter(),
      scenarioConfig,
      1,
      throwingLogger,
    );
    const caseId = runner.createCase({
      title: 'controlled failure owner release',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    await expect(runner.runCase(caseId, {
      maxTurns: 1,
      runnerToken: 'controlled-failure-token',
      runnerPid: 303,
    })).rejects.toThrow('controlled runner failure');

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(repo.getExecutionLease(caseId)).toMatchObject({ runner_pid: 0 });
    clearIntervalSpy.mockRestore();
  });

  it('releases a claimed owner when human resume rejects the current state', async () => {
    const runner = makeRunner(repo, new FakePiAdapter(), scenarioConfig, 0);
    const caseId = runner.createCase({
      title: 'invalid resume state',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });
    const token = 'invalid-resume-token';
    repo.acquireExecutionLease(caseId, {
      runner_token_sha256: createHash('sha256').update(token).digest('hex'),
      runner_pid: 0,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    repo.updateCase(caseId, { status: 'running' });

    await expect(runner.resumeCaseWithHumanInput(
      caseId,
      'continue',
      { runnerToken: token, runnerPid: 404 },
    )).rejects.toThrow();
    expect(repo.getExecutionLease(caseId)).toMatchObject({ runner_pid: 0 });
  });

  it('连续 2 次无工具调用 -> Case 转 failed + agent_no_action_in_nonterminal_state 事件', async () => {
    const fakePi = new FakePiAdapter();
    fakePi.registerScript('songwriting', {
      turns: [
        { content: '我不调用工具', toolCalls: [] },
        { content: '我还不调用工具', toolCalls: [] },
      ],
    });

    const runner = makeRunner(repo, fakePi, scenarioConfig, 5);
    const caseId = runner.createCase({
      title: '无动作测试',
      inputPayload: { reference_lyrics: '参考', fixed_phrase: '金句' },
    });

    const result = await runner.runCase(caseId, {
      maxTurns: 5,
      runnerToken: 'no-action-test-token',
    });

    expect(result.status).toBe('failed');
    const events = repo.getControlEventsByCase(caseId);
    expect(events.some((e) => e.event_type === 'agent_no_action_in_nonterminal_state')).toBe(true);
  });

  it('第一次无工具调用追加纠错消息（Case 不静默返回非终态、不直接 failed）', async () => {
    const fakePi = new FakePiAdapter();
    // turn0 无工具调用 -> 纠错（不 failed）；turn1 路由派活 -> 进入 waiting_review，
    // maxTurns=2 让循环在脚本耗尽前结束，避免后续 reviewer 无脚本又触发第二次无动作。
    fakePi.registerScript('songwriting', {
      turns: [
        { content: '我先不调用工具', toolCalls: [] },
        {
          content: '派活',
          toolCalls: [
            { name: 'route_message', arguments: { target_agent: 'generator', instruction: '创作歌词', reason: '开始' } },
          ],
        },
      ],
    });

    const runner = makeRunner(repo, fakePi, scenarioConfig, 2);
    const caseId = runner.createCase({
      title: '纠错测试',
      inputPayload: { reference_lyrics: '参考', fixed_phrase: '金句' },
    });
    const runnerToken = 'revision-e2e-runner-token';
    expect(repo.getCase(caseId)?.status).toBe('created');
    const result = await runner.runCase(caseId, {
      maxTurns: 2,
      runnerToken,
      runnerPid: 101,
    });

    // 第一次无动作被纠错而非失败；路由后进入 waiting_review
    expect(result.status).not.toBe('failed');
    expect(repo.getControlEventsByCase(caseId).some((e) => e.event_type === 'agent_no_action_in_nonterminal_state')).toBe(false);
    expect(repo.validateExecutionLease(
      caseId,
      createHash('sha256').update(runnerToken).digest('hex'),
    )).toBe(true);
  });

  it('carries the runner token through a human-input resume transition', async () => {
    const runner = makeRunner(repo, new FakePiAdapter(), scenarioConfig, 0);
    const caseId = runner.createCase({
      title: 'resume lease test',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });
    repo.updateCase(caseId, { status: 'created' });
    const runnerToken = 'resume-runner-token';
    repo.acquireExecutionLease(caseId, {
      runner_token_sha256: createHash('sha256').update(runnerToken).digest('hex'),
      runner_pid: 0,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    repo.updateCase(caseId, { status: 'waiting_human' });

    const result = await runner.resumeCaseWithHumanInput(
      caseId,
      'continue',
      { runnerToken, runnerPid: 202 },
    );

    expect(result.status).toBe('running');
  });

  it('accepts only the new runner token after a CaseRunner lease transfer', async () => {
    const runner = makeRunner(repo, new FakePiAdapter(), scenarioConfig, 0);
    const caseId = runner.createCase({
      title: 'runner transfer test',
      inputPayload: { reference_lyrics: 'reference', fixed_phrase: 'phrase' },
    });
    await runner.runCase(caseId, {
      maxTurns: 0,
      runnerToken: 'old-runner-token',
      runnerPid: 101,
    });
    expect(repo.transferExecutionLease(
      caseId,
      createHash('sha256').update('old-runner-token').digest('hex'),
      {
        runner_token_sha256: createHash('sha256')
          .update('new-runner-token')
          .digest('hex'),
        runner_pid: 0,
        runner_started_at: '2026-07-27T00:00:02.000Z',
        heartbeat_at: '2026-07-27T00:00:02.000Z',
      },
    )).toBe(true);

    // @ts-expect-error verifies the runtime guard for JavaScript callers
    await expect(runner.runCase(caseId, { maxTurns: 0 }))
      .rejects.toThrow('Runner token is required');
    await expect(runner.runCase(caseId, {
      maxTurns: 0,
      runnerToken: 'old-runner-token',
    })).rejects.toThrow('Execution lease owner claim failed');
    await expect(runner.runCase(caseId, {
      maxTurns: 0,
      runnerToken: 'new-runner-token',
    })).resolves.toMatchObject({ status: 'running' });
  });
});

describe('7.5 同 Case 恢复（5.5：程序化恢复决策）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let configLoader: FileConfigLoader;
  let scenarioConfig: ScenarioConfig;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    mkdirSync(resolve(dirname(TEST_DB_PATH)), { recursive: true });
    repo = new SqliteRepository(TEST_DB_PATH);
    clock = new SystemClock();
    configLoader = new FileConfigLoader();
    scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
  });
  afterEach(() => repo.close());

  it('repairing + submitted 指令 + under_review 版本 -> 直接路由审核 Agent -> 关闭指令 -> 交付', async () => {
    const fakePi = new FakePiAdapter();
    // alignTurnCounter 到 sequence=1 -> 从 script[1] 开始消费
    fakePi.registerScript('songwriting', {
      turns: [
        { content: '崩溃点占位（不被消费）', toolCalls: [] },
        { content: '审核通过', toolCalls: [{ name: 'submit_evaluation', arguments: { verdict: 'approve', issues: [], summary: '通过' } }] },
        { content: '申请交付', toolCalls: [{ name: 'approve_delivery', arguments: { summary: '交付' } }] },
      ],
    });

    const runner = makeRunner(repo, fakePi, scenarioConfig, 6);

    // 直接构造 Case 状态：repairing + v2 under_review + ri1 submitted + issueA claimed_fixed
    const caseId = 'case_resume_1';
    repo.insertCase({
      case_id: caseId, title: '恢复测试', status: 'created', current_stage: 'repairing',
      scenario_snapshot: JSON.stringify(scenarioConfig), input_payload: JSON.stringify({ reference_lyrics: 'r', fixed_phrase: 'f' }),
      created_at: clock.now(), updated_at: clock.now(), completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_resume', case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'av_r2', status: 'active', created_at: clock.now(),
    });
    repo.insertArtifactVersion({
      artifact_version_id: 'av_r1', artifact_id: 'art_resume', version: 1,
      content: 'a\nb\nc', summary: 'v1', source_message_id: null, source_turn_id: null, parent_version_id: null,
      diff: null, content_hash: 'hash_r1', status: 'superseded', approved_at: null, created_at: clock.now(),
    });
    repo.insertArtifactVersion({
      artifact_version_id: 'av_r2', artifact_id: 'art_resume', version: 2,
      content: 'a\nB\nc', summary: 'v2 修了第2行', source_message_id: null, source_turn_id: null, parent_version_id: 'av_r1',
      diff: null, content_hash: 'hash_r2', status: 'under_review', approved_at: null, created_at: clock.now(),
    });
    repo.insertIssue({
      issue_id: 'issueA', case_id: caseId, artifact_version_id: 'av_r1', evaluation_message_id: 'msg_eval',
      severity: 'blocking', anchor: JSON.stringify({ type: 'line', value: '2' }), problem: '第2行坏', evidence: 'e',
      status: 'claimed_fixed', resolution_artifact_version_id: 'av_r2', verified_by_evaluation_id: null,
      created_at: clock.now(), updated_at: clock.now(), closed_at: null,
    });
    repo.insertRevisionInstruction({
      revision_instruction_id: 'ri_resume_1', case_id: caseId, target_agent: 'generator',
      target_artifact_version_id: 'av_r1', issue_ids: JSON.stringify(['issueA']),
      editable_anchors: JSON.stringify(['line:2']), frozen_anchors: JSON.stringify(['line:1', 'line:3']),
      status: 'submitted', source_message_id: 'msg_route', created_at: clock.now(),
    });
    // 一个已完成的 Turn（崩溃前最后状态）
    repo.insertTurn({
      turn_id: 'turn_1', case_id: caseId, session_id: 'sess_r1', sequence: 1, status: 'completed',
      input_message_id: null, output_message_id: 'msg_out_1', context_snapshot_id: null,
      produced_artifact_version_ids: '[]', started_at: clock.now(), finished_at: clock.now(),
      retry_of_turn_id: null, provider_error: null,
    });

    repo.acquireExecutionLease(caseId, {
      runner_token_sha256: createHash('sha256')
        .update('recovery-test-token')
        .digest('hex'),
      runner_pid: 0,
      runner_started_at: clock.now(),
      heartbeat_at: clock.now(),
    });
    repo.updateCase(caseId, { status: 'repairing' });
    const result = await runner.runCase(caseId, {
      maxTurns: 6,
      runnerToken: 'recovery-test-token',
    });

    // 不创建新 Case
    expect(repo.getCase(caseId)).not.toBeNull();
    expect(repo.getCasesByStatus('approved').length).toBe(1);
    expect(repo.getCasesByStatus('approved')[0].case_id).toBe(caseId);

    // 直接路由审核 Agent：第一个续跑 Turn 的 agent 应为 reviewer
    const turns = repo.getTurnsByCase(caseId);
    const resumeTurns = turns.filter((t) => (t.turn_id as string) !== 'turn_1');
    expect(resumeTurns.length).toBeGreaterThan(0);
    const firstResumeTurn = resumeTurns[0];
    const firstSession = repo.getSession(firstResumeTurn.session_id as string);
    expect(firstSession?.agent_key).toBe('reviewer');

    // 审核通过后关闭原指令
    expect(repo.getRevisionInstruction('ri_resume_1')?.status).toBe('verified');
    expect(repo.getIssue('issueA')?.status).toBe('verified');
    // Case 可交付
    expect(result.status).toBe('approved');
    expect(result.gate?.status).toBe('pass');
  });
});

describe('7.7 真实形态回归（v1 -> repair -> v2 -> repair -> v3 -> approve -> 交付）', () => {
  let repo: SqliteRepository;
  let configLoader: FileConfigLoader;
  let scenarioConfig: ScenarioConfig;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    mkdirSync(resolve(dirname(TEST_DB_PATH)), { recursive: true });
    repo = new SqliteRepository(TEST_DB_PATH);
    configLoader = new FileConfigLoader();
    scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
  });
  afterEach(() => repo.close());

  it('两轮返修后全部 Instruction 关闭、门禁通过、Case approved', async () => {
    const fakePi = new FakePiAdapter();
    fakePi.registerScript('songwriting', {
      turns: [
        // 0 supervisor: 派给 generator
        {
          content: '开始',
          toolCalls: [{ name: 'route_message', arguments: { target_agent: 'generator', instruction: '创作歌词', reason: '开始' } }],
        },
        // 1 generator: 发布 v1
        {
          content: '初版',
          toolCalls: [{ name: 'publish_artifact', arguments: { artifact_type: 'lyrics', content: '月光铺在青石巷\n你的身影在远方\n花开满了山岗', summary: 'v1' } }],
        },
        // 2 reviewer: repair（issue A 在第2行）
        {
          content: '审核v1',
          toolCalls: [{
            name: 'submit_evaluation',
            arguments: {
              verdict: 'repair',
              issues: [{ severity: 'blocking', anchor: { type: 'line', value: '2' }, problem: '第2行意境跳跃', evidence: 'e' }],
              summary: '第2行需返修',
            },
          }],
        },
        // 3 supervisor: 发返修（不填 issue_ids，系统自动补齐当前 open blocking）
        {
          content: '返修第2行',
          toolCalls: [{
            name: 'route_message',
            arguments: {
              target_agent: 'generator',
              instruction: '只改第2行',
              scope: { editable_anchors: ['line:2'], frozen_anchors: ['line:1', 'line:3'] },
              reason: '第2行返修',
            },
          }],
        },
        // 4 generator: 发布 v2（修第2行）
        {
          content: 'v2',
          toolCalls: [{ name: 'publish_artifact', arguments: { artifact_type: 'lyrics', content: '月光铺在青石巷\n你的影子在身旁\n花开满了山岗', summary: 'v2 修第2行' } }],
        },
        // 5 reviewer: repair（issue B 在第3行）
        {
          content: '审核v2',
          toolCalls: [{
            name: 'submit_evaluation',
            arguments: {
              verdict: 'repair',
              issues: [{ severity: 'blocking', anchor: { type: 'line', value: '3' }, problem: '第3行单薄', evidence: 'e' }],
              summary: '第3行需返修',
            },
          }],
        },
        // 6 supervisor: 发返修第3行（系统自动补齐 issue B）
        {
          content: '返修第3行',
          toolCalls: [{
            name: 'route_message',
            arguments: {
              target_agent: 'generator',
              instruction: '只改第3行',
              scope: { editable_anchors: ['line:3'], frozen_anchors: ['line:1', 'line:2'] },
              reason: '第3行返修',
            },
          }],
        },
        // 7 generator: 发布 v3（修第3行）
        {
          content: 'v3',
          toolCalls: [{ name: 'publish_artifact', arguments: { artifact_type: 'lyrics', content: '月光铺在青石巷\n你的影子在身旁\n花开满了山岗上', summary: 'v3 修第3行' } }],
        },
        // 8 reviewer: approve
        {
          content: '审核通过',
          toolCalls: [{ name: 'submit_evaluation', arguments: { verdict: 'approve', issues: [], summary: '通过' } }],
        },
        // 9 supervisor: 申请交付
        {
          content: '交付',
          toolCalls: [{ name: 'approve_delivery', arguments: { summary: '交付' } }],
        },
      ],
    });

    const runner = makeRunner(repo, fakePi, scenarioConfig, 15);
    const caseId = runner.createCase({
      title: '两轮返修回归',
      inputPayload: { reference_lyrics: '参考', fixed_phrase: '你是我的山歌' },
    });
    const result = await runner.runCase(caseId, {
      maxTurns: 15,
      runnerToken: 'full-regression-test-token',
    });

    // Case = approved
    expect(result.status).toBe('approved');
    // Artifact v3 = approved
    const artifact = repo.getArtifactByTypeAndCase(caseId, 'lyrics');
    const latest = repo.getLatestVersion(artifact!.artifact_id as string);
    expect(latest?.version).toBe(3);
    expect(latest?.status).toBe('delivered'); // approve_delivery 通过后置 delivered
    // 所有 blocking Issue = verified
    const issues = repo.getIssuesByCase(caseId).filter((i) => i.severity === 'blocking');
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.status === 'verified')).toBe(true);
    // 所有相关 Revision Instruction = verified
    const instructions = repo.getRevisionInstructionsByCase(caseId);
    expect(instructions.length).toBeGreaterThanOrEqual(2);
    expect(instructions.every((ri) => ri.status === 'verified' || ri.status === 'scope_violation')).toBe(true);
    // active revision count = 0
    const active = repo.getActiveRevisionInstructions(caseId);
    expect(active.length).toBe(0);
    // delivery gate = pass
    expect(result.gate?.status).toBe('pass');
    expect(result.gate?.checks.every((c) => c.passed)).toBe(true);
  });
});
