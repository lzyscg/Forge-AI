import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeScenarioBundleSha256,
  FileConfigLoader,
  SqliteRepository,
} from '@forge-ai/adapters';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Worker execution identity', () => {
  it('injects the source bundle identity into versions produced by Fake Pi', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-identity-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'worker.db');
    const scenarioPath = resolve('scenarios/copywriting/scenario.yaml');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve('apps/worker/src/main.ts')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          DB_PATH: dbPath,
          PI_MODE: 'fake',
          SCENARIO_PATH: scenarioPath,
          MAX_TURNS: '10',
          FORGE_RUNNER_TOKEN: 'worker-approved-secret-token',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const config = new FileConfigLoader().loadScenario(scenarioPath);
    const expectedBundle = computeScenarioBundleSha256(scenarioPath, config);
    const repo = new SqliteRepository(dbPath);
    try {
      const approvedCases = repo.getCasesByStatus('approved');
      expect(approvedCases).toHaveLength(1);
      expect(repo.getExecutionLease(approvedCases[0].case_id as string)).toBeNull();
      const artifact = repo.getArtifactByTypeAndCase(
        approvedCases[0].case_id as string,
        config.delivery.deliverable_artifact_type,
      );
      expect(artifact).not.toBeNull();
      const versions = repo.getVersionsByArtifact(artifact!.artifact_id as string);
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every(
        (version) => version.template_bundle_sha256 === expectedBundle,
      )).toBe(true);
    } finally {
      repo.close();
    }
  });

  it('requires an explicit runner token', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-token-required-'));
    temporaryDirectories.push(directory);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve('apps/worker/src/main.ts')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          DB_PATH: join(directory, 'worker.db'),
          PI_MODE: 'fake',
          SCENARIO_PATH: resolve('scenarios/copywriting/scenario.yaml'),
          MAX_TURNS: '0',
          FORGE_RUNNER_TOKEN: '',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'FORGE_RUNNER_TOKEN is required',
    );
  });

  it('uses the secret token without logging or persisting plaintext and releases a nonterminal owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-lease-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'worker.db');
    const token = 'worker-nonterminal-secret-token';
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve('apps/worker/src/main.ts')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          DB_PATH: dbPath,
          PI_MODE: 'fake',
          SCENARIO_PATH: resolve('scenarios/copywriting/scenario.yaml'),
          MAX_TURNS: '0',
          FORGE_RUNNER_TOKEN: token,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readFileSync(dbPath).includes(Buffer.from(token))).toBe(false);

    const repo = new SqliteRepository(dbPath);
    try {
      const runningCases = repo.getCasesByStatus('running');
      expect(runningCases).toHaveLength(1);
      expect(repo.getExecutionLease(runningCases[0].case_id as string)).toEqual({
        runner_token_sha256: createHash('sha256').update(token).digest('hex'),
        runner_pid: 0,
        runner_started_at: expect.any(String),
        heartbeat_at: expect.any(String),
      });
    } finally {
      repo.close();
    }
  });

  it('fails closed on a claimed recovery lease with an actionable transfer hint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-worker-recovery-owner-'));
    temporaryDirectories.push(directory);
    const dbPath = join(directory, 'worker.db');
    const scenarioPath = resolve('scenarios/copywriting/scenario.yaml');
    const config = new FileConfigLoader().loadScenario(scenarioPath);
    const token = 'worker-recovery-secret-token';
    const repo = new SqliteRepository(dbPath);
    repo.insertCase({
      case_id: 'case-recovery-owned',
      title: 'owned recovery case',
      status: 'created',
      current_stage: 'init',
      scenario_id: config.scenario.id,
      scenario_snapshot: JSON.stringify(config),
      input_payload: '{}',
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
      completed_at: null,
    });
    repo.acquireExecutionLease('case-recovery-owned', {
      runner_token_sha256: createHash('sha256').update(token).digest('hex'),
      runner_pid: 999,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    repo.updateCase('case-recovery-owned', { status: 'running' });
    repo.close();

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve('apps/worker/src/main.ts')],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          DB_PATH: dbPath,
          PI_MODE: 'fake',
          SCENARIO_PATH: scenarioPath,
          MAX_TURNS: '0',
          FORGE_RUNNER_TOKEN: token,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('case transfer-lease');
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    const observer = new SqliteRepository(dbPath);
    expect(observer.getExecutionLease('case-recovery-owned')?.runner_pid)
      .toBe(999);
    observer.close();
  });
});
