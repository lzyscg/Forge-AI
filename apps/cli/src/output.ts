/**
 * stdout 协议输出工具
 * 硬约束：stdout 只有第 1 行 + 末行，所有进度走 stderr + 文件 logger。
 */
import { writeSync } from 'node:fs';

export function writeStdoutLine(obj: unknown): void {
  writeSync(1, JSON.stringify(obj) + '\n');
}

export function writeFirstLine(caseId: string): void {
  writeSync(1, JSON.stringify({ case_id: caseId }) + '\n');
}

export function writeErrorLine(error: string, blockingCaseId?: string): void {
  const obj: Record<string, string> = { error };
  if (blockingCaseId) obj.blocking_case_id = blockingCaseId;
  writeSync(1, JSON.stringify(obj) + '\n');
}

export function writeResultLine(result: unknown): void {
  writeSync(1, JSON.stringify(result) + '\n');
}
