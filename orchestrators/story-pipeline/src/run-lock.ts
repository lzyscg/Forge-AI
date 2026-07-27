import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname as operatingSystemHostname } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { sha256 } from './hash.js';

export interface ProcessIdentity {
  pid: number;
  started_at: string;
}

export interface ProcessInspector {
  current(): ProcessIdentity;
  inspect(pid: number): ProcessIdentity | null;
}

export interface AcquireStageLockOptions {
  run_dir: string;
  run_id: string;
  stage_key: string;
  owner_token: string;
  nonce?: string;
  hostname?: string;
  process_inspector?: ProcessInspector;
}

export interface StageLock {
  path: string;
  release(): void;
}

interface StageLockPayload {
  pid: number;
  process_started_at: string;
  hostname: string;
  nonce: string;
  owner_token_sha256: string;
}

function ensureLexicallyInside(runDirectory: string, target: string): void {
  const pathFromRun = relative(runDirectory, target);
  if (
    pathFromRun === '..'
    || pathFromRun.startsWith(`..${sep}`)
    || isAbsolute(pathFromRun)
  ) {
    throw new Error('stage lock path escapes the run directory');
  }
}

function ensureSafeExistingPath(runDirectory: string, target: string): void {
  ensureLexicallyInside(runDirectory, target);
  const canonicalRun = realpathSync(runDirectory);
  const canonicalTarget = realpathSync(target);
  const pathFromRun = relative(canonicalRun, canonicalTarget);
  if (
    pathFromRun === '..'
    || pathFromRun.startsWith(`..${sep}`)
    || isAbsolute(pathFromRun)
  ) {
    throw new Error('stage lock path resolves outside the run directory');
  }
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error('stage lock path contains a symbolic link or reparse point');
  }
}

function ensureSafeDirectory(runDirectory: string, target: string): void {
  ensureSafeExistingPath(runDirectory, runDirectory);
  ensureLexicallyInside(runDirectory, target);
  const pathFromRun = relative(runDirectory, target);
  let current = runDirectory;
  for (const component of pathFromRun.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) mkdirSync(current);
    ensureSafeExistingPath(runDirectory, current);
  }
}

function ensureSafeLeafPath(runDirectory: string, target: string): void {
  ensureLexicallyInside(runDirectory, target);
  ensureSafeExistingPath(runDirectory, dirname(target));
  if (existsSync(target)) ensureSafeExistingPath(runDirectory, target);
}

function writeExclusiveJson(path: string, value: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readLock(path: string): StageLockPayload {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StageLockPayload>;
  if (
    !Number.isInteger(parsed.pid)
    || typeof parsed.process_started_at !== 'string'
    || typeof parsed.hostname !== 'string'
    || typeof parsed.nonce !== 'string'
    || typeof parsed.owner_token_sha256 !== 'string'
  ) {
    throw new Error('stage lock contains invalid ownership evidence');
  }
  return parsed as StageLockPayload;
}

function isLive(
  payload: StageLockPayload,
  inspector: ProcessInspector,
): boolean {
  const processIdentity = inspector.inspect(payload.pid);
  return processIdentity !== null
    && processIdentity.started_at === payload.process_started_at;
}

function inspectWithPowerShell(pid: number): ProcessIdentity | null {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; `
      + 'if ($null -ne $p) { [Console]::Out.Write('
      + '$p.StartTime.ToUniversalTime().ToString("o")) }',
  ], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  const startedAt = result.status === 0 ? result.stdout.trim() : '';
  if (startedAt) return { pid, started_at: startedAt };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw new Error(`could not verify process ${String(pid)} start time`);
  }
  throw new Error(`could not verify process ${String(pid)} start time`);
}

function inspectWithPs(pid: number): ProcessIdentity | null {
  const result = spawnSync('ps', [
    '-o',
    'lstart=',
    '-p',
    String(pid),
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
  });
  const value = result.status === 0 ? result.stdout.trim() : '';
  if (!value) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
      throw new Error(`could not verify process ${String(pid)} start time`);
    }
    throw new Error(`could not verify process ${String(pid)} start time`);
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf())
    ? null
    : { pid, started_at: timestamp.toISOString() };
}

export function createProcessInspector(
  platform: NodeJS.Platform = process.platform,
): ProcessInspector {
  const inspect = platform === 'win32'
    ? inspectWithPowerShell
    : inspectWithPs;
  return {
    current: () => {
      const identity = inspect(process.pid);
      if (!identity) {
        throw new Error('could not inspect the current process start time');
      }
      return identity;
    },
    inspect,
  };
}

export function acquireStageLock(
  options: AcquireStageLockOptions,
): StageLock {
  const runDirectory = resolve(options.run_dir);
  const inspector = options.process_inspector ?? createProcessInspector();
  const current = inspector.current();
  const nonce = options.nonce ?? randomUUID();
  const ownerTokenSha256 = sha256(options.owner_token);
  const payload: StageLockPayload = {
    pid: current.pid,
    process_started_at: current.started_at,
    hostname: options.hostname ?? operatingSystemHostname(),
    nonce,
    owner_token_sha256: ownerTokenSha256,
  };
  const stageLockDirectory = join(runDirectory, '.locks', 'stages');
  ensureSafeDirectory(runDirectory, stageLockDirectory);
  const lockName = `${sha256(`${options.run_id}\0${options.stage_key}`)}.lock`;
  const lockPath = join(stageLockDirectory, lockName);
  ensureSafeLeafPath(runDirectory, lockPath);

  for (;;) {
    try {
      writeExclusiveJson(lockPath, payload);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    ensureSafeLeafPath(runDirectory, lockPath);
    let existing: StageLockPayload;
    try {
      existing = readLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (isLive(existing, inspector)) {
      throw new Error('stage lock is held by a live process');
    }

    const staleDirectory = join(stageLockDirectory, 'stale');
    ensureSafeDirectory(runDirectory, staleDirectory);
    const auditPath = join(
      staleDirectory,
      `${lockName}.${sha256(
        `${existing.nonce}\0${nonce}\0${randomUUID()}`,
      )}.stale`,
    );
    ensureSafeLeafPath(runDirectory, auditPath);
    try {
      renameSync(lockPath, auditPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    ensureSafeLeafPath(runDirectory, auditPath);
  }

  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      ensureSafeLeafPath(runDirectory, lockPath);
      let currentPayload: StageLockPayload;
      try {
        currentPayload = readLock(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (
        currentPayload.nonce !== nonce
        || currentPayload.owner_token_sha256 !== ownerTokenSha256
      ) {
        return;
      }
      rmSync(lockPath);
    },
  };
}
