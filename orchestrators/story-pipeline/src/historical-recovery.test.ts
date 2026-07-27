import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CreateCaseRequest,
  ForgeCaseSnapshot,
  ForgeClient,
  RunCaseRequest,
} from './forge-client.js';
import {
  appendManifestEvent,
  loadManifest,
  type PipelineManifestV21,
  type StageAttemptV21,
  type StageRecordV21,
} from './manifest.js';
import { sha256 } from './hash.js';
import { recoverLegacyHistory } from './historical-recovery.js';
import type { ValidationResult } from './quality.js';
import { historicalRecoveryAttempt, reconcileRun } from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const legacyTemplate = (hash: string) => ({
  algorithm: 'legacy-unversioned-v1' as const,
  content_sha256: hash,
  equivalence: 'unknown' as const,
});

function writeEvidence(
  runDir: string,
  prefix: string,
  content: string,
): Pick<
  StageRecordV21,
  | 'raw_artifact_path'
  | 'raw_artifact_sha256'
  | 'artifact_path'
  | 'artifact_sha256'
  | 'sidecar_path'
  | 'sidecar_sha256'
  | 'validation_report_path'
  | 'validation_report_sha256'
> {
  const values = {
    raw_artifact_path: `raw/${prefix}.md`,
    raw_artifact_sha256: sha256(content),
    artifact_path: `artifacts/${prefix}.md`,
    artifact_sha256: sha256(content),
    sidecar_path: `structured/${prefix}.json`,
    sidecar_sha256: sha256('{}'),
    validation_report_path: `validation/${prefix}.json`,
    validation_report_sha256: sha256('{}'),
  };
  for (const [relativePath, body] of [
    [values.raw_artifact_path, content],
    [values.artifact_path, content],
    [values.sidecar_path, '{}'],
    [values.validation_report_path, '{}'],
  ]) {
    const path = join(runDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
  }
  return values;
}

function attempt(
  id: string,
  stageKey: string,
  caseId: string,
  inputSha: string,
  inputPath: string,
  templateHash: string,
  outcome: StageAttemptV21['outcome'],
): StageAttemptV21 {
  return {
    attempt_id: id,
    stage_key: stageKey,
    stage: stageKey === 'outline'
      ? 'outline'
      : stageKey.startsWith('packet-')
        ? 'chapter_packet'
        : 'chapter_draft',
    chapter_id: stageKey === 'outline' ? null : 'B001',
    template: stageKey === 'outline'
      ? 'zhihu-story-outline'
      : stageKey.startsWith('packet-')
        ? 'zhihu-chapter-packet'
        : 'zhihu-chapter-draft',
    expected_artifact_type: stageKey === 'outline'
      ? 'blueprint_bundle'
      : stageKey.startsWith('packet-')
        ? 'chapter_packet'
        : 'chapter_draft',
    expected_scenario_snapshot_sha256: null,
    case_id: caseId,
    input_sha256: inputSha,
    parent_record_ids: stageKey === 'outline'
      ? []
      : stageKey.startsWith('packet-')
        ? ['outline-v1']
        : ['packet-b001-v1'],
    template_identity: legacyTemplate(templateHash),
    runner_token_sha256: null,
    runner_credential_path: null,
    outcome,
    input_path: inputPath,
    raw_artifact_path: null,
    validation_report_path: null,
    started_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    detail: null,
  };
}

function snapshot(
  candidate: StageAttemptV21,
  content: string | null,
  status: 'approved' | 'stopped' = 'approved',
): ForgeCaseSnapshot {
  const delivered = status === 'approved';
  return {
    case_id: candidate.case_id,
    status,
    success: delivered,
    case_identity: null,
    execution_identity: null,
    legacy_case_evidence: {
      scenario_id: candidate.template,
      scenario_snapshot_sha256: `${candidate.case_id}-scenario`,
      input_payload_sha256: candidate.input_sha256,
      created_at: '2026-07-26T00:00:00.000Z',
      protocol_identity_absent: true,
    },
    final_artifact: delivered ? {
      type: candidate.expected_artifact_type,
      version: 1,
      status: 'delivered',
      content: content!,
      artifact_id: `${candidate.case_id}-artifact`,
      version_id: `${candidate.case_id}-version`,
    } : null,
    turns: { count: 1, items: [] },
    issues: [],
    gate: delivered ? {
      status: 'pass',
      artifact_version_id: `${candidate.case_id}-version`,
      checks: [],
    } : null,
    diff: null,
    action_required: null,
    error: null,
  };
}

function fixture() {
  const runDir = mkdtempSync(join(tmpdir(), 'forge-historical-recovery-'));
  roots.push(runDir);
  const outlineContent = '# outline\n';
  const packetContent = '# packet\n';
  const draftContent = '# draft\n';
  const outlineInput = { source_text: 'source' };
  const packetInput = { blueprint_bundle: outlineContent };
  const draftInput = { chapter_packet: packetContent };
  const inputs = [
    ['inputs/outline.json', outlineInput],
    ['inputs/packet.json', packetInput],
    ['inputs/packet-failed.json', {}],
    ['inputs/draft-a4.json', draftInput],
    ['inputs/draft-a5.json', draftInput],
    ['inputs/draft-a6.json', draftInput],
    ['inputs/draft-a2.json', draftInput],
  ] as const;
  for (const [relativePath, input] of inputs) {
    const path = join(runDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  }
  const outlineInputSha = sha256(JSON.stringify(outlineInput));
  const packetInputSha = sha256(JSON.stringify(packetInput));
  const draftInputSha = sha256(JSON.stringify(draftInput));
  const outlineAttempt = attempt(
    'outline-a1', 'outline', 'case-outline', outlineInputSha,
    'inputs/outline.json', 'outline-template', 'delivered',
  );
  const packetAttempt = attempt(
    'packet-a1', 'packet-b001', 'case-packet', packetInputSha,
    'inputs/packet.json', 'packet-template', 'delivered',
  );
  const failedPacketAttempt = attempt(
    'packet-a0', 'packet-b001', 'case-packet-failed',
    sha256(JSON.stringify({})), 'inputs/packet-failed.json',
    'packet-template-old', 'validation_failed',
  );
  const draftA4 = attempt(
    'draft-a4', 'draft-b001', 'case-draft-a4', draftInputSha,
    'inputs/draft-a4.json', 'draft-template-a4', 'running',
  );
  const draftA2 = attempt(
    'draft-a2', 'draft-b001', 'case-draft-a2', draftInputSha,
    'inputs/draft-a2.json', 'draft-template-a2', 'blocked',
  );
  const draftA5 = attempt(
    'draft-a5', 'draft-b001', 'case-draft-a5', draftInputSha,
    'inputs/draft-a5.json', 'draft-template-a5', 'interrupted',
  );
  const draftA6 = attempt(
    'draft-a6', 'draft-b001', 'case-draft-a6', draftInputSha,
    'inputs/draft-a6.json', 'draft-template-a6', 'running',
  );
  const outlineRecord: StageRecordV21 = {
    record_id: 'outline-v1',
    revision: 1,
    stage_key: 'outline',
    stage: 'outline',
    chapter_id: null,
    template: outlineAttempt.template,
    template_identity: outlineAttempt.template_identity,
    case_id: outlineAttempt.case_id,
    parent_record_ids: [],
    parent_case_ids: [],
    status: 'delivered',
    input_path: outlineAttempt.input_path,
    input_sha256: outlineInputSha,
    ...writeEvidence(runDir, 'outline-v1', outlineContent),
    artifact_type: 'blueprint_bundle',
    artifact_version: 1,
    completed_at: '2026-07-26T00:00:01.000Z',
  };
  const packetRecord: StageRecordV21 = {
    record_id: 'packet-b001-v1',
    revision: 1,
    stage_key: 'packet-b001',
    stage: 'chapter_packet',
    chapter_id: 'B001',
    template: packetAttempt.template,
    template_identity: packetAttempt.template_identity,
    case_id: packetAttempt.case_id,
    parent_record_ids: [outlineRecord.record_id],
    parent_case_ids: [outlineRecord.case_id],
    status: 'delivered',
    input_path: packetAttempt.input_path,
    input_sha256: packetInputSha,
    ...writeEvidence(runDir, 'packet-b001-v1', packetContent),
    artifact_type: 'chapter_packet',
    artifact_version: 1,
    completed_at: '2026-07-26T00:00:02.000Z',
  };
  const manifest: PipelineManifestV21 = {
    schema_version: '2.1',
    revision: 0,
    previous_manifest_sha256: null,
    run_id: 'run-1',
    story_id: 'story-1',
    title: 'Story',
    mode: 'imitation',
    config_sha256: 'config',
    boundary_map_path: 'structured/boundaries.json',
    boundary_map_sha256: 'boundaries',
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
    attempts: [
      outlineAttempt,
      failedPacketAttempt,
      packetAttempt,
      draftA2,
      draftA4,
      draftA5,
      draftA6,
    ],
    stages: [outlineRecord, packetRecord],
    invalidations: [
      {
        invalidation_id: 'inv-1',
        record_id: outlineRecord.record_id,
        stage_key: outlineRecord.stage_key,
        reason: 'historical mistake',
        root_record_id: outlineRecord.record_id,
        invalidated_at: '2026-07-26T00:00:03.000Z',
      },
      {
        invalidation_id: 'inv-2',
        record_id: packetRecord.record_id,
        stage_key: packetRecord.stage_key,
        reason: 'historical mistake',
        root_record_id: outlineRecord.record_id,
        invalidated_at: '2026-07-26T00:00:03.000Z',
      },
    ],
    reinstatements: [],
    replacements: [],
    events: [],
    final_artifact_path: null,
  };
  for (const candidate of manifest.attempts) {
    appendManifestEvent(manifest, {
      at: candidate.started_at,
      type: 'stage_started',
      stage_key: candidate.stage_key,
      attempt_id: candidate.attempt_id,
      before_outcome: null,
      after_outcome: 'running',
      case_id: candidate.case_id,
      artifact_id: null,
      artifact_version: null,
      version_id: null,
      record_id: null,
      reason: candidate.attempt_id,
      actor: 'story-pipeline',
    });
  }
  const snapshots = new Map<string, ForgeCaseSnapshot>([
    [outlineAttempt.case_id, snapshot(outlineAttempt, outlineContent)],
    [packetAttempt.case_id, snapshot(packetAttempt, packetContent)],
    [draftA4.case_id, snapshot(draftA4, draftContent)],
    [draftA2.case_id, {
      ...snapshot(draftA2, null, 'stopped'),
      status: 'waiting_human',
    }],
    [draftA5.case_id, snapshot(draftA5, draftContent)],
    [draftA6.case_id, snapshot(draftA6, null, 'stopped')],
  ]);
  const validate = (content: string): ValidationResult => ({
    canonicalContent: content,
    report: {
      schema_version: '1.0',
      stage_key: 'fixture',
      artifact_kind: 'draft',
      artifact_sha256: sha256(content),
      valid: true,
      checks: [],
      errors: [],
      warnings: [],
      metrics: {},
    },
    sidecar: {
      schema_version: '1.0',
      artifact_kind: 'fixture',
      artifact_sha256: sha256(content),
    },
  });
  return {
    runDir,
    manifest,
    snapshots,
    validate,
  };
}

describe('append-only historical recovery', () => {
  it('selects the Attempt bound to the delivered historical Stage Record', () => {
    const state = fixture();

    expect(historicalRecoveryAttempt(
      {
        chapters: [{ id: 'B001' }],
      } as never,
      state.manifest,
      'packet-b001',
    ).attempt_id).toBe('packet-a1');
  });

  it('dry-runs reinstatement and reports approved candidate ambiguity without writes', () => {
    const state = fixture();
    const before = JSON.stringify(state.manifest);

    const result = recoverLegacyHistory({
      run_dir: state.runDir,
      manifest: state.manifest,
      chapter_ids: ['B001'],
      snapshots: state.snapshots,
      apply: false,
      attest_template_compatibility: false,
      legacy_case_bindings: [],
      validators: {
        outline: state.validate,
        'packet-b001': state.validate,
        'draft-b001': state.validate,
      },
    });

    expect(result.actions.map(({ action }) => action)).toEqual([
      'attestation_required',
      'reinstate',
      'reinstate',
      'close',
      'close',
      'ambiguous',
    ]);
    expect(result.ambiguous).toEqual([{
      stage_key: 'draft-b001',
      candidates: ['case-draft-a4', 'case-draft-a5'],
    }]);
    expect(JSON.stringify(state.manifest)).toBe(before);
    expect(readFileSync(join(state.runDir, 'artifacts/outline-v1.md'), 'utf8'))
      .toBe('# outline\n');
  });

  it('applies one attested lineage and becomes a zero-action ledger handoff', () => {
    const state = fixture();

    const applied = recoverLegacyHistory({
      run_dir: state.runDir,
      manifest: state.manifest,
      chapter_ids: ['B001'],
      snapshots: state.snapshots,
      apply: true,
      adopt_case: 'case-draft-a5',
      attest_template_compatibility: true,
      legacy_case_bindings: ['case-draft-a5:draft-b001'],
      attestation_reason: 'operator compared immutable DB input and file evidence',
      validators: {
        outline: state.validate,
        'packet-b001': state.validate,
        'draft-b001': state.validate,
      },
      now: '2026-07-27T00:00:00.000Z',
    });

    expect(applied.ambiguous).toEqual([]);
    expect(applied.next_stage).toBe('ledger-b001');
    expect(applied.manifest.invalidations.map(({ invalidation_id }) =>
      invalidation_id)).toEqual(['inv-1', 'inv-2']);
    expect(applied.manifest.reinstatements).toHaveLength(2);
    expect(applied.manifest.reinstatements.every(
      ({ compatibility }) => compatibility === 'operator_attested',
    )).toBe(true);
    expect(applied.manifest.stages.map(({ record_id }) => record_id)).toEqual([
      'outline-v1',
      'packet-b001-v1',
      'outline-v2',
      'packet-b001-v2',
      'draft-b001-v1',
    ]);
    expect(applied.manifest.stages.slice(-3).every(
      (record) =>
        record.template_identity.equivalence === 'operator_attested'
        && record.legacy_binding_attestation?.reason
          === 'operator compared immutable DB input and file evidence',
    )).toBe(true);

    const repeated = recoverLegacyHistory({
      run_dir: state.runDir,
      manifest: applied.manifest,
      chapter_ids: ['B001'],
      snapshots: state.snapshots,
      apply: true,
      adopt_case: 'case-draft-a5',
      attest_template_compatibility: true,
      legacy_case_bindings: ['case-draft-a5:draft-b001'],
      attestation_reason: 'operator compared immutable DB input and file evidence',
      validators: {
        outline: state.validate,
        'packet-b001': state.validate,
        'draft-b001': state.validate,
      },
      now: '2026-07-27T00:00:00.000Z',
    });

    expect(repeated.actions).toEqual([]);
    expect(repeated.ambiguous).toEqual([]);
    expect(repeated.next_stage).toBe('ledger-b001');
    expect(repeated.manifest).toEqual(applied.manifest);
  });

  it('rejects mismatched legacy input evidence before mutating the Manifest', () => {
    const state = fixture();
    state.snapshots.get('case-draft-a5')!.legacy_case_evidence!
      .input_payload_sha256 = 'wrong-input';
    const before = JSON.stringify(state.manifest);

    expect(() => recoverLegacyHistory({
      run_dir: state.runDir,
      manifest: state.manifest,
      chapter_ids: ['B001'],
      snapshots: state.snapshots,
      apply: true,
      adopt_case: 'case-draft-a5',
      attest_template_compatibility: true,
      legacy_case_bindings: ['case-draft-a5:draft-b001'],
      attestation_reason: 'operator compared immutable DB input and file evidence',
      validators: {
        outline: state.validate,
        'packet-b001': state.validate,
        'draft-b001': state.validate,
      },
    })).toThrow('legacy Case input evidence does not match');
    expect(JSON.stringify(state.manifest)).toBe(before);
  });

  it('reconcileRun commits the attested recovery once without creating or running a Case', async () => {
    const state = fixture();
    const config = {
      run_id: state.manifest.run_id,
      story_id: state.manifest.story_id,
      title: state.manifest.title,
      mode: 'imitation',
      source_file: 'source.md',
      requirements: 'fixture',
      chapters: [{ id: 'B001', label: 'B001' }],
    };
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const configPath = join(state.runDir, 'config.json');
    writeFileSync(configPath, configText, 'utf8');
    state.manifest.config_sha256 = sha256(configText);
    writeFileSync(
      join(state.runDir, 'manifest.json'),
      `${JSON.stringify(state.manifest, null, 2)}\n`,
      'utf8',
    );
    let mutations = 0;
    const forge: ForgeClient = {
      createCase: async (_request: CreateCaseRequest) => {
        mutations += 1;
        throw new Error('createCase must not be called');
      },
      runCase: async (_caseId: string, _request: RunCaseRequest) => {
        mutations += 1;
        throw new Error('runCase must not be called');
      },
      getCaseStatus: async (caseId: string) => {
        const found = state.snapshots.get(caseId);
        if (!found) throw new Error(`missing fixture Case ${caseId}`);
        return structuredClone(found);
      },
      abortCase: async () => {
        mutations += 1;
        throw new Error('abortCase must not be called');
      },
    };
    const options = {
      command: 'reconcile' as const,
      configPath,
      runDir: state.runDir,
      dbPath: join(state.runDir, 'forge.db'),
      dryRun: false,
      adoptCase: 'case-draft-a5',
      attestTemplateCompatibility: true,
      attestLegacyCaseBindings: ['case-draft-a5:draft-b001'],
      attestationReason:
        'operator compared immutable DB input and file evidence',
    };
    const validators = {
      outline: state.validate,
      'packet-b001': state.validate,
      'draft-b001': state.validate,
    };

    const first = await reconcileRun(
      options,
      forge,
      new AbortController().signal,
      validators,
    );
    const afterFirst = loadManifest(join(state.runDir, 'manifest.json'));
    const second = await reconcileRun(
      options,
      forge,
      new AbortController().signal,
      validators,
    );
    const afterSecond = loadManifest(join(state.runDir, 'manifest.json'));

    expect(first.next_stage).toBe('ledger-b001');
    expect(first.actions.length).toBeGreaterThan(0);
    expect(afterFirst.revision).toBe(1);
    expect(second.actions).toEqual([]);
    expect(second.next_stage).toBe('ledger-b001');
    expect(afterSecond.revision).toBe(1);
    expect(mutations).toBe(0);
  });
});
