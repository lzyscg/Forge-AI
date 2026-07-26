import { createHash } from 'node:crypto';
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

interface StageRecord {
  stage_key: string;
  stage: string;
  chapter_id: string | null;
  template: string;
  case_id: string;
  parent_case_ids: string[];
  status: 'delivered';
  input_path: string;
  input_sha256: string;
  artifact_path: string;
  artifact_sha256: string;
  artifact_type: string;
  artifact_version: number;
  completed_at: string;
}

interface StageAttempt {
  attempt_id: string;
  stage_key: string;
  case_id: string;
  input_sha256: string;
  outcome: 'running' | 'interrupted' | 'blocked' | 'failed' | 'delivered';
  started_at: string;
  updated_at: string;
  detail: string | null;
}

interface ManifestEvent {
  sequence: number;
  at: string;
  type: 'stage_started' | 'stage_interrupted' | 'stage_blocked' | 'stage_failed' | 'stage_delivered';
  stage_key: string;
  case_id: string;
  previous_event_sha256: string | null;
  event_sha256: string;
}

interface PipelineManifest {
  schema_version: '1.0';
  run_id: string;
  story_id: string;
  title: string;
  mode: PipelineMode;
  config_sha256: string;
  created_at: string;
  updated_at: string;
  stages: StageRecord[];
  attempts: StageAttempt[];
  events: ManifestEvent[];
  final_artifact_path: string | null;
}

interface CliOptions {
  configPath: string;
  runDir: string;
  dbPath: string;
  mode: PiMode;
}

