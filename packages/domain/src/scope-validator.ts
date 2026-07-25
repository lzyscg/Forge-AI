/**
 * 行级越界校验（支柱三：受控返修）
 * 返修时明确"哪些部分可以改（editable）、哪些部分冻结（frozen）"。
 * 系统在返修后自动比对改动，越界修改的版本不允许进入复审。
 */

export interface LineDiff {
  lineNumber: number;
  type: 'added' | 'removed' | 'modified';
}

export interface ScopeValidationInput {
  editableAnchors: string[]; // e.g. ["line:4"]
  frozenAnchors: string[]; // e.g. ["line:1-3", "line:5-16"]
  changedLines: number[]; // 实际发生变化的行号列表
}

export interface ScopeValidationOutput {
  valid: boolean;
  violatedLines: number[];
  detail: string;
}

/**
 * 解析 anchor 字符串为行号集合
 * 支持格式："line:4"（单行）、"line:1-3"（范围）
 */
export function parseAnchorToLines(anchor: string): number[] {
  const match = anchor.match(/^line:(\d+)(?:-(\d+))?$/);
  if (!match) return [];

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;

  const lines: number[] = [];
  for (let i = start; i <= end; i++) {
    lines.push(i);
  }
  return lines;
}

/**
 * 解析多个 anchors 为行号集合
 */
export function parseAnchorsToLineSet(anchors: string[]): Set<number> {
  const lineSet = new Set<number>();
  for (const anchor of anchors) {
    for (const line of parseAnchorToLines(anchor)) {
      lineSet.add(line);
    }
  }
  return lineSet;
}

/**
 * 校验返修是否越界
 * 规则：所有实际变化的行必须在 editable 范围内，不能触碰 frozen 范围
 */
export function validateScope(input: ScopeValidationInput): ScopeValidationOutput {
  const editableLines = parseAnchorsToLineSet(input.editableAnchors);
  const frozenLines = parseAnchorsToLineSet(input.frozenAnchors);

  const violatedLines: number[] = [];

  for (const line of input.changedLines) {
    // 如果行在 frozen 范围内，越界
    if (frozenLines.has(line)) {
      violatedLines.push(line);
    }
    // 如果行不在 editable 范围内（且 frozen 为空时），也越界
    else if (editableLines.size > 0 && !editableLines.has(line)) {
      violatedLines.push(line);
    }
  }

  const valid = violatedLines.length === 0;

  return {
    valid,
    violatedLines,
    detail: valid
      ? '所有改动均在 editable 范围内，校验通过'
      : `越界修改了以下行: ${violatedLines.join(', ')}，这些行在 frozen 范围内或不在 editable 范围内`,
  };
}

/**
 * 计算两段文本的行级变化行号
 * 简单实现：逐行对比，找出不同的行号
 */
export function computeChangedLines(oldContent: string, newContent: string): number[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const changedLines: number[] = [];

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine !== newLine) {
      changedLines.push(i + 1); // 1-based line number
    }
  }

  return changedLines;
}
