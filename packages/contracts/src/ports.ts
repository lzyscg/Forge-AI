/**
 * 端口接口定义（铁律 5：application 层通过端口调用外部实现，不直接碰具体实现）
 */

import type { DeliveryValidatorConfig, ScenarioConfig } from './scenario.js';
import type { ToolName } from './tools.js';
import type {
  CaseStatus,
  ExecutionLease,
  ExecutionLeaseAbortResult,
} from './case.js';

// === Pi 端口 ===
export interface PiSessionOptions {
  scenarioId?: string;
  scenarioSkillsPath?: string;  // scenarios/<id>/skills/
  agentSkills?: string[];       // AgentConfig.skills
}

export interface PiSession {
  session_ref: string;
}

export interface PiToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface PiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: PiToolCall[];
  tool_call_id?: string;
}

export interface PiToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface PiTurnResult {
  content: string | null;
  tool_calls: PiToolCall[];
  finish_reason: 'stop' | 'tool_calls' | 'error';
  error?: string;
}

/**
 * 工具执行回调：由 turn-executor 提供，adapter 在内部循环中调用。
 * 回调负责幂等检查 + 持久化 + 实际执行。
 */
export type PiToolExecutorFn = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Record<string, unknown>;

export interface PiPort {
  createSession(agentKey: string, policy: string, scopeKey?: string, options?: PiSessionOptions): Promise<PiSession>;
  resumeSession(sessionRef: string, options?: PiSessionOptions): Promise<PiSession>;
  closeSession(sessionRef: string): Promise<void>;
  executeTurn(
    session: PiSession,
    messages: PiMessage[],
    tools: PiToolDefinition[],
    toolExecutor?: PiToolExecutorFn,
  ): Promise<PiTurnResult>;
  /** 注册上下文解析器（FakePi 用于动态替换脚本占位符） */
  registerContextResolver?(fn: () => Record<string, string>): void;
  /** 对齐 Turn 计数器（FakePi 崩溃恢复续跑时避免脚本错位） */
  alignTurnCounter?(scenarioId: string, sequence: number): void;
  /** 注册 DB session_id -> Pi 内部 session 的映射（RealPi 用于别名桥接） */
  registerSession?(sessionId: string, piSessionRef: string): void;
  /** 获取 session 已加载的 skills 列表 */
  getSkills?(sessionRef: string): Array<{ name: string; description: string }>;
}

// === Repository 端口 ===
export interface RepositoryPort {
  // 事务支持
  beginTransaction(): void;
  commitTransaction(): void;
  rollbackTransaction(): void;
  runInTransaction<T>(fn: () => T): T;

  // Cases
  getDbInstanceId(): string;
  insertCase(record: Record<string, unknown>): void;
  updateCase(caseId: string, fields: Record<string, unknown>): void;
  getCase(caseId: string): Record<string, unknown> | null;
  getCasesByStatus(status: string): Record<string, unknown>[];
  acquireExecutionLease(caseId: string, lease: ExecutionLease): boolean;
  getExecutionLease(caseId: string): ExecutionLease | null;
  validateExecutionLease(caseId: string, runnerTokenSha256: string): boolean;
  transferExecutionLease(
    caseId: string,
    oldRunnerTokenSha256: string,
    lease: ExecutionLease,
  ): boolean;
  heartbeatExecutionLease(
    caseId: string,
    runnerTokenSha256: string,
    heartbeatAt: string,
  ): boolean;
  abortCaseWithExecutionLease(
    caseId: string,
    runnerTokenSha256: string,
    stoppedAt: string,
    abortableStatuses: readonly CaseStatus[],
  ): ExecutionLeaseAbortResult;
  clearExecutionLease(caseId: string): void;
  updateCaseAndClearExecutionLease(
    caseId: string,
    fields: Record<string, unknown>,
  ): void;

  // Turns
  insertTurn(record: Record<string, unknown>): void;
  updateTurn(turnId: string, fields: Record<string, unknown>): void;
  getTurn(turnId: string): Record<string, unknown> | null;
  getTurnsByCase(caseId: string): Record<string, unknown>[];
  getIncompleteTurns(caseId: string): Record<string, unknown>[];
  getLastCompletedTurn(caseId: string): Record<string, unknown> | null;

