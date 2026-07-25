/**
 * Case 生命周期管理
 * 创建 Case（加载 YAML + 快照冻结）、启动、状态流转
 */

import type {
  ScenarioConfig,
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  CaseStatus,
} from '@forge-ai/contracts';
import { transitionCase } from '@forge-ai/domain';

export interface CreateCaseInput {
  title: string;
  scenarioConfig: ScenarioConfig;
  inputPayload: Record<string, unknown>;
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

    this.repo.insertCase({
      case_id: caseId,
      title: input.title,
      status: 'created' satisfies CaseStatus,
      current_stage: 'init',
      scenario_snapshot: JSON.stringify(input.scenarioConfig),
      input_payload: JSON.stringify(input.inputPayload),
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
