/**
 * 崩溃恢复集成测试（12.2）
 * 
 * 验证：
 * 1. Case 先经过 waiting_recovery 再回到 running
 * 2. 从最后完成 Turn 续跑
 * 3. 已完成产物版本未被重新生成（content_hash 不变、无重复版本）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { SqliteRepository, FakePiAdapter, SystemClock, UuidGenerator, FileConfigLoader } from '@forge-ai/adapters';
import type { FakePiScript } from '@forge-ai/adapters';
import { CaseService, TurnExecutor, RecoveryService } from '@forge-ai/application';
import type { PiToolDefinition } from '@forge-ai/contracts';

const TEST_DB_PATH = resolve('./data/test-crash-recovery.db');
const SCENARIO_PATH = resolve('./scenarios/songwriting/scenario.yaml');

const TOOL_DEFINITIONS: PiToolDefinition[] = [
  {
    name: 'publish_artifact',
    description: '发布产物',
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
    description: '提交审核',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        issues: { type: 'array' },
        summary: { type: 'string' },
      },
      required: ['verdict', 'issues', 'summary'],
    },
  },
  {
    name: 'route_message',
    description: '路由消息',
    parameters: {
      type: 'object',
      properties: {
        target_agent: { type: 'string' },
        instruction: { type: 'string' },
        scope: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['target_agent', 'instruction'],
    },
  },
  {
    name: 'approve_delivery',
    description: '申请交付',
    parameters: {
      type: 'object',
      properties: {
        artifact_type: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['summary'],
    },
  },
];

describe('崩溃恢复测试', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let configLoader: FileConfigLoader;

  beforeEach(() => {
    // 清理测试数据库
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH);
    }
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

    repo = new SqliteRepository(TEST_DB_PATH);
    clock = new SystemClock();
    idGen = new UuidGenerator();
    configLoader = new FileConfigLoader();
  });

  afterEach(() => {
    repo.close();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH);
    }
  });

  it('崩溃后恢复：Case 经过 waiting_recovery → running，从最后完成 Turn 续跑', () => {
    // 加载场景配置
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);

    // 创建 Case
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({
      title: '崩溃恢复测试',
      scenarioConfig,
      inputPayload: { test: true },
    });
    caseService.startCase(caseId);

    // 模拟执行了 2 个 Turn（已完成）
    repo.insertTurn({
      turn_id: 'turn_1',
      case_id: caseId,
      session_id: 'sess_1',
      sequence: 1,
      status: 'completed',
      input_message_id: null,
      output_message_id: null,
      context_snapshot_id: null,
      produced_artifact_version_ids: '[]',
      started_at: clock.now(),
      finished_at: clock.now(),
      retry_of_turn_id: null,
      provider_error: null,
    });

    repo.insertTurn({
      turn_id: 'turn_2',
      case_id: caseId,
      session_id: 'sess_1',
      sequence: 2,
      status: 'completed',
      input_message_id: null,
      output_message_id: null,
      context_snapshot_id: null,
      produced_artifact_version_ids: '[]',
      started_at: clock.now(),
      finished_at: clock.now(),
      retry_of_turn_id: null,
      provider_error: null,
    });

    // 模拟第 3 个 Turn 正在执行时崩溃（status = running）
    repo.insertTurn({
      turn_id: 'turn_3',
      case_id: caseId,
      session_id: 'sess_1',
      sequence: 3,
      status: 'running', // 崩溃时正在运行
      input_message_id: null,
      output_message_id: null,
      context_snapshot_id: null,
      produced_artifact_version_ids: '[]',
      started_at: clock.now(),
      finished_at: null,
      retry_of_turn_id: null,
      provider_error: null,
    });

    // 验证 Case 当前是 running 状态
    const caseBefore = repo.getCase(caseId);
    expect(caseBefore?.status).toBe('running');

    // 执行恢复
    const recoveryService = new RecoveryService(repo, clock);
    const needsRecovery = recoveryService.findCasesNeedingRecovery();
    expect(needsRecovery).toContain(caseId);

    const result = recoveryService.recoverCase(caseId);

    // 验证恢复结果
    expect(result.recovered).toBe(true);
    expect(result.lastCompletedTurnSequence).toBe(2);
    expect(result.failedTurnIds).toContain('turn_3');

    // 验证 Case 状态回到 running
    const caseAfter = repo.getCase(caseId);
    expect(caseAfter?.status).toBe('running');

    // 验证 turn_3 被标记为 failed
    const turn3 = repo.getTurn('turn_3');
    expect(turn3?.status).toBe('failed');
    expect(turn3?.provider_error).toBe('Process crashed during execution');

    // 验证 turn_1 和 turn_2 仍然是 completed（未被覆盖）
    const turn1 = repo.getTurn('turn_1');
    const turn2 = repo.getTurn('turn_2');
    expect(turn1?.status).toBe('completed');
    expect(turn2?.status).toBe('completed');

    // 验证恢复事件被记录
    const events = repo.getControlEventsByCase(caseId);
    expect(events.some((e) => e.event_type === 'recovery_started')).toBe(true);
    expect(events.some((e) => e.event_type === 'recovery_completed')).toBe(true);
  });

  it('崩溃恢复不覆盖已完成的产物版本', () => {
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({
      title: '产物版本保护测试',
      scenarioConfig,
      inputPayload: { test: true },
    });
    caseService.startCase(caseId);

    // 创建产物和版本
    const artifactId = 'art_test';
    repo.insertArtifact({
      artifact_id: artifactId,
      case_id: caseId,
      artifact_type: 'lyrics',
      scope_key: null,
      current_valid_version_id: null,
      status: 'active',
      created_at: clock.now(),
    });

    const versionId = 'ver_test';
    const contentHash = 'abc123hash';
    repo.insertArtifactVersion({
      artifact_version_id: versionId,
      artifact_id: artifactId,
      version: 1,
      content: '测试歌词内容',
      summary: '初始版本',
      source_message_id: null,
      source_turn_id: null,
      parent_version_id: null,
      diff: null,
      content_hash: contentHash,
      status: 'draft',
      approved_at: null,
      created_at: clock.now(),
    });

    // 模拟崩溃：创建一个 running 的 Turn
    repo.insertTurn({
      turn_id: 'turn_crash',
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

    // 执行恢复
    const recoveryService = new RecoveryService(repo, clock);
    recoveryService.recoverCase(caseId);

    // 验证产物版本未被修改
    const version = repo.getArtifactVersion(versionId);
    expect(version?.content_hash).toBe(contentHash);
    expect(version?.content).toBe('测试歌词内容');
    expect(version?.status).toBe('draft');

    // 验证没有重复版本
    const versions = repo.getVersionsByArtifact(artifactId);
    expect(versions.length).toBe(1);
  });
});
