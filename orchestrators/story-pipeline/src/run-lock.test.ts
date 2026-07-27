import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
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

  it('leaves no final or temp lock when temp fsync fails', () => {
    const runDir = temporaryRun();
    const lockName = `${sha256('run-1\0draft-b001')}.lock`;
    const stageDirectory = join(runDir, '.locks', 'stages');

    expect(() => acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-1',
      process_inspector: inspector(),
      fs_ops: {
        fsyncFile: () => {
          throw new Error('injected lock fsync failure');
        },
      },
    })).toThrow('injected lock fsync failure');

    expect(existsSync(join(stageDirectory, lockName))).toBe(false);
    expect(readdirSync(stageDirectory).filter((name) => name.includes('.tmp')))
      .toEqual([]);
  });

  it('retries release removal and completes only after deletion succeeds', () => {
    const runDir = temporaryRun();
    const lockPath = join(
      runDir,
      '.locks',
      'stages',
      `${sha256('run-1\0draft-b001')}.lock`,
    );
    let finalRemoveAttempts = 0;
    const lock = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-1',
      process_inspector: inspector(),
      fs_ops: {
        remove: (path) => {
          if (path === lockPath) {
            finalRemoveAttempts += 1;
            if (finalRemoveAttempts === 1) {
              const error = new Error('transient busy') as NodeJS.ErrnoException;
              error.code = 'EBUSY';
              throw error;
            }
          }
          rmSync(path);
        },
      },
    });

    lock.release();

    expect(finalRemoveAttempts).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails closed on an existing reclaim guard without moving either file', () => {
    const runDir = temporaryRun();
    const oldInspector = inspector('2026-07-27T00:00:00.000Z');
    acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'old-owner',
      nonce: 'old-lock',
      process_inspector: oldInspector,
    });
    const lockPath = join(
      runDir,
      '.locks',
      'stages',
      `${sha256('run-1\0draft-b001')}.lock`,
    );
    const guardPath = `${lockPath}.reclaim`;
    writeFileSync(guardPath, `${JSON.stringify({
      pid: 202,
      process_started_at: '2026-07-27T00:00:00.000Z',
      hostname: 'dead-worker',
      nonce: 'dead-guard',
      owner_token_sha256: sha256('dead-guard-owner'),
    }, null, 2)}\n`, 'utf8');

    const lockBefore = readFileSync(lockPath, 'utf8');
    const guardBefore = readFileSync(guardPath, 'utf8');

    expect(() => acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'new-owner',
      nonce: 'new-lock',
      process_inspector: inspector('2026-07-27T01:00:00.000Z'),
    })).toThrow(
      'reclaim guard already exists; manual audit and recovery required',
    );

    expect(readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(readFileSync(guardPath, 'utf8')).toBe(guardBefore);
    expect(readdirSync(join(runDir, '.locks', 'stages', 'stale'))).toEqual([]);
  });

  it('allows only one independent process to reclaim the same stale lock', async () => {
    const runDir = temporaryRun();
    const stageDirectory = join(runDir, '.locks', 'stages');
    mkdirSync(stageDirectory, { recursive: true });
    const lockPath = join(
      stageDirectory,
      `${sha256('run-1\0draft-b001')}.lock`,
    );
    writeFileSync(lockPath, `${JSON.stringify({
      pid: 999_999,
      process_started_at: '2020-01-01T00:00:00.000Z',
      hostname: 'dead-worker',
      nonce: 'stale-lock',
      owner_token_sha256: sha256('dead-owner'),
    }, null, 2)}\n`, 'utf8');
    const gatePath = join(runDir, 'gate');
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'run-lock.ts')).href;
    const children = ['one', 'two'].map((worker) => {
      const readyPath = join(runDir, `${worker}.ready`);
      const resultPath = join(runDir, `${worker}.result`);
      const script = `
        import { existsSync, writeFileSync } from 'node:fs';
        import { acquireStageLock } from ${JSON.stringify(moduleUrl)};
        const wait = new Int32Array(new SharedArrayBuffer(4));
        writeFileSync(${JSON.stringify(readyPath)}, 'ready');
        while (!existsSync(${JSON.stringify(gatePath)})) Atomics.wait(wait, 0, 0, 5);
        try {
          const lock = acquireStageLock({
            run_dir: ${JSON.stringify(runDir)},
            run_id: 'run-1',
            stage_key: 'draft-b001',
            owner_token: ${JSON.stringify(`owner-${worker}`)},
          });
          writeFileSync(${JSON.stringify(resultPath)}, 'acquired');
          setTimeout(() => { lock.release(); }, 3000);
        } catch (error) {
          writeFileSync(${JSON.stringify(resultPath)}, 'error:' + error.message);
        }
      `;
      const child = spawn(process.execPath, [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        script,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { child, readyPath, resultPath };
    });
    await Promise.all(children.map(({ readyPath }) => waitForFile(readyPath)));
    writeFileSync(gatePath, 'go', 'utf8');
    await Promise.all(children.map(({ child }) => waitForExit(child)));

    const results = children.map(({ resultPath }) =>
      readFileSync(resultPath, 'utf8')
    );
    expect(results.filter((result) => result === 'acquired')).toHaveLength(1);
    expect(results.filter((result) =>
      result.includes('stage lock is held by a live process')
      || result.includes(
        'reclaim guard already exists; manual audit and recovery required',
      )
    ), JSON.stringify(results)).toHaveLength(1);
  }, 20_000);

  it('never lets independent processes recover or rename a pre-existing guard', async () => {
    const runDir = temporaryRun();
    const stageDirectory = join(runDir, '.locks', 'stages');
    mkdirSync(stageDirectory, { recursive: true });
    const lockPath = join(
      stageDirectory,
      `${sha256('run-1\0draft-b001')}.lock`,
    );
    const guardPath = `${lockPath}.reclaim`;
    const stalePayload = {
      pid: 999_999,
      process_started_at: '2020-01-01T00:00:00.000Z',
      hostname: 'dead-worker',
      nonce: 'stale-lock',
      owner_token_sha256: sha256('dead-owner'),
    };
    const guardPayload = {
      ...stalePayload,
      nonce: 'stale-guard',
      owner_token_sha256: sha256('dead-guard-owner'),
    };
    writeFileSync(lockPath, `${JSON.stringify(stalePayload, null, 2)}\n`);
    writeFileSync(guardPath, `${JSON.stringify(guardPayload, null, 2)}\n`);
    const lockBefore = readFileSync(lockPath, 'utf8');
    const guardBefore = readFileSync(guardPath, 'utf8');
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'run-lock.ts')).href;
    const children = ['one', 'two'].map((worker) => {
      const resultPath = join(runDir, `${worker}.guard-result`);
      const script = `
        import { writeFileSync } from 'node:fs';
        import { acquireStageLock } from ${JSON.stringify(moduleUrl)};
        try {
          const lock = acquireStageLock({
            run_dir: ${JSON.stringify(runDir)},
            run_id: 'run-1',
            stage_key: 'draft-b001',
            owner_token: ${JSON.stringify(`owner-${worker}`)},
          });
          writeFileSync(${JSON.stringify(resultPath)}, 'acquired');
          lock.release();
        } catch (error) {
          writeFileSync(${JSON.stringify(resultPath)}, 'error:' + error.message);
        }
      `;
      const child = spawn(process.execPath, [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        script,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { child, resultPath };
    });
    await Promise.all(children.map(({ child }) => waitForExit(child)));

    const results = children.map(({ resultPath }) =>
      readFileSync(resultPath, 'utf8')
    );
    expect(results.every((result) => result.includes(
      'reclaim guard already exists; manual audit and recovery required',
    ))).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(readFileSync(guardPath, 'utf8')).toBe(guardBefore);
    expect(readdirSync(stageDirectory).filter((name) =>
      name.includes('.stale')
    )).toEqual([]);
  }, 15_000);

  it('returns an acquired handle when linked temp cleanup must wait for release', () => {
    const runDir = temporaryRun();
    let tempRemoveAttempts = 0;
    const lock = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-1',
      process_inspector: inspector(),
      fs_ops: {
        remove: (path) => {
          if (path.includes('.tmp') && tempRemoveAttempts < 3) {
            tempRemoveAttempts += 1;
            const error = new Error('temp busy') as NodeJS.ErrnoException;
            error.code = 'EBUSY';
            throw error;
          }
          rmSync(path);
        },
      },
    });

    expect(existsSync(lock.path)).toBe(true);
    expect(lock.cleanup_paths).toHaveLength(1);
    expect(lock.warnings).toEqual([
      'stage lock temp cleanup deferred until release',
    ]);
    expect(() => acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'owner-2',
      process_inspector: inspector(),
    })).toThrow('stage lock is held by a live process');

    const cleanupPath = lock.cleanup_paths[0]!;
    expect(existsSync(cleanupPath)).toBe(true);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(existsSync(cleanupPath)).toBe(false);
    expect(tempRemoveAttempts).toBe(3);
  });

  it('transfers failed reclaim-guard cleanup to the published successor handle', () => {
    const runDir = temporaryRun();
    const stageDirectory = join(runDir, '.locks', 'stages');
    const staleDirectory = join(stageDirectory, 'stale');
    mkdirSync(staleDirectory, { recursive: true });
    const lockPath = join(
      stageDirectory,
      `${sha256('run-1\0draft-b001')}.lock`,
    );
    const guardPath = `${lockPath}.reclaim`;
    writeFileSync(lockPath, `${JSON.stringify({
      pid: 999_999,
      process_started_at: '2020-01-01T00:00:00.000Z',
      hostname: 'dead-worker',
      nonce: 'stale-lock',
      owner_token_sha256: sha256('dead-owner'),
    }, null, 2)}\n`);

    const guardTempPaths = new Set<string>();
    const successorTempPaths = new Set<string>();
    let guardTempRemoveAttempts = 0;
    let successorTempRemoveAttempts = 0;
    const busy = (): NodeJS.ErrnoException => {
      const error = new Error('injected cleanup busy') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      return error;
    };
    const lock = acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'new-owner',
      nonce: 'new-lock',
      process_inspector: inspector(),
      fs_ops: {
        remove: (path) => {
          const isTemporary = path.endsWith('.tmp');
          if (isTemporary && path.includes('.reclaim.')) {
            guardTempPaths.add(path);
            guardTempRemoveAttempts += 1;
            if (guardTempRemoveAttempts <= 6) throw busy();
          } else if (
            isTemporary
            && readdirSync(staleDirectory).length > 0
          ) {
            successorTempPaths.add(path);
            successorTempRemoveAttempts += 1;
            if (successorTempRemoveAttempts <= 3) throw busy();
          }
          rmSync(path);
        },
      },
    });

    expect(existsSync(lock.path)).toBe(true);
    expect(guardTempRemoveAttempts).toBe(6);
    expect(successorTempRemoveAttempts).toBe(3);
    expect(lock.cleanup_paths).toEqual(expect.arrayContaining([
      ...guardTempPaths,
      ...successorTempPaths,
    ]));
    expect(lock.warnings).toContain(
      'stage lock temp cleanup deferred until release',
    );
    expect(() => acquireStageLock({
      run_dir: runDir,
      run_id: 'run-1',
      stage_key: 'draft-b001',
      owner_token: 'other-owner',
      process_inspector: inspector(),
    })).toThrow('stage lock is held by a live process');

    lock.release();

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(guardPath)).toBe(false);
    expect([...guardTempPaths, ...successorTempPaths].every(
      (path) => !existsSync(path),
    )).toBe(true);
  });
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
