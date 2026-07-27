/**
 * Case 生命周期管理
 * 创建 Case（加载 YAML + 快照冻结）、启动、状态流转
 */

import { createHash } from 'node:crypto';
import type {
  ScenarioConfig,
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  CaseStatus,
  CaseRunBinding,
} from '@forge-ai/contracts';
import { transitionCase } from '@forge-ai/domain';

export interface CreateCaseInput {
  title: string;
  scenarioConfig: ScenarioConfig;
  inputPayload: Record<string, unknown>;
  runBinding?: CaseRunBinding;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class CaseService {
  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
    private idGen: IdGeneratorPort,
  ) {}

  createCase(input: CreateCaseInput): string {
    const caseId = this.idGen.generate('case');
    const now = this.clock.now();
    const scenarioSnapshot = JSON.stringify(input.scenarioConfig);
    const inputPayload = JSON.stringify(input.inputPayload);
    const runBinding = input.runBinding ?? {
      run_id: null,
      story_id: null,
      stage_key: null,
      chapter_id: null,
    };

    this.repo.insertCase({
      case_id: caseId,
      title: input.title,
      status: 'created' satisfies CaseStatus,
      current_stage: 'init',
      scenario_id: input.scenarioConfig.scenario.id,
      scenario_snapshot: scenarioSnapshot,
      input_payload: inputPayload,
      scenario_snapshot_sha256: sha256(canonicalJson(input.scenarioConfig)),
      input_payload_sha256: sha256(canonicalJson(input.inputPayload)),
      run_id: runBinding.run_id,
      story_id: runBinding.story_id,
      stage_key: runBinding.stage_key,
      chapter_id: runBinding.chapter_id,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    return caseId;
  }

  startCase(caseId: string): void {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);

    const newStatus = transitionCase(record.status as CaseStatus, 'running');
    this.repo.updateCase(caseId, {
      status: newStatus,
      updated_at: this.clock.now(),
    });
  }

  transitionCaseStatus(caseId: string, to: CaseStatus): void {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);

    const newStatus = transitionCase(record.status as CaseStatus, to);
    const fields: Record<string, unknown> = {
      status: newStatus,
      updated_at: this.clock.now(),
    };

    if (to === 'approved' || to === 'failed' || to === 'stopped') {
      fields.completed_at = this.clock.now();
    }

    this.repo.updateCase(caseId, fields);
  }

  getScenarioConfig(caseId: string): ScenarioConfig {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);
    return JSON.parse(record.scenario_snapshot as string) as ScenarioConfig;
  }

  getInputPayload(caseId: string): Record<string, unknown> {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);
    return JSON.parse(record.input_payload as string) as Record<string, unknown>;
  }
}
