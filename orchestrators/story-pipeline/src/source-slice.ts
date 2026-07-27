import { createHash } from 'node:crypto';

export interface SourceSliceBoundary {
  id: string;
  content_start_offset: number;
  content_end_offset: number;
  segment_sha256: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sliceChapterSource(
  sourceText: string,
  boundary: SourceSliceBoundary,
): string {
  const { content_start_offset: start, content_end_offset: end } = boundary;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > sourceText.length
  ) {
    throw new Error(`${boundary.id} 的参考章节切片范围无效`);
  }

  const segment = sourceText.slice(start, end);
  if (sha256(segment) !== boundary.segment_sha256) {
    throw new Error(`${boundary.id} 的参考章节切片哈希不匹配`);
  }
  return segment;
}
