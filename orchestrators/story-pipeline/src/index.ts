import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ChapterBoundary,
  type ChapterBoundaryMap,
  type ValidationResult,
  sha256,
  validateDraft,
  validateFinal,
  validateLedger,
  validateOutline,
  validatePacket,
} from './quality.js';
import {
  materializeDeliveredArtifact,
  reconcileStage,
  requireScenarioSnapshotIdentity,
  type ReconciliationAction,
  type StagePlan,
} from './reconciliation.js';
import { descendantClosure } from './invalidation.js';
import {
  activeForConsumption,
  beginReplacement,
  bindReplacementAttempt,
  cancelReplacement,
  commitReplacement,
  prepareReplacementCandidate,
  replacementTarget,
  type BeginReplacementInput,
} from './replacement.js';
import {
  appendManifestEvent,
  clearRunnerCredential,
  initializeManifest,
  loadManifest,
  persistRunnerCredential,
  saveManifestCas,
  validateManifestChain,
  type AttemptOutcome,
  type InvalidationRecord,
  type PipelineManifestV21 as PipelineManifest,
  type StageAttemptV21 as StageAttempt,
  type StageRecordV21 as StageRecord,
  type TemplateIdentity,
} from './manifest.js';
import {
  ForgeCliClient,
  installAbortSignalHandlers,
  type ForgeCaseSnapshot,
  type ForgeClient,
} from './forge-client.js';
import { acquireStageLock } from './run-lock.js';
import { sliceChapterSource } from './source-slice.js';
import {
  compareTemplateIdentity,
  identifyTemplateDirectory,
} from './template-hash.js';

type PipelineMode = 'imitation';
type PiMode = 'fake' | 'real';

interface ChapterConfig {
  id: string;
  label?: string;
}

interface PipelineConfig {
  run_id: string;
  story_id: string;
  title: string;
  mode: PipelineMode;
  source_file: string;
  requirements: string;
  chapters: ChapterConfig[];
}

interface RunOptions {
  command: 'run';
  configPath: string;
  runDir: string;
  dbPath: string;
  mode: PiMode;
  runId: string;
  storyId: string;
}

interface InvalidateOptions {
  command: 'invalidate';
  runDir: string;
  fromStage: string;
  reason: string;
}

export interface ReconcileOptions {
  command: 'reconcile';
  configPath: string;
  runDir: string;
  dbPath: string;
  mode?: PiMode;
  dryRun: boolean;
  adoptCase?: string;
  attestTemplateCompatibility: boolean;
  attestLegacyCaseBindings: string[];
}

export interface ReconcileRunResult {
  actions: ReconciliationAction[];
}

type CliOptions = RunOptions | InvalidateOptions | ReconcileOptions;

