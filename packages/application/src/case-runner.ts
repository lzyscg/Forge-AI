/**
 * CaseRunner — 从 apps/worker/src/main.ts 提取的核心执行逻辑
 * 铁律 5：只通过端口（PiPort / RepositoryPort 等）调用外部实现，不 import 具体 adapter。
 * 铁律 1：不硬编码业务角色名，所有角色来自配置。
 */

import { resolve, dirname } from 'node:path';
import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  PiPort,
  PiToolDefinition,
  ScenarioConfig,
  ConfigLoaderPort,
  ResultJson,
  ResultArtifact,
  ResultTurnItem,
  ResultIssue,
  ResultGate,
  ResultGateCheck,
  GateCheckResult,
} from '@forge-ai/contracts';
import { CaseService } from './case-service.js';
import { TurnExecutor } from './turn-executor.js';
import { RecoveryService } from './recovery.js';

// === Logger 接口（注入，不直接 console.log） ===
export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
  warn(msg: string): void;
}

// === 并发守卫错误 ===
export class ConcurrentCaseError extends Error {
  public readonly runningCaseId: string;
  constructor(runningCaseId: string) {
    super(`Another case is already running: ${runningCaseId}`);
    this.name = 'ConcurrentCaseError';
    this.runningCaseId = runningCaseId;
  }
}

// === CaseRunner 构造参数 ===
export interface CaseRunnerOptions {
  repo: RepositoryPort;
  clock: ClockPort;
  idGen: IdGeneratorPort;
  pi: PiPort;
  scenarioConfig: ScenarioConfig;
  scenarioPath: string; // 用于构造 prompt 路径
  configLoader: ConfigLoaderPort;
  toolDefinitions: PiToolDefinition[];
  logger: Logger;
  maxTurns?: number; // 默认 20
}

export class CaseRunner {
  private caseService: CaseService;
  private turnExecutor: TurnExecutor;
  private recoveryService: RecoveryService;
  private repo: RepositoryPort;
  private clock: ClockPort;
  private idGen: IdGeneratorPort;
  private pi: PiPort;
  private scenarioConfig: ScenarioConfig;
  private scenarioPath: string;
  private configLoader: ConfigLoaderPort;
  private toolDefinitions: PiToolDefinition[];
  private logger: Logger;
  private maxTurns: number;

  constructor(opts: CaseRunnerOptions) {
    this.repo = opts.repo;
    this.clock = opts.clock;
    this.idGen = opts.idGen;
    this.pi = opts.pi;
    this.scenarioConfig = opts.scenarioConfig;
    this.scenarioPath = opts.scenarioPath;
    this.configLoader = opts.configLoader;
    this.toolDefinitions = opts.toolDefinitions;
    this.logger = opts.logger;
    this.maxTurns = opts.maxTurns ?? 20;

    this.caseService = new CaseService(opts.repo, opts.clock, opts.idGen);
    this.turnExecutor = new TurnExecutor(opts.repo, opts.clock, opts.idGen, opts.pi);
    this.recoveryService = new RecoveryService(opts.repo, opts.clock);

    // 注册上下文解析器（闭包捕获 repo，FakePi 用于动态替换脚本占位符）
    this.pi.registerContextResolver?.((): Record<string, string> => {
      const cases = this.repo.getCasesByStatus('running')
        .concat(this.repo.getCasesByStatus('repairing'))
        .concat(this.repo.getCasesByStatus('waiting_review'));
      for (const c of cases) {
        const issues = this.repo.getIssuesByCase(c.case_id as string);
        if (issues.length > 0) {
          const issueIds = issues.map((i) => i.issue_id as string);
          return { 'PLACEHOLDER_ISSUE_ID': issueIds[0] };
        }
      }
      return {} as Record<string, string>;
    });
  }

  /**
   * 创建 Case（委托 CaseService）
   */
  createCase(input: { title: string; inputPayload: Record<string, unknown> }): string {
    const caseId = this.caseService.createCase({
      title: input.title,
      scenarioConfig: this.scenarioConfig,
      inputPayload: input.inputPayload,
    });
    this.caseService.startCase(caseId);
    return caseId;
  }

