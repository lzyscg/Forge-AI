import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeCaseSnapshot } from './forge-client.js';
import { sha256 } from './hash.js';
import type {
  PipelineManifestV21,
  StageAttemptV21,
  StageRecordV21,
} from './manifest.js';
import {
  materializeDeliveredArtifact,
  requireScenarioSnapshotIdentity,
  reconcileStage,
  type StagePlan,
} from './reconciliation.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const templateIdentity = {
  algorithm: 'source-tree-sha256-v2',
  content_sha256: 'bundle-sha256',
  equivalence: 'verified',
} as const;

const plan: StagePlan = {
  run_id: 'run-1',
  story_id: 'story-1',
  stage_key: 'draft-b001',
  stage: 'chapter_draft',
  chapter_id: 'B001',
  expected_artifact_type: 'chapter_draft',
  expected_scenario_snapshot_sha256: 'scenario-sha256',
  input_sha256: 'input-sha256',
  parent_record_ids: ['packet-b001-v1'],
  template_identity: templateIdentity,
};

function attempt(caseId: string, attemptId: string): StageAttemptV21 {
  return {
    attempt_id: attemptId,
    stage_key: plan.stage_key,
    stage: plan.stage,
    chapter_id: plan.chapter_id,
    template: 'zhihu-chapter-draft',
    expected_artifact_type: plan.expected_artifact_type,
    expected_scenario_snapshot_sha256:
      plan.expected_scenario_snapshot_sha256,
    case_id: caseId,
    input_sha256: plan.input_sha256,
    parent_record_ids: [...plan.parent_record_ids],
    template_identity: templateIdentity,
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome: 'interrupted',
    input_path: `inputs/${attemptId}.json`,
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    detail: null,
  };
}

function approvedSnapshot(caseId: string): ForgeCaseSnapshot {
  return {
    case_id: caseId,
    status: 'approved',
    success: true,
    case_identity: {
      db_instance_id: 'db-1',
      scenario_id: 'zhihu-chapter-draft',
      scenario_snapshot_sha256: 'scenario-sha256',
      input_payload_sha256: plan.input_sha256,
      run_binding: {
        run_id: plan.run_id,
        story_id: plan.story_id,
        stage_key: plan.stage_key,
        chapter_id: plan.chapter_id,
      },
    },
    execution_identity: {
      template_bundle_sha256: plan.template_identity.content_sha256,
      artifact_version_id: `${caseId}-artifact-v1`,
    },
    final_artifact: {
      type: plan.expected_artifact_type,
      version: 1,
      status: 'delivered',
      content: '# chapter',
      artifact_id: `${caseId}-artifact`,
      version_id: `${caseId}-artifact-v1`,
    },
    turns: { count: 1, items: [] },
    issues: [],
    gate: {
      status: 'pass',
      artifact_version_id: `${caseId}-artifact-v1`,
      checks: [],
    },
    diff: null,
    action_required: null,
    error: null,
  };
}

function runningSnapshot(caseId: string): ForgeCaseSnapshot {
  const snapshot = approvedSnapshot(caseId);
  snapshot.status = 'running';
  snapshot.success = false;
  snapshot.final_artifact = null;
  snapshot.gate = null;
  snapshot.execution_identity = null;
  return snapshot;
}

function parentRecord(): StageRecordV21 {
  return {
    record_id: 'packet-b001-v1',
    revision: 1,
    stage_key: 'packet-b001',
    stage: 'chapter_packet',
    chapter_id: 'B001',
    template: 'zhihu-chapter-packet',
    template_identity: templateIdentity,
    case_id: 'case-packet',
    parent_record_ids: [],
    parent_case_ids: [],
    status: 'delivered',
    input_path: 'inputs/packet.json',
    input_sha256: 'packet-input',
    raw_artifact_path: 'raw-artifacts/packet.md',
    raw_artifact_sha256: 'packet-raw',
    artifact_path: 'artifacts/packet.md',
    artifact_sha256: 'packet-artifact',
    sidecar_path: 'structured/packet.json',
    sidecar_sha256: 'packet-sidecar',
    validation_report_path: 'validation/packet.json',
    validation_report_sha256: 'packet-report',
    artifact_type: 'chapter_packet',
    artifact_version: 1,
    completed_at: '2026-07-27T00:00:00.000Z',
  };
}

