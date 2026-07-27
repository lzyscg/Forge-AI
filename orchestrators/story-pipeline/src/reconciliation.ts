import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ForgeCaseSnapshot } from './forge-client.js';
import { sha256 } from './hash.js';
import {
  appendManifestEvent,
  AttemptOutcome,
  type PipelineManifestV21,
  StageAttemptV21,
  type StageRecordV21,
  TemplateIdentity,
} from './manifest.js';
import type { ValidationResult } from './quality.js';

export interface StagePlan {
  run_id: string;
  story_id: string;
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  expected_artifact_type: string;
  input_sha256: string;
  parent_record_ids: string[];
  template_identity: TemplateIdentity;
}

export type ReconciliationAction =
  | { action: 'adopt'; stage_key: string; attempt_id: string; case_id: string }
  | { action: 'close'; attempt_id: string; outcome: AttemptOutcome; reason: string }
  | { action: 'resume'; attempt_id: string; case_id: string }
  | { action: 'ambiguous'; stage_key: string; candidates: string[] }
  | { action: 'reject'; attempt_id: string; reason: string };

export type MaterializedStageRecord = StageRecordV21 & {
  artifact_version_id: string;
  materialization_key: string;
};

export interface MaterializeDeliveredArtifactOptions {
  run_dir: string;
  manifest: PipelineManifestV21;
  plan: StagePlan;
  attempt: StageAttemptV21;
  snapshot: ForgeCaseSnapshot;
  validate: (rawContent: string) => ValidationResult;
  completed_at?: string;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function insideRunDirectory(runDirectory: string, path: string): string {
  const absolute = resolve(runDirectory, path);
  const rel = relative(resolve(runDirectory), absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`materialization path escapes the run directory: ${path}`);
  }
  return absolute;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function verifyRecordFile(
  runDirectory: string,
  path: string,
  expectedSha256: string,
): void {
  const absolute = insideRunDirectory(runDirectory, path);
  if (!existsSync(absolute) || sha256(readFileSync(absolute)) !== expectedSha256) {
    throw new Error(`materialized artifact evidence is missing or changed: ${path}`);
  }
}

function rejectionReason(
  plan: StagePlan,
  attempt: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
): string | null {
  const caseIdentity = snapshot.case_identity;
  const binding = caseIdentity?.run_binding;
  if (
    !binding ||
    binding.run_id !== plan.run_id ||
    binding.story_id !== plan.story_id ||
    binding.stage_key !== plan.stage_key ||
    binding.chapter_id !== plan.chapter_id
  ) {
    return 'Forge run binding does not match the stage plan';
  }
  if (caseIdentity.input_payload_sha256 !== plan.input_sha256) {
    return 'Forge input payload identity does not match the stage plan';
  }
  if (attempt.input_sha256 !== plan.input_sha256) {
    return 'Attempt input identity does not match the stage plan';
  }
  if (
    attempt.stage_key !== plan.stage_key ||
    attempt.stage !== plan.stage ||
    attempt.chapter_id !== plan.chapter_id
  ) {
    return 'Attempt stage identity does not match the stage plan';
  }
  if (
    attempt.parent_record_ids.length !== plan.parent_record_ids.length ||
    attempt.parent_record_ids.some(
      (recordId, index) => recordId !== plan.parent_record_ids[index],
    )
  ) {
    return 'Attempt parent identity does not match the stage plan';
  }
  if (
    caseIdentity.scenario_id !== attempt.template ||
    attempt.template_identity.algorithm !== plan.template_identity.algorithm ||
    attempt.template_identity.content_sha256 !== plan.template_identity.content_sha256
  ) {
    return 'Forge scenario or execution bundle does not match the stage plan';
  }
  return null;
}

function adoptionRejectionReason(
  plan: StagePlan,
  attempt: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
): string | null {
  const identityReason = rejectionReason(plan, attempt, snapshot);
  if (identityReason) return identityReason;
  if (
    snapshot.execution_identity?.template_bundle_sha256
      !== plan.template_identity.content_sha256
  ) {
    return 'Forge scenario or execution bundle does not match the stage plan';
  }
  if (
    attempt.expected_artifact_type !== plan.expected_artifact_type ||
    snapshot.final_artifact?.type !== plan.expected_artifact_type
  ) {
    return 'Forge artifact type does not match the stage plan';
  }
  if (
    snapshot.status !== 'approved' ||
    snapshot.success !== true ||
    snapshot.gate?.status !== 'pass' ||
    snapshot.final_artifact?.status !== 'delivered'
  ) {
    return 'Forge case has not passed the delivery gate';
  }
  const artifactVersionId = snapshot.final_artifact.version_id;
  if (
    snapshot.gate.artifact_version_id !== artifactVersionId ||
    snapshot.execution_identity?.artifact_version_id !== artifactVersionId
  ) {
    return 'Forge gate, execution, and artifact versions do not match';
  }
  return null;
}

export function reconcileStage(
  plan: StagePlan,
  attempts: StageAttemptV21[],
  snapshots: Map<string, ForgeCaseSnapshot>,
  explicitCaseId?: string,
): ReconciliationAction[] {
  const rejected: ReconciliationAction[] = [];
  const candidates: StageAttemptV21[] = [];
  for (const attempt of attempts) {
    const snapshot = snapshots.get(attempt.case_id);
    if (!snapshot) {
      rejected.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: 'Forge case snapshot is missing',
      });
      continue;
    }
    const identityReason = rejectionReason(plan, attempt, snapshot);
    if (identityReason) {
      rejected.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: identityReason,
      });
      continue;
    }
    if (['failed', 'stopped'].includes(snapshot.status)) {
      rejected.push({
        action: 'close',
        attempt_id: attempt.attempt_id,
        outcome: 'failed',
        reason: `Forge case is terminal with status ${snapshot.status}`,
      });
      continue;
    }
    if (snapshot.status !== 'approved') {
      rejected.push({
        action: 'resume',
        attempt_id: attempt.attempt_id,
        case_id: attempt.case_id,
      });
      continue;
    }
    const adoptionReason = adoptionRejectionReason(plan, attempt, snapshot);
    if (adoptionReason) {
      rejected.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: adoptionReason,
      });
      continue;
    }
    candidates.push(attempt);
  }

  if (candidates.length === 0) return rejected;
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    return [{
      action: 'adopt',
      stage_key: plan.stage_key,
      attempt_id: candidate.attempt_id,
      case_id: candidate.case_id,
    }];
  }
  if (explicitCaseId) {
    const selected = candidates.find((candidate) => candidate.case_id === explicitCaseId);
    if (selected) {
      return [{
        action: 'adopt',
        stage_key: plan.stage_key,
        attempt_id: selected.attempt_id,
        case_id: selected.case_id,
      }];
    }
  }
  return [{
    action: 'ambiguous',
    stage_key: plan.stage_key,
    candidates: candidates.map((candidate) => candidate.case_id).sort(),
  }];
}

