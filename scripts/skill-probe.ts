/**
 * SDK 探针：验证 noTools:'builtin' + customTools:[createReadTool, ...] 能共存
 * 零 token：不实际调模型，只验证 session 创建不报错
 */
import {
  createAgentSession,
  createReadToolDefinition,
  defineTool,
  SessionManager,
  ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// 验证 createReadToolDefinition 能和 customTools 共存
const readTool = createReadToolDefinition(process.cwd()) as unknown as ToolDefinition;
const dummyTool = defineTool({
  name: 'dummy',
  label: 'Dummy',
  description: 'test',
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
});

// 零 token：不实际调模型，只验证 session 创建不报错
const runtime = await ModelRuntime.create();
const { session } = await createAgentSession({
  modelRuntime: runtime,
  sessionManager: SessionManager.inMemory(),
  noTools: 'builtin',  // 禁用内置工具
  customTools: [readTool, dummyTool],  // 但 customTools 接受 readTool
});
console.log('SDK probe PASS: noTools:builtin + customTools:[readTool, ...] coexist');
session.dispose();
