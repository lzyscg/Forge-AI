import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sliceChapterSource } from './source-slice.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('sliceChapterSource', () => {
  it('passes only the mechanically bounded current chapter into its Case', () => {
    const source = '冷开场正文第一章正文第二章正文';
    const expected = '第一章正文';

    expect(sliceChapterSource(source, {
      id: 'B001',
      content_start_offset: 5,
      content_end_offset: 10,
      segment_sha256: digest(expected),
    })).toBe(expected);
  });

  it('rejects a boundary whose source segment hash no longer matches', () => {
    expect(() => sliceChapterSource('已被修改的原文', {
      id: 'B001',
      content_start_offset: 0,
      content_end_offset: 6,
      segment_sha256: digest('另一段原文'),
    })).toThrow('B001 的参考章节切片哈希不匹配');
  });
});
