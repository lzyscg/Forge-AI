import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeForConsumption,
  beginReplacement,
  bindReplacementAttempt,
  cancelReplacement,
  commitReplacement,
  prepareReplacementCandidate,
  replacementTarget,
} from './replacement.js';
import type {
  PipelineManifestV21,
  StageRecordV21,
  StageAttemptV21,
  TemplateIdentity,
} from './manifest.js';

const templateIdentity: TemplateIdentity = {
  algorithm: 'source-tree-sha256-v2',
  content_sha256: 'template-v1',
  equivalence: 'verified',
};

function stageRecord(
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

function manifestWithStages(stages: StageRecordV21[]): PipelineManifestV21 {
  return {
    schema_version: '2.1',
    revision: 1,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'Story',
    mode: 'imitation',
    config_sha256: 'config',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundaries',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    attempts: [],
    stages,
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
}

function attemptFor(
  candidate: StageRecordV21,
  attemptId = `${candidate.stage_key}-a2`,
): StageAttemptV21 {
  return {
    attempt_id: attemptId,
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

describe('tracked replacement dependencies', () => {
  it('tracks every local source module required by a clean checkout', () => {
    const result = spawnSync('git', [
      'ls-files',
      '--error-unmatch',
      'orchestrators/story-pipeline/src/invalidation.ts',
    ], {
      cwd: resolve(import.meta.dirname, '..', '..', '..'),
      encoding: 'utf8',
      shell: false,
    });

    expect(result.status, result.stderr).toBe(0);
  });
});

describe('two-phase replacement state machine', () => {
  it('keeps old evidence valid while pending but blocks it from new consumption', () => {
    const old = stageRecord('outline-v1', 'outline');
    const manifest = manifestWithStages([old]);

    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
      at: '2026-01-02T00:00:00.000Z',
    });

    expect(manifest.invalidations).toEqual([]);
    expect(manifest.stages).toEqual([old]);
    expect(replacementTarget(manifest, 'outline')).toBe(replacement);
    expect(activeForConsumption(manifest, 'outline')).toBeNull();
  });

  it('commits the candidate and invalidates the old tree as one state transition', () => {
    const old = stageRecord('outline-v1', 'outline');
    const child = stageRecord('packet-v1', 'packet', [old.record_id]);
    const candidate = stageRecord('outline-v2', 'outline');
    const manifest = manifestWithStages([old, child]);
    const attempt = attemptFor(candidate);
    manifest.attempts.push(attempt);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
      at: '2026-01-02T00:00:00.000Z',
    });
    replacement.attempt_id = attempt.attempt_id;
    replacement.candidate_record = candidate;

    commitReplacement(
      manifest,
      replacement.replacement_id,
      '2026-01-03T00:00:00.000Z',
    );

    expect(replacement.status).toBe('committed');
    expect(manifest.stages).toContain(candidate);
    expect(manifest.invalidations.map((item) => item.record_id)).toEqual([
      old.record_id,
      child.record_id,
    ]);
    expect(activeForConsumption(manifest, 'outline')).toBe(candidate);
  });

  it('cancels without changing the old active tree', () => {
    const old = stageRecord('outline-v1', 'outline');
    const child = stageRecord('packet-v1', 'packet', [old.record_id]);
    const manifest = manifestWithStages([old, child]);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
      at: '2026-01-02T00:00:00.000Z',
    });

    cancelReplacement(
      manifest,
      replacement.replacement_id,
      'Forge stopped',
      '2026-01-03T00:00:00.000Z',
    );

    expect(replacement.status).toBe('cancelled');
    expect(manifest.invalidations).toEqual([]);
    expect(manifest.stages).toEqual([old, child]);
    expect(activeForConsumption(manifest, 'outline')).toBe(old);
  });

  it('blocks active descendants from new consumption while replacement is pending', () => {
    const old = stageRecord('outline-v1', 'outline');
    const child = stageRecord('packet-v1', 'packet', [old.record_id]);
    const manifest = manifestWithStages([old, child]);

    beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });

    expect(activeForConsumption(manifest, 'packet')).toBeNull();
  });

  it('reuses the same replacement and attempt after restart', () => {
    const old = stageRecord('outline-v1', 'outline');
    const manifest = manifestWithStages([old]);
    const input = {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'outline-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    };
    const first = beginReplacement(manifest, input);
    bindReplacementAttempt(
      manifest,
      first.replacement_id,
      'outline-a2',
      '2026-01-02T01:00:00.000Z',
    );
    const eventCount = manifest.events.length;

    const resumed = beginReplacement(manifest, input);
    bindReplacementAttempt(
      manifest,
      resumed.replacement_id,
      'outline-a2',
      '2026-01-03T01:00:00.000Z',
    );

    expect(resumed).toBe(first);
    expect(resumed.attempt_id).toBe('outline-a2');
    expect(manifest.replacements).toEqual([first]);
    expect(manifest.events).toHaveLength(eventCount);
  });

  it('prepares candidate identity without activating or delivering it', () => {
    const old = stageRecord('outline-v1', 'outline');
    const candidate = stageRecord('outline-v2', 'outline');
    const manifest = manifestWithStages([old]);
    manifest.attempts.push(attemptFor(candidate));
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    bindReplacementAttempt(manifest, replacement.replacement_id, 'outline-a2');
    const deliveredEvents = manifest.events.filter(
      (event) => event.type === 'stage_delivered',
    ).length;

    prepareReplacementCandidate(
      manifest,
      replacement.replacement_id,
      'outline-a2',
      candidate,
      '2026-01-02T02:00:00.000Z',
    );

    expect(replacement.candidate_record).toBe(candidate);
    expect(manifest.stages).toEqual([old]);
    expect(manifest.invalidations).toEqual([]);
    expect(manifest.events.filter(
      (event) => event.type === 'stage_delivered',
    )).toHaveLength(deliveredEvents);
  });

  it('rejects partial or mismatched candidate evidence without changing the old tree', () => {
    const old = stageRecord('outline-v1', 'outline');
    const candidate = {
      ...stageRecord('outline-v2', 'outline'),
      input_sha256: 'wrong-input',
    };
    const manifest = manifestWithStages([old]);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: 'expected-input',
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    bindReplacementAttempt(manifest, replacement.replacement_id, 'outline-a2');

    expect(() => prepareReplacementCandidate(
      manifest,
      replacement.replacement_id,
      'outline-a2',
      candidate,
    )).toThrow('replacement candidate identity does not match');
    expect(replacement.candidate_record).toBeNull();
    expect(manifest.stages).toEqual([old]);
    expect(manifest.invalidations).toEqual([]);
  });

  it('applies commit and cancellation idempotently', () => {
    const old = stageRecord('outline-v1', 'outline');
    const candidate = stageRecord('outline-v2', 'outline');
    const manifest = manifestWithStages([old]);
    manifest.attempts.push(attemptFor(candidate));
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    bindReplacementAttempt(manifest, replacement.replacement_id, 'outline-a2');
    prepareReplacementCandidate(
      manifest,
      replacement.replacement_id,
      'outline-a2',
      candidate,
    );
    commitReplacement(manifest, replacement.replacement_id);
    const committedEventCount = manifest.events.length;

    expect(commitReplacement(manifest, replacement.replacement_id)).toBe(candidate);
    expect(manifest.events).toHaveLength(committedEventCount);
    expect(manifest.stages.filter(
      (record) => record.record_id === candidate.record_id,
    )).toHaveLength(1);
    expect(manifest.invalidations.filter(
      (record) => record.record_id === old.record_id,
    )).toHaveLength(1);

    const otherOld = stageRecord('packet-v1', 'packet');
    const otherManifest = manifestWithStages([otherOld]);
    const cancelled = beginReplacement(otherManifest, {
      stage_key: 'packet',
      old_record_id: otherOld.record_id,
      expected_input_sha256: 'packet-v2-input',
      expected_template_identity: templateIdentity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    cancelReplacement(otherManifest, cancelled.replacement_id, 'stopped');
    const cancelledEventCount = otherManifest.events.length;
    cancelReplacement(otherManifest, cancelled.replacement_id, 'stopped');
    expect(otherManifest.events).toHaveLength(cancelledEventCount);
  });

  it('rejects a candidate from a different Case than the bound Attempt without mutation', () => {
    const old = stageRecord('outline-v1', 'outline');
    const candidate = stageRecord('outline-v2', 'outline');
    const manifest = manifestWithStages([old]);
    const attempt = {
      ...attemptFor(candidate),
      case_id: 'case-A',
    };
    manifest.attempts.push(attempt);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    bindReplacementAttempt(
      manifest,
      replacement.replacement_id,
      attempt.attempt_id,
    );
    const before = structuredClone(manifest);

    expect(() => prepareReplacementCandidate(
      manifest,
      replacement.replacement_id,
      attempt.attempt_id,
      candidate,
    )).toThrow('candidate Case does not match replacement Attempt');
    expect(manifest).toEqual(before);
  });

  it.each([
    {
      name: 'input',
      corrupt: (attempt: StageAttemptV21) => {
        attempt.input_sha256 = 'wrong-input';
      },
    },
    {
      name: 'template',
      corrupt: (attempt: StageAttemptV21) => {
        attempt.template_identity = {
          ...attempt.template_identity,
          content_sha256: 'wrong-template',
        };
      },
    },
    {
      name: 'ordered parents',
      corrupt: (attempt: StageAttemptV21) => {
        attempt.parent_record_ids = ['wrong-parent'];
      },
    },
  ])('rejects bound Attempt $name mismatch without mutation', ({ corrupt }) => {
    const parent = stageRecord('source-v1', 'source');
    const old = stageRecord('outline-v1', 'outline', [parent.record_id]);
    const candidate = stageRecord(
      'outline-v2',
      'outline',
      [parent.record_id],
    );
    const manifest = manifestWithStages([parent, old]);
    const attempt = attemptFor(candidate);
    corrupt(attempt);
    manifest.attempts.push(attempt);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: candidate.parent_record_ids,
      reason: 'identity changed',
    });
    bindReplacementAttempt(
      manifest,
      replacement.replacement_id,
      attempt.attempt_id,
    );
    const before = structuredClone(manifest);

    expect(() => prepareReplacementCandidate(
      manifest,
      replacement.replacement_id,
      attempt.attempt_id,
      candidate,
    )).toThrow('replacement Attempt identity does not match');
    expect(manifest).toEqual(before);
  });

  it('revalidates the Attempt identity at commit without mutation', () => {
    const old = stageRecord('outline-v1', 'outline');
    const candidate = stageRecord('outline-v2', 'outline');
    const manifest = manifestWithStages([old]);
    const attempt = attemptFor(candidate);
    manifest.attempts.push(attempt);
    const replacement = beginReplacement(manifest, {
      stage_key: 'outline',
      old_record_id: old.record_id,
      expected_input_sha256: candidate.input_sha256,
      expected_template_identity: candidate.template_identity,
      expected_parent_record_ids: [],
      reason: 'input changed',
    });
    bindReplacementAttempt(
      manifest,
      replacement.replacement_id,
      attempt.attempt_id,
    );
    replacement.candidate_record = candidate;
    attempt.case_id = 'corrupt-case';
    const before = structuredClone(manifest);

    expect(() => commitReplacement(
      manifest,
      replacement.replacement_id,
    )).toThrow('candidate Case does not match replacement Attempt');
    expect(manifest).toEqual(before);
  });
});
