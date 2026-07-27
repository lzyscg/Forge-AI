import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SqliteRepository } from '@forge-ai/adapters';
import { CaseService } from './case-service.js';

const now = '2026-07-27T00:00:01.000Z';

function buildService(): {
  repo: SqliteRepository;
  service: CaseService;
} {
  const repo = new SqliteRepository(':memory:');
  repo.insertCase({
    case_id: 'case-1',
    title: 'leased case',
    status: 'running',
    current_stage: 'init',
    scenario_snapshot: '{}',
    input_payload: '{}',
    created_at: now,
    updated_at: now,
    completed_at: null,
  });
  return {
    repo,
    service: new CaseService(
      repo,
      { now: () => now },
      { generate: () => 'unused' },
    ),
  };
}

describe('CaseService execution lease', () => {
  it('hashes runner tokens before acquiring and validating a lease', () => {
    const { repo, service } = buildService();
    const token = 'runner-token-plaintext';

    expect(service.acquireExecutionLease('case-1', token, 101)).toBe(true);
    expect(service.validateExecutionLease('case-1', token)).toBe(true);
    expect(repo.getExecutionLease('case-1')).toEqual({
      runner_token_sha256: createHash('sha256').update(token).digest('hex'),
      runner_pid: 101,
      runner_started_at: now,
      heartbeat_at: now,
    });
    expect(JSON.stringify(repo.getExecutionLease('case-1'))).not.toContain(token);
    repo.close();
  });

  it.each(['approved', 'failed', 'stopped'] as const)(
    'clears the lease after a normal transition to %s',
    (status) => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'runner-token', 101);

    service.transitionCaseStatus('case-1', status);

    expect(repo.getExecutionLease('case-1')).toBeNull();
    repo.close();
    },
  );

  it.each(['repairing', 'waiting_review', 'waiting_human'] as const)(
    'retains the lease when normal execution pauses in %s',
    (status) => {
      const { repo, service } = buildService();
      service.acquireExecutionLease('case-1', 'runner-token', 101);

      service.transitionCaseStatus('case-1', status);

      expect(service.validateExecutionLease('case-1', 'runner-token')).toBe(true);
      repo.close();
    },
  );

  it('transfers, heartbeats, and aborts only with the authorized plaintext token', () => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'old-token', 101);

    expect(service.transferExecutionLease(
      'case-1',
      'wrong-token',
      'new-token',
      202,
    )).toBe(false);
    expect(service.transferExecutionLease(
      'case-1',
      'old-token',
      'new-token',
      202,
    )).toBe(true);
    expect(service.heartbeatExecutionLease('case-1', 'old-token')).toBe(false);
    expect(service.heartbeatExecutionLease('case-1', 'new-token')).toBe(true);
    expect(() => service.abortCase('case-1', 'wrong-token'))
      .toThrow('Execution lease authorization failed');
    expect(service.abortCase('case-1', 'new-token')).toBe('stopped');
    expect(service.abortCase('case-1', 'new-token')).toBe('stopped');
    repo.close();
  });
});
