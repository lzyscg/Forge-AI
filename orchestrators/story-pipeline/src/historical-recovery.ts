import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ForgeCaseSnapshot } from './forge-client.js';
import { sha256 } from './hash.js';
import {
  appendManifestEvent,
  type LegacyBindingAttestation,
  type PipelineManifestV21,
  type StageAttemptV21,
  type StageRecordV21,
  type TemplateIdentity,
  validateManifestChain,
} from './manifest.js';
import {
  materializeDeliveredArtifact,
  type StagePlan,
} from './reconciliation.js';
import type { ValidationResult } from './quality.js';

export type HistoricalRecoveryAction =
  | {
      action: 'attestation_required';
      kind: 'template_compatibility';
      reason: string;
    }
  | {
      action: 'reinstate';
      stage_key: string;
      old_record_id: string;
      new_record_id: string;
      case_id: string;
    }
  | {
      action: 'close';
      attempt_id: string;
      outcome: 'failed' | 'interrupted';
      reason: string;
    }
  | {
      action: 'ambiguous';
      stage_key: string;
      candidates: string[];
    }
  | {
      action: 'adopt';
      stage_key: string;
      attempt_id: string;
      case_id: string;
      record_id: string;
    };

export interface HistoricalRecoveryOptions {
  run_dir: string;
  manifest: PipelineManifestV21;
  chapter_ids: string[];
  snapshots: Map<string, ForgeCaseSnapshot>;
  apply: boolean;
  adopt_case?: string;
  attest_template_compatibility: boolean;
  legacy_case_bindings: string[];
  attestation_reason?: string;
  validators: Record<string, (content: string) => ValidationResult>;
  now?: string;
}

export interface HistoricalRecoveryResult {
  applicable: boolean;
  actions: HistoricalRecoveryAction[];
  ambiguous: Array<{ stage_key: string; candidates: string[] }>;
  next_stage: string | null;
  manifest: PipelineManifestV21;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeEvidencePath(runDirectory: string, relativePath: string): string {
  const root = realpathSync(resolve(runDirectory));
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`historical evidence escapes run directory: ${relativePath}`);
  }
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`historical evidence is missing or unsafe: ${relativePath}`);
  }
  const canonical = realpathSync(absolute);
  const canonicalRel = relative(root, canonical);
  if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
    throw new Error(`historical evidence escapes run directory: ${relativePath}`);
  }
  return canonical;
}

function verifyFile(
  runDirectory: string,
  path: string,
  expectedSha256: string,
): Buffer {
  const content = readFileSync(safeEvidencePath(runDirectory, path));
  if (sha256(content) !== expectedSha256) {
    throw new Error(`historical evidence SHA-256 mismatch: ${path}`);
  }
  return content;
}

