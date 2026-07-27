import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('SQLite execution lease', () => {
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
      '2026-07-27T00:00:03.000Z',
    )).toBe(false);
    expect(repo.heartbeatExecutionLease(
      'case-1',
      replacementHash,
      '2026-07-27T00:00:04.000Z',
    )).toBe(true);
    expect(repo.getExecutionLease('case-1')).toEqual({
      runner_token_sha256: replacementHash,
      runner_pid: 202,
      runner_started_at: '2026-07-27T00:00:02.000Z',
      heartbeat_at: '2026-07-27T00:00:04.000Z',
    });
  });

  it.each(['running', 'repairing', 'waiting_review', 'waiting_human'] as const)(
    'atomically aborts %s, clears its lease, and accepts only the same token on retry',
    (status) => {
      const repo = openRepository(':memory:');
      insertCase(repo, status);
      const hash = 'a'.repeat(64);
      repo.acquireExecutionLease('case-1', {
        runner_token_sha256: hash,
        runner_pid: 101,
        runner_started_at: '2026-07-27T00:00:01.000Z',
        heartbeat_at: '2026-07-27T00:00:01.000Z',
      });

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
    insertCase(repo, status);
    const hash = 'a'.repeat(64);
    repo.acquireExecutionLease('case-1', {
      runner_token_sha256: hash,
      runner_pid: 101,
      runner_started_at: '2026-07-27T00:00:01.000Z',
      heartbeat_at: '2026-07-27T00:00:01.000Z',
    });

    expect(repo.abortCaseWithExecutionLease(
      'case-1',
      hash,
      '2026-07-27T00:00:05.000Z',
      ['running', 'repairing', 'waiting_review', 'waiting_human'],
    )).toEqual({ ok: false, reason: 'terminal_status', status });
  });
});