interface StageSpec {
  key: string;
  stage: string;
  chapterId: string | null;
  template: string;
  templateIdentity: TemplateIdentity;
  expectedArtifactType: string;
  title: string;
  input: Record<string, unknown>;
  parents: StageRecord[];
  validate: (rawContent: string) => ValidationResult;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packetController = join(
  repoRoot,
  'scenarios',
  'zhihu-chapter-packet',
  'skills',
  'zhihu-salt-chapter-packet',
  'scripts',
  'controller_artifact.py',
);

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseReconcileArgs(argv: string[]): ReconcileOptions {
  const valueNames = new Set([
    'config',
    'run-dir',
    'db',
    'mode',
    'adopt-case',
    'attest-legacy-case-binding',
  ]);
  const booleanNames = new Set([
    'dry-run',
    'apply',
    'attest-template-compatibility',
  ]);
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) {
      throw new Error(`invalid reconcile option: ${key ?? '(empty)'}`);
    }
    const name = key.slice(2);
    if (booleanNames.has(name)) {
      if (booleans.has(name)) {
        throw new Error(`duplicate reconcile option: ${key}`);
      }
      booleans.add(name);
      continue;
    }
    if (!valueNames.has(name)) {
      throw new Error(`unknown reconcile option: ${key}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`reconcile option requires a value: ${key}`);
    }
    if (values.has(name)) {
      throw new Error(`duplicate reconcile option: ${key}`);
    }
    values.set(name, value);
    index += 1;
  }
  const config = values.get('config');
  const runDir = values.get('run-dir');
  const db = values.get('db');
  if (!config || !runDir || !db) {
    throw new Error('reconcile requires --config, --run-dir, and --db');
  }
  const dryRun = booleans.has('dry-run');
  const apply = booleans.has('apply');
  if (dryRun === apply) {
    throw new Error('reconcile requires exactly one of --dry-run or --apply');
  }
  if (
    dryRun
    && (
      values.has('adopt-case')
      || values.has('attest-legacy-case-binding')
      || booleans.has('attest-template-compatibility')
    )
  ) {
    throw new Error('reconcile attestation and adoption flags require --apply');
  }
  const mode = values.get('mode');
  if (mode !== undefined && mode !== 'fake' && mode !== 'real') {
    throw new Error('reconcile --mode must be fake or real');
  }
  return {
    command: 'reconcile',
    configPath: resolve(process.cwd(), config),
    runDir: resolve(process.cwd(), runDir),
    dbPath: resolve(process.cwd(), db),
    mode: mode as PiMode | undefined,
    dryRun,
    adoptCase: values.get('adopt-case'),
    attestTemplateCompatibility: booleans.has(
      'attest-template-compatibility',
    ),
    attestLegacyCaseBindings: values.has('attest-legacy-case-binding')
      ? [values.get('attest-legacy-case-binding')!]
      : [],
  };
}

function parseLegacyArgs(argv: string[]): CliOptions {
  if (argv[0] !== 'run' && argv[0] !== 'invalidate') {
    throw new Error(
      '用法: story-pipeline run --config <file> [--mode fake|real] [--run-dir <dir>] [--db <file>]；或 invalidate --run-dir <dir> --from <stage-key> --reason <text>',
    );
  }

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`无效参数: ${key ?? '(空)'}`);
    }
    values.set(key.slice(2), value);
  }

  if (argv[0] === 'invalidate') {
    const runDirArg = values.get('run-dir');
    const fromStage = values.get('from');
    const reason = values.get('reason');
    if (!runDirArg || !fromStage || !reason) {
      throw new Error('invalidate 需要 --run-dir、--from 和 --reason');
    }
    return {
      command: 'invalidate',
      runDir: resolve(process.cwd(), runDirArg),
      fromStage,
      reason,
    };
  }

  const configArg = values.get('config');
  if (!configArg) throw new Error('缺少 --config');
  const configPath = resolve(process.cwd(), configArg);
  const config = loadConfig(configPath);
  const runDir = resolve(
    process.cwd(),
    values.get('run-dir') ?? join('data', 'story-runs', config.run_id),
  );
  const dbPath = resolve(process.cwd(), values.get('db') ?? join(runDir, 'forge.db'));
  const mode = (values.get('mode') ?? 'fake') as PiMode;
  if (mode !== 'fake' && mode !== 'real') {
    throw new Error(`不支持的 --mode: ${mode}`);
  }
  return {
    command: 'run',
    configPath,
    runDir,
    dbPath,
    mode,
    runId: config.run_id,
    storyId: config.story_id,
  };
}

function parseArgs(argv: string[]): CliOptions {
  return argv[0] === 'reconcile'
    ? parseReconcileArgs(argv.slice(1))
    : parseLegacyArgs(argv);
}

function loadConfig(path: string): PipelineConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PipelineConfig>;
  const required = ['run_id', 'story_id', 'title', 'mode', 'source_file', 'requirements', 'chapters'] as const;
  const missing = required.filter((key) => parsed[key] === undefined);
  if (missing.length > 0) throw new Error(`生产配置缺少字段: ${missing.join(', ')}`);
  if (!Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    throw new Error('生产配置 chapters 至少包含一章');
  }
  const ids = parsed.chapters.map((chapter) => chapter.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('章节 id 不能为空且不得重复');
  }
  if (parsed.mode !== 'imitation') {
    throw new Error(
      `首版故事模板只支持 imitation；收到 ${parsed.mode}。原创与改写应使用独立大纲模板，不能复用原文提取 Skill。`,
    );
  }
  return parsed as PipelineConfig;
}

function ensureInsideRunDir(runDir: string, target: string): void {
  const rel = relative(runDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`运行产物路径越界: ${target}`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function loadOrCreateManifest(
  runDir: string,
  config: PipelineConfig,
  configHash: string,
  boundaryMapPath: string,
  boundaryMapHash: string,
): PipelineManifest {
  const manifestPath = join(runDir, 'manifest.json');
  const now = new Date().toISOString();
  const { manifest } = initializeManifest(manifestPath, () => ({
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: config.run_id,
    story_id: config.story_id,
    title: config.title,
    mode: config.mode,
    config_sha256: configHash,
    boundary_map_path: relative(runDir, boundaryMapPath).replaceAll('\\', '/'),
    boundary_map_sha256: boundaryMapHash,
    created_at: now,
    updated_at: now,
    stages: [],
    attempts: [],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  }));
  if (manifest.run_id !== config.run_id || manifest.story_id !== config.story_id) {
    throw new Error('现有运行目录属于其他 run/story，拒绝覆盖');
  }
  if (manifest.config_sha256 !== configHash) {
    throw new Error('生产配置已变化。请使用新 run_id，或先完成明确的回退决策');
  }
  manifest.attempts ??= [];
  manifest.invalidations ??= [];
  if (
    manifest.boundary_map_sha256 !== boundaryMapHash ||
    resolve(runDir, manifest.boundary_map_path) !== boundaryMapPath
  ) {
    throw new Error('章节边界 sidecar 与 manifest 不一致');
  }
  validateManifestChain(manifest);
  return manifest;
}

interface EventArtifactIdentity {
  artifactId: string | null;
  artifactVersion: number | null;
  versionId: string | null;
  recordId: string | null;
}

function appendAttemptEvent(
  manifest: PipelineManifest,
  type: string,
  attempt: StageAttempt,
  beforeOutcome: AttemptOutcome | null,
  afterOutcome: AttemptOutcome | null,
  reason: string | null,
  artifact: EventArtifactIdentity = {
    artifactId: null,
    artifactVersion: null,
    versionId: null,
    recordId: null,
  },
): void {
  appendManifestEvent(manifest, {
    at: new Date().toISOString(),
    type,
    stage_key: attempt.stage_key,
    attempt_id: attempt.attempt_id,
    before_outcome: beforeOutcome,
    after_outcome: afterOutcome,
    case_id: attempt.case_id,
    artifact_id: artifact.artifactId,
    artifact_version: artifact.artifactVersion,
    version_id: artifact.versionId,
    record_id: artifact.recordId,
    reason,
    actor: 'story-pipeline',
  });
}

function saveManifest(runDir: string, manifest: PipelineManifest): void {
  const intended = structuredClone(manifest);
  const saved = saveManifestCas(
    join(runDir, 'manifest.json'),
    manifest.revision,
    (latest) => {
      const revision = latest.revision;
      const previousManifestHash = latest.previous_manifest_sha256;
      Object.assign(latest, intended);
      latest.revision = revision;
      latest.previous_manifest_sha256 = previousManifestHash;
    },
  );
  Object.assign(manifest, saved);
}

function persistReplacementMutation(
  manifestPath: string,
  mutate: (manifest: PipelineManifest) => void,
): PipelineManifest {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = loadManifest(manifestPath);
    const probe = structuredClone(latest);
    const beforeEvents = probe.events.length;
    mutate(probe);
    if (probe.events.length === beforeEvents) return latest;
    try {
      return saveManifestCas(
        manifestPath,
        latest.revision,
        mutate,
      );
    } catch (error) {
      if (
        attempt < 3
        && error instanceof Error
        && error.message.startsWith('manifest revision conflict:')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('replacement Manifest CAS retry limit exceeded');
}

export function persistPendingReplacement(
  manifestPath: string,
  input: BeginReplacementInput,
): PipelineManifest {
  const at = input.at ?? new Date().toISOString();
  return persistReplacementMutation(manifestPath, (manifest) => {
    beginReplacement(manifest, { ...input, at });
  });
}

export function persistReplacementAttempt(
  manifestPath: string,
  replacementId: string,
  attemptId: string,
  at = new Date().toISOString(),
): PipelineManifest {
  return persistReplacementMutation(manifestPath, (manifest) => {
    bindReplacementAttempt(manifest, replacementId, attemptId, at);
  });
}

export function persistReplacementCandidate(
  manifestPath: string,
  replacementId: string,
  attemptId: string,
  candidate: StageRecord,
  at = new Date().toISOString(),
): PipelineManifest {
  return persistReplacementMutation(manifestPath, (manifest) => {
    prepareReplacementCandidate(
      manifest,
      replacementId,
      attemptId,
      candidate,
      at,
    );
  });
}

export function persistReplacementCancellation(
  manifestPath: string,
  replacementId: string,
  reason: string,
  at = new Date().toISOString(),
): PipelineManifest {
  return persistReplacementMutation(manifestPath, (manifest) => {
    const replacement = manifest.replacements.find(
      (item) => item.replacement_id === replacementId,
    );
    const attempt = replacement?.attempt_id
      ? manifest.attempts.find(
          (item) => item.attempt_id === replacement.attempt_id,
        )
      : null;
    if (replacement?.status === 'pending' && attempt) {
      const beforeOutcome = attempt.outcome;
      attempt.outcome = 'failed';
      attempt.updated_at = at;
      attempt.detail = reason;
      attempt.runner_credential_path = null;
      appendAttemptEvent(
        manifest,
        'stage_failed',
        attempt,
        beforeOutcome,
        'failed',
        reason,
      );
    }
    cancelReplacement(manifest, replacementId, reason, at);
  });
}

function replacementAttempt(
  manifest: PipelineManifest,
  replacementId: string,
): StageAttempt | null {
  const replacement = manifest.replacements.find(
    (item) => item.replacement_id === replacementId,
  );
  if (!replacement?.attempt_id) return null;
  return manifest.attempts.find(
    (item) => item.attempt_id === replacement.attempt_id,
  ) ?? null;
}

function removeReplacementCredential(
  manifestPath: string,
  attempt: StageAttempt | null,
): void {
  if (attempt === null) return;
  const runDir = dirname(manifestPath);
  const credentialPath = resolve(
    runDir,
    'credentials',
    `${sha256(attempt.attempt_id)}.runner-token`,
  );
  ensureInsideRunDir(runDir, credentialPath);
  if (!existsSync(credentialPath)) return;
  if (attempt.runner_token_sha256 === null) {
    throw new Error(
      `terminal replacement credential has no Attempt secret hash: ${attempt.attempt_id}`,
    );
  }
  const credentialStat = lstatSync(credentialPath);
  if (!credentialStat.isFile() || credentialStat.isSymbolicLink()) {
    throw new Error(
      `terminal replacement credential is not a regular file: ${attempt.attempt_id}`,
    );
  }
  const credential = readFileSync(credentialPath);
  if (sha256(credential) !== attempt.runner_token_sha256) {
    throw new Error(
      `terminal replacement credential does not match Attempt: ${attempt.attempt_id}`,
    );
  }
  rmSync(credentialPath, { force: true });
}

function cleanupTerminalReplacementCredentials(
  manifestPath: string,
  manifest: PipelineManifest,
): void {
  for (const replacement of manifest.replacements) {
    if (replacement.status === 'pending' || replacement.attempt_id === null) {
      continue;
    }
    const attempt = manifest.attempts.find(
      (item) => item.attempt_id === replacement.attempt_id,
    );
    removeReplacementCredential(manifestPath, attempt ?? null);
  }
}

export function persistReplacementCommit(
  manifestPath: string,
  replacementId: string,
  expectedRevision: number,
  at = new Date().toISOString(),
): PipelineManifest {
  const latest = loadManifest(manifestPath);
  const attempt = replacementAttempt(latest, replacementId);
  const existing = latest.replacements.find(
    (replacement) => replacement.replacement_id === replacementId,
  );
  if (existing?.status === 'committed') {
    removeReplacementCredential(manifestPath, attempt);
    return latest;
  }
  try {
    const committed = saveManifestCas(
      manifestPath,
      expectedRevision,
      (manifest) => {
        commitReplacement(manifest, replacementId, at);
      },
    );
    removeReplacementCredential(manifestPath, attempt);
    return committed;
  } catch (error) {
    const afterFailure = loadManifest(manifestPath);
    const replacement = afterFailure.replacements.find(
      (item) => item.replacement_id === replacementId,
    );
    if (replacement?.status === 'committed') {
      removeReplacementCredential(
        manifestPath,
        replacementAttempt(afterFailure, replacementId),
      );
      return afterFailure;
    }
    if (replacement?.status === 'pending') {
      try {
        const cancelled = persistReplacementCancellation(
          manifestPath,
          replacementId,
          'replacement commit precondition failed',
          at,
        );
        const cancelledReplacement = cancelled.replacements.find(
          (item) => item.replacement_id === replacementId,
        );
        if (cancelledReplacement?.status !== 'cancelled') {
          throw new Error('replacement cancellation did not commit');
        }
        removeReplacementCredential(
          manifestPath,
          replacementAttempt(cancelled, replacementId),
        );
      } catch (cancellationError) {
        throw new AggregateError(
          [error, cancellationError],
          'replacement commit and cancellation both failed',
        );
      }
    }
    throw error;
  }
}

function invalidatedRecordIds(manifest: PipelineManifest): Set<string> {
  return new Set(manifest.invalidations.map((item) => item.record_id));
}

function activeStage(manifest: PipelineManifest, stageKey: string): StageRecord | null {
  const invalidated = invalidatedRecordIds(manifest);
  return [...manifest.stages].reverse().find(
    (stage) => stage.stage_key === stageKey && !invalidated.has(stage.record_id),
  ) ?? null;
}

function invalidateStageAndDescendants(
  manifest: PipelineManifest,
  root: StageRecord,
  reason: string,
): StageRecord[] {
  const alreadyInvalidated = invalidatedRecordIds(manifest);
  const pending = new Set(descendantClosure(manifest.stages, root.record_id, alreadyInvalidated));
  const affected: StageRecord[] = [];

  const at = new Date().toISOString();
  for (const stage of manifest.stages) {
    if (!pending.has(stage.record_id) || alreadyInvalidated.has(stage.record_id)) continue;
    const invalidation: InvalidationRecord = {
      invalidation_id: `inv-${manifest.invalidations.length + 1}`,
      record_id: stage.record_id,
      stage_key: stage.stage_key,
      reason,
      root_record_id: root.record_id,
      invalidated_at: at,
    };
    manifest.invalidations.push(invalidation);
    appendManifestEvent(manifest, {
      at,
      type: 'stage_invalidated',
      stage_key: stage.stage_key,
      attempt_id: null,
      before_outcome: null,
      after_outcome: null,
      case_id: stage.case_id,
      artifact_id: stage.record_id,
      artifact_version: stage.artifact_version,
      version_id: stage.record_id,
      record_id: stage.record_id,
      reason,
      actor: 'story-pipeline',
    });
    affected.push(stage);
  }
  if (affected.some((stage) => stage.stage_key === 'final')) {
    manifest.final_artifact_path = null;
  }
  return affected;
}

function templateIdentity(template: string): TemplateIdentity {
  const templatePath = join(repoRoot, 'scenarios', template);
  if (!existsSync(templatePath)) throw new Error(`场景模板不存在: ${templatePath}`);
  return identifyTemplateDirectory(templatePath);
}

function ensureBoundaryMap(runDir: string, sourcePath: string): {
  path: string;
  map: ChapterBoundaryMap;
  hash: string;
} {
  const boundaryPath = join(runDir, 'structured', 'chapter-boundaries.json');
  ensureInsideRunDir(runDir, boundaryPath);
  if (!existsSync(boundaryPath)) {
    mkdirSync(dirname(boundaryPath), { recursive: true });
    const result = spawnSync('python', [
      packetController,
      'extract-boundaries',
      '--source',
      sourcePath,
      '--output',
      boundaryPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`章节边界提取失败: ${result.stderr || result.stdout || result.error?.message || 'unknown'}`);
    }
  }
  const content = readFileSync(boundaryPath, 'utf8');
  const map = JSON.parse(content) as ChapterBoundaryMap;
  if (!map.valid || map.operation !== 'chapter-boundary-map' || !Array.isArray(map.chapters)) {
    throw new Error('章节边界 sidecar 结构无效');
  }
  const sourceHash = sha256(readFileSync(sourcePath));
  if (map.source.sha256 !== sourceHash) {
    throw new Error('源文件内容已变化，章节边界 sidecar 失效；请使用新 run_id 或执行明确回退');
  }
  return { path: boundaryPath, map, hash: sha256(content) };
}

function readSidecar(runDir: string, record: StageRecord): Record<string, unknown> {
  const path = resolve(runDir, record.sidecar_path);
  ensureInsideRunDir(runDir, path);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function existingStage(
  manifest: PipelineManifest,
  spec: StageSpec,
  runDir: string,
): StageRecord | null {
  const record = activeStage(manifest, spec.key);
  if (!record) return null;
  const pendingReplacement = replacementTarget(manifest, spec.key);
  if (!activeForConsumption(manifest, spec.key) && !pendingReplacement) {
    throw new Error(
      `阶段 ${spec.key} 被上游 pending replacement 阻止启动`,
    );
  }
  const intendedInputHash = sha256(canonicalJson(spec.input));
  const intendedParents = spec.parents.map((parent) => parent.record_id);
  const changeReasons: string[] = [];
  const templateComparison = compareTemplateIdentity(
    record.template_identity,
    spec.templateIdentity,
  );
  if (templateComparison === 'migration_required') {
    throw new Error(
      `阶段 ${spec.key} 的模板身份算法已变化，需要先完成显式身份迁移`,
    );
  }
  if (record.template !== spec.template || templateComparison === 'content_changed') {
    changeReasons.push('模板内容变化');
  }
  if (canonicalJson(record.parent_record_ids) !== canonicalJson(intendedParents)) {
    changeReasons.push('父产物版本变化');
  }
  if (intendedInputHash !== record.input_sha256) {
    changeReasons.push('阶段输入变化');
  }
  if (changeReasons.length > 0) {
    const reason = `${spec.key} replacement pending：${changeReasons.join('、')}`;
    const beforeEvents = manifest.events.length;
    const replacement = beginReplacement(manifest, {
      stage_key: spec.key,
      old_record_id: record.record_id,
      expected_input_sha256: intendedInputHash,
      expected_template_identity: spec.templateIdentity,
      expected_parent_record_ids: intendedParents,
      reason,
    });
    if (manifest.events.length > beforeEvents) saveManifest(runDir, manifest);
    process.stdout.write(
      `[replace] ${record.record_id} -> ${replacement.replacement_id} pending\n`,
    );
    return null;
  }
  if (pendingReplacement) {
    throw new Error(
      `阶段 ${spec.key} 有与当前计划不一致的 pending replacement`,
    );
  }

  const inputPath = resolve(runDir, record.input_path);
  ensureInsideRunDir(runDir, inputPath);
  if (!existsSync(inputPath)) {
    throw new Error(`阶段 ${spec.key} 的输入证据缺失: ${inputPath}`);
  }
  const persistedInput = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (sha256(canonicalJson(persistedInput)) !== record.input_sha256) {
    throw new Error(`阶段 ${spec.key} 的输入证据哈希不一致`);
  }
  const artifactPath = resolve(runDir, record.artifact_path);
  ensureInsideRunDir(runDir, artifactPath);
  if (!existsSync(artifactPath)) {
    throw new Error(`阶段 ${spec.key} 的证据产物缺失: ${artifactPath}`);
  }
  const actualHash = sha256(readFileSync(artifactPath));
  if (actualHash !== record.artifact_sha256) {
    throw new Error(`阶段 ${spec.key} 的证据产物哈希不一致`);
  }
  for (const [label, pathValue, expectedHash] of [
    ['原始产物', record.raw_artifact_path, record.raw_artifact_sha256],
    ['结构化 sidecar', record.sidecar_path, record.sidecar_sha256],
    ['机械门禁报告', record.validation_report_path, record.validation_report_sha256],
  ] as const) {
    const path = resolve(runDir, pathValue);
    ensureInsideRunDir(runDir, path);
    if (!existsSync(path)) throw new Error(`阶段 ${spec.key} 的${label}缺失: ${path}`);
    if (sha256(readFileSync(path)) !== expectedHash) {
      throw new Error(`阶段 ${spec.key} 的${label}哈希不一致`);
    }
  }
  return record;
}

async function executeStage(
  manifest: PipelineManifest,
  spec: StageSpec,
  options: RunOptions,
  forgeClient: ForgeClient,
  signal: AbortSignal,
): Promise<StageRecord> {
  const stageLock = acquireStageLock({
    run_dir: options.runDir,
    run_id: options.runId,
    stage_key: spec.key,
    owner_token: randomUUID(),
  });
  try {
    Object.assign(
      manifest,
      loadManifest(join(options.runDir, 'manifest.json')),
    );
    return await executeStageUnlocked(
      manifest,
      spec,
      options,
      forgeClient,
      signal,
    );
  } finally {
    stageLock.release();
  }
}

async function executeStageUnlocked(
  manifest: PipelineManifest,
  spec: StageSpec,
  options: RunOptions,
  forgeClient: ForgeClient,
  signal: AbortSignal,
): Promise<StageRecord> {
  const resumed = existingStage(manifest, spec, options.runDir);
  if (resumed) {
    process.stdout.write(`[skip] ${spec.key} -> ${resumed.record_id} / ${resumed.case_id}\n`);
    return resumed;
  }

  const inputHash = sha256(canonicalJson(spec.input));
  const pendingReplacement = replacementTarget(manifest, spec.key);
  const intendedParentRecordIds = spec.parents.map(
    (parent) => parent.record_id,
  );
  const resumableAttempts = [...manifest.attempts].reverse().filter(
    (attempt) =>
      attempt.stage_key === spec.key &&
      attempt.input_sha256 === inputHash &&
      canonicalJson(attempt.parent_record_ids)
        === canonicalJson(intendedParentRecordIds) &&
      ['running', 'interrupted', 'blocked'].includes(attempt.outcome),
  );
  if (resumableAttempts.some(
    (attempt) =>
      compareTemplateIdentity(attempt.template_identity, spec.templateIdentity) ===
      'migration_required',
  )) {
    throw new Error(`阶段 ${spec.key} 的 Attempt 模板身份算法已变化，需要先完成显式身份迁移`);
  }
  if (resumableAttempts.some(
    (attempt) => attempt.expected_scenario_snapshot_sha256 === null,
  )) {
    throw new Error(
      `阶段 ${spec.key} 的旧 Attempt 缺少 scenario snapshot 身份，需要 Task 8 显式证明`,
    );
  }
  const reusableAttempt = pendingReplacement?.attempt_id
    ? resumableAttempts.find(
        (attempt) => attempt.attempt_id === pendingReplacement.attempt_id,
      )
    : resumableAttempts.find(
        (attempt) =>
          compareTemplateIdentity(
            attempt.template_identity,
            spec.templateIdentity,
          ) === 'equal'
          && attempt.template === spec.template,
      );
  if (pendingReplacement?.attempt_id && !reusableAttempt) {
    throw new Error(
      `pending replacement ${pendingReplacement.replacement_id} `
      + `cannot recover attempt ${pendingReplacement.attempt_id}`,
    );
  }

  let attempt: StageAttempt;
  let caseId: string;
  let inputPath: string;
  if (reusableAttempt) {
    inputPath = resolve(options.runDir, reusableAttempt.input_path);
    ensureInsideRunDir(options.runDir, inputPath);
    if (!existsSync(inputPath)) {
      throw new Error(`阶段 ${spec.key} 的尝试输入证据缺失: ${inputPath}`);
    }
    const persistedInput = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (sha256(canonicalJson(persistedInput)) !== inputHash) {
      throw new Error(`阶段 ${spec.key} 的尝试输入证据哈希不一致`);
    }
    attempt = reusableAttempt;
    caseId = attempt.case_id;
    if (pendingReplacement && pendingReplacement.attempt_id === null) {
      bindReplacementAttempt(
        manifest,
        pendingReplacement.replacement_id,
        attempt.attempt_id,
      );
      saveManifest(options.runDir, manifest);
    }
    process.stdout.write(`[resume] ${spec.key} -> ${caseId}\n`);
  } else {
    const attemptNumber = manifest.attempts.filter((item) => item.stage_key === spec.key).length + 1;
    const attemptId = `${spec.key}-a${attemptNumber}`;
    inputPath = join(options.runDir, 'inputs', spec.key, `${attemptId}.json`);
    ensureInsideRunDir(options.runDir, inputPath);
    writeJson(inputPath, spec.input);
    process.stdout.write(`[run] ${spec.key} (${spec.template})\n`);
    caseId = await forgeClient.createCase({
      template: spec.template,
      dbPath: options.dbPath,
      mode: options.mode,
      title: spec.title,
      inputFile: inputPath,
      runId: options.runId,
      storyId: options.storyId,
      stageKey: spec.key,
      chapterId: spec.chapterId,
    }, signal);
    if (!caseId) throw new Error(`阶段 ${spec.key} 未返回 case_id`);
    const createdSnapshot = await forgeClient.getCaseStatus(
      caseId,
      options.dbPath,
    );
    const scenarioSnapshotSha256 = requireScenarioSnapshotIdentity(
      createdSnapshot,
      caseId,
    );
    const now = new Date().toISOString();
    attempt = {
      attempt_id: attemptId,
      stage_key: spec.key,
      stage: spec.stage,
      chapter_id: spec.chapterId,
      template: spec.template,
      expected_artifact_type: spec.expectedArtifactType,
      expected_scenario_snapshot_sha256: scenarioSnapshotSha256,
      case_id: caseId,
      input_sha256: inputHash,
      parent_record_ids: intendedParentRecordIds,
      template_identity: spec.templateIdentity,
      runner_token_sha256: null,
      runner_credential_path: null,
      outcome: 'running',
      input_path: relative(options.runDir, inputPath).replaceAll('\\', '/'),
      raw_artifact_path: null,
      validation_report_path: null,
      started_at: now,
      updated_at: now,
      detail: null,
    };
    persistRunnerCredential(options.runDir, attempt, randomUUID());
    manifest.attempts.push(attempt);
    appendAttemptEvent(
      manifest,
      'stage_started',
      attempt,
      null,
      'running',
      'Forge Case created',
    );
    if (pendingReplacement) {
      bindReplacementAttempt(
        manifest,
        pendingReplacement.replacement_id,
        attempt.attempt_id,
      );
    }
    saveManifest(options.runDir, manifest);
  }

  let result: ForgeCaseSnapshot | undefined;
  try {
    if (attempt.runner_credential_path === null) {
      throw new Error(`Attempt ${attempt.attempt_id} has no runner credential`);
    }
    const runnerCredentialPath = resolve(
      options.runDir,
      attempt.runner_credential_path,
    );
    ensureInsideRunDir(options.runDir, runnerCredentialPath);
    result = await forgeClient.runCase(caseId, {
      dbPath: options.dbPath,
      mode: options.mode,
      runnerCredentialPath,
    }, signal);
  } catch (error) {
    if (signal.aborted) {
      result = await forgeClient.getCaseStatus(caseId, options.dbPath);
    } else {
    const beforeOutcome = attempt.outcome;
    attempt.outcome = 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = error instanceof Error ? error.message : String(error);
    appendAttemptEvent(
      manifest,
      'stage_interrupted',
      attempt,
      beforeOutcome,
      attempt.outcome,
      attempt.detail,
    );
    saveManifest(options.runDir, manifest);
    throw error;
    }
  }

  if (!result || result.case_id !== caseId) {
    const beforeOutcome = attempt.outcome;
    attempt.outcome = 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = 'Forge 未返回有效结果';
    appendAttemptEvent(
      manifest,
      'stage_interrupted',
      attempt,
      beforeOutcome,
      attempt.outcome,
      attempt.detail,
    );
    saveManifest(options.runDir, manifest);
    throw new Error(`阶段 ${spec.key} 未返回有效结果`);
  }
  if (signal.aborted && pendingReplacement) {
    const beforeOutcome = attempt.outcome;
    attempt.outcome = 'failed';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = 'replacement execution cancelled';
    clearRunnerCredential(options.runDir, attempt);
    cancelReplacement(
      manifest,
      pendingReplacement.replacement_id,
      attempt.detail,
    );
    appendAttemptEvent(
      manifest,
      'stage_failed',
      attempt,
      beforeOutcome,
      'failed',
      attempt.detail,
    );
    saveManifest(options.runDir, manifest);
    throw new Error(`阶段 ${spec.key} replacement 已取消`);
  }
  if (!result.success || result.status !== 'approved' || !result.final_artifact) {
    const beforeOutcome = attempt.outcome;
    const plan: StagePlan = {
      run_id: options.runId,
      story_id: options.storyId,
      stage_key: spec.key,
      stage: spec.stage,
      chapter_id: spec.chapterId,
      expected_artifact_type: spec.expectedArtifactType,
      expected_scenario_snapshot_sha256:
        attempt.expected_scenario_snapshot_sha256,
      input_sha256: inputHash,
      parent_record_ids: spec.parents.map((parent) => parent.record_id),
      template_identity: spec.templateIdentity,
    };
    const reconciled = reconcileStage(
      plan,
      [attempt],
      new Map([[caseId, result]]),
      caseId,
    );
    const finalAction = reconciled.at(-1);
    attempt.outcome = finalAction?.action === 'close'
      ? finalAction.outcome
      : finalAction?.action === 'reject'
        ? 'failed'
        : result.status === 'waiting_human'
          ? 'blocked'
          : 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = finalAction && 'reason' in finalAction
      ? finalAction.reason
      : result.error ?? `Forge status=${result.status}`;
    if (attempt.outcome === 'failed') {
      clearRunnerCredential(options.runDir, attempt);
      if (pendingReplacement) {
        cancelReplacement(
          manifest,
          pendingReplacement.replacement_id,
          attempt.detail,
        );
      }
    }
    appendAttemptEvent(
      manifest,
      attempt.outcome === 'blocked'
        ? 'stage_blocked'
        : attempt.outcome === 'failed'
          ? 'stage_failed'
          : 'stage_interrupted',
      attempt,
      beforeOutcome,
      attempt.outcome,
      attempt.detail,
    );
    saveManifest(options.runDir, manifest);
    throw new Error(
      `阶段 ${spec.key} 未通过 Forge 门禁: status=${result.status}, error=${result.error ?? 'none'}`,
    );
  }

  let record: StageRecord;
  try {
    record = materializeDeliveredArtifact({
      run_dir: options.runDir,
      manifest,
      plan: {
        run_id: options.runId,
        story_id: options.storyId,
        stage_key: spec.key,
        stage: spec.stage,
        chapter_id: spec.chapterId,
        expected_artifact_type: spec.expectedArtifactType,
        expected_scenario_snapshot_sha256:
          attempt.expected_scenario_snapshot_sha256,
        input_sha256: inputHash,
        parent_record_ids: spec.parents.map((parent) => parent.record_id),
        template_identity: spec.templateIdentity,
      },
      attempt,
      snapshot: result,
      validate: spec.validate,
      activation: pendingReplacement ? 'candidate' : 'active',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const beforeOutcome = attempt.outcome;
    attempt.outcome = 'validation_failed';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = message;
    clearRunnerCredential(options.runDir, attempt);
    if (pendingReplacement) {
      cancelReplacement(
        manifest,
        pendingReplacement.replacement_id,
        message,
      );
    }
    appendAttemptEvent(
      manifest,
      'stage_validation_failed',
      attempt,
      beforeOutcome,
      attempt.outcome,
      attempt.detail,
      {
        artifactId: result.final_artifact.artifact_id,
        artifactVersion: result.final_artifact.version,
        versionId: result.final_artifact.version_id,
        recordId: null,
      },
    );
    saveManifest(options.runDir, manifest);
    throw new Error(`阶段 ${spec.key} 未通过机械门禁: ${attempt.detail}`);
  }
  if (pendingReplacement) {
    prepareReplacementCandidate(
      manifest,
      pendingReplacement.replacement_id,
      attempt.attempt_id,
      record,
    );
    saveManifest(options.runDir, manifest);
    const committed = persistReplacementCommit(
      join(options.runDir, 'manifest.json'),
      pendingReplacement.replacement_id,
      manifest.revision,
    );
    Object.assign(manifest, committed);
    const committedRecord = activeForConsumption(manifest, spec.key);
    if (!committedRecord || committedRecord.record_id !== record.record_id) {
      throw new Error(`阶段 ${spec.key} replacement commit 未激活候选记录`);
    }
    process.stdout.write(`[done] ${record.record_id} -> ${caseId}\n`);
    return committedRecord;
  }
  clearRunnerCredential(options.runDir, attempt);
  saveManifest(options.runDir, manifest);
  process.stdout.write(`[done] ${record.record_id} -> ${caseId}\n`);
  return record;
}

function readArtifact(runDir: string, record: StageRecord): string {
  const path = resolve(runDir, record.artifact_path);
  ensureInsideRunDir(runDir, path);
  return readFileSync(path, 'utf8');
}

function endingExcerpt(content: string, maxChars = 500): string {
  return content.length <= maxChars ? content : content.slice(-maxChars);
}

function stagePlanFromAttempts(
  config: PipelineConfig,
  manifest: PipelineManifest,
  attempts: StageAttempt[],
): StagePlan {
  const first = attempts[0];
  if (!first) throw new Error('cannot build a stage plan without attempts');
  const expectedStages = new Map<string, {
    stage: string;
    chapterId: string | null;
    template: string;
    artifactType: string;
  }>();
  expectedStages.set('outline', {
    stage: 'outline',
    chapterId: null,
    template: 'zhihu-story-outline',
    artifactType: 'blueprint_bundle',
  });
  expectedStages.set('final', {
    stage: 'final_review',
    chapterId: null,
    template: 'zhihu-story-final',
    artifactType: 'final_manuscript',
  });
  for (const chapter of config.chapters) {
    const chapterKey = chapter.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    expectedStages.set(`packet-${chapterKey}`, {
      stage: 'chapter_packet',
      chapterId: chapter.id,
      template: 'zhihu-chapter-packet',
      artifactType: 'chapter_packet',
    });
    expectedStages.set(`draft-${chapterKey}`, {
      stage: 'chapter_draft',
      chapterId: chapter.id,
      template: 'zhihu-chapter-draft',
      artifactType: 'chapter_draft',
    });
    expectedStages.set(`ledger-${chapterKey}`, {
      stage: 'ledger_update',
      chapterId: chapter.id,
      template: 'zhihu-story-ledger',
      artifactType: 'state_ledger',
    });
  }
  const expected = expectedStages.get(first.stage_key);
  if (
    !expected
    || first.stage !== expected.stage
    || first.chapter_id !== expected.chapterId
    || first.template !== expected.template
    || first.expected_artifact_type !== expected.artifactType
  ) {
    throw new Error(
      `manifest cannot reconstruct a config-backed StagePlan for ${first.stage_key}`,
    );
  }
  const planIdentity = canonicalJson({
    stage: first.stage,
    chapter_id: first.chapter_id,
    expected_artifact_type: first.expected_artifact_type,
    expected_scenario_snapshot_sha256:
      first.expected_scenario_snapshot_sha256,
    input_sha256: first.input_sha256,
    parent_record_ids: first.parent_record_ids,
    template_identity: first.template_identity,
  });
  if (attempts.some((attempt) => canonicalJson({
    stage: attempt.stage,
    chapter_id: attempt.chapter_id,
    expected_artifact_type: attempt.expected_artifact_type,
    expected_scenario_snapshot_sha256:
      attempt.expected_scenario_snapshot_sha256,
    input_sha256: attempt.input_sha256,
    parent_record_ids: attempt.parent_record_ids,
    template_identity: attempt.template_identity,
  }) !== planIdentity)) {
    throw new Error(
      `manifest cannot reconstruct one StagePlan for ${first.stage_key}`,
    );
  }
  return {
    run_id: manifest.run_id,
    story_id: manifest.story_id,
    stage_key: first.stage_key,
    stage: first.stage,
    chapter_id: first.chapter_id,
    expected_artifact_type: first.expected_artifact_type,
    expected_scenario_snapshot_sha256:
      first.expected_scenario_snapshot_sha256,
    input_sha256: first.input_sha256,
    parent_record_ids: [...first.parent_record_ids],
    template_identity: { ...first.template_identity },
  };
}

function recoveryInput(
  runDir: string,
  attempt: StageAttempt,
): Record<string, unknown> {
  const path = resolve(runDir, attempt.input_path);
  ensureInsideRunDir(runDir, path);
  if (!existsSync(path)) {
    throw new Error(`attempt input evidence is missing: ${attempt.input_path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      `attempt input evidence is not valid JSON: ${attempt.input_path}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('attempt input evidence must be a JSON object');
  }
  if (sha256(canonicalJson(parsed)) !== attempt.input_sha256) {
    throw new Error('attempt input evidence SHA-256 does not match the Attempt');
  }
  return parsed as Record<string, unknown>;
}

function requiredInputString(
  input: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} recovery input is missing ${key}`);
  }
  return value;
}

function structuredInput<T>(
  input: Record<string, unknown>,
  key: string,
  label: string,
): T {
  const serialized = requiredInputString(input, key, label);
  try {
    return JSON.parse(serialized) as T;
  } catch {
    throw new Error(`${label} recovery input has invalid ${key}`);
  }
}

function verifiedParentSidecar(
  runDir: string,
  manifest: PipelineManifest,
  attempt: StageAttempt,
  artifactType: string,
): Record<string, unknown> {
  const parent = attempt.parent_record_ids
    .map((recordId) => manifest.stages.find(
      (record) => record.record_id === recordId,
    ))
    .find((record) => record?.artifact_type === artifactType);
  if (!parent) {
    throw new Error(
      `${attempt.stage_key} recovery evidence is missing ${artifactType} parent`,
    );
  }
  const path = resolve(runDir, parent.sidecar_path);
  ensureInsideRunDir(runDir, path);
  if (!existsSync(path)) {
    throw new Error(`${attempt.stage_key} recovery parent sidecar is missing`);
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== parent.sidecar_sha256) {
    throw new Error(
      `${attempt.stage_key} recovery parent sidecar SHA-256 does not match`,
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`${attempt.stage_key} recovery parent sidecar is invalid`);
  }
}

export function recoveryValidatorFromEvidence(
  config: PipelineConfig,
  manifest: PipelineManifest,
  attempt: StageAttempt,
  runDir: string,
): (rawContent: string) => ValidationResult {
  const input = recoveryInput(runDir, attempt);
  if (attempt.stage === 'outline') {
    const boundaries = structuredInput<ChapterBoundaryMap>(
      input,
      'chapter_boundaries',
      'outline',
    );
    if (
      !Array.isArray(boundaries.chapters)
      || config.chapters.some((chapter) =>
        !boundaries.chapters.some((boundary) => boundary.id === chapter.id)
      )
    ) {
      throw new Error('outline recovery chapter boundaries do not match config');
    }
    return (rawContent) => validateOutline(
      attempt.stage_key,
      rawContent,
      boundaries,
    );
  }
  if (attempt.stage === 'chapter_packet') {
    const boundary = structuredInput<ChapterBoundary>(
      input,
      'chapter_boundary',
      'packet',
    );
    if (
      typeof boundary.id !== 'string'
      || boundary.id !== attempt.chapter_id
    ) {
      throw new Error('packet recovery chapter boundary does not match Attempt');
    }
    const sourceText = requiredInputString(
      input,
      'reference_chapter_text',
      'packet',
    );
    return (rawContent) => validatePacket(
      attempt.stage_key,
      rawContent,
      boundary,
      sourceText,
    );
  }
  if (attempt.stage === 'chapter_draft') {
    const packetContent = requiredInputString(
      input,
      'chapter_packet',
      'draft',
    );
    const sourceText = requiredInputString(
      input,
      'reference_chapter_text',
      'draft',
    );
    const packetSidecar = verifiedParentSidecar(
      runDir,
      manifest,
      attempt,
      'chapter_packet',
    );
    return (rawContent) => validateDraft(
      attempt.stage_key,
      rawContent,
      packetContent,
      packetSidecar,
      sourceText,
    );
  }
  if (attempt.stage === 'ledger_update') {
    const chapterId = requiredInputString(input, 'chapter_id', 'ledger');
    if (chapterId !== attempt.chapter_id) {
      throw new Error('ledger recovery chapter_id does not match Attempt');
    }
    const draftContent = requiredInputString(
      input,
      'approved_chapter_draft',
      'ledger',
    );
    const previousLedger = requiredInputString(
      input,
      'previous_ledger',
      'ledger',
    );
    return (rawContent) => validateLedger(
      attempt.stage_key,
      rawContent,
      chapterId,
      draftContent,
      previousLedger,
    );
  }
  if (attempt.stage === 'final_review') {
    const assembled = requiredInputString(
      input,
      'assembled_manuscript',
      'final',
    );
    const approved = structuredInput<Array<{ chapter_id?: unknown }>>(
      input,
      'approved_chapters',
      'final',
    );
    if (
      !Array.isArray(approved)
      || approved.some((chapter) => typeof chapter.chapter_id !== 'string')
    ) {
      throw new Error('final recovery approved_chapters is invalid');
    }
    const chapterIds = approved.map((chapter) => String(chapter.chapter_id));
    if (
      canonicalJson(chapterIds)
      !== canonicalJson(config.chapters.map((chapter) => chapter.id))
    ) {
      throw new Error('final recovery approved chapters do not match config');
    }
    return (rawContent) => validateFinal(
      attempt.stage_key,
      rawContent,
      assembled,
      chapterIds,
    );
  }
  throw new Error(`no recovery validator for stage ${attempt.stage}`);
}

export async function reconcileRun(
  options: ReconcileOptions,
  forgeClient: ForgeClient,
  signal: AbortSignal,
  validators: Record<string, (rawContent: string) => ValidationResult> = {},
): Promise<ReconcileRunResult> {
  const configText = readFileSync(options.configPath, 'utf8');
  const config = loadConfig(options.configPath);
  const manifestPath = join(options.runDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`run manifest does not exist: ${manifestPath}`);
  }
  let initialManifest = loadManifest(manifestPath);
  validateManifestChain(initialManifest);
  if (
    initialManifest.run_id !== config.run_id
    || initialManifest.story_id !== config.story_id
    || initialManifest.config_sha256 !== sha256(configText)
  ) {
    throw new Error('production config does not match the run manifest');
  }
  if (!options.dryRun) {
    cleanupTerminalReplacementCredentials(manifestPath, initialManifest);
  }
  if (
    !options.dryRun
    && (
      options.attestTemplateCompatibility
      || options.attestLegacyCaseBindings.length > 0
    )
  ) {
    if (options.attestTemplateCompatibility) {
      appendManifestEvent(initialManifest, {
        at: new Date().toISOString(),
        type: 'operator_attestation',
        stage_key: 'manifest',
        attempt_id: null,
        before_outcome: null,
        after_outcome: null,
        case_id: null,
        artifact_id: null,
        artifact_version: null,
        version_id: null,
        record_id: null,
        reason: 'operator attested template compatibility',
        actor: 'operator',
      });
    }
    for (const binding of options.attestLegacyCaseBindings) {
      const separator = binding.lastIndexOf(':');
      const caseId = separator > 0 ? binding.slice(0, separator) : '';
      const stageKey = separator > 0 ? binding.slice(separator + 1) : '';
      if (!caseId || !stageKey) {
        throw new Error(
          '--attest-legacy-case-binding requires <case-id>:<stage-key>',
        );
      }
      appendManifestEvent(initialManifest, {
        at: new Date().toISOString(),
        type: 'operator_attestation',
        stage_key: stageKey,
        attempt_id: null,
        before_outcome: null,
        after_outcome: null,
        case_id: caseId,
        artifact_id: null,
        artifact_version: null,
        version_id: null,
        record_id: null,
        reason: 'operator attested legacy case binding',
        actor: 'operator',
      });
    }
    saveManifest(options.runDir, initialManifest);
    initialManifest = loadManifest(manifestPath);
  }

