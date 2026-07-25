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
  /** P1-2 修复：当前活跃的 scenarioId，用于路由到对应 script */
  private activeScenarioId: string | null = null;

  /**
   * 注册一个场景的脚本
   */
  registerScript(scenarioId: string, script: FakePiScript): void {
    this.scripts.set(scenarioId, script);
    this.turnCounters.set(scenarioId, 0);
    // 自动设置为活跃场景（最后一个注册的）
    this.activeScenarioId = scenarioId;
  }

  /**
   * P1-2 修复：显式设置活跃场景 ID
   */
  setActiveScenario(scenarioId: string): void {
    this.activeScenarioId = scenarioId;
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

  /**
   * 设置某个场景的 turn 计数器（崩溃恢复续跑时由 worker 调用）。
   * 让 Fake Pi 从“最后完成 Turn 的下一个”脚本位置继续消费，避免续跑时脚本错位。
   * index 传 lastCompletedTurn.sequence（1-based）正好对应 0-based 的下一个脚本索引。
   */
  setTurnCounter(scenarioId: string, index: number): void {
    if (this.scripts.has(scenarioId)) {
      this.turnCounters.set(scenarioId, Math.max(0, index));
      this.activeScenarioId = scenarioId;
    }
  }
  
  /** PiPort 接口方法：委托给 setContextResolver */
  registerContextResolver(fn: () => Record<string, string>): void {
    this.setContextResolver(fn);
  }
  
  /** PiPort 接口方法：委托给 setTurnCounter */
  alignTurnCounter(scenarioId: string, sequence: number): void {
    this.setTurnCounter(scenarioId, sequence);
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
    // P1-2 修复：按 activeScenarioId 路由到对应 script（而非永远取第一个）
    const scriptKey = this.activeScenarioId ?? this.scripts.keys().next().value;
    if (!scriptKey || !this.scripts.has(scriptKey)) {
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
      // P1-1 修复：稳定的 tool_call_id
      // 使用 scenarioId + turnIndex + toolIndex 组合，确保同一 Turn 重试时 ID 不变
      return {
        id: `${scriptKey}_t${turnIndex}_tc${i}`,
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
