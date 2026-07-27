import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfigLoader, SqliteRepository } from '@forge-ai/adapters';
import { CaseService } from '@forge-ai/application';

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];
const now = '2026-07-27T00:00:01.000Z';

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) {
    rmSync(file, { force: true });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabase(): { dbPath: string; repo: SqliteRepository; service: CaseService } {
  const directory = mkdtempSync(join(tmpdir(), 'forge-cli-abort-'));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, 'forge.db');
  const repo = new SqliteRepository(dbPath);
  return {
    dbPath,
    repo,
    service: new CaseService(
      repo,
      { now: () => now },
      { generate: () => 'unused' },
    ),
  };
}

function insertCase(repo: SqliteRepository, caseId: string): void {
  repo.insertCase({
    case_id: caseId,
    title: 'CLI lease integration',
    status: 'created',
    current_stage: 'init',
    scenario_snapshot: '{}',
    input_payload: '{}',
    created_at: now,
    updated_at: now,
    completed_at: null,
  });
}

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', resolve('apps/cli/src/index.ts'), ...args],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

describe('leased case CLI', () => {
  it.each(['run', 'resume'])(
    'requires --runner-token for case %s',
    (command) => {
      const args = command === 'resume'
        ? ['case', command, 'missing-case', '--answer', 'continue']
        : ['case', command, 'missing-case'];
      const result = runCli(args);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("required option '--runner-token <uuid>' not specified");
    },
  );

  it('runs through the real CLI process with FakePi and persists only the token hash', () => {
    const { dbPath, repo } = createDatabase();
    const caseId = 'case-cli-fake-pi-lease';
    const scenarioPath = resolve('scenarios/songwriting/scenario.yaml');
    const scenarioConfig = new FileConfigLoader().loadScenario(scenarioPath);
    const logPath = resolve('data', `case-${caseId}.log`);
    temporaryFiles.push(logPath);
    repo.insertCase({
      case_id: caseId,
      title: 'CLI FakePi lease',
      status: 'created',
      current_stage: 'init',
      scenario_id: scenarioConfig.scenario.id,
      scenario_snapshot: JSON.stringify(scenarioConfig),
      input_payload: JSON.stringify({
        reference_lyrics: 'reference',
        fixed_phrase: 'phrase',
      }),
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
    repo.close();

    const token = 'run-secret-token';
    const result = runCli([
      'case', 'run', caseId,
      '--runner-token', token,
      '--max-turns', '0',
      '--mode', 'fake',
      '--db', dbPath,
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ case_id: caseId });
    expect(lines[1]).toMatchObject({ case_id: caseId, status: 'running' });
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readFileSync(dbPath).includes(Buffer.from(token))).toBe(false);
    expect(readFileSync(logPath, 'utf8')).not.toContain(token);

    const reopened = new SqliteRepository(dbPath);
    expect(reopened.getExecutionLease(caseId)?.runner_token_sha256)
      .toMatch(/^[a-f0-9]{64}$/);
    reopened.close();
  });

  it('aborts a leased running case only with the matching token without leaking it', () => {
    const { dbPath, repo, service } = createDatabase();
    insertCase(repo, 'case-running');
    service.acquireExecutionLease('case-running', 'authorized-secret-token', 101);
    service.startCase('case-running', 'authorized-secret-token');
    repo.close();

    const rejected = runCli([
      'case', 'abort', 'case-running',
      '--runner-token', 'wrong-secret-token',
      '--db', dbPath,
    ]);
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain('wrong-secret-token');

    const aborted = runCli([
      'case', 'abort', 'case-running',
      '--runner-token', 'authorized-secret-token',
      '--db', dbPath,
    ]);
    expect(aborted.status, `${aborted.stdout}\n${aborted.stderr}`).toBe(0);
    expect(aborted.stdout.trim()).toBe(
      JSON.stringify({ case_id: 'case-running', status: 'stopped' }),
    );
    expect(`${aborted.stdout}${aborted.stderr}`).not.toContain('authorized-secret-token');

    const repeated = runCli([
      'case', 'abort', 'case-running',
      '--runner-token', 'authorized-secret-token',
      '--db', dbPath,
    ]);
    expect(repeated.status, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
    expect(repeated.stdout.trim()).toBe(aborted.stdout.trim());

    const wrongRepeated = runCli([
      'case', 'abort', 'case-running',
      '--runner-token', 'wrong-secret-token',
      '--db', dbPath,
    ]);
    expect(wrongRepeated.status).not.toBe(0);
    expect(JSON.parse(wrongRepeated.stdout)).toEqual({
      error: 'Execution lease authorization failed',
    });

    const reopened = new SqliteRepository(dbPath);
    expect(reopened.getCase('case-running')?.status).toBe('stopped');
    expect(reopened.getExecutionLease('case-running')).toBeNull();
    reopened.close();
  });

  it('transfers the lease atomically and rejects a stale old token', () => {
    const { dbPath, repo, service } = createDatabase();
    insertCase(repo, 'case-transfer');
    service.acquireExecutionLease('case-transfer', 'old-secret-token', 101);
    service.startCase('case-transfer', 'old-secret-token');
    repo.close();

    const wrongTransfer = runCli([
      'case', 'transfer-lease', 'case-transfer',
      '--old-runner-token', 'wrong-secret-token',
      '--new-runner-token', 'new-secret-token',
      '--db', dbPath,
    ]);
    expect(wrongTransfer.status).not.toBe(0);

    const transferred = runCli([
      'case', 'transfer-lease', 'case-transfer',
      '--old-runner-token', 'old-secret-token',
      '--new-runner-token', 'new-secret-token',
      '--db', dbPath,
    ]);
    expect(transferred.status, `${transferred.stdout}\n${transferred.stderr}`).toBe(0);
    expect(transferred.stdout.trim()).toBe(
      JSON.stringify({ case_id: 'case-transfer', lease_transferred: true }),
    );
    expect(`${transferred.stdout}${transferred.stderr}`)
      .not.toMatch(/old-secret-token|new-secret-token/);

    const stale = runCli([
      'case', 'abort', 'case-transfer',
      '--runner-token', 'old-secret-token',
      '--db', dbPath,
    ]);
    expect(stale.status).not.toBe(0);

    const authorized = runCli([
      'case', 'abort', 'case-transfer',
      '--runner-token', 'new-secret-token',
      '--db', dbPath,
    ]);
    expect(authorized.status, `${authorized.stdout}\n${authorized.stderr}`).toBe(0);
  });

  it.each(['approved', 'failed'] as const)(
    'rejects abort for a terminal %s case',
    (terminalStatus) => {
      const { dbPath, repo } = createDatabase();
      insertCase(repo, `case-${terminalStatus}`);
      repo.updateCase(`case-${terminalStatus}`, { status: terminalStatus });
      repo.close();

      const result = runCli([
        'case', 'abort', `case-${terminalStatus}`,
        '--runner-token', 'unused-secret-token',
        '--db', dbPath,
      ]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        error: `Cannot abort terminal case: ${terminalStatus}`,
      });
    },
  );

  it('does not let legacy case stop bypass an active lease', () => {
    const { dbPath, repo, service } = createDatabase();
    insertCase(repo, 'case-leased-wait');
    service.acquireExecutionLease('case-leased-wait', 'stop-secret-token', 101);
    service.startCase('case-leased-wait', 'stop-secret-token');
    service.transitionCaseStatus(
      'case-leased-wait',
      'waiting_review',
      'stop-secret-token',
    );
    repo.close();

    const result = runCli(['case', 'stop', 'case-leased-wait', '--db', dbPath]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: 'Cannot stop a leased case. Use case abort with the matching runner token.',
    });

    const reopened = new SqliteRepository(dbPath);
    expect(reopened.getCase('case-leased-wait')?.status).toBe('waiting_review');
    expect(reopened.getExecutionLease('case-leased-wait')).not.toBeNull();
    reopened.close();
  });
});