  /**
   * 运行 Case（含崩溃恢复 + 并发守卫 + Turn 循环）
   */
  async runCase(caseId: string, opts?: { maxTurns?: number }): Promise<ResultJson> {
    const maxTurns = opts?.maxTurns ?? this.maxTurns;

    // 1. 终态 case → 幂等返回（不报错）
    const caseRecord = this.repo.getCase(caseId);
    if (!caseRecord) {
      throw new Error(`Case not found: ${caseId}`);
    }
    const status = caseRecord.status as string;
    if (status === 'approved' || status === 'failed' || status === 'stopped') {
      return this.buildResultJson(caseId);
    }

    // 2. waiting_human → 返回 JSON + action_required hint
    if (status === 'waiting_human') {
      const result = this.buildResultJson(caseId);
      result.action_required = 'Case is waiting for human input. Use resumeCaseWithHumanInput to continue.';
      return result;
    }

    // 3. 单 case 并发守卫
    this.assertNoConcurrentCase(caseId);

    // 4. RecoveryService.recoverCase（只恢复传入 caseId）
    const recoveryResult = this.recoveryService.recoverCase(caseId);
    this.logger.info(`[Recovery] ${caseId}: ${recoveryResult.detail}`);

    // 5. 从最后完成 Turn 推断续跑起点
    let agentKey: string;
    let message: string;
    const lastTurn = this.repo.getLastCompletedTurn(caseId);

    // 6. pi.alignTurnCounter（可选链）
    if (lastTurn) {
      this.pi.alignTurnCounter?.(this.scenarioConfig.scenario.id, lastTurn.sequence as number);
    }

    let inferredAgent: string | null = null;
    let inferredMessage: string | null = null;

    if (lastTurn) {
      const actions = this.repo.getToolActionsByTurn(lastTurn.turn_id as string);
      for (const action of actions) {
        if (action.tool_name === 'route_message' && action.result) {
          const routeOutput = JSON.parse(action.result as string);
          if (routeOutput.success) {
            const args = JSON.parse(action.arguments as string);
            inferredAgent = args.target_agent;
            inferredMessage = args.instruction;
          }
        }
      }
    }

    if (inferredAgent) {
      // 从最后 Turn 的 route_message 推断了续跑起点
      agentKey = inferredAgent;
      message = inferredMessage!;
    } else if (!lastTurn) {
      // 新建 Case（无任何 Turn）：使用用户输入作为首条消息
      agentKey = this.scenarioConfig.start_agent;
      const payload = this.caseService.getInputPayload(caseId);
      message = this.renderInputMessage(payload);
    } else {
      // 崩溃续跑（有 Turn 但无法从 route_message 推断）：使用上下文摘要
      agentKey = this.scenarioConfig.start_agent;
      message = this.buildResumeContextMessage(caseId);
    }

    // 7. runTurnLoop
    await this.runTurnLoop(caseId, agentKey, message, maxTurns);

    // 8. 返回 buildResultJson
    return this.buildResultJson(caseId);
  }

  /**
   * 人工输入后续跑
   */
  async resumeCaseWithHumanInput(caseId: string, answer: string): Promise<ResultJson> {
    // 并发守卫
    this.assertNoConcurrentCase(caseId);

    // 1. transitionCase(waiting_human → running)
    this.caseService.transitionCaseStatus(caseId, 'running');

    // 2. 找最后 Turn 的 tool_actions 中 request_human_input 的 agent
    const lastTurn = this.repo.getLastCompletedTurn(caseId);
    let question = '';
    let targetAgent = this.scenarioConfig.start_agent;

    if (lastTurn) {
      const actions = this.repo.getToolActionsByTurn(lastTurn.turn_id as string);
      for (const action of actions) {
        if (action.tool_name === 'request_human_input') {
          const args = JSON.parse(action.arguments as string);
          question = args.question ?? args.reason ?? '';
          // 找该 turn 的 agent
          const turnRecord = this.repo.getTurn(lastTurn.turn_id as string);
          if (turnRecord) {
            // 从 session 找 agent_key
            const session = this.repo.getSession(turnRecord.session_id as string);
            if (session) {
              targetAgent = session.agent_key as string;
            }
          }
        }
      }
    }

    // 3-4. 渲染答案消息
    const message = `用户对你提出的问题'${question}'的回答：\n${answer}`;

    // 5. runTurnLoop（不 recover）
    await this.runTurnLoop(caseId, targetAgent, message, this.maxTurns);

    // 6. 返回 buildResultJson
    return this.buildResultJson(caseId);
  }