  const nonterminal = initialManifest.attempts.filter((attempt) =>
    ['running', 'interrupted', 'blocked'].includes(attempt.outcome)
  );
  const attemptsByStage = new Map<string, StageAttempt[]>();
  for (const attempt of nonterminal) {
    const stageAttempts = attemptsByStage.get(attempt.stage_key) ?? [];
    stageAttempts.push(attempt);
    attemptsByStage.set(attempt.stage_key, stageAttempts);
  }
  const actions: ReconciliationAction[] = [];
  for (const initialStageAttempts of attemptsByStage.values()) {
    const initialPlan = stagePlanFromAttempts(
      config,
      initialManifest,
      initialStageAttempts,
    );
    const stageLock = options.dryRun
      ? null
      : acquireStageLock({
          run_dir: options.runDir,
          run_id: initialManifest.run_id,
          stage_key: initialPlan.stage_key,
          owner_token: randomUUID(),
        });
    try {
      const manifest = options.dryRun
        ? initialManifest
        : loadManifest(manifestPath);
      const stageAttempts = manifest.attempts.filter((attempt) =>
        initialStageAttempts.some(
          (initial) => initial.attempt_id === attempt.attempt_id,
        )
        && ['running', 'interrupted', 'blocked'].includes(attempt.outcome)
      );
      if (stageAttempts.length === 0) continue;
      const plan = stagePlanFromAttempts(config, manifest, stageAttempts);
      const pendingReplacement = replacementTarget(
        manifest,
        plan.stage_key,
      );
      if (
        pendingReplacement?.attempt_id
        && options.adoptCase
        && stageAttempts.find(
          (attempt) => attempt.attempt_id === pendingReplacement.attempt_id,
        )?.case_id !== options.adoptCase
      ) {
        throw new Error(
          `pending replacement ${pendingReplacement.replacement_id} `
          + 'cannot adopt a different Case',
        );
      }
    const snapshots = new Map<string, ForgeCaseSnapshot>();
    for (const attempt of stageAttempts) {
      snapshots.set(
        attempt.case_id,
        await forgeClient.getCaseStatus(attempt.case_id, options.dbPath),
      );
    }
      const stageActions = reconcileStage(
      plan,
      stageAttempts,
      snapshots,
      options.adoptCase ?? (
        pendingReplacement?.attempt_id
          ? stageAttempts.find(
              (attempt) =>
                attempt.attempt_id === pendingReplacement.attempt_id,
            )?.case_id
          : undefined
      ),
      );
      actions.push(...stageActions);
      if (options.dryRun) continue;

      const pending = [...stageActions];
      const processedFingerprints = new Set<string>();
      let processedActions = 0;
      while (pending.length > 0) {
        const action = pending.shift()!;
        processedActions += 1;
        if (processedActions > 64) {
          throw new Error('reconciliation action limit exceeded');
        }
        const actionCaseId = 'case_id' in action ? action.case_id : null;
        const fingerprint = canonicalJson({
          action,
          forge_status: actionCaseId
            ? snapshots.get(actionCaseId)?.status ?? null
            : null,
        });
        if (processedFingerprints.has(fingerprint)) {
          throw new Error(
            `reconciliation made no progress for stage ${plan.stage_key}`,
          );
        }
        processedFingerprints.add(fingerprint);
        if (action.action === 'ambiguous') {
          throw new Error(
            `stage ${action.stage_key} is ambiguous: ${action.candidates.join(', ')}`,
          );
        }
        const attempt = manifest.attempts.find(
          (candidate) => candidate.attempt_id === action.attempt_id,
        );
        if (!attempt) {
          throw new Error(`reconciliation attempt is missing: ${action.attempt_id}`);
        }
        if (action.action === 'close' || action.action === 'reject') {
          const outcome = action.action === 'close'
            ? action.outcome
            : 'failed';
          const beforeOutcome = attempt.outcome;
          attempt.outcome = outcome;
          attempt.updated_at = new Date().toISOString();
          attempt.detail = action.reason;
          if (outcome === 'failed') {
            clearRunnerCredential(options.runDir, attempt);
            if (
              pendingReplacement?.attempt_id === attempt.attempt_id
              && pendingReplacement.status === 'pending'
            ) {
              cancelReplacement(
                manifest,
                pendingReplacement.replacement_id,
                action.reason,
              );
            }
          }
          appendAttemptEvent(
            manifest,
            outcome === 'failed' ? 'stage_failed' : 'stage_interrupted',
            attempt,
            beforeOutcome,
            outcome,
            action.reason,
          );
          saveManifest(options.runDir, manifest);
          continue;
        }
        if (action.action === 'block') {
          if (attempt.outcome !== 'blocked') {
            const beforeOutcome = attempt.outcome;
            attempt.outcome = 'blocked';
            attempt.updated_at = new Date().toISOString();
            attempt.detail = action.reason;
            appendAttemptEvent(
              manifest,
              'stage_blocked',
              attempt,
              beforeOutcome,
              'blocked',
              action.reason,
            );
            saveManifest(options.runDir, manifest);
          }
          continue;
        }
        if (action.action === 'adopt') {
          const snapshot = snapshots.get(action.case_id);
          if (!snapshot) {
            throw new Error(`Forge snapshot is missing: ${action.case_id}`);
          }
          let record: StageRecord;
          try {
            record = materializeDeliveredArtifact({
              run_dir: options.runDir,
              manifest,
              plan,
              attempt,
              snapshot,
              validate: validators[plan.stage_key]
                ?? recoveryValidatorFromEvidence(
                  config,
                  manifest,
                  attempt,
                  options.runDir,
                ),
              activation: pendingReplacement ? 'candidate' : 'active',
            });
          } catch (error) {
            if (!pendingReplacement) throw error;
            const reason = error instanceof Error
              ? error.message
              : String(error);
            const beforeOutcome = attempt.outcome;
            attempt.outcome = 'validation_failed';
            attempt.updated_at = new Date().toISOString();
            attempt.detail = reason;
            clearRunnerCredential(options.runDir, attempt);
            cancelReplacement(
              manifest,
              pendingReplacement.replacement_id,
              reason,
            );
            appendAttemptEvent(
              manifest,
              'stage_validation_failed',
              attempt,
              beforeOutcome,
              'validation_failed',
              reason,
            );
            saveManifest(options.runDir, manifest);
            throw error;
          }
          if (pendingReplacement) {
            if (pendingReplacement.attempt_id !== attempt.attempt_id) {
              throw new Error(
                'approved candidate does not belong to pending replacement',
              );
            }
            const beforeEvents = manifest.events.length;
            prepareReplacementCandidate(
              manifest,
              pendingReplacement.replacement_id,
              attempt.attempt_id,
              record,
            );
            if (manifest.events.length > beforeEvents) {
              saveManifest(options.runDir, manifest);
            }
            Object.assign(
              manifest,
              persistReplacementCommit(
                manifestPath,
                pendingReplacement.replacement_id,
                manifest.revision,
              ),
            );
          } else {
            clearRunnerCredential(options.runDir, attempt);
            saveManifest(options.runDir, manifest);
          }
          continue;
        }

        if (!options.mode) {
          throw new Error('reconcile resume requires --mode fake|real');
        }
        if (attempt.runner_credential_path === null) {
          throw new Error(
            `Attempt ${attempt.attempt_id} has no runner credential`,
          );
        }
        const runnerCredentialPath = resolve(
          options.runDir,
          attempt.runner_credential_path,
        );
        ensureInsideRunDir(options.runDir, runnerCredentialPath);
        const resumedSnapshot = await forgeClient.runCase(
          action.case_id,
          {
            dbPath: options.dbPath,
            mode: options.mode,
            runnerCredentialPath,
          },
          signal,
        );
        snapshots.set(action.case_id, resumedSnapshot);
        const followup = reconcileStage(
          plan,
          [attempt],
          new Map([[action.case_id, resumedSnapshot]]),
          action.case_id,
        );
        actions.push(...followup);
        pending.push(...followup);
      }
    } finally {
      stageLock?.release();
    }
  }
  return { actions };
}

