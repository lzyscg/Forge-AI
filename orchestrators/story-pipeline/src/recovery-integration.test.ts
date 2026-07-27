import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from './hash.js';
import {
  initializeManifest,
  loadManifest,
  type StageAttemptV21,
} from './manifest.js';
import type { ForgeCaseSnapshot, ForgeClient } from './forge-client.js';
import { reconcileRun } from './index.js';

const temporaryDirectories: string[] = [];
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const cliEntry = resolve(import.meta.dirname, 'index.ts');

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function invoke(args: string[]) {
  return spawnSync(process.execPath, [
    '--import',
    'tsx/esm',
    cliEntry,
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
}

function unwrittenPaths() {
  const root = mkdtempSync(join(tmpdir(), 'forge-reconcile-parser-'));
  temporaryDirectories.push(root);
  return {
    root,
    config: join(root, 'missing-config.json'),
    runDir: join(root, 'must-not-exist'),
    db: join(root, 'must-not-exist.db'),
  };
}

describe('story-pipeline reconcile command parsing', () => {
  it.each([
    {
      name: 'missing config',
      error: 'reconcile requires --config, --run-dir, and --db',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--run-dir', paths.runDir, '--db', paths.db, '--dry-run',
      ],
    },
    {
      name: 'missing run directory',
      error: 'reconcile requires --config, --run-dir, and --db',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--db', paths.db, '--dry-run',
      ],
    },
    {
      name: 'missing database',
      error: 'reconcile requires --config, --run-dir, and --db',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--dry-run',
      ],
    },
    {
      name: 'neither dry-run nor apply',
      error: 'reconcile requires exactly one of --dry-run or --apply',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--db', paths.db,
      ],
    },
    {
      name: 'both dry-run and apply',
      error: 'reconcile requires exactly one of --dry-run or --apply',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--db', paths.db, '--dry-run', '--apply',
      ],
    },
    {
      name: 'apply-only flag in dry-run',
      error: 'reconcile attestation and adoption flags require --apply',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--db', paths.db, '--dry-run', '--adopt-case', 'case-1',
      ],
    },
    {
      name: 'unknown flag',
      error: 'unknown reconcile option: --mystery',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--db', paths.db, '--dry-run', '--mystery',
      ],
    },
    {
      name: 'attestation without an operator reason',
      error: 'reconcile attestation requires --attestation-reason',
      args: (paths: ReturnType<typeof unwrittenPaths>) => [
        'reconcile', '--config', paths.config, '--run-dir', paths.runDir,
        '--db', paths.db, '--apply', '--attest-template-compatibility',
      ],
    },
  ])('rejects $name before writing anything', ({ args, error }) => {
    const paths = unwrittenPaths();
    const result = invoke(args(paths));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(existsSync(paths.runDir)).toBe(false);
    expect(existsSync(paths.db)).toBe(false);
  });

  it('accepts a complete dry-run command and leaves the run directory byte-identical', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-reconcile-dry-run-'));
    temporaryDirectories.push(root);
    const runDir = join(root, 'run');
    const configPath = join(root, 'production-config.json');
    const dbPath = join(root, 'forge.db');
    const config = {
      run_id: 'run-1',
      story_id: 'story-1',
      title: 'Recovery fixture',
      mode: 'imitation',
      source_file: 'source.md',
      requirements: 'test only',
      chapters: [{ id: 'B001' }],
    };
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(configPath, configText, 'utf8');
    mkdirSync(runDir);
    initializeManifest(join(runDir, 'manifest.json'), () => ({
      schema_version: '2.1',
      revision: 0,
      previous_manifest_sha256: null,
      run_id: config.run_id,
      story_id: config.story_id,
      title: config.title,
      mode: config.mode,
      config_sha256: sha256(configText),
      boundary_map_path: 'structured/chapter-boundaries.json',
      boundary_map_sha256: 'boundary-sha256',
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
      attempts: [],
      stages: [],
      invalidations: [],
      reinstatements: [],
      replacements: [],
      events: [],
      final_artifact_path: null,
    }));
    const before = directorySnapshot(runDir);

    const result = invoke([
      'reconcile',
      '--config', configPath,
      '--run-dir', runDir,
      '--db', dbPath,
      '--dry-run',
      '--mode', 'fake',
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      success: true,
      dry_run: true,
      actions: [],
    });
    expect(directorySnapshot(runDir)).toEqual(before);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe('reconcile apply', () => {
  it('persists cleanup before adopting through the shared materializer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-reconcile-apply-'));
    temporaryDirectories.push(root);
    const runDir = join(root, 'run');
    const configPath = join(root, 'production-config.json');
    const inputPath = join(runDir, 'inputs', 'outline', 'outline-a2.json');
    const config = {
      run_id: 'run-1',
      story_id: 'story-1',
      title: 'Recovery fixture',
      mode: 'imitation',
      source_file: 'source.md',
      requirements: 'test only',
      chapters: [{ id: 'B001' }],
    } as const;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const input = { source_text: 'source' };
    const inputText = `${JSON.stringify(input, null, 2)}\n`;
    const inputSha = sha256(JSON.stringify(input));
    writeFileSync(configPath, configText, 'utf8');
    mkdirSync(join(runDir, 'inputs', 'outline'), { recursive: true });
    writeFileSync(inputPath, inputText, 'utf8');
    const attempts = [
      recoveryAttempt('case-failed', 'outline-a1', inputSha),
      recoveryAttempt('case-approved', 'outline-a2', inputSha),
    ];
    initializeManifest(join(runDir, 'manifest.json'), () => ({
      schema_version: '2.1',
      revision: 0,
      previous_manifest_sha256: null,
      run_id: config.run_id,
      story_id: config.story_id,
      title: config.title,
      mode: config.mode,
      config_sha256: sha256(configText),
      boundary_map_path: 'structured/chapter-boundaries.json',
      boundary_map_sha256: 'boundary-sha256',
      created_at: '2026-07-27T00:00:00.000Z',
      updated_at: '2026-07-27T00:00:00.000Z',
      attempts,
      stages: [],
      invalidations: [],
      reinstatements: [],
      replacements: [],
      events: [],
      final_artifact_path: null,
    }));
    const forge = new FakeForgeClient(new Map([
      ['case-failed', failedSnapshot('case-failed', inputSha)],
      ['case-approved', approvedRecoverySnapshot('case-approved', inputSha)],
    ]));

    const result = await reconcileRun({
      command: 'reconcile',
      configPath,
      runDir,
      dbPath: join(root, 'forge.db'),
      dryRun: false,
      attestTemplateCompatibility: false,
      attestLegacyCaseBindings: [],
    }, forge, new AbortController().signal, {
      outline: (rawContent) => ({
        canonicalContent: `${rawContent.trim()}\n`,
        report: {
          schema_version: '1.0',
          stage_key: 'outline',
          artifact_kind: 'outline',
          artifact_sha256: sha256(`${rawContent.trim()}\n`),
          valid: true,
          checks: [],
          errors: [],
          warnings: [],
          metrics: {},
        },
        sidecar: {
          schema_version: '1.0',
          artifact_kind: 'blueprint_bundle',
          artifact_sha256: sha256(`${rawContent.trim()}\n`),
        },
      }),
    });

    expect(result.actions.map((action) => action.action)).toEqual([
      'close',
      'adopt',
    ]);
    const manifest = loadManifest(join(runDir, 'manifest.json'));
    expect(manifest.attempts.map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'delivered',
    ]);
    expect(manifest.events.slice(-2).map((event) => event.type)).toEqual([
      'stage_failed',
      'stage_delivered',
    ]);
    expect(manifest.stages).toHaveLength(1);
    expect(manifest.stages[0]?.case_id).toBe('case-approved');
    expect(forge.runRequests).toEqual([]);
  });

  it('persists terminal cleanup before reporting live-case ambiguity', async () => {
    const fixture = applyFixture([
      recoveryAttempt('case-stopped', 'outline-a1', 'input-sha'),
      recoveryAttempt('case-running-1', 'outline-a2', 'input-sha'),
      recoveryAttempt('case-running-2', 'outline-a3', 'input-sha'),
    ]);
    const stopped = runningSnapshot('case-stopped', 'input-sha');
    stopped.status = 'stopped';
    const forge = new FakeForgeClient(new Map([
      ['case-stopped', stopped],
      ['case-running-1', runningSnapshot('case-running-1', 'input-sha')],
      ['case-running-2', runningSnapshot('case-running-2', 'input-sha')],
    ]));

    await expect(reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    )).rejects.toThrow('stage outline is ambiguous');

    const manifest = loadManifest(join(fixture.runDir, 'manifest.json'));
    expect(manifest.attempts.map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'interrupted',
      'interrupted',
    ]);
    expect(manifest.events.at(-1)?.type).toBe('stage_failed');
    expect(manifest.events.at(-1)?.case_id).toBe('case-stopped');
    expect(manifest.stages).toEqual([]);
  });

  it('requires an explicit mode only when a resume action would run', async () => {
    const candidate = recoveryAttempt('case-running', 'outline-a1', 'input-sha');
    const fixture = applyFixture([candidate]);
    persistFakeCredential(fixture.runDir, candidate);
    const forge = new FakeForgeClient(new Map([
      ['case-running', runningSnapshot('case-running', 'input-sha')],
    ]), new Map([
      ['case-running', failedSnapshot('case-running', 'input-sha')],
    ]));

    await expect(reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    )).rejects.toThrow('reconcile resume requires --mode fake|real');

    expect(forge.runRequests).toEqual([]);
  });

  it('passes the explicitly selected fake mode to resume without a real model', async () => {
    const candidate = recoveryAttempt('case-running', 'outline-a1', 'input-sha');
    const fixture = applyFixture([candidate]);
    persistFakeCredential(fixture.runDir, candidate);
    const forge = new FakeForgeClient(new Map([
      ['case-running', runningSnapshot('case-running', 'input-sha')],
    ]), new Map([
      ['case-running', failedSnapshot('case-running', 'input-sha')],
    ]));

    await reconcileRun({
      ...fixture.options,
      mode: 'fake',
    }, forge, new AbortController().signal);

    expect(forge.runRequests).toHaveLength(1);
    expect(forge.runRequests[0]?.request.mode).toBe('fake');
  });

  it('blocks waiting_human idempotently without calling runCase or deleting credentials', async () => {
    const candidate = recoveryAttempt('case-human', 'outline-a1', 'input-sha');
    const fixture = applyFixture([candidate]);
    const credentialPath = persistFakeCredential(fixture.runDir, candidate);
    const forge = new FakeForgeClient(
      new Map([['case-human', waitingHumanSnapshot('case-human', 'input-sha')]]),
      undefined,
      1,
    );

    await reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    );
    const first = loadManifest(join(fixture.runDir, 'manifest.json'));
    const eventCount = first.events.length;
    expect(first.attempts[0]?.outcome).toBe('blocked');
    expect(first.events.at(-1)?.type).toBe('stage_blocked');
    expect(existsSync(credentialPath)).toBe(true);

    await reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    );
    const second = loadManifest(join(fixture.runDir, 'manifest.json'));
    expect(second.events).toHaveLength(eventCount);
    expect(forge.runRequests).toEqual([]);
    expect(existsSync(credentialPath)).toBe(true);
  });

  it('fails closed when approved recovery input lacks validator evidence', async () => {
    const input = { source_text: 'source without chapter boundaries' };
    const inputSha = sha256(JSON.stringify(input));
    const candidate = recoveryAttempt('case-approved', 'outline-a1', inputSha);
    const fixture = applyFixture([candidate]);
    writeAttemptInput(fixture.runDir, candidate, input);
    const forge = new FakeForgeClient(new Map([
      ['case-approved', approvedRecoverySnapshot('case-approved', inputSha)],
    ]));

    await expect(reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    )).rejects.toThrow('outline recovery input is missing chapter_boundaries');

    expect(loadManifest(join(fixture.runDir, 'manifest.json')).stages).toEqual([]);
  });

  it('rebuilds packet sidecar fields through the normal packet validator', async () => {
    const boundary = {
      id: 'B001',
      sequence: 1,
      display: '01',
      source_label: null,
      content_start_offset: 0,
      content_end_offset: 6,
      boundary_signature: 'boundary-signature',
      segment_sha256: 'segment-sha',
      start_anchor: 'start',
      end_anchor: 'end',
      next_forbidden_action: null,
    };
    const input = {
      chapter_boundary: JSON.stringify(boundary),
      reference_chapter_text: 'reference source text',
    };
    const inputSha = sha256(JSON.stringify(input));
    const candidate = recoveryAttempt('case-packet', 'packet-b001-a1', inputSha);
    Object.assign(candidate, {
      stage_key: 'packet-b001',
      stage: 'chapter_packet',
      chapter_id: 'B001',
      template: 'zhihu-chapter-packet',
      expected_artifact_type: 'chapter_packet',
      input_path: 'inputs/packet-b001/packet-b001-a1.json',
    });
    const fixture = applyFixture([candidate]);
    writeAttemptInput(fixture.runDir, candidate, input);
    const packetFixture = JSON.parse(readFileSync(
      join(repoRoot, 'scenarios', 'zhihu-chapter-packet', 'fake-pi-script.json'),
      'utf8',
    )) as {
      turns: Array<{
        toolCalls: Array<{
          name: string;
          arguments: { content?: string };
        }>;
      }>;
    };
    const packetContent = packetFixture.turns
      .flatMap((turn) => turn.toolCalls)
      .find((call) => call.name === 'publish_artifact')
      ?.arguments.content;
    if (!packetContent) throw new Error('packet FakePi fixture has no artifact');
    const snapshot = approvedRecoverySnapshot('case-packet', inputSha);
    snapshot.case_identity!.scenario_id = 'zhihu-chapter-packet';
    snapshot.case_identity!.run_binding.stage_key = 'packet-b001';
    snapshot.case_identity!.run_binding.chapter_id = 'B001';
    snapshot.final_artifact!.type = 'chapter_packet';
    snapshot.final_artifact!.content = packetContent;
    const forge = new FakeForgeClient(new Map([['case-packet', snapshot]]));

    await reconcileRun(
      fixture.options,
      forge,
      new AbortController().signal,
    );

    const manifest = loadManifest(join(fixture.runDir, 'manifest.json'));
    const sidecar = JSON.parse(readFileSync(
      join(fixture.runDir, manifest.stages[0]!.sidecar_path),
      'utf8',
    )) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      artifact_kind: 'chapter_packet',
      chapter: {
        id: 'B001',
        boundary_signature: 'boundary-signature',
      },
    });
    expect(sidecar).toHaveProperty('length_budget');
    expect(sidecar).toHaveProperty('units');
  });

  it('fails a same-status resume loop after bounded no-progress detection', async () => {
    const candidate = recoveryAttempt('case-running', 'outline-a1', 'input-sha');
    const fixture = applyFixture([candidate]);
    persistFakeCredential(fixture.runDir, candidate);
    const running = runningSnapshot('case-running', 'input-sha');
    const forge = new FakeForgeClient(
      new Map([['case-running', running]]),
      new Map([['case-running', running]]),
      4,
    );

    await expect(reconcileRun({
      ...fixture.options,
      mode: 'fake',
    }, forge, new AbortController().signal)).rejects.toThrow(
      'reconciliation made no progress',
    );
    expect(forge.runRequests.length).toBeLessThanOrEqual(2);
  });
});

function directorySnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = path.slice(root.length + 1).replaceAll('\\', '/');
      if (statSync(path).isDirectory()) {
        result[`${relativePath}/`] = 'directory';
        visit(path);
      } else {
        result[relativePath] = readFileSync(path).toString('base64');
      }
    }
  };
  visit(root);
  return result;
}

const recoveryTemplateIdentity = {
  algorithm: 'source-tree-sha256-v2',
  content_sha256: 'bundle-sha256',
  equivalence: 'verified',
} as const;

function recoveryAttempt(
  caseId: string,
  attemptId: string,
  inputSha: string,
): StageAttemptV21 {
  return {
    attempt_id: attemptId,
    stage_key: 'outline',
    stage: 'outline',
    chapter_id: null,
    template: 'zhihu-story-outline',
    expected_artifact_type: 'blueprint_bundle',
    expected_scenario_snapshot_sha256: 'scenario-sha256',
    case_id: caseId,
    input_sha256: inputSha,
    parent_record_ids: [],
    template_identity: recoveryTemplateIdentity,
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome: 'interrupted',
    input_path: 'inputs/outline/outline-a2.json',
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    detail: null,
  };
}

function approvedRecoverySnapshot(
  caseId: string,
  inputSha: string,
): ForgeCaseSnapshot {
  return {
    case_id: caseId,
    status: 'approved',
    success: true,
    case_identity: {
      db_instance_id: 'db-1',
      scenario_id: 'zhihu-story-outline',
      scenario_snapshot_sha256: 'scenario-sha256',
      input_payload_sha256: inputSha,
      run_binding: {
        run_id: 'run-1',
        story_id: 'story-1',
        stage_key: 'outline',
        chapter_id: null,
      },
    },
    execution_identity: {
      template_bundle_sha256: recoveryTemplateIdentity.content_sha256,
      artifact_version_id: `${caseId}-v1`,
    },
    final_artifact: {
      type: 'blueprint_bundle',
      version: 1,
      status: 'delivered',
      content: '# recovered outline',
      artifact_id: `${caseId}-artifact`,
      version_id: `${caseId}-v1`,
    },
    turns: { count: 1, items: [] },
    issues: [],
    gate: {
      status: 'pass',
      artifact_version_id: `${caseId}-v1`,
      checks: [],
    },
    diff: null,
    action_required: null,
    error: null,
  };
}

