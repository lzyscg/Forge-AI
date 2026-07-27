import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ResultJson } from '@forge-ai/contracts';

export interface CreateCaseRequest {
  template: string;
  dbPath: string;
  mode: 'fake' | 'real';
  title: string;
  inputFile: string;
  runId: string;
  storyId: string;
  stageKey: string;
  chapterId: string | null;
}

export interface RunCaseRequest {
  dbPath: string;
  mode: 'fake' | 'real';
  runnerCredentialPath: string;
}

export type ForgeCaseSnapshot = ResultJson;

export interface ForgeClient {
  createCase(request: CreateCaseRequest, signal?: AbortSignal): Promise<string>;
  runCase(
    caseId: string,
    request: RunCaseRequest,
    signal?: AbortSignal,
  ): Promise<ForgeCaseSnapshot>;
  getCaseStatus(caseId: string, dbPath: string): Promise<ForgeCaseSnapshot>;
  abortCase(caseId: string, dbPath: string, runnerToken: string): Promise<void>;
}

export interface ForgeCliClientOptions {
  repoRoot: string;
  cliEntryPath?: string;
  maxOutputBytes?: number;
}

interface CommandResult {
  exitCode: number | null;
  jsonLines: Record<string, unknown>[];
  stderr: string;
}

interface RunningCommand {
  child: ChildProcess;
  completion: Promise<CommandResult>;
}

export class ForgeCliClient implements ForgeClient {
  private readonly repoRoot: string;
  private readonly cliEntryPath: string;
  private readonly maxOutputBytes: number;

