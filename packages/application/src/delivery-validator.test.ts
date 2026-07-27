import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository, SystemClock, UuidGenerator } from '@forge-ai/adapters';
import { ToolExecutor } from './tool-executor.js';
import type {
  ArtifactValidatorPort,
  ScenarioConfig,
} from '@forge-ai/contracts';

const SCENARIO = {
  scenario: { id: 'validator-test', name: 'Validator test', version: 1 },
  input_fields: [{ key: 'constraints', label: 'Constraints' }],
  agents: [],
  start_agent: 'reviewer',
  routes: [],
  context_rules: {},
  artifact_types: [{ type: 'draft', diff: 'line' }],
  delivery: {
    deliverable_artifact_type: 'draft',
    validators: [{
      id: 'surface',
      command: 'node',
      entrypoint: 'validators/surface.mjs',
      args: [],
      timeout_ms: 5_000,
    }],
  },
} satisfies ScenarioConfig;

describe('scenario-owned delivery validators', () => {
  let repo: SqliteRepository;
  let clock: SystemClock;
  let idGen: UuidGenerator;

  beforeEach(() => {
    repo = new SqliteRepository(':memory:');
    clock = new SystemClock();
    idGen = new UuidGenerator();
    repo.insertCase({
      case_id: 'case_validator',
      title: 't',
      status: 'running',
      current_stage: 'review',
      scenario_id: SCENARIO.scenario.id,
      scenario_snapshot: JSON.stringify(SCENARIO),
      input_payload: JSON.stringify({ constraints: '900–1200 Chinese characters' }),
      created_at: clock.now(),
      updated_at: clock.now(),
      completed_at: null,
    });
    repo.insertArtifact({
      artifact_id: 'art_validator',
      case_id: 'case_validator',
      artifact_type: 'draft',
      scope_key: null,
      current_valid_version_id: 'av_validator',
      status: 'active',
      created_at: clock.now(),
    });
    repo.insertArtifactVersion({
      artifact_version_id: 'av_validator',
      artifact_id: 'art_validator',
      version: 1,
      content: 'too short',
      summary: 'candidate',
      source_message_id: null,
      source_turn_id: null,
      parent_version_id: null,
      diff: null,
      content_hash: 'hash',
      status: 'approved',
      approved_at: clock.now(),
      created_at: clock.now(),
    });
  });

  it('blocks delivery and persists the scenario validator failure', () => {
    const validator: ArtifactValidatorPort = {
      validate: (request) => ({
        passed: false,
        detail: `length 9 violates ${String(request.inputPayload.constraints)}`,
      }),
    };
    const executor = new ToolExecutor(repo, clock, idGen, validator);

    const result = executor.execute(
      'approve_delivery',
      { summary: 'deliver' },
      {
        caseId: 'case_validator',
        turnId: 'turn_validator',
        sessionId: 'session_validator',
        agentKey: 'reviewer',
        messageId: 'message_validator',
        scenarioConfig: SCENARIO,
      },
    );

    expect(result.gate_passed).toBe(false);
    expect(result.checks).toContainEqual({
      check: 'scenario_validator:surface',
      passed: false,
      detail: 'length 9 violates 900–1200 Chinese characters',
    });
    expect(repo.getArtifactVersion('av_validator')?.status).toBe('approved');
    const gates = repo.getDeliveryGateResults('case_validator');
    expect(gates).toHaveLength(1);
    expect(gates[0].status).toBe('fail');
  });

  it('fails closed when a configured validator runtime is unavailable', () => {
    const executor = new ToolExecutor(repo, clock, idGen);

    const result = executor.execute(
      'approve_delivery',
      { summary: 'deliver' },
      {
        caseId: 'case_validator',
        turnId: 'turn_validator',
        sessionId: 'session_validator',
        agentKey: 'reviewer',
        messageId: 'message_validator',
        scenarioConfig: SCENARIO,
      },
    );

    expect(result.gate_passed).toBe(false);
    expect((result.checks as Array<{ check: string; passed: boolean }>)).toContainEqual(
      expect.objectContaining({
        check: 'scenario_validator:surface',
        passed: false,
      }),
    );
  });
});
