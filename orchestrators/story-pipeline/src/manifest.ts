import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type AttemptOutcome =
  | 'running'
  | 'interrupted'
  | 'blocked'
  | 'failed'
  | 'validation_failed'
  | 'delivered';

export interface TemplateIdentity {
  algorithm: 'legacy-unversioned-v1' | 'source-tree-sha256-v2';
  content_sha256: string;
  equivalence: 'verified' | 'operator_attested' | 'unknown';
}

export interface StageRecordV21 {
  record_id: string;
  revision: number;
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  template: string;
  template_identity: TemplateIdentity;
  case_id: string;
  parent_record_ids: string[];
  parent_case_ids: string[];
  status: 'delivered';
  input_path: string;
  input_sha256: string;
  raw_artifact_path: string;
  raw_artifact_sha256: string;
  artifact_path: string;
  artifact_sha256: string;
  sidecar_path: string;
  sidecar_sha256: string;
  validation_report_path: string;
  validation_report_sha256: string;
  artifact_type: string;
  artifact_version: number;
  completed_at: string;
}

export interface StageAttemptV21 {
  attempt_id: string;
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  template: string;
  expected_artifact_type: string;
  case_id: string;
  input_sha256: string;
  parent_record_ids: string[];
  template_identity: TemplateIdentity;
  runner_token_sha256: string | null;
  runner_credential_path: string | null;
  outcome: AttemptOutcome;
  input_path: string;
  raw_artifact_path: string | null;
  validation_report_path: string | null;
  started_at: string;
  updated_at: string;
  detail: string | null;
}

export interface InvalidationRecord {
  invalidation_id: string;
  record_id: string;
  stage_key: string;
  reason: string;
  root_record_id: string;
  invalidated_at: string;
}

export interface ReinstatementRecord {
  reinstatement_id: string;
  old_record_id: string;
  new_record_id: string;
  case_id: string;
  evidence_sha256: string;
  compatibility: 'verified' | 'operator_attested';
  reason: string;
}

export interface ReplacementRecord {
  replacement_id: string;
  stage_key: string;
  old_record_id: string;
  expected_input_sha256: string;
  expected_template_identity: TemplateIdentity;
  expected_parent_record_ids: string[];
  attempt_id: string | null;
  status: 'pending' | 'committed' | 'cancelled';
  candidate_record: StageRecordV21 | null;
  reason: string;
}

export interface ManifestEventV21 {
  sequence: number;
  at: string;
  type: string;
  stage_key: string;
  attempt_id?: string | null;
  before_outcome?: AttemptOutcome | null;
  after_outcome?: AttemptOutcome | null;
  case_id: string | null;
  artifact_id?: string | null;
  artifact_version?: number | null;
  version_id?: string | null;
  record_id: string | null;
  reason?: string | null;
  actor?: string;
  detail?: string | null;
  previous_event_sha256: string | null;
  event_sha256: string;
}

export type ManifestEventInput = Omit<
  Required<ManifestEventV21>,
  'sequence' | 'previous_event_sha256' | 'event_sha256' | 'detail'
>;

export interface PipelineManifestV21 {
  schema_version: '2.1';
  revision: number;
  previous_manifest_sha256: string | null;
  run_id: string;
  story_id: string;
  title: string;
  mode: string;
  config_sha256: string;
  boundary_map_path: string;
  boundary_map_sha256: string;
  created_at: string;
  updated_at: string;
  attempts: StageAttemptV21[];
  stages: StageRecordV21[];
  invalidations: InvalidationRecord[];
  reinstatements: ReinstatementRecord[];
  replacements: ReplacementRecord[];
  events: ManifestEventV21[];
  final_artifact_path: string | null;
}

export interface ManifestFsOps {
  rename(from: string, to: string): void;
  fsyncFile(path: string): void;
  remove(path: string): void;
}

interface LegacyStageRecord extends Omit<StageRecordV21, 'template_identity'> {
  template_sha256: string;
}

interface LegacyStageAttempt extends Omit<
  StageAttemptV21,
  | 'stage'
  | 'chapter_id'
  | 'template'
  | 'expected_artifact_type'
  | 'parent_record_ids'
  | 'template_identity'
  | 'runner_token_sha256'
  | 'runner_credential_path'
> {
  template_sha256: string;
}

interface PipelineManifestV20 extends Omit<
  PipelineManifestV21,
  | 'schema_version'
  | 'revision'
  | 'previous_manifest_sha256'
  | 'attempts'
  | 'stages'
  | 'reinstatements'
  | 'replacements'
