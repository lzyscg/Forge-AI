import { describe, expect, it } from 'vitest';
import {
  type ChapterBoundaryMap,
  sha256,
  validateDraft,
  validateFinal,
  validateLedger,
  validateOutline,
  validatePacket,
} from './quality.js';

const boundaries: ChapterBoundaryMap = {
  schema_version: '1.0',
  operation: 'chapter-boundary-map',
  valid: true,
  source: {
    path: 'source.txt',
    file_name: 'source.txt',
    sha256: 'source-hash',
    line_count: 20,
    character_count: 100,
  },
  chapters: [
    {
      id: 'B000',
      sequence: 0,
      display: '冷开场',
      source_label: null,
      content_start_offset: 0,
      content_end_offset: 10,
      boundary_signature: 'sig-0',
      segment_sha256: 'seg-0',
      start_anchor: '起点',
      end_anchor: '冷开场终点',
      next_forbidden_action: '第一章起点',
    },
    {
      id: 'B001',
      sequence: 1,
      display: '01',
      source_label: '01',
      content_start_offset: 10,
      content_end_offset: 20,
      boundary_signature: 'sig-1',
      segment_sha256: 'seg-1',
      start_anchor: '第一章起点',
      end_anchor: '第一章终点',
      next_forbidden_action: null,
    },
  ],
};

const globalHeadings = [
  '提取基准与章节边界',
  '一句话主线',
  '叙述契约',
  '主题与价值冲突',
  '叙事指纹',
  '原文事实冲突与处理决定',
  '源文功能覆盖总表',
  '全局信息揭示表',
  '全局生命周期调度',
  '分章执行卡',
].map((heading) => `## ${heading}`).join('\n\n');

const endingHeadings = [
  '主要人物与关系状态',
  '伏笔与回收',
  '复现门禁报告',
].map((heading) => `## ${heading}`).join('\n\n');

function chapterCard(sequence: string, label: string, id: string): string {
  return `## ${sequence}｜${label}（${id}）

### 章节目的与退出状态
- P0：[FACT @L1-L2] 事件发生。

### 事实与知识边界
- 边界：只到当前结果。

### 因果与篇幅
- 因果链：触发到结果。

### 情绪执行与读者压力
- 人物情绪链：平静到紧张。

### 声音、判断与对白
- 语言呼吸：短段。

### 场景连续性与生命周期
- 场景连续性：连续。

### 章末钩子
- 钩子与下章驱动：悬置。`;
}

const validOutline = `# 测试大纲

${globalHeadings}

${chapterCard('00', '冷开场', 'B000')}

${chapterCard('01', '原文 01', 'B001')}

${endingHeadings}`;

const validPacket = `# B001 正文执行包

## 输出与章首
- 标题形式与目标汉字数：10–200 汉字

## 本章唯一任务
- 主要阅读动力：查明眼前的异常。

## 场景功能单元

### U1：门口相遇
- 变化：独处 → 看见来人
- 写作链：敲门 → 我开门 → 对方停在门外
- 直接写出：她说“我回来了。”
- 留白：我只确认她已经出现。
- 本单元正向有限清单：人物：我、姐姐；在场对象：门；可用事实：她离家多年。
- 授权容量载体：对白轮次 1；动作反馈闭环 1；认知或感知转折 1；事后反应 0
- 保真：H-01
- 展开：标准

## 声音与正文边界
- 句式、段落与留白呼吸：短段。

## 章尾状态
- 当前知识停点：我只确认她站在门外。`;

describe('story pipeline mechanical quality gates', () => {
  it('accepts a complete boundary-aligned outline', () => {
    const result = validateOutline('outline', validOutline, boundaries);
    expect(result.report.valid).toBe(true);
    expect((result.sidecar.chapters as unknown[]).length).toBe(2);
  });

  it('rejects an abbreviated outline chapter contract', () => {
    const broken = validOutline.replace('### 场景连续性与生命周期', '### 被错误省略');
    const result = validateOutline('outline', broken, boundaries);
    expect(result.report.valid).toBe(false);
    expect(result.report.errors.join('\n')).toContain('outline_chapter_contract');
  });

  it('leaves packet content judgments to the Forge Case gate', () => {
    const source = '这是参考原文中一段绝对不能逐字复制的连续长句。';
    const broken = `${validPacket}\n- 当前知识停点：尚不可知系统存在。\n- 摘录：这是参考原文中一段绝对不能逐字复制的连续长句。`;
    const result = validatePacket('packet-b001', broken, boundaries.chapters[1], source);
    expect(result.report.valid).toBe(true);
    expect(result.report.checks.map((check) => check.name)).not.toContain(
      'packet_future_isolation',
    );
    expect(result.report.checks.map((check) => check.name)).not.toContain(
      'packet_source_overlap',
    );
    expect(Number(result.report.metrics.source_overlap_count)).toBeGreaterThan(0);
  });

  it('leaves draft prose quality judgments to the Forge Case gate', () => {
    const packetResult = validatePacket(
      'packet-b001',
      validPacket,
      boundaries.chapters[1],
      '完全不同的参考文字',
    );
    expect(packetResult.report.valid).toBe(true);
    const draft = `# 第一章

她在门外站了三天，才说：“爸爸让我来找你。”`;
    const result = validateDraft(
      'draft-b001',
      draft,
      packetResult.canonicalContent,
      packetResult.sidecar,
      '完全不同的参考文字',
    );
    expect(result.report.valid).toBe(true);
    expect(result.report.checks).toEqual([]);
    expect(result.sidecar).toMatchObject({
      artifact_kind: 'chapter_draft',
      packet_sha256: sha256(packetResult.canonicalContent),
    });
  });

  it('leaves ledger prose evidence judgments to the Forge Case gate', () => {
    const ledger = `# B001 状态账本

## 时空与在场
- F-B001-1：她说“原输入中没有的话”。

## 普通已成立事实
- F-B001-2：尚不可知的事实。

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
    expect(result.report.checks.map((check) => check.name)).not.toContain(
      'ledger_quote_evidence',
    );
    expect(result.report.checks.map((check) => check.name)).not.toContain(
      'ledger_future_isolation',
    );
  });

  it('requires final assembly to be byte-equivalent after newline normalization', () => {
    const good = validateFinal('final', '# 第一章\n\n正文', '# 第一章\n\n正文', ['B001']);
    const bad = validateFinal('final', '# 试产说明\n\n# 第一章\n\n正文', '# 第一章\n\n正文', ['B001']);
    expect(good.report.valid).toBe(true);
    expect(bad.report.valid).toBe(false);
  });
});
