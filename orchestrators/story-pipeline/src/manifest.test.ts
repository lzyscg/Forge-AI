import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendManifestEvent,
  clearRunnerCredential,
  initializeManifest,
  loadManifest,
  persistRunnerCredential,
  saveManifestCas,
  type PipelineManifestV21,
  type StageAttemptV21,
} from './manifest.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempManifestPath(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-manifest-'));
  roots.push(root);
  return { root, path: join(root, 'manifest.json') };
}

function emptyManifest(): PipelineManifestV21 {
  return {
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'test',
    mode: 'imitation',
    config_sha256: 'config-hash',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundary-hash',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    stages: [],
    attempts: [],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
}

function appendTestEvent(manifest: PipelineManifestV21, reason: string): void {
  appendManifestEvent(manifest, {
    at: '2026-07-27T00:00:01.000Z',
    type: 'attempt_outcome_changed',
    stage_key: 'stage-1',
    attempt_id: 'attempt-1',
    before_outcome: 'running',
    after_outcome: 'interrupted',
    case_id: 'case-1',
    artifact_id: null,
    artifact_version: null,
    version_id: null,
    record_id: null,
    reason,
    actor: 'story-pipeline',
  });
}

function runningAttempt(): StageAttemptV21 {
  return {
    attempt_id: 'attempt-1',
    stage_key: 'stage-1',
    stage: 'generic-stage',
    chapter_id: null,
    template: 'generic-template',
    expected_artifact_type: 'generic-artifact',
    expected_scenario_snapshot_sha256: 'scenario-snapshot-hash',
    case_id: 'case-1',
    input_sha256: 'input-hash',
    parent_record_ids: [],
    template_identity: {
      algorithm: 'source-tree-sha256-v2',
      content_sha256: 'template-hash',
      equivalence: 'verified',
    },
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome: 'running',
    input_path: 'inputs/stage-1.json',
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    detail: null,
  };
}

interface RaceResult {
  worker: string;
  status: 'created' | 'reloaded' | 'committed' | 'conflict';
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for worker readiness');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runProcessRace(
  mode: 'initialize' | 'cas',
  manifestPath: string,
): Promise<RaceResult[]> {
  const root = dirname(manifestPath);
  const gatePath = join(root, `${mode}.gate`);
  const workerPath = fileURLToPath(new URL('./manifest-race-worker.ts', import.meta.url));
  const workers = ['one', 'two'].map((worker) => {
    const readyPath = join(root, `${mode}.${worker}.ready`);
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      workerPath,
      mode,
      manifestPath,
      worker,
      readyPath,
      gatePath,
    ], {
      cwd: process.cwd(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const completed = new Promise<RaceResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`race worker ${worker} exited ${String(code)}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout.trim()) as RaceResult);
      });
    });
    return { readyPath, completed };
  });
  await waitUntil(() => workers.every(({ readyPath }) => existsSync(readyPath)));
  writeFileSync(gatePath, 'go', 'utf8');
  return Promise.all(workers.map(({ completed }) => completed));
}

describe('loadManifest', () => {
  it('migrates schema 2.0 identities without dropping its hashed events', () => {
    const { path } = tempManifestPath();
    const legacyEvent = {
      sequence: 1,
      at: '2026-07-27T00:00:00.000Z',
      type: 'stage_started',
      stage_key: 'stage-1',
      case_id: 'case-1',
      record_id: null,
      detail: 'started',
      previous_event_sha256: null,
      event_sha256: '489843559a5f6ea61cdab4683f0923a8b1ac8d9c1f499074bc9f79b35aca7675',
    };
    writeFileSync(path, `${JSON.stringify({
      ...emptyManifest(),
      schema_version: '2.0',
      revision: undefined,
      previous_manifest_sha256: undefined,
      reinstatements: undefined,
      replacements: undefined,
      stages: [{
        record_id: 'stage-1-v1',
        revision: 1,
        stage_key: 'stage-1',
        stage: 'generic-stage',
        chapter_id: null,
        template: 'generic-template',
        template_sha256: 'legacy-stage-template-hash',
        case_id: 'case-1',
        parent_record_ids: [],
        parent_case_ids: [],
        status: 'delivered',
        input_path: 'inputs/stage-1.json',
        input_sha256: 'input-hash',
        raw_artifact_path: 'raw/stage-1.md',
        raw_artifact_sha256: 'raw-hash',
        artifact_path: 'artifacts/stage-1.md',
        artifact_sha256: 'artifact-hash',
        sidecar_path: 'structured/stage-1.json',
        sidecar_sha256: 'sidecar-hash',
        validation_report_path: 'validation/stage-1.json',
        validation_report_sha256: 'validation-hash',
        artifact_type: 'generic-artifact',
        artifact_version: 1,
        completed_at: '2026-07-27T00:00:02.000Z',
      }],
      attempts: [{
        attempt_id: 'attempt-1',
        stage_key: 'stage-1',
        case_id: 'case-1',
        input_sha256: 'input-hash',
        template_sha256: 'legacy-attempt-template-hash',
        outcome: 'running',
        input_path: 'inputs/stage-1.json',
        raw_artifact_path: null,
        validation_report_path: null,
        started_at: '2026-07-27T00:00:00.000Z',
        updated_at: '2026-07-27T00:00:00.000Z',
        detail: null,
      }],
      events: [legacyEvent],
    }, null, 2)}\n`, 'utf8');

    const migrated = loadManifest(path);

    expect(migrated.schema_version).toBe('2.1');
    expect(migrated.revision).toBe(0);
    expect(migrated.events).toEqual([legacyEvent]);
    expect(migrated.stages[0]?.template_identity).toEqual({
      algorithm: 'legacy-unversioned-v1',
      content_sha256: 'legacy-stage-template-hash',
      equivalence: 'unknown',
    });
    expect(migrated.attempts[0]?.template_identity).toEqual({
      algorithm: 'legacy-unversioned-v1',
      content_sha256: 'legacy-attempt-template-hash',
      equivalence: 'unknown',
    });
    expect(
      migrated.attempts[0]?.expected_scenario_snapshot_sha256,
    ).toBeNull();
  });

  it('marks a pre-field schema 2.1 attempt scenario identity as unavailable', () => {
    const { path } = tempManifestPath();
    const persisted = emptyManifest();
    const legacyAttempt = runningAttempt();
    delete (legacyAttempt as Partial<StageAttemptV21>)
      .expected_scenario_snapshot_sha256;
    persisted.attempts.push(legacyAttempt);
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    const loaded = loadManifest(path);

    expect(
      loaded.attempts[0]?.expected_scenario_snapshot_sha256,
    ).toBeNull();
  });
});

describe('saveManifestCas', () => {
  it('allows only one writer to commit the same expected revision', () => {
    const { path } = tempManifestPath();
    writeFileSync(path, `${JSON.stringify(emptyManifest(), null, 2)}\n`, 'utf8');

    const committed = saveManifestCas(path, 0, (latest) => {
      appendTestEvent(latest, 'first writer');
    });

    expect(committed.revision).toBe(1);
    expect(() => saveManifestCas(path, 0, (latest) => {
      appendTestEvent(latest, 'stale writer');
    })).toThrow(/revision.*expected 0.*actual 1/i);
    const reloaded = loadManifest(path);
    expect(reloaded.revision).toBe(1);
    expect(reloaded.events).toHaveLength(1);
    expect(reloaded.events[0]?.reason).toBe('first writer');
  });

  it('serializes independent processes competing on the same revision without losing events', async () => {
    const { path } = tempManifestPath();
    initializeManifest(path, emptyManifest);

    const results = await runProcessRace('cas', path);

    expect(results.map(({ status }) => status).sort()).toEqual(['committed', 'conflict']);
    const committedWorker = results.find(({ status }) => status === 'committed')!.worker;
    const reloaded = loadManifest(path);
    expect(reloaded.revision).toBe(1);
    expect(reloaded.events.map(({ type }) => type)).toEqual([
      'manifest_created',
      'attempt_outcome_changed',
    ]);
    expect(reloaded.events[1]?.reason).toBe(`worker ${committedWorker}`);
  }, 15_000);

  it('keeps the committed file and removes the temporary file when rename fails', () => {
    const { root, path } = tempManifestPath();
    const original = `${JSON.stringify(emptyManifest(), null, 2)}\n`;
    writeFileSync(path, original, 'utf8');
    const removed: string[] = [];

    expect(() => saveManifestCas(path, 0, (latest) => {
      appendTestEvent(latest, 'rename will fail');
    }, {
      fsyncFile() {},
      rename() {
        throw new Error('simulated rename failure');
      },
      remove(target) {
        removed.push(target);
        rmSync(target, { force: true });
      },
    })).toThrow('simulated rename failure');

    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0]!)).toBe(false);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('initializeManifest', () => {
  it('atomically creates once while a concurrent process reloads the committed manifest', async () => {
    const { path } = tempManifestPath();

    const results = await runProcessRace('initialize', path);

    expect(results.map(({ status }) => status).sort()).toEqual(['created', 'reloaded']);
    const manifest = loadManifest(path);
    expect(manifest.revision).toBe(0);
    expect(manifest.events).toHaveLength(1);
    expect(manifest.events[0]).toMatchObject({
      type: 'manifest_created',
      attempt_id: null,
      before_outcome: null,
      after_outcome: null,
      case_id: null,
      artifact_id: null,
      artifact_version: null,
      version_id: null,
      record_id: null,
      reason: 'manifest initialized',
    });
  }, 15_000);
});

describe('runner credentials', () => {
  it('stores only token identity in the manifest and removes the credential at terminal outcome', () => {
    const { root } = tempManifestPath();
    const attempt = runningAttempt();

    persistRunnerCredential(root, attempt, 'secret-runner-token');

    const credentialPath = join(root, attempt.runner_credential_path!);
    expect(readFileSync(credentialPath, 'utf8')).toBe('secret-runner-token');
    expect(attempt.runner_token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(attempt)).not.toContain('secret-runner-token');
    if (process.platform !== 'win32') {
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    }

    attempt.outcome = 'delivered';
    clearRunnerCredential(root, attempt);
    expect(existsSync(credentialPath)).toBe(false);
    expect(attempt.runner_credential_path).toBeNull();
  });

  it('fails closed without leaving a token when Windows ACL restriction fails', () => {
    const { root } = tempManifestPath();
    const attempt = runningAttempt();
    let aclCalls = 0;

    expect(() => persistRunnerCredential(root, attempt, 'secret-runner-token', {
      platform: 'win32',
      restrictWindowsAcl() {
        aclCalls += 1;
        if (aclCalls === 3) throw new Error('simulated ACL failure');
      },
    })).toThrow('simulated ACL failure');

    expect(aclCalls).toBe(3);
    const credentialsDirectory = join(root, 'credentials');
    expect(
      existsSync(credentialsDirectory) ? readdirSync(credentialsDirectory) : [],
    ).toEqual([]);
    expect(attempt.runner_token_sha256).toBeNull();
    expect(attempt.runner_credential_path).toBeNull();
  });
});
