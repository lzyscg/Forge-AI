/**
 * 崩溃恢复集成测试（12.2）
 *
 * 关键背景：Turn 是事务化原子提交的（P0-3），崩溃时正在执行的 Turn 会随进程死亡
 * 回滚，不会残留 running 状态的 Turn。所以恢复不能依赖 incomplete turn 来触发，
 * 而要看 Case 是否处于运行中状态（running/waiting_review/repairing）。
 *
 * 验证：
 * 1. Case 先经过 waiting_recovery 再回到 running（recovery_started/completed 事件）
 * 2. 从最后完成 Turn 续跑（lastCompletedTurnSequence 正确）
 * 3. 已完成 Turn / 产物版本未被覆盖
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { SqliteRepository, SystemClock, UuidGenerator, FileConfigLoader } from '@forge-ai/adapters';
import { CaseService, RecoveryService } from '@forge-ai/application';

const TEST_DB_PATH = resolve('./data/test-crash-recovery.db');
const SCENARIO_PATH = resolve('./scenarios/songwriting/scenario.yaml');

describe('崩溃恢复测试（真实事务化场景）', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;
  let configLoader: FileConfigLoader;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
    repo = new SqliteRepository(TEST_DB_PATH);
    clock = new SystemClock();
    idGen = new UuidGenerator();
    configLoader = new FileConfigLoader();
  });

  afterEach(() => {
    repo.close();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
  });

  it('Case=running + 已完成 Turn，无 incomplete turn 残留时仍触发恢复（事务化崩溃的真实形态）', () => {
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({ title: '崩溃恢复', scenarioConfig, inputPayload: { test: true } });
    caseService.startCase(caseId);

    // 模拟跑完了 2 个 Turn（已 commit），第 3 个 Turn 执行中崩溃 -> 事务回滚，不残留
    for (let i = 1; i <= 2; i++) {
      repo.insertTurn({
        turn_id: `turn_${i}`, case_id: caseId, session_id: 'sess_1', sequence: i,
        status: 'completed', input_message_id: null, output_message_id: `msg_out_${i}`,
        context_snapshot_id: null, produced_artifact_version_ids: '[]',
        started_at: clock.now(), finished_at: clock.now(), retry_of_turn_id: null, provider_error: null,
      });
    }
    // 注意：没有 turn_3（事务回滚不残留）-- 这是 P0-3 事务化后的真实崩溃磁盘状态

    expect(repo.getCase(caseId)?.status).toBe('running');
    expect(repo.getIncompleteTurns(caseId)).toHaveLength(0); // 真实事务化下无 incomplete turn

    const recoveryService = new RecoveryService(repo, clock);
    expect(recoveryService.findCasesNeedingRecovery()).toContain(caseId);

    const result = recoveryService.recoverCase(caseId);

    // 恢复成功，从最后完成 Turn（sequence=2）续跑
    expect(result.recovered).toBe(true);
    expect(result.lastCompletedTurnSequence).toBe(2);

    // Case 经过 waiting_recovery 回到 running
    expect(repo.getCase(caseId)?.status).toBe('running');
    const events = repo.getControlEventsByCase(caseId);
    expect(events.some((e) => e.event_type === 'recovery_started')).toBe(true);
    expect(events.some((e) => e.event_type === 'recovery_completed')).toBe(true);

    // 已完成 Turn 未被覆盖
    expect(repo.getTurn('turn_1')?.status).toBe('completed');
    expect(repo.getTurn('turn_2')?.status).toBe('completed');
  });

  it('waiting_review 状态的 Case 也能被恢复（经 running -> waiting_recovery -> running）', () => {
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({ title: 'waiting_review 恢复', scenarioConfig, inputPayload: {} });
    caseService.startCase(caseId);
    // 崩溃时 Case 卡在 waiting_review（例如产物已发布、等审核时进程挂了）
    caseService.transitionCaseStatus(caseId, 'waiting_review');
    repo.insertTurn({
      turn_id: 'turn_1', case_id: caseId, session_id: 'sess_1', sequence: 1,
      status: 'completed', input_message_id: null, output_message_id: 'msg_1',
      context_snapshot_id: null, produced_artifact_version_ids: '[]',
      started_at: clock.now(), finished_at: clock.now(), retry_of_turn_id: null, provider_error: null,
    });

    const recoveryService = new RecoveryService(repo, clock);
    expect(recoveryService.findCasesNeedingRecovery()).toContain(caseId);
    const result = recoveryService.recoverCase(caseId);
    expect(result.recovered).toBe(true);
    expect(repo.getCase(caseId)?.status).toBe('running');
  });

  it('崩溃恢复不覆盖已完成的产物版本', () => {
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({ title: '产物保护', scenarioConfig, inputPayload: {} });
    caseService.startCase(caseId);

    const artifactId = 'art_test';
    const contentHash = 'abc123hash';
    repo.insertArtifact({
      artifact_id: artifactId, case_id: caseId, artifact_type: 'lyrics',
      scope_key: null, current_valid_version_id: 'ver_test', status: 'active', created_at: clock.now(),
    });
    repo.insertArtifactVersion({
      artifact_version_id: 'ver_test', artifact_id: artifactId, version: 1,
      content: '测试歌词内容', summary: 'v1', source_message_id: null, source_turn_id: null,
      parent_version_id: null, diff: null, content_hash: contentHash, status: 'draft',
      approved_at: null, created_at: clock.now(),
    });

    new RecoveryService(repo, clock).recoverCase(caseId);

    const version = repo.getArtifactVersion('ver_test');
    expect(version?.content_hash).toBe(contentHash);
    expect(version?.content).toBe('测试歌词内容');
    expect(repo.getVersionsByArtifact(artifactId)).toHaveLength(1);
  });

  it('若存在残留的 running Turn（非事务化路径），恢复时标记为 failed', () => {
    // 边缘情况：Turn 状态在事务外被设为 running 的罕见路径（如未来非事务化写入）
    const scenarioConfig = configLoader.loadScenario(SCENARIO_PATH);
    const caseService = new CaseService(repo, clock, idGen);
    const caseId = caseService.createCase({ title: '残留 running', scenarioConfig, inputPayload: {} });
    caseService.startCase(caseId);
    repo.insertTurn({
      turn_id: 'turn_running', case_id: caseId, session_id: 'sess_1', sequence: 1,
      status: 'running', input_message_id: null, output_message_id: null,
      context_snapshot_id: null, produced_artifact_version_ids: '[]',
      started_at: clock.now(), finished_at: null, retry_of_turn_id: null, provider_error: null,
    });

    const result = new RecoveryService(repo, clock).recoverCase(caseId);
    expect(result.failedTurnIds).toContain('turn_running');
    expect(repo.getTurn('turn_running')?.status).toBe('failed');
  });
});