  // Messages
  insertMessage(record: Record<string, unknown>): void;
  getMessage(messageId: string): Record<string, unknown> | null;
  getMessagesByCase(caseId: string): Record<string, unknown>[];

  // Sessions
  insertSession(record: Record<string, unknown>): void;
  updateSession(sessionId: string, fields: Record<string, unknown>): void;
  getSession(sessionId: string): Record<string, unknown> | null;
  getActiveSession(caseId: string, agentKey: string, scopeKey?: string): Record<string, unknown> | null;
  closeSessionsByCase(caseId: string): void;

  // Artifacts
  insertArtifact(record: Record<string, unknown>): void;
  updateArtifact(artifactId: string, fields: Record<string, unknown>): void;
  getArtifact(artifactId: string): Record<string, unknown> | null;
  getArtifactByTypeAndCase(caseId: string, artifactType: string): Record<string, unknown> | null;

  // Artifact Versions
  insertArtifactVersion(record: Record<string, unknown>): void;
  updateArtifactVersion(versionId: string, fields: Record<string, unknown>): void;
  getArtifactVersion(versionId: string): Record<string, unknown> | null;
  getVersionsByArtifact(artifactId: string): Record<string, unknown>[];
  getLatestVersion(artifactId: string): Record<string, unknown> | null;
  getVersionByContentHash(artifactId: string, contentHash: string): Record<string, unknown> | null;

  // Issues
  insertIssue(record: Record<string, unknown>): void;
  updateIssue(issueId: string, fields: Record<string, unknown>): void;
  getIssue(issueId: string): Record<string, unknown> | null;
  getIssuesByCase(caseId: string): Record<string, unknown>[];
  getBlockingIssuesByCase(caseId: string): Record<string, unknown>[];

  // Issue Events
  insertIssueEvent(record: Record<string, unknown>): void;
  getIssueEvents(issueId: string): Record<string, unknown>[];

  // Revision Instructions
  insertRevisionInstruction(record: Record<string, unknown>): void;
  updateRevisionInstruction(id: string, fields: Record<string, unknown>): void;
  getRevisionInstruction(id: string): Record<string, unknown> | null;
  getActiveRevisionInstructions(caseId: string): Record<string, unknown>[];
  getRevisionInstructionsByCase(caseId: string): Record<string, unknown>[];

  // Context Snapshots
  insertContextSnapshot(record: Record<string, unknown>): void;
  getContextSnapshot(id: string): Record<string, unknown> | null;

  // Delivery Gate Results
  insertDeliveryGateResult(record: Record<string, unknown>): void;
  getDeliveryGateResults(caseId: string): Record<string, unknown>[];

  // Tool Actions
  insertToolAction(record: Record<string, unknown>): void;
  updateToolAction(actionId: string, fields: Record<string, unknown>): void;
  getToolActionByProviderId(turnId: string, providerToolCallId: string): Record<string, unknown> | null;
  getToolActionsByTurn(turnId: string): Record<string, unknown>[];

  // Route Edges
  insertRouteEdge(record: Record<string, unknown>): void;
  getRouteEdgesByCase(caseId: string): Record<string, unknown>[];

  // Control Events
  insertControlEvent(record: Record<string, unknown>): void;
  getControlEventsByCase(caseId: string): Record<string, unknown>[];
}

// === 时钟端口 ===
export interface ClockPort {
  now(): string; // ISO 8601
}

// === ID 生成端口 ===
export interface IdGeneratorPort {
  generate(prefix: string): string;
}

// === 场景配置加载端口 ===
export interface ConfigLoaderPort {
  loadScenario(path: string): ScenarioConfig;
  loadPrompt(path: string): string;
}

// === Scenario-owned deterministic delivery validation ===
export interface ArtifactValidationRequest {
  validator: DeliveryValidatorConfig;
  artifactType: string;
  artifactContent: string;
  inputPayload: Record<string, unknown>;
}

export interface ArtifactValidationResult {
  passed: boolean;
  detail: string;
}

export interface ArtifactValidatorPort {
  validate(request: ArtifactValidationRequest): ArtifactValidationResult;
}
