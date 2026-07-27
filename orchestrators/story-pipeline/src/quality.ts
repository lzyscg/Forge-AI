import { sha256 } from './hash.js';

export { sha256 } from './hash.js';

export interface ChapterBoundary {
  id: string;
  sequence: number;
  display: string;
  source_label: string | null;
  content_start_offset: number;
  content_end_offset: number;
  boundary_signature: string;
  segment_sha256: string;
  start_anchor: string;
  end_anchor: string;
  next_forbidden_action: string | null;
}

export interface ChapterBoundaryMap {
  schema_version: string;
  operation: 'chapter-boundary-map';
  valid: boolean;
  source: {
    path: string;
    file_name: string;
    sha256: string;
    line_count: number;
    character_count: number;
  };
  chapters: ChapterBoundary[];
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface QualityReport {
  schema_version: '1.0';
  stage_key: string;
  artifact_kind: 'outline' | 'packet' | 'draft' | 'ledger' | 'final';
  artifact_sha256: string;
  valid: boolean;
  checks: QualityCheck[];
  errors: string[];
  warnings: string[];
  metrics: Record<string, number | string | boolean | string[]>;
}

export interface ValidationResult {
  canonicalContent: string;
  report: QualityReport;
  sidecar: Record<string, unknown>;
}

const OUTLINE_GLOBAL_HEADINGS = [
  '## 提取基准与章节边界',
  '## 一句话主线',
  '## 叙述契约',
  '## 主题与价值冲突',
  '## 叙事指纹',
  '## 原文事实冲突与处理决定',
  '## 源文功能覆盖总表',
  '## 全局信息揭示表',
  '## 全局生命周期调度',
  '## 分章执行卡',
  '## 主要人物与关系状态',
  '## 伏笔与回收',
  '## 复现门禁报告',
] as const;

const OUTLINE_CHAPTER_SECTIONS = [
  '章节目的与退出状态',
  '事实与知识边界',
  '因果与篇幅',
  '情绪执行与读者压力',
  '声音、判断与对白',
  '场景连续性与生命周期',
  '章末钩子',
] as const;

const PACKET_HEADINGS = [
  '## 输出与章首',
  '## 本章唯一任务',
  '## 场景功能单元',
  '## 声音与正文边界',
  '## 章尾状态',
] as const;

const LEDGER_HEADINGS = [
  '## 时空与在场',
  '## 普通已成立事实',
  '## 知识状态',
  '## 当前活跃状态',
  '## 跨章未完成义务',
  '## 待回收信号',
  '## 本章闭合项',
  '## 下一章承接',
] as const;

const CONTROL_LEAK_PATTERNS = [
  /尚不可知/u,
  /不可推断/u,
  /未来答案/u,
  /后文(?:揭示|答案|真相)/u,
  /后续(?:揭示|答案|真相)/u,
  /下一章(?:揭示|答案|真相)/u,
  /禁止(?:写|出现|提及|泄露)/u,
  /不得(?:写|出现|提及|泄露)/u,
] as const;

const QUANTIFIED_CLAIM = /(?:\d+|[零一二三四五六七八九十百千万两]+)(?:年|月|日|天|小时|分钟|分|科|次|个|名|场|份|条|轮|字)/gu;
const HIGH_RISK_CLAIMS = ['全省最高', '全国最高', '唯一一个', '所有人都', '全部人都'] as const;

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function cjkStream(value: string): string {
  return (value.match(/[\u3400-\u9fff]/gu) ?? []).join('');
}

function makeCheck(name: string, passed: boolean, detail: string): QualityCheck {
  return { name, passed, detail };
}

function finishReport(
  stageKey: string,
  artifactKind: QualityReport['artifact_kind'],
  content: string,
  checks: QualityCheck[],
  warnings: string[] = [],
  metrics: QualityReport['metrics'] = {},
): QualityReport {
  const errors = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);
  return {
    schema_version: '1.0',
    stage_key: stageKey,
    artifact_kind: artifactKind,
    artifact_sha256: sha256(content),
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
    metrics,
  };
}

function markdownSections(content: string, level: number): string[] {
  const prefix = '#'.repeat(level);
  const pattern = new RegExp(`^${prefix} ([^\\r\\n]+)\\s*$`, 'gmu');
  return [...content.matchAll(pattern)].map((match) => match[1].trim());
}