interface StageSpec {
  key: string;
  stage: string;
  chapterId: string | null;
  template: string;
  title: string;
  input: Record<string, unknown>;
  parents: StageRecord[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const forgeBin = join(repoRoot, 'apps', 'cli', 'bin.js');

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  if (argv[0] !== 'run') {
    throw new Error(
      '用法: npx tsx orchestrators/story-pipeline/src/index.ts run --config <file> [--mode fake|real] [--run-dir <dir>] [--db <file>]',
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
  return { configPath, runDir, dbPath, mode };
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
): PipelineManifest {
  const manifestPath = join(runDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PipelineManifest;
    if (manifest.run_id !== config.run_id || manifest.story_id !== config.story_id) {
      throw new Error('现有运行目录属于其他 run/story，拒绝覆盖');
    }
    if (manifest.config_sha256 !== configHash) {
      throw new Error('生产配置已变化。请使用新 run_id，或先完成明确的回退决策');
    }
    manifest.attempts ??= [];
    validateManifestChain(manifest);
    return manifest;
  }

  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  const manifest: PipelineManifest = {
    schema_version: '1.0',
    run_id: config.run_id,
    story_id: config.story_id,
    title: config.title,
    mode: config.mode,
    config_sha256: configHash,
    created_at: now,
    updated_at: now,
    stages: [],
    attempts: [],
    events: [],
    final_artifact_path: null,
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

function appendEvent(
  manifest: PipelineManifest,
  type: ManifestEvent['type'],
  stageKey: string,
  caseId: string,
): void {
  const previousEvent = manifest.events.at(-1);
  const eventBase = {
    sequence: manifest.events.length + 1,
    at: new Date().toISOString(),
    type,
    stage_key: stageKey,
    case_id: caseId,
    previous_event_sha256: previousEvent?.event_sha256 ?? null,
  };
  manifest.events.push({
    ...eventBase,
    event_sha256: sha256(canonicalJson(eventBase)),
  });
  manifest.updated_at = eventBase.at;
}

function saveManifest(runDir: string, manifest: PipelineManifest): void {
  writeJson(join(runDir, 'manifest.json'), manifest);
}

function validateManifestChain(manifest: PipelineManifest): void {
  const stageKeys = new Set<string>();
  const caseIds = new Set<string>();
  for (const stage of manifest.stages) {
    if (stageKeys.has(stage.stage_key)) {
      throw new Error(`manifest 存在重复阶段: ${stage.stage_key}`);
    }
    for (const parentCaseId of stage.parent_case_ids) {
      if (!caseIds.has(parentCaseId)) {
        throw new Error(`阶段 ${stage.stage_key} 引用了尚未登记的父 Case: ${parentCaseId}`);
      }
    }
    stageKeys.add(stage.stage_key);
    caseIds.add(stage.case_id);
  }

  let previousHash: string | null = null;
  for (let index = 0; index < manifest.events.length; index++) {
    const event = manifest.events[index];
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== previousHash) {
      throw new Error(`manifest 事件链在 sequence=${event.sequence} 处断裂`);
    }
    const eventBase = {
      sequence: event.sequence,
      at: event.at,
      type: event.type,
      stage_key: event.stage_key,
      case_id: event.case_id,
      previous_event_sha256: event.previous_event_sha256,
    };
    const expectedHash = sha256(canonicalJson(eventBase));
    if (expectedHash !== event.event_sha256) {
      throw new Error(`manifest 事件哈希不匹配: sequence=${event.sequence}`);
    }
    previousHash = event.event_sha256;
  }
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

function existingStage(manifest: PipelineManifest, spec: StageSpec, runDir: string): StageRecord | null {
  const record = manifest.stages.find((item) => item.stage_key === spec.key);
  if (!record) return null;
  if (record.status !== 'delivered') {
    throw new Error(`阶段 ${spec.key} 已存在但未交付，拒绝静默覆盖`);
  }
  if (record.template !== spec.template) {
    throw new Error(`阶段 ${spec.key} 的模板已变化，请使用新 run_id`);
  }
  const intendedParents = spec.parents.map((parent) => parent.case_id);
  if (canonicalJson(record.parent_case_ids) !== canonicalJson(intendedParents)) {
    throw new Error(`阶段 ${spec.key} 的父 Case 关系已变化`);
  }
  const intendedInputHash = sha256(canonicalJson(spec.input));
  if (intendedInputHash !== record.input_sha256) {
    throw new Error(`阶段 ${spec.key} 的预期输入与已交付记录不一致`);
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
  return record;
}

function executeStage(
  manifest: PipelineManifest,
  spec: StageSpec,
  options: CliOptions,
): StageRecord {
  const resumed = existingStage(manifest, spec, options.runDir);
  if (resumed) {
    process.stdout.write(`[skip] ${spec.key} -> ${resumed.case_id}\n`);
    return resumed;
  }

  const inputPath = join(options.runDir, 'inputs', `${spec.key}.json`);
  const artifactPath = join(options.runDir, 'artifacts', `${spec.key}.md`);
  ensureInsideRunDir(options.runDir, inputPath);
  ensureInsideRunDir(options.runDir, artifactPath);

  const inputHash = sha256(canonicalJson(spec.input));
  const reusableAttempt = [...manifest.attempts].reverse().find(
    (attempt) =>
      attempt.stage_key === spec.key &&
      attempt.input_sha256 === inputHash &&
      ['running', 'interrupted', 'blocked'].includes(attempt.outcome),
  );

  let attempt: StageAttempt;
  let caseId: string;
  if (reusableAttempt) {
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
      attempt_id: `${spec.key}-a${manifest.attempts.filter((item) => item.stage_key === spec.key).length + 1}`,
      stage_key: spec.key,
      case_id: caseId,
      input_sha256: inputHash,
      outcome: 'running',
      started_at: now,
      updated_at: now,
      detail: null,
    };
    manifest.attempts.push(attempt);
    appendEvent(manifest, 'stage_started', spec.key, caseId);
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
    attempt.outcome = 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = error instanceof Error ? error.message : String(error);
    appendEvent(manifest, 'stage_interrupted', spec.key, caseId);
    saveManifest(options.runDir, manifest);
    throw error;
  }

  if (!result || result.case_id !== caseId) {
    attempt.outcome = 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = 'Forge 未返回有效结果';
    appendEvent(manifest, 'stage_interrupted', spec.key, caseId);
    saveManifest(options.runDir, manifest);
    throw new Error(`阶段 ${spec.key} 未返回有效结果`);
  }
  if (!result.success || result.status !== 'approved' || !result.final_artifact) {
    attempt.outcome = result.status === 'waiting_human'
      ? 'blocked'
      : ['failed', 'stopped'].includes(result.status)
        ? 'failed'
        : 'interrupted';
    attempt.updated_at = new Date().toISOString();
    attempt.detail = result.error ?? `Forge status=${result.status}`;
    appendEvent(
      manifest,
      attempt.outcome === 'blocked'
        ? 'stage_blocked'
        : attempt.outcome === 'failed'
          ? 'stage_failed'
          : 'stage_interrupted',
      spec.key,
      caseId,
    );
    saveManifest(options.runDir, manifest);
    throw new Error(
      `阶段 ${spec.key} 未通过 Forge 门禁: status=${result.status}, error=${result.error ?? 'none'}`,
    );
  }

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, result.final_artifact.content, 'utf8');
  const artifactHash = sha256(result.final_artifact.content);
  const record: StageRecord = {
    stage_key: spec.key,
    stage: spec.stage,
    chapter_id: spec.chapterId,
    template: spec.template,
    case_id: caseId,
    parent_case_ids: spec.parents.map((parent) => parent.case_id),
    status: 'delivered',
    input_path: relative(options.runDir, inputPath).replaceAll('\\', '/'),
    input_sha256: inputHash,
    artifact_path: relative(options.runDir, artifactPath).replaceAll('\\', '/'),
    artifact_sha256: artifactHash,
    artifact_type: result.final_artifact.type,
    artifact_version: result.final_artifact.version,
    completed_at: new Date().toISOString(),
  };

  attempt.outcome = 'delivered';
  attempt.updated_at = record.completed_at;
  attempt.detail = null;
  manifest.stages.push(record);
  appendEvent(manifest, 'stage_delivered', spec.key, caseId);
  saveManifest(options.runDir, manifest);
  process.stdout.write(`[done] ${spec.key} -> ${caseId}\n`);
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

function runPipeline(options: CliOptions): void {
  const configText = readFileSync(options.configPath, 'utf8');
  const config = loadConfig(options.configPath);
  const sourcePath = resolve(dirname(options.configPath), config.source_file);
  if (!existsSync(sourcePath)) throw new Error(`源文件不存在: ${sourcePath}`);
  const canonicalSourcePath = realpathSync(sourcePath);
  const sourceText = readFileSync(canonicalSourcePath, 'utf8');
  const manifest = loadOrCreateManifest(options.runDir, config, sha256(configText));

  const outline = executeStage(
    manifest,
    {
      key: 'outline',
      stage: 'outline',
      chapterId: null,
      template: 'zhihu-story-outline',
      title: `${config.title} / 大纲`,
      input: {
        source_text: sourceText,
        production_mode: config.mode,
        production_requirements: config.requirements,
      },
      parents: [],
    },
    options,
  );
  const blueprint = readArtifact(options.runDir, outline);

  let previousLedger: StageRecord | null = null;
  let previousDraft: StageRecord | null = null;
  const drafts: StageRecord[] = [];

  for (const chapter of config.chapters) {
    const chapterKey = chapter.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
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
        title: `${config.title} / ${chapter.label ?? chapter.id} / 执行包`,
        input: {
          chapter_id: chapter.id,
          chapter_label: chapter.label ?? chapter.id,
          blueprint_bundle: blueprint,
          previous_ledger: previousLedgerText,
          previous_chapter_ending: previousEnding,
        },
        parents: [outline, ...(previousLedger ? [previousLedger] : [])],
      },
      options,
    );

    const draft = executeStage(
      manifest,
      {
        key: `draft-${chapterKey}`,
        stage: 'chapter_draft',
        chapterId: chapter.id,
        template: 'zhihu-chapter-draft',
        title: `${config.title} / ${chapter.label ?? chapter.id} / 正文`,
        input: {
          chapter_id: chapter.id,
          chapter_label: chapter.label ?? chapter.id,
          chapter_packet: readArtifact(options.runDir, packet),
          repair_context: '首稿生产；如 Forge 审核产生 Issue，只按安全返修范围修改。',
        },
        parents: [packet],
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
        title: `${config.title} / ${chapter.label ?? chapter.id} / 状态账本`,
        input: {
          chapter_id: chapter.id,
          approved_chapter_draft: readArtifact(options.runDir, draft),
          previous_ledger: previousLedgerText,
          forge_audit_evidence: `上游正文 Case ${draft.case_id} 已通过 Forge 独立审核与交付门禁。`,
        },
        parents: [draft, ...(previousLedger ? [previousLedger] : [])],
      },
      options,
    );
    previousDraft = draft;
    previousLedger = ledger;
  }

  const finalStage = executeStage(
    manifest,
    {
      key: 'final',
      stage: 'final_review',
      chapterId: null,
      template: 'zhihu-story-final',
      title: `${config.title} / 全文终审`,
      input: {
        blueprint_bundle: blueprint,
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
    },
    options,
  );

  if (manifest.final_artifact_path !== finalStage.artifact_path) {
    manifest.final_artifact_path = finalStage.artifact_path;
    manifest.updated_at = new Date().toISOString();
    writeJson(join(options.runDir, 'manifest.json'), manifest);
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

try {
  runPipeline(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`[story-pipeline] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
