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
  termination?: ProcessTerminationOptions;
}

export interface ProcessTerminationOptions {
  platform?: NodeJS.Platform;
  taskkillTimeoutMs?: number;
  childCloseTimeoutMs?: number;
  spawnTaskkill?: (pid: number) => ChildProcess;
}

export interface SignalHost {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
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

class ForgeCommandError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = 'ForgeCommandError';
  }
}

export class ForgeCliClient implements ForgeClient {
  private readonly repoRoot: string;
  private readonly cliEntryPath: string;
  private readonly maxOutputBytes: number;
  private readonly termination: ProcessTerminationOptions;

  constructor(options: ForgeCliClientOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.cliEntryPath = options.cliEntryPath
      ?? join(this.repoRoot, 'apps', 'cli', 'src', 'index.ts');
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.termination = options.termination ?? {};
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
    const env = { FORGE_INPUT_FILE: request.inputFile };
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    const running = this.startCommand(args, env, []);
    if (!signal) return requireCaseId(await running.completion);

    const outcome = await raceCommandWithAbort(running.completion, signal);
    if (outcome.kind === 'completed') return requireCaseId(outcome.result);
    if (outcome.kind === 'failed') throw outcome.error;

    await terminateProcessTree(running.child, this.termination);
    let interruptedResult: CommandResult | undefined;
    try {
      interruptedResult = await running.completion;
    } catch (error) {
      if (error instanceof ForgeCommandError) interruptedResult = error.result;
      else throw error;
    }
    const caseId = interruptedResult ? findCaseId(interruptedResult) : undefined;
    if (caseId) return caseId;
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  private async getCaseStatusWithSecrets(
    caseId: string,
    dbPath: string,
    secrets: string[],
  ): Promise<ForgeCaseSnapshot> {
    const result = await this.invoke([
      'case', 'status', caseId,
      '--db', dbPath,
    ], {}, undefined, secrets);
    return requireSnapshot(result, caseId, secrets);
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
      return this.getCaseStatusWithSecrets(
        caseId,
        request.dbPath,
        [runnerToken],
      );
    }

    const running = this.startCommand(args, {}, [runnerToken]);
    if (!signal) {
      return requireSnapshot(await running.completion, caseId, [runnerToken]);
    }

    const outcome = await raceCommandWithAbort(running.completion, signal);
    if (outcome.kind === 'completed') {
      return requireSnapshot(outcome.result, caseId, [runnerToken]);
    }
    if (outcome.kind === 'failed') throw outcome.error;

    await terminateProcessTree(running.child, this.termination);
    await running.completion.catch(() => undefined);
    await this.abortCase(caseId, request.dbPath, runnerToken);
    return this.getCaseStatusWithSecrets(
      caseId,
      request.dbPath,
      [runnerToken],
    );
  }

  async getCaseStatus(
    caseId: string,
    dbPath: string,
  ): Promise<ForgeCaseSnapshot> {
    return this.getCaseStatusWithSecrets(caseId, dbPath, []);
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

    const outcome = await raceCommandWithAbort(running.completion, signal);
    if (outcome.kind === 'completed') return outcome.result;
    if (outcome.kind === 'failed') throw outcome.error;

    await terminateProcessTree(running.child, this.termination);
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
          void terminateProcessTree(child, this.termination).catch((error: unknown) => {
            rejectPromise(error);
          });
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
      child.once('error', () => {
        rejectPromise(new Error('Forge CLI process failed to start'));
      });
      child.once('close', (exitCode) => {
        if (forcedError) {
          rejectPromise(forcedError);
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = redactSecrets(
          Buffer.concat(stderrChunks).toString('utf8'),
          secrets,
        );
        const jsonLines = parseJsonLines(stdout).map(
          (line) => sanitizeProtocolValue(line, secrets),
        );
        const result = { exitCode, jsonLines, stderr };
        if (exitCode !== 0) {
          const cliError = [...jsonLines].reverse().find(
            (line) => typeof line.error === 'string',
          )?.error;
          const detail = typeof cliError === 'string' ? cliError : stderr;
          rejectPromise(new ForgeCommandError(
            `Forge CLI failed with exit code ${String(exitCode)}${detail ? `: ${detail}` : ''}`,
            result,
          ));
          return;
        }
        resolvePromise(result);
      });
    });
    return { child, completion };
  }
}