> {
  schema_version: '2.0';
  attempts?: LegacyStageAttempt[];
  stages: LegacyStageRecord[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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

function legacyIdentity(contentSha256: string): TemplateIdentity {
  return {
    algorithm: 'legacy-unversioned-v1',
    content_sha256: contentSha256,
    equivalence: 'unknown',
  };
}

function migrateV20(manifest: PipelineManifestV20): PipelineManifestV21 {
  const stages = manifest.stages.map((stage): StageRecordV21 => {
    const { template_sha256: templateSha256, ...rest } = stage;
    return { ...rest, template_identity: legacyIdentity(templateSha256) };
  });
  const stagesByKey = new Map(stages.map((stage) => [stage.stage_key, stage]));
  const attempts = (manifest.attempts ?? []).map((attempt): StageAttemptV21 => {
    const { template_sha256: templateSha256, ...rest } = attempt;
    const stage = stagesByKey.get(attempt.stage_key);
    return {
      ...rest,
      stage: stage?.stage ?? attempt.stage_key,
      chapter_id: stage?.chapter_id ?? null,
      template: stage?.template ?? '',
      expected_artifact_type: stage?.artifact_type ?? '',
      parent_record_ids: stage?.parent_record_ids ?? [],
      template_identity: legacyIdentity(templateSha256),
      runner_token_sha256: null,
      runner_credential_path: null,
    };
  });
  return {
    ...manifest,
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    stages,
    attempts,
    invalidations: manifest.invalidations ?? [],
    reinstatements: [],
    replacements: [],
    events: manifest.events ?? [],
  };
}

export function loadManifest(path: string): PipelineManifestV21 {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | PipelineManifestV20
    | PipelineManifestV21;
  const manifest = parsed.schema_version === '2.0'
    ? migrateV20(parsed)
    : parsed.schema_version === '2.1'
      ? parsed
      : null;
  if (!manifest) {
    const version = (parsed as { schema_version?: unknown }).schema_version;
    throw new Error(`unsupported manifest schema: ${String(version)}`);
  }
  manifest.attempts ??= [];
  manifest.invalidations ??= [];
  manifest.reinstatements ??= [];
  manifest.replacements ??= [];
  manifest.events ??= [];
  validateManifestChain(manifest);
  return manifest;
}

export function appendManifestEvent(
  manifest: PipelineManifestV21,
  input: ManifestEventInput,
): ManifestEventV21 {
  const eventBase = {
    sequence: manifest.events.length + 1,
    ...input,
    previous_event_sha256: manifest.events.at(-1)?.event_sha256 ?? null,
  };
  const event: ManifestEventV21 = {
    ...eventBase,
    event_sha256: sha256(canonicalJson(eventBase)),
  };
  manifest.events.push(event);
  manifest.updated_at = input.at;
  return event;
}

export function validateManifestChain(manifest: PipelineManifestV21): void {
  const recordIds = new Set<string>();
  const activeByStage = new Map<string, string>();
  const invalidated = new Set(manifest.invalidations.map((item) => item.record_id));
  for (const stage of manifest.stages) {
    if (recordIds.has(stage.record_id)) {
      throw new Error(`manifest contains duplicate record: ${stage.record_id}`);
    }
    for (const parentRecordId of stage.parent_record_ids) {
      if (!recordIds.has(parentRecordId)) {
        throw new Error(
          `stage ${stage.stage_key} references an unregistered parent: ${parentRecordId}`,
        );
      }
    }
    recordIds.add(stage.record_id);
    if (!invalidated.has(stage.record_id)) {
      if (activeByStage.has(stage.stage_key)) {
        throw new Error(`stage ${stage.stage_key} has multiple active records`);
      }
      activeByStage.set(stage.stage_key, stage.record_id);
    }
  }
  for (const invalidation of manifest.invalidations) {
    if (!recordIds.has(invalidation.record_id)) {
      throw new Error(`invalidation references missing record: ${invalidation.record_id}`);
    }
  }

  let previousHash: string | null = null;
  for (let index = 0; index < manifest.events.length; index += 1) {
    const event = manifest.events[index]!;
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== previousHash) {
      throw new Error(`manifest event chain is broken at sequence=${event.sequence}`);
    }
    const { event_sha256: eventSha256, ...eventBase } = event;
    const expectedHash = sha256(canonicalJson(eventBase));
    if (expectedHash !== eventSha256) {
      throw new Error(`manifest event hash mismatch at sequence=${event.sequence}`);
    }
    previousHash = eventSha256;
  }
}

function defaultFsyncFile(path: string): void {
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

const defaultFsOps: ManifestFsOps = {
  rename: renameSync,
  fsyncFile: defaultFsyncFile,
  remove: (path) => rmSync(path, { force: true }),
};

function waitForLock(lockPath: string): number {
  const startedAt = Date.now();
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      return openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= 5_000) {
        throw new Error(`timed out acquiring manifest lock: ${lockPath}`);
      }
      Atomics.wait(waitState, 0, 0, 10);
    }
  }
}