async function runReconcile(
  options: ReconcileOptions,
  forgeClient: ForgeClient,
  signal: AbortSignal,
): Promise<void> {
  const result = await reconcileRun(options, forgeClient, signal);
  process.stdout.write(`${JSON.stringify({
    success: true,
    dry_run: options.dryRun,
    actions: result.actions,
  })}\n`);
}

async function runPipeline(
  options: RunOptions,
  forgeClient: ForgeClient,
  signal: AbortSignal,
): Promise<void> {
  const configText = readFileSync(options.configPath, 'utf8');
  const config = loadConfig(options.configPath);
  const sourcePath = resolve(dirname(options.configPath), config.source_file);
  if (!existsSync(sourcePath)) throw new Error(`源文件不存在: ${sourcePath}`);
  const canonicalSourcePath = realpathSync(sourcePath);
  const sourceText = readFileSync(canonicalSourcePath, 'utf8');
  const boundary = ensureBoundaryMap(options.runDir, canonicalSourcePath);
  const boundaryIds = new Set(boundary.map.chapters.map((chapter) => chapter.id));
  const unknownChapters = config.chapters.filter((chapter) => !boundaryIds.has(chapter.id));
  if (unknownChapters.length > 0) {
    throw new Error(`配置章节不在机械边界 map 中: ${unknownChapters.map((chapter) => chapter.id).join(', ')}`);
  }
  const manifest = loadOrCreateManifest(
    options.runDir,
    config,
    sha256(configText),
    boundary.path,
    boundary.hash,
  );
  await reconcileRun({
    command: 'reconcile',
    configPath: options.configPath,
    runDir: options.runDir,
    dbPath: options.dbPath,
    mode: options.mode,
    dryRun: false,
    attestTemplateCompatibility: false,
    attestLegacyCaseBindings: [],
  }, forgeClient, signal);
  Object.assign(
    manifest,
    loadManifest(join(options.runDir, 'manifest.json')),
  );
  const outlineTemplateIdentity = templateIdentity('zhihu-story-outline');

  const outline = await executeStage(
    manifest,
    {
      key: 'outline',
      stage: 'outline',
      chapterId: null,
      template: 'zhihu-story-outline',
      templateIdentity: outlineTemplateIdentity,
      expectedArtifactType: 'blueprint_bundle',
      title: `${config.title} / 大纲`,
      input: {
        source_text: sourceText,
        chapter_boundaries: JSON.stringify(boundary.map),
        production_mode: config.mode,
        production_requirements: config.requirements,
      },
      parents: [],
      validate: (rawContent) => validateOutline('outline', rawContent, boundary.map),
    },
    options,
    forgeClient,
    signal,
  );
  const blueprint = readArtifact(options.runDir, outline);
  const outlineSidecar = readSidecar(options.runDir, outline);
  const packetTemplateIdentity = templateIdentity('zhihu-chapter-packet');
  const draftTemplateIdentity = templateIdentity('zhihu-chapter-draft');
  const ledgerTemplateIdentity = templateIdentity('zhihu-story-ledger');
  const finalTemplateIdentity = templateIdentity('zhihu-story-final');

  let previousLedger: StageRecord | null = null;
  let previousDraft: StageRecord | null = null;
  const drafts: StageRecord[] = [];

  for (const chapter of config.chapters) {
    const chapterKey = chapter.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const chapterBoundary = boundary.map.chapters.find((item) => item.id === chapter.id);
    if (!chapterBoundary) throw new Error(`找不到章节边界: ${chapter.id}`);
    const referenceChapterText = sliceChapterSource(sourceText, chapterBoundary);
    const previousLedgerText = previousLedger
      ? readArtifact(options.runDir, previousLedger)
      : '这是第一章，尚无上一章状态账本。';
    const previousEnding = previousDraft
      ? endingExcerpt(readArtifact(options.runDir, previousDraft))
      : '这是第一章，尚无上一章结尾。';

    const packet = await executeStage(
      manifest,
      {
        key: `packet-${chapterKey}`,
        stage: 'chapter_packet',
        chapterId: chapter.id,
        template: 'zhihu-chapter-packet',
        templateIdentity: packetTemplateIdentity,
        expectedArtifactType: 'chapter_packet',
        title: `${config.title} / ${chapter.label ?? chapter.id} / 执行包`,
        input: {
          chapter_id: chapter.id,
          chapter_label: chapter.label ?? chapter.id,
          chapter_boundary: JSON.stringify(chapterBoundary),
          reference_chapter_text: referenceChapterText,
          blueprint_bundle: blueprint,
          blueprint_sidecar: JSON.stringify(outlineSidecar),
          previous_ledger: previousLedgerText,
          previous_chapter_ending: previousEnding,
        },
        parents: [outline, ...(previousLedger ? [previousLedger] : [])],
        validate: (rawContent) => validatePacket(
          `packet-${chapterKey}`,
          rawContent,
          chapterBoundary,
          sourceText,
        ),
      },
      options,
      forgeClient,
      signal,
    );
    const packetContent = readArtifact(options.runDir, packet);
    const packetSidecar = readSidecar(options.runDir, packet);

    const draft = await executeStage(
      manifest,
      {
        key: `draft-${chapterKey}`,
        stage: 'chapter_draft',
        chapterId: chapter.id,
        template: 'zhihu-chapter-draft',
        templateIdentity: draftTemplateIdentity,
        expectedArtifactType: 'chapter_draft',
        title: `${config.title} / ${chapter.label ?? chapter.id} / 正文`,
        input: {
          chapter_id: chapter.id,
          chapter_label: chapter.label ?? chapter.id,
          chapter_packet: packetContent,
          reference_chapter_text: referenceChapterText,
          repair_context: '首稿生产；如 Forge 审核产生 Issue，只按安全返修范围修改。',
        },
        parents: [packet],
        validate: (rawContent) => validateDraft(
          `draft-${chapterKey}`,
          rawContent,
          packetContent,
          packetSidecar,
          sourceText,
        ),
      },
      options,
      forgeClient,
      signal,
    );
    drafts.push(draft);

    const ledger = await executeStage(
      manifest,
      {
        key: `ledger-${chapterKey}`,
        stage: 'ledger_update',
        chapterId: chapter.id,
        template: 'zhihu-story-ledger',
        templateIdentity: ledgerTemplateIdentity,
        expectedArtifactType: 'state_ledger',
        title: `${config.title} / ${chapter.label ?? chapter.id} / 状态账本`,
        input: {
          chapter_id: chapter.id,
          approved_chapter_draft: readArtifact(options.runDir, draft),
          previous_ledger: previousLedgerText,
          forge_audit_evidence: `上游正文 Case ${draft.case_id} 已通过 Forge 独立审核与交付门禁。`,
        },
        parents: [draft, ...(previousLedger ? [previousLedger] : [])],
        validate: (rawContent) => validateLedger(
          `ledger-${chapterKey}`,
          rawContent,
          chapter.id,
          readArtifact(options.runDir, draft),
          previousLedgerText,
        ),
      },
      options,
      forgeClient,
      signal,
    );
    previousDraft = draft;
    previousLedger = ledger;
  }

  const assembledManuscript = drafts
    .map((draft) => readArtifact(options.runDir, draft).trim())
    .join('\n\n');
  const finalStage = await executeStage(
    manifest,
    {
      key: 'final',
      stage: 'final_review',
      chapterId: null,
      template: 'zhihu-story-final',
      templateIdentity: finalTemplateIdentity,
      expectedArtifactType: 'final_manuscript',
      title: `${config.title} / 全文终审`,
      input: {
        blueprint_bundle: blueprint,
        assembled_manuscript: assembledManuscript,
        approved_chapters: JSON.stringify(
          drafts.map((draft) => ({
            chapter_id: draft.chapter_id,
            case_id: draft.case_id,
            content: readArtifact(options.runDir, draft),
          })),
        ),
        final_ledger: previousLedger
          ? readArtifact(options.runDir, previousLedger)
          : '无状态账本。',
        production_requirements: config.requirements,
      },
      parents: [outline, ...drafts, ...(previousLedger ? [previousLedger] : [])],
      validate: (rawContent) => validateFinal(
        'final',
        rawContent,
        assembledManuscript,
        drafts.map((draft) => String(draft.chapter_id)),
      ),
    },
    options,
    forgeClient,
    signal,
  );

  if (manifest.final_artifact_path !== finalStage.artifact_path) {
    manifest.final_artifact_path = finalStage.artifact_path;
    const finalAttempt = [...manifest.attempts].reverse().find(
      (attempt) => attempt.case_id === finalStage.case_id,
    );
    if (!finalAttempt) throw new Error(`终稿阶段缺少 Attempt: ${finalStage.case_id}`);
    appendAttemptEvent(
      manifest,
      'final_artifact_selected',
      finalAttempt,
      finalAttempt.outcome,
      finalAttempt.outcome,
      '选择当前有效终稿',
      {
        artifactId: finalStage.record_id,
        artifactVersion: finalStage.artifact_version,
        versionId: finalStage.record_id,
        recordId: finalStage.record_id,
      },
    );
    saveManifest(options.runDir, manifest);
  }
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      run_id: config.run_id,
      stages: manifest.stages.length,
      final_case_id: finalStage.case_id,
      final_artifact: resolve(options.runDir, finalStage.artifact_path),
      manifest: resolve(options.runDir, 'manifest.json'),
      db: options.dbPath,
    })}\n`,
  );
}

function runInvalidate(options: InvalidateOptions): void {
  const manifestPath = join(options.runDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`运行清单不存在: ${manifestPath}`);
  const manifest = loadManifest(manifestPath);
  validateManifestChain(manifest);
  const root = activeStage(manifest, options.fromStage);
  if (!root) throw new Error(`没有可失效的当前阶段: ${options.fromStage}`);
  const affected = invalidateStageAndDescendants(manifest, root, options.reason);
  saveManifest(options.runDir, manifest);
  process.stdout.write(`${JSON.stringify({
    success: true,
    from_stage: options.fromStage,
    root_record_id: root.record_id,
    invalidated: affected.map((stage) => ({
      record_id: stage.record_id,
      stage_key: stage.stage_key,
      case_id: stage.case_id,
    })),
    manifest: manifestPath,
  })}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'invalidate') {
    runInvalidate(options);
    return;
  }
  if (options.command === 'reconcile') {
    const controller = new AbortController();
    const removeSignalHandlers = installAbortSignalHandlers(controller);
    try {
      await runReconcile(
        options,
        new ForgeCliClient({ repoRoot }),
        controller.signal,
      );
    } finally {
      removeSignalHandlers();
    }
    return;
  }

  const controller = new AbortController();
  const removeSignalHandlers = installAbortSignalHandlers(controller);
  try {
    await runPipeline(
      options,
      new ForgeCliClient({ repoRoot }),
      controller.signal,
    );
  } finally {
    removeSignalHandlers();
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `[story-pipeline] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