function findCaseId(result: CommandResult): string | undefined {
  return [...result.jsonLines]
    .reverse()
    .map((line) => line.case_id)
    .find((value): value is string => typeof value === 'string' && value.length > 0);
}

function requireCaseId(result: CommandResult): string {
  const caseId = findCaseId(result);
  if (!caseId) throw new Error('Forge CLI did not return a Case ID');
  return caseId;
}

type CommandAbortOutcome =
  | { kind: 'completed'; result: CommandResult }
  | { kind: 'failed'; error: unknown }
  | { kind: 'aborted' };

async function raceCommandWithAbort(
  completion: Promise<CommandResult>,
  signal: AbortSignal,
): Promise<CommandAbortOutcome> {
  let notifyAbort: (() => void) | undefined;
  const aborted = new Promise<CommandAbortOutcome>((resolvePromise) => {
    notifyAbort = () => resolvePromise({ kind: 'aborted' });
    signal.addEventListener('abort', notifyAbort, { once: true });
    if (signal.aborted) notifyAbort();
  });
  const completed = completion.then(
    (result): CommandAbortOutcome => ({ kind: 'completed', result }),
    (error: unknown): CommandAbortOutcome => ({ kind: 'failed', error }),
  );
  const outcome = await Promise.race([completed, aborted]);
  if (notifyAbort) signal.removeEventListener('abort', notifyAbort);
  return outcome;
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
  secrets: string[],
): ForgeCaseSnapshot {
  const snapshot = [...result.jsonLines].reverse().find(
    (line) => line.case_id === expectedCaseId && typeof line.status === 'string',
  );
  if (!snapshot) throw new Error('Forge CLI did not return a Case snapshot');
  return sanitizeProtocolValue(snapshot, secrets) as unknown as ForgeCaseSnapshot;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret.length > 0
      ? redacted.replaceAll(secret, '[redacted]')
      : redacted,
    value,
  );
}

function sanitizeProtocolValue<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') {
    return redactSecrets(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProtocolValue(item, secrets)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeProtocolValue(item, secrets),
      ]),
    ) as T;
  }
  return value;
}

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessClose(
  child: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<number | null> {
  if (processHasExited(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      child.removeListener('error', fail);
      resolvePromise(exitCode);
    };
    const fail = (): void => {
      clearTimeout(timer);
      child.removeListener('close', finish);
      rejectPromise(new Error(`${label} failed`));
    };
    const timer = setTimeout(() => {
      child.removeListener('close', finish);
      child.removeListener('error', fail);
      rejectPromise(new Error(`${label} timed out`));
    }, timeoutMs);
    timer.unref();
    child.once('close', finish);
    child.once('error', fail);
  });
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTerminationOptions = {},
): Promise<void> {
  if (child.pid === undefined || processHasExited(child)) return;
  const platform = options.platform ?? process.platform;
  const taskkillTimeoutMs = options.taskkillTimeoutMs ?? 5_000;
  const childCloseTimeoutMs = options.childCloseTimeoutMs ?? 5_000;
  if (platform === 'win32') {
    const killer = options.spawnTaskkill
      ? options.spawnTaskkill(child.pid)
      : spawn('taskkill.exe', [
          '/PID',
          String(child.pid),
          '/T',
          '/F',
        ], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
    let taskkillExitCode: number | null;
    try {
      taskkillExitCode = await waitForProcessClose(
        killer,
        taskkillTimeoutMs,
        'taskkill',
      );
    } catch (error) {
      killer.kill();
      throw error;
    }
    if (taskkillExitCode !== 0) {
      throw new Error(`taskkill failed with exit code ${String(taskkillExitCode)}`);
    }
    await waitForProcessClose(
      child,
      childCloseTimeoutMs,
      'child process exit',
    );
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await waitForProcessClose(
    child,
    childCloseTimeoutMs,
    'child process exit',
  );
}

export function installAbortSignalHandlers(
  controller: AbortController,
  host: SignalHost = process,
): () => void {
  const abort = (): void => controller.abort();
  host.on('SIGINT', abort);
  host.on('SIGTERM', abort);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    host.removeListener('SIGINT', abort);
    host.removeListener('SIGTERM', abort);
  };
}
