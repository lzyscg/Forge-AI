/**
 * 返修一致性修复（5.6 + 恢复路径复用）
 *
 * 关闭"关联 Issue 已全部 verified 但仍 submitted"的陈旧返修指令。
 * 用于：
 * - approve_delivery 门禁 no_active_revision 失败时（5.6）
 * - runCase 恢复续跑前清理历史脏指令（避免它们匹配最新版本触发 AMBIGUOUS、
 *   并阻塞门禁 no_active_revision）
 *
 * 铁律 4：一致性修复以 control_event(consistency_repair) 追加记录，可追溯。
 */
import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  IssueStatus,
  RevisionInstructionStatus,
} from '@forge-ai/contracts';
import { findStaleSubmittedInstructions } from '@forge-ai/domain';

export function repairStaleSubmittedInstructions(
  repo: RepositoryPort,
  clock: ClockPort,
  idGen: IdGeneratorPort,
  caseId: string,
  reason: string,
): string[] {
  const active = repo.getActiveRevisionInstructions(caseId);
  const refs = active.map((ri) => ({
    id: ri.revision_instruction_id as string,
    status: ri.status as RevisionInstructionStatus,
    issueIds: JSON.parse((ri.issue_ids as string) || '[]') as string[],
  }));
  const issues = repo.getIssuesByCase(caseId);
  const issueStatus = new Map<string, IssueStatus>();
  for (const i of issues) issueStatus.set(i.issue_id as string, i.status as IssueStatus);

  const stale = findStaleSubmittedInstructions(refs, issueStatus);
  if (stale.length === 0) return [];

  for (const id of stale) {
    repo.updateRevisionInstruction(id, { status: 'verified' });
  }
  repo.insertControlEvent({
    event_id: idGen.generate('evt'),
    case_id: caseId,
    event_type: 'consistency_repair',
    actor: 'system',
    detail: JSON.stringify({ closed_instruction_ids: stale, reason }),
    created_at: clock.now(),
  });
  return stale;
}
