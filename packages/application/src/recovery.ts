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
  /** 进程级恢复事件计数器，保证 control_events.event_id 唯一（4.5 幂等） */
  private static eventSeq = 0;

  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
  ) {}

  /**
   * 扫描所有需要恢复的 Case（处于运行中状态：running/waiting_review/repairing）
   *
   * 关键：不能依赖 incomplete turn（status != completed）来触发恢复。
   * 因为 Turn 是事务化原子提交的（P0-3），崩溃时正在执行的 Turn 会随进程死亡
   * 回滚，不会残留 running 状态的 Turn。所以只要 Case 处于非终态的运行中状态，
   * 就说明上次没跑完，需要从最后完成的 Turn 续跑。
   */
  findCasesNeedingRecovery(): string[] {
    const RUNTIME_STATES: CaseStatus[] = ['running', 'waiting_review', 'repairing'];
    const needsRecovery: string[] = [];
    const seen = new Set<string>();
    for (const status of RUNTIME_STATES) {
      for (const caseRecord of this.repo.getCasesByStatus(status)) {
        const id = caseRecord.case_id as string;
        if (!seen.has(id)) {
          seen.add(id);
          needsRecovery.push(id);
        }
      }
    }
    return needsRecovery;
  }

  /**
   * 对单个 Case 执行恢复
   */
  recoverCase(
    caseId: string,
    runnerTokenSha256?: string,
  ): RecoveryResult {
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

    let currentStatus = caseRecord.status as CaseStatus;
    const incompleteTurns = this.repo.getIncompleteTurns(caseId);

    // 先把 Case 转到 running（waiting_review/repairing -> running），才能进 waiting_recovery。
    // 不再因"没有 incomplete turn"就跳过恢复：Turn 事务化（P0-3）下崩溃 Turn 会回滚不残留，
    // 只要 Case 处于运行中状态就说明上次没跑完，需要从最后完成 Turn 续跑。
    if (currentStatus === 'waiting_review' || currentStatus === 'repairing') {
      this.commitStatus(
        caseId,
        currentStatus,
        transitionCase(currentStatus, 'running'),
        runnerTokenSha256,
      );
      currentStatus = 'running';
    }

    // Case → waiting_recovery
    if (currentStatus === 'running') {
      this.commitStatus(
        caseId,
        currentStatus,
        transitionCase(currentStatus, 'waiting_recovery'),
        runnerTokenSha256,
      );
    }

    // 记录恢复事件（4.5 幂等：用进程级计数器保证 event_id 唯一，
    // 避免同一 Case 短时间内重复恢复时 Date.now() 同毫秒导致 UNIQUE 冲突）
    this.repo.insertControlEvent({
      event_id: `evt_recovery_${caseId}_${Date.now()}_${RecoveryService.eventSeq++}`,
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
    this.commitStatus(
      caseId,
      'waiting_recovery',
      transitionCase('waiting_recovery', 'running'),
      runnerTokenSha256,
    );

    // 记录恢复完成事件
    this.repo.insertControlEvent({
      event_id: `evt_recovery_done_${caseId}_${Date.now()}_${RecoveryService.eventSeq++}`,
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

  private commitStatus(
    caseId: string,
    expectedStatus: CaseStatus,
    status: CaseStatus,
    runnerTokenSha256?: string,
  ): void {
    const committed = this.repo.compareAndSetCaseStatus(
      caseId,
      expectedStatus,
      {
        status,
        updated_at: this.clock.now(),
      },
      { runnerTokenSha256 },
    );
    if (!committed) {
      throw new Error(
        'Case state changed concurrently or lease authorization failed',
      );
    }
  }
}
