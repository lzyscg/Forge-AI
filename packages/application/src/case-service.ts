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
import { CASE_IDENTITY_PROTOCOL_VERSION } from '@forge-ai/contracts';
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

    this.repo.runInTransaction(() => {
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
      this.repo.insertControlEvent({
        event_id: `identity-protocol-${caseId}`,
        case_id: caseId,
        event_type: 'case_identity_protocol',
        actor: 'case-service',
        detail: CASE_IDENTITY_PROTOCOL_VERSION,
        created_at: now,
      });
    });

    return caseId;
  }

  startCase(caseId: string, runnerToken?: string): void {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);

    const newStatus = transitionCase(record.status as CaseStatus, 'running');
    const committed = this.repo.compareAndSetCaseStatus(
      caseId,
      record.status as CaseStatus,
      {
        status: newStatus,
        updated_at: this.clock.now(),
      },
      {
        runnerTokenSha256: runnerToken === undefined
          ? undefined
          : sha256(runnerToken),
      },
    );
    if (!committed) {
      throw new Error('Case state changed concurrently');
    }
  }

  acquireExecutionLease(
    caseId: string,
    runnerToken: string,
    runnerPid: number,
  ): boolean {
    const now = this.clock.now();
    return this.repo.acquireExecutionLease(caseId, {
      runner_token_sha256: sha256(runnerToken),
      runner_pid: runnerPid,
      runner_started_at: now,
      heartbeat_at: now,
    });
  }

  validateExecutionLease(caseId: string, runnerToken: string): boolean {
    return this.repo.validateExecutionLease(caseId, sha256(runnerToken));
  }

  claimExecutionLease(
    caseId: string,
    runnerToken: string,
    runnerPid: number,
  ): boolean {
    return this.repo.claimExecutionLease(
      caseId,
      sha256(runnerToken),
      runnerPid,
      this.clock.now(),
    );
  }

  releaseExecutionLeaseOwner(
    caseId: string,
    runnerToken: string,
    runnerPid: number,
  ): boolean {
    return this.repo.releaseExecutionLeaseOwner(
      caseId,
      sha256(runnerToken),
      runnerPid,
    );
  }

  transferExecutionLease(
    caseId: string,
    oldRunnerToken: string,
    newRunnerToken: string,
  ): boolean {
    const now = this.clock.now();
    return this.repo.transferExecutionLease(
      caseId,
      sha256(oldRunnerToken),
      {
        runner_token_sha256: sha256(newRunnerToken),
        runner_pid: 0,
        runner_started_at: now,
        heartbeat_at: now,
      },
    );
  }

  heartbeatExecutionLease(
    caseId: string,
    runnerToken: string,
    runnerPid: number,
  ): boolean {
    return this.repo.heartbeatExecutionLease(
      caseId,
      sha256(runnerToken),
      runnerPid,
      this.clock.now(),
    );
  }

  stopCaseWithoutLease(caseId: string): 'stopped' {
    const record = this.repo.getCase(caseId);
    if (!record) throw new Error(`Case not found: ${caseId}`);
    const status = record.status as CaseStatus;
    if (status === 'approved' || status === 'failed' || status === 'stopped') {
      throw new Error(`Case already in terminal state: ${status}`);
    }
    if (status === 'running') {
      throw new Error('Cannot stop a running case. Wait for it to finish or crash.');
    }
    const stopped = this.repo.stopCaseWithoutExecutionLease(
      caseId,
      status,
      this.clock.now(),
    );
    if (!stopped) {
      throw new Error(
        'Case state changed concurrently or execution lease exists',
      );
    }
    return 'stopped';
  }

  abortCase(caseId: string, runnerToken: string): 'stopped' {
    const result = this.repo.abortCaseWithExecutionLease(
      caseId,
      sha256(runnerToken),
      this.clock.now(),
      ['running', 'repairing', 'waiting_review', 'waiting_human'],
    );
    if (result.ok) return result.status;

    if (result.reason === 'case_not_found') {
      throw new Error(`Case not found: ${caseId}`);
    }
    if (result.reason === 'invalid_token') {
      throw new Error('Execution lease authorization failed');
    }
    if (result.reason === 'terminal_status') {
      throw new Error(`Cannot abort terminal case: ${result.status}`);
    }
    throw new Error(`Cannot abort case in status: ${result.status}`);
  }

  transitionCaseStatus(
    caseId: string,
    to: CaseStatus,
    runnerToken?: string,
  ): void {
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

    const committed = this.repo.compareAndSetCaseStatus(
      caseId,
      record.status as CaseStatus,
      fields,
      {
        runnerTokenSha256: runnerToken === undefined
          ? undefined
          : sha256(runnerToken),
        clearExecutionLease:
          to === 'approved' || to === 'failed' || to === 'stopped',
      },
    );
    if (!committed) {
      throw new Error(
        'Case state changed concurrently or lease authorization failed',
      );
    }
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
