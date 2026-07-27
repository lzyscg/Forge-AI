import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeCaseSnapshot } from './forge-client.js';
import { sha256 } from './hash.js';
import type {
  PipelineManifestV21,
  StageAttemptV21,
  TemplateIdentity,
} from './manifest.js';
import {
  type ChapterBoundary,
  validateDraft,
  validateLedger,
  validatePacket,
} from './quality.js';
import {
  materializeDeliveredArtifact,
  type StagePlan,
} from './reconciliation.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const templateIdentity: TemplateIdentity = {
  algorithm: 'source-tree-sha256-v2',
  content_sha256: 'bundle-sha256',
  equivalence: 'verified',
};

function emptyManifest(): PipelineManifestV21 {
  return {
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'Story',
    mode: 'imitation',
    config_sha256: 'config',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundaries',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    attempts: [],
    stages: [],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
}

function approvedSnapshot(content: string, inputSha256: string): ForgeCaseSnapshot {
  return {
    case_id: 'case-draft',
    status: 'approved',
    success: true,
    case_identity: {
      db_instance_id: 'db-1',
      scenario_id: 'zhihu-chapter-draft',
      scenario_snapshot_sha256: 'scenario-sha256',
      input_payload_sha256: inputSha256,
      run_binding: {
        run_id: 'run-1',
        story_id: 'story-1',
        stage_key: 'draft-b001',
        chapter_id: 'B001',
      },
    },
    execution_identity: {
      template_bundle_sha256: templateIdentity.content_sha256,
      artifact_version_id: 'artifact-version-1',
    },
    final_artifact: {
      type: 'chapter_draft',
      version: 1,
      status: 'delivered',
      content,
      artifact_id: 'artifact-1',
      version_id: 'artifact-version-1',
    },
    turns: { count: 1, items: [] },
    issues: [],
    gate: {
      status: 'pass',
      artifact_version_id: 'artifact-version-1',
      checks: [],
    },
    diff: null,
    action_required: null,
    error: null,
  };
}

describe('external quality responsibility boundary', () => {
  it('materializes a Forge-approved draft without an H1 or prose-quality approval', () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'forge-quality-boundary-'));
    temporaryDirectories.push(runDirectory);
    const input = { chapter: 'B001' };
    const inputSha256 = sha256(JSON.stringify(input));
    const inputPath = 'inputs/draft-b001-a1.json';
    const inputAbsolute = join(runDirectory, inputPath);
    mkdirSync(dirname(inputAbsolute), { recursive: true });
    writeFileSync(inputAbsolute, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
    const plan: StagePlan = {
      run_id: 'run-1',
      story_id: 'story-1',
      stage_key: 'draft-b001',
      stage: 'chapter_draft',
      chapter_id: 'B001',
      expected_artifact_type: 'chapter_draft',
      expected_scenario_snapshot_sha256: 'scenario-sha256',
      input_sha256: inputSha256,
      parent_record_ids: [],
      template_identity: templateIdentity,
    };
    const attempt: StageAttemptV21 = {
      attempt_id: 'draft-b001-a1',
      stage_key: plan.stage_key,
      stage: plan.stage,
      chapter_id: plan.chapter_id,
      template: 'zhihu-chapter-draft',
      expected_artifact_type: plan.expected_artifact_type,
      expected_scenario_snapshot_sha256:
        plan.expected_scenario_snapshot_sha256,
      case_id: 'case-draft',
      input_sha256: plan.input_sha256,
      parent_record_ids: [],
      template_identity: templateIdentity,
      runner_token_sha256: null,
      runner_credential_path: null,
      outcome: 'interrupted',
      input_path: inputPath,
      raw_artifact_path: null,
      validation_report_path: null,
      started_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
      detail: null,
    };
    const manifest = emptyManifest();
    manifest.attempts.push(attempt);
    const draft = `她照抄这段连续很长的参考原文内容，还用了"ASCII 对白"，站了三天。

尚不可知的控制措辞也留在正文里。`;

    const record = materializeDeliveredArtifact({
      run_dir: runDirectory,
      manifest,
      plan,
      attempt,
      snapshot: approvedSnapshot(draft, inputSha256),
      validate: (content) => validateDraft(
        plan.stage_key,
        content,
        '章节包没有授权这些对白或数量。',
        { length_budget: { lower: 1, upper: 2 } },
        '她照抄这段连续很长的参考原文内容',
      ),
    });

    expect(record.status).toBe('delivered');
    const report = JSON.parse(readFileSync(
      join(runDirectory, record.validation_report_path),
      'utf8',
    )) as { valid: boolean; checks: unknown[]; metrics: Record<string, unknown> };
    expect(report.valid).toBe(true);
    expect(report.checks).toEqual([]);
    expect(report.metrics).toMatchObject({
      ascii_quote_count: 2,
      unauthorized_claims: ['三天'],
    });
  });

  it('keeps packet future-language and source-overlap findings observational', () => {
    const source = '这是参考原文中一段绝对不能逐字复制的连续长句。';
    const boundary: ChapterBoundary = {
      id: 'B001',
      sequence: 1,
      display: '01',
      source_label: '01',
      content_start_offset: 0,
      content_end_offset: source.length,
      boundary_signature: 'sig-1',
      segment_sha256: sha256(source),
      start_anchor: '开始',
      end_anchor: '结束',
      next_forbidden_action: null,
    };
    const packet = `# B001 执行包

## 输出与章首
- 标题形式与目标汉字数：10–200 汉字

## 本章唯一任务
- 任务：处理眼前事件。

## 场景功能单元
### U1：现场
- 变化：未知 → 看见
- 写作链：进入 → 看见
- 直接写出：动作
- 留白：原因
- 本单元正向有限清单：人物
- 授权容量载体：动作 1
- 保真：H-01
- 展开：标准

## 声音与正文边界
- 呼吸：短段

## 章尾状态
- 当前知识停点：尚不可知。
- 摘录：${source}`;

    const result = validatePacket('packet-b001', packet, boundary, source);

    expect(result.report.valid).toBe(true);
    expect(result.report.metrics).toMatchObject({
      source_overlap_count: expect.any(Number),
    });
    expect(Number(result.report.metrics.source_overlap_count)).toBeGreaterThan(0);
  });

  it('keeps ledger future-language and quote-evidence findings observational', () => {
    const ledger = `# B001 状态账本

## 时空与在场
- F-B001-1：她说“输入中不存在的话”。
## 普通已成立事实
- F-B001-2：尚不可知。
## 知识状态
- O-B001-1：我看见她。
## 当前活跃状态
- A-B001-1：门开着。
## 跨章未完成义务
- O-B001-2：等待回应。
## 待回收信号
- S-B001-1：旧照片。
## 本章闭合项
- F-B001-3：敲门结束。
## 下一章承接
- A-B001-2：我仍在门口。`;

    const result = validateLedger(
      'ledger-b001',
      ledger,
      'B001',
      '正文没有那句引语。',
      '没有上一账本。',
    );

    expect(result.report.valid).toBe(true);
    expect(result.report.metrics).toMatchObject({
      unauthorized_quotes: ['输入中不存在的话'],
    });
  });
});
