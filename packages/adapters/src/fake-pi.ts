/**
 * Fake Pi Adapter
 * 确定性脚本化响应，零 Token 成本，行为完全可预测。
 * 按场景配置返回预设的工具调用序列。
 */

import type {
  PiPort,
  PiSession,
  PiMessage,
  PiToolDefinition,
  PiTurnResult,
  PiToolCall,
} from '@forge-ai/contracts';

export interface FakePiScript {
  /** 每个 turn 的预设响应，按顺序消费 */
  turns: FakePiTurnScript[];
}

export interface FakePiTurnScript {
  /** 匹配条件：当前是第几个 turn（0-based），或匹配 agent key */
  agentKey?: string;
  /** 预设的文本输出 */
  content?: string;
  /** 预设的工具调用 */
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  /** 完成原因 */
  finishReason?: 'stop' | 'tool_calls';
}

export class FakePiAdapter implements PiPort {
  private scripts: Map<string, FakePiScript> = new Map();
  private turnCounters: Map<string, number> = new Map();
  private sessionCounter = 0;
  private contextResolver: (() => Record<string, string>) | null = null;

  /**
   * 注册一个场景的脚本
   */
  registerScript(scenarioId: string, script: FakePiScript): void {
    this.scripts.set(scenarioId, script);
    this.turnCounters.set(scenarioId, 0);
  }

  /**
   * 设置上下文解析器（用于动态替换脚本中的占位符）
   */
  setContextResolver(resolver: () => Record<string, string>): void {
    this.contextResolver = resolver;
  }

  /**
   * 重置计数器（用于测试）
   */
  reset(): void {
    for (const key of this.turnCounters.keys()) {
      this.turnCounters.set(key, 0);
    }
  }

  async createSession(agentKey: string, policy: string, scopeKey?: string): Promise<PiSession> {
    this.sessionCounter++;
    return { session_ref: `fake_session_${this.sessionCounter}_${agentKey}` };
  }

  async resumeSession(sessionRef: string): Promise<PiSession> {
    return { session_ref: sessionRef };
  }

  async closeSession(sessionRef: string): Promise<void> {
    // no-op for fake
  }

  async executeTurn(
    session: PiSession,
    messages: PiMessage[],
    tools: PiToolDefinition[],
  ): Promise<PiTurnResult> {
    // 找到当前活跃的脚本（简化：使用第一个注册的脚本）
    const scriptKey = this.scripts.keys().next().value;
    if (!scriptKey) {
      return { content: 'No script registered', tool_calls: [], finish_reason: 'stop' };
    }

    const script = this.scripts.get(scriptKey)!;
    const turnIndex = this.turnCounters.get(scriptKey) ?? 0;
    this.turnCounters.set(scriptKey, turnIndex + 1);

    // 找到匹配的 turn script
    const turnScript = script.turns[turnIndex];
    if (!turnScript) {
      return { content: 'Script exhausted', tool_calls: [], finish_reason: 'stop' };
    }

    const toolCalls: PiToolCall[] = (turnScript.toolCalls ?? []).map((tc, i) => {
      let argsStr = JSON.stringify(tc.arguments);
      // 动态替换占位符
      if (this.contextResolver) {
        const context = this.contextResolver();
        for (const [key, value] of Object.entries(context)) {
          argsStr = argsStr.replace(new RegExp(key, 'g'), value);
        }
      }
      return {
        id: `fake_tc_${turnIndex}_${i}`,
        name: tc.name,
        arguments: argsStr,
      };
    });

    return {
      content: turnScript.content ?? null,
      tool_calls: toolCalls,
      finish_reason: turnScript.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    };
  }
}
