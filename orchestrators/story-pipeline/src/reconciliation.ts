import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type { ForgeCaseSnapshot } from './forge-client.js';
import { sha256 } from './hash.js';
import {
  appendManifestEvent,
  AttemptOutcome,
  type LegacyBindingAttestation,
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
  expected_scenario_snapshot_sha256: string | null;
  input_sha256: string;
  parent_record_ids: string[];
  template_identity: TemplateIdentity;
}

export type ReconciliationAction =
  | { action: 'adopt'; stage_key: string; attempt_id: string; case_id: string }
  | { action: 'close'; attempt_id: string; outcome: AttemptOutcome; reason: string }
  | { action: 'block'; attempt_id: string; case_id: string; reason: string }
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
  activation?: 'active' | 'candidate';
  completed_at?: string;
  fs_ops?: Partial<MaterializationFsOps>;
  legacy_binding_attestation?: LegacyBindingAttestation;
}

export interface MaterializationFileStat {
  isSymbolicLink(): boolean;
}

export interface MaterializationFsOps {
  exists(path: string): boolean;
  lstat(path: string): MaterializationFileStat;
  realpath(path: string): string;
  mkdir(path: string): void;
  readFile(path: string): Buffer;
  writeFile(path: string, content: string): void;
  fsyncFile(path: string): void;
  fsyncDirectory(path: string): void;
  listDirectory(path: string): string[];
  rename(from: string, to: string): void;
  removeTree(path: string): void;
}

const defaultMaterializationFsOps: MaterializationFsOps = {
  exists: existsSync,
  lstat: lstatSync,
  realpath: realpathSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  readFile: readFileSync,
  writeFile: (path, content) => {
    writeFileSync(path, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  },
  fsyncFile: (path) => {
    const descriptor = openSync(path, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  fsyncDirectory: (path) => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      fsyncSync(descriptor);
    } catch (error) {
      if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  },
  listDirectory: (path) => readdirSync(path),
  rename: renameSync,
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};

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

function pathIsInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeMaterializationPath(
  runDirectory: string,
  path: string,
  fsOps: MaterializationFsOps,
): string {
  const requestedRoot = resolve(runDirectory);
  const absolute = resolve(requestedRoot, path);
  const rel = relative(requestedRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`materialization path escapes the run directory: ${path}`);
  }
  if (!fsOps.exists(requestedRoot)) {
    throw new Error(`materialization run directory does not exist: ${requestedRoot}`);
  }
  if (fsOps.lstat(requestedRoot).isSymbolicLink()) {
    throw new Error(
      'materialization path contains a symbolic link or reparse point',
    );
  }
  const canonicalRoot = fsOps.realpath(requestedRoot);
  let current = requestedRoot;
  for (const component of rel.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, component);
    if (!fsOps.exists(current)) break;
    if (fsOps.lstat(current).isSymbolicLink()) {
      throw new Error(
        'materialization path contains a symbolic link or reparse point',
      );
    }
    if (!pathIsInside(canonicalRoot, fsOps.realpath(current))) {
      throw new Error('materialization path resolves outside the run directory');
    }
  }
  return absolute;
}

function ensureSafeParentDirectory(
  runDirectory: string,
  path: string,
  fsOps: MaterializationFsOps,
): void {
  const parent = dirname(path);
  safeMaterializationPath(runDirectory, parent, fsOps);
  fsOps.mkdir(parent);
  safeMaterializationPath(runDirectory, parent, fsOps);
}

function verifyRecordFile(
  runDirectory: string,
  path: string,
  expectedSha256: string,
  fsOps: MaterializationFsOps,
): void {
  const absolute = safeMaterializationPath(runDirectory, path, fsOps);
  if (!fsOps.exists(absolute) || sha256(fsOps.readFile(absolute)) !== expectedSha256) {
    throw new Error(`materialized artifact evidence is missing or changed: ${path}`);
  }
}

interface BundleEvidence {
  name: string;
  content: string;
  expectedSha256: string;
}