  /**
   * Turn 循环（核心路由逻辑，从 main.ts 原样搬迁）
   */
  private async runTurnLoop(caseId: string, agentKey: string, message: string, maxTurns: number): Promise<void> {
    let currentAgentKey = agentKey;
    let currentMessage = message;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;

    for (let turnNum = 0; turnNum < maxTurns; turnNum++) {
      const caseRecord = this.repo.getCase(caseId);
      if (!caseRecord) break;

      const caseStatus = caseRecord.status as string;
      if (caseStatus === 'approved' || caseStatus === 'failed' || caseStatus === 'stopped') {
        this.logger.info(`\n[Case] 终态: ${caseStatus}`);
        break;
      }
      if (caseStatus === 'waiting_human') {
        this.logger.info(`\n[Case] 等待人工输入，停止`);
        break;
      }

      // 获取或创建 session（cold_per_version 策略：每次调用都创建全新 Session）
      const agentConfig = this.scenarioConfig.agents.find((a) => a.key === currentAgentKey);
      if (!agentConfig) {
        this.logger.error(`[错误] 未找到 agent 配置: ${currentAgentKey}`);
        break;
      }

      let session = this.repo.getActiveSession(caseId, currentAgentKey);
      let sessionId: string;

      // cold_per_version：关闭旧 Session，确保每次调用都是独立冷启动
      if (session && agentConfig.session.policy === 'cold_per_version') {
        this.repo.updateSession(session.session_id as string, { status: 'closed', closed_at: this.clock.now() });
        await this.pi.closeSession(session.pi_session_ref as string);
        session = null;
      }

      if (!session) {
        sessionId = this.idGen.generate('sess');
        const piSession = await this.pi.createSession(currentAgentKey, agentConfig.session.policy);
        this.repo.insertSession({
          session_id: sessionId,
          case_id: caseId,
          agent_key: currentAgentKey,
          session_policy: agentConfig.session.policy,
          scope_key: null,
          pi_session_ref: piSession.session_ref,
          status: 'active',
          opened_at: this.clock.now(),
          closed_at: null,
        });
        // 注册 DB session_id -> pi_session_ref 别名（RealPi 需要，FakePi no-op）
        this.pi.registerSession?.(sessionId, piSession.session_ref);
      } else {
        // persistent 策略：复用已有 Session（继承历史上下文）
        sessionId = session.session_id as string;
        // 跨进程恢复：resumeSession 把 persistent session 从磁盘文件加载回内存
        await this.pi.resumeSession(session.pi_session_ref as string);
        this.pi.registerSession?.(sessionId, session.pi_session_ref as string);
      }

      // 加载提示词
      let systemPrompt = `你是 ${agentConfig.name}。`;
      try {
        const promptPath = resolve(dirname(this.scenarioPath), agentConfig.prompt);
        systemPrompt = this.configLoader.loadPrompt(promptPath);
      } catch {
        // 使用默认提示词
      }

      // 过滤该 agent 可用的工具
      const agentTools = this.toolDefinitions.filter((t) => agentConfig.tools.includes(t.name));

      this.logger.info(`\n[Turn ${turnNum + 1}] Agent: ${currentAgentKey} (${agentConfig.name})`);

      // 执行 Turn
      const result = await this.turnExecutor.executeTurn({
        caseId,
        sessionId,
        agentKey: currentAgentKey,
        scenarioConfig: this.scenarioConfig,
        systemPrompt,
        userMessage: currentMessage,
        tools: agentTools,
      });

      if (result.status === 'failed') {
        consecutiveErrors++;
        this.logger.info(`  [失败] ${result.error}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          this.logger.error(`\n[停止] 连续 ${maxConsecutiveErrors} 次异常，停下汇报`);
          this.caseService.transitionCaseStatus(caseId, 'failed');
          break;
        }
        continue;
      }

      consecutiveErrors = 0;
      this.logger.info(`  [完成] Turn: ${result.turnId}`);

      // 解析工具调用结果，决定下一步（路由决策——原样搬迁）
      const toolActions = this.repo.getToolActionsByTurn(result.turnId);
      let routed = false;

      for (const action of toolActions) {
        if (action.tool_name === 'route_message' && action.result) {
          const routeOutput = JSON.parse(action.result as string);
          if (routeOutput.success) {
            const args = JSON.parse(action.arguments as string);
            currentAgentKey = args.target_agent;
            currentMessage = args.instruction;
            routed = true;

            // 更新 Case 状态
            if (args.scope?.issue_ids?.length > 0) {
              this.caseService.transitionCaseStatus(caseId, 'repairing');
            } else {
              const cr = this.repo.getCase(caseId);
              if (cr && cr.status === 'running') {
                this.caseService.transitionCaseStatus(caseId, 'waiting_review');
              }
            }
            break;
          }
        }

        if (action.tool_name === 'approve_delivery' && action.result) {
          const deliveryOutput = JSON.parse(action.result as string);
          if (deliveryOutput.gate_passed) {
            this.caseService.transitionCaseStatus(caseId, 'approved');
            this.repo.closeSessionsByCase(caseId);
            this.logger.info(`\n[交付] 门禁通过，Case 已交付！`);
          } else {
            this.logger.info(`  [门禁] 未通过: ${JSON.stringify(deliveryOutput.checks?.filter((c: any) => !c.passed))}`);
            // 回到总控
            currentAgentKey = this.scenarioConfig.start_agent;
            currentMessage = `交付门禁未通过，请检查原因并决定下一步。门禁结果：${JSON.stringify(deliveryOutput.checks)}`;
            routed = true;
          }
        }

        if (action.tool_name === 'submit_evaluation' && action.result) {
          const evalOutput = JSON.parse(action.result as string);
          const evalArgs = JSON.parse(action.arguments as string);
          if (evalArgs.verdict === 'approve') {
            // 审核通过，回到总控
            currentAgentKey = this.scenarioConfig.start_agent;
            currentMessage = `审核已通过。产物已通过复审验证。请决定是否申请交付。`;
            routed = true;
            const cr = this.repo.getCase(caseId);
            if (cr && (cr.status === 'repairing' || cr.status === 'waiting_review')) {
              this.caseService.transitionCaseStatus(caseId, 'running');
            }
          } else {
            // 审核不通过，回到总控
            currentAgentKey = this.scenarioConfig.start_agent;
            // 把 issue 详情（problem/anchor/evidence）带进消息，否则总控无法构造 editable/frozen 返修范围
            const issueDetails = ((evalOutput.issue_ids as string[]) ?? [])
              .map((id) => {
                const iss = this.repo.getIssue(id);
                if (!iss) return `issue ${id}: (详情不可用)`;
                let anchor: any = iss.anchor;
                try { anchor = JSON.parse(iss.anchor as string); } catch { /* keep raw */ }
                const anchorStr = anchor && typeof anchor === 'object'
                  ? `${anchor.type}:${anchor.value}`
                  : String(anchor);
                return `issue ${id} [${iss.severity}] 锚点 ${anchorStr}\n  问题: ${iss.problem}\n  证据: ${iss.evidence}`;
              })
              .join('\n');
            currentMessage = `审核未通过，需要返修。以下是审核发现的具体问题：\n${issueDetails}\n\n请据此制定返修方案：使用 route_message 派给负责生成产物的 Agent，在 scope 中明确 editable_anchors（可改的行）、frozen_anchors（必须冻结的行），并在 issue_ids 中关联上述问题。`;
            routed = true;
            const cr = this.repo.getCase(caseId);
            if (cr && cr.status === 'waiting_review') {
              this.caseService.transitionCaseStatus(caseId, 'running');
            }
          }
        }

        if (action.tool_name === 'publish_artifact' && action.result) {
          const pubOutput = JSON.parse(action.result as string);
          if (pubOutput.success) {
            this.logger.info(`  [产物] v${pubOutput.version} 已发布`);
            // 发布后自动路由到审核（根据配置）
            const nextRoute = this.scenarioConfig.routes.find(
              (r) => r.from === currentAgentKey && r.to.length > 0,
            );
            if (nextRoute && !routed) {
              // 检查是否有到 reviewer 的路由
              const reviewerRoute = this.scenarioConfig.routes.find(
                (r) => r.from === currentAgentKey,
              );
              if (reviewerRoute) {
                const targetKey = reviewerRoute.to.find((t) => {
                  const targetAgent = this.scenarioConfig.agents.find((a) => a.key === t);
                  return targetAgent?.tools.includes('submit_evaluation');
                });
                if (targetKey) {
                  currentAgentKey = targetKey;
                  currentMessage = `请审核最新版本的产物。`;
                  routed = true;
                  const cr = this.repo.getCase(caseId);
                  // 初版发布：running -> waiting_review；
                  // 返修版发布：repairing -> waiting_review（否则 case 卡在 repairing，
                  // 后续 reviewer 再判 repair、supervisor 再发返修会触发 repairing->repairing 非法转换）
                  if (cr && (cr.status === 'running' || cr.status === 'repairing')) {
                    this.caseService.transitionCaseStatus(caseId, 'waiting_review');
                  }
                }
              }
            }
          }
        }

        if (action.tool_name === 'request_human_input') {
          this.caseService.transitionCaseStatus(caseId, 'waiting_human');
          this.logger.info(`  [人工] Case 进入 waiting_human 状态`);
        }
      }

      if (!routed) {
        // 没有路由发生，检查是否应该结束
        const cr = this.repo.getCase(caseId);
        if (cr && (cr.status === 'approved' || cr.status === 'waiting_human')) {
          break;
        }
        // 默认：如果当前 agent 没有产生路由，结束循环
        if (result.toolCallResults.length === 0) {
          this.logger.info(`  [结束] Agent 未产生工具调用，循环结束`);
          break;
        }
      }
    }
  }

  /**
   * 构造崩溃恢复续跑消息
   */
  private buildResumeContextMessage(caseId: string): string {
    const lines: string[] = ['系统崩溃恢复后续跑。请根据以下当前进度决定下一步：'];
    const caseRecord = this.repo.getCase(caseId);
    if (caseRecord) {
      lines.push(`- Case 状态: ${caseRecord.status}`);
    }
    // 各产物类型的最新版本（配置驱动，不写死产物类型名）
    for (const at of this.scenarioConfig.artifact_types) {
      const artifact = this.repo.getArtifactByTypeAndCase(caseId, at.type);
      if (artifact) {
        const latest = this.repo.getLatestVersion(artifact.artifact_id as string);
        if (latest) {
          lines.push(`- 最新产物 [${at.type}]: v${latest.version} (${latest.status})`);
        }
      }
    }
    // 待处理 Issue
    const issues = this.repo.getIssuesByCase(caseId);
    const active = issues.filter((i) =>
      ['open', 'repairing', 'claimed_fixed', 'reopened'].includes(i.status as string),
    );
    if (active.length > 0) {
      lines.push(
        `- 待处理 Issue: ${active.length} 个（${active.map((i) => `${i.severity}:${i.status}`).join(', ')}）`,
      );
    } else {
      lines.push('- 待处理 Issue: 无');
    }
    // 活跃返修指令
    const revisions = this.repo.getActiveRevisionInstructions(caseId);
    if (revisions.length > 0) {
      lines.push(`- 活跃返修指令: ${revisions.length} 条`);
    } else {
      lines.push('- 活跃返修指令: 无');
    }
    lines.push(
      '请依据上述进度决定下一步：若产物待审核则路由给审核方，若需返修则下发返修指令，若已满足交付条件则申请交付。',
    );
    return lines.join('\n');
  }

  /**
   * 把输入 payload 渲染成首条任务消息（通用，不写死歌词/文案语义）
   */
  renderInputMessage(payload: Record<string, unknown>): string {
    const lines = this.scenarioConfig.input_fields.map((f) => `${f.label}: ${payload[f.key]}`);
    return `请开始执行任务。用户输入：\n${lines.join('\n')}`;
  }

  /**
   * 构建结果 JSON
   */
  buildResultJson(caseId: string): ResultJson {
    const caseRecord = this.repo.getCase(caseId);
    const status = (caseRecord?.status as string) ?? 'unknown';
    const success = status === 'approved';

    // final_artifact
    let finalArtifact: ResultArtifact | null = null;
    const deliverableType = this.scenarioConfig.delivery?.deliverable_artifact_type;
    if (deliverableType) {
      const artifact = this.repo.getArtifactByTypeAndCase(caseId, deliverableType);
      if (artifact) {
        const latestVersion = this.repo.getLatestVersion(artifact.artifact_id as string);
        if (latestVersion) {
          finalArtifact = {
            type: deliverableType,
            version: latestVersion.version as number,
            status: latestVersion.status as string,
            content: latestVersion.content as string,
            artifact_id: artifact.artifact_id as string,
            version_id: latestVersion.version_id as string,
          };
        }
      }
    }

    // turns
    const turns = this.repo.getTurnsByCase(caseId);
    const turnItems: ResultTurnItem[] = turns.map((t) => {
      const actions = this.repo.getToolActionsByTurn(t.turn_id as string);
      let produced: string[] = [];
      try {
        produced = JSON.parse(t.produced_artifact_version_ids as string);
      } catch { /* empty */ }
      return {
        seq: t.sequence as number,
        agent: t.session_id ? (this.repo.getSession(t.session_id as string)?.agent_key as string ?? 'unknown') : 'unknown',
        tools: actions.map((a) => a.tool_name as string),
        produced,
      };
    });

    // issues
    const issues = this.repo.getIssuesByCase(caseId);
    const resultIssues: ResultIssue[] = issues.map((i) => ({
      id: i.issue_id as string,
      severity: i.severity as string,
      status: i.status as string,
      problem: i.problem as string,
    }));

    // gate
    let gate: ResultGate | null = null;
    const gateResults = this.repo.getDeliveryGateResults(caseId);
    if (gateResults.length > 0) {
      const lastGate = gateResults[gateResults.length - 1];
      let checks: ResultGateCheck[] = [];
      try {
        const parsed: GateCheckResult[] = JSON.parse(lastGate.checks as string);
        checks = parsed.map((c) => ({ name: c.check, passed: c.passed }));
      } catch { /* empty */ }
      gate = {
        status: lastGate.status as 'pass' | 'fail',
        checks,
      };
    }

    // action_required
    let actionRequired: string | null = null;
    if (status === 'waiting_human') {
      actionRequired = 'Case is waiting for human input.';
    }

    return {
      case_id: caseId,
      status,
      success,
      final_artifact: finalArtifact,
      turns: { count: turns.length, items: turnItems },
      issues: resultIssues,
      gate,
      diff: null,
      action_required: actionRequired,
      error: null,
    };
  }

  /**
   * 并发守卫
   */
  private assertNoConcurrentCase(caseId: string): void {
    const runningCases = this.repo.getCasesByStatus('running').filter(c => c.case_id !== caseId);
    if (runningCases.length > 0) {
      throw new ConcurrentCaseError(runningCases[0].case_id as string);
    }
  }
}
