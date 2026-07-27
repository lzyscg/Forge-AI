import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
  basename,
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

export interface StageLockFileStat {
  isSymbolicLink(): boolean;
}

export interface StageLockFsOps {
  exists(path: string): boolean;
  lstat(path: string): StageLockFileStat;
  mkdir(path: string): void;
  readFile(path: string): Buffer;
  realpath(path: string): string;
  rename(from: string, to: string): void;
  remove(path: string): void;
  writeFile(path: string, content: string): void;
  fsyncFile(path: string): void;
  link(existingPath: string, newPath: string): void;
}

export interface AcquireStageLockOptions {
  run_dir: string;
  run_id: string;
  stage_key: string;
  owner_token: string;
  nonce?: string;
  hostname?: string;
  process_inspector?: ProcessInspector;
  fs_ops?: Partial<StageLockFsOps>;
}

export interface StageLock {
  path: string;
  cleanup_paths: string[];
  warnings: string[];
  release(): void;
}

interface StageLockPayload {
  pid: number;
  process_started_at: string;
  hostname: string;
  nonce: string;
  owner_token_sha256: string;
}

interface PublicationResult {
  deferred_cleanup_path: string | null;
  warning: string | null;
}

const defaultFsOps: StageLockFsOps = {
  exists: existsSync,
  lstat: lstatSync,
  mkdir: (path) => mkdirSync(path),
  readFile: readFileSync,
  realpath: realpathSync,
  rename: renameSync,
  remove: (path) => rmSync(path),
  writeFile: (path, content) => writeFileSync(path, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  }),
  fsyncFile: (path) => {
    const descriptor = openSync(path, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  link: linkSync,
};

function waitBriefly(): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, 5);
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

function ensureSafeExistingPath(
  runDirectory: string,
  target: string,
  fsOps: StageLockFsOps,
): void {
  ensureLexicallyInside(runDirectory, target);
  const canonicalRun = fsOps.realpath(runDirectory);
  const canonicalTarget = fsOps.realpath(target);
  const pathFromRun = relative(canonicalRun, canonicalTarget);
  if (
    pathFromRun === '..'
    || pathFromRun.startsWith(`..${sep}`)
    || isAbsolute(pathFromRun)
  ) {
    throw new Error('stage lock path resolves outside the run directory');
  }
  if (fsOps.lstat(target).isSymbolicLink()) {
    throw new Error('stage lock path contains a symbolic link or reparse point');
  }
}

