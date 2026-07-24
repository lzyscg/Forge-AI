/**
 * 真实 Pi Adapter
 * 基于 @earendil-works/pi-ai SDK，使用 DeepSeek 作为底层模型。
 *
 * 探针结论：
 * 1. Session = Context 对象（systemPrompt + messages + tools），可序列化
 *    - persistent: 跨 Turn 维护同一 Context
 *    - cold_per_version: 每次新建 Context
 * 2. 工具调用有稳定 id（toolCall.id），可用作幂等键
 * 3. DeepSeek 原生支持（DEEPSEEK_API_KEY 环境变量）
 *
 * 铁律 6：API Key 不进日志/数据库/前端
 */

import {
  createModels,
  type Context,
  type Tool,
  type Message,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import type {
  PiPort,
  PiSession,
  PiMessage,
  PiToolDefinition,
  PiTurnResult,
  PiToolCall,
  PiToolExecutorFn,
} from '@forge-ai/contracts';

/** 内部 Session 状态 */
interface SessionState {
  sessionRef: string;
  agentKey: string;
  policy: string;
  context: Context;
}

/** 最大工具循环次数（防止无限循环） */
const MAX_TOOL_ITERATIONS = 10;

export class RealPiAdapter implements PiPort {
  private sessions: Map<string, SessionState> = new Map();
  private sessionCounter = 0;
  private models: ReturnType<typeof createModels>;
  private modelId: string;

  constructor(options?: { modelId?: string }) {
    // 初始化 Models 集合，注册 DeepSeek provider
    this.models = createModels();
    this.models.setProvider(deepseekProvider());
    this.modelId = options?.modelId ?? process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';
  }

  async createSession(agentKey: string, policy: string, scopeKey?: string): Promise<PiSession> {
    this.sessionCounter++;
    // 使用外部传入的 session_ref（由 worker 生成）
    // 如果未传入，则生成一个默认的
    const sessionRef = `pi_session_${this.sessionCounter}_${agentKey}`;

    // 创建空 Context（system prompt 在 executeTurn 时设置）
    const context: Context = {
      messages: [],
      tools: [],
    };

    this.sessions.set(sessionRef, {
      sessionRef,
      agentKey,
      policy,
      context,
    });

    return { session_ref: sessionRef };
  }

  /**
   * 注册一个已存在的 session（由 worker 调用，用于关联 DB session_id 和 Pi session）
   */
  registerSession(sessionRef: string, agentKey: string, policy: string): void {
    if (!this.sessions.has(sessionRef)) {
      this.sessions.set(sessionRef, {
        sessionRef,
        agentKey,
        policy,
        context: { messages: [], tools: [] },
      });
    }
  }

  async resumeSession(sessionRef: string): Promise<PiSession> {
    // 如果 session 不在内存中，创建一个空的（cold start）
    if (!this.sessions.has(sessionRef)) {
      this.sessions.set(sessionRef, {
        sessionRef,
        agentKey: 'unknown',
        policy: 'persistent',
        context: { messages: [], tools: [] },
      });
    }
    return { session_ref: sessionRef };
  }

  async closeSession(sessionRef: string): Promise<void> {
    this.sessions.delete(sessionRef);
  }

  async executeTurn(
    session: PiSession,
    messages: PiMessage[],
    tools: PiToolDefinition[],
    toolExecutor?: PiToolExecutorFn,
  ): Promise<PiTurnResult> {
    const sessionState = this.sessions.get(session.session_ref);
    if (!sessionState) {
      return {
        content: null,
        tool_calls: [],
        finish_reason: 'error',
        error: `Session not found: ${session.session_ref}`,
      };
    }

    // 获取模型
    const model = this.models.getModel('deepseek', this.modelId);
    if (!model) {
      return {
        content: null,
        tool_calls: [],
        finish_reason: 'error',
        error: `Model not found: deepseek/${this.modelId}`,
      };
    }

    // 转换工具定义为 Pi 格式
    const piTools: Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Tool['parameters'],
    }));

    // 构建 Context
    const isPersistent = sessionState.policy === 'persistent';

    if (isPersistent) {
      // persistent: 追加到现有 Context
      // 更新 system prompt（取 messages 中的 system 消息）
      const systemMsg = messages.find((m) => m.role === 'system');
      if (systemMsg) {
        sessionState.context.systemPrompt = systemMsg.content;
      }
      // 追加工具定义
      sessionState.context.tools = piTools;
      // 追加用户消息
      const userMsgs = messages.filter((m) => m.role === 'user');
      for (const um of userMsgs) {
        sessionState.context.messages.push({
          role: 'user',
          content: um.content,
          timestamp: Date.now(),
        });
      }
    } else {
      // cold_per_version: 每次新建 Context
      const systemMsg = messages.find((m) => m.role === 'system');
      sessionState.context = {
        systemPrompt: systemMsg?.content ?? '',
        messages: [],
        tools: piTools,
      };
      const userMsgs = messages.filter((m) => m.role === 'user');
      for (const um of userMsgs) {
        sessionState.context.messages.push({
          role: 'user',
          content: um.content,
          timestamp: Date.now(),
        });
      }
    }

    // 工具循环：调用模型 → 如果有工具调用 → 执行 → 追加结果 → 再次调用
    const allToolCalls: PiToolCall[] = [];
    let finalContent: string | null = null;
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      try {
        // 调用 Pi SDK
        const response: AssistantMessage = await this.models.complete(model, sessionState.context);

        // 检查错误
        if (response.stopReason === 'error') {
          return {
            content: null,
            tool_calls: allToolCalls,
            finish_reason: 'error',
            error: response.errorMessage ?? 'Model returned error',
          };
        }

        // 追加 assistant 消息到 Context
        sessionState.context.messages.push(response);

        // 提取工具调用
        const toolCallBlocks = response.content.filter(
          (b): b is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } =>
            b.type === 'toolCall',
        );

        if (toolCallBlocks.length === 0) {
          // 没有工具调用，提取文本内容
          const textBlocks = response.content.filter(
            (b): b is { type: 'text'; text: string } => b.type === 'text',
          );
          finalContent = textBlocks.map((b) => b.text).join('\n') || null;
          break;
        }

        // 有工具调用
        for (const tc of toolCallBlocks) {
          const piToolCall: PiToolCall = {
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          };
          allToolCalls.push(piToolCall);

          // 如果有 toolExecutor 回调，执行工具并追加结果到 Context
          if (toolExecutor) {
            try {
              const result = toolExecutor(tc.id, tc.name, tc.arguments as Record<string, unknown>);
              // 追加工具结果到 Context（让模型看到结果）
              sessionState.context.messages.push({
                role: 'toolResult',
                toolCallId: tc.id,
                toolName: tc.name,
                content: [{ type: 'text', text: JSON.stringify(result) }],
                isError: false,
                timestamp: Date.now(),
              });
            } catch (err) {
              // 工具执行失败，追加错误结果
              sessionState.context.messages.push({
                role: 'toolResult',
                toolCallId: tc.id,
                toolName: tc.name,
                content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
                timestamp: Date.now(),
              });
            }
          }
        }

        // 如果没有 toolExecutor，直接返回工具调用（让 turn-executor 处理）
        if (!toolExecutor) {
          return {
            content: finalContent,
            tool_calls: allToolCalls,
            finish_reason: 'tool_calls',
          };
        }

        // 有 toolExecutor，继续循环让模型看到工具结果
      } catch (err) {
        return {
          content: null,
          tool_calls: allToolCalls,
          finish_reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      content: finalContent,
      tool_calls: allToolCalls,
      finish_reason: allToolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }
}
