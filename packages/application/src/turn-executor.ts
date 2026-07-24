/**
 * Turn 编排
 * Turn 生命周期：queued → running → 调用 Pi → 解析工具调用 → 执行 → completed/failed
 *
 * P0-3 修复：整个 Turn 的状态翻转与全部副作用在同一个数据库事务内提交。
 * 使用显式 beginTransaction/commit/rollback（而非 runInTransaction），
 * 因为 pi.executeTurn 是 async 的，事务需要跨越 await 点。
 * better-sqlite3 是同步的，事务在 await 期间保持打开状态。
 */

import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  PiPort,
  PiMessage,
  PiToolDefinition,
  PiTurnResult,
  PiToolExecutorFn,
  ScenarioConfig,
  ToolName,
  TurnStatus,
} from '@forge-ai/contracts';
import { transitionTurn } from '@forge-ai/domain';
import { ToolExecutor, type ToolExecutionContext } from './tool-executor.js';
import { ContextBuilder } from './context-builder.js';

export interface TurnExecutionInput {
  caseId: string;
  sessionId: string;
  agentKey: string;
  scenarioConfig: ScenarioConfig;
  systemPrompt: string;
  userMessage: string;
  tools: PiToolDefinition[];
}

export interface TurnExecutionResult {
  turnId: string;
  status: 'completed' | 'failed';
  outputContent: string | null;
  toolCallResults: Record<string, unknown>[];
  error?: string;
}

export class TurnExecutor {
  private toolExecutor: ToolExecutor;
  private contextBuilder: ContextBuilder;

  constructor(
    private repo: RepositoryPort,
    private clock: ClockPort,
    private idGen: IdGeneratorPort,
    private pi: PiPort,
  ) {
    this.toolExecutor = new ToolExecutor(repo, clock, idGen);
    this.contextBuilder = new ContextBuilder(repo, clock, idGen);
  }

  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    const turnId = this.idGen.generate('turn');
    const sequence = this.getNextSequence(input.caseId);

    // P0-3：显式事务，跨越 async Pi 调用
    // better-sqlite3 同步操作在 await 之间保持事务打开
    this.repo.beginTransaction();