function failedSnapshot(
  caseId: string,
  inputSha: string,
): ForgeCaseSnapshot {
  const snapshot = approvedRecoverySnapshot(caseId, inputSha);
  snapshot.status = 'failed';
  snapshot.success = false;
  snapshot.execution_identity = null;
  snapshot.final_artifact = null;
  snapshot.gate = null;
  return snapshot;
}

class FakeForgeClient implements ForgeClient {
  readonly runRequests: Array<{
    caseId: string;
    request: Parameters<ForgeClient['runCase']>[1];
  }> = [];

  constructor(
    private readonly snapshots: Map<string, ForgeCaseSnapshot>,
    private readonly runSnapshots = snapshots,
    private readonly maxRunCalls = Number.POSITIVE_INFINITY,
  ) {}

  async createCase(): Promise<string> {
    throw new Error('recovery must not create a new case');
  }

  async runCase(
    caseId: string,
    request: Parameters<ForgeClient['runCase']>[1],
  ): Promise<ForgeCaseSnapshot> {
    this.runRequests.push({ caseId, request });
    if (this.runRequests.length > this.maxRunCalls) {
      throw new Error('fake detected an unbounded resume loop');
    }
    const snapshot = this.runSnapshots.get(caseId);
    if (!snapshot) throw new Error(`missing fake run snapshot: ${caseId}`);
    this.snapshots.set(caseId, structuredClone(snapshot));
    return structuredClone(snapshot);
  }