export function saveManifestCas(
  path: string,
  expectedRevision: number,
  mutate: (latest: PipelineManifestV21) => void,
  fsOps: ManifestFsOps = defaultFsOps,
): PipelineManifestV21 {
  const lockDirectory = join(dirname(path), '.locks');
  const lockPath = join(lockDirectory, 'manifest.lock');
  mkdirSync(lockDirectory, { recursive: true });
  const lockDescriptor = waitForLock(lockPath);
  let temporaryPath: string | null = null;
  try {
    const previousBytes = readFileSync(path);
    const latest = loadManifest(path);
    if (latest.revision !== expectedRevision) {
      throw new Error(
        `manifest revision conflict: expected ${expectedRevision}, actual ${latest.revision}`,
      );
    }

    const previousEvents = latest.events.map((event) => canonicalJson(event));
    const previousTailHash = latest.events.at(-1)?.event_sha256 ?? null;
    mutate(latest);

    if (latest.revision !== expectedRevision) {
      throw new Error('manifest mutation must not change revision directly');
    }
    if (latest.events.length <= previousEvents.length) {
      throw new Error('manifest mutation must append at least one hashed event');
    }
    for (let index = 0; index < previousEvents.length; index += 1) {
      if (canonicalJson(latest.events[index]) !== previousEvents[index]) {
        throw new Error('manifest mutation must not rewrite existing events');
      }
    }
    if (latest.events[previousEvents.length]?.previous_event_sha256 !== previousTailHash) {
      throw new Error('manifest appended event does not continue the current event hash');
    }

    validateManifestChain(latest);
    latest.revision = expectedRevision + 1;
    latest.previous_manifest_sha256 = sha256(previousBytes);
    temporaryPath = join(
      dirname(path),
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    writeFileSync(temporaryPath, `${JSON.stringify(latest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fsOps.fsyncFile(temporaryPath);
    fsOps.rename(temporaryPath, path);
    temporaryPath = null;
    return latest;
  } catch (error) {
    if (temporaryPath !== null) {
      try {
        fsOps.remove(temporaryPath);
      } catch {
        // Preserve the original error. The caller can inspect the run directory.
      }
    }
    throw error;
  } finally {
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }
}

function credentialPath(runDirectory: string, attemptId: string): {
  absolute: string;
  relative: string;
} {
  const relativePath = join('credentials', `${sha256(attemptId)}.runner-token`);
  const absolutePath = resolve(runDirectory, relativePath);
  const rel = relative(resolve(runDirectory), absolutePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('runner credential path escapes the run directory');
  }
  return {
    absolute: absolutePath,
    relative: relativePath.replaceAll('\\', '/'),
  };
}

export function persistRunnerCredential(
  runDirectory: string,
  attempt: StageAttemptV21,
  runnerToken: string,
): void {
  const path = credentialPath(runDirectory, attempt.attempt_id);
  mkdirSync(dirname(path.absolute), { recursive: true, mode: 0o700 });
  writeFileSync(path.absolute, runnerToken, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path.absolute, 0o600);
  attempt.runner_token_sha256 = sha256(runnerToken);
  attempt.runner_credential_path = path.relative;
}

export function clearRunnerCredential(
  runDirectory: string,
  attempt: StageAttemptV21,
): void {
  if (!['failed', 'validation_failed', 'delivered'].includes(attempt.outcome)) {
    throw new Error(`runner credential cannot be cleared for outcome ${attempt.outcome}`);
  }
  if (attempt.runner_credential_path !== null) {
    const absolutePath = resolve(runDirectory, attempt.runner_credential_path);
    const rel = relative(resolve(runDirectory), absolutePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('runner credential path escapes the run directory');
    }
    if (existsSync(absolutePath)) rmSync(absolutePath, { force: true });
  }
  attempt.runner_credential_path = null;
}
