/**
 * 工具执行器
 * 铁律 2：模型不碰工程数据。工具参数只保留最必要的字段，其余由系统补齐。
 */

import { createHash } from 'node:crypto';
import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  ScenarioConfig,
  PublishArtifactInput,
  PublishArtifactOutput,
  SubmitEvaluationInput,
  SubmitEvaluationOutput,
  RouteMessageInput,
  RouteMessageOutput,
  ApproveDeliveryInput,
  ApproveDeliveryOutput,
  RequestHumanInputInput,
  RequestHumanInputOutput,
  ToolName,
} from '@forge-ai/contracts';
import {
  transitionArtifactVersion,
  evaluateDeliveryGate,
  validateScope,
  computeChangedLines,
  applyRouteMessageWithIssues,
  applyPublishArtifactRepair,
  applyEvaluationVerify,
  findUnresolvableSubmittedInstructions,
  isRevisionInstructionActive,
  type DeliveryGateInput,
  type InstructionRef,
} from '@forge-ai/domain';
import type { IssueStatus, RevisionInstructionStatus } from '@forge-ai/contracts';
import { repairOrphanedInstructions } from './revision-consistency.js';

export interface ToolExecutionContext {
  caseId: string;
  turnId: string;
  sessionId: string;
  agentKey: string;
  messageId: string;
  scenarioConfig: ScenarioConfig;
}

