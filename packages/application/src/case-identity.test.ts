import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeScenarioBundleSha256,
  FakePiAdapter,
  FileConfigLoader,
  SqliteRepository,
  SystemClock,
  UuidGenerator,
} from '@forge-ai/adapters';
import type { PiToolDefinition, ScenarioConfig } from '@forge-ai/contracts';
import { CaseRunner, ToolExecutor, type Logger } from '@forge-ai/application';

const ORIGINAL_SCENARIO = {
  scenario: { id: 'identity-scenario', name: 'Identity scenario', version: 1 },
  input_fields: [
    { key: 'a', label: 'A' },
    { key: 'z', label: 'Z' },
  ],
  agents: [],
  start_agent: 'author',
  routes: [],
  context_rules: {},
  artifact_types: [{ type: 'draft', diff: 'line' }],
  delivery: { deliverable_artifact_type: 'draft' },
} satisfies ScenarioConfig;

const CHANGED_DISK_SCENARIO = {
  ...ORIGINAL_SCENARIO,
  scenario: { ...ORIGINAL_SCENARIO.scenario, version: 2 },
  artifact_types: [{ type: 'replacement', diff: 'line' }],
  delivery: { deliverable_artifact_type: 'replacement' },
} satisfies ScenarioConfig;

const NO_TOOLS: PiToolDefinition[] = [];
const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runner(
  repo: SqliteRepository,
  scenarioConfig: ScenarioConfig,
  templateBundleSha256: string,
  scenarioPath = 'changed-on-disk/scenario.yaml',
): CaseRunner {
  const pi = new FakePiAdapter();
  pi.registerScript(scenarioConfig.scenario.id, { turns: [] });
  return new CaseRunner({
    repo,
    clock: new SystemClock(),
    idGen: new UuidGenerator(),
    pi,
    scenarioConfig,
    scenarioPath,
    configLoader: new FileConfigLoader(),
    toolDefinitions: NO_TOOLS,
    logger,
    templateBundleSha256,
  });
}

describe('immutable Forge Case identity', () => {
  it('returns immutable input and scenario identity after the template directory changes', () => {
    const repo = new SqliteRepository(':memory:');
    const clock = new SystemClock();
    const idGen = new UuidGenerator();
    const scenarioDirectory = mkdtempSync(join(tmpdir(), 'forge-case-identity-'));
    temporaryDirectories.push(scenarioDirectory);
    const scenarioPath = join(scenarioDirectory, 'scenario.yaml');
    writeFileSync(scenarioPath, 'scenario: original\n', 'utf8');
    const createdBundleHash = computeScenarioBundleSha256(
      scenarioPath,
      ORIGINAL_SCENARIO,
    );
    const originalRunner = runner(
      repo,
      ORIGINAL_SCENARIO,
      createdBundleHash,
      scenarioPath,
    );
    const inputPayload = { z: 2, optional: undefined, a: 1 };
    const createdInputHash = createHash('sha256')
      .update('{"a":1,"optional":null,"z":2}')
      .digest('hex');
    const caseId = originalRunner.createCase({
      title: 'identity',
      inputPayload,
      runBinding: {
        run_id: 'run-7',
        story_id: 'story-3',
        stage_key: 'draft-c001',
        chapter_id: 'c001',
      },
    });
    const createdCase = repo.getCase(caseId)!;
    const createdSnapshotHash = createdCase.scenario_snapshot_sha256 as string;
    expect(createdCase.input_payload).toBe('{"z":2,"a":1}');
    expect(createdCase.input_payload).not.toContain('run-7');

    const executor = new ToolExecutor(repo, clock, idGen);
    const publish = executor.execute(
      'publish_artifact',
      { artifact_type: 'draft', content: 'immutable output', summary: 'v1' },
      {
        caseId,
        turnId: 'turn-1',
        sessionId: 'session-1',
        agentKey: 'author',
        messageId: 'message-1',
        scenarioConfig: ORIGINAL_SCENARIO,
        templateBundleSha256: createdBundleHash,
      },
    );
    const versionId = publish.artifact_version_id as string;
    repo.updateArtifactVersion(versionId, { status: 'approved' });
    executor.execute(
      'approve_delivery',
      { summary: 'deliver' },
      {
        caseId,
        turnId: 'turn-2',
        sessionId: 'session-1',
        agentKey: 'author',
        messageId: 'message-2',
        scenarioConfig: ORIGINAL_SCENARIO,
        templateBundleSha256: '2'.repeat(64),
      },
    );
    expect(repo.getArtifactVersion(versionId)?.template_bundle_sha256)
      .toBe(createdBundleHash);
    expect(repo.getDeliveryGateResults(caseId).at(-1)?.template_bundle_sha256)
      .toBe(createdBundleHash);

    writeFileSync(scenarioPath, 'scenario: changed\n', 'utf8');
    const changedBundleHash = computeScenarioBundleSha256(
      scenarioPath,
      CHANGED_DISK_SCENARIO,
    );
    expect(changedBundleHash).not.toBe(createdBundleHash);
    const status = runner(repo, CHANGED_DISK_SCENARIO, changedBundleHash, scenarioPath)
      .buildResultJson(caseId);

    expect(status.case_identity?.input_payload_sha256).toBe(createdInputHash);
    expect(status.case_identity?.scenario_snapshot_sha256).toBe(createdSnapshotHash);
    expect(status.case_identity?.scenario_id).toBe('identity-scenario');
    expect(status.case_identity?.run_binding).toEqual({
      run_id: 'run-7',
      story_id: 'story-3',
      stage_key: 'draft-c001',
      chapter_id: 'c001',
    });
    expect(status.case_identity?.db_instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(status.final_artifact?.type).toBe('draft');
    expect(status.execution_identity).toEqual({
      template_bundle_sha256: createdBundleHash,
      artifact_version_id: versionId,
    });
    expect(status.execution_identity?.artifact_version_id)
      .toBe(status.final_artifact?.version_id);
    expect(status.gate?.artifact_version_id).toBe(status.final_artifact?.version_id);
    repo.close();
  });

  it('returns null identities for legacy records instead of fabricating hashes', () => {
    const repo = new SqliteRepository(':memory:');
    repo.insertCase({
      case_id: 'legacy-case',
      title: 'legacy',
      status: 'created',
      current_stage: 'init',
      scenario_snapshot: JSON.stringify(ORIGINAL_SCENARIO),
      input_payload: '{"a":1,"z":2}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      completed_at: null,
    });

    const status = runner(repo, CHANGED_DISK_SCENARIO, '4'.repeat(64))
      .buildResultJson('legacy-case');

    expect(status.case_identity).toBeNull();
    expect(status.execution_identity).toBeNull();
    repo.close();
  });
});
