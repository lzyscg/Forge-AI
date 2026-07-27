import { descendantClosure } from './invalidation.js';
import {
  appendManifestEvent,
  type PipelineManifestV21,
  type ReplacementRecord,
  type StageRecordV21,
  type TemplateIdentity,
} from './manifest.js';

export interface BeginReplacementInput {
  stage_key: string;
  old_record_id: string;
  expected_input_sha256: string;
  expected_template_identity: TemplateIdentity;
  expected_parent_record_ids: string[];
  reason: string;
  at?: string;
}

function sameTemplateIdentity(
  left: TemplateIdentity,
  right: TemplateIdentity,
): boolean {
  return left.algorithm === right.algorithm
    && left.content_sha256 === right.content_sha256
    && left.equivalence === right.equivalence;
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function invalidatedRecordIds(manifest: PipelineManifestV21): Set<string> {
  return new Set(manifest.invalidations.map((item) => item.record_id));
}

function activeRecord(
  manifest: PipelineManifestV21,
  stageKey: string,
): StageRecordV21 | null {
  const invalidated = invalidatedRecordIds(manifest);
  return [...manifest.stages].reverse().find(
    (record) =>
      record.stage_key === stageKey && !invalidated.has(record.record_id),
  ) ?? null;
}

export function replacementTarget(
  manifest: PipelineManifestV21,
  stageKey: string,
): ReplacementRecord | null {
  return [...manifest.replacements].reverse().find(
    (replacement) =>
      replacement.stage_key === stageKey && replacement.status === 'pending',
  ) ?? null;
}

export function activeForConsumption(
  manifest: PipelineManifestV21,
  stageKey: string,
): StageRecordV21 | null {
  const record = activeRecord(manifest, stageKey);
  if (!record) return null;
  const invalidated = invalidatedRecordIds(manifest);
  for (const replacement of manifest.replacements) {
    if (replacement.status !== 'pending') continue;
    const blocked = descendantClosure(
      manifest.stages,
      replacement.old_record_id,
      invalidated,
    );
    if (blocked.includes(record.record_id)) return null;
  }
  return record;
}

export function beginReplacement(
  manifest: PipelineManifestV21,
  input: BeginReplacementInput,
): ReplacementRecord {
  const oldRecord = activeRecord(manifest, input.stage_key);
  if (!oldRecord || oldRecord.record_id !== input.old_record_id) {
    throw new Error('replacement old record is not active');
  }
  const existing = replacementTarget(manifest, input.stage_key);
  if (existing) {
    if (
      existing.old_record_id !== input.old_record_id
      || existing.expected_input_sha256 !== input.expected_input_sha256
      || !sameTemplateIdentity(
        existing.expected_template_identity,
        input.expected_template_identity,
      )
      || !sameOrderedValues(
        existing.expected_parent_record_ids,
        input.expected_parent_record_ids,
      )
    ) {
      throw new Error('stage already has a different pending replacement');
    }
    return existing;
  }
  const at = input.at ?? new Date().toISOString();
  const replacement: ReplacementRecord = {
    replacement_id: `replacement-${manifest.replacements.length + 1}`,
    stage_key: input.stage_key,
    old_record_id: input.old_record_id,
    expected_input_sha256: input.expected_input_sha256,
    expected_template_identity: structuredClone(
      input.expected_template_identity,
    ),
    expected_parent_record_ids: [...input.expected_parent_record_ids],
    attempt_id: null,
    status: 'pending',
    candidate_record: null,
    reason: input.reason,
  };
  manifest.replacements.push(replacement);
  appendManifestEvent(manifest, {
    at,
    type: 'replacement_pending',
    stage_key: replacement.stage_key,
    attempt_id: null,
    before_outcome: null,
    after_outcome: null,
    case_id: oldRecord.case_id,
    artifact_id: oldRecord.record_id,
    artifact_version: oldRecord.artifact_version,
    version_id: oldRecord.record_id,
    record_id: oldRecord.record_id,
    reason: replacement.reason,
    actor: 'story-pipeline',
  });
  return replacement;
}

function requireReplacement(
  manifest: PipelineManifestV21,
  replacementId: string,
): ReplacementRecord {
  const replacement = manifest.replacements.find(
    (item) => item.replacement_id === replacementId,
  );
  if (!replacement) throw new Error('replacement does not exist');
  return replacement;
}

export function bindReplacementAttempt(
  manifest: PipelineManifestV21,
  replacementId: string,
  attemptId: string,
  at = new Date().toISOString(),
): ReplacementRecord {
  const replacement = requireReplacement(manifest, replacementId);
  if (replacement.status !== 'pending') {
    throw new Error('only a pending replacement can bind an attempt');
  }
  if (replacement.attempt_id === attemptId) return replacement;
  if (replacement.attempt_id !== null) {
    throw new Error('replacement is already bound to another attempt');
  }
  replacement.attempt_id = attemptId;
  appendManifestEvent(manifest, {
    at,
    type: 'replacement_attempt_bound',
    stage_key: replacement.stage_key,
    attempt_id: attemptId,
    before_outcome: null,
    after_outcome: null,
    case_id: null,
    artifact_id: null,
    artifact_version: null,
    version_id: null,
    record_id: replacement.old_record_id,
    reason: replacement.reason,
    actor: 'story-pipeline',
  });
  return replacement;
}

function candidateMatchesReplacement(
  replacement: ReplacementRecord,
  candidate: StageRecordV21,
): boolean {
  return candidate.stage_key === replacement.stage_key
    && candidate.input_sha256 === replacement.expected_input_sha256
    && sameTemplateIdentity(
      candidate.template_identity,
      replacement.expected_template_identity,
    )
    && sameOrderedValues(
      candidate.parent_record_ids,
      replacement.expected_parent_record_ids,
    );
}

export function prepareReplacementCandidate(
  manifest: PipelineManifestV21,
  replacementId: string,
  attemptId: string,
  candidate: StageRecordV21,
  at = new Date().toISOString(),
): StageRecordV21 {
  const replacement = requireReplacement(manifest, replacementId);
  if (replacement.status !== 'pending') {
    throw new Error('only a pending replacement can prepare a candidate');
  }
  if (replacement.attempt_id !== attemptId) {
    throw new Error('replacement candidate attempt does not match');
  }
  if (!candidateMatchesReplacement(replacement, candidate)) {
    throw new Error('replacement candidate identity does not match');
  }
  if (manifest.stages.some(
    (record) => record.record_id === candidate.record_id,
  )) {
    throw new Error('replacement candidate is already active');
  }
  if (replacement.candidate_record) {
    if (
      JSON.stringify(replacement.candidate_record) === JSON.stringify(candidate)
    ) {
      return replacement.candidate_record;
    }
    throw new Error('replacement already has different candidate evidence');
  }
  replacement.candidate_record = candidate;
  appendManifestEvent(manifest, {
    at,
    type: 'replacement_candidate_prepared',
    stage_key: replacement.stage_key,
    attempt_id: attemptId,
    before_outcome: null,
    after_outcome: null,
    case_id: candidate.case_id,
    artifact_id: candidate.record_id,
    artifact_version: candidate.artifact_version,
    version_id: candidate.record_id,
    record_id: candidate.record_id,
    reason: replacement.reason,
    actor: 'story-pipeline',
  });
  return candidate;
}

export function commitReplacement(
  manifest: PipelineManifestV21,
  replacementId: string,
  at = new Date().toISOString(),
): StageRecordV21 {
  const replacement = requireReplacement(manifest, replacementId);
  if (replacement.status === 'committed') {
    if (!replacement.candidate_record) {
      throw new Error('committed replacement has no candidate record');
    }
    return replacement.candidate_record;
  }
  if (replacement.status !== 'pending') {
    throw new Error('only a pending replacement can be committed');
  }
  const candidate = replacement.candidate_record;
  if (!candidate || replacement.attempt_id === null) {
    throw new Error('replacement candidate is not prepared');
  }
  if (!candidateMatchesReplacement(replacement, candidate)) {
    throw new Error('replacement candidate identity does not match');
  }
  const oldRecord = activeRecord(manifest, replacement.stage_key);
  if (!oldRecord || oldRecord.record_id !== replacement.old_record_id) {
    throw new Error('replacement old record is no longer active');
  }
  const existingCandidate = manifest.stages.find(
    (record) => record.record_id === candidate.record_id,
  );
  if (existingCandidate) {
    throw new Error('replacement candidate record already exists');
  }
  const invalidated = invalidatedRecordIds(manifest);
  const affectedRecordIds = descendantClosure(
    manifest.stages,
    replacement.old_record_id,
    invalidated,
  );
  const affectedRecords = affectedRecordIds.map((recordId) => {
    const record = manifest.stages.find((item) => item.record_id === recordId);
    if (!record) throw new Error(`replacement descendant is missing: ${recordId}`);
    return record;
  });
  const attempt = manifest.attempts.find(
    (item) => item.attempt_id === replacement.attempt_id,
  );
  if (manifest.attempts.length > 0 && !attempt) {
    throw new Error('replacement attempt is missing');
  }
  const beforeOutcome = attempt?.outcome ?? 'running';
  for (const record of affectedRecords) {
    manifest.invalidations.push({
      invalidation_id: `inv-${manifest.invalidations.length + 1}`,
      record_id: record.record_id,
      stage_key: record.stage_key,
      reason: replacement.reason,
      root_record_id: replacement.old_record_id,
      invalidated_at: at,
    });
    appendManifestEvent(manifest, {
      at,
      type: 'stage_invalidated',
      stage_key: record.stage_key,
      attempt_id: replacement.attempt_id,
      before_outcome: null,
      after_outcome: null,
      case_id: record.case_id,
      artifact_id: record.record_id,
      artifact_version: record.artifact_version,
      version_id: record.record_id,
      record_id: record.record_id,
      reason: replacement.reason,
      actor: 'story-pipeline',
    });
    if (manifest.final_artifact_path === record.artifact_path) {
      manifest.final_artifact_path = null;
    }
  }
  manifest.stages.push(candidate);
  if (attempt) {
    attempt.outcome = 'delivered';
    attempt.raw_artifact_path = candidate.raw_artifact_path;
    attempt.validation_report_path = candidate.validation_report_path;
    attempt.runner_credential_path = null;
    attempt.updated_at = at;
    attempt.detail = null;
  }
  replacement.status = 'committed';
  appendManifestEvent(manifest, {
    at,
    type: 'stage_delivered',
    stage_key: candidate.stage_key,
    attempt_id: replacement.attempt_id,
    before_outcome: beforeOutcome,
    after_outcome: 'delivered',
    case_id: candidate.case_id,
    artifact_id: candidate.record_id,
    artifact_version: candidate.artifact_version,
    version_id: candidate.record_id,
    record_id: candidate.record_id,
    reason: 'replacement candidate committed',
    actor: 'story-pipeline',
  });
  appendManifestEvent(manifest, {
    at,
    type: 'replacement_committed',
    stage_key: replacement.stage_key,
    attempt_id: replacement.attempt_id,
    before_outcome: null,
    after_outcome: null,
    case_id: candidate.case_id,
    artifact_id: candidate.record_id,
    artifact_version: candidate.artifact_version,
    version_id: candidate.record_id,
    record_id: candidate.record_id,
    reason: replacement.reason,
    actor: 'story-pipeline',
  });
  return candidate;
}

export function cancelReplacement(
  manifest: PipelineManifestV21,
  replacementId: string,
  reason: string,
  at = new Date().toISOString(),
): ReplacementRecord {
  const replacement = requireReplacement(manifest, replacementId);
  if (replacement.status === 'cancelled') return replacement;
  if (replacement.status !== 'pending') {
    throw new Error('committed replacement cannot be cancelled');
  }
  replacement.status = 'cancelled';
  appendManifestEvent(manifest, {
    at,
    type: 'replacement_cancelled',
    stage_key: replacement.stage_key,
    attempt_id: replacement.attempt_id,
    before_outcome: null,
    after_outcome: null,
    case_id: replacement.candidate_record?.case_id ?? null,
    artifact_id: replacement.candidate_record?.record_id ?? null,
    artifact_version: replacement.candidate_record?.artifact_version ?? null,
    version_id: replacement.candidate_record?.record_id ?? null,
    record_id: replacement.old_record_id,
    reason,
    actor: 'story-pipeline',
  });
  return replacement;
}