  constructor(options: ForgeCliClientOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.cliEntryPath = options.cliEntryPath
      ?? join(this.repoRoot, 'apps', 'cli', 'src', 'index.ts');
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  async createCase(
    request: CreateCaseRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const args = [
      'case', 'create',
      '--template', request.template,
      '--db', request.dbPath,
      '--mode', request.mode,
      '--title', request.title,
      '--run-id', request.runId,
      '--story-id', request.storyId,
      '--stage-key', request.stageKey,
    ];
    if (request.chapterId !== null) {
      args.push('--chapter-id', request.chapterId);
    }
    const result = await this.invoke(args, {
      FORGE_INPUT_FILE: request.inputFile,
    }, signal);
    const caseId = [...result.jsonLines]
      .reverse()
      .map((line) => line.case_id)
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    if (!caseId) throw new Error('Forge CLI did not return a Case ID');
    return caseId;
  }

  async runCase(
    caseId: string,
    request: RunCaseRequest,
    signal?: AbortSignal,
  ): Promise<ForgeCaseSnapshot> {
    const runnerToken = readFileSync(request.runnerCredentialPath, 'utf8');
    const args = [
      'case', 'run', caseId,
      '--wait',
      '--db', request.dbPath,
      '--mode', request.mode,
      '--runner-token', runnerToken,
    ];
    if (signal?.aborted) {
      await this.abortCase(caseId, request.dbPath, runnerToken);
      return this.getCaseStatus(caseId, request.dbPath);
    }

    const running = this.startCommand(args, {}, [runnerToken]);
    if (!signal) return requireSnapshot(await running.completion, caseId);

    let notifyAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolvePromise) => {
      notifyAbort = () => resolvePromise('aborted');
      signal.addEventListener('abort', notifyAbort, { once: true });
      if (signal.aborted) notifyAbort();
    });
    const completed = running.completion.then(
      (result) => ({ kind: 'completed' as const, result }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    const outcome = await Promise.race([
      completed,
      aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    if (notifyAbort) signal.removeEventListener('abort', notifyAbort);

    if (outcome.kind === 'completed') {
      return requireSnapshot(outcome.result, caseId);
    }
    if (outcome.kind === 'failed') throw outcome.error;

    await terminateProcessTree(running.child);
    await running.completion.catch(() => undefined);
    await this.abortCase(caseId, request.dbPath, runnerToken);
    return this.getCaseStatus(caseId, request.dbPath);
  }

  async getCaseStatus(
    caseId: string,
    dbPath: string,
  ): Promise<ForgeCaseSnapshot> {
    const result = await this.invoke([
      'case', 'status', caseId,
      '--db', dbPath,
    ], {});
    return requireSnapshot(result, caseId);
  }

  async abortCase(
    caseId: string,
    dbPath: string,
    runnerToken: string,
  ): Promise<void> {
    await this.invoke([
      'case', 'abort', caseId,
      '--db', dbPath,
      '--runner-token', runnerToken,
    ], {}, undefined, [runnerToken]);
  }

  private async invoke(
    args: string[],
    envExtra: Record<string, string>,
    signal?: AbortSignal,
    secrets: string[] = [],
  ): Promise<CommandResult> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    const running = this.startCommand(args, envExtra, secrets);
    if (!signal) return running.completion;

    let notifyAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolvePromise) => {
      notifyAbort = () => resolvePromise('aborted');
      signal.addEventListener('abort', notifyAbort, { once: true });
      if (signal.aborted) notifyAbort();
    });
    const completed = running.completion.then(
      (result) => ({ kind: 'completed' as const, result }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    const outcome = await Promise.race([
      completed,
      aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    if (notifyAbort) signal.removeEventListener('abort', notifyAbort);
    if (outcome.kind === 'completed') return outcome.result;
    if (outcome.kind === 'failed') throw outcome.error;

    await terminateProcessTree(running.child);
    await running.completion.catch(() => undefined);
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  private startCommand(
    args: string[],
    envExtra: Record<string, string>,
    secrets: string[],
  ): RunningCommand {
    const child = spawn(process.execPath, [
      '--import',
      'tsx/esm',
      this.cliEntryPath,
      ...args,
    ], {
      cwd: this.repoRoot,
      env: { ...process.env, ...envExtra },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let forcedError: Error | null = null;
      let terminationStarted = false;

      const stopForLimit = (label: string): void => {
        if (forcedError) return;
        forcedError = new Error(`Forge CLI ${label} exceeded the configured limit`);
        if (!terminationStarted) {
          terminationStarted = true;
          void terminateProcessTree(child);
        }
      };
      const appendBounded = (
        chunks: Buffer[],
        chunk: Buffer,
        currentBytes: number,
        label: string,
      ): number => {
        const remainingBytes = this.maxOutputBytes - currentBytes;
        if (remainingBytes <= 0) {
          stopForLimit(label);
          return currentBytes;
        }
        if (chunk.length > remainingBytes) {
          chunks.push(chunk.subarray(0, remainingBytes));
          stopForLimit(label);
          return this.maxOutputBytes;
        }
        chunks.push(chunk);
        return currentBytes + chunk.length;
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes = appendBounded(stdoutChunks, chunk, stdoutBytes, 'stdout');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = appendBounded(stderrChunks, chunk, stderrBytes, 'stderr');
      });
      child.once('error', (error) => rejectPromise(error));
      child.once('close', (exitCode) => {
        if (forcedError) {
          rejectPromise(forcedError);
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const jsonLines = parseJsonLines(stdout);
        if (exitCode !== 0) {
          const cliError = [...jsonLines].reverse().find(
            (line) => typeof line.error === 'string',
          )?.error;
          const detail = redactSecrets(
            typeof cliError === 'string' ? cliError : stderr,
            secrets,
          );
          rejectPromise(new Error(
            `Forge CLI failed with exit code ${String(exitCode)}${detail ? `: ${detail}` : ''}`,
          ));
          return;
        }
        resolvePromise({ exitCode, jsonLines, stderr });
      });
    });
    return { child, completion };
  }
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lines.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-protocol lines. The total stdout size is bounded by invoke().
    }
  }
  return lines;
}

function requireSnapshot(
  result: CommandResult,
  expectedCaseId: string,
): ForgeCaseSnapshot {
  const snapshot = [...result.jsonLines].reverse().find(
    (line) => line.case_id === expectedCaseId && typeof line.status === 'string',
  );
  if (!snapshot) throw new Error('Forge CLI did not return a Case snapshot');
  return snapshot as unknown as ForgeCaseSnapshot;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret.length > 0
      ? redacted.replaceAll(secret, '[redacted]')
      : redacted,
    value,
  );
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill.exe', [
        '/PID',
        String(child.pid),
        '/T',
        '/F',
      ], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolvePromise());
      killer.once('close', () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
