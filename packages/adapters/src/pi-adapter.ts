/**
 * 真实 Pi Adapter
 * 基于 @earendil-works/pi-coding-agent SDK（Agent Runtime with tool calling and state management）
 *
 * 核心设计：
 * 1. 使用 Pi 原生 AgentSession + SessionManager，不自建 Agent 循环
 * 2. persistent → SessionManager.create(cwd, sessionDir) 文件持久化，崩溃后可恢复
 * 3. cold_per_version → SessionManager.inMemory() 每次新建
 * 4. 自定义工具通过 defineTool() 注册，Pi 内置循环自动执行
 * 5. resumeSession → SessionManager.open(path) 恢复完整历史（P0-2 修复）
 *
 * 铁律 6：API Key 不进日志/数据库/前端
 */

import {
  createAgentSession,
  createReadToolDefinition,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type {
  PiPort,
  PiSession,
  PiSessionOptions,
  PiMessage,
  PiToolDefinition,
  PiTurnResult,
  PiToolCall,
  PiToolExecutorFn,
} from '@forge-ai/contracts';
import { join, relative, resolve } from 'node:path';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';

/** 创建白名单 access 函数（铁律 6：只允许读 skills 目录） */
export function createWhitelistAccess(scenarioSkillsPath: string): (absolutePath: string) => Promise<void> {
  if (!existsSync(scenarioSkillsPath)) {
    throw new Error(`Skills directory not found: ${scenarioSkillsPath}. Check scenario.yaml skills config.`);
  }
  const allowedRoot = realpathSync(scenarioSkillsPath);
  return async (absolutePath: string) => {
    const realPath = realpathSync(absolutePath);  // 解析 symlink
    const rel = relative(allowedRoot, realPath);
    // 必须在 skills 目录内（不能 ../ 逃逸）
    if (rel.startsWith('..') || resolve(allowedRoot, rel) !== realPath) {
      throw new Error(`Access denied: ${absolutePath} is outside skills whitelist`);
    }
  };
}

/** 内部 Session 状态 */
interface SessionState {
  agentSession: AgentSession;
  sessionManager: SessionManager;
  agentKey: string;
  policy: string;
  /** 当前 Turn 的工具执行回调（每次 executeTurn 时设置） */
  currentToolExecutor: PiToolExecutorFn | null;
  /** Skill 资源加载器（可选） */
  resourceLoader?: DefaultResourceLoader;
}

export class RealPiAdapter implements PiPort {
  private sessions: Map<string, SessionState> = new Map();
  private modelRuntime: ModelRuntime | null = null;
  private modelId: string;
  private dataDir: string;

  constructor(options?: { modelId?: string; dataDir?: string }) {
    this.modelId = options?.modelId ?? process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';
    this.dataDir = options?.dataDir ?? process.env.PI_SESSION_DIR ?? './data/pi-sessions';
  }

  /** 懒初始化 ModelRuntime */
  private async getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create();
      // 铁律 6：API Key 从环境变量读取，不记录到日志
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (apiKey) {
        await this.modelRuntime.setRuntimeApiKey('deepseek', apiKey);
      }
    }
    return this.modelRuntime;
  }

  async createSession(agentKey: string, policy: string, scopeKey?: string, options?: PiSessionOptions): Promise<PiSession> {
    const sessionRef = `pi_${agentKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const runtime = await this.getModelRuntime();
    const model = runtime.getModel('deepseek', this.modelId);

    // persistent → 文件持久化（崩溃后可通过 SessionManager.open 恢复）
    // cold_per_version → 内存（不持久化）
    const sessionManager = policy === 'persistent'
      ? SessionManager.create(process.cwd(), join(this.dataDir, sessionRef))
      : SessionManager.inMemory(process.cwd());

    // 如果有 skills 配置，创建 resourceLoader
    let resourceLoader: DefaultResourceLoader | undefined;
    if (options?.scenarioSkillsPath && options.agentSkills?.length) {
      resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        additionalSkillPaths: [options.scenarioSkillsPath],
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: (base) => ({
          skills: base.skills.filter(s => options.agentSkills!.includes(s.name)),
          diagnostics: base.diagnostics,
        }),
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      modelRuntime: runtime,
      model: model ?? undefined,
      sessionManager,
      noTools: 'builtin',      // 禁用 Pi 内置工具（read/bash/edit/write），保留自定义工具
      customTools: this.buildCustomTools(sessionRef, options),
      resourceLoader,
    });

    this.sessions.set(sessionRef, {
      agentSession: session,
      sessionManager,
      agentKey,
      policy,
      currentToolExecutor: null,
      resourceLoader,
    });

    return { session_ref: sessionRef };
  }

  /**
   * 注册 DB session_id -> Pi 内部 session 的映射（别名）。
   * turn-executor 用 DB session_id 调 executeTurn，但 createSession/resumeSession 用 pi_session_ref 做 map key，
   * 所以需要别名桥接。
   *
   * 必须显式传入刚 createSession/resumeSession 返回的 piSessionRef，直接别名到它对应的 state。
   * 不能用「按 agentKey 循环找现有 state」的旧逻辑——cold_per_version 下旧 session 已被 closeSession
   * dispose，但其别名 key 可能仍残留在 map 中，循环会命中已 dispose 的旧 state，导致新 Turn 在死 session 上 prompt 返回空。
   */
  registerSession(sessionId: string, piSessionRef: string): void {
    const state = this.sessions.get(piSessionRef);
    if (state) {
      this.sessions.set(sessionId, state);
    }
  }

  /**
   * 恢复 Session（P0-2 修复 + 2.3 跨进程恢复：从文件恢复完整历史，绝不创建空 Context）
   *
   * 关键：用 SessionManager.open 显式打开 session 文件，而不是 continueRecent。
   * continueRecent 在找不到文件 / cwd 不匹配 / 读盘竞态时会**静默新建空 session**，
   * 历史丢失却不报错--这会让 persistent session 续跑后"上下文不含之前 Turn 历史"，
   * 直接违反 2.3 硬指标。这里改为显式定位 .jsonl 文件，找不到就抛错（fail loud）。
   */
  async resumeSession(sessionRef: string, options?: PiSessionOptions): Promise<PiSession> {
    // 已在内存中（同一进程内复用，幂等）
    if (this.sessions.has(sessionRef)) {
      return { session_ref: sessionRef };
    }

    // persistent session 持久化在 dataDir/<sessionRef>/ 下，每个 sessionRef 目录含一个 .jsonl
    const sessionDir = join(this.dataDir, sessionRef);
    if (!existsSync(sessionDir)) {
      throw new Error(
        `Cannot resume session ${sessionRef}: no persisted session dir at ${sessionDir}`,
      );
    }

    // 显式定位 session 文件（取 mtime 最新的一条）。每个 sessionRef 目录正常只有 1 个 .jsonl。
    let jsonlFiles: string[] = [];
    try {
      jsonlFiles = readdirSync(sessionDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(sessionDir, f));
    } catch {
      // 读盘失败，下面按空处理 -> 抛错
    }
    if (jsonlFiles.length === 0) {
      throw new Error(
        `Cannot resume session ${sessionRef}: no .jsonl session file in ${sessionDir}`,
      );
    }
    const sessionFile = jsonlFiles
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].p;

    const sessionManager = SessionManager.open(sessionFile, sessionDir, process.cwd());
    const runtime = await this.getModelRuntime();
    const model = runtime.getModel('deepseek', this.modelId);

    // 重建 resourceLoader（persistent 崩溃恢复 skill 仍在）
    let resourceLoader: DefaultResourceLoader | undefined;
    if (options?.scenarioSkillsPath && options.agentSkills?.length) {
      resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        additionalSkillPaths: [options.scenarioSkillsPath],
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: (base) => ({
          skills: base.skills.filter(s => options.agentSkills!.includes(s.name)),
          diagnostics: base.diagnostics,
        }),
      });
      await resourceLoader.reload();
    }

    const { session } = await createAgentSession({
      cwd: process.cwd(),
      modelRuntime: runtime,
      model: model ?? undefined,
      sessionManager,
      noTools: 'builtin',
      customTools: this.buildCustomTools(sessionRef, options),
      resourceLoader,
    });

    this.sessions.set(sessionRef, {
      agentSession: session,
      sessionManager,
      agentKey: 'restored',
      policy: 'persistent',
      currentToolExecutor: null,
      resourceLoader,
    });

    return { session_ref: sessionRef };
  }

  async closeSession(sessionRef: string): Promise<void> {
    const state = this.sessions.get(sessionRef);
    if (state) {
      state.agentSession.dispose();
      // 清除该 state 的所有 key（pi_session_ref 主键 + 任何 DB session_id 别名），
      // 否则残留别名会被 registerSession 之后的 executeTurn 命中已 dispose 的死 session。
      for (const [key, s] of this.sessions) {
        if (s === state) this.sessions.delete(key);
      }
    }
  }

  /** 获取 session 已加载的 skills 列表 */
  getSkills(sessionRef: string): Array<{ name: string; description: string }> {
    const state = this.sessions.get(sessionRef);
    if (!state?.resourceLoader) return [];
    const { skills } = state.resourceLoader.getSkills();
    return skills.map(s => ({ name: s.name, description: s.description }));
  }

  /**
   * 执行 Turn：通过 Pi 原生 Agent 循环（prompt → model → tool call → execute → model sees result → continue）
   * 不自建工具循环。工具在 customTools 的 execute() 中通过 toolExecutor 回调执行。
   */
  async executeTurn(
    session: PiSession,
    messages: PiMessage[],
    tools: PiToolDefinition[],
    toolExecutor?: PiToolExecutorFn,
  ): Promise<PiTurnResult> {
    const state = this.sessions.get(session.session_ref);
    if (!state) {
      return {
        content: null,
        tool_calls: [],
        finish_reason: 'error',
        error: `Session not found: ${session.session_ref}`,
      };
    }

    // 设置当前 Turn 的工具执行回调
    state.currentToolExecutor = toolExecutor ?? null;

    // 收集工具调用事件
    const toolCalls: PiToolCall[] = [];
    let finalContent: string | null = null;

    const unsubscribe = state.agentSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'tool_execution_start') {
        toolCalls.push({
          id: event.toolCallId,
          name: event.toolName,
          arguments: JSON.stringify(event.args),
        });
      }
      if (event.type === 'message_end') {
        // 收集最终 assistant 文本
        const msg = (event as any).message;
        if (msg && msg.role === 'assistant') {
          const textParts = (msg.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text);
          if (textParts.length > 0) {
            finalContent = textParts.join('\n');
          }
        }
      }
    });

    try {
      // 构建 prompt：将 system prompt 和 user message 合并
      const promptText = this.buildPromptText(messages);

      // Pi 原生 Agent 循环：model -> tool call -> execute -> model sees result -> continue
      // 真实模型（尤其 cold_per_version 下的 flash）偶发返回完全空响应（无文本、无工具调用）。
      // 空响应没有副作用（未调工具），在事务内重试是安全的。最多重试 2 次，追加明确指令迫使模型调工具。
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        toolCalls.length = 0;
        finalContent = null;
        const p = attempt === 1
          ? promptText
          : `${promptText}\n\n<nudge>你刚才没有返回任何内容，也没有调用工具。你必须调用工具完成任务，禁止只回复空内容。请现在调用工具。</nudge>`;
        await state.agentSession.prompt(p);
        if (toolCalls.length > 0 || finalContent) break;
        console.warn(`[PiAdapter] 空响应（attempt ${attempt}/${MAX_ATTEMPTS}, agent=${state.agentKey}），重试...`);
      }

      return {
        content: finalContent,
        tool_calls: toolCalls,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    } catch (err) {
      return {
        content: null,
        tool_calls: toolCalls,
        finish_reason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      unsubscribe();
      state.currentToolExecutor = null;
    }
  }

  /**
   * 构建 Forge 自定义工具（通过 defineTool 注册到 Pi Agent Runtime）
   * Pi 的内置 Agent 循环会自动调用这些工具的 execute()
   */
  private buildCustomTools(sessionRef: string, options?: PiSessionOptions): ToolDefinition[] {
    const getState = () => this.sessions.get(sessionRef);

    /** 通用工具执行：调用 turn-executor 提供的 toolExecutor 回调 */
    const executeViaCallback = (toolCallId: string, toolName: string, params: Record<string, unknown>) => {
      const state = getState();
      if (!state?.currentToolExecutor) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No tool executor available' }) }],
          details: undefined,
          isError: true,
        };
      }
      try {
        const result = state.currentToolExecutor(toolCallId, toolName, params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: undefined,
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
          isError: true,
        };
      }
    };

    const tools: ToolDefinition[] = [
      defineTool({
        name: 'publish_artifact',
        label: 'Publish Artifact',
        description: '发布或修订一个产物。系统自动补齐版本号、时间、来源等工程数据。',
        parameters: Type.Object({
          artifact_type: Type.String({ description: '配置里注册的产物类型' }),
          content: Type.String({ description: '业务内容本身' }),
          summary: Type.String({ description: '这一轮做了什么' }),
        }),
        execute: async (toolCallId, params) => executeViaCallback(toolCallId, 'publish_artifact', params as Record<string, unknown>),
      }),
      defineTool({
        name: 'submit_evaluation',
        label: 'Submit Evaluation',
        description: '提交审核结论。系统自动绑定到被审核的产物版本并为每个 issue 生成稳定 ID。',
        parameters: Type.Object({
          verdict: Type.Union([
            Type.Literal('approve'),
            Type.Literal('repair'),
            Type.Literal('regenerate'),
            Type.Literal('input_problem'),
          ]),
          issues: Type.Array(Type.Object({
            severity: Type.Union([Type.Literal('blocking'), Type.Literal('major'), Type.Literal('minor')]),
            anchor: Type.Object({ type: Type.String(), value: Type.String() }),
            problem: Type.String(),
            evidence: Type.String(),
          })),
          summary: Type.String(),
        }),
        execute: async (toolCallId, params) => executeViaCallback(toolCallId, 'submit_evaluation', params as Record<string, unknown>),
      }),
      defineTool({
        name: 'route_message',
        label: 'Route Message',
        description: '把任务或返修指令派给某个 Agent。',
        parameters: Type.Object({
          target_agent: Type.String({ description: '配置里的 agent key' }),
          instruction: Type.String(),
          scope: Type.Optional(Type.Object({
            editable_anchors: Type.Optional(Type.Array(Type.String())),
            frozen_anchors: Type.Optional(Type.Array(Type.String())),
            issue_ids: Type.Optional(Type.Array(Type.String())),
          })),
          reason: Type.Optional(Type.String()),
        }),
        execute: async (toolCallId, params) => executeViaCallback(toolCallId, 'route_message', params as Record<string, unknown>),
      }),
      defineTool({
        name: 'approve_delivery',
        label: 'Approve Delivery',
        description: '申请交付。系统独立执行交付门禁核对，核对不通过就拒绝。',
        parameters: Type.Object({
          artifact_type: Type.Optional(Type.String({ description: '要交付的产物类型（可选，系统自动定位）' })),
          summary: Type.String(),
        }),
        execute: async (toolCallId, params) => executeViaCallback(toolCallId, 'approve_delivery', params as Record<string, unknown>),
      }),
      defineTool({
        name: 'request_human_input',
        label: 'Request Human Input',
        description: '请求人工输入。Case 将停在 waiting_human 状态。',
        parameters: Type.Object({
          reason: Type.String(),
          question: Type.Optional(Type.String()),
        }),
        execute: async (toolCallId, params) => executeViaCallback(toolCallId, 'request_human_input', params as Record<string, unknown>),
      }),
    ];

    // 5+1：加受限 read 工具（铁律 6：只允许读 skills 目录）
    if (options?.scenarioSkillsPath && options.agentSkills?.length) {
      const skillsPath = options.scenarioSkillsPath;
      const readTool = createReadToolDefinition(process.cwd(), {
        operations: {
          access: createWhitelistAccess(skillsPath),
          readFile: async (absolutePath: string) => {
            const { readFile } = await import('node:fs/promises');
            return readFile(absolutePath);
          },
        },
      });
      tools.push(readTool as unknown as ToolDefinition);
    }

    return tools;
  }

  /**
   * 构建发给 Pi 的 prompt 文本
   * 将 system prompt 作为指令前缀，user message 作为任务内容
   */
  private buildPromptText(messages: PiMessage[]): string {
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role === 'user');
    const userContent = userMsgs.map(m => m.content).join('\n\n');

    if (systemMsg) {
      return `<instructions>\n${systemMsg.content}\n</instructions>\n\n<task>\n${userContent}\n</task>`;
    }
    return userContent;
  }
}