export class ToolExecutor {
  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
    private idGen: IdGeneratorPort,
  ) {}

  execute(
    toolName: ToolName,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Record<string, unknown> {
    switch (toolName) {
      case 'publish_artifact':
        return this.publishArtifact(args as unknown as PublishArtifactInput, ctx) as unknown as Record<string, unknown>;
      case 'submit_evaluation':
        return this.submitEvaluation(args as unknown as SubmitEvaluationInput, ctx) as unknown as Record<string, unknown>;
      case 'route_message':
        return this.routeMessage(args as unknown as RouteMessageInput, ctx) as unknown as Record<string, unknown>;
      case 'approve_delivery':
        return this.approveDelivery(args as unknown as ApproveDeliveryInput, ctx) as unknown as Record<string, unknown>;
      case 'request_human_input':
        return this.requestHumanInput(args as unknown as RequestHumanInputInput, ctx) as unknown as Record<string, unknown>;
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }

  private publishArtifact(input: PublishArtifactInput, ctx: ToolExecutionContext): PublishArtifactOutput {
    const { caseId, turnId, messageId, scenarioConfig } = ctx;

    // 验证 artifact_type 在配置中注册
    const artifactTypeConfig = scenarioConfig.artifact_types.find(
      (t) => t.type === input.artifact_type,
    );
    if (!artifactTypeConfig) {
      return { success: false, error: `未注册的产物类型: ${input.artifact_type}` };
    }

    // 查找或创建 artifact
    let artifact = this.repo.getArtifactByTypeAndCase(caseId, input.artifact_type);
    if (!artifact) {
      const artifactId = this.idGen.generate('art');
      this.repo.insertArtifact({
        artifact_id: artifactId,
        case_id: caseId,
        artifact_type: input.artifact_type,
        scope_key: null,
        current_valid_version_id: null,
        status: 'active',
        created_at: this.clock.now(),
      });
      artifact = { artifact_id: artifactId };
    }

    const artifactId = artifact.artifact_id as string;

    // 计算版本号
    const existingVersions = this.repo.getVersionsByArtifact(artifactId);
    const version = existingVersions.length + 1;

    // 计算 content hash
    const contentHash = createHash('sha256').update(input.content).digest('hex');

    // 幂等检查：同一 artifact 是否已有相同 content hash 的版本
    const existingByHash = this.repo.getVersionByContentHash(artifactId, contentHash);
    if (existingByHash) {
      return {
        success: true,
        artifact_version_id: existingByHash.artifact_version_id as string,
        version: existingByHash.version as number,
      };
    }

    // 计算与上一版的 diff
    // 父本取最后一个非 rejected 版本：越界 rejected 版本是死分支，若以它为基准，
    // 返修重试版本会与被拒版本比较 diff，导致 scope 校验把"回滚越界改动"误判为新越界。
    const nonRejected = existingVersions.filter((v) => v.status !== 'rejected');
    const parentVersion = nonRejected.length > 0
      ? nonRejected[nonRejected.length - 1]
      : null;
    let diff: string | null = null;
    if (parentVersion) {
      const changedLines = computeChangedLines(
        parentVersion.content as string,
        input.content,
      );
      diff = JSON.stringify(changedLines);
    }

    // 行级越界校验（如果有活跃的返修指令）
    const activeInstructions = this.repo.getActiveRevisionInstructions(caseId);
    // 5.2：发布返修版本时按 (target_agent=当前发布方, target_artifact_version_id=父版本)
    // 定位唯一活跃指令。不再无条件取数组最后一条（旧实现会悬挂其他指令）。
    let boundInstruction: Record<string, unknown> | null = null;
    if (activeInstructions.length > 0 && parentVersion) {
      const parentId = parentVersion.artifact_version_id as string;
      const candidates = activeInstructions.filter((ri) => {
        // submitted = 该轮返修版本已发布、待审核，不是返修任务，不能再次绑定（否则
        // 历史脏 submitted 指令会让新 publish 触发 AMBIGUOUS 或误绑已完成轮次）。
        if (ri.status === 'submitted') return false;
        if (ri.target_agent !== ctx.agentKey) return false;
        const targetVersion = ri.target_artifact_version_id as string | null;
        // 优先匹配 target_artifact_version_id === parent；允许 null 兜底（指令创建时无版本）
        return targetVersion === parentId || targetVersion === null;
      });
      if (candidates.length === 0) {
        // 没有绑定到当前 Agent/父版本的活跃指令：不能发布模糊归属的返修版本。
        // 这通常意味着活跃指令指向其他 Agent 或其他父版本（跨轮悬挂），需要先由系统确定性处理。
        return {
          success: false,
          error: `无法发布返修版本：当前没有匹配 Agent(${ctx.agentKey})与父版本(${parentId})的活跃返修指令。活跃指令: ${activeInstructions.map((ri) => `${ri.revision_instruction_id}(${ri.target_agent}->${ri.target_artifact_version_id ?? 'null'})`).join(', ')}`,
          error_code: 'NO_ACTIVE_INSTRUCTION',
        };
      }
      if (candidates.length > 1) {
        return {
          success: false,
          error: `无法发布返修版本：匹配到 ${candidates.length} 条活跃返修指令，归属模糊，拒绝发布: ${candidates.map((c) => c.revision_instruction_id).join(', ')}`,
          error_code: 'AMBIGUOUS_ACTIVE_INSTRUCTION',
        };
      }
      boundInstruction = candidates[0];
      const ri = boundInstruction;
      const editableAnchors = JSON.parse(ri.editable_anchors as string) as string[];
      const frozenAnchors = JSON.parse(ri.frozen_anchors as string) as string[];
      const changedLines = computeChangedLines(parentVersion.content as string, input.content);

      const scopeResult = validateScope({ editableAnchors, frozenAnchors, changedLines });
      if (!scopeResult.valid) {
        // 越界：产物版本置为 rejected，返修指令置为 scope_violation
        const versionId = this.idGen.generate('av');
        this.repo.insertArtifactVersion({
          artifact_version_id: versionId,
          artifact_id: artifactId,
          version,
          content: input.content,
          summary: input.summary,
          source_message_id: messageId,
          source_turn_id: turnId,
          parent_version_id: parentVersion.artifact_version_id,
          diff,
          content_hash: contentHash,
          status: 'rejected',
          approved_at: null,
          created_at: this.clock.now(),
        });
        this.repo.updateRevisionInstruction(ri.revision_instruction_id as string, {
          status: 'scope_violation',
        });
        // 支柱一/三：越界后系统自动重发一份同 scope/issue_ids 的返修指令（status=issued，仍 active），
        // 让生成 Agent 可在同一 Turn 内重试。否则指令进 scope_violation 终态后，生成 Agent 的后续
        // 合规版本会因无 active instruction 被当成 draft，Issue 永远卡在 repairing，门禁永远拦。
        const retriedIssueIds = this.parseIssueIds(ri.issue_ids as string);
        this.repo.insertRevisionInstruction({
          revision_instruction_id: this.idGen.generate('ri'),
          case_id: caseId,
          target_agent: ri.target_agent as string,
          target_artifact_version_id: (ri.target_artifact_version_id as string | null) ?? null,
          issue_ids: JSON.stringify(retriedIssueIds),
          editable_anchors: JSON.stringify(editableAnchors),
          frozen_anchors: JSON.stringify(frozenAnchors),
          status: 'issued' satisfies RevisionInstructionStatus,
          source_message_id: messageId,
          created_at: this.clock.now(),
        });
        return {
          success: false,
          error: `越界修改被拒绝: ${scopeResult.detail}。已自动重发返修指令，请严格只修改 editable_anchors 范围内的行（不增删行、不动 frozen 行）后重新发布。`,
        };
      }

      // 通过校验：更新 Issue 和 Revision Instruction 状态
      const issueIds = this.parseIssueIds(ri.issue_ids as string);
      const currentIssueStatuses = new Map<string, IssueStatus>();
      for (const issueId of issueIds) {
        const issue = this.repo.getIssue(issueId);
        if (issue) currentIssueStatuses.set(issueId, issue.status as IssueStatus);
      }

      const crossResult = applyPublishArtifactRepair(
        issueIds,
        currentIssueStatuses,
        ri.revision_instruction_id as string,
        ri.status as RevisionInstructionStatus,
      );

      for (const t of crossResult.issueTransitions) {
        this.repo.updateIssue(t.issueId, {
          status: t.to,
          resolution_artifact_version_id: null, // 会在下面设置
          updated_at: this.clock.now(),
        });
        // 铁律 4：Issue 状态变化以事件追加记录（返修方声称已修复 -> claimed_fixed）
        this.repo.insertIssueEvent({
          issue_event_id: this.idGen.generate('ie'),
          issue_id: t.issueId,
          event_type: t.to,
          actor: ctx.agentKey,
          message_id: messageId,
          detail: input.summary,
          created_at: this.clock.now(),
        });
      }
      for (const t of crossResult.instructionTransitions) {
        // 只应用最终状态（跳过中间状态）
        this.repo.updateRevisionInstruction(t.instructionId, { status: t.to });
      }
    }

    // 创建新版本
    const versionId = this.idGen.generate('av');
    const status = activeInstructions.length > 0 ? 'under_review' : 'draft';

    this.repo.insertArtifactVersion({
      artifact_version_id: versionId,
      artifact_id: artifactId,
      version,
      content: input.content,
      summary: input.summary,
      source_message_id: messageId,
      source_turn_id: turnId,
      parent_version_id: parentVersion?.artifact_version_id ?? null,
      diff,
      content_hash: contentHash,
      status,
      approved_at: null,
      created_at: this.clock.now(),
    });

    // 更新 artifact 的 current_valid_version_id
    this.repo.updateArtifact(artifactId, { current_valid_version_id: versionId });

    // 如果有旧版本，标记为 superseded
    if (parentVersion && parentVersion.status !== 'rejected') {
      this.repo.updateArtifactVersion(parentVersion.artifact_version_id as string, {
        status: 'superseded',
      });
    }

    // 更新 Issue 的 resolution_artifact_version_id（5.2：用绑定的指令，不再取数组最后一条）
    if (boundInstruction) {
      const issueIds = this.parseIssueIds(boundInstruction.issue_ids as string);
      for (const issueId of issueIds) {
        this.repo.updateIssue(issueId, { resolution_artifact_version_id: versionId });
      }
    }

    return { success: true, artifact_version_id: versionId, version };
  }

  private submitEvaluation(input: SubmitEvaluationInput, ctx: ToolExecutionContext): SubmitEvaluationOutput {
    const { caseId, messageId } = ctx;

    // 找到当前被审核的产物版本（最新的 under_review 版本）
    const artifactType = ctx.scenarioConfig.artifact_types[0]?.type;
    if (!artifactType) {
      return { success: false, error: '场景未配置产物类型' };
    }

    const artifact = this.repo.getArtifactByTypeAndCase(caseId, artifactType);
    if (!artifact) {
      return { success: false, error: '未找到产物' };
    }

    const latestVersion = this.repo.getLatestVersion(artifact.artifact_id as string);
    if (!latestVersion) {
      return { success: false, error: '未找到产物版本' };
    }

    const issueIds: string[] = [];

    if (input.verdict === 'approve') {
      // 幂等：版本已 approved，直接返回成功（不重复迁移）
      if (latestVersion.status === 'approved') {
        return { success: true, issue_ids: [] };
      }

      // 收集 Case 下全部 Issue 的当前状态（不只 claimed_fixed，
      // 还需要 verified 状态用于判定陈旧 submitted 指令是否可一致关闭）
      const issues = this.repo.getIssuesByCase(caseId);
      const allIssueStatuses = new Map<string, IssueStatus>();
      for (const issue of issues) {
        allIssueStatuses.set(issue.issue_id as string, issue.status as IssueStatus);
      }
      const claimedFixedIssueIds = issues
        .filter((i) => i.status === 'claimed_fixed')
        .map((i) => i.issue_id as string);

      // 解析全部 submitted 指令为 InstructionRef（5.1：不再只取第一条）
      const submittedRefs = this.collectInstructionRefs(caseId, 'submitted');

      // 5.1 / 7.2：若存在无法在本次 approve 中关闭的 submitted 指令
      // （其关联 Issue 仍有 repairing/open/reopened），不能产生半批准状态。
      // 先返回结构化错误，不改任何状态。
      const unresolvable = findUnresolvableSubmittedInstructions(submittedRefs, allIssueStatuses);
      if (unresolvable.length > 0) {
        return {
          success: false,
          error: `审核通过无法批准产物：存在 ${unresolvable.length} 条 submitted 返修指令的关联 Issue 尚未 claimed_fixed（最新版本未完整解决这些指令的问题）: ${unresolvable.join(', ')}`,
          error_code: 'PARTIAL_REVISION_INCOMPLETE',
          incomplete_instruction_ids: unresolvable,
        };
      }

      // 审核通过：先算跨状态机结果，再统一落库（避免中途异常产生半状态）
      const crossResult = applyEvaluationVerify(
        claimedFixedIssueIds,
        allIssueStatuses,
        submittedRefs,
      );

      // 5.1/4.2：Issue + Instruction + ArtifactVersion 的状态迁移在同一事务内提交，
      // 中途异常整体回滚，不残留半批准状态（Issue verified 但 Instruction 仍 submitted 等）。
      this.repo.runInTransaction(() => {
        // Issue：claimed_fixed -> verified
        for (const t of crossResult.issueTransitions) {
          this.repo.updateIssue(t.issueId, {
            status: t.to,
            verified_by_evaluation_id: messageId,
            updated_at: this.clock.now(),
            closed_at: this.clock.now(),
          });
          this.repo.insertIssueEvent({
            issue_event_id: this.idGen.generate('ie'),
            issue_id: t.issueId,
            event_type: 'verified',
            actor: ctx.agentKey,
            message_id: messageId,
            detail: input.summary,
            created_at: this.clock.now(),
          });
        }
        // Instruction：submitted -> verified（5.1：全部可关闭的指令一并关闭）
        for (const t of crossResult.instructionTransitions) {
          this.repo.updateRevisionInstruction(t.instructionId, { status: t.to });
        }
        // ArtifactVersion：under_review -> approved
        this.repo.updateArtifactVersion(latestVersion.artifact_version_id as string, {
          status: 'approved',
          approved_at: this.clock.now(),
        });
      });
    } else if (input.verdict === 'repair' || input.verdict === 'regenerate') {
      // 审核不通过：登记 issues
      for (const issueInput of input.issues) {
        const issueId = this.idGen.generate('issue');
        issueIds.push(issueId);

        this.repo.insertIssue({
          issue_id: issueId,
          case_id: caseId,
          artifact_version_id: latestVersion.artifact_version_id,
          evaluation_message_id: messageId,
          severity: issueInput.severity,
          anchor: JSON.stringify(issueInput.anchor),
          problem: issueInput.problem,
          evidence: issueInput.evidence,
          status: 'open' satisfies IssueStatus,
          resolution_artifact_version_id: null,
          verified_by_evaluation_id: null,
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
          closed_at: null,
        });

        this.repo.insertIssueEvent({
          issue_event_id: this.idGen.generate('ie'),
          issue_id: issueId,
          event_type: 'created',
          actor: ctx.agentKey,
          message_id: messageId,
          detail: issueInput.problem,
          created_at: this.clock.now(),
        });
      }

      // 产物版本保持 under_review 或回到 draft
      this.repo.updateArtifactVersion(latestVersion.artifact_version_id as string, {
        status: 'under_review',
      });
    }

    return { success: true, issue_ids: issueIds };
  }

  private routeMessage(input: RouteMessageInput, ctx: ToolExecutionContext): RouteMessageOutput {
    const { caseId, messageId, scenarioConfig } = ctx;

    // 校验路由合法性
    const route = scenarioConfig.routes.find(
      (r) => r.from === ctx.agentKey && r.to.includes(input.target_agent),
    );
    if (!route) {
      return {
        success: false,
        error: `路由不合法: ${ctx.agentKey} -> ${input.target_agent}`,
      };
    }

    // 支柱一：模型不应被要求完美管理 issue_ids。supervisor 发返修（带 editable/frozen scope）
    // 却漏填 issue_ids 时，系统自动补齐为当前 Case 的 open blocking issues--否则 Issue 生命周期
    // 断裂（不进 repairing/claimed_fixed/verified），交付门禁会永远拦截，真实模型下频繁触发。
    const scope = input.scope;
    const hasRepairScope = !!scope
      && ((scope.editable_anchors?.length ?? 0) > 0 || (scope.frozen_anchors?.length ?? 0) > 0);
    if (hasRepairScope && (!scope!.issue_ids || scope!.issue_ids.length === 0)) {
      const openBlocking = this.repo.getIssuesByCase(caseId).filter(
        (i) => i.status === 'open' && i.severity === 'blocking',
      );
      if (openBlocking.length > 0) {
        scope!.issue_ids = openBlocking.map((i) => i.issue_id as string);
      }
    }

    // 5.3：校验 issue_ids 引用完整性。任一不合法则整条 route_message 失败，
    // 不写入 Revision Instruction、不改任何 Issue 状态。
    // 不变量 4.1：issue_id 必须存在 + 属于当前 Case + 状态在 open|reopened。
    if (input.scope?.issue_ids && input.scope.issue_ids.length > 0) {
      const invalidIds: string[] = [];
      const seen = new Set<string>();
      for (const issueId of input.scope.issue_ids) {
        if (seen.has(issueId)) continue; // 去重，不重复报错
        seen.add(issueId);
        const issue = this.repo.getIssue(issueId);
        if (!issue) {
          invalidIds.push(issueId);
          continue;
        }
        if (issue.case_id !== caseId) {
          invalidIds.push(issueId);
          continue;
        }
        const st = issue.status as IssueStatus;
        if (st !== 'open' && st !== 'reopened') {
          invalidIds.push(issueId);
          continue;
        }
      }
      if (invalidIds.length > 0) {
        return {
          success: false,
          error: `route_message 拒绝：issue_ids 中存在不合法引用（不存在 / 不属于当前 Case / 状态不在 open|reopened）: ${invalidIds.join(', ')}`,
          error_code: 'INVALID_ISSUE_REFERENCE',
          invalid_issue_ids: invalidIds,
        };
      }

      // 5.2 单活跃指令约束：同一个 Case、目标 Agent 同时最多一条 issued|in_progress 指令。
      // 新问题需要追加时，合并到现有活跃指令（扩展 issue_ids + anchors），而不是新建第二条。
      // （submitted 指令代表该轮已发布版本、正在等待复审，属于不同轮次，可与新 issued 共存。）
      const existingActive = this.repo.getActiveRevisionInstructions(caseId).find((ri) => {
        if (ri.target_agent !== input.target_agent) return false;
        const st = ri.status as RevisionInstructionStatus;
        return st === 'issued' || st === 'in_progress';
      });

      if (existingActive) {
        // 合并：把新（合法）issue_ids 并入现有指令，并扩展 editable/frozen 锚点
        const mergedIssueIds = this.mergeUnique(
          this.parseIssueIds(existingActive.issue_ids as string),
          input.scope.issue_ids,
        );
        const mergedEditable = this.mergeUnique(
          JSON.parse(existingActive.editable_anchors as string) as string[],
          input.scope.editable_anchors ?? [],
        );
        const mergedFrozen = this.mergeUnique(
          JSON.parse(existingActive.frozen_anchors as string) as string[],
          input.scope.frozen_anchors ?? [],
        );
        this.repo.updateRevisionInstruction(existingActive.revision_instruction_id as string, {
          issue_ids: JSON.stringify(mergedIssueIds),
          editable_anchors: JSON.stringify(mergedEditable),
          frozen_anchors: JSON.stringify(mergedFrozen),
        });

        // 只对新加入的（之前非 repairing 的）Issue 触发 open|reopened -> repairing
        const currentIssueStatuses = new Map<string, IssueStatus>();
        for (const issueId of input.scope.issue_ids) {
          const issue = this.repo.getIssue(issueId);
          if (issue) currentIssueStatuses.set(issueId, issue.status as IssueStatus);
        }
        const crossResult = applyRouteMessageWithIssues(
          input.scope.issue_ids,
          currentIssueStatuses,
          existingActive.revision_instruction_id as string,
        );
        for (const t of crossResult.issueTransitions) {
          this.repo.updateIssue(t.issueId, { status: t.to, updated_at: this.clock.now() });
          this.repo.insertIssueEvent({
            issue_event_id: this.idGen.generate('ie'),
            issue_id: t.issueId,
            event_type: 'repairing',
            actor: ctx.agentKey,
            message_id: messageId,
            detail: input.reason ?? input.instruction,
            created_at: this.clock.now(),
          });
        }

        // 记录路由边
        this.repo.insertRouteEdge({
          route_id: this.idGen.generate('route'),
          case_id: caseId,
          source_message_id: messageId,
          target_message_id: null,
          source_agent: ctx.agentKey,
          target_agent: input.target_agent,
          reason: input.reason ?? null,
          context_snapshot_id: null,
          created_at: this.clock.now(),
        });

        return { success: true, revision_instruction_id: existingActive.revision_instruction_id as string };
      }

      // 新建 Revision Instruction
      const revisionInstructionId = this.idGen.generate('ri');

      // 找到当前产物版本
      const artifactType = scenarioConfig.artifact_types[0]?.type;
      const artifact = artifactType
        ? this.repo.getArtifactByTypeAndCase(caseId, artifactType)
        : null;
      const latestVersion = artifact
        ? this.repo.getLatestVersion(artifact.artifact_id as string)
        : null;

      this.repo.insertRevisionInstruction({
        revision_instruction_id: revisionInstructionId,
        case_id: caseId,
        target_agent: input.target_agent,
        target_artifact_version_id: latestVersion?.artifact_version_id ?? null,
        issue_ids: JSON.stringify(input.scope.issue_ids),
        editable_anchors: JSON.stringify(input.scope.editable_anchors ?? []),
        frozen_anchors: JSON.stringify(input.scope.frozen_anchors ?? []),
        status: 'issued' satisfies RevisionInstructionStatus,
        source_message_id: messageId,
        created_at: this.clock.now(),
      });

      // 跨状态机联动：Issue -> repairing
      const currentIssueStatuses = new Map<string, IssueStatus>();
      for (const issueId of input.scope.issue_ids) {
        const issue = this.repo.getIssue(issueId);
        if (issue) currentIssueStatuses.set(issueId, issue.status as IssueStatus);
      }

      const crossResult = applyRouteMessageWithIssues(
        input.scope.issue_ids,
        currentIssueStatuses,
        revisionInstructionId,
      );

      for (const t of crossResult.issueTransitions) {
        this.repo.updateIssue(t.issueId, { status: t.to, updated_at: this.clock.now() });
        this.repo.insertIssueEvent({
          issue_event_id: this.idGen.generate('ie'),
          issue_id: t.issueId,
          event_type: 'repairing',
          actor: ctx.agentKey,
          message_id: messageId,
          detail: input.reason ?? input.instruction,
          created_at: this.clock.now(),
        });
      }

      // 记录路由边
      this.repo.insertRouteEdge({
        route_id: this.idGen.generate('route'),
        case_id: caseId,
        source_message_id: messageId,
        target_message_id: null,
        source_agent: ctx.agentKey,
        target_agent: input.target_agent,
        reason: input.reason ?? null,
        context_snapshot_id: null,
        created_at: this.clock.now(),
      });

      return { success: true, revision_instruction_id: revisionInstructionId };
    }

    // 记录路由边
    this.repo.insertRouteEdge({
      route_id: this.idGen.generate('route'),
      case_id: caseId,
      source_message_id: messageId,
      target_message_id: null,
      source_agent: ctx.agentKey,
      target_agent: input.target_agent,
      reason: input.reason ?? null,
      context_snapshot_id: null,
      created_at: this.clock.now(),
    });

    return { success: true, revision_instruction_id: undefined };
  }

  private approveDelivery(input: ApproveDeliveryInput, ctx: ToolExecutionContext): ApproveDeliveryOutput {
    const { caseId, scenarioConfig } = ctx;

    // 系统自动定位版本（铁律 2：Agent 不碰版本号）
    const artifactType = input.artifact_type ?? scenarioConfig.delivery.deliverable_artifact_type;
    const artifact = this.repo.getArtifactByTypeAndCase(caseId, artifactType);
    if (!artifact) {
      return { success: false, error: `未找到类型为 ${artifactType} 的产物` };
    }

    const latestVersion = this.repo.getLatestVersion(artifact.artifact_id as string);
    if (!latestVersion) {
      return { success: false, error: '未找到产物版本' };
    }

    let gateResult = this.evaluateGateForCase(caseId, latestVersion.artifact_version_id as string, ctx.turnId);

    // 记录门禁结果（若发生一致性修复，下面会追加第二条并通过 finalGateResultId 返回最终结果）
    let finalGateResultId = this.idGen.generate('gate');
    this.repo.insertDeliveryGateResult({
      gate_result_id: finalGateResultId,
      case_id: caseId,
      artifact_version_id: latestVersion.artifact_version_id,
      status: gateResult.passed ? 'pass' : 'fail',
      checks: JSON.stringify(gateResult.checks),
      blocking_issue_ids: JSON.stringify(gateResult.blockingIssueIds),
      created_at: this.clock.now(),
    });

    // 5.6：门禁失败且唯一失败项是 no_active_revision 时的确定性恢复。
    // 不让 start agent 根据门禁文本再次创建新的返修指令（会加剧不一致）。
    let consistencyRepaired = false;
    if (!gateResult.passed) {
      const failedChecks = gateResult.checks.filter((c) => !c.passed);
      const onlyNoActiveRevision =
        failedChecks.length === 1 && failedChecks[0].check === 'no_active_revision';
      if (onlyNoActiveRevision) {
        // 5.6 一致性修复：关闭"关联 Issue 已全 verified 但仍 submitted"的陈旧指令（复用共享 helper）
        const stale = repairOrphanedInstructions(this.repo, this.clock, this.idGen, caseId, 'issues_all_verified');
        if (stale.length > 0) {
          consistencyRepaired = true;
          // 重新评估门禁
          gateResult = this.evaluateGateForCase(caseId, latestVersion.artifact_version_id as string, ctx.turnId);
          // 记录修复后的门禁结果（作为最终返回的 gate_result_id）
          finalGateResultId = this.idGen.generate('gate');
          this.repo.insertDeliveryGateResult({
            gate_result_id: finalGateResultId,
            case_id: caseId,
            artifact_version_id: latestVersion.artifact_version_id,
            status: gateResult.passed ? 'pass' : 'fail',
            checks: JSON.stringify(gateResult.checks),
            blocking_issue_ids: JSON.stringify(gateResult.blockingIssueIds),
            created_at: this.clock.now(),
          });
        }

        if (!gateResult.passed) {
          // 仍未通过：按剩余活跃指令状态确定性路由
          const remaining = this.collectInstructionRefs(caseId, 'active');
          const stillActive = remaining.filter((r) => isRevisionInstructionActive(r.status));
          if (stillActive.length > 0) {
            const hasSubmitted = stillActive.some((r) => r.status === 'submitted');
            if (hasSubmitted) {
              // submitted -> 审核 Agent
              const reviewer = this.findReviewerAgentKey(scenarioConfig);
              if (reviewer) {
                return {
                  success: true,
                  gate_result_id: finalGateResultId,
                  gate_passed: false,
                  checks: gateResult.checks,
                  consistency_repaired: consistencyRepaired,
                  route_to: reviewer,
                  route_reason: `交付门禁因存在 submitted 返修指令未关闭而失败，但其关联 Issue 尚未全部 verified。请审核最新返修版本。`,
                };
              }
            }
            // issued|in_progress -> 该指令的 target_agent
            const inProgress = stillActive.find((r) => r.status === 'issued' || r.status === 'in_progress');
            if (inProgress) {
              // 需要取 target_agent：collectInstructionRefs 没带，重新查
              const rec = this.repo.getRevisionInstruction(inProgress.id);
              const targetAgent = rec?.target_agent as string | undefined;
              if (targetAgent) {
                return {
                  success: true,
                  gate_result_id: finalGateResultId,
                  gate_passed: false,
                  checks: gateResult.checks,
                  consistency_repaired: consistencyRepaired,
                  route_to: targetAgent,
                  route_reason: `交付门禁因存在未完成的返修指令(${inProgress.id})而失败。请按返修指令发布修复版本。`,
                };
              }
            }
          }
          // 无法确定性路由 -> 报内部错误，不让 Agent 猜
          return {
            success: false,
            gate_result_id: finalGateResultId,
            gate_passed: false,
            checks: gateResult.checks,
            consistency_repaired: consistencyRepaired,
            error_code: 'INTERNAL_STATE_INCONSISTENT',
            error: `交付门禁唯一失败项为 no_active_revision，但一致性修复后仍无法通过，且无法确定性路由。需要人工介入核查 Case 状态。`,
          };
        }
        // 修复后通过 -> 继续走交付
      }
    }

    if (gateResult.passed) {
      // 交付成功：产物版本 -> delivered
      this.repo.updateArtifactVersion(latestVersion.artifact_version_id as string, {
        status: 'delivered',
      });
    }

    return {
      success: true,
      gate_result_id: finalGateResultId,
      gate_passed: gateResult.passed,
      checks: gateResult.checks,
      consistency_repaired: consistencyRepaired || undefined,
    };
  }

  private requestHumanInput(input: RequestHumanInputInput, ctx: ToolExecutionContext): RequestHumanInputOutput {
    // MVP：让 Case 进入 waiting_human 状态
    this.repo.insertControlEvent({
      event_id: this.idGen.generate('evt'),
      case_id: ctx.caseId,
      event_type: 'request_human_input',
      actor: ctx.agentKey,
      detail: JSON.stringify({ reason: input.reason, question: input.question }),
      created_at: this.clock.now(),
    });

    return { success: true, message: 'Case 已进入 waiting_human 状态，等待人工输入' };
  }

  // === 私有辅助 ===

  /** 安全解析 revision_instruction.issue_ids（JSON 字符串） */
  private parseIssueIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 收集 Case 下指令的 InstructionRef（statusFilter: 'submitted' | 'active' | 'all'） */
  private collectInstructionRefs(caseId: string, statusFilter: 'submitted' | 'active' | 'all'): InstructionRef[] {
    const all = this.repo.getRevisionInstructionsByCase(caseId);
    return all
      .filter((ri) => {
        const st = ri.status as RevisionInstructionStatus;
        if (statusFilter === 'all') return true;
        if (statusFilter === 'submitted') return st === 'submitted';
        return isRevisionInstructionActive(st);
      })
      .map((ri) => ({
        id: ri.revision_instruction_id as string,
        status: ri.status as RevisionInstructionStatus,
        issueIds: this.parseIssueIds(ri.issue_ids as string),
      }));
  }

  /** 查找持有 submit_evaluation 工具的 Agent（审核方），配置驱动，不写死角色名 */
  private findReviewerAgentKey(scenarioConfig: ScenarioConfig): string | null {
    const reviewer = scenarioConfig.agents.find((a) => a.tools.includes('submit_evaluation'));
    return reviewer?.key ?? null;
  }

  /** 计算当前 Case 的交付门禁结果（用于 approveDelivery 与一致性修复后重评估） */
  private evaluateGateForCase(caseId: string, versionId: string, currentTurnId: string) {
    const latestVersion = this.repo.getArtifactVersion(versionId);
    const allIssues = this.repo.getIssuesByCase(caseId);
    const blockingIssues = allIssues
      .filter((i) => i.severity === 'blocking')
      .map((i) => ({
        issueId: i.issue_id as string,
        status: i.status as IssueStatus,
        severity: i.severity as string,
      }));
    const revisionInstructions = this.repo.getRevisionInstructionsByCase(caseId).map((ri) => ({
      id: ri.revision_instruction_id as string,
      status: ri.status as RevisionInstructionStatus,
    }));
    const incompleteTurns = this.repo
      .getIncompleteTurns(caseId)
      .filter((t) => t.turn_id !== currentTurnId)
      .map((t) => ({
        turnId: t.turn_id as string,
        status: t.status as string,
      })) as { turnId: string; status: 'queued' | 'running' | 'completed' | 'failed' }[];

    const gateInput: DeliveryGateInput = {
      artifactVersion: latestVersion ? { status: latestVersion.status as any } : null,
      artifactVersionApproved: latestVersion?.status === 'approved' || latestVersion?.status === 'delivered',
      blockingIssues,
      revisionInstructions,
      incompleteTurns,
    };
    return evaluateDeliveryGate(gateInput);
  }

  /** 数组去重合并（保持顺序） */
  private mergeUnique(...arrs: string[][]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const arr of arrs) {
      for (const x of arr) {
        if (!seen.has(x)) {
          seen.add(x);
          out.push(x);
        }
      }
    }
    return out;
  }
}
