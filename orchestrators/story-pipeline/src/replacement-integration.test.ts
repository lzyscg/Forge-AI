import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeClient } from './forge-client.js';
import { sha256 } from './hash.js';
import {
  persistPendingReplacement,
  persistReplacementAttempt,
  persistReplacementCancellation,
  persistReplacementCandidate,
  persistReplacementCommit,
  reconcileRun,
} from './index.js';
import {
  appendManifestEvent,
  initializeManifest,
  loadManifest,
  persistRunnerCredential,
  saveManifestCas,
  type PipelineManifestV21,
  type StageAttemptV21,
  type StageRecordV21,
  type TemplateIdentity,
} from './manifest.js';
import { commitReplacement } from './replacement.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const templateIdentity: TemplateIdentity = {
  algorithm: 'source-tree-sha256-v2',
  content_sha256: 'template-v1',
  equivalence: 'verified',
};

function record(
  recordId: string,
  stageKey: string,
  parentRecordIds: string[] = [],
): StageRecordV21 {
  return {
    record_id: recordId,
    revision: 1,
    stage_key: stageKey,
    stage: stageKey,
    chapter_id: null,
    template: `${stageKey}-template`,
    template_identity: templateIdentity,
    case_id: `${recordId}-case`,
    parent_record_ids: parentRecordIds,
    parent_case_ids: parentRecordIds.map((id) => `${id}-case`),
    status: 'delivered',
    input_path: `${recordId}/input.json`,
    input_sha256: `${recordId}-input`,
    raw_artifact_path: `${recordId}/raw.md`,
    raw_artifact_sha256: `${recordId}-raw`,
    artifact_path: `${recordId}/artifact.md`,
    artifact_sha256: `${recordId}-artifact`,
    sidecar_path: `${recordId}/sidecar.json`,
    sidecar_sha256: `${recordId}-sidecar`,
    validation_report_path: `${recordId}/validation.json`,
    validation_report_sha256: `${recordId}-validation`,
    artifact_type: stageKey,
    artifact_version: 1,
    completed_at: '2026-01-01T00:00:00.000Z',
  };
}

function manifestPathWith(
  stages: StageRecordV21[],
  attempts: StageAttemptV21[] = [],
  withCredentials = false,
  configSha256 = 'config',
): string {
  const runDirectory = mkdtempSync(join(tmpdir(), 'forge-replacement-'));
  temporaryDirectories.push(runDirectory);
  const manifestPath = join(runDirectory, 'manifest.json');
  if (withCredentials) {
    for (const attempt of attempts) {
      persistRunnerCredential(
        runDirectory,
        attempt,
        `runner-token-${attempt.attempt_id}`,
        { platform: 'linux' },
      );
    }
  }
  initializeManifest(manifestPath, (): PipelineManifestV21 => ({
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'Story',
    mode: 'imitation',
    config_sha256: configSha256,
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundaries',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    attempts,
    stages,
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  }));
  return manifestPath;
}

const unusedForgeClient: ForgeClient = {
  async createCase() {
    throw new Error('unexpected createCase');
  },
  async runCase() {
    throw new Error('unexpected runCase');
  },
  async getCaseStatus() {
    throw new Error('unexpected getCaseStatus');
  },
  async abortCase() {
    throw new Error('unexpected abortCase');
  },
};

function attemptFor(candidate: StageRecordV21): StageAttemptV21 {
  return {
    attempt_id: `${candidate.stage_key}-a2`,
    stage_key: candidate.stage_key,
    stage: candidate.stage,
    chapter_id: candidate.chapter_id,
    template: candidate.template,
    expected_artifact_type: candidate.artifact_type,
    expected_scenario_snapshot_sha256: 'scenario-v1',
    case_id: candidate.case_id,
    input_sha256: candidate.input_sha256,
    parent_record_ids: [...candidate.parent_record_ids],
    template_identity: candidate.template_identity,
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome: 'running',
    input_path: candidate.input_path,
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    detail: null,
  };
}