export function materializeDeliveredArtifact(
  options: MaterializeDeliveredArtifactOptions,
): MaterializedStageRecord {
  const {
    run_dir: runDirectory,
    manifest,
    plan,
    attempt,
    snapshot,
    validate,
  } = options;
  if (manifest.run_id !== plan.run_id || manifest.story_id !== plan.story_id) {
    throw new Error('manifest run identity does not match the stage plan');
  }
  if (snapshot.case_id !== attempt.case_id) {
    throw new Error('Forge snapshot case id does not match the attempt');
  }
  const rejection = adoptionRejectionReason(plan, attempt, snapshot);
  if (rejection) throw new Error(rejection);

  const invalidated = new Set(
    manifest.invalidations.map((invalidation) => invalidation.record_id),
  );
  const parents = plan.parent_record_ids.map((recordId) => {
    const parent = manifest.stages.find(
      (record) => record.record_id === recordId && !invalidated.has(recordId),
    );
    if (!parent) {
      throw new Error(`parent record is missing or invalidated: ${recordId}`);
    }
    return parent;
  });

  const artifactVersionId = snapshot.final_artifact!.version_id;
  const materializationKey = sha256(canonicalJson({
    run_id: plan.run_id,
    stage_key: plan.stage_key,
    input_sha256: plan.input_sha256,
    parent_record_ids: plan.parent_record_ids,
    case_id: attempt.case_id,
    artifact_version_id: artifactVersionId,
  }));
  const existing = manifest.stages.find((record) =>
    (record as Partial<MaterializedStageRecord>).materialization_key
      === materializationKey) as MaterializedStageRecord | undefined;
  if (existing) {
    verifyRecordFile(runDirectory, existing.raw_artifact_path, existing.raw_artifact_sha256);
    verifyRecordFile(runDirectory, existing.artifact_path, existing.artifact_sha256);
    verifyRecordFile(runDirectory, existing.sidecar_path, existing.sidecar_sha256);
    verifyRecordFile(
      runDirectory,
      existing.validation_report_path,
      existing.validation_report_sha256,
    );
    return existing;
  }

  if (manifest.stages.some(
    (record) =>
      record.stage_key === plan.stage_key && !invalidated.has(record.record_id),
  )) {
    throw new Error(`stage already has an active record: ${plan.stage_key}`);
  }

  const inputPath = insideRunDirectory(runDirectory, attempt.input_path);
  if (!existsSync(inputPath)) {
    throw new Error(`attempt input evidence is missing: ${attempt.input_path}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch {
    throw new Error(`attempt input evidence is not valid JSON: ${attempt.input_path}`);
  }
  if (sha256(canonicalJson(input)) !== plan.input_sha256) {
    throw new Error('attempt input evidence SHA-256 does not match the stage plan');
  }

  const validation = validate(snapshot.final_artifact!.content);
  if (!validation.report.valid) {
    throw new Error(
      `delivered artifact failed structural validation: ${validation.report.errors.join('; ')}`,
    );
  }
  const serializedSidecar = JSON.stringify(validation.sidecar);
  const serializedReport = JSON.stringify(validation.report);
  JSON.parse(serializedSidecar);
  JSON.parse(serializedReport);

  const revision = Math.max(
    0,
    ...manifest.stages
      .filter((record) => record.stage_key === plan.stage_key)
      .map((record) => record.revision),
  ) + 1;
  const recordId = `${plan.stage_key}-v${revision}`;
  const rawArtifactPath = `raw-artifacts/${plan.stage_key}/${attempt.attempt_id}.md`;
  const artifactPath = `artifacts/${recordId}.md`;
  const sidecarPath = `structured/${recordId}.json`;
  const validationReportPath = `validation/${plan.stage_key}/${attempt.attempt_id}.json`;
  const rawArtifactAbsolute = insideRunDirectory(runDirectory, rawArtifactPath);
  const artifactAbsolute = insideRunDirectory(runDirectory, artifactPath);
  const sidecarAbsolute = insideRunDirectory(runDirectory, sidecarPath);
  const validationReportAbsolute = insideRunDirectory(
    runDirectory,
    validationReportPath,
  );

  mkdirSync(dirname(rawArtifactAbsolute), { recursive: true });
  mkdirSync(dirname(artifactAbsolute), { recursive: true });
  writeFileSync(rawArtifactAbsolute, snapshot.final_artifact!.content, 'utf8');
  writeFileSync(artifactAbsolute, validation.canonicalContent, 'utf8');
  writeJson(sidecarAbsolute, validation.sidecar);
  writeJson(validationReportAbsolute, validation.report);

  const completedAt = options.completed_at ?? new Date().toISOString();
  const record: MaterializedStageRecord = {
    record_id: recordId,
    revision,
    stage_key: plan.stage_key,
    stage: plan.stage,
    chapter_id: plan.chapter_id,
    template: attempt.template,
    template_identity: plan.template_identity,
    case_id: attempt.case_id,
    parent_record_ids: [...plan.parent_record_ids],
    parent_case_ids: parents.map((parent) => parent.case_id),
    status: 'delivered',
    input_path: attempt.input_path,
    input_sha256: plan.input_sha256,
    raw_artifact_path: rawArtifactPath,
    raw_artifact_sha256: sha256(readFileSync(rawArtifactAbsolute)),
    artifact_path: artifactPath,
    artifact_sha256: sha256(readFileSync(artifactAbsolute)),
    sidecar_path: sidecarPath,
    sidecar_sha256: sha256(readFileSync(sidecarAbsolute)),
    validation_report_path: validationReportPath,
    validation_report_sha256: sha256(readFileSync(validationReportAbsolute)),
    artifact_type: snapshot.final_artifact!.type,
    artifact_version: snapshot.final_artifact!.version,
    artifact_version_id: artifactVersionId,
    materialization_key: materializationKey,
    completed_at: completedAt,
  };
  const beforeOutcome = attempt.outcome;
  attempt.outcome = 'delivered';
  attempt.raw_artifact_path = rawArtifactPath;
  attempt.validation_report_path = validationReportPath;
  attempt.updated_at = completedAt;
  attempt.detail = null;
  manifest.stages.push(record);
  appendManifestEvent(manifest, {
    at: completedAt,
    type: 'stage_delivered',
    stage_key: plan.stage_key,
    attempt_id: attempt.attempt_id,
    before_outcome: beforeOutcome,
    after_outcome: 'delivered',
    case_id: attempt.case_id,
    artifact_id: snapshot.final_artifact!.artifact_id,
    artifact_version: snapshot.final_artifact!.version,
    version_id: artifactVersionId,
    record_id: recordId,
    reason: 'Forge delivery identity verified and materialized',
    actor: 'story-pipeline',
  });
  return record;
}
