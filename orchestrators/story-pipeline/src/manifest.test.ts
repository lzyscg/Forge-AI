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
  validateManifestChain,
  type PipelineManifestV21,
  type StageAttemptV21,
  type StageRecordV21,
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

function deliveredRecord(recordId = 'stage-1-v1'): StageRecordV21 {
  return {
    record_id: recordId,
    revision: 1,
    stage_key: 'stage-1',
    stage: 'generic-stage',
    chapter_id: null,
    template: 'generic-template',
    template_identity: {
      algorithm: 'source-tree-sha256-v2',
      content_sha256: 'template-hash',
      equivalence: 'verified',
    },
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
      }, {
        attempt_id: 'draft-b001-a6',
        stage_key: 'draft-b001',
        case_id: 'case-draft-b001',
        input_sha256: 'draft-input-hash',
        template_sha256: 'legacy-draft-template-hash',
        outcome: 'running',
        input_path: 'inputs/draft-b001-a6.json',
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
    expect(migrated.attempts[1]).toMatchObject({
      stage: 'chapter_draft',
      chapter_id: 'B001',
      template: 'zhihu-chapter-draft',
      expected_artifact_type: 'chapter_draft',
    });
    expect(migrated.replacements).toEqual([]);
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

describe('replacement manifest invariants', () => {
  it('rejects a pending candidate that leaked into active stages', () => {
    const manifest = emptyManifest();
    const old = deliveredRecord();
    const candidate = {
      ...deliveredRecord('stage-1-v2'),
      revision: 2,
      case_id: 'case-2',
      input_sha256: 'new-input',
    };
    manifest.stages.push(old, candidate);
    manifest.invalidations.push({
      invalidation_id: 'inv-candidate',
      record_id: candidate.record_id,
      stage_key: candidate.stage_key,
      reason: 'fixture',
      root_record_id: candidate.record_id,
      invalidated_at: '2026-07-27T00:00:03.000Z',
    });
    manifest.attempts.push({
      ...runningAttempt(),
      attempt_id: 'attempt-2',
      stage_key: candidate.stage_key,
      stage: candidate.stage,
      chapter_id: candidate.chapter_id,
      template: candidate.template,
      expected_artifact_type: candidate.artifact_type,
      case_id: candidate.case_id,
      input_sha256: candidate.input_sha256,
      parent_record_ids: [...candidate.parent_record_ids],
      template_identity: candidate.template_identity,
      outcome: 'delivered',
      raw_artifact_path: candidate.raw_artifact_path,
      validation_report_path: candidate.validation_report_path,
    });
    manifest.replacements.push({
      replacement_id: 'replacement-1',
      stage_key: old.stage_key,
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      attempt_id: 'attempt-2',
      status: 'pending',
      candidate_record: candidate,
      reason: 'input changed',
    });

    expect(() => validateManifestChain(manifest)).toThrow(
      'pending replacement candidate is already registered',
    );
  });

  it('rejects a committed replacement without atomic old invalidation', () => {
    const manifest = emptyManifest();
    const old = deliveredRecord();
    const candidate = {
      ...deliveredRecord('stage-1-v2'),
      revision: 2,
      case_id: 'case-2',
      input_sha256: 'new-input',
    };
    manifest.stages.push(old, candidate);
    manifest.invalidations.push({
      invalidation_id: 'inv-candidate',
      record_id: candidate.record_id,
      stage_key: candidate.stage_key,
      reason: 'fixture',
      root_record_id: candidate.record_id,
      invalidated_at: '2026-07-27T00:00:03.000Z',
    });
    manifest.attempts.push({
      ...runningAttempt(),
      attempt_id: 'attempt-2',
      stage_key: candidate.stage_key,
      stage: candidate.stage,
      chapter_id: candidate.chapter_id,
      template: candidate.template,
      expected_artifact_type: candidate.artifact_type,
      case_id: candidate.case_id,
      input_sha256: candidate.input_sha256,
      parent_record_ids: [...candidate.parent_record_ids],
      template_identity: candidate.template_identity,
      outcome: 'delivered',
      raw_artifact_path: candidate.raw_artifact_path,
      validation_report_path: candidate.validation_report_path,
    });
    manifest.replacements.push({
      replacement_id: 'replacement-1',
      stage_key: old.stage_key,
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      attempt_id: 'attempt-2',
      status: 'committed',
      candidate_record: candidate,
      reason: 'input changed',
    });

    expect(() => validateManifestChain(manifest)).toThrow(
      'committed replacement old record is still active',
    );
  });

  it('rejects a corrupt committed replacement whose candidate Case differs from its Attempt', () => {
    const manifest = emptyManifest();
    const old = deliveredRecord();
    const candidate = {
      ...deliveredRecord('stage-1-v2'),
      revision: 2,
      case_id: 'case-B',
      input_sha256: 'new-input',
    };
    manifest.stages.push(old, candidate);
    manifest.invalidations.push({
      invalidation_id: 'inv-old',
      record_id: old.record_id,
      stage_key: old.stage_key,
      reason: 'replacement committed',
      root_record_id: old.record_id,
      invalidated_at: '2026-07-27T00:00:03.000Z',
    });
    manifest.attempts.push({
      ...runningAttempt(),
      attempt_id: 'attempt-2',
      stage_key: candidate.stage_key,
      stage: candidate.stage,
      chapter_id: candidate.chapter_id,
      template: candidate.template,
      expected_artifact_type: candidate.artifact_type,
      case_id: 'case-A',
      input_sha256: candidate.input_sha256,
      parent_record_ids: [...candidate.parent_record_ids],
      template_identity: candidate.template_identity,
      outcome: 'delivered',
      raw_artifact_path: candidate.raw_artifact_path,
      validation_report_path: candidate.validation_report_path,
    });
    manifest.replacements.push({
      replacement_id: 'replacement-1',
      stage_key: old.stage_key,
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      attempt_id: 'attempt-2',
      status: 'committed',
      candidate_record: candidate,
      reason: 'input changed',
    });

    expect(() => validateManifestChain(manifest)).toThrow(
      'replacement candidate does not match its Attempt',
    );
  });
});

describe('historical reinstatement invariants', () => {
  function historicalManifest() {
    const manifest = emptyManifest();
    const oldRecord = {
      ...deliveredRecord('stage-1-v1'),
      template_identity: {
        algorithm: 'legacy-unversioned-v1' as const,
        content_sha256: 'legacy-template-hash',
        equivalence: 'unknown' as const,
      },
    };
    manifest.stages.push(oldRecord);
    manifest.invalidations.push({
      invalidation_id: 'inv-1',
      record_id: oldRecord.record_id,
      stage_key: oldRecord.stage_key,
      reason: 'historical invalidation',
      root_record_id: oldRecord.record_id,
      invalidated_at: '2026-07-27T00:00:03.000Z',
    });
    const historicalEvent = appendManifestEvent(manifest, {
      at: '2026-07-27T00:00:02.000Z',
      type: 'stage_delivered',
      stage_key: oldRecord.stage_key,
      attempt_id: 'attempt-1',
      before_outcome: 'running',
      after_outcome: 'delivered',
      case_id: oldRecord.case_id,
      artifact_id: 'artifact-1',
      artifact_version: 1,
      version_id: 'version-1',
      record_id: oldRecord.record_id,
      reason: 'historical delivery',
      actor: 'story-pipeline',
    });
    manifest.attempts.push({
      ...runningAttempt(),
      outcome: 'delivered',
      template_identity: oldRecord.template_identity,
      raw_artifact_path: oldRecord.raw_artifact_path,
      validation_report_path: oldRecord.validation_report_path,
    });
    const restoredRecord = {
      ...oldRecord,
      record_id: 'stage-1-v2',
      revision: 2,
      template_identity: {
        ...oldRecord.template_identity,
        equivalence: 'operator_attested' as const,
      },
      input_file_sha256: 'historical-input-file-hash',
      legacy_binding_attestation: {
        proof: 'operator_attested' as const,
        case_id: oldRecord.case_id,
        run_id: manifest.run_id,
        story_id: manifest.story_id,
        stage_key: oldRecord.stage_key,
        chapter_id: oldRecord.chapter_id,
        input_sha256: oldRecord.input_sha256,
        input_file_sha256: 'historical-input-file-hash',
        scenario_snapshot_sha256: 'legacy-scenario-hash',
        attempt_id: 'attempt-1',
        historical_attempt_id: 'attempt-1',
        historical_event_sha256: historicalEvent.event_sha256,
        template_identity_before: oldRecord.template_identity,
        template_identity_after: {
          ...oldRecord.template_identity,
          equivalence: 'operator_attested' as const,
        },
        attested_at: '2026-07-27T00:00:04.000Z',
        reason: 'operator reviewed the immutable historical evidence',
      },
    };
    manifest.stages.push(restoredRecord);
    manifest.reinstatements.push({
      reinstatement_id: 'reinstate-1',
      old_record_id: oldRecord.record_id,
      new_record_id: restoredRecord.record_id,
      case_id: oldRecord.case_id,
      evidence_sha256: restoredRecord.artifact_sha256,
      compatibility: 'operator_attested',
      reason: 'operator reviewed the immutable historical evidence',
    });
    return { manifest, restoredRecord };
  }

  it('accepts an append-only operator-attested reinstatement bound to historical evidence', () => {
    const { manifest } = historicalManifest();

    expect(() => validateManifestChain(manifest)).not.toThrow();
    expect(manifest.invalidations.map(({ invalidation_id }) => invalidation_id))
      .toEqual(['inv-1']);
  });

  it('rejects a reinstatement whose attestation does not bind a historical event', () => {
    const { manifest, restoredRecord } = historicalManifest();
    restoredRecord.legacy_binding_attestation.historical_event_sha256 =
      'not-a-historical-event';

    expect(() => validateManifestChain(manifest)).toThrow(
      'legacy binding attestation historical event is missing',
    );
  });

  it('rejects an attested record whose raw input file hash differs', () => {
    const { manifest, restoredRecord } = historicalManifest();
    restoredRecord.legacy_binding_attestation.input_file_sha256 =
      'different-input-file-hash';

    expect(() => validateManifestChain(manifest)).toThrow(
      'legacy binding attestation record identity does not match',
    );
  });

  it('rejects a legacy reinstatement that claims verified compatibility', () => {
    const { manifest } = historicalManifest();
    manifest.reinstatements[0]!.compatibility = 'verified';

    expect(() => validateManifestChain(manifest)).toThrow(
      'legacy reinstatement must remain operator_attested',
    );
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
