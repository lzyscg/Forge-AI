import { describe, it, expect } from 'vitest';
import {
  parseAnchorToLines,
  parseAnchorsToLineSet,
  validateScope,
  computeChangedLines,
} from './scope-validator.js';

describe('行级越界校验', () => {
  describe('parseAnchorToLines', () => {
    it('解析单行 anchor', () => {
      expect(parseAnchorToLines('line:4')).toEqual([4]);
    });

    it('解析范围 anchor', () => {
      expect(parseAnchorToLines('line:1-3')).toEqual([1, 2, 3]);
    });

    it('解析单行（起止相同）', () => {
      expect(parseAnchorToLines('line:5-5')).toEqual([5]);
    });

    it('无效格式返回空数组', () => {
      expect(parseAnchorToLines('paragraph:2')).toEqual([]);
      expect(parseAnchorToLines('')).toEqual([]);
    });
  });

  describe('parseAnchorsToLineSet', () => {
    it('解析多个 anchors', () => {
      const set = parseAnchorsToLineSet(['line:1-3', 'line:5']);
      expect(set.has(1)).toBe(true);
      expect(set.has(2)).toBe(true);
      expect(set.has(3)).toBe(true);
      expect(set.has(4)).toBe(false);
      expect(set.has(5)).toBe(true);
    });
  });

  describe('validateScope', () => {
    it('只改了 editable 行 → 通过', () => {
      const result = validateScope({
        editableAnchors: ['line:4'],
        frozenAnchors: ['line:1-3', 'line:5-16'],
        changedLines: [4],
      });
      expect(result.valid).toBe(true);
      expect(result.violatedLines).toHaveLength(0);
    });

    it('改了 frozen 行 → 越界', () => {
      const result = validateScope({
        editableAnchors: ['line:4'],
        frozenAnchors: ['line:1-3', 'line:5-16'],
        changedLines: [4, 8],
      });
      expect(result.valid).toBe(false);
      expect(result.violatedLines).toContain(8);
    });

    it('改了 editable 范围外的行（不在 frozen 中）→ 越界', () => {
      const result = validateScope({
        editableAnchors: ['line:4'],
        frozenAnchors: [],
        changedLines: [4, 10],
      });
      expect(result.valid).toBe(false);
      expect(result.violatedLines).toContain(10);
    });

    it('多行 editable → 改这些行通过', () => {
      const result = validateScope({
        editableAnchors: ['line:4', 'line:7-8'],
        frozenAnchors: ['line:1-3', 'line:5-6', 'line:9-16'],
        changedLines: [4, 7, 8],
      });
      expect(result.valid).toBe(true);
    });

    it('没有改动 → 通过', () => {
      const result = validateScope({
        editableAnchors: ['line:4'],
        frozenAnchors: ['line:1-3', 'line:5-16'],
        changedLines: [],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('computeChangedLines', () => {
    it('相同内容无变化', () => {
      const content = '第一行\n第二行\n第三行';
      expect(computeChangedLines(content, content)).toEqual([]);
    });

    it('修改中间一行', () => {
      const old = '第一行\n第二行\n第三行';
      const updated = '第一行\n修改后\n第三行';
      expect(computeChangedLines(old, updated)).toEqual([2]);
    });

    it('修改多行', () => {
      const old = 'A\nB\nC\nD';
      const updated = 'A\nX\nC\nY';
      expect(computeChangedLines(old, updated)).toEqual([2, 4]);
    });

    it('新增行', () => {
      const old = 'A\nB';
      const updated = 'A\nB\nC';
      expect(computeChangedLines(old, updated)).toEqual([3]);
    });

    it('删除行', () => {
      const old = 'A\nB\nC';
      const updated = 'A\nB';
      expect(computeChangedLines(old, updated)).toEqual([3]);
    });
  });
});
