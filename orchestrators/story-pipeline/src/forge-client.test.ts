import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '@forge-ai/adapters';
import { ForgeCliClient } from './forge-client.js';

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) {
    rmSync(file, { force: true });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeCli(): {
  cliEntryPath: string;
  invocationPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'forge-client-'));
  temporaryDirectories.push(directory);
  const cliEntryPath = join(directory, 'fake-cli.mjs');
  const invocationPath = join(directory, 'invocation.json');
  writeFileSync(
    cliEntryPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({`,
      '  execPath: process.execPath,',
      '  argv: process.argv.slice(2),',
      '}));',
      "process.stdout.write(JSON.stringify({ progress: 'created' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ case_id: 'case-fake-1' }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  return { cliEntryPath, invocationPath };
}

function createRunFakeCli(): {
  cliEntryPath: string;
  invocationPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'forge-client-run-'));
  temporaryDirectories.push(directory);
  const cliEntryPath = join(directory, 'fake-cli.mjs');
  const invocationPath = join(directory, 'invocation.json');
  writeFileSync(
    cliEntryPath,
    [
      "import { createHash } from 'node:crypto';",
      "import { writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      "const tokenIndex = argv.indexOf('--runner-token');",
      "const token = tokenIndex === -1 ? '' : argv[tokenIndex + 1];",
      'const redactedArgv = [...argv];',
      "if (tokenIndex !== -1) redactedArgv[tokenIndex + 1] = '[redacted]';",
      `writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({`,
      '  argv: redactedArgv,',
      "  tokenSha256: createHash('sha256').update(token).digest('hex'),",
      '}));',
      "process.stdout.write(JSON.stringify({ progress: 'running' }) + '\\n');",
      'process.stdout.write(JSON.stringify({',
      "  case_id: 'case-fake-run',",
      "  status: 'approved',",
      '  success: true,',
      "  final_artifact: { type: 'draft', version: 1, status: 'delivered', content: `content:${token}`, artifact_id: 'a1', version_id: 'v1' },",
      '  case_identity: null, execution_identity: null,',
      "  turns: { count: 1, items: [{ seq: 1, agent: token, tools: ['safe', token], produced: [] }] },",
      "  issues: [{ id: 'i1', severity: 'major', status: 'open', problem: `nested:${token}` }], gate: null, diff: null,",
      '  action_required: null, error: null,',
      "}) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  return { cliEntryPath, invocationPath };
}

function createAbortFakeCli(): {
  cliEntryPath: string;
  eventsPath: string;
  pidsPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'forge-client-abort-'));
  temporaryDirectories.push(directory);
  const cliEntryPath = join(directory, 'fake-cli.mjs');
  const eventsPath = join(directory, 'events.jsonl');
  const pidsPath = join(directory, 'pids.json');
  writeFileSync(
    cliEntryPath,
    [
      "import { createHash } from 'node:crypto';",
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      'const argv = process.argv.slice(2);',
      'const command = argv[1];',
      "const tokenIndex = argv.indexOf('--runner-token');",
      "const token = tokenIndex === -1 ? '' : argv[tokenIndex + 1];",
      "const tokenSha256 = createHash('sha256').update(token).digest('hex');",
      `const eventsPath = ${JSON.stringify(eventsPath)};`,
      `const pidsPath = ${JSON.stringify(pidsPath)};`,
      'const append = (value) => appendFileSync(eventsPath, JSON.stringify(value) + "\\n");',
      'const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };',
      "if (command === 'run') {",
      '  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      '  writeFileSync(pidsPath, JSON.stringify({ runPid: process.pid, descendantPid: descendant.pid }));',
      "  append({ command, tokenSha256 });",
      "  process.stdout.write(JSON.stringify({ progress: 'running' }) + '\\n');",
      '  setInterval(() => {}, 1000);',
      "} else if (command === 'abort') {",
      '  const pids = JSON.parse(readFileSync(pidsPath, "utf8"));',
      '  append({ command, tokenSha256, runAlive: alive(pids.runPid), descendantAlive: alive(pids.descendantPid) });',
      "  process.stdout.write(JSON.stringify({ case_id: 'case-fake-abort', status: 'stopped' }) + '\\n');",
      "} else if (command === 'status') {",
      "  append({ command });",
      "  const leakedToken = 'abort-runner-secret';",
      '  process.stdout.write(JSON.stringify({',
      "    case_id: 'case-fake-abort', status: 'stopped', success: false,",
      '    final_artifact: null, case_identity: null, execution_identity: null,',
      "    turns: { count: 1, items: [{ seq: 1, agent: leakedToken, tools: [leakedToken], produced: [] }] },",
      "    issues: [{ id: 'i1', severity: 'major', status: 'open', problem: `status:${leakedToken}` }], gate: null, diff: null,",
      "    action_required: null, error: `stopped:${leakedToken}`,",
      "  }) + '\\n');",
      '}',
    ].join('\n'),
    'utf8',
  );
  return { cliEntryPath, eventsPath, pidsPath };
}

function createCancellableCreateFakeCli(committed: boolean): {
  cliEntryPath: string;
  pidPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'forge-client-create-cancel-'));
  temporaryDirectories.push(directory);
  const cliEntryPath = join(directory, 'fake-cli.mjs');
  const pidPath = join(directory, 'create.pid');
  writeFileSync(
    cliEntryPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      committed
        ? "process.stdout.write(JSON.stringify({ case_id: 'case-create-committed' }) + '\\n');"
        : "process.stdout.write(JSON.stringify({ progress: 'before-commit' }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  return { cliEntryPath, pidPath };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function forceKillProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The production cancellation may already have removed the process group.
  }
}

function createHangingChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

function readWindowsCommandLine(pid: number): string {
  const script = [
    '$processId = [int]$env:FORGE_TEST_PROCESS_ID',
    '$process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"',
    'if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }',
  ].join('\n');
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      FORGE_TEST_PROCESS_ID: String(pid),
    },
  }).stdout;
}

describe('ForgeCliClient', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'keeps the %s handler installed across repeated signals until cleanup',
    async (signalName) => {
      const host = new EventEmitter();
      const controller = new AbortController();
      const module = await import('./forge-client.js') as unknown as {
        installAbortSignalHandlers: (
          abortController: AbortController,
          signalHost: EventEmitter,
        ) => () => void;
      };

      const cleanup = module.installAbortSignalHandlers(controller, host);
      host.emit(signalName);
      host.emit(signalName);

      expect(controller.signal.aborted).toBe(true);
      expect(host.listenerCount(signalName)).toBe(1);
      cleanup();
      expect(host.listenerCount(signalName)).toBe(0);
    },
  );

  it('creates a Case through the TypeScript CLI and passes immutable run bindings', async () => {
    const fake = createFakeCli();
    const client = new ForgeCliClient({
      repoRoot: resolve('.'),
      cliEntryPath: fake.cliEntryPath,
      maxOutputBytes: 4_096,
    });

    const caseId = await client.createCase({
      template: 'story-template',
      dbPath: 'forge.db',
      mode: 'fake',
      title: 'Bound story stage',
      inputFile: 'input.json',
      runId: 'run-1',
      storyId: 'story-1',
      stageKey: 'draft-c001',
      chapterId: 'c001',
    });

    expect(caseId).toBe('case-fake-1');
    expect(JSON.parse(readFileSync(fake.invocationPath, 'utf8'))).toEqual({
      execPath: process.execPath,
      argv: [
        'case', 'create',
        '--template', 'story-template',
        '--db', 'forge.db',
        '--mode', 'fake',
        '--title', 'Bound story stage',
        '--run-id', 'run-1',
        '--story-id', 'story-1',
        '--stage-key', 'draft-c001',
        '--chapter-id', 'c001',
      ],
    });
  });

  it.each([
    { committed: true, expectedCaseId: 'case-create-committed' },
    { committed: false, expectedCaseId: null },
  ])(
    'recovers only a committed Case ID when create cancellation committed=$committed',
    async ({ committed, expectedCaseId }) => {
      const fake = createCancellableCreateFakeCli(committed);
      const client = new ForgeCliClient({
        repoRoot: resolve('.'),
        cliEntryPath: fake.cliEntryPath,
        maxOutputBytes: 4_096,
      });
      const controller = new AbortController();
      const createPromise = client.createCase({
        template: 'story-template',
        dbPath: 'forge.db',
        mode: 'fake',
        title: 'Cancellation tracking',
        inputFile: 'input.json',
        runId: 'run-create-cancel',
        storyId: 'story-create-cancel',
        stageKey: 'draft-cancel',
        chapterId: null,
      }, controller.signal);
      await waitForFile(fake.pidPath);
      const pid = Number(readFileSync(fake.pidPath, 'utf8'));
      try {
        controller.abort();
        if (expectedCaseId) {
          await expect(createPromise).resolves.toBe(expectedCaseId);
        } else {
          await expect(createPromise).rejects.toMatchObject({ name: 'AbortError' });
        }
      } finally {
        forceKillProcessTree(pid);
      }
    },
  );

  it('reads the runner credential only for invocation and returns the final JSONL snapshot', async () => {
    const fake = createRunFakeCli();
    const credentialPath = join(
      mkdtempSync(join(tmpdir(), 'forge-client-credential-')),
      'runner-token',
    );
    temporaryDirectories.push(resolve(credentialPath, '..'));
    const runnerToken = 'runner-secret-value';
    writeFileSync(credentialPath, runnerToken, 'utf8');
    const client = new ForgeCliClient({
      repoRoot: resolve('.'),
      cliEntryPath: fake.cliEntryPath,
      maxOutputBytes: 4_096,
    });

    const snapshot = await client.runCase('case-fake-run', {
      dbPath: 'forge.db',
      mode: 'fake',
      runnerCredentialPath: credentialPath,
    });

    expect(snapshot).toMatchObject({
      case_id: 'case-fake-run',
      status: 'approved',
      success: true,
      final_artifact: { version_id: 'v1' },
    });
    expect(JSON.stringify(snapshot)).not.toContain(runnerToken);
    expect(snapshot.final_artifact?.content).toBe('content:[redacted]');
    expect(snapshot.turns.items[0]?.tools).toEqual(['safe', '[redacted]']);
    expect(JSON.parse(readFileSync(fake.invocationPath, 'utf8'))).toEqual({
      argv: [
        'case', 'run', 'case-fake-run',
        '--wait',
        '--db', 'forge.db',
        '--mode', 'fake',
        '--runner-token', '[redacted]',
      ],
      tokenSha256: createHash('sha256').update(runnerToken).digest('hex'),
    });
  });

  it.each(['stdout', 'stderr'] as const)(
    'bounds %s and never exposes a runner token in the error',
    async (stream) => {
      const directory = mkdtempSync(join(tmpdir(), `forge-client-${stream}-limit-`));
      temporaryDirectories.push(directory);
      const cliEntryPath = join(directory, 'fake-cli.mjs');
      const credentialPath = join(directory, 'runner-token');
      const runnerToken = 'bounded-output-secret';
      writeFileSync(credentialPath, runnerToken, 'utf8');
      writeFileSync(
        cliEntryPath,
        stream === 'stdout'
          ? "process.stdout.write('x'.repeat(8192));"
          : [
              'const argv = process.argv.slice(2);',
              "const index = argv.indexOf('--runner-token');",
              "process.stderr.write((argv[index + 1] + '|').repeat(1024));",
              'process.exitCode = 1;',
            ].join('\n'),
        'utf8',
      );
      const client = new ForgeCliClient({
        repoRoot: resolve('.'),
        cliEntryPath,
        maxOutputBytes: 128,
      });

      const error = await client.runCase('case-output-limit', {
        dbPath: 'forge.db',
        mode: 'fake',
        runnerCredentialPath: credentialPath,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `Forge CLI ${stream} exceeded the configured limit`,
      );
      expect((error as Error).message).not.toContain(runnerToken);
    },
  );

  it.runIf(process.platform === 'win32').each([
    {
      name: 'taskkill timeout',
      spawnTaskkill: () => createHangingChild(),
      taskkillTimeoutMs: 50,
      expected: 'timed out',
    },
    {
      name: 'taskkill nonzero exit',
      spawnTaskkill: () => spawn(process.execPath, ['-e', 'process.exit(7)'], {
        windowsHide: true,
        stdio: 'ignore',
      }),
      taskkillTimeoutMs: 500,
      expected: 'exit code 7',
    },
    {
      name: 'taskkill no-op success',
      spawnTaskkill: () => spawn(process.execPath, ['-e', 'process.exit(0)'], {
        windowsHide: true,
        stdio: 'ignore',
      }),
      taskkillTimeoutMs: 500,
      expected: 'child process exit timed out',
    },
  ])(
    'fails closed within a bound when $name cannot confirm tree cleanup',
    async ({ spawnTaskkill, taskkillTimeoutMs, expected }) => {
      const child = createHangingChild();
      const startedAt = Date.now();
      try {
        const module = await import('./forge-client.js') as unknown as {
          terminateProcessTree: (
            childProcess: ChildProcess,
            options: Record<string, unknown>,
          ) => Promise<void>;
        };
        await expect(module.terminateProcessTree(child, {
          platform: 'win32',
          taskkillTimeoutMs,
          childCloseTimeoutMs: 50,
          spawnTaskkill,
        })).rejects.toThrow(expected);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(child.pid && readWindowsCommandLine(child.pid)).not.toBe('');
      } finally {
        if (child.pid) forceKillProcessTree(child.pid);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not abort or query status when process-tree cleanup cannot be confirmed',
    async () => {
      const fake = createAbortFakeCli();
      const credentialDirectory = mkdtempSync(join(tmpdir(), 'forge-client-failed-kill-'));
      temporaryDirectories.push(credentialDirectory);
      const credentialPath = join(credentialDirectory, 'runner-token');
      writeFileSync(credentialPath, 'failed-kill-secret', 'utf8');
      const client = new ForgeCliClient({
        repoRoot: resolve('.'),
        cliEntryPath: fake.cliEntryPath,
        maxOutputBytes: 4_096,
        termination: {
          platform: 'win32',
          taskkillTimeoutMs: 500,
          childCloseTimeoutMs: 50,
          spawnTaskkill: () => spawn(
            process.execPath,
            ['-e', 'process.exit(0)'],
            { windowsHide: true, stdio: 'ignore' },
          ),
        },
      });
      const controller = new AbortController();
      const runPromise = client.runCase('case-fake-abort', {
        dbPath: 'forge.db',
        mode: 'fake',
        runnerCredentialPath: credentialPath,
      }, controller.signal);
      await waitForFile(fake.pidsPath);
      const pids = JSON.parse(readFileSync(fake.pidsPath, 'utf8')) as {
        runPid: number;
        descendantPid: number;
      };

      try {
        controller.abort();
        const error = await runPromise.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('child process exit timed out');
        expect((error as Error).message).not.toContain('failed-kill-secret');
        const events = readFileSync(fake.eventsPath, 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        expect(events.map((event) => event.command)).toEqual(['run']);
      } finally {
        forceKillProcessTree(pids.runPid);
        forceKillProcessTree(pids.descendantPid);
      }
    },
  );

  it('kills the exact process tree before aborting with the same token and then querying status', async () => {
    const fake = createAbortFakeCli();
    const credentialDirectory = mkdtempSync(join(tmpdir(), 'forge-client-abort-token-'));
    temporaryDirectories.push(credentialDirectory);
    const credentialPath = join(credentialDirectory, 'runner-token');
    const runnerToken = 'abort-runner-secret';
    const tokenSha256 = createHash('sha256').update(runnerToken).digest('hex');
    writeFileSync(credentialPath, runnerToken, 'utf8');
    const client = new ForgeCliClient({
      repoRoot: resolve('.'),
      cliEntryPath: fake.cliEntryPath,
      maxOutputBytes: 4_096,
    });
    const controller = new AbortController();

    const resultPromise = client.runCase('case-fake-abort', {
      dbPath: 'forge.db',
      mode: 'fake',
      runnerCredentialPath: credentialPath,
    }, controller.signal);
    await waitForFile(fake.pidsPath);
    const pids = JSON.parse(readFileSync(fake.pidsPath, 'utf8')) as {
      runPid: number;
      descendantPid: number;
    };

    try {
      controller.abort();
      await expect(resultPromise).resolves.toMatchObject({
        case_id: 'case-fake-abort',
        status: 'stopped',
        error: 'stopped:[redacted]',
      });
      const snapshot = await resultPromise;
      expect(JSON.stringify(snapshot)).not.toContain(runnerToken);
      const events = readFileSync(fake.eventsPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        { command: 'run', tokenSha256 },
        {
          command: 'abort',
          tokenSha256,
          runAlive: false,
          descendantAlive: false,
        },
        { command: 'status' },
      ]);
    } finally {
      forceKillProcessTree(pids.runPid);
      forceKillProcessTree(pids.descendantPid);
    }
  });

  it.runIf(process.platform === 'win32')(
    'stops a real FakePi CLI Case without leaving the direct CLI wrapper',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'forge-client-real-cli-'));
      temporaryDirectories.push(directory);
      const dbPath = join(directory, 'forge.db');
      const inputFile = join(directory, 'input.json');
      const credentialPath = join(directory, 'runner-token');
      const scenarioDirectory = join(directory, 'songwriting');
      const scenarioPath = join(scenarioDirectory, 'scenario.yaml');
      const validatorPath = join(scenarioDirectory, 'slow-validator.mjs');
      const validatorPidPath = join(directory, 'validator.pid');
      const runnerToken = 'real-cli-cancellation-secret';
      cpSync(resolve('scenarios/songwriting'), scenarioDirectory, { recursive: true });
      writeFileSync(
        scenarioPath,
        readFileSync(scenarioPath, 'utf8')
          .replace('  id: songwriting', `  id: ${JSON.stringify(scenarioPath)}`)
          .replace(
            '  deliverable_artifact_type: lyrics',
            [
              '  deliverable_artifact_type: lyrics',
              '  validators:',
              '    - id: slow-cancellation-probe',
              '      command: node',
              '      entrypoint: slow-validator.mjs',
              '      timeout_ms: 300000',
            ].join('\n'),
          ),
        'utf8',
      );
      writeFileSync(
        validatorPath,
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(validatorPidPath)}, String(process.pid));`,
          "setTimeout(() => process.stdout.write(JSON.stringify({ valid: true })), 60000);",
        ].join('\n'),
        'utf8',
      );
      writeFileSync(inputFile, JSON.stringify({
        reference_lyrics: 'reference',
        fixed_phrase: 'phrase',
      }), 'utf8');
      writeFileSync(credentialPath, runnerToken, 'utf8');
      const client = new ForgeCliClient({ repoRoot: resolve('.') });
      const caseId = await client.createCase({
        template: scenarioPath,
        dbPath,
        mode: 'fake',
        title: 'ForgeClient Windows cancellation',
        inputFile,
        runId: 'run-windows-cancel',
        storyId: 'story-windows-cancel',
        stageKey: 'draft-cancel',
        chapterId: 'cancel',
      });
      const logPath = resolve('data', `case-${caseId}.log`);
      temporaryFiles.push(logPath);
      const controller = new AbortController();
      const runPromise = client.runCase(caseId, {
        dbPath,
        mode: 'fake',
        runnerCredentialPath: credentialPath,
      }, controller.signal);
      const repo = new SqliteRepository(dbPath);
      let runnerPid = 0;
      let validatorPid = 0;

      try {
        await waitForFile(validatorPidPath);
        validatorPid = Number(readFileSync(validatorPidPath, 'utf8'));
        runnerPid = repo.getExecutionLease(caseId)?.runner_pid ?? 0;
        expect(runnerPid).toBeGreaterThan(0);
        expect(validatorPid).toBeGreaterThan(0);
        const activeCommandLine = readWindowsCommandLine(runnerPid);
        expect(activeCommandLine).toContain('apps\\cli\\src\\index.ts');
        expect(activeCommandLine).not.toContain('apps\\cli\\bin.js');
        expect(readWindowsCommandLine(validatorPid)).toContain('slow-validator.mjs');
        controller.abort();
        const snapshot = await runPromise;

        expect(snapshot).toMatchObject({ case_id: caseId, status: 'stopped' });
        expect(repo.getCase(caseId)?.status).toBe('stopped');
        expect(repo.getExecutionLease(caseId)).toBeNull();
        expect(readWindowsCommandLine(runnerPid)).toBe('');
        expect(readWindowsCommandLine(validatorPid)).toBe('');
        expect(readFileSync(dbPath).includes(Buffer.from(runnerToken))).toBe(false);
        if (existsSync(logPath)) {
          expect(readFileSync(logPath, 'utf8')).not.toContain(runnerToken);
        }
      } finally {
        repo.close();
        if (runnerPid > 0) forceKillProcessTree(runnerPid);
        if (validatorPid > 0) forceKillProcessTree(validatorPid);
      }
    },
    30_000,
  );
});
