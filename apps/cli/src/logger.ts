/**
 * 文件 Logger + stderr Logger
 * 所有进度/日志走 stderr + 文件，stdout 保持纯净。
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@forge-ai/application';

export function createFileLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: 'a' });
  const ts = () => new Date().toISOString();
  return {
    info: (msg) => { stream.write(`[${ts()}] INFO ${msg}\n`); process.stderr.write(`[INFO] ${msg}\n`); },
    error: (msg) => { stream.write(`[${ts()}] ERROR ${msg}\n`); process.stderr.write(`[ERROR] ${msg}\n`); },
    warn: (msg) => { stream.write(`[${ts()}] WARN ${msg}\n`); process.stderr.write(`[WARN] ${msg}\n`); },
  };
}

// case 创建前日志写 stderr
export const stderrLogger: Logger = {
  info: (msg) => process.stderr.write(`[INFO] ${msg}\n`),
  error: (msg) => process.stderr.write(`[ERROR] ${msg}\n`),
  warn: (msg) => process.stderr.write(`[WARN] ${msg}\n`),
};
