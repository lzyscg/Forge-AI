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
    status: 'created',
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
    service.startCase('case-1', 'runner-token');

    service.transitionCaseStatus('case-1', status, 'runner-token');

    expect(repo.getExecutionLease('case-1')).toBeNull();
    repo.close();
    },
  );

  it.each(['repairing', 'waiting_review', 'waiting_human'] as const)(
    'retains the lease when normal execution pauses in %s',
    (status) => {
      const { repo, service } = buildService();
      service.acquireExecutionLease('case-1', 'runner-token', 101);
      service.startCase('case-1', 'runner-token');

      service.transitionCaseStatus('case-1', status, 'runner-token');

      expect(service.validateExecutionLease('case-1', 'runner-token')).toBe(true);
      repo.close();
    },
  );

  it('transfers, heartbeats, and aborts only with the authorized plaintext token', () => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'old-token', 101);
    service.startCase('case-1', 'old-token');

    expect(service.transferExecutionLease(
      'case-1',
      'wrong-token',
      'new-token',
    )).toBe(false);
    expect(service.transferExecutionLease(
      'case-1',
      'old-token',
      'new-token',
    )).toBe(true);
    expect(repo.getExecutionLease('case-1')?.runner_pid).toBe(0);
    expect(service.claimExecutionLease('case-1', 'new-token', 202)).toBe(true);
    expect(service.claimExecutionLease('case-1', 'new-token', 303)).toBe(false);
    expect(service.heartbeatExecutionLease('case-1', 'old-token', 202)).toBe(false);
    expect(service.heartbeatExecutionLease('case-1', 'new-token', 303)).toBe(false);
    expect(service.heartbeatExecutionLease('case-1', 'new-token', 202)).toBe(true);
    expect(service.releaseExecutionLeaseOwner('case-1', 'new-token', 303)).toBe(false);
    expect(service.releaseExecutionLeaseOwner('case-1', 'new-token', 202)).toBe(true);
    expect(repo.getExecutionLease('case-1')?.runner_pid).toBe(0);
    expect(() => service.abortCase('case-1', 'wrong-token'))
      .toThrow('Execution lease authorization failed');
    expect(service.abortCase('case-1', 'new-token')).toBe('stopped');
    expect(service.abortCase('case-1', 'new-token')).toBe('stopped');
    repo.close();
  });

  it('stops a legacy case only when no execution lease exists', () => {
    const { repo, service } = buildService();

    service.acquireExecutionLease('case-1', 'runner-token', 101);
    expect(() => service.stopCaseWithoutLease('case-1'))
      .toThrow('Case state changed concurrently or execution lease exists');
    expect(repo.getCase('case-1')?.status).toBe('created');

    repo.clearExecutionLease('case-1');
    expect(service.stopCaseWithoutLease('case-1')).toBe('stopped');
    expect(repo.getCase('case-1')?.status).toBe('stopped');
    repo.close();
  });

  it('requires a matching lease token when one is supplied for a state commit', () => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'runner-token', 101);
    service.startCase('case-1', 'runner-token');

    expect(() => service.transitionCaseStatus(
      'case-1',
      'waiting_review',
      'wrong-token',
    )).toThrow('Case state changed concurrently or lease authorization failed');
    expect(repo.getCase('case-1')?.status).toBe('running');

    service.transitionCaseStatus('case-1', 'waiting_review', 'runner-token');
    expect(repo.getCase('case-1')?.status).toBe('waiting_review');
    repo.close();
  });

  it('accepts only the new token after an explicit lease transfer', () => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'old-token', 101);
    service.startCase('case-1', 'old-token');
    service.transferExecutionLease('case-1', 'old-token', 'new-token');

    expect(() => service.transitionCaseStatus('case-1', 'waiting_review'))
      .toThrow('Case state changed concurrently or lease authorization failed');
    expect(() => service.transitionCaseStatus(
      'case-1',
      'waiting_review',
      'old-token',
    )).toThrow('Case state changed concurrently or lease authorization failed');
    service.transitionCaseStatus('case-1', 'waiting_review', 'new-token');

    expect(repo.getCase('case-1')?.status).toBe('waiting_review');
    repo.close();
  });

  it('requires explicit transfer before a new pid can claim a crashed owner', () => {
    const { repo, service } = buildService();
    service.acquireExecutionLease('case-1', 'recovery-token', 101);
    service.startCase('case-1', 'recovery-token');

    expect(service.claimExecutionLease('case-1', 'recovery-token', 202))
      .toBe(false);
    expect(repo.getExecutionLease('case-1')?.runner_pid).toBe(101);

    expect(service.transferExecutionLease(
      'case-1',
      'recovery-token',
      'recovery-token',
    )).toBe(true);
    expect(repo.getExecutionLease('case-1')?.runner_pid).toBe(0);
    expect(service.claimExecutionLease('case-1', 'recovery-token', 202))
      .toBe(true);
    expect(repo.getExecutionLease('case-1')?.runner_pid).toBe(202);
    repo.close();
  });
});
