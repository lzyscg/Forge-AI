import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ChapterBoundaryMap,
  type QualityReport,
  type ValidationResult,
  sha256,
  validateDraft,
  validateFinal,
  validateLedger,
  validateOutline,
  validatePacket,
} from './quality.js';
import { descendantClosure } from './invalidation.js';
import {
  appendManifestEvent,
  loadManifest,
  saveManifestCas,
  validateManifestChain,
  type AttemptOutcome,
  type InvalidationRecord,
  type PipelineManifestV21 as PipelineManifest,
  type StageAttemptV21 as StageAttempt,
  type StageRecordV21 as StageRecord,
  type TemplateIdentity,
} from './manifest.js';
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

interface ForgeArtifact {
  type: string;
  version: number;
  status: string;
  content: string;
  artifact_id: string;
  version_id: string;
}

interface ForgeResult {
  case_id: string;
  status: string;
  success: boolean;
  final_artifact: ForgeArtifact | null;
  error: string | null;
}

interface RunOptions {
  command: 'run';
  configPath: string;
  runDir: string;
  dbPath: string;
  mode: PiMode;
}

interface InvalidateOptions {
  command: 'invalidate';
  runDir: string;
  fromStage: string;
  reason: string;
}

type CliOptions = RunOptions | InvalidateOptions;

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
const forgeBin = join(repoRoot, 'apps', 'cli', 'bin.js');
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

function parseArgs(argv: string[]): CliOptions {
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
  return { command: 'run', configPath, runDir, dbPath, mode };
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
  if (existsSync(manifestPath)) {
    const manifest = loadManifest(manifestPath);
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

  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  const manifest: PipelineManifest = {
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
  };
  writeJson(manifestPath, manifest);
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

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        results.push(value as Record<string, unknown>);
      }
    } catch {
      // CLI 的非 JSON 人类日志只进入 stderr；这里忽略偶发的普通文本。
    }
  }
  return results;
}