    try {
      // 创建 Turn 记录（queued）
      this.repo.insertTurn({
        turn_id: turnId,
        case_id: input.caseId,
        session_id: input.sessionId,
        sequence,
        status: 'queued' satisfies TurnStatus,
        input_message_id: null,
        output_message_id: null,
        context_snapshot_id: null,
        produced_artifact_version_ids: '[]',
        started_at: null,
        finished_at: null,
        retry_of_turn_id: null,
        provider_error: null,
      });

      // Turn → running
      this.repo.updateTurn(turnId, {
        status: transitionTurn('queued', 'running'),
        started_at: this.clock.now(),
      });

      // 构建上下文
      const { messages, snapshotId } = this.contextBuilder.buildContext({
        caseId: input.caseId,
        sessionId: input.sessionId,
        turnId,
        agentKey: input.agentKey,
        scenarioConfig: input.scenarioConfig,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
      });

      this.repo.updateTurn(turnId, { context_snapshot_id: snapshotId });

      // 记录输入消息
      const inputMessageId = this.idGen.generate('msg');
      this.repo.insertMessage({
        message_id: inputMessageId,
        case_id: input.caseId,
        session_id: input.sessionId,
        source_agent: null,
        target_agent: input.agentKey,
        parent_message_id: null,
        message_type: 'system',
        content: input.userMessage,
        artifact_version_refs: null,
        issue_refs: null,
        created_at: this.clock.now(),
      });
      this.repo.updateTurn(turnId, { input_message_id: inputMessageId });

      // 调用 Pi
      const session = { session_ref: input.sessionId };
      const toolCallResults: Record<string, unknown>[] = [];
      const producedVersionIds: string[] = [];
      const outputMessageId = this.idGen.generate('msg');

      // 工具执行回调（真实 Pi adapter 的 Agent 循环中调用）
      // 所有 DB 操作都在当前打开的事务内
      const toolExecutor: PiToolExecutorFn = (toolCallId, toolName, args) => {
        // 幂等检查
        const existingAction = this.repo.getToolActionByProviderId(turnId, toolCallId);
        if (existingAction) {
          const result = JSON.parse(existingAction.result as string);
          toolCallResults.push(result);
          return result;
        }

        // 记录工具调用
        const actionId = this.idGen.generate('act');
        this.repo.insertToolAction({
          action_id: actionId,
          turn_id: turnId,
          tool_name: toolName,
          arguments: JSON.stringify(args),
          result: null,
          status: 'pending',
          provider_tool_call_id: toolCallId,
          created_at: this.clock.now(),
        });

        // 执行工具
        const ctx: ToolExecutionContext = {
          caseId: input.caseId,
          turnId,
          sessionId: input.sessionId,
          agentKey: input.agentKey,
          messageId: outputMessageId,
          scenarioConfig: input.scenarioConfig,
        };

        const toolResult = this.toolExecutor.execute(toolName as ToolName, args, ctx);
        toolCallResults.push(toolResult);

        // 更新工具调用记录
        this.repo.updateToolAction(actionId, {
          result: JSON.stringify(toolResult),
          status: 'completed',
        });

        // 收集产物版本 ID
        if (toolResult.artifact_version_id) {
          producedVersionIds.push(toolResult.artifact_version_id as string);
        }

        return toolResult;
      };

      // Pi 执行（async，事务保持打开）
      const piResult: PiTurnResult = await this.pi.executeTurn(session, messages, input.tools, toolExecutor);

      if (piResult.finish_reason === 'error') {
        throw new Error(piResult.error ?? 'Pi returned error');
      }

      // 如果 adapter 没有使用 toolExecutor 回调（如 Fake Pi），则在这里执行工具
      const hasCallbackResults = toolCallResults.length > 0;

      if (!hasCallbackResults && piResult.tool_calls.length > 0) {
        // 传统模式：adapter 返回工具调用，turn-executor 执行（仍在同一事务内）
        for (let i = 0; i < piResult.tool_calls.length; i++) {
          const toolCall = piResult.tool_calls[i];
          const toolName = toolCall.name as ToolName;
          const args = JSON.parse(toolCall.arguments);

          // 幂等检查
          const providerToolCallId = toolCall.id || `${turnId}_seq_${i}`;
          const existingAction = this.repo.getToolActionByProviderId(turnId, providerToolCallId);
          if (existingAction) {
            toolCallResults.push(JSON.parse(existingAction.result as string));
            continue;
          }

          // 记录工具调用
          const actionId = this.idGen.generate('act');
          this.repo.insertToolAction({
            action_id: actionId,
            turn_id: turnId,
            tool_name: toolName,
            arguments: toolCall.arguments,
            result: null,
            status: 'pending',
            provider_tool_call_id: providerToolCallId,
            created_at: this.clock.now(),
          });

          // 执行工具
          const ctx: ToolExecutionContext = {
            caseId: input.caseId,
            turnId,
            sessionId: input.sessionId,
            agentKey: input.agentKey,
            messageId: outputMessageId,
            scenarioConfig: input.scenarioConfig,
          };

          const toolResult = this.toolExecutor.execute(toolName, args, ctx);
          toolCallResults.push(toolResult);

          // 更新工具调用记录
          this.repo.updateToolAction(actionId, {
            result: JSON.stringify(toolResult),
            status: 'completed',
          });

          // 收集产物版本 ID
          if (toolResult.artifact_version_id) {
            producedVersionIds.push(toolResult.artifact_version_id as string);
          }
        }
      }

      // 记录输出消息
      this.repo.insertMessage({
        message_id: outputMessageId,
        case_id: input.caseId,
        session_id: input.sessionId,
        source_agent: input.agentKey,
        target_agent: null,
        parent_message_id: inputMessageId,
        message_type: 'agent_output',
        content: piResult.content ?? JSON.stringify(toolCallResults),
        artifact_version_refs: producedVersionIds.length > 0 ? JSON.stringify(producedVersionIds) : null,
        issue_refs: null,
        created_at: this.clock.now(),
      });

      // Turn → completed
      this.repo.updateTurn(turnId, {
        status: transitionTurn('running', 'completed'),
        output_message_id: outputMessageId,
        produced_artifact_version_ids: JSON.stringify(producedVersionIds),
        finished_at: this.clock.now(),
      });

      // 提交事务：Turn 状态 + 所有副作用原子性写入
      this.repo.commitTransaction();

      return {
        turnId,
        status: 'completed',
        outputContent: piResult.content,
        toolCallResults,
      };
    } catch (error) {
      // 回滚事务：所有 DB 变更撤销（Turn、工具调用、产物等）
      this.repo.rollbackTransaction();

      const errorMsg = error instanceof Error ? error.message : String(error);

      // 在事务外记录 failed Turn（新事务）
      this.repo.insertTurn({
        turn_id: turnId,
        case_id: input.caseId,
        session_id: input.sessionId,
        sequence,
        status: 'failed' satisfies TurnStatus,
        input_message_id: null,
        output_message_id: null,
        context_snapshot_id: null,
        produced_artifact_version_ids: '[]',
        started_at: this.clock.now(),
        finished_at: this.clock.now(),
        retry_of_turn_id: null,
        provider_error: errorMsg,
      });

      return {
        turnId,
        status: 'failed',
        outputContent: null,
        toolCallResults: [],
        error: errorMsg,
      };
    }
  }

  private getNextSequence(caseId: string): number {
    const turns = this.repo.getTurnsByCase(caseId);
    return turns.length + 1;
  }
}