describe('replacement Manifest CAS integration', () => {
  it('reuses the same pending replacement and attempt after restart', () => {
    const old = record('outline-v1', 'outline');
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const path = manifestPathWith([old], [attempt]);
    const input = {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    };
    const pending = persistPendingReplacement(path, input);
    const replacement = pending.replacements[0]!;
    const bound = persistReplacementAttempt(
      path,
      replacement.replacement_id,
      attempt.attempt_id,
    );
    const restartRevision = bound.revision;

    const resumedPending = persistPendingReplacement(path, input);
    const resumed = persistReplacementAttempt(
      path,
      replacement.replacement_id,
      attempt.attempt_id,
    );

    expect(resumedPending.replacements[0]!.replacement_id).toBe(
      replacement.replacement_id,
    );
    expect(resumed.replacements[0]!.attempt_id).toBe(attempt.attempt_id);
    expect(resumed.replacements).toHaveLength(1);
    expect(resumed.revision).toBe(restartRevision);
  });

  it('cancels after validation failure without changing the old tree', () => {
    const old = record('outline-v1', 'outline');
    const child = record('packet-v1', 'packet', [old.record_id]);
    const path = manifestPathWith([old, child]);
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });

    persistReplacementCancellation(
      path,
      pending.replacements[0]!.replacement_id,
      'structural validation failed',
    );

    const saved = loadManifest(path);
    expect(saved.replacements[0]!.status).toBe('cancelled');
    expect(saved.stages).toEqual([old, child]);
    expect(saved.invalidations).toEqual([]);
  });

  it('commits invalidation and candidate activation in one Manifest revision', () => {
    const old = record('outline-v1', 'outline');
    const child = record('packet-v1', 'packet', [old.record_id]);
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const path = manifestPathWith([old, child], [attempt]);
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    const replacementId = pending.replacements[0]!.replacement_id;
    persistReplacementAttempt(path, replacementId, attempt.attempt_id);
    const prepared = persistReplacementCandidate(
      path,
      replacementId,
      attempt.attempt_id,
      candidate,
    );
    const beforeCommitRevision = prepared.revision;

    const committed = persistReplacementCommit(
      path,
      replacementId,
      beforeCommitRevision,
    );

    expect(committed.revision).toBe(beforeCommitRevision + 1);
    expect(committed.replacements[0]!.status).toBe('committed');
    expect(committed.stages).toContainEqual(candidate);
    expect(committed.invalidations.map((item) => item.record_id)).toEqual([
      old.record_id,
      child.record_id,
    ]);
    expect(loadManifest(path)).toEqual(committed);
  });

  it('cancels on commit CAS conflict and leaves old evidence active', () => {
    const old = record('outline-v1', 'outline');
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const path = manifestPathWith([old], [attempt]);
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    const replacementId = pending.replacements[0]!.replacement_id;
    persistReplacementAttempt(path, replacementId, attempt.attempt_id);
    const prepared = persistReplacementCandidate(
      path,
      replacementId,
      attempt.attempt_id,
      candidate,
    );
    saveManifestCas(path, prepared.revision, (manifest) => {
      appendManifestEvent(manifest, {
        at: '2026-01-02T03:00:00.000Z',
        type: 'concurrent_audit',
        stage_key: 'manifest',
        attempt_id: null,
        before_outcome: null,
        after_outcome: null,
        case_id: null,
        artifact_id: null,
        artifact_version: null,
        version_id: null,
        record_id: null,
        reason: 'concurrent writer',
        actor: 'story-pipeline',
      });
    });

    expect(() => persistReplacementCommit(
      path,
      replacementId,
      prepared.revision,
    )).toThrow('manifest revision conflict');

    const saved = loadManifest(path);
    expect(saved.replacements[0]!.status).toBe('cancelled');
    expect(saved.stages).toEqual([old]);
    expect(saved.invalidations).toEqual([]);
  });

  it('terminalizes the bound Attempt before deleting credentials on CAS conflict', () => {
    const old = record('outline-v1', 'outline');
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const path = manifestPathWith([old], [attempt], true);
    const credentialPath = join(
      path,
      '..',
      attempt.runner_credential_path!,
    );
    expect(existsSync(credentialPath)).toBe(true);
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    const replacementId = pending.replacements[0]!.replacement_id;
    persistReplacementAttempt(path, replacementId, attempt.attempt_id);
    const prepared = persistReplacementCandidate(
      path,
      replacementId,
      attempt.attempt_id,
      candidate,
    );
    saveManifestCas(path, prepared.revision, (manifest) => {
      appendManifestEvent(manifest, {
        at: '2026-01-02T03:00:00.000Z',
        type: 'concurrent_audit',
        stage_key: 'manifest',
        attempt_id: null,
        before_outcome: null,
        after_outcome: null,
        case_id: null,
        artifact_id: null,
        artifact_version: null,
        version_id: null,
        record_id: null,
        reason: 'concurrent writer',
        actor: 'story-pipeline',
      });
    });

    expect(() => persistReplacementCommit(
      path,
      replacementId,
      prepared.revision,
    )).toThrow('manifest revision conflict');

    const saved = loadManifest(path);
    const savedAttempt = saved.attempts[0]!;
    expect(saved.replacements[0]!.status).toBe('cancelled');
    expect(savedAttempt.outcome).toBe('failed');
    expect(savedAttempt.detail).toBe('replacement commit precondition failed');
    expect(savedAttempt.runner_credential_path).toBeNull();
    expect(saved.events).toContainEqual(expect.objectContaining({
      type: 'stage_failed',
      attempt_id: attempt.attempt_id,
      before_outcome: 'running',
      after_outcome: 'failed',
    }));
    expect(existsSync(credentialPath)).toBe(false);
    expect(saved.stages).toEqual([old]);
    expect(saved.invalidations).toEqual([]);
  });

  it('cleans a committed replacement credential left by a crash on restart', async () => {
    const old = record('outline-v1', 'outline');
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const config = {
      run_id: 'run-1',
      story_id: 'story-1',
      title: 'Story',
      mode: 'imitation',
      source_file: 'source.md',
      requirements: 'test only',
      chapters: [{ id: 'B001' }],
    };
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const path = manifestPathWith(
      [old],
      [attempt],
      true,
      sha256(configText),
    );
    const runDir = dirname(path);
    const configPath = join(runDir, 'production-config.json');
    writeFileSync(configPath, configText, 'utf8');
    const credentialPath = join(runDir, attempt.runner_credential_path!);
    const unrelatedPath = join(runDir, 'credentials', 'unrelated.runner-token');
    writeFileSync(unrelatedPath, 'unrelated-secret', 'utf8');
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    const replacementId = pending.replacements[0]!.replacement_id;
    persistReplacementAttempt(path, replacementId, attempt.attempt_id);
    const prepared = persistReplacementCandidate(
      path,
      replacementId,
      attempt.attempt_id,
      candidate,
    );

    saveManifestCas(path, prepared.revision, (manifest) => {
      commitReplacement(manifest, replacementId);
    });
    expect(existsSync(credentialPath)).toBe(true);

    await reconcileRun({
      command: 'reconcile',
      configPath,
      runDir,
      dbPath: join(runDir, 'forge.db'),
      dryRun: false,
      attestTemplateCompatibility: false,
      attestLegacyCaseBindings: [],
    }, unusedForgeClient, new AbortController().signal);

    expect(existsSync(credentialPath)).toBe(false);
    expect(readFileSync(unrelatedPath, 'utf8')).toBe('unrelated-secret');
  });

  it('fails closed when crash residue does not match the Attempt secret hash', async () => {
    const old = record('outline-v1', 'outline');
    const candidate = {
      ...record('outline-v2', 'outline'),
      input_sha256: 'outline-v2-input',
    };
    const attempt = attemptFor(candidate);
    const config = {
      run_id: 'run-1',
      story_id: 'story-1',
      title: 'Story',
      mode: 'imitation',
      source_file: 'source.md',
      requirements: 'test only',
      chapters: [{ id: 'B001' }],
    };
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const path = manifestPathWith(
      [old],
      [attempt],
      true,
      sha256(configText),
    );
    const runDir = dirname(path);
    const configPath = join(runDir, 'production-config.json');
    writeFileSync(configPath, configText, 'utf8');
    const credentialPath = join(runDir, attempt.runner_credential_path!);
    const pending = persistPendingReplacement(path, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    const replacementId = pending.replacements[0]!.replacement_id;
    persistReplacementAttempt(path, replacementId, attempt.attempt_id);
    const prepared = persistReplacementCandidate(
      path,
      replacementId,
      attempt.attempt_id,
      candidate,
    );
    saveManifestCas(path, prepared.revision, (manifest) => {
      commitReplacement(manifest, replacementId);
    });
    writeFileSync(credentialPath, 'foreign-secret', 'utf8');

    await expect(reconcileRun({
      command: 'reconcile',
      configPath,
      runDir,
      dbPath: join(runDir, 'forge.db'),
      dryRun: false,
      attestTemplateCompatibility: false,
      attestLegacyCaseBindings: [],
    }, unusedForgeClient, new AbortController().signal)).rejects.toThrow(
      'terminal replacement credential does not match Attempt',
    );
    expect(readFileSync(credentialPath, 'utf8')).toBe('foreign-secret');
  });
});