  async getCaseStatus(caseId: string): Promise<ForgeCaseSnapshot> {
    const snapshot = this.snapshots.get(caseId);
    if (!snapshot) throw new Error(`missing fake snapshot: ${caseId}`);
    return structuredClone(snapshot);
  }

  async abortCase(): Promise<void> {
    throw new Error('abort was not expected');
  }
}

function runningSnapshot(
  caseId: string,
  inputSha: string,
): ForgeCaseSnapshot {
  const snapshot = approvedRecoverySnapshot(caseId, inputSha);
  snapshot.status = 'running';
  snapshot.success = false;
  snapshot.execution_identity = null;
  snapshot.final_artifact = null;
  snapshot.gate = null;
  return snapshot;
}

function waitingHumanSnapshot(
  caseId: string,
  inputSha: string,
): ForgeCaseSnapshot {
  const snapshot = runningSnapshot(caseId, inputSha);
  snapshot.status = 'waiting_human';
  return snapshot;
}

function applyFixture(attempts: StageAttemptV21[]): {
  runDir: string;
  options: Parameters<typeof reconcileRun>[0];
} {
  const root = mkdtempSync(join(tmpdir(), 'forge-reconcile-ambiguous-'));
  temporaryDirectories.push(root);
  const runDir = join(root, 'run');
  const configPath = join(root, 'production-config.json');
  const config = {
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'Recovery fixture',
    mode: 'imitation',
    source_file: 'source.md',
    requirements: 'test only',
    chapters: [{ id: 'B001' }],
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, configText, 'utf8');
  mkdirSync(runDir);
  initializeManifest(join(runDir, 'manifest.json'), () => ({
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: config.run_id,
    story_id: config.story_id,
    title: config.title,
    mode: config.mode,
    config_sha256: sha256(configText),
    boundary_map_path: 'structured/chapter-boundaries.json',
    boundary_map_sha256: 'boundary-sha256',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    attempts,
    stages: [],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  }));
  return {
    runDir,
    options: {
      command: 'reconcile',
      configPath,
      runDir,
      dbPath: join(root, 'forge.db'),
      dryRun: false,
      attestTemplateCompatibility: false,
      attestLegacyCaseBindings: [],
    },
  };
}

function persistFakeCredential(
  runDir: string,
  attempt: StageAttemptV21,
): string {
  const path = join(runDir, 'credentials', `${attempt.attempt_id}.token`);
  mkdirSync(join(runDir, 'credentials'), { recursive: true });
  writeFileSync(path, 'fake-runner-token', 'utf8');
  attempt.runner_credential_path = `credentials/${attempt.attempt_id}.token`;
  attempt.runner_token_sha256 = sha256('fake-runner-token');
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = loadManifest(manifestPath);
  const persisted = manifest.attempts.find(
    (candidate) => candidate.attempt_id === attempt.attempt_id,
  );
  if (!persisted) throw new Error('fixture attempt is missing');
  persisted.runner_credential_path = attempt.runner_credential_path;
  persisted.runner_token_sha256 = attempt.runner_token_sha256;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

function writeAttemptInput(
  runDir: string,
  attempt: StageAttemptV21,
  input: Record<string, unknown>,
): void {
  const path = join(runDir, attempt.input_path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
}