function verifyMaterializationBundle(
  runDirectory: string,
  bundlePath: string,
  evidence: BundleEvidence[],
  fsOps: MaterializationFsOps,
): boolean {
  const safeBundlePath = safeMaterializationPath(
    runDirectory,
    bundlePath,
    fsOps,
  );
  if (!fsOps.exists(safeBundlePath)) return false;
  const expectedNames = evidence.map((item) => item.name).sort();
  const actualNames = fsOps.listDirectory(safeBundlePath).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) return false;
  return evidence.every((item) => {
    const path = safeMaterializationPath(
      runDirectory,
      join(safeBundlePath, item.name),
      fsOps,
    );
    return fsOps.exists(path) &&
      sha256(fsOps.readFile(path)) === item.expectedSha256;
  });
}

function removeSafeTree(
  runDirectory: string,
  path: string,
  fsOps: MaterializationFsOps,
): void {
  const safePath = safeMaterializationPath(runDirectory, path, fsOps);
  if (!fsOps.exists(safePath)) return;
  fsOps.removeTree(safePath);
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
  if (plan.expected_scenario_snapshot_sha256 === null) {
    return 'Stage plan scenario snapshot identity is unavailable';
  }
  if (attempt.expected_scenario_snapshot_sha256 === null) {
    return 'Attempt scenario snapshot identity is unavailable';
  }
  if (
    attempt.expected_scenario_snapshot_sha256
      !== plan.expected_scenario_snapshot_sha256 ||
    caseIdentity.scenario_snapshot_sha256
      !== plan.expected_scenario_snapshot_sha256
  ) {
    return 'Forge scenario snapshot identity does not match the stage plan';
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
    plan.template_identity.equivalence === 'unknown' ||
    attempt.template_identity.equivalence === 'unknown'
  ) {
    return 'Template identity equivalence is not attested';
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

export function requireScenarioSnapshotIdentity(
  snapshot: ForgeCaseSnapshot,
  expectedCaseId: string,
): string {
  const identity = snapshot.case_identity;
  if (
    snapshot.case_id !== expectedCaseId ||
    !identity ||
    identity.scenario_snapshot_sha256.length === 0
  ) {
    throw new Error('new Forge case has no immutable scenario snapshot identity');
  }
  return identity.scenario_snapshot_sha256;
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

function legacyAdoptionRejectionReason(
  manifest: PipelineManifestV21,
  plan: StagePlan,
  attempt: StageAttemptV21,
  snapshot: ForgeCaseSnapshot,
  attestation: LegacyBindingAttestation,
): string | null {
  const evidence = snapshot.legacy_case_evidence;
  if (
    snapshot.identity_protocol_version !== null
    || snapshot.case_identity !== null
    || snapshot.execution_identity !== null
    || !evidence
    || evidence.protocol_identity_absent !== true
  ) {
    return 'legacy Case protocol evidence is unavailable';
  }
  if (
    attempt.template_identity.algorithm !== 'legacy-unversioned-v1'
    || attempt.template_identity.equivalence !== 'unknown'
    || attempt.expected_scenario_snapshot_sha256 !== null
    || plan.expected_scenario_snapshot_sha256 !== null
    || plan.template_identity.algorithm !== attempt.template_identity.algorithm
    || plan.template_identity.content_sha256
      !== attempt.template_identity.content_sha256
    || plan.template_identity.equivalence !== 'operator_attested'
  ) {
    return 'Attempt is not eligible for legacy identity attestation';
  }
  if (
    attempt.stage_key !== plan.stage_key
    || attempt.stage !== plan.stage
    || attempt.chapter_id !== plan.chapter_id
    || attempt.input_sha256 !== plan.input_sha256
    || canonicalJson(attempt.parent_record_ids)
      !== canonicalJson(plan.parent_record_ids)
  ) {
    return 'Attempt identity does not match the legacy stage plan';
  }
  if (
    attestation.proof !== 'operator_attested'
    || attestation.reason.trim().length === 0
    || attestation.case_id !== attempt.case_id
    || attestation.run_id !== manifest.run_id
    || attestation.story_id !== manifest.story_id
    || attestation.stage_key !== attempt.stage_key
    || attestation.chapter_id !== attempt.chapter_id
    || attestation.input_sha256 !== attempt.input_sha256
    || attestation.input_file_sha256.length === 0
    || attestation.attempt_id !== attempt.attempt_id
    || canonicalJson(attestation.template_identity_before)
      !== canonicalJson(attempt.template_identity)
    || canonicalJson(attestation.template_identity_after)
      !== canonicalJson(plan.template_identity)
  ) {
    return 'legacy binding attestation does not match the Attempt';
  }
  if (
    evidence.scenario_id !== attempt.template
    || evidence.input_payload_sha256 !== attempt.input_sha256
    || evidence.input_payload_sha256 !== attestation.input_sha256
  ) {
    return 'legacy Case input evidence does not match';
  }
  if (
    evidence.scenario_snapshot_sha256
      !== attestation.scenario_snapshot_sha256
  ) {
    return 'legacy Case scenario evidence does not match';
  }
  const historicalEvent = manifest.events.find(
    (event) => event.event_sha256 === attestation.historical_event_sha256,
  );
  const historicalAttempt = manifest.attempts.find(
    (candidate) =>
      candidate.attempt_id === attestation.historical_attempt_id,
  );
  if (
    !historicalAttempt
    || historicalAttempt.case_id !== attempt.case_id
    || historicalAttempt.stage_key !== attempt.stage_key
    || historicalAttempt.input_sha256 !== attempt.input_sha256
    || !historicalEvent
    || historicalEvent.case_id !== attempt.case_id
    || historicalEvent.stage_key !== attempt.stage_key
    || (
      historicalEvent.attempt_id !== undefined
      && historicalEvent.attempt_id !== null
      && historicalEvent.attempt_id !== historicalAttempt.attempt_id
    )
  ) {
    return 'legacy binding historical Attempt event does not match';
  }
  if (
    snapshot.status !== 'approved'
    || snapshot.success !== true
    || snapshot.gate?.status !== 'pass'
    || snapshot.final_artifact?.status !== 'delivered'
    || snapshot.final_artifact.type !== plan.expected_artifact_type
  ) {
    return 'Forge legacy Case has not passed the delivery gate';
  }
  if (
    snapshot.gate.artifact_version_id
      !== snapshot.final_artifact.version_id
  ) {
    return 'Forge legacy gate and artifact versions do not match';
  }
  return null;
}

export function reconcileStage(
  plan: StagePlan,
  attempts: StageAttemptV21[],
  snapshots: Map<string, ForgeCaseSnapshot>,
  explicitCaseId?: string,
): ReconciliationAction[] {
  const cleanup: ReconciliationAction[] = [];
  const live: Array<{
    attempt: StageAttemptV21;
    action: 'adopt' | 'block' | 'resume';
  }> = [];
  for (const attempt of attempts) {
    const snapshot = snapshots.get(attempt.case_id);
    if (!snapshot) {
      cleanup.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: 'Forge case snapshot is missing',
      });
      continue;
    }
    const identityReason = rejectionReason(plan, attempt, snapshot);
    if (identityReason) {
      cleanup.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: identityReason,
      });
      continue;
    }
    if (['failed', 'stopped'].includes(snapshot.status)) {
      cleanup.push({
        action: 'close',
        attempt_id: attempt.attempt_id,
        outcome: 'failed',
        reason: `Forge case is terminal with status ${snapshot.status}`,
      });
      continue;
    }
    if (snapshot.status === 'waiting_human') {
      live.push({ attempt, action: 'block' });
      continue;
    }
    if (snapshot.status !== 'approved') {
      live.push({ attempt, action: 'resume' });
      continue;
    }
    const adoptionReason = adoptionRejectionReason(plan, attempt, snapshot);
    if (adoptionReason) {
      cleanup.push({
        action: 'reject',
        attempt_id: attempt.attempt_id,
        reason: adoptionReason,
      });
      continue;
    }
    live.push({ attempt, action: 'adopt' });
  }

  if (live.length === 0) return cleanup;
  const selected = live.length === 1
    ? live[0]!
    : explicitCaseId
      ? live.find((candidate) => candidate.attempt.case_id === explicitCaseId)
      : undefined;
  if (!selected) {
    return [
      ...cleanup,
      {
        action: 'ambiguous',
        stage_key: plan.stage_key,
        candidates: live
          .map((candidate) => candidate.attempt.case_id)
          .sort(),
      },
    ];
  }
  const unselected = live
    .filter((candidate) => candidate !== selected)
    .map((candidate): ReconciliationAction => ({
      action: 'close',
      attempt_id: candidate.attempt.attempt_id,
      outcome: 'interrupted',
      reason: `Forge case was not selected for stage ${plan.stage_key}`,
    }));
  const arbitration: ReconciliationAction = selected.action === 'adopt'
    ? {
        action: 'adopt',
        stage_key: plan.stage_key,
        attempt_id: selected.attempt.attempt_id,
        case_id: selected.attempt.case_id,
      }
    : selected.action === 'block'
      ? {
          action: 'block',
          attempt_id: selected.attempt.attempt_id,
          case_id: selected.attempt.case_id,
          reason: 'Forge case is waiting for explicit human input',
        }
      : {
        action: 'resume',
        attempt_id: selected.attempt.attempt_id,
        case_id: selected.attempt.case_id,
        };
  return [...cleanup, ...unselected, arbitration];
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
  const fsOps: MaterializationFsOps = {
    ...defaultMaterializationFsOps,
    ...options.fs_ops,
  };
  if (manifest.run_id !== plan.run_id || manifest.story_id !== plan.story_id) {
    throw new Error('manifest run identity does not match the stage plan');
  }
  if (snapshot.case_id !== attempt.case_id) {
    throw new Error('Forge snapshot case id does not match the attempt');
  }
  const rejection = options.legacy_binding_attestation
    ? legacyAdoptionRejectionReason(
        manifest,
        plan,
        attempt,
        snapshot,
        options.legacy_binding_attestation,
      )
    : adoptionRejectionReason(plan, attempt, snapshot);
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
  const knownRecords = [
    ...manifest.stages,
    ...manifest.replacements.flatMap((replacement) =>
      replacement.candidate_record ? [replacement.candidate_record] : []
    ),
  ];
  const existing = knownRecords.find((record) =>
    (record as Partial<MaterializedStageRecord>).materialization_key
      === materializationKey) as MaterializedStageRecord | undefined;
  if (existing) {
    verifyRecordFile(
      runDirectory,
      existing.raw_artifact_path,
      existing.raw_artifact_sha256,
      fsOps,
    );
    verifyRecordFile(
      runDirectory,
      existing.artifact_path,
      existing.artifact_sha256,
      fsOps,
    );
    verifyRecordFile(
      runDirectory,
      existing.sidecar_path,
      existing.sidecar_sha256,
      fsOps,
    );
    verifyRecordFile(
      runDirectory,
      existing.validation_report_path,
      existing.validation_report_sha256,
      fsOps,
    );
    return existing;
  }

  if (
    (options.activation ?? 'active') === 'active'
    && manifest.stages.some(
    (record) =>
      record.stage_key === plan.stage_key && !invalidated.has(record.record_id),
    )
  ) {
    throw new Error(`stage already has an active record: ${plan.stage_key}`);
  }

  const inputPath = safeMaterializationPath(
    runDirectory,
    attempt.input_path,
    fsOps,
  );
  if (!fsOps.exists(inputPath)) {
    throw new Error(`attempt input evidence is missing: ${attempt.input_path}`);
  }
  const inputBytes = fsOps.readFile(inputPath);
  let input: unknown;
  try {
    input = JSON.parse(inputBytes.toString('utf8'));
  } catch {
    throw new Error(`attempt input evidence is not valid JSON: ${attempt.input_path}`);
  }
  if (sha256(canonicalJson(input)) !== plan.input_sha256) {
    throw new Error('attempt input evidence SHA-256 does not match the stage plan');
  }
  if (
    options.legacy_binding_attestation
    && sha256(inputBytes)
      !== options.legacy_binding_attestation.input_file_sha256
  ) {
    throw new Error(
      'attempt input file SHA-256 does not match the attestation',
    );
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
    ...knownRecords
      .filter((record) => record.stage_key === plan.stage_key)
      .map((record) => record.revision),
  ) + 1;
  const recordId = `${plan.stage_key}-v${revision}`;
  const bundleParentPath = safeMaterializationPath(
    runDirectory,
    'materialized',
    fsOps,
  );
  const finalBundlePath = safeMaterializationPath(
    runDirectory,
    `materialized/${recordId}`,
    fsOps,
  );
  const stagingBundlePath = safeMaterializationPath(
    runDirectory,
    `materialized/.${recordId}.staging`,
    fsOps,
  );
  const rawArtifactPath = `materialized/${recordId}/raw.md`;
  const artifactPath = `materialized/${recordId}/artifact.md`;
  const sidecarPath = `materialized/${recordId}/sidecar.json`;
  const validationReportPath = `materialized/${recordId}/validation.json`;
  const evidence: BundleEvidence[] = [
    {
      name: 'raw.md',
      content: snapshot.final_artifact!.content,
    },
    {
      name: 'artifact.md',
      content: validation.canonicalContent,
    },
    {
      name: 'sidecar.json',
      content: `${JSON.stringify(validation.sidecar, null, 2)}\n`,
    },
    {
      name: 'validation.json',
      content: `${JSON.stringify(validation.report, null, 2)}\n`,
    },
  ].map((item) => ({
    ...item,
    expectedSha256: sha256(item.content),
  }));
  ensureSafeParentDirectory(runDirectory, finalBundlePath, fsOps);
  let publishedByThisRun = false;
  if (fsOps.exists(finalBundlePath)) {
    if (!verifyMaterializationBundle(
      runDirectory,
      finalBundlePath,
      evidence,
      fsOps,
    )) {
      throw new Error(
        'published materialization bundle does not match expected evidence',
      );
    }
    if (fsOps.exists(stagingBundlePath)) {
      removeSafeTree(runDirectory, stagingBundlePath, fsOps);
    }
  } else {
    if (fsOps.exists(stagingBundlePath)) {
      removeSafeTree(runDirectory, stagingBundlePath, fsOps);
    }
    fsOps.mkdir(stagingBundlePath);
    safeMaterializationPath(runDirectory, stagingBundlePath, fsOps);
    try {
      for (const item of evidence) {
        const stagingFile = safeMaterializationPath(
          runDirectory,
          join(stagingBundlePath, item.name),
          fsOps,
        );
        fsOps.writeFile(stagingFile, item.content);
        fsOps.fsyncFile(stagingFile);
        if (sha256(fsOps.readFile(stagingFile)) !== item.expectedSha256) {
          throw new Error(`staging evidence SHA-256 mismatch: ${item.name}`);
        }
      }
      if (!verifyMaterializationBundle(
        runDirectory,
        stagingBundlePath,
        evidence,
        fsOps,
      )) {
        throw new Error('staging materialization bundle is incomplete');
      }
      fsOps.fsyncDirectory(stagingBundlePath);
      fsOps.fsyncDirectory(bundleParentPath);
      safeMaterializationPath(runDirectory, stagingBundlePath, fsOps);
      safeMaterializationPath(runDirectory, finalBundlePath, fsOps);
      if (fsOps.exists(finalBundlePath)) {
        throw new Error(`materialization bundle already exists: ${recordId}`);
      }
      fsOps.rename(stagingBundlePath, finalBundlePath);
      publishedByThisRun = true;
      fsOps.fsyncDirectory(bundleParentPath);
      if (!verifyMaterializationBundle(
        runDirectory,
        finalBundlePath,
        evidence,
        fsOps,
      )) {
        throw new Error(
          'published materialization bundle does not match expected evidence',
        );
      }
    } catch (error) {
      if (fsOps.exists(stagingBundlePath)) {
        try {
          removeSafeTree(runDirectory, stagingBundlePath, fsOps);
        } catch {
          // Preserve the materialization failure.
        }
      }
      if (publishedByThisRun && fsOps.exists(finalBundlePath)) {
        try {
          removeSafeTree(runDirectory, finalBundlePath, fsOps);
        } catch {
          // Preserve the materialization failure.
        }
      }
      throw error;
    }
  }

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
    input_file_sha256: sha256(inputBytes),
    raw_artifact_path: rawArtifactPath,
    raw_artifact_sha256: evidence[0]!.expectedSha256,
    artifact_path: artifactPath,
    artifact_sha256: evidence[1]!.expectedSha256,
    sidecar_path: sidecarPath,
    sidecar_sha256: evidence[2]!.expectedSha256,
    validation_report_path: validationReportPath,
    validation_report_sha256: evidence[3]!.expectedSha256,
    artifact_type: snapshot.final_artifact!.type,
    artifact_version: snapshot.final_artifact!.version,
    artifact_version_id: artifactVersionId,
    materialization_key: materializationKey,
    completed_at: completedAt,
    ...(options.legacy_binding_attestation
      ? {
          legacy_binding_attestation:
            structuredClone(options.legacy_binding_attestation),
        }
      : {}),
  };
  if (options.activation === 'candidate') return record;
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
