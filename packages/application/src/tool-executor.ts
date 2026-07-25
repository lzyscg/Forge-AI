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
  type DeliveryGateInput,
} from '@forge-ai/domain';
import type { IssueStatus, RevisionInstructionStatus } from '@forge-ai/contracts';

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
    const parentVersion = existingVersions.length > 0
      ? existingVersions[existingVersions.length - 1]
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
    if (activeInstructions.length > 0 && parentVersion) {
      const ri = activeInstructions[activeInstructions.length - 1];
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
        return { success: false, error: `越界修改被拒绝: ${scopeResult.detail}` };
      }

      // 通过校验：更新 Issue 和 Revision Instruction 状态
      const issueIds = JSON.parse(ri.issue_ids as string) as string[];
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

    // 更新 Issue 的 resolution_artifact_version_id
    if (activeInstructions.length > 0) {
      const ri = activeInstructions[activeInstructions.length - 1];
      const issueIds = JSON.parse(ri.issue_ids as string) as string[];
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
      // 审核通过：产物版本 → approved
      this.repo.updateArtifactVersion(latestVersion.artifact_version_id as string, {
        status: 'approved',
        approved_at: this.clock.now(),
      });

      // 如果有 claimed_fixed 的 issue，标记为 verified
      const issues = this.repo.getIssuesByCase(caseId);
      const claimedFixedIssues = issues.filter((i) => i.status === 'claimed_fixed');
      const currentIssueStatuses = new Map<string, IssueStatus>();
      for (const issue of claimedFixedIssues) {
        currentIssueStatuses.set(issue.issue_id as string, issue.status as IssueStatus);
      }

      // 查找相关的 revision instruction
      const instructions = this.repo.getRevisionInstructionsByCase(caseId);
      const submittedInstruction = instructions.find((ri) => ri.status === 'submitted');

      const crossResult = applyEvaluationVerify(
        claimedFixedIssues.map((i) => i.issue_id as string),
        currentIssueStatuses,
        submittedInstruction ? (submittedInstruction.revision_instruction_id as string) : null,
        submittedInstruction ? (submittedInstruction.status as RevisionInstructionStatus) : null,
      );

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
      for (const t of crossResult.instructionTransitions) {
        this.repo.updateRevisionInstruction(t.instructionId, { status: t.to });
      }
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
        error: `路由不合法: ${ctx.agentKey} → ${input.target_agent}`,
      };
    }

    let revisionInstructionId: string | undefined;

    // 如果携带 issue_ids，创建 Revision Instruction
    if (input.scope?.issue_ids && input.scope.issue_ids.length > 0) {
      revisionInstructionId = this.idGen.generate('ri');

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

      // 跨状态机联动：Issue → repairing
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

    // 收集门禁检查所需数据
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

    const incompleteTurns = this.repo.getIncompleteTurns(caseId)
      .filter((t) => t.turn_id !== ctx.turnId) // 排除当前正在执行的 Turn
      .map((t) => ({
        turnId: t.turn_id as string,
        status: t.status as string,
      })) as { turnId: string; status: 'queued' | 'running' | 'completed' | 'failed' }[];

    const gateInput: DeliveryGateInput = {
      artifactVersion: { status: latestVersion.status as any },
      artifactVersionApproved: latestVersion.status === 'approved',
      blockingIssues,
      revisionInstructions,
      incompleteTurns,
    };

    const gateResult = evaluateDeliveryGate(gateInput);

    // 记录门禁结果
    const gateResultId = this.idGen.generate('gate');
    this.repo.insertDeliveryGateResult({
      gate_result_id: gateResultId,
      case_id: caseId,
      artifact_version_id: latestVersion.artifact_version_id,
      status: gateResult.passed ? 'pass' : 'fail',
      checks: JSON.stringify(gateResult.checks),
      blocking_issue_ids: JSON.stringify(gateResult.blockingIssueIds),
      created_at: this.clock.now(),
    });

    if (gateResult.passed) {
      // 交付成功：产物版本 → delivered
      this.repo.updateArtifactVersion(latestVersion.artifact_version_id as string, {
        status: 'delivered',
      });
    }

    return {
      success: true,
      gate_result_id: gateResultId,
      gate_passed: gateResult.passed,
      checks: gateResult.checks,
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
}