function runForge(args: string[], envExtra: Record<string, string>): Record<string, unknown>[] {
  const result = spawnSync(process.execPath, [forgeBin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...envExtra },
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  const parsed = parseJsonLines(result.stdout ?? '');
  if (result.status !== 0) {
    const last = parsed.at(-1);
    throw new Error(
      `Forge CLI 失败 (${args.join(' ')}): ${String(last?.error ?? result.error?.message ?? result.stdout ?? 'unknown error')}`,
    );
  }
  return parsed;
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
    const reason = `${spec.key} 自动失效：${changeReasons.join('、')}`;
    const affected = invalidateStageAndDescendants(manifest, record, reason);
    saveManifest(runDir, manifest);
    process.stdout.write(`[invalidate] ${affected.map((item) => item.record_id).join(', ')}\n`);
    return null;
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

function executeStage(
  manifest: PipelineManifest,
  spec: StageSpec,
  options: RunOptions,
): StageRecord {
  const resumed = existingStage(manifest, spec, options.runDir);
  if (resumed) {
    process.stdout.write(`[skip] ${spec.key} -> ${resumed.record_id} / ${resumed.case_id}\n`);
    return resumed;
  }

  const inputHash = sha256(canonicalJson(spec.input));
  const resumableAttempts = [...manifest.attempts].reverse().filter(
    (attempt) =>
      attempt.stage_key === spec.key &&
      attempt.input_sha256 === inputHash &&
      ['running', 'interrupted', 'blocked'].includes(attempt.outcome),
  );
  if (resumableAttempts.some(
    (attempt) =>
      compareTemplateIdentity(attempt.template_identity, spec.templateIdentity) ===
      'migration_required',
  )) {
    throw new Error(`阶段 ${spec.key} 的 Attempt 模板身份算法已变化，需要先完成显式身份迁移`);
  }
  const reusableAttempt = resumableAttempts.find(
    (attempt) =>
      compareTemplateIdentity(attempt.template_identity, spec.templateIdentity) === 'equal' &&
      attempt.template === spec.template,
  );

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
    process.stdout.write(`[resume] ${spec.key} -> ${caseId}\n`);
  } else {
    const attemptNumber = manifest.attempts.filter((item) => item.stage_key === spec.key).length + 1;
    const attemptId = `${spec.key}-a${attemptNumber}`;
    inputPath = join(options.runDir, 'inputs', spec.key, `${attemptId}.json`);
    ensureInsideRunDir(options.runDir, inputPath);
    writeJson(inputPath, spec.input);
    process.stdout.write(`[run] ${spec.key} (${spec.template})\n`);
    const env = { FORGE_INPUT_FILE: inputPath };
    const createLines = runForge(
      ['case', 'create', '--template', spec.template, '--db', options.dbPath, '--mode', options.mode, '--title', spec.title],
      env,
    );
    const createResult = createLines.at(-1);
    caseId = String(createResult?.case_id ?? '');
    if (!caseId) throw new Error(`阶段 ${spec.key} 未返回 case_id`);
    const now = new Date().toISOString();
    attempt = {
      attempt_id: attemptId,
      stage_key: spec.key,
      stage: spec.stage,
      chapter_id: spec.chapterId,
      template: spec.template,
      expected_artifact_type: spec.expectedArtifactType,
      case_id: caseId,
      input_sha256: inputHash,
      parent_record_ids: spec.parents.map((parent) => parent.record_id),
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
    manifest.attempts.push(attempt);
    appendAttemptEvent(
      manifest,
      'stage_started',
      attempt,
      null,
      'running',
      'Forge Case created',
    );
    saveManifest(options.runDir, manifest);
  }

  let result: ForgeResult | undefined;
  try {
    const runLines = runForge(
      ['case', 'run', caseId, '--wait', '--db', options.dbPath, '--mode', options.mode],
      {},
    );
    result = runLines.at(-1) as unknown as ForgeResult | undefined;
  } catch (error) {
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
  if (!result.success || result.status !== 'approved' || !result.final_artifact) {
    const beforeOutcome = attempt.outcome;
    attempt.outcome = result.status === 'waiting_human'
      ? 'blocked'
      : ['failed', 'stopped'].includes(result.status)
        ? 'failed'
        : 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = result.error ?? `Forge status=${result.status}`;
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

  const rawArtifactPath = join(
    options.runDir,
    'raw-artifacts',
    spec.key,
    `${attempt.attempt_id}.md`,
  );
  const validationReportPath = join(
    options.runDir,
    'validation',
    spec.key,
    `${attempt.attempt_id}.json`,
  );
  ensureInsideRunDir(options.runDir, rawArtifactPath);
  ensureInsideRunDir(options.runDir, validationReportPath);
  mkdirSync(dirname(rawArtifactPath), { recursive: true });
  writeFileSync(rawArtifactPath, result.final_artifact.content, 'utf8');
  attempt.raw_artifact_path = relative(options.runDir, rawArtifactPath).replaceAll('\\', '/');

  let validation: ValidationResult;
  try {
    validation = spec.validate(result.final_artifact.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: QualityReport = {
      schema_version: '1.0',
      stage_key: spec.key,
      artifact_kind: spec.stage === 'outline'
        ? 'outline'
        : spec.stage === 'chapter_packet'
          ? 'packet'
          : spec.stage === 'chapter_draft'
            ? 'draft'
            : spec.stage === 'ledger_update'
              ? 'ledger'
              : 'final',
      artifact_sha256: sha256(result.final_artifact.content),
      valid: false,
      checks: [],
      errors: [`validator_exception: ${message}`],
      warnings: [],
      metrics: {},
    };
    validation = {
      canonicalContent: result.final_artifact.content,
      report,
      sidecar: {
        schema_version: '1.0',
        artifact_kind: report.artifact_kind,
        artifact_sha256: report.artifact_sha256,
      },
    };
  }
  writeJson(validationReportPath, validation.report);
  attempt.validation_report_path = relative(options.runDir, validationReportPath).replaceAll('\\', '/');
  if (!validation.report.valid) {
    const beforeOutcome = attempt.outcome;
    attempt.outcome = 'validation_failed';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = validation.report.errors.join('；');
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

  const revision = Math.max(
    0,
    ...manifest.stages.filter((item) => item.stage_key === spec.key).map((item) => item.revision),
  ) + 1;
  const recordId = `${spec.key}-v${revision}`;
  const artifactPath = join(options.runDir, 'artifacts', `${recordId}.md`);
  const sidecarPath = join(options.runDir, 'structured', `${recordId}.json`);
  ensureInsideRunDir(options.runDir, artifactPath);
  ensureInsideRunDir(options.runDir, sidecarPath);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, validation.canonicalContent, 'utf8');
  writeJson(sidecarPath, validation.sidecar);
  const artifactHash = sha256(validation.canonicalContent);
  const record: StageRecord = {
    record_id: recordId,
    revision,
    stage_key: spec.key,
    stage: spec.stage,
    chapter_id: spec.chapterId,
    template: spec.template,
    template_identity: spec.templateIdentity,
    case_id: caseId,
    parent_record_ids: spec.parents.map((parent) => parent.record_id),
    parent_case_ids: spec.parents.map((parent) => parent.case_id),
    status: 'delivered',
    input_path: relative(options.runDir, inputPath).replaceAll('\\', '/'),
    input_sha256: inputHash,
    raw_artifact_path: relative(options.runDir, rawArtifactPath).replaceAll('\\', '/'),
    raw_artifact_sha256: sha256(result.final_artifact.content),
    artifact_path: relative(options.runDir, artifactPath).replaceAll('\\', '/'),
    artifact_sha256: artifactHash,
    sidecar_path: relative(options.runDir, sidecarPath).replaceAll('\\', '/'),
    sidecar_sha256: sha256(readFileSync(sidecarPath)),
    validation_report_path: relative(options.runDir, validationReportPath).replaceAll('\\', '/'),
    validation_report_sha256: sha256(readFileSync(validationReportPath)),
    artifact_type: result.final_artifact.type,
    artifact_version: result.final_artifact.version,
    completed_at: new Date().toISOString(),
  };

  const beforeOutcome = attempt.outcome;
  attempt.outcome = 'delivered';
  attempt.updated_at = record.completed_at;
  attempt.detail = null;
  manifest.stages.push(record);
  appendAttemptEvent(
    manifest,
    'stage_delivered',
    attempt,
    beforeOutcome,
    attempt.outcome,
    '机械门禁通过',
    {
      artifactId: result.final_artifact.artifact_id,
      artifactVersion: result.final_artifact.version,
      versionId: result.final_artifact.version_id,
      recordId,
    },
  );
  saveManifest(options.runDir, manifest);
  process.stdout.write(`[done] ${recordId} -> ${caseId}\n`);
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

function runPipeline(options: RunOptions): void {
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
  const outlineTemplateIdentity = templateIdentity('zhihu-story-outline');

  const outline = executeStage(
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

    const packet = executeStage(
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
    );
    const packetContent = readArtifact(options.runDir, packet);
    const packetSidecar = readSidecar(options.runDir, packet);

    const draft = executeStage(
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
    );
    drafts.push(draft);

    const ledger = executeStage(
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
    );
    previousDraft = draft;
    previousLedger = ledger;
  }

  const assembledManuscript = drafts
    .map((draft) => readArtifact(options.runDir, draft).trim())
    .join('\n\n');
  const finalStage = executeStage(
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

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'run') runPipeline(options);
  else runInvalidate(options);
} catch (error) {
  process.stderr.write(`[story-pipeline] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
