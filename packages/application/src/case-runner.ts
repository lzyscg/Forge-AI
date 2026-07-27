/**
 * CaseRunner — 从 apps/worker/src/main.ts 提取的核心执行逻辑
 * 铁律 5：只通过端口（PiPort / RepositoryPort 等）调用外部实现，不 import 具体 adapter。
 * 铁律 1：不硬编码业务角色名，所有角色来自配置。
 */

import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import type {
  RepositoryPort,
  ClockPort,
  IdGeneratorPort,
  PiPort,
  PiSessionOptions,
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
  ArtifactValidatorPort,
  CaseRunBinding,
  ResultCaseIdentity,
  ResultExecutionIdentity,
} from '@forge-ai/contracts';
import { CaseService } from './case-service.js';
import { TurnExecutor } from './turn-executor.js';
import { RecoveryService } from './recovery.js';
import { repairOrphanedInstructions } from './revision-consistency.js';

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
  artifactValidator?: ArtifactValidatorPort;
  templateBundleSha256?: string | null;
  maxTurns?: number; // 默认 20
}

export interface RunCaseOptions {
  maxTurns?: number;
  runnerToken?: string;
  runnerPid?: number;
}

export interface ResumeCaseOptions {
  runnerToken?: string;
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
  private templateBundleSha256: string | null;
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
    this.templateBundleSha256 = opts.templateBundleSha256 ?? null;
    this.maxTurns = opts.maxTurns ?? 20;

    this.caseService = new CaseService(opts.repo, opts.clock, opts.idGen);
    this.turnExecutor = new TurnExecutor(
      opts.repo,
      opts.clock,
      opts.idGen,
      opts.pi,
      opts.artifactValidator,
    );
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
  createCase(input: {
    title: string;
    inputPayload: Record<string, unknown>;
    runBinding?: CaseRunBinding;
  }): string {
    const caseId = this.caseService.createCase({
      title: input.title,
      scenarioConfig: this.scenarioConfig,
      inputPayload: input.inputPayload,
      runBinding: input.runBinding,
    });
    return caseId;
  }

  /**
   * 运行 Case（含崩溃恢复 + 并发守卫 + Turn 循环）
   */
  async runCase(caseId: string, opts?: RunCaseOptions): Promise<ResultJson> {
    const maxTurns = opts?.maxTurns ?? this.maxTurns;
    const runnerToken = opts?.runnerToken;

    // 1. 终态 case → 幂等返回（不报错）
    const caseRecord = this.repo.getCase(caseId);
    if (!caseRecord) {
      throw new Error(`Case not found: ${caseId}`);
    }
    let status = caseRecord.status as string;
    if (status === 'approved' || status === 'failed' || status === 'stopped') {
      return this.buildResultJson(caseId);
    }

    let lease = this.repo.getExecutionLease(caseId);
    if (status === 'created' && !lease && runnerToken !== undefined) {
      const acquired = this.caseService.acquireExecutionLease(
        caseId,
        runnerToken,
        opts?.runnerPid ?? process.pid,
      );
      if (!acquired) {
        throw new Error('Execution lease acquisition failed');
      }
      lease = this.repo.getExecutionLease(caseId);
    }
    if (lease) {
      if (
        runnerToken === undefined
        || !this.caseService.validateExecutionLease(caseId, runnerToken)
      ) {
        throw new Error('Execution lease authorization failed');
      }
    } else if (runnerToken !== undefined) {
      throw new Error('Execution lease authorization failed');
    }

    if (status === 'created') {
      this.caseService.startCase(caseId, runnerToken);
      status = 'running';
    }

    // 2. waiting_human → 返回 JSON + action_required hint
    if (status === 'waiting_human') {
      const result = this.buildResultJson(caseId);
      result.action_required = "use 'forge case resume <id> --answer'";
      return result;
    }

    // 3. 单 case 并发守卫
    this.assertNoConcurrentCase(caseId);

    // 4. RecoveryService.recoverCase（只恢复传入 caseId）
    const recoveryResult = this.recoveryService.recoverCase(
      caseId,
      runnerToken === undefined
        ? undefined
        : createHash('sha256').update(runnerToken).digest('hex'),
    );
    this.logger.info(`[Recovery] ${caseId}: ${recoveryResult.detail}`);

    // 4.5 一致性修复扩展到恢复路径：清理"关联 Issue 已全 verified 但仍 submitted"
    // 的历史脏指令（如真实旧 Case 遗留的 stale submitted）。否则它们匹配最新版本，
    // 后续 publish 会触发 AMBIGUOUS_ACTIVE_INSTRUCTION，且门禁 no_active_revision 拦截。
    const repaired = repairOrphanedInstructions(this.repo, this.clock, this.idGen, caseId, 'recovery_cleanup');
    if (repaired.length > 0) {
      this.logger.info(`[恢复] 清理 ${repaired.length} 条陈旧 submitted 指令（issue 已全 verified）`);
    }

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

    // 5.5：恢复决策优先由程序根据当前状态判断（不把全部判断交给模型）。
    if (!lastTurn) {
      // 新建 Case（无任何 Turn）：使用用户输入作为首条消息
      agentKey = this.scenarioConfig.start_agent;
      const payload = this.caseService.getInputPayload(caseId);
      message = this.renderInputMessage(payload);
    } else {
      const decision = this.decideResumeAgent(caseId);
      if (decision) {
        // 程序判定：under_review -> 审核 Agent；issued/in_progress -> 返修 Agent；
        // 全部关闭未交付 -> start_agent 申请交付
        agentKey = decision.agent;
        message = decision.message;
      } else if (inferredAgent) {
        // 回退 1：从最后 Turn 的 route_message 推断续跑起点
        agentKey = inferredAgent;
        message = inferredMessage!;
      } else {
        // 回退 2：回到 start_agent，附带完整状态上下文
        agentKey = this.scenarioConfig.start_agent;
        message = this.buildResumeContextMessage(caseId);
      }
    }

    // 7. runTurnLoop
    await this.runTurnLoop(caseId, agentKey, message, maxTurns, runnerToken);

    // 8. 返回 buildResultJson
    return this.buildResultJson(caseId);
  }