function recoveryInput(
  runDirectory: string,
  attempt: StageAttemptV21,
): Record<string, unknown> {
  const bytes = verifyFile(
    runDirectory,
    attempt.input_path,
    sha256(readFileSync(safeEvidencePath(runDirectory, attempt.input_path))),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`historical input is not valid JSON: ${attempt.input_path}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`historical input must be an object: ${attempt.input_path}`);
  }
  if (sha256(canonicalJson(parsed)) !== attempt.input_sha256) {
    throw new Error('historical input SHA-256 does not match the Attempt');
  }
  return parsed as Record<string, unknown>;
}

function inferredStage(stageKey: string): {
  stage: string;
  chapter_id: string | null;
  expected_artifact_type: string;
} {
  if (stageKey === 'outline') {
    return {
      stage: 'outline',
      chapter_id: null,
      expected_artifact_type: 'blueprint_bundle',
    };
  }
  if (stageKey.startsWith('packet-')) {
    return {
      stage: 'chapter_packet',
      chapter_id: stageKey.slice('packet-'.length).toUpperCase(),
      expected_artifact_type: 'chapter_packet',
    };
  }
  if (stageKey.startsWith('draft-')) {
    return {
      stage: 'chapter_draft',
      chapter_id: stageKey.slice('draft-'.length).toUpperCase(),
      expected_artifact_type: 'chapter_draft',
    };
  }
  throw new Error(`unsupported historical recovery stage: ${stageKey}`);
}

function historicalEvent(
  manifest: PipelineManifestV21,
  attempt: StageAttemptV21,
  oldRecordId?: string,
) {
  const event = manifest.events.find((candidate) =>
    candidate.case_id === attempt.case_id
    && candidate.stage_key === attempt.stage_key
    && (
      candidate.attempt_id === attempt.attempt_id
      || candidate.detail === attempt.attempt_id
      || (
        oldRecordId !== undefined
        && candidate.record_id === oldRecordId
      )
    )
  );
  if (!event) {
    throw new Error(
      `historical Attempt event is missing: ${attempt.attempt_id}`,
    );
  }
  return event;
}

function operatorIdentity(before: TemplateIdentity): TemplateIdentity {
  if (
    before.algorithm !== 'legacy-unversioned-v1'
    || before.equivalence !== 'unknown'
  ) {
    throw new Error('historical recovery only accepts legacy unknown identity');
  }
  return { ...before, equivalence: 'operator_attested' };
}

function verifyLegacySnapshot(
  attempt: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
  expectedArtifactType: string,
  expectedContentSha256?: string,
): void {
  const evidence = snapshot.legacy_case_evidence;
  if (
    snapshot.case_id !== attempt.case_id
    || snapshot.case_identity !== null
    || snapshot.execution_identity !== null
    || !evidence
    || evidence.protocol_identity_absent !== true
    || evidence.input_payload_sha256 !== attempt.input_sha256
  ) {
    throw new Error('legacy Case input evidence does not match');
  }
  if (
    snapshot.status !== 'approved'
    || snapshot.success !== true
    || snapshot.final_artifact?.status !== 'delivered'
    || snapshot.final_artifact.type !== expectedArtifactType
    || snapshot.gate?.status !== 'pass'
    || snapshot.gate.artifact_version_id
      !== snapshot.final_artifact.version_id
  ) {
    throw new Error('legacy Case delivery evidence does not match');
  }
  if (
    expectedContentSha256 !== undefined
    && sha256(snapshot.final_artifact.content) !== expectedContentSha256
  ) {
    throw new Error('legacy Case artifact content does not match file evidence');
  }
}

function nextStage(
  manifest: PipelineManifestV21,
  chapterIds: string[],
): string | null {
  const invalidated = new Set(
    manifest.invalidations.map((item) => item.record_id),
  );
  const active = new Set(
    manifest.stages
      .filter((record) => !invalidated.has(record.record_id))
      .map((record) => record.stage_key),
  );
  if (!active.has('outline')) return 'outline';
  for (const chapterId of chapterIds) {
    const key = chapterId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!active.has(`packet-${key}`)) return `packet-${key}`;
    if (!active.has(`draft-${key}`)) return `draft-${key}`;
    if (!active.has(`ledger-${key}`)) return `ledger-${key}`;
  }
  return active.has('final') ? null : 'final';
}

function attestation(
  manifest: PipelineManifestV21,
  projection: StageAttemptV21,
  historicalAttempt: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
  after: TemplateIdentity,
  eventSha256: string,
  reason: string,
  at: string,
): LegacyBindingAttestation {
  return {
    proof: 'operator_attested',
    case_id: projection.case_id,
    run_id: manifest.run_id,
    story_id: manifest.story_id,
    stage_key: projection.stage_key,
    chapter_id: projection.chapter_id,
    input_sha256: projection.input_sha256,
    scenario_snapshot_sha256:
      snapshot.legacy_case_evidence!.scenario_snapshot_sha256,
    attempt_id: projection.attempt_id,
    historical_attempt_id: historicalAttempt.attempt_id,
    historical_event_sha256: eventSha256,
    template_identity_before: projection.template_identity,
    template_identity_after: after,
    attested_at: at,
    reason,
  };
}

function projectionAttempt(
  manifest: PipelineManifestV21,
  historical: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
  parentRecordIds: string[],
  suffix: string,
  now: string,
): StageAttemptV21 {
  const inferred = inferredStage(historical.stage_key);
  const idBase = `${historical.attempt_id}-${suffix}`;
  let attemptId = idBase;
  let sequence = 2;
  while (manifest.attempts.some((item) => item.attempt_id === attemptId)) {
    attemptId = `${idBase}-${sequence}`;
    sequence += 1;
  }
  return {
    attempt_id: attemptId,
    stage_key: historical.stage_key,
    stage: inferred.stage,
    chapter_id: inferred.chapter_id,
    template: snapshot.legacy_case_evidence!.scenario_id,
    expected_artifact_type: inferred.expected_artifact_type,
    expected_scenario_snapshot_sha256: null,
    case_id: historical.case_id,
    input_sha256: historical.input_sha256,
    parent_record_ids: parentRecordIds,
    template_identity: { ...historical.template_identity },
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome: 'interrupted',
    input_path: historical.input_path,
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: now,
    updated_at: now,
    detail: 'historical recovery projection',
  };
}

function exactLegacyBinding(
  bindings: string[],
  caseId: string,
  stageKey: string,
): boolean {
  return bindings.includes(`${caseId}:${stageKey}`);
}

export function recoverLegacyHistory(
  options: HistoricalRecoveryOptions,
): HistoricalRecoveryResult {
  const original = options.manifest;
  const invalidated = new Set(
    original.invalidations.map((item) => item.record_id),
  );
  const pendingReinstatements = original.stages.filter((record) =>
    invalidated.has(record.record_id)
    && !original.reinstatements.some(
      (item) => item.old_record_id === record.record_id,
    )
  );
  const hasLegacy = pendingReinstatements.some(
    (record) =>
      record.template_identity.algorithm === 'legacy-unversioned-v1',
  );
  const currentNextStage = nextStage(original, options.chapter_ids);
  const alreadyRecovered = !hasLegacy
    && currentNextStage !== 'outline'
    && !currentNextStage?.startsWith('packet-')
    && !currentNextStage?.startsWith('draft-');
  if (alreadyRecovered) {
    return {
      applicable: true,
      actions: [],
      ambiguous: [],
      next_stage: currentNextStage,
      manifest: original,
    };
  }
  if (!hasLegacy) {
    return {
      applicable: false,
      actions: [],
      ambiguous: [],
      next_stage: currentNextStage,
      manifest: original,
    };
  }

  const actions: HistoricalRecoveryAction[] = [{
    action: 'attestation_required',
    kind: 'template_compatibility',
    reason: 'legacy template bundle cannot be cryptographically reproduced',
  }];
  const ambiguous: Array<{ stage_key: string; candidates: string[] }> = [];
  const now = options.now ?? new Date().toISOString();
  const reason = options.attestation_reason?.trim() ?? '';
  if (
    options.apply
    && (
      !options.attest_template_compatibility
      || reason.length === 0
    )
  ) {
    throw new Error(
      'historical recovery requires template attestation and a non-empty reason',
    );
  }

  const working = structuredClone(original);
  const restoredIds = new Map<string, string>();
  const restoredRecords: StageRecordV21[] = [];

  for (const oldRecord of pendingReinstatements) {
    const historicalAttempt = working.attempts.find((attempt) =>
      attempt.case_id === oldRecord.case_id
      && attempt.stage_key === oldRecord.stage_key
      && attempt.input_sha256 === oldRecord.input_sha256
    );
    if (!historicalAttempt) {
      throw new Error(
        `historical delivered Attempt is missing: ${oldRecord.record_id}`,
      );
    }
    const snapshot = options.snapshots.get(oldRecord.case_id);
    if (!snapshot) {
      throw new Error(`historical Case snapshot is missing: ${oldRecord.case_id}`);
    }
    recoveryInput(options.run_dir, historicalAttempt);
    verifyFile(
      options.run_dir,
      oldRecord.raw_artifact_path,
      oldRecord.raw_artifact_sha256,
    );
    const artifactBytes = verifyFile(
      options.run_dir,
      oldRecord.artifact_path,
      oldRecord.artifact_sha256,
    );
    verifyFile(
      options.run_dir,
      oldRecord.sidecar_path,
      oldRecord.sidecar_sha256,
    );
    verifyFile(
      options.run_dir,
      oldRecord.validation_report_path,
      oldRecord.validation_report_sha256,
    );
    verifyLegacySnapshot(
      historicalAttempt,
      snapshot,
      oldRecord.artifact_type,
      oldRecord.raw_artifact_sha256,
    );
    const validator = options.validators[oldRecord.stage_key];
    if (!validator) {
      throw new Error(`historical validator is missing: ${oldRecord.stage_key}`);
    }
    const validation = validator(snapshot.final_artifact!.content);
    if (
      !validation.report.valid
      || sha256(validation.canonicalContent) !== oldRecord.artifact_sha256
      || !artifactBytes.equals(Buffer.from(validation.canonicalContent))
    ) {
      throw new Error(
        `historical artifact structural validation failed: ${oldRecord.stage_key}`,
      );
    }
    const parentRecordIds = oldRecord.parent_record_ids.map((recordId) =>
      restoredIds.get(recordId) ?? recordId
    );
    if (oldRecord.stage.startsWith('chapter_packet')) {
      const input = recoveryInput(options.run_dir, historicalAttempt);
      const parent = restoredRecords.find(
        (record) => record.record_id === parentRecordIds[0],
      );
      if (
        !parent
        || typeof input.blueprint_bundle !== 'string'
        || sha256(input.blueprint_bundle) !== parent.artifact_sha256
      ) {
        throw new Error('packet input does not match reinstated outline evidence');
      }
    }
    const projection = projectionAttempt(
      working,
      historicalAttempt,
      snapshot,
      parentRecordIds,
      'reinstatement',
      now,
    );
    const afterIdentity = operatorIdentity(historicalAttempt.template_identity);
    const event = historicalEvent(
      working,
      historicalAttempt,
      oldRecord.record_id,
    );
    const revision = Math.max(
      ...working.stages
        .filter((record) => record.stage_key === oldRecord.stage_key)
        .map((record) => record.revision),
    ) + 1;
    const newRecord: StageRecordV21 = {
      ...oldRecord,
      record_id: `${oldRecord.stage_key}-v${revision}`,
      revision,
      parent_record_ids: parentRecordIds,
      parent_case_ids: parentRecordIds.map((recordId) => {
        const parent = [...working.stages, ...restoredRecords].find(
          (record) => record.record_id === recordId,
        );
        if (!parent) {
          throw new Error(`reinstated parent is missing: ${recordId}`);
        }
        return parent.case_id;
      }),
      template_identity: afterIdentity,
      legacy_binding_attestation: attestation(
        working,
        projection,
        historicalAttempt,
        snapshot,
        afterIdentity,
        event.event_sha256,
        reason || 'operator attestation required',
        now,
      ),
      completed_at: now,
    };
    actions.push({
      action: 'reinstate',
      stage_key: oldRecord.stage_key,
      old_record_id: oldRecord.record_id,
      new_record_id: newRecord.record_id,
      case_id: oldRecord.case_id,
    });
    restoredIds.set(oldRecord.record_id, newRecord.record_id);
    restoredRecords.push(newRecord);
    if (options.apply) {
      projection.outcome = 'delivered';
      projection.raw_artifact_path = newRecord.raw_artifact_path;
      projection.validation_report_path = newRecord.validation_report_path;
      projection.detail = null;
      working.attempts.push(projection);
      working.stages.push(newRecord);
      working.reinstatements.push({
        reinstatement_id: `reinstate-${sha256(canonicalJson({
          old_record_id: oldRecord.record_id,
          new_record_id: newRecord.record_id,
          case_id: oldRecord.case_id,
        })).slice(0, 24)}`,
        old_record_id: oldRecord.record_id,
        new_record_id: newRecord.record_id,
        case_id: oldRecord.case_id,
        evidence_sha256: newRecord.artifact_sha256,
        compatibility: 'operator_attested',
        reason,
      });
      appendManifestEvent(working, {
        at: now,
        type: 'stage_reinstated',
        stage_key: newRecord.stage_key,
        attempt_id: projection.attempt_id,
        before_outcome: null,
        after_outcome: 'delivered',
        case_id: newRecord.case_id,
        artifact_id: snapshot.final_artifact!.artifact_id,
        artifact_version: snapshot.final_artifact!.version,
        version_id: snapshot.final_artifact!.version_id,
        record_id: newRecord.record_id,
        reason,
        actor: 'operator',
      });
    }
  }

  const chapterId = options.chapter_ids[0];
  if (!chapterId) throw new Error('historical recovery requires one chapter');
  const chapterKey = chapterId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const draftStageKey = `draft-${chapterKey}`;
  const nonterminal = working.attempts.filter((attempt) =>
    ['running', 'interrupted', 'blocked'].includes(attempt.outcome)
  );
  const draftApproved: StageAttemptV21[] = [];
  const closeActions: HistoricalRecoveryAction[] = [];
  for (const candidate of nonterminal) {
    const snapshot = options.snapshots.get(candidate.case_id);
    if (!snapshot) continue;
    if (snapshot.status === 'stopped' || snapshot.status === 'failed') {
      closeActions.push({
        action: 'close',
        attempt_id: candidate.attempt_id,
        outcome: 'failed',
        reason: `Forge case is terminal with status ${snapshot.status}`,
      });
    } else if (
      candidate.stage_key === draftStageKey
      && snapshot.status === 'approved'
    ) {
      const inferred = inferredStage(draftStageKey);
      verifyLegacySnapshot(
        candidate,
        snapshot,
        inferred.expected_artifact_type,
      );
      recoveryInput(options.run_dir, candidate);
      draftApproved.push(candidate);
    } else if (candidate.stage_key === draftStageKey) {
      closeActions.push({
        action: 'close',
        attempt_id: candidate.attempt_id,
        outcome: 'interrupted',
        reason: `Forge case is not an approved historical recovery candidate: ${snapshot.status}`,
      });
    }
  }
  actions.push(...closeActions);

  let selected: StageAttemptV21 | undefined;
  if (draftApproved.length > 1 && !options.adopt_case) {
    const conflict = {
      stage_key: draftStageKey,
      candidates: draftApproved.map((attempt) => attempt.case_id).sort(),
    };
    ambiguous.push(conflict);
    actions.push({ action: 'ambiguous', ...conflict });
  } else if (draftApproved.length > 0) {
    selected = options.adopt_case
      ? draftApproved.find((attempt) => attempt.case_id === options.adopt_case)
      : draftApproved[0];
    if (!selected) {
      throw new Error('explicit legacy adoption Case is not an approved candidate');
    }
  }
  if (!options.apply || !selected) {
    return {
      applicable: true,
      actions,
      ambiguous,
      next_stage: nextStage(original, options.chapter_ids),
      manifest: original,
    };
  }
  if (
    !exactLegacyBinding(
      options.legacy_case_bindings,
      selected.case_id,
      selected.stage_key,
    )
  ) {
    throw new Error('selected legacy Case requires an exact binding attestation');
  }

  for (const action of closeActions) {
    if (action.action !== 'close') continue;
    const candidate = working.attempts.find(
      (attempt) => attempt.attempt_id === action.attempt_id,
    )!;
    const before = candidate.outcome;
    candidate.outcome = action.outcome;
    candidate.updated_at = now;
    candidate.detail = action.reason;
    appendManifestEvent(working, {
      at: now,
      type: action.outcome === 'failed'
        ? 'stage_failed'
        : 'stage_interrupted',
      stage_key: candidate.stage_key,
      attempt_id: candidate.attempt_id,
      before_outcome: before,
      after_outcome: action.outcome,
      case_id: candidate.case_id,
      artifact_id: null,
      artifact_version: null,
      version_id: null,
      record_id: null,
      reason: action.reason,
      actor: 'story-pipeline',
    });
  }
  for (const unselected of draftApproved.filter(
    (candidate) => candidate !== selected,
  )) {
    const before = unselected.outcome;
    unselected.outcome = 'interrupted';
    unselected.updated_at = now;
    unselected.detail = `Forge case was not selected for stage ${draftStageKey}`;
    actions.push({
      action: 'close',
      attempt_id: unselected.attempt_id,
      outcome: 'interrupted',
      reason: unselected.detail,
    });
    appendManifestEvent(working, {
      at: now,
      type: 'stage_interrupted',
      stage_key: unselected.stage_key,
      attempt_id: unselected.attempt_id,
      before_outcome: before,
      after_outcome: 'interrupted',
      case_id: unselected.case_id,
      artifact_id: null,
      artifact_version: null,
      version_id: null,
      record_id: null,
      reason: unselected.detail,
      actor: 'story-pipeline',
    });
  }

  const selectedSnapshot = options.snapshots.get(selected.case_id)!;
  const packetRecord = working.stages.find(
    (record) =>
      record.stage_key === `packet-${chapterKey}`
      && !invalidated.has(record.record_id),
  ) ?? restoredRecords.find(
    (record) => record.stage_key === `packet-${chapterKey}`,
  );
  if (!packetRecord) throw new Error('reinstated packet record is missing');
  const draftInput = recoveryInput(options.run_dir, selected);
  if (
    typeof draftInput.chapter_packet !== 'string'
    || sha256(draftInput.chapter_packet) !== packetRecord.artifact_sha256
  ) {
    throw new Error('draft input does not match reinstated packet evidence');
  }
  const projection = projectionAttempt(
    working,
    selected,
    selectedSnapshot,
    [packetRecord.record_id],
    'adoption',
    now,
  );
  const afterIdentity = operatorIdentity(selected.template_identity);
  const event = historicalEvent(working, selected);
  const binding = attestation(
    working,
    projection,
    selected,
    selectedSnapshot,
    afterIdentity,
    event.event_sha256,
    reason,
    now,
  );
  working.attempts.push(projection);
  const draftPlan: StagePlan = {
    run_id: working.run_id,
    story_id: working.story_id,
    stage_key: draftStageKey,
    stage: 'chapter_draft',
    chapter_id: chapterId,
    expected_artifact_type: 'chapter_draft',
    expected_scenario_snapshot_sha256: null,
    input_sha256: projection.input_sha256,
    parent_record_ids: [packetRecord.record_id],
    template_identity: afterIdentity,
  };
  const validator = options.validators[draftStageKey];
  if (!validator) throw new Error(`historical validator is missing: ${draftStageKey}`);
  const record = materializeDeliveredArtifact({
    run_dir: options.run_dir,
    manifest: working,
    plan: draftPlan,
    attempt: projection,
    snapshot: selectedSnapshot,
    validate: validator,
    completed_at: now,
    legacy_binding_attestation: binding,
  });
  actions.push({
    action: 'adopt',
    stage_key: draftStageKey,
    attempt_id: projection.attempt_id,
    case_id: selected.case_id,
    record_id: record.record_id,
  });
  validateManifestChain(working);
  return {
    applicable: true,
    actions,
    ambiguous,
    next_stage: nextStage(working, options.chapter_ids),
    manifest: working,
  };
}
