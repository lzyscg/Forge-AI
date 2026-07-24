/**
 * 崩溃恢复逻辑
 * 启动时扫描非 completed 的 Turn，Case 进入 waiting_recovery → 从最后完成 Turn 续跑
 * 铁律 4：崩溃恢复不允许覆盖任何已经成功持久化的结果
 */

import type {
  RepositoryPort,
  ClockPort,
  CaseStatus,
} from '@forge-ai/contracts';
import { transitionCase } from '@forge-ai/domain';

export interface RecoveryResult {
  caseId: string;
  recovered: boolean;
  lastCompletedTurnSequence: number | null;
  failedTurnIds: string[];
  detail: string;
}

export class RecoveryService {
  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
  ) {}

  /**
   * 扫描所有需要恢复的 Case（状态为 running 但有未完成的 Turn）
   */
  findCasesNeedingRecovery(): string[] {
    const runningCases = this.repo.getCasesByStatus('running');
    const needsRecovery: string[] = [];

    for (const caseRecord of runningCases) {
      const incompleteTurns = this.repo.getIncompleteTurns(caseRecord.case_id as string);
      if (incompleteTurns.length > 0) {
        needsRecovery.push(caseRecord.case_id as string);
      }
    }

    return needsRecovery;
  }

  /**
   * 对单个 Case 执行恢复
   */
  recoverCase(caseId: string): RecoveryResult {
    const caseRecord = this.repo.getCase(caseId);
    if (!caseRecord) {
      return {
        caseId,
        recovered: false,
        lastCompletedTurnSequence: null,
        failedTurnIds: [],
        detail: 'Case not found',
      };
    }

    const currentStatus = caseRecord.status as CaseStatus;
    const incompleteTurns = this.repo.getIncompleteTurns(caseId);

    if (incompleteTurns.length === 0) {
      return {
        caseId,
        recovered: false,
        lastCompletedTurnSequence: null,
        failedTurnIds: [],
        detail: 'No incomplete turns found, no recovery needed',
      };
    }

    // Case → waiting_recovery
    if (currentStatus === 'running') {
      this.repo.updateCase(caseId, {
        status: transitionCase(currentStatus, 'waiting_recovery'),
        updated_at: this.clock.now(),
      });
    }

    // 记录恢复事件
    this.repo.insertControlEvent({
      event_id: `evt_recovery_${caseId}_${Date.now()}`,
      case_id: caseId,
      event_type: 'recovery_started',
      actor: 'system',
      detail: JSON.stringify({
        incomplete_turn_count: incompleteTurns.length,
        incomplete_turn_ids: incompleteTurns.map((t) => t.turn_id),
      }),
      created_at: this.clock.now(),
    });

    // 将未完成的 running Turn 标记为 failed（不覆盖已 completed 的）
    const failedTurnIds: string[] = [];
    for (const turn of incompleteTurns) {
      if (turn.status === 'running') {
        this.repo.updateTurn(turn.turn_id as string, {
          status: 'failed',
          finished_at: this.clock.now(),
          provider_error: 'Process crashed during execution',
        });
        failedTurnIds.push(turn.turn_id as string);
      }
    }

    // 找到最后完成的 Turn
    const lastCompleted = this.repo.getLastCompletedTurn(caseId);
    const lastSequence = lastCompleted ? (lastCompleted.sequence as number) : null;

    // Case → running（恢复后续跑）
    this.repo.updateCase(caseId, {
      status: transitionCase('waiting_recovery', 'running'),
      updated_at: this.clock.now(),
    });

    // 记录恢复完成事件
    this.repo.insertControlEvent({
      event_id: `evt_recovery_done_${caseId}_${Date.now()}`,
      case_id: caseId,
      event_type: 'recovery_completed',
      actor: 'system',
      detail: JSON.stringify({
        last_completed_turn_sequence: lastSequence,
        failed_turn_ids: failedTurnIds,
      }),
      created_at: this.clock.now(),
    });

    return {
      caseId,
      recovered: true,
      lastCompletedTurnSequence: lastSequence,
      failedTurnIds,
      detail: `Recovery completed. Last completed turn sequence: ${lastSequence}. Failed turns: ${failedTurnIds.length}`,
    };
  }
}