function manifestWithParent(): PipelineManifestV21 {
  return {
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: plan.run_id,
    story_id: plan.story_id,
    title: 'Story',
    mode: 'imitation',
    config_sha256: 'config',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundaries',
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    attempts: [],
    stages: [parentRecord()],
    invalidations: [],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
}

function materializationFixture(): {
  runDirectory: string;
  plan: StagePlan;
  candidate: StageAttemptV21;
  snapshot: ForgeCaseSnapshot;
  manifest: PipelineManifestV21;
  validate: (content: string) => ReturnType<
    Parameters<typeof materializeDeliveredArtifact>[0]['validate']
  >;
} {
  const runDirectory = mkdtempSync(join(tmpdir(), 'forge-reconcile-'));
  temporaryDirectories.push(runDirectory);
  const input = { chapter: 'one' };
  const inputHash = sha256(JSON.stringify(input));
  const materializationPlan = { ...plan, input_sha256: inputHash };
  const candidate = attempt('case-adopt', 'draft-b001-a1');
  candidate.input_sha256 = inputHash;
  candidate.input_path = 'inputs/draft-b001-a1.json';
  const inputPath = join(runDirectory, candidate.input_path);
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  const snapshot = approvedSnapshot(candidate.case_id);
  snapshot.case_identity!.input_payload_sha256 = inputHash;
  const manifest = manifestWithParent();
  manifest.attempts.push(candidate);
  return {
    runDirectory,
    plan: materializationPlan,
    candidate,
    snapshot,
    manifest,
    validate: (content) => ({
      canonicalContent: `${content.trim()}\n`,
      report: {
        schema_version: '1.0',
        stage_key: plan.stage_key,
        artifact_kind: 'draft',
        artifact_sha256: sha256(`${content.trim()}\n`),
        valid: true,
        checks: [],
        errors: [],
        warnings: [],
        metrics: {},
      },
      sidecar: {
        schema_version: '1.0',
        artifact_kind: 'chapter_draft',
        artifact_sha256: sha256(`${content.trim()}\n`),
      },
    }),
  };
}

function materializedEvidencePaths(runDirectory: string): string[] {
  return [
    join(runDirectory, 'raw-artifacts/draft-b001/draft-b001-a1.md'),
    join(runDirectory, 'artifacts/draft-b001-v1.md'),
    join(runDirectory, 'structured/draft-b001-v1.json'),
    join(runDirectory, 'validation/draft-b001/draft-b001-a1.json'),
  ];
}

function allWorkspaceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('stage reconciliation', () => {
  it('reports ambiguity instead of selecting the newer of two matching cases', () => {
    const attempts = [
      attempt('case_4088', 'draft-b001-a4'),
      attempt('case_ed9', 'draft-b001-a5'),
    ];
    const snapshots = new Map(attempts.map((item) => [
      item.case_id,
      approvedSnapshot(item.case_id),
    ]));

    expect(reconcileStage(plan, attempts, snapshots)).toEqual([{
      action: 'ambiguous',
      stage_key: plan.stage_key,
      candidates: ['case_4088', 'case_ed9'],
    }]);
  });

  it('rejects a candidate whose Forge input identity differs from the plan', () => {
    const candidate = attempt('case_wrong_input', 'draft-b001-a1');
    const snapshot = approvedSnapshot(candidate.case_id);
    snapshot.case_identity!.input_payload_sha256 = 'other-input';

    expect(reconcileStage(
      plan,
      [candidate],
      new Map([[candidate.case_id, snapshot]]),
    )).toEqual([{
      action: 'reject',
      attempt_id: candidate.attempt_id,
      reason: 'Forge input payload identity does not match the stage plan',
    }]);
  });

  it('allows only an explicit case id to resolve otherwise ambiguous candidates', () => {
    const attempts = [
      attempt('case_4088', 'draft-b001-a4'),
      attempt('case_ed9', 'draft-b001-a5'),
    ];
    const snapshots = new Map(attempts.map((item) => [
      item.case_id,
      approvedSnapshot(item.case_id),
    ]));

    expect(reconcileStage(plan, attempts, snapshots, 'case_ed9')).toEqual([
      {
        action: 'close',
        attempt_id: 'draft-b001-a4',
        outcome: 'interrupted',
        reason: `Forge case was not selected for stage ${plan.stage_key}`,
      },
      {
        action: 'adopt',
        stage_key: plan.stage_key,
        attempt_id: 'draft-b001-a5',
        case_id: 'case_ed9',
      },
    ]);
  });

  it.each([
    {
      name: 'scenario snapshot identity',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.case_identity!.scenario_snapshot_sha256 = 'other-snapshot';
      },
      reason: 'Forge scenario snapshot identity does not match the stage plan',
    },
    {
      name: 'parent identity',
      mutate: (candidate: StageAttemptV21, _snapshot: ForgeCaseSnapshot) => {
        candidate.parent_record_ids = ['packet-b001-v0'];
      },
      reason: 'Attempt parent identity does not match the stage plan',
    },
    {
      name: 'scenario identity',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.case_identity!.scenario_id = 'other-scenario';
      },
      reason: 'Forge scenario or execution bundle does not match the stage plan',
    },
    {
      name: 'execution bundle identity',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.execution_identity!.template_bundle_sha256 = 'other-bundle';
      },
      reason: 'Forge scenario or execution bundle does not match the stage plan',
    },
    {
      name: 'artifact type',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.final_artifact!.type = 'other-artifact';
      },
      reason: 'Forge artifact type does not match the stage plan',
    },
    {
      name: 'gate version binding',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.gate!.artifact_version_id = 'other-version';
      },
      reason: 'Forge gate, execution, and artifact versions do not match',
    },
    {
      name: 'execution version binding',
      mutate: (_candidate: StageAttemptV21, snapshot: ForgeCaseSnapshot) => {
        snapshot.execution_identity!.artifact_version_id = 'other-version';
      },
      reason: 'Forge gate, execution, and artifact versions do not match',
    },
  ])('rejects a candidate with the wrong $name', ({ mutate, reason }) => {
    const candidate = attempt('case-invalid', 'draft-b001-a1');
    const snapshot = approvedSnapshot(candidate.case_id);
    mutate(candidate, snapshot);

    expect(reconcileStage(
      plan,
      [candidate],
      new Map([[candidate.case_id, snapshot]]),
    )).toEqual([{
      action: 'reject',
      attempt_id: candidate.attempt_id,
      reason,
    }]);
  });

  it.each([
    {
      name: 'legacy attempt scenario identity',
      mutate: (candidate: StageAttemptV21, _candidatePlan: StagePlan) => {
        candidate.expected_scenario_snapshot_sha256 = null;
      },
      reason: 'Attempt scenario snapshot identity is unavailable',
    },
    {
      name: 'legacy plan scenario identity',
      mutate: (_candidate: StageAttemptV21, candidatePlan: StagePlan) => {
        candidatePlan.expected_scenario_snapshot_sha256 = null;
      },
      reason: 'Stage plan scenario snapshot identity is unavailable',
    },
    {
      name: 'unknown attempt template equivalence',
      mutate: (candidate: StageAttemptV21, _candidatePlan: StagePlan) => {
        candidate.template_identity = {
          ...candidate.template_identity,
          equivalence: 'unknown',
        };
      },
      reason: 'Template identity equivalence is not attested',
    },
    {
      name: 'unknown plan template equivalence',
      mutate: (_candidate: StageAttemptV21, candidatePlan: StagePlan) => {
        candidatePlan.template_identity = {
          ...candidatePlan.template_identity,
          equivalence: 'unknown',
        };
      },
      reason: 'Template identity equivalence is not attested',
    },
  ])('fails closed for $name', ({ mutate, reason }) => {
    const candidatePlan = structuredClone(plan);
    const candidate = attempt('case-legacy', 'draft-b001-a1');
    const snapshot = approvedSnapshot(candidate.case_id);
    mutate(candidate, candidatePlan);

    expect(reconcileStage(
      candidatePlan,
      [candidate],
      new Map([[candidate.case_id, snapshot]]),
    )).toEqual([{
      action: 'reject',
      attempt_id: candidate.attempt_id,
      reason,
    }]);
  });

  it('accepts an exact operator-attested template identity', () => {
    const candidatePlan = structuredClone(plan);
    candidatePlan.template_identity.equivalence = 'operator_attested';
    const candidate = attempt('case-attested', 'draft-b001-a1');
    candidate.template_identity.equivalence = 'operator_attested';

    expect(reconcileStage(
      candidatePlan,
      [candidate],
      new Map([[candidate.case_id, approvedSnapshot(candidate.case_id)]]),
    )).toEqual([{
      action: 'adopt',
      stage_key: plan.stage_key,
      attempt_id: candidate.attempt_id,
      case_id: candidate.case_id,
    }]);
  });

  it('extracts the immutable scenario snapshot identity captured after create', () => {
    expect(requireScenarioSnapshotIdentity(
      approvedSnapshot('case-created'),
      'case-created',
    )).toBe('scenario-sha256');
  });

  it('rejects a create status response without immutable scenario identity', () => {
    const snapshot = approvedSnapshot('case-created');
    snapshot.case_identity = null;

    expect(() => requireScenarioSnapshotIdentity(
      snapshot,
      'case-created',
    )).toThrow('new Forge case has no immutable scenario snapshot identity');
  });

  it('closes a failed Forge case instead of treating it as an adoption candidate', () => {
    const candidate = attempt('case-failed', 'draft-b001-a1');
    const snapshot = approvedSnapshot(candidate.case_id);
    snapshot.status = 'failed';
    snapshot.success = false;
    snapshot.final_artifact = null;
    snapshot.gate = null;
    snapshot.execution_identity = null;

    expect(reconcileStage(
      plan,
      [candidate],
      new Map([[candidate.case_id, snapshot]]),
    )).toEqual([{
      action: 'close',
      attempt_id: candidate.attempt_id,
      outcome: 'failed',
      reason: 'Forge case is terminal with status failed',
    }]);
  });

  it('resumes an identity-matched nonterminal Forge case', () => {
    const candidate = attempt('case-running', 'draft-b001-a1');
    const snapshot = runningSnapshot(candidate.case_id);

    expect(reconcileStage(
      plan,
      [candidate],
      new Map([[candidate.case_id, snapshot]]),
    )).toEqual([{
      action: 'resume',
      attempt_id: candidate.attempt_id,
      case_id: candidate.case_id,
    }]);
  });

  it('retains terminal cleanup before the one approved-stage arbitration', () => {
    const stopped = attempt('case-stopped', 'draft-b001-a1');
    const approved = attempt('case-approved', 'draft-b001-a2');
    const stoppedSnapshot = runningSnapshot(stopped.case_id);
    stoppedSnapshot.status = 'stopped';

    expect(reconcileStage(
      plan,
      [stopped, approved],
      new Map([
        [stopped.case_id, stoppedSnapshot],
        [approved.case_id, approvedSnapshot(approved.case_id)],
      ]),
    )).toEqual([
      {
        action: 'close',
        attempt_id: stopped.attempt_id,
        outcome: 'failed',
        reason: 'Forge case is terminal with status stopped',
      },
      {
        action: 'adopt',
        stage_key: plan.stage_key,
        attempt_id: approved.attempt_id,
        case_id: approved.case_id,
      },
    ]);
  });

  it('reports one ambiguity instead of resuming two matching live cases', () => {
    const first = attempt('case-running-1', 'draft-b001-a1');
    const second = attempt('case-running-2', 'draft-b001-a2');

    expect(reconcileStage(
      plan,
      [first, second],
      new Map([
        [first.case_id, runningSnapshot(first.case_id)],
        [second.case_id, runningSnapshot(second.case_id)],
      ]),
    )).toEqual([{
      action: 'ambiguous',
      stage_key: plan.stage_key,
      candidates: ['case-running-1', 'case-running-2'],
    }]);
  });

  it('reports approved and running live cases as ambiguous competitors', () => {
    const approved = attempt('case-approved', 'draft-b001-a1');
    const running = attempt('case-running', 'draft-b001-a2');

    expect(reconcileStage(
      plan,
      [approved, running],
      new Map([
        [approved.case_id, approvedSnapshot(approved.case_id)],
        [running.case_id, runningSnapshot(running.case_id)],
      ]),
    )).toEqual([{
      action: 'ambiguous',
      stage_key: plan.stage_key,
      candidates: ['case-approved', 'case-running'],
    }]);
  });

  it('keeps ambiguity when the explicit case id is not a live candidate', () => {
    const approved = attempt('case-approved', 'draft-b001-a1');
    const running = attempt('case-running', 'draft-b001-a2');

    expect(reconcileStage(
      plan,
      [approved, running],
      new Map([
        [approved.case_id, approvedSnapshot(approved.case_id)],
        [running.case_id, runningSnapshot(running.case_id)],
      ]),
      'case-unknown',
    )).toEqual([{
      action: 'ambiguous',
      stage_key: plan.stage_key,
      candidates: ['case-approved', 'case-running'],
    }]);
  });

  it('closes every non-selected live attempt after explicit adoption', () => {
    const approved = attempt('case-approved', 'draft-b001-a1');
    const running = attempt('case-running', 'draft-b001-a2');

    expect(reconcileStage(
      plan,
      [approved, running],
      new Map([
        [approved.case_id, approvedSnapshot(approved.case_id)],
        [running.case_id, runningSnapshot(running.case_id)],
      ]),
      approved.case_id,
    )).toEqual([
      {
        action: 'close',
        attempt_id: running.attempt_id,
        outcome: 'interrupted',
        reason: `Forge case was not selected for stage ${plan.stage_key}`,
      },
      {
        action: 'adopt',
        stage_key: plan.stage_key,
        attempt_id: approved.attempt_id,
        case_id: approved.case_id,
      },
    ]);
  });

  it('materializes an adopted case once and returns the same record without rewriting', () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'forge-reconcile-'));
    temporaryDirectories.push(runDirectory);
    const input = { chapter: 'one' };
    const inputText = `${JSON.stringify(input, null, 2)}\n`;
    const inputHash = sha256(JSON.stringify(input));
    const materializationPlan = { ...plan, input_sha256: inputHash };
    const candidate = attempt('case-adopt', 'draft-b001-a1');
    candidate.input_sha256 = inputHash;
    candidate.input_path = 'inputs/draft-b001-a1.json';
    const inputPath = join(runDirectory, candidate.input_path);
    mkdirSync(dirname(inputPath), { recursive: true });
    writeFileSync(inputPath, inputText, 'utf8');
    const snapshot = approvedSnapshot(candidate.case_id);
    snapshot.case_identity!.input_payload_sha256 = inputHash;
    const manifest = manifestWithParent();
    manifest.attempts.push(candidate);

    const first = materializeDeliveredArtifact({
      run_dir: runDirectory,
      manifest,
      plan: materializationPlan,
      attempt: candidate,
      snapshot,
      validate: (content) => ({
        canonicalContent: `${content.trim()}\n`,
        report: {
          schema_version: '1.0',
          stage_key: plan.stage_key,
          artifact_kind: 'draft',
          artifact_sha256: sha256(`${content.trim()}\n`),
          valid: true,
          checks: [],
          errors: [],
          warnings: [],
          metrics: {},
        },
        sidecar: {
          schema_version: '1.0',
          artifact_kind: 'chapter_draft',
          artifact_sha256: sha256(`${content.trim()}\n`),
        },
      }),
      completed_at: '2026-07-27T01:00:00.000Z',
    });
    const artifactPath = join(runDirectory, first.artifact_path);
    const preservedTime = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(artifactPath, preservedTime, preservedTime);
    const eventCount = manifest.events.length;

    const second = materializeDeliveredArtifact({
      run_dir: runDirectory,
      manifest,
      plan: materializationPlan,
      attempt: candidate,
      snapshot,
      validate: () => {
        throw new Error('an idempotent repeat must not revalidate or rewrite');
      },
      completed_at: '2026-07-27T02:00:00.000Z',
    });

    expect(second).toBe(first);
    expect(manifest.stages.filter(
      (record) => record.stage_key === plan.stage_key,
    )).toEqual([first]);
    expect(manifest.events).toHaveLength(eventCount);
    expect(statSync(artifactPath).mtime.toISOString()).toBe(
      preservedTime.toISOString(),
    );
    expect(readFileSync(artifactPath, 'utf8')).toBe('# chapter\n');
  });

  it('fails closed when a declared parent record is invalidated', () => {
    const runDirectory = mkdtempSync(join(tmpdir(), 'forge-reconcile-'));
    temporaryDirectories.push(runDirectory);
    const candidate = attempt('case-adopt', 'draft-b001-a1');
    const manifest = manifestWithParent();
    manifest.invalidations.push({
      invalidation_id: 'inv-1',
      record_id: plan.parent_record_ids[0]!,
      stage_key: 'packet-b001',
      reason: 'source changed',
      root_record_id: plan.parent_record_ids[0]!,
      invalidated_at: '2026-07-27T00:30:00.000Z',
    });

    expect(() => materializeDeliveredArtifact({
      run_dir: runDirectory,
      manifest,
      plan,
      attempt: candidate,
      snapshot: approvedSnapshot(candidate.case_id),
      validate: () => {
        throw new Error('must not validate an artifact with invalid parents');
      },
      completed_at: '2026-07-27T01:00:00.000Z',
    })).toThrow('parent record is missing or invalidated: packet-b001-v1');
  });

  it('removes every temp and final when the third evidence write fails', () => {
    const fixture = materializationFixture();
    let writes = 0;

    expect(() => materializeDeliveredArtifact({
      run_dir: fixture.runDirectory,
      manifest: fixture.manifest,
      plan: fixture.plan,
      attempt: fixture.candidate,
      snapshot: fixture.snapshot,
      validate: fixture.validate,
      fs_ops: {
        writeFile: (path, content) => {
          writes += 1;
          if (writes === 3) throw new Error('injected third write failure');
          writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
        },
      },
    })).toThrow('injected third write failure');

    expect(fixture.manifest.stages).toEqual([parentRecord()]);
    expect(fixture.manifest.events).toEqual([]);
    expect(fixture.candidate.outcome).toBe('interrupted');
    expect(materializedEvidencePaths(fixture.runDirectory).some(existsSync)).toBe(false);
    expect(allWorkspaceFiles(fixture.runDirectory).some(
      (path) => path.endsWith('.tmp'),
    )).toBe(false);
  });

  it('rolls back already published finals when the third rename fails', () => {
    const fixture = materializationFixture();
    let renames = 0;

    expect(() => materializeDeliveredArtifact({
      run_dir: fixture.runDirectory,
      manifest: fixture.manifest,
      plan: fixture.plan,
      attempt: fixture.candidate,
      snapshot: fixture.snapshot,
      validate: fixture.validate,
      fs_ops: {
        rename: (from, to) => {
          renames += 1;
          if (renames === 3) throw new Error('injected third rename failure');
          renameSync(from, to);
        },
      },
    })).toThrow('injected third rename failure');

    expect(fixture.manifest.stages).toEqual([parentRecord()]);
    expect(fixture.manifest.events).toEqual([]);
    expect(fixture.candidate.outcome).toBe('interrupted');
    expect(materializedEvidencePaths(fixture.runDirectory).some(existsSync)).toBe(false);
    expect(allWorkspaceFiles(fixture.runDirectory).some(
      (path) => path.endsWith('.tmp'),
    )).toBe(false);
  });

  it('rejects a symlink or junction in any materialization path component', () => {
    const fixture = materializationFixture();
    const artifactsDirectory = join(fixture.runDirectory, 'artifacts');
    mkdirSync(artifactsDirectory, { recursive: true });

    expect(() => materializeDeliveredArtifact({
      run_dir: fixture.runDirectory,
      manifest: fixture.manifest,
      plan: fixture.plan,
      attempt: fixture.candidate,
      snapshot: fixture.snapshot,
      validate: fixture.validate,
      fs_ops: {
        lstat: (path) => path === artifactsDirectory
          ? { isSymbolicLink: () => true }
          : lstatSync(path),
      },
    })).toThrow('materialization path contains a symbolic link or reparse point');

    expect(materializedEvidencePaths(fixture.runDirectory).some(existsSync)).toBe(false);
  });

  it('rejects a materialization component whose real path escapes the run', () => {
    const fixture = materializationFixture();
    const artifactsDirectory = join(fixture.runDirectory, 'artifacts');
    mkdirSync(artifactsDirectory, { recursive: true });

    expect(() => materializeDeliveredArtifact({
      run_dir: fixture.runDirectory,
      manifest: fixture.manifest,
      plan: fixture.plan,
      attempt: fixture.candidate,
      snapshot: fixture.snapshot,
      validate: fixture.validate,
      fs_ops: {
        realpath: (path) => path === artifactsDirectory
          ? dirname(fixture.runDirectory)
          : realpathSync(path),
      },
    })).toThrow('materialization path resolves outside the run directory');

    expect(materializedEvidencePaths(fixture.runDirectory).some(existsSync)).toBe(false);
  });
});
