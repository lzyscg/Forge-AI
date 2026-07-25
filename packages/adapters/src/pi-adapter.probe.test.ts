/**
 * P0-1 零 Token 探测测试
 * 验证 @earendil-works/pi-coding-agent SDK 可加载、Session 可创建、工具可注册。
 * 不消耗任何真实 Token（不调用模型 API）。
 *
 * 验收标准（来自返修清单）：
 * 1. pi-coding-agent 可正常 import
 * 2. createAgentSession 可创建 in-memory session
 * 3. defineTool 可注册自定义工具
 * 4. session.subscribe 可订阅事件
 */

import { describe, it, expect } from 'vitest';

describe('P0-1: Pi Coding Agent SDK 探测（零 Token）', () => {
  it('pi-coding-agent 核心 API 可正常导入', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');

    // 验证关键导出存在
    expect(sdk.createAgentSession).toBeTypeOf('function');
    expect(sdk.defineTool).toBeTypeOf('function');
    expect(sdk.SessionManager).toBeDefined();
    expect(sdk.ModelRuntime).toBeDefined();
    expect(sdk.AgentSession).toBeDefined();
  });

  it('SessionManager.inMemory() 可创建内存 session manager', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const sm = SessionManager.inMemory(process.cwd());
    expect(sm).toBeDefined();
    expect(sm.isPersisted()).toBe(false);
  });

  it('defineTool 可注册自定义工具（TypeBox Schema）', async () => {
    const { defineTool } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');

    const tool = defineTool({
      name: 'noop_tool',
      label: 'Noop Tool',
      description: 'A test tool that does nothing',
      parameters: Type.Object({
        input: Type.String({ description: 'test input' }),
      }),
      execute: async (toolCallId, params) => {
        return {
          content: [{ type: 'text' as const, text: `noop: ${params.input}` }],
          details: undefined,
          isError: false,
        };
      },
    });

    expect(tool.name).toBe('noop_tool');
    expect(tool.description).toBe('A test tool that does nothing');
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeTypeOf('function');
  });

  it('createAgentSession 可创建 in-memory session（不需要 API Key）', async () => {
    const { createAgentSession, SessionManager, defineTool } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');

    const testTool = defineTool({
      name: 'probe_tool',
      label: 'Probe',
      description: 'Probe tool for testing',
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(params) }],
        details: undefined,
        isError: false,
      }),
    });

    // 创建 session（不需要真实 API Key，因为不调用 prompt）
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      sessionManager: SessionManager.inMemory(process.cwd()),
      noTools: 'builtin',  // 只禁用内置工具，保留 custom tools
      customTools: [testTool],
    });

    expect(session).toBeDefined();

    // 验证可以订阅事件
    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event.type);
    });
    expect(unsubscribe).toBeTypeOf('function');

    // 验证工具已注册
    const allTools = session.getAllTools();
    const probeTool = allTools.find((t: any) => t.name === 'probe_tool');
    expect(probeTool).toBeDefined();

    // 清理
    unsubscribe();
    session.dispose();
  });

  it('RealPiAdapter 可实例化且接口完整', async () => {
    const { RealPiAdapter } = await import('@forge-ai/adapters');

    const adapter = new RealPiAdapter({ modelId: 'deepseek-v4-flash', dataDir: '/tmp/pi-probe-test' });

    // 验证接口方法存在
    expect(adapter.createSession).toBeTypeOf('function');
    expect(adapter.resumeSession).toBeTypeOf('function');
    expect(adapter.closeSession).toBeTypeOf('function');
    expect(adapter.executeTurn).toBeTypeOf('function');
    expect(adapter.registerSession).toBeTypeOf('function');
  });
});
