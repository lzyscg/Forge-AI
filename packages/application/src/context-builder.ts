/**
 * Context Builder
 * 根据 context_rules 组装发给 Pi 的上下文（静态包含规则 + 快照落库 + hash）
 */

import { createHash } from 'node:crypto';
import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  ScenarioConfig,
  PiMessage,
} from '@forge-ai/contracts';

export interface ContextBuildInput {
  caseId: string;
  sessionId: string;
  turnId: string;
  agentKey: string;
  scenarioConfig: ScenarioConfig;
  systemPrompt: string;
  userMessage: string;
}

export class ContextBuilder {
  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
    private idGen: IdGeneratorPort,
  ) {}

  buildContext(input: ContextBuildInput): { messages: PiMessage[]; snapshotId: string } {
    const messages: PiMessage[] = [];

    // System prompt
    messages.push({
      role: 'system',
      content: input.systemPrompt,
    });

    // 根据 context_rules 组装上下文
    const contextParts: string[] = [];

    // 查找适用的 context rule
    const ruleKey = this.findContextRuleKey(input.agentKey, input.scenarioConfig);
    if (ruleKey) {
      const rule = input.scenarioConfig.context_rules[ruleKey];
      if (rule) {
        for (const includeItem of rule.include) {
          const content = this.resolveContextInclude(includeItem, input.caseId, input.scenarioConfig);
          if (content) {
            contextParts.push(content);
          }
        }
      }
    }

    // 用户消息（包含上下文 + 实际指令）
    let fullUserMessage = input.userMessage;
    if (contextParts.length > 0) {
      fullUserMessage = `--- 上下文信息 ---\n${contextParts.join('\n\n')}\n\n--- 任务 ---\n${input.userMessage}`;
    }

    messages.push({
      role: 'user',
      content: fullUserMessage,
    });

    // 计算 hash 并落库
    const renderedContext = JSON.stringify(messages);
    const contextHash = createHash('sha256').update(renderedContext).digest('hex');
    const snapshotId = this.idGen.generate('ctx');

    this.repo.insertContextSnapshot({
      context_snapshot_id: snapshotId,
      case_id: input.caseId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      included_refs: JSON.stringify(ruleKey ? [ruleKey] : []),
      rendered_context: renderedContext,
      context_hash: contextHash,
      created_at: this.clock.now(),
    });

    return { messages, snapshotId };
  }

  private findContextRuleKey(agentKey: string, config: ScenarioConfig): string | null {
    // 查找 context_rules 中匹配当前 agent 的规则
    for (const key of Object.keys(config.context_rules)) {
      if (key.includes(agentKey)) {
        return key;
      }
    }
    return null;
  }

  private resolveContextInclude(
    includeItem: string,
    caseId: string,
    config: ScenarioConfig,
  ): string | null {
    switch (includeItem) {
      case 'current_artifact_version': {
        const artifactType = config.artifact_types[0]?.type;
        if (!artifactType) return null;
        const artifact = this.repo.getArtifactByTypeAndCase(caseId, artifactType);
        if (!artifact) return null;
        const latestVersion = this.repo.getLatestVersion(artifact.artifact_id as string);
        if (!latestVersion) return null;
        return `[当前产物 v${latestVersion.version}]\n${latestVersion.content}`;
      }
      case 'input_constraints': {
        const caseRecord = this.repo.getCase(caseId);
        if (!caseRecord) return null;
        const inputPayload = JSON.parse(caseRecord.input_payload as string);
        return `[用户输入约束]\n${JSON.stringify(inputPayload, null, 2)}`;
      }
      case 'target_issues': {
        const issues = this.repo.getIssuesByCase(caseId);
        const activeIssues = issues.filter(
          (i) => i.status === 'open' || i.status === 'repairing' || i.status === 'reopened',
        );
        if (activeIssues.length === 0) return null;
        const issueTexts = activeIssues.map(
          (i) => `- [${i.severity}] ${i.problem} (锚点: ${i.anchor})`,
        );
        return `[待修复问题]\n${issueTexts.join('\n')}`;
      }
      case 'revision_scope': {
        const instructions = this.repo.getActiveRevisionInstructions(caseId);
        if (instructions.length === 0) return null;
        const ri = instructions[instructions.length - 1];
        return `[返修范围]\n可编辑: ${ri.editable_anchors}\n冻结: ${ri.frozen_anchors}`;
      }
      default:
        return null;
    }
  }
}
