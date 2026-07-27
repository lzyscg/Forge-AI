import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from './hash.js';
import {
  acquireStageLock,
  type ProcessInspector,
} from './run-lock.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRun(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forge-run-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

function inspector(
  currentStart = '2026-07-27T00:00:00.000Z',
): ProcessInspector {
  return {
    current: () => ({
      pid: 101,
      started_at: currentStart,
    }),
    inspect: (pid) => pid === 101
      ? { pid, started_at: currentStart }
      : null,
  };
}

describe('stage run locks', () => {
  it('uses the SHA-256 of run id, NUL, and stage key and records ownership evidence', () => {
    const runDir = temporaryRun();
    const lock = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'secret-owner-token',
      nonce: 'nonce-1',
      hostname: 'worker-a',
      process_inspector: inspector(),
    });

    const expectedName = `${sha256('run-1\0draft-b001')}.lock`;
    expect(lock.path).toBe(join(runDir, '.locks', 'stages', expectedName));
    expect(JSON.parse(readFileSync(lock.path, 'utf8'))).toEqual({
      pid: 101,
      process_started_at: '2026-07-27T00:00:00.000Z',
      hostname: 'worker-a',
      nonce: 'nonce-1',
      owner_token_sha256: sha256('secret-owner-token'),
    });

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('rejects a second owner for the same live stage', () => {
    const runDir = temporaryRun();
    const first = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-1',
      nonce: 'nonce-1',
      hostname: 'worker-a',
      process_inspector: inspector(),
    });

    expect(() => acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-2',
      nonce: 'nonce-2',
      hostname: 'worker-b',
      process_inspector: inspector(),
    })).toThrow('stage lock is held by a live process');

    first.release();
  });

  it('atomically audits a PID-reused stale lock before acquiring it', () => {
    const runDir = temporaryRun();
    const first = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-1',
      nonce: 'nonce-1',
      hostname: 'worker-a',
      process_inspector: inspector('2026-07-27T00:00:00.000Z'),
    });
    const second = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-2',
      nonce: 'nonce-2',
      hostname: 'worker-b',
      process_inspector: inspector('2026-07-27T01:00:00.000Z'),
    });

    const auditDirectory = join(runDir, '.locks', 'stages', 'stale');
    const auditNames = readdirSync(auditDirectory);
    expect(auditNames).toHaveLength(1);
    expect(JSON.parse(
      readFileSync(join(auditDirectory, auditNames[0]!), 'utf8'),
    )).toMatchObject({
      pid: 101,
      process_started_at: '2026-07-27T00:00:00.000Z',
      nonce: 'nonce-1',
    });
    expect(JSON.parse(readFileSync(second.path, 'utf8'))).toMatchObject({
      process_started_at: '2026-07-27T01:00:00.000Z',
      nonce: 'nonce-2',
    });

    first.release();
    expect(existsSync(second.path)).toBe(true);
    second.release();
  });

  it('rejects the second of two independent Node processes on the same stage', async () => {
    const runDir = temporaryRun();
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'run-lock.ts')).href;
    const acquireScript = (hold: boolean): string => `
      import { acquireStageLock } from ${JSON.stringify(moduleUrl)};
      const lock = acquireStageLock({
        run_dir: ${JSON.stringify(runDir)},
        run_id: 'run-1',
        stage_key: 'draft-b001',
        owner_token: ${JSON.stringify(hold ? 'owner-1' : 'owner-2')},
      });
      process.stdout.write('READY\\n');
      ${hold
        ? "process.stdin.once('data', () => { lock.release(); process.exit(0); });"
        : 'lock.release();'}
    `;
    const first = spawn(process.execPath, [
      '--import',
      'tsx/esm',
      '--input-type=module',
      '-e',
      acquireScript(true),
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForOutput(first, 'READY');

    const second = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      '--input-type=module',
      '-e',
      acquireScript(false),
    ], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('stage lock is held by a live process');
    first.stdin?.end('release');
    await waitForExit(first);
  }, 15_000);
});

function waitForOutput(
  child: ReturnType<typeof spawn>,
  expected: string,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`timed out waiting for child: ${stderr}`));
    }, 8_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(expected)) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timer);
        rejectPromise(new Error(`child exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`child exited ${String(code)}`));
    });
  });
}
