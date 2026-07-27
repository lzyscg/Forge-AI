import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from './sqlite-repository.js';

const roots: string[] = [];
const repositories: SqliteRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openRepository(path: string): SqliteRepository {
  const repository = new SqliteRepository(path);
  repositories.push(repository);
  return repository;
}

function insertCase(repo: SqliteRepository, status = 'created'): void {
  repo.insertCase({
    case_id: 'case-1',
    title: 'leased case',
    status,
    current_stage: 'init',
    scenario_snapshot: '{}',
    input_payload: '{}',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    completed_at: null,
  });
}

async function runRace(
  dbPath: string,
  operations: Array<Record<string, unknown>>,
): Promise<unknown[]> {
  const workers: Worker[] = [];
  for (const operation of operations) {
    const worker = new Worker(
      new URL('./execution-lease-race.worker.ts', import.meta.url),
      {
        execArgv: ['--import', 'tsx'],
        workerData: { dbPath, operation },
      },
    );
    workers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', (message: { type: string }) => {
        if (message.type === 'ready') resolve();
        else reject(new Error(`Worker failed before ready: ${message.type}`));
      });
    });
  }

  const outcomes = workers.map((worker) => new Promise<unknown>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message: {
      type: string;
      outcome?: unknown;
      error?: string;
    }) => {
      if (message.type === 'result') resolve(message.outcome);
      else reject(new Error(message.error ?? `Worker failed: ${message.type}`));
    });
    worker.postMessage({ type: 'go' });
  }));

  try {
    return await Promise.all(outcomes);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

describe('SQLite execution lease', () => {
  it.each([
    'running',
    'repairing',
    'waiting_review',
    'waiting_recovery',
    'waiting_human',
    'approved',
    'failed',
    'stopped',
  ] as const)('does not acquire a fresh lease for a %s case', (status) => {
    const repo = openRepository(':memory:');
    insertCase(repo, status);

    expect(repo.acquireExecutionLease('case-1', {
      runner_token_sha256: 'a'.repeat(64),
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    })).toBe(false);
    expect(repo.getExecutionLease('case-1')).toBeNull();
  });

  it('allows only one repository connection to acquire a case lease', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-execution-lease-'));
    roots.push(root);
    const dbPath = join(root, 'forge.db');
    const first = openRepository(dbPath);
    const second = openRepository(dbPath);
    insertCase(first);

    expect(first.acquireExecutionLease('case-1', {
      runner_token_sha256: 'a'.repeat(64),
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    })).toBe(true);
    expect(second.acquireExecutionLease('case-1', {
      runner_token_sha256: 'b'.repeat(64),
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:02.000Z',
    })).toBe(false);

  });

  it('allows only one simultaneous connection to acquire a fresh lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-execution-lease-race-'));
    roots.push(root);
    const dbPath = join(root, 'forge.db');
    const observer = openRepository(dbPath);
    insertCase(observer);

    const outcomes = await runRace(dbPath, [
      {
        kind: 'acquire',
        caseId: 'case-1',
        lease: {
          runner_token_sha256: 'a'.repeat(64),
          runner_pid: 101,
          runner_started_at: '2026-07-27T00:00:01.000Z',
          heartbeat_at: '2026-07-27T00:00:01.000Z',
        },
      },
      {
        kind: 'acquire',
        caseId: 'case-1',
        lease: {
          runner_token_sha256: 'b'.repeat(64),
          runner_pid: 202,
          runner_started_at: '2026-07-27T00:00:02.000Z',
          heartbeat_at: '2026-07-27T00:00:02.000Z',
        },
      },
    ]);

    expect(outcomes.filter((outcome) => outcome === true)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === false)).toHaveLength(1);
  });

  it('allows only one simultaneous runner to claim an unowned matching lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-execution-claim-race-'));
    roots.push(root);
    const dbPath = join(root, 'forge.db');
    const observer = openRepository(dbPath);
    insertCase(observer);
    const hash = 'a'.repeat(64);
    observer.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 0,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });

    const outcomes = await runRace(dbPath, [
      {
        kind: 'claim',
        caseId: 'case-1',
        runnerTokenSha256: hash,
        runnerPid: 101,
        claimedAt: '2026-07-27T00:00:02.000Z',
      },
      {
        kind: 'claim',
        caseId: 'case-1',
        runnerTokenSha256: hash,
        runnerPid: 202,
        claimedAt: '2026-07-27T00:00:03.000Z',
      },
    ]);

    expect(outcomes.filter((outcome) => outcome === true)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === false)).toHaveLength(1);
    expect([101, 202]).toContain(observer.getExecutionLease('case-1')?.runner_pid);
  });

  it('releases only the current owner while retaining the token lease', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    const hash = 'a'.repeat(64);
    repo.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });

    expect(repo.releaseExecutionLeaseOwner('case-1', hash, 202)).toBe(false);
    expect(repo.releaseExecutionLeaseOwner('case-1', hash, 101)).toBe(true);
    expect(repo.getExecutionLease('case-1')).toMatchObject({
      runner_token_sha256: hash,
      runner_pid: 0,
    });
  });

  it('allows only atomic lease acquisition or legacy stop to win', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-execution-stop-race-'));
    roots.push(root);
    const dbPath = join(root, 'forge.db');
    const observer = openRepository(dbPath);
    insertCase(observer);

    const [acquired, stopped] = await runRace(dbPath, [
      {
        kind: 'acquire',
        caseId: 'case-1',
        lease: {
          runner_token_sha256: 'a'.repeat(64),
          runner_pid: 101,
          runner_started_at: '2026-07-27T00:00:01.000Z',
          heartbeat_at: '2026-07-27T00:00:01.000Z',
        },
      },
      {
        kind: 'stop',
        caseId: 'case-1',
        expectedStatus: 'created',
        stoppedAt: '2026-07-27T00:00:02.000Z',
      },
    ]);

    expect(Number(acquired) + Number(stopped)).toBe(1);
    if (acquired) {
      expect(observer.getCase('case-1')?.status).toBe('created');
      expect(observer.getExecutionLease('case-1')).not.toBeNull();
    } else {
      expect(observer.getCase('case-1')?.status).toBe('stopped');
      expect(observer.getExecutionLease('case-1')).toBeNull();
    }
  });

  it('keeps an existing non-terminal lease valid instead of reacquiring it', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    const originalHash = 'a'.repeat(64);
    expect(repo.acquireExecutionLease('case-1', {
      runner_token_sha256: originalHash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    })).toBe(true);
    repo.updateCase('case-1', { status: 'waiting_review' });

    expect(repo.acquireExecutionLease('case-1', {
      runner_token_sha256: 'b'.repeat(64),
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:02.000Z',
    })).toBe(false);
    expect(repo.validateExecutionLease('case-1', originalHash)).toBe(true);
  });

  it('validates, transfers, and heartbeats only with the current token hash', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    const originalHash = 'a'.repeat(64);
    const replacementHash = 'b'.repeat(64);
    expect(repo.acquireExecutionLease('case-1', {
      runner_token_sha256: originalHash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    })).toBe(true);

    expect(repo.transferExecutionLease('case-1', 'c'.repeat(64), {
      runner_token_sha256: replacementHash,
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:02.000Z',
    })).toBe(false);
    expect(repo.transferExecutionLease('case-1', originalHash, {
      runner_token_sha256: replacementHash,
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:02.000Z',
    })).toBe(true);
    expect(repo.validateExecutionLease('case-1', originalHash)).toBe(false);
    expect(repo.validateExecutionLease('case-1', replacementHash)).toBe(true);
    expect(repo.heartbeatExecutionLease(
      'case-1',
      originalHash,
      202,
      '2026-07-27T00:00:03.000Z',
    )).toBe(false);
    expect(repo.heartbeatExecutionLease(
      'case-1',
      replacementHash,
      202,
      '2026-07-27T00:00:04.000Z',
    )).toBe(true);
    expect(repo.getExecutionLease('case-1')).toEqual({
      runner_token_sha256: replacementHash,
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:04.000Z',
    });
  });

  it('commits a state change only for the expected status and matching lease token', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    const hash = 'a'.repeat(64);
    repo.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    repo.updateCase('case-1', { status: 'running' });

    expect(repo.compareAndSetCaseStatus(
      'case-1',
      'running',
      {
        status: 'waiting_review',
        updated_at: '2026-07-27T00:00:02.000Z',
      },
      { runnerTokenSha256: 'b'.repeat(64) },
    )).toBe(false);
    expect(repo.compareAndSetCaseStatus(
      'case-1',
      'running',
      {
        status: 'waiting_review',
        updated_at: '2026-07-27T00:00:02.000Z',
      },
      { runnerTokenSha256: hash },
    )).toBe(true);
    expect(repo.compareAndSetCaseStatus(
      'case-1',
      'running',
      {
        status: 'approved',
        updated_at: '2026-07-27T00:00:03.000Z',
      },
      { runnerTokenSha256: hash, clearExecutionLease: true },
    )).toBe(false);
    expect(repo.getCase('case-1')?.status).toBe('waiting_review');
    expect(repo.getExecutionLease('case-1')).not.toBeNull();
  });

  it('rejects an omitted token when an active lease exists', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    repo.acquireExecutionLease('case-1', {
      runner_token_sha256: 'a'.repeat(64),
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });

    expect(repo.compareAndSetCaseStatus(
      'case-1',
      'created',
      { status: 'running' },
    )).toBe(false);
    expect(repo.getCase('case-1')?.status).toBe('created');
  });

  it('allows a legacy no-token transition only when no active lease exists', () => {
    const repo = openRepository(':memory:');
    insertCase(repo);

    expect(repo.compareAndSetCaseStatus(
      'case-1',
      'created',
      { status: 'running' },
    )).toBe(true);
    expect(repo.getCase('case-1')?.status).toBe('running');
  });

  it('allows only abort or a normal terminal transition to win a simultaneous race', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-execution-state-race-'));
    roots.push(root);
    const dbPath = join(root, 'forge.db');
    const observer = openRepository(dbPath);
    insertCase(observer);
    const hash = 'a'.repeat(64);
    observer.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    observer.updateCase('case-1', { status: 'running' });

    const [abortOutcome, transitionOutcome] = await runRace(dbPath, [
      {
        kind: 'abort',
        caseId: 'case-1',
        runnerTokenSha256: hash,
        stoppedAt: '2026-07-27T00:00:03.000Z',
        abortableStatuses: [
          'running',
          'repairing',
          'waiting_review',
          'waiting_human',
        ],
      },
      {
        kind: 'transition',
        caseId: 'case-1',
        expectedStatus: 'running',
        fields: {
          status: 'approved',
          updated_at: '2026-07-27T00:00:04.000Z',
          completed_at: '2026-07-27T00:00:04.000Z',
        },
        runnerTokenSha256: hash,
        clearExecutionLease: true,
      },
    ]) as [
      { ok: boolean; status?: string; reason?: string },
      boolean,
    ];

    expect(Number(abortOutcome.ok) + Number(transitionOutcome)).toBe(1);
    expect(['stopped', 'approved']).toContain(observer.getCase('case-1')?.status);
    expect(observer.getExecutionLease('case-1')).toBeNull();
  });

  it.each(['running', 'repairing', 'waiting_review', 'waiting_human'] as const)(
    'atomically aborts %s, clears its lease, and accepts only the same token on retry',
    (status) => {
      const repo = openRepository(':memory:');
      insertCase(repo);
      const hash = 'a'.repeat(64);
      repo.acquireExecutionLease('case-1', {
        runner_token_sha256: hash,
        runner_pid: 101,
        runner_started_at: '2026-07-27T00:00:01.000Z',
        heartbeat_at: '2026-07-27T00:00:01.000Z',
      });
      repo.updateCase('case-1', { status });

      expect(repo.abortCaseWithExecutionLease(
        'case-1',
        hash,
        '2026-07-27T00:00:05.000Z',
        ['running', 'repairing', 'waiting_review', 'waiting_human'],
      )).toEqual({ ok: true, status: 'stopped' });
      expect(repo.getCase('case-1')?.status).toBe('stopped');
      expect(repo.getExecutionLease('case-1')).toBeNull();
      expect(repo.abortCaseWithExecutionLease(
        'case-1',
        hash,
        '2026-07-27T00:00:06.000Z',
        ['running', 'repairing', 'waiting_review', 'waiting_human'],
      )).toEqual({ ok: true, status: 'stopped' });
      expect(repo.abortCaseWithExecutionLease(
        'case-1',
        'b'.repeat(64),
        '2026-07-27T00:00:07.000Z',
        ['running', 'repairing', 'waiting_review', 'waiting_human'],
      )).toEqual({ ok: false, reason: 'invalid_token', status: 'stopped' });
    },
  );

  it.each(['approved', 'failed'] as const)('rejects abort for %s', (status) => {
    const repo = openRepository(':memory:');
    insertCase(repo);
    const hash = 'a'.repeat(64);
    repo.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });
    repo.updateCase('case-1', { status });

    expect(repo.abortCaseWithExecutionLease(
      'case-1',
      hash,
      '2026-07-27T00:00:05.000Z',
      ['running', 'repairing', 'waiting_review', 'waiting_human'],
    )).toEqual({ ok: false, reason: 'terminal_status', status });
  });
});