function fieldValue(block: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^- (?:\\*\\*)?${escaped}(?:\\*\\*)?[：:]\\s*(.+)$`, 'mu'));
  return match?.[1]?.trim() ?? null;
}

function chapterBlocks(content: string): Array<{
  id: string;
  sequenceLabel: string;
  displayLabel: string;
  body: string;
}> {
  const pattern = /^## (?<seq>00|0[1-9]|[1-9]\d)｜(?<label>.+?)（(?<id>B\d{3})）\s*$/gmu;
  const matches = [...content.matchAll(pattern)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1]?.index;
    const fallback = content.indexOf('## 主要人物与关系状态', start);
    const end = next ?? (fallback >= 0 ? fallback : content.length);
    return {
      id: match.groups!.id,
      sequenceLabel: match.groups!.seq,
      displayLabel: match.groups!.label,
      body: content.slice(start, end),
    };
  });
}

export function findSharedCjkSequences(source: string, output: string, width = 12): string[] {
  const sourceCjk = cjkStream(source);
  const outputCjk = cjkStream(output);
  const matches = new Set<string>();
  for (let index = 0; index <= sourceCjk.length - width; index++) {
    const candidate = sourceCjk.slice(index, index + width);
    if (outputCjk.includes(candidate)) matches.add(candidate);
  }
  return [...matches];
}

function futureBoundaryIds(content: string, current: ChapterBoundary): string[] {
  const matches = [...content.matchAll(/\bB(?<number>\d{3})\b/gu)]
    .map((match) => `B${match.groups!.number}`);
  return [...new Set(matches.filter((id) => Number(id.slice(1)) > Number(current.id.slice(1))))];
}

function controlLeaks(content: string): string[] {
  return CONTROL_LEAK_PATTERNS
    .filter((pattern) => pattern.test(content))
    .map((pattern) => pattern.source);
}

function quotedSpans(content: string): string[] {
  const spans: string[] = [];
  for (const match of content.matchAll(/[“"]([^”"\n]+)[”"]/gu)) {
    const value = match[1].trim();
    if (value) spans.push(value);
  }
  return spans;
}

function quantifiedClaims(content: string): string[] {
  const claims = new Set(content.match(QUANTIFIED_CLAIM) ?? []);
  for (const phrase of HIGH_RISK_CLAIMS) {
    if (content.includes(phrase)) claims.add(phrase);
  }
  return [...claims];
}

export function validateOutline(
  stageKey: string,
  rawContent: string,
  boundaries: ChapterBoundaryMap,
): ValidationResult {
  const content = normalizeNewlines(rawContent).trim();
  const checks: QualityCheck[] = [];
  const missingGlobal = OUTLINE_GLOBAL_HEADINGS.filter((heading) => !content.includes(heading));
  checks.push(makeCheck(
    'outline_global_headings',
    missingGlobal.length === 0,
    missingGlobal.length === 0 ? '13 个全局标题齐全' : `缺少：${missingGlobal.join('、')}`,
  ));

  const blocks = chapterBlocks(content);
  const actualIds = blocks.map((block) => block.id);
  const expectedIds = boundaries.chapters.map((chapter) => chapter.id);
  checks.push(makeCheck(
    'outline_boundary_ids',
    JSON.stringify(actualIds) === JSON.stringify(expectedIds),
    `期望 ${expectedIds.join(',')}；实际 ${actualIds.join(',') || '(空)'}`,
  ));

  const incomplete: string[] = [];
  for (const boundary of boundaries.chapters) {
    const block = blocks.find((item) => item.id === boundary.id);
    if (!block) continue;
    const sections = markdownSections(block.body, 3);
    const exactSections = sections.filter((section) =>
      OUTLINE_CHAPTER_SECTIONS.includes(section as typeof OUTLINE_CHAPTER_SECTIONS[number]));
    if (JSON.stringify(exactSections) !== JSON.stringify(OUTLINE_CHAPTER_SECTIONS)) {
      incomplete.push(`${boundary.id}:七段结构=${exactSections.join('/')}`);
      continue;
    }
    if (!/\[(?:FACT|OBS)\s+@L\d+/u.test(block.body)) {
      incomplete.push(`${boundary.id}:P0 缺 FACT/OBS 行号证据`);
    }
  }
  checks.push(makeCheck(
    'outline_chapter_contract',
    incomplete.length === 0,
    incomplete.length === 0 ? '所有章节均具备七段合同与来源证据' : incomplete.join('；'),
  ));

  const duplicateIds = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
  checks.push(makeCheck(
    'outline_unique_ids',
    duplicateIds.length === 0,
    duplicateIds.length === 0 ? '章节 ID 唯一' : `重复 ID：${[...new Set(duplicateIds)].join(',')}`,
  ));

  const report = finishReport(stageKey, 'outline', content, checks, [], {
    expected_chapters: expectedIds.length,
    parsed_chapters: actualIds.length,
    chapter_ids: actualIds,
  });
  return {
    canonicalContent: `${content}\n`,
    report,
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'outline',
      artifact_sha256: report.artifact_sha256,
      source_sha256: boundaries.source.sha256,
      chapters: blocks.map((block) => ({
        id: block.id,
        sequence_label: block.sequenceLabel,
        display_label: block.displayLabel,
        section_titles: markdownSections(block.body, 3),
        content_sha256: sha256(block.body),
      })),
    },
  };
}

export function validatePacket(
  stageKey: string,
  rawContent: string,
  boundary: ChapterBoundary,
  sourceText: string,
): ValidationResult {
  const content = normalizeNewlines(rawContent).trim();
  const checks: QualityCheck[] = [];
  const headings = markdownSections(content, 2);
  const missing = PACKET_HEADINGS.filter((heading) => !content.includes(heading));
  checks.push(makeCheck(
    'packet_required_headings',
    missing.length === 0,
    missing.length === 0 ? '五个必要区块齐全' : `缺少：${missing.join('、')}`,
  ));

  const rangeMatches = [...content.matchAll(/(?<!\d)(\d+)\s*[–—-]\s*(\d+)\s*汉字/gu)];
  const lower = Number(rangeMatches[0]?.[1] ?? 0);
  const upper = Number(rangeMatches[0]?.[2] ?? 0);
  checks.push(makeCheck(
    'packet_length_budget',
    rangeMatches.length === 1 && lower > 0 && upper >= lower,
    rangeMatches.length === 1 ? `范围 ${lower}–${upper}` : `篇幅范围出现 ${rangeMatches.length} 次`,
  ));

  const unitMatches = [...content.matchAll(/^### (?<id>U\d+)[：:](?<title>[^\r\n]+)$/gmu)];
  const unitErrors: string[] = [];
  for (let index = 0; index < unitMatches.length; index++) {
    const match = unitMatches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = unitMatches[index + 1]?.index ?? content.indexOf('## 声音与正文边界', start);
    const block = content.slice(start, end >= 0 ? end : content.length);
    const required = ['变化', '写作链', '直接写出', '留白', '本单元正向有限清单', '授权容量载体', '保真', '展开'];
    const absent = required.filter((field) => !fieldValue(block, field));
    if (absent.length > 0) unitErrors.push(`${match.groups!.id} 缺少 ${absent.join('/')}`);
  }
  checks.push(makeCheck(
    'packet_scene_units',
    unitMatches.length > 0 && unitErrors.length === 0,
    unitMatches.length === 0 ? '没有场景功能单元' : (unitErrors.join('；') || `${unitMatches.length} 个单元结构完整`),
  ));

  const futureIds = futureBoundaryIds(content, boundary);
  const leaks = controlLeaks(content);
  const overlaps = findSharedCjkSequences(sourceText, content, 12);

  const boundaryMentioned = content.includes(boundary.id);
  checks.push(makeCheck(
    'packet_chapter_identity',
    boundaryMentioned,
    boundaryMentioned ? `已绑定 ${boundary.id}` : `正文包未出现当前章节 ID ${boundary.id}`,
  ));

  const report = finishReport(stageKey, 'packet', content, checks, [], {
    h2_count: headings.length,
    unit_count: unitMatches.length,
    lower,
    upper,
    future_ids: futureIds,
    source_overlap_count: overlaps.length,
  });
  return {
    canonicalContent: `${content}\n`,
    report,
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'chapter_packet',
      artifact_sha256: report.artifact_sha256,
      chapter: {
        id: boundary.id,
        sequence: boundary.sequence,
        display: boundary.display,
        boundary_signature: boundary.boundary_signature,
      },
      length_budget: { lower, upper },
      units: unitMatches.map((match) => ({
        id: match.groups!.id,
        title: match.groups!.title.trim(),
      })),
      future_ids: futureIds,
      control_leaks: leaks,
      source_overlaps: overlaps,
    },
  };
}

export function validateDraft(
  stageKey: string,
  rawContent: string,
  packetContent: string,
  packetSidecar: Record<string, unknown>,
  sourceText: string,
): ValidationResult {
  const content = normalizeNewlines(rawContent).trim();
  const checks: QualityCheck[] = [];
  const h1 = markdownSections(content, 1);

  const lengthBudget = packetSidecar.length_budget as { lower?: number; upper?: number } | undefined;
  const lower = Number(lengthBudget?.lower ?? 0);
  const upper = Number(lengthBudget?.upper ?? 0);
  const cjkCount = cjkStream(content).length;
  const asciiQuotes = (content.match(/"/gu) ?? []).length;
  const overlaps = findSharedCjkSequences(sourceText, content, 12);
  const packetCjk = cjkStream(packetContent);
  const unauthorizedQuotes = quotedSpans(content).filter((quote) => !packetCjk.includes(cjkStream(quote)));
  const unauthorizedClaims = quantifiedClaims(content)
    .filter((claim) => !packetContent.includes(claim));
  const leaks = controlLeaks(content);

  const paragraphs = content.split(/\n\s*\n/gu).filter((paragraph) => paragraph.trim());
  const report = finishReport(stageKey, 'draft', content, checks, [], {
    cjk_count: cjkCount,
    h1_count: h1.length,
    paragraph_count: paragraphs.length,
    declared_length_lower: lower,
    declared_length_upper: upper,
    ascii_quote_count: asciiQuotes,
    source_overlap_count: overlaps.length,
    unauthorized_quotes: unauthorizedQuotes,
    unauthorized_claims: unauthorizedClaims,
    control_language_patterns: leaks,
  });
  return {
    canonicalContent: `${content}\n`,
    report,
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'chapter_draft',
      artifact_sha256: report.artifact_sha256,
      packet_sha256: sha256(packetContent),
      cjk_count: cjkCount,
      paragraphs: paragraphs.map((paragraph, index) => ({
        index: index + 1,
        sha256: sha256(paragraph),
      })),
      quoted_spans: quotedSpans(content),
      quantified_claims: quantifiedClaims(content),
      source_overlaps: overlaps,
    },
  };
}

export function validateLedger(
  stageKey: string,
  rawContent: string,
  chapterId: string,
  draftContent: string,
  previousLedger: string,
): ValidationResult {
  const content = normalizeNewlines(rawContent).trim();
  const checks: QualityCheck[] = [];
  const missing = LEDGER_HEADINGS.filter((heading) => !content.includes(heading));
  checks.push(makeCheck(
    'ledger_required_headings',
    missing.length === 0,
    missing.length === 0 ? '八个账本区块齐全' : `缺少：${missing.join('、')}`,
  ));

  const declaredIds = [...content.matchAll(/^- (?<id>[FAOS]-B\d{3}-\d+)[：:]/gmu)]
    .map((match) => match.groups!.id);
  const wrongChapterIds = declaredIds.filter((id) => !id.includes(`-${chapterId}-`));
  const duplicates = declaredIds.filter((id, index) => declaredIds.indexOf(id) !== index);
  checks.push(makeCheck(
    'ledger_stable_ids',
    declaredIds.length > 0 && wrongChapterIds.length === 0 && duplicates.length === 0,
    declaredIds.length === 0
      ? '没有稳定 ID'
      : `错误章节 ID=${wrongChapterIds.join(',') || '(无)'}；重复=${duplicates.join(',') || '(无)'}`,
  ));

  const leaks = controlLeaks(content);
  const evidenceCorpus = `${draftContent}\n${previousLedger}`;
  const unauthorizedQuotes = quotedSpans(content)
    .filter((quote) => !cjkStream(evidenceCorpus).includes(cjkStream(quote)));

  const report = finishReport(stageKey, 'ledger', content, checks, [], {
    stable_id_count: declaredIds.length,
    stable_ids: declaredIds,
    unauthorized_quotes: unauthorizedQuotes,
    control_language_patterns: leaks,
  });
  return {
    canonicalContent: `${content}\n`,
    report,
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'state_ledger',
      artifact_sha256: report.artifact_sha256,
      chapter_id: chapterId,
      draft_sha256: sha256(draftContent),
      previous_ledger_sha256: sha256(previousLedger),
      stable_ids: declaredIds,
    },
  };
}

export function validateFinal(
  stageKey: string,
  rawContent: string,
  expectedContent: string,
  chapterIds: string[],
): ValidationResult {
  const content = normalizeNewlines(rawContent).trim();
  const expected = normalizeNewlines(expectedContent).trim();
  const checks = [
    makeCheck(
      'final_exact_assembly',
      content === expected,
      content === expected ? '终稿与冻结章节逐字一致' : '终稿增加、删除或改写了冻结章节内容',
    ),
  ];
  const report = finishReport(stageKey, 'final', content, checks, [], {
    expected_sha256: sha256(expected),
    chapter_ids: chapterIds,
  });
  return {
    canonicalContent: `${content}\n`,
    report,
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'final_manuscript',
      artifact_sha256: report.artifact_sha256,
      expected_sha256: sha256(expected),
      chapter_ids: chapterIds,
    },
  };
}