function ensureSafeDirectory(
  runDirectory: string,
  target: string,
  fsOps: StageLockFsOps,
): void {
  ensureSafeExistingPath(runDirectory, runDirectory, fsOps);
  ensureLexicallyInside(runDirectory, target);
  const pathFromRun = relative(runDirectory, target);
  let current = runDirectory;
  for (const component of pathFromRun.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    if (!fsOps.exists(current)) {
      try {
        fsOps.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    ensureSafeExistingPath(runDirectory, current, fsOps);
  }
}

function ensureSafeLeafPath(
  runDirectory: string,
  target: string,
  fsOps: StageLockFsOps,
): void {
  ensureLexicallyInside(runDirectory, target);
  ensureSafeExistingPath(runDirectory, dirname(target), fsOps);
  if (fsOps.exists(target)) {
    ensureSafeExistingPath(runDirectory, target, fsOps);
  }
}

function payloadMatches(
  left: StageLockPayload,
  right: StageLockPayload,
): boolean {
  return left.pid === right.pid
    && left.process_started_at === right.process_started_at
    && left.nonce === right.nonce
    && left.owner_token_sha256 === right.owner_token_sha256;
}

function readLock(
  path: string,
  fsOps: StageLockFsOps,
): StageLockPayload {
  const parsed = JSON.parse(
    fsOps.readFile(path).toString('utf8'),
  ) as Partial<StageLockPayload>;
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

function removeWithRetry(path: string, fsOps: StageLockFsOps): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fsOps.remove(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      lastError = error;
      if (attempt < 2) waitBriefly();
    }
  }
  throw lastError;
}

function removeOwnedPublishedPath(
  path: string,
  payload: StageLockPayload,
  fsOps: StageLockFsOps,
): void {
  let current: StageLockPayload;
  try {
    current = readLock(path, fsOps);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (payloadMatches(current, payload)) removeWithRetry(path, fsOps);
}

function publishExclusiveJson(
  runDirectory: string,
  finalPath: string,
  payload: StageLockPayload,
  fsOps: StageLockFsOps,
): PublicationResult {
  const temporaryPath = join(
    dirname(finalPath),
    `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  ensureSafeLeafPath(runDirectory, temporaryPath, fsOps);
  let published = false;
  let primaryError: unknown;
  try {
    fsOps.writeFile(
      temporaryPath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    fsOps.fsyncFile(temporaryPath);
    ensureSafeLeafPath(runDirectory, temporaryPath, fsOps);
    ensureSafeLeafPath(runDirectory, finalPath, fsOps);
    fsOps.link(temporaryPath, finalPath);
    published = true;
  } catch (error) {
    primaryError = error;
    if (fsOps.exists(finalPath)) {
      try {
        removeOwnedPublishedPath(finalPath, payload, fsOps);
      } catch {
        // Preserve the publish failure; a future owner will fail closed.
      }
    }
  }
  let deferredCleanupPath: string | null = null;
  try {
    removeWithRetry(temporaryPath, fsOps);
  } catch (cleanupError) {
    if (published && primaryError === undefined) {
      deferredCleanupPath = temporaryPath;
    } else if (primaryError === undefined) {
      primaryError = cleanupError;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (!published) throw new Error('stage lock publication did not complete');
  return {
    deferred_cleanup_path: deferredCleanupPath,
    warning: deferredCleanupPath
      ? 'stage lock temp cleanup deferred until release'
      : null,
  };
}

function isLive(
  payload: StageLockPayload,
  inspector: ProcessInspector,
): boolean {
  const processIdentity = inspector.inspect(payload.pid);
  return processIdentity !== null
    && processIdentity.started_at === payload.process_started_at;
}

function auditPath(
  staleDirectory: string,
  lockName: string,
  observed: StageLockPayload,
  contenderNonce: string,
  kind: 'lock' | 'reclaim',
): string {
  return join(
    staleDirectory,
    `${lockName}.${kind}.${sha256(
      `${observed.pid}\0${observed.process_started_at}\0`
      + `${observed.nonce}\0${observed.owner_token_sha256}\0`
      + `${contenderNonce}\0${randomUUID()}`,
    )}.stale`,
  );
}

function releaseOwnedPath(
  runDirectory: string,
  path: string,
  payload: StageLockPayload,
  fsOps: StageLockFsOps,
): boolean {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      ensureSafeLeafPath(runDirectory, path, fsOps);
      const current = readLock(path, fsOps);
      if (!payloadMatches(current, payload)) return true;
      fsOps.remove(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      lastError = error;
      if (attempt < 2) waitBriefly();
    }
  }
  throw lastError;
}

function acquireReclaimGuard(
  runDirectory: string,
  guardPath: string,
  guardPayload: StageLockPayload,
  fsOps: StageLockFsOps,
): StageLock {
  let publication: PublicationResult;
  try {
    publication = publishExclusiveJson(
      runDirectory,
      guardPath,
      guardPayload,
      fsOps,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    ensureSafeLeafPath(runDirectory, guardPath, fsOps);
    throw new Error(
      'reclaim guard already exists; manual audit and recovery required',
    );
  }
  const cleanupPaths = publication.deferred_cleanup_path
    ? [publication.deferred_cleanup_path]
    : [];
  const warnings = publication.warning ? [publication.warning] : [];
  let released = false;
  return {
    path: guardPath,
    cleanup_paths: cleanupPaths,
    warnings,
    release: () => {
      if (released) return;
      const guardReleased = releaseOwnedPath(
        runDirectory,
        guardPath,
        guardPayload,
        fsOps,
      );
      if (!guardReleased) return;
      for (const cleanupPath of cleanupPaths) {
        ensureSafeLeafPath(runDirectory, cleanupPath, fsOps);
        removeWithRetry(cleanupPath, fsOps);
      }
      released = true;
    },
  };
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
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
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
  const fsOps: StageLockFsOps = { ...defaultFsOps, ...options.fs_ops };
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
  const guardPayload: StageLockPayload = {
    ...payload,
    nonce: `${nonce}.reclaim.${randomUUID()}`,
  };
  const stageLockDirectory = join(runDirectory, '.locks', 'stages');
  ensureSafeDirectory(runDirectory, stageLockDirectory, fsOps);
  const lockName = `${sha256(`${options.run_id}\0${options.stage_key}`)}.lock`;
  const lockPath = join(stageLockDirectory, lockName);
  const guardPath = `${lockPath}.reclaim`;
  const staleDirectory = join(stageLockDirectory, 'stale');
  ensureSafeDirectory(runDirectory, staleDirectory, fsOps);
  ensureSafeLeafPath(runDirectory, lockPath, fsOps);
  ensureSafeLeafPath(runDirectory, guardPath, fsOps);

  const cleanupPaths: string[] = [];
  const warnings: string[] = [];
  for (;;) {
    try {
      const publication = publishExclusiveJson(
        runDirectory,
        lockPath,
        payload,
        fsOps,
      );
      if (publication.deferred_cleanup_path) {
        cleanupPaths.push(publication.deferred_cleanup_path);
      }
      if (publication.warning) warnings.push(publication.warning);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    ensureSafeLeafPath(runDirectory, lockPath, fsOps);
    let observed: StageLockPayload;
    try {
      observed = readLock(lockPath, fsOps);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (isLive(observed, inspector)) {
      throw new Error('stage lock is held by a live process');
    }

    const guard = acquireReclaimGuard(
      runDirectory,
      guardPath,
      guardPayload,
      fsOps,
    );
    try {
      let currentLock: StageLockPayload;
      try {
        currentLock = readLock(lockPath, fsOps);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!payloadMatches(currentLock, observed)) continue;
      const staleLockPath = auditPath(
        staleDirectory,
        lockName,
        observed,
        nonce,
        'lock',
      );
      ensureSafeLeafPath(runDirectory, staleLockPath, fsOps);
      try {
        fsOps.rename(lockPath, staleLockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      ensureSafeLeafPath(runDirectory, staleLockPath, fsOps);
      try {
        const publication = publishExclusiveJson(
          runDirectory,
          lockPath,
          payload,
          fsOps,
        );
        if (publication.deferred_cleanup_path) {
          cleanupPaths.push(publication.deferred_cleanup_path);
        }
        if (publication.warning) warnings.push(publication.warning);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      guard.release();
    }
  }

  let released = false;
  return {
    path: lockPath,
    cleanup_paths: cleanupPaths,
    warnings,
    release: () => {
      if (released) return;
      const finalReleased = releaseOwnedPath(
        runDirectory,
        lockPath,
        payload,
        fsOps,
      );
      if (!finalReleased) return;
      for (const cleanupPath of cleanupPaths) {
        ensureSafeLeafPath(runDirectory, cleanupPath, fsOps);
        removeWithRetry(cleanupPath, fsOps);
      }
      released = true;
    },
  };
}