  /**
   * 人工输入后续跑
   */
  async resumeCaseWithHumanInput(
    caseId: string,
    answer: string,
    opts?: ResumeCaseOptions,
  ): Promise<ResultJson> {
    // 并发守卫
    this.assertNoConcurrentCase(caseId);

    // 1. transitionCase(waiting_human → running)
    this.caseService.transitionCaseStatus(
      caseId,
      'running',
      opts?.runnerToken,
    );

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
    await this.runTurnLoop(
      caseId,
      targetAgent,
      message,
      this.maxTurns,
      opts?.runnerToken,
    );

    // 6. 返回 buildResultJson
    return this.buildResultJson(caseId);
  }

  /**
   * Turn 循环（核心路由逻辑，从 main.ts 原样搬迁）
   */
  private async runTurnLoop(
    caseId: string,
    agentKey: string,
    message: string,
    maxTurns: number,
    runnerToken?: string,
  ): Promise<void> {
    let currentAgentKey = agentKey;
    let currentMessage = message;
    let consecutiveErrors = 0;
    // 5.4：非终态 Case 连续无工具调用计数。第一次追加纠错消息，第二次转 failed。
    let consecutiveNoAction = 0;
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
        const sessionOptions: PiSessionOptions = {
          scenarioId: this.scenarioConfig.scenario.id,
          scenarioSkillsPath: resolve(dirname(this.scenarioPath), 'skills'),
          agentSkills: agentConfig.skills ?? [],
        };
        const piSession = await this.pi.createSession(currentAgentKey, agentConfig.session.policy, undefined, sessionOptions);
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
        const sessionOptions: PiSessionOptions = {
          scenarioId: this.scenarioConfig.scenario.id,
          scenarioSkillsPath: resolve(dirname(this.scenarioPath), 'skills'),
          agentSkills: agentConfig.skills ?? [],
        };
        await this.pi.resumeSession(session.pi_session_ref as string, sessionOptions);
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
        templateBundleSha256: this.templateBundleSha256,
      });

      if (result.status === 'failed') {
        consecutiveErrors++;
        this.logger.info(`  [失败] ${result.error}`);
        if (consecutiveErrors >= maxConsecutiveErrors) {
          this.logger.error(`\n[停止] 连续 ${maxConsecutiveErrors} 次异常，停下汇报`);
          this.caseService.transitionCaseStatus(caseId, 'failed', runnerToken);
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
              this.caseService.transitionCaseStatus(caseId, 'repairing', runnerToken);
            } else {
              const cr = this.repo.getCase(caseId);
              if (cr && cr.status === 'running') {
                this.caseService.transitionCaseStatus(caseId, 'waiting_review', runnerToken);
              }
            }
            break;
          }
        }

        if (action.tool_name === 'approve_delivery' && action.result) {
          const deliveryOutput = JSON.parse(action.result as string);
          if (deliveryOutput.gate_passed) {
            this.caseService.transitionCaseStatus(caseId, 'approved', runnerToken);
            this.repo.closeSessionsByCase(caseId);
            this.logger.info(`\n[交付] 门禁通过，Case 已交付！`);
          } else if (deliveryOutput.error_code === 'INTERNAL_STATE_INCONSISTENT') {
            // 5.6：一致性修复后仍无法通过门禁，且无法确定性路由 -> 内部错误，转 failed
            this.logger.error(`\n[门禁] 内部状态不一致，Case 转 failed: ${deliveryOutput.error}`);
            this.caseService.transitionCaseStatus(caseId, 'failed', runnerToken);
            routed = true;
          } else if (deliveryOutput.route_to) {
            // 5.6：按指令状态确定性路由（submitted -> 审核 Agent；issued/in_progress -> 返修 Agent）
            this.logger.info(`  [门禁] 未通过，确定性路由到 ${deliveryOutput.route_to}: ${deliveryOutput.route_reason}`);
            currentAgentKey = deliveryOutput.route_to;
            currentMessage = deliveryOutput.route_reason ?? `交付门禁未通过，请按当前返修指令继续。`;
            routed = true;
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
              this.caseService.transitionCaseStatus(caseId, 'running', runnerToken);
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
              this.caseService.transitionCaseStatus(caseId, 'running', runnerToken);
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
                    this.caseService.transitionCaseStatus(caseId, 'waiting_review', runnerToken);
                  }
                }
              }
            }
          }
        }

        if (action.tool_name === 'request_human_input') {
          this.caseService.transitionCaseStatus(caseId, 'waiting_human', runnerToken);
          this.logger.info(`  [人工] Case 进入 waiting_human 状态`);
        }
      }

      if (!routed) {
        // 没有路由发生，检查是否应该结束
        const cr = this.repo.getCase(caseId);
        if (cr && (cr.status === 'approved' || cr.status === 'waiting_human')) {
          break;
        }
        // 5.4：非终态 Case（running/waiting_review/repairing）+ 无工具调用，不得静默返回。
        if (result.toolCallResults.length === 0) {
          consecutiveNoAction++;
          if (consecutiveNoAction >= 2) {
            // 连续第二次仍无动作：转 failed，记录原因
            this.logger.error(`\n[停止] 非终态 Case(${cr?.status}) 连续 ${consecutiveNoAction} 次无工具调用，转为 failed`);
            this.caseService.transitionCaseStatus(caseId, 'failed', runnerToken);
            this.repo.insertControlEvent({
              event_id: this.idGen.generate('evt'),
              case_id: caseId,
              event_type: 'agent_no_action_in_nonterminal_state',
              actor: currentAgentKey,
              detail: JSON.stringify({ case_status: cr?.status, agent: currentAgentKey, consecutive_no_action: consecutiveNoAction }),
              created_at: this.clock.now(),
            });
            break;
          }
          // 第一次：追加确定性纠错消息（列活跃指令 + Issue + 允许工具），让同一 Agent 重试
          this.logger.warn(`  [纠错] 非终态 Case(${cr?.status}) 无工具调用，追加确定性纠错消息重试`);
          currentMessage = this.buildCorrectionMessage(caseId, currentAgentKey);
          // currentAgentKey 保持不变，让同一 Agent 据纠错消息重试
          continue;
        }
        // 有工具调用但没产生路由：重置无动作计数，循环继续（沿用既有行为）
        consecutiveNoAction = 0;
      } else {
        consecutiveNoAction = 0;
      }
    }
  }

  /**
   * 5.5：构造崩溃恢复续跑上下文消息（富上下文）。
   * 包含 Case 状态、最新产物版本、全部未关闭 Issue（ID/severity/status/anchor）、
   * 全部活跃返修指令（ID/status/target_agent/target_version/issue_ids）、下一步允许动作。
   */
  private buildResumeContextMessage(caseId: string): string {
    const lines: string[] = ['系统崩溃恢复后续跑。当前进度如下：'];
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
          lines.push(
            `- 最新产物 [${at.type}]: v${latest.version} (status=${latest.status}, hash=${(latest.content_hash as string).slice(0, 8)})`,
          );
        }
      }
    }
    // 全部未关闭 Issue：ID / severity / status / anchor
    const issues = this.repo.getIssuesByCase(caseId);
    const open = issues.filter((i) =>
      ['open', 'repairing', 'claimed_fixed', 'reopened'].includes(i.status as string),
    );
    if (open.length > 0) {
      lines.push(`- 未关闭 Issue（${open.length} 个）:`);
      for (const i of open) {
        let anchor: any = i.anchor;
        try { anchor = i.anchor ? JSON.parse(i.anchor as string) : null; } catch { /* keep raw */ }
        const anchorStr = anchor && typeof anchor === 'object'
          ? `${anchor.type}:${anchor.value}`
          : String(anchor ?? '');
        lines.push(
          `    - ${i.issue_id} [severity=${i.severity}, status=${i.status}] anchor=${anchorStr} problem=${(i.problem as string).slice(0, 60)}`,
        );
      }
    } else {
      lines.push('- 未关闭 Issue: 无');
    }
    // 全部活跃返修指令：ID / status / target_agent / target_version / issue_ids
    const revisions = this.repo.getActiveRevisionInstructions(caseId);
    if (revisions.length > 0) {
      lines.push(`- 活跃返修指令（${revisions.length} 条）:`);
      for (const ri of revisions) {
        const issueIds = this.parseIssueIdsSafe(ri.issue_ids as string);
        lines.push(
          `    - ${ri.revision_instruction_id} [status=${ri.status}, target_agent=${ri.target_agent}, target_version=${ri.target_artifact_version_id ?? 'null'}] issue_ids=[${issueIds.join(',')}]`,
        );
      }
    } else {
      lines.push('- 活跃返修指令: 无');
    }
    // 下一步系统允许的动作
    lines.push('- 下一步允许动作:');
    lines.push('    - 若产物版本为 under_review：路由给审核方（submit_evaluation）。');
    lines.push('    - 若存在 issued/in_progress 返修指令：路由给指令 target_agent 发布修复版本。');
    lines.push('    - 若 Issue 与指令均已关闭但 Case 未 approved：回到 start agent 申请交付。');
    return lines.join('\n');
  }

  /**
   * 5.5：程序化恢复决策。根据当前状态确定性选择续跑 Agent，不把判断全交给模型。
   * 返回 null 表示无法归类，调用方回退到 route_message 推断 / start_agent。
   */
  private decideResumeAgent(caseId: string): { agent: string; message: string } | null {
    const caseRecord = this.repo.getCase(caseId);
    if (!caseRecord) return null;
    const status = caseRecord.status as string;
    // 终态 / 等待人工：runCase 顶部已处理，这里不决定
    if (['approved', 'failed', 'stopped', 'waiting_human'].includes(status)) return null;

    // 1. 存在 issued/in_progress 指令 -> 路由其 target_agent（返修进行中）
    const active = this.repo.getActiveRevisionInstructions(caseId);
    const inProgress = active.find(
      (ri) => ri.status === 'issued' || ri.status === 'in_progress',
    );
    if (inProgress) {
      return {
        agent: inProgress.target_agent as string,
        message: `系统恢复续跑：存在进行中的返修指令(${inProgress.revision_instruction_id})，请按指令的 editable_anchors 范围发布修复版本。\n${this.buildResumeContextMessage(caseId)}`,
      };
    }

    // 2. 存在 open/reopened Issue（审核方已 repair、尚未下发返修）-> 回 start agent 发返修。
    //    不能因 version 仍 under_review 就再派 reviewer--reviewer 已评估过（issue 已建），
    //    再派会空转无动作（Fake/真实 Pi 崩溃恢复续跑实测卡在这里直到 maxTurns->failed）。
    const issues = this.repo.getIssuesByCase(caseId);
    const pendingRepair = issues.filter(
      (i) => (i.status as string) === 'open' || (i.status as string) === 'reopened',
    );
    if (pendingRepair.length > 0) {
      return {
        agent: this.scenarioConfig.start_agent,
        message: `系统恢复续跑：存在 ${pendingRepair.length} 个未返修的 Issue（审核方已挑出，尚未下发返修）。请用 route_message 向生成方下发定点返修（editable/frozen scope + issue_ids）。\n${this.buildResumeContextMessage(caseId)}`,
      };
    }

    // 3. 最新版本 under_review 且无待返修 Issue -> 路由审核 Agent（待审核）
    for (const at of this.scenarioConfig.artifact_types) {
      const artifact = this.repo.getArtifactByTypeAndCase(caseId, at.type);
      if (artifact) {
        const latest = this.repo.getLatestVersion(artifact.artifact_id as string);
        if (latest && latest.status === 'under_review') {
          const reviewer = this.findReviewerAgentKey();
          if (reviewer) {
            return {
              agent: reviewer,
              message: `系统恢复续跑：最新产物版本 v${latest.version} 处于 under_review，请执行审核（submit_evaluation）。`,
            };
          }
        }
      }
    }
    // 4. 全部 Issue 已 verified、无活跃指令但未交付 -> 回到 start agent 申请交付
    const openIssues = issues.filter((i) => (i.status as string) !== 'verified');
    if (openIssues.length === 0 && active.length === 0) {
      return {
        agent: this.scenarioConfig.start_agent,
        message: `系统恢复续跑：所有 Issue 已 verified、无活跃返修指令。若最新产物版本已审核通过，请申请交付（approve_delivery）。`,
      };
    }
    // 5. 状态无法归类（如存在 submitted 指令但版本非 under_review）-> 返回 null，调用方回退
    return null;
  }

  /**
   * 5.4：非终态无工具调用时的确定性纠错消息。列出当前活跃指令、未关闭 Issue、
   * 当前 Agent 允许的工具，让 Agent 据此重试，而不是自行猜测 ID。
   */
  private buildCorrectionMessage(caseId: string, agentKey: string): string {
    const lines: string[] = [
      `[系统纠错] 当前 Case 处于非终态，但你本轮没有产生任何工具调用。请根据以下状态立即执行下一步：`,
    ];
    const caseRecord = this.repo.getCase(caseId);
    if (caseRecord) lines.push(`- Case 状态: ${caseRecord.status}`);

    // 活跃返修指令
    const active = this.repo.getActiveRevisionInstructions(caseId);
    if (active.length > 0) {
      lines.push(`- 活跃返修指令（${active.length} 条）:`);
      for (const ri of active) {
        const issueIds = this.parseIssueIdsSafe(ri.issue_ids as string);
        lines.push(
          `    - ${ri.revision_instruction_id} [status=${ri.status}, target_agent=${ri.target_agent}] issue_ids=[${issueIds.join(',')}]`,
        );
      }
    } else {
      lines.push('- 活跃返修指令: 无');
    }
    // 未关闭 Issue
    const openIssues = this.repo
      .getIssuesByCase(caseId)
      .filter((i) => ['open', 'repairing', 'claimed_fixed', 'reopened'].includes(i.status as string));
    if (openIssues.length > 0) {
      lines.push(`- 未关闭 Issue（${openIssues.length} 个）:`);
      for (const i of openIssues) {
        lines.push(`    - ${i.issue_id} [${i.severity}/${i.status}] ${(i.problem as string).slice(0, 60)}`);
      }
    }
    // 当前 Agent 允许的工具
    const agentConfig = this.scenarioConfig.agents.find((a) => a.key === agentKey);
    if (agentConfig) {
      lines.push(`- 你（${agentKey}）允许的工具: ${agentConfig.tools.join(', ')}`);
    }
    // 确定性提示
    if (agentConfig?.tools.includes('submit_evaluation')) {
      const artifactType = this.scenarioConfig.artifact_types[0]?.type;
      lines.push(`- 请立即调用 submit_evaluation 对最新 ${artifactType ?? '产物'} 版本给出审核结论。`);
    } else if (agentConfig?.tools.includes('publish_artifact')) {
      lines.push(`- 请立即调用 publish_artifact 按返修指令发布修复版本（只改 editable_anchors 范围）。`);
    } else if (agentConfig?.tools.includes('approve_delivery')) {
      lines.push(`- 请立即调用 approve_delivery 申请交付，或调用 route_message 派发任务。`);
    }
    lines.push('- 若再次无工具调用，Case 将被转为 failed。');
    return lines.join('\n');
  }

  /** 安全解析 issue_ids JSON 字符串（case-runner 内部用） */
  private parseIssueIdsSafe(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 查找持有 submit_evaluation 工具的 Agent（审核方），配置驱动 */
  private findReviewerAgentKey(): string | null {
    const reviewer = this.scenarioConfig.agents.find((a) => a.tools.includes('submit_evaluation'));
    return reviewer?.key ?? null;
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
    let scenarioSnapshot: ScenarioConfig | null = null;
    try {
      scenarioSnapshot = JSON.parse(String(caseRecord?.scenario_snapshot)) as ScenarioConfig;
    } catch {
      scenarioSnapshot = null;
    }

    let caseIdentity: ResultCaseIdentity | null = null;
    if (
      caseRecord
      && typeof caseRecord.scenario_id === 'string'
      && typeof caseRecord.scenario_snapshot_sha256 === 'string'
      && typeof caseRecord.input_payload_sha256 === 'string'
    ) {
      caseIdentity = {
        db_instance_id: this.repo.getDbInstanceId(),
        scenario_id: caseRecord.scenario_id,
        scenario_snapshot_sha256: caseRecord.scenario_snapshot_sha256,
        input_payload_sha256: caseRecord.input_payload_sha256,
        run_binding: {
          run_id: (caseRecord.run_id as string | null) ?? null,
          story_id: (caseRecord.story_id as string | null) ?? null,
          stage_key: (caseRecord.stage_key as string | null) ?? null,
          chapter_id: (caseRecord.chapter_id as string | null) ?? null,
        },
      };
    }

    // final_artifact
    let finalArtifact: ResultArtifact | null = null;
    let finalVersion: Record<string, unknown> | null = null;
    const deliverableType = scenarioSnapshot?.delivery?.deliverable_artifact_type;
    if (deliverableType) {
      const artifact = this.repo.getArtifactByTypeAndCase(caseId, deliverableType);
      if (artifact) {
        const latestVersion = this.repo.getLatestVersion(artifact.artifact_id as string);
        if (latestVersion) {
          finalVersion = latestVersion;
          finalArtifact = {
            type: deliverableType,
            version: latestVersion.version as number,
            status: latestVersion.status as string,
            content: latestVersion.content as string,
            artifact_id: artifact.artifact_id as string,
            version_id: latestVersion.artifact_version_id as string,
          };
        }
      }
    }
    const executionIdentity: ResultExecutionIdentity | null = (
      finalVersion
      && typeof finalVersion.template_bundle_sha256 === 'string'
    ) ? {
        template_bundle_sha256: finalVersion.template_bundle_sha256,
        artifact_version_id: finalVersion.artifact_version_id as string,
      }
      : null;

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
    const lastGate = finalArtifact
      ? [...gateResults].reverse().find(
          (candidate) => candidate.artifact_version_id === finalArtifact.version_id,
        )
      : undefined;
    if (lastGate) {
      let checks: ResultGateCheck[] = [];
      try {
        const parsed: GateCheckResult[] = JSON.parse(lastGate.checks as string);
        checks = parsed.map((c) => ({ name: c.check, passed: c.passed }));
      } catch { /* empty */ }
      gate = {
        status: lastGate.status as 'pass' | 'fail',
        artifact_version_id: lastGate.artifact_version_id as string,
        checks,
      };
    }

    // action_required
    let actionRequired: string | null = null;
    if (status === 'waiting_human') {
      actionRequired = "use 'forge case resume <id> --answer'";
    }

    return {
      case_id: caseId,
      status,
      success,
      final_artifact: finalArtifact,
      case_identity: caseIdentity,
      execution_identity: executionIdentity,
      turns: { count: turns.length, items: turnItems },
      issues: resultIssues,
      gate,
      diff: null,
      action_required: actionRequired,
      error: null,
    };
  }

  /**
   * 并发守卫：检查是否有其他 running case（供 CLI preflight 调用）
   */
  assertNoConcurrentCase(excludeCaseId?: string): void {
    const runningCases = this.repo.getCasesByStatus('running').filter(c => c.case_id !== excludeCaseId);
    if (runningCases.length > 0) {
      throw new ConcurrentCaseError(runningCases[0].case_id as string);
    }
  }
}
