import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
