/**
 * Worker 主入口
 * 加载配置 → 初始化 SQLite → 选择 Pi adapter（Fake/Real）→ 创建/恢复 Case → 顺序执行 Turn 循环
 * 单 Case 顺序执行，不做并发。
 */

import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import type { PiPort, PiToolDefinition, ScenarioConfig, RepositoryPort } from '@forge-ai/contracts';
import { CaseService, TurnExecutor, RecoveryService } from '@forge-ai/application';
import { SqliteRepository, FakePiAdapter, RealPiAdapter, SystemClock, UuidGenerator, FileConfigLoader } from '@forge-ai/adapters';
import type { FakePiScript } from '@forge-ai/adapters';

// === 工具定义（注册给 Pi 的） ===
const TOOL_DEFINITIONS: PiToolDefinition[] = [
  {
    name: 'publish_artifact',
    description: '发布或修订一个产物。系统自动补齐版本号、时间、来源等工程数据。',
    parameters: {
      type: 'object',
      properties: {
        artifact_type: { type: 'string', description: '配置里注册的产物类型' },
        content: { type: 'string', description: '业务内容本身' },
        summary: { type: 'string', description: '这一轮做了什么' },
      },
      required: ['artifact_type', 'content', 'summary'],
    },
  },
  {
    name: 'submit_evaluation',
    description: '提交审核结论。系统自动绑定到被审核的产物版本并为每个 issue 生成稳定 ID。',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'repair', 'regenerate', 'input_problem'] },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
              anchor: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'string' } } },
              problem: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['severity', 'anchor', 'problem', 'evidence'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['verdict', 'issues', 'summary'],
    },
  },
  {
    name: 'route_message',
    description: '把任务或返修指令派给某个 Agent。',
    parameters: {
      type: 'object',
      properties: {
        target_agent: { type: 'string', description: '配置里的 agent key' },
        instruction: { type: 'string' },
        scope: {
          type: 'object',
          properties: {
            editable_anchors: { type: 'array', items: { type: 'string' } },
            frozen_anchors: { type: 'array', items: { type: 'string' } },
            issue_ids: { type: 'array', items: { type: 'string' } },
          },
        },
        reason: { type: 'string' },
      },
      required: ['target_agent', 'instruction'],
    },
  },
  {
    name: 'approve_delivery',
    description: '申请交付。系统独立执行交付门禁核对，核对不通过就拒绝。',
    parameters: {
      type: 'object',
      properties: {
        artifact_type: { type: 'string', description: '要交付的产物类型（可选，系统自动定位）' },
        summary: { type: 'string' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'request_human_input',
    description: '请求人工输入。Case 将停在 waiting_human 状态。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['reason'],
    },
  },
];

/**
 * 构造崩溃恢复续跑消息：附 Case 当前状态摘要，让 start_agent 能据实决定下一步
 * （路由审核 / 下发返修 / 申请交付），而不是收到一句模糊的"续跑"后停滞。
 * 全部从配置 + DB 状态派生，不含业务角色名硬编码（铁律 1）。
 */
function buildResumeContextMessage(
  caseId: string,
  repo: RepositoryPort,
  config: ScenarioConfig,
): string {
  const lines: string[] = ['系统崩溃恢复后续跑。请根据以下当前进度决定下一步：'];
  const caseRecord = repo.getCase(caseId);
  if (caseRecord) {
    lines.push(`- Case 状态: ${caseRecord.status}`);
  }
  // 各产物类型的最新版本（配置驱动，不写死产物类型名）
  for (const at of config.artifact_types) {
    const artifact = repo.getArtifactByTypeAndCase(caseId, at.type);
    if (artifact) {
      const latest = repo.getLatestVersion(artifact.artifact_id as string);
      if (latest) {
        lines.push(`- 最新产物 [${at.type}]: v${latest.version} (${latest.status})`);
      }
    }
  }
  // 待处理 Issue
  const issues = repo.getIssuesByCase(caseId);
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
  const revisions = repo.getActiveRevisionInstructions(caseId);
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
 * 解析 Case 输入 payload（铁律 1：输入不写死在源码，按 scenario.input_fields 驱动）。
 * 优先级：FORGE_INPUT 环境变量(JSON) > FORGE_INPUT_FILE 环境变量(路径) >
 *        <scenario 目录>/input.example.json > fail loud。
 * 校验：scenario.input_fields 声明的字段必须齐全。
 */
function resolveInputPayload(
  scenarioPath: string,
  config: ScenarioConfig,
): Record<string, unknown> {
  let raw: string;
  let source: string;
  if (process.env.FORGE_INPUT) {
    raw = process.env.FORGE_INPUT;
    source = 'FORGE_INPUT';
  } else if (process.env.FORGE_INPUT_FILE) {
    const file = resolve(process.env.FORGE_INPUT_FILE);
    raw = readFileSync(file, 'utf-8');
    source = `FORGE_INPUT_FILE(${file})`;
  } else {
    const samplePath = resolve(dirname(scenarioPath), 'input.example.json');
    if (existsSync(samplePath)) {
      raw = readFileSync(samplePath, 'utf-8');
      source = `sample(${samplePath})`;
    } else {
      throw new Error(
        `未提供 Case 输入：请设置 FORGE_INPUT(JSON) 或 FORGE_INPUT_FILE(路径)，` +
          `或在 ${samplePath} 放置示例输入。期望字段：${config.input_fields.map((f) => f.key).join(', ')}`,
      );
    }
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`输入 JSON 解析失败(来源 ${source})：${e instanceof Error ? e.message : e}`);
  }
  const missing = config.input_fields.filter((f) => !(f.key in payload)).map((f) => f.key);
  if (missing.length > 0) {
    throw new Error(
      `输入缺少必填字段(来源 ${source})：${missing.join(', ')}。` +
        `scenario.input_fields 要求：${config.input_fields.map((f) => f.key).join(', ')}`,
    );
  }
  console.log(`  输入来源: ${source}`);
  return payload;
}

/**
 * 把输入 payload 渲染成首条任务消息（通用，不写死歌词/文案语义）。
 * 按 scenario.input_fields 的 label 逐字段渲染。
 */
function renderInputMessage(payload: Record<string, unknown>, config: ScenarioConfig): string {
  const lines = config.input_fields.map((f) => `${f.label}: ${payload[f.key]}`);
  return `请开始执行任务。用户输入：\n${lines.join('\n')}`;
}

async function main() {
  // 读取环境变量
  const piMode = process.env.PI_MODE ?? 'fake';
  const dbPath = process.env.DB_PATH ?? './data/forge.db';
  const scenarioPath = process.env.SCENARIO_PATH ?? './scenarios/songwriting/scenario.yaml';

  console.log(`[Forge AI Worker] 启动`);
  console.log(`  PI_MODE: ${piMode}`);
  console.log(`  DB_PATH: ${dbPath}`);
  console.log(`  SCENARIO_PATH: ${scenarioPath}`);

  // 确保数据目录存在
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });

  // 初始化基础设施
  const repo = new SqliteRepository(resolve(dbPath));
  const clock = new SystemClock();
  const idGen = new UuidGenerator();
  const configLoader = new FileConfigLoader();

  // 加载场景配置
  const scenarioConfig = configLoader.loadScenario(resolve(scenarioPath));
  console.log(`  场景: ${scenarioConfig.scenario.name} (v${scenarioConfig.scenario.version})`);

  // 选择 Pi adapter
  let pi: PiPort;
  let fakePi: FakePiAdapter | null = null;

  if (piMode === 'fake') {
    fakePi = new FakePiAdapter();
    // 加载 Fake Pi 脚本
    const scriptPath = resolve(scenarioPath).replace('scenario.yaml', 'fake-pi-script.json');
    try {
      const { readFileSync } = await import('node:fs');
      const scriptContent = readFileSync(scriptPath, 'utf-8');
      const script: FakePiScript = JSON.parse(scriptContent);
      fakePi.registerScript(scenarioConfig.scenario.id, script);
      console.log(`  Fake Pi 脚本已加载: ${scriptPath}`);
    } catch {
      console.log(`  警告: 未找到 Fake Pi 脚本 (${scriptPath})，使用空脚本`);
      fakePi.registerScript(scenarioConfig.scenario.id, { turns: [] });
    }
    // 设置上下文解析器：动态替换 PLACEHOLDER_ISSUE_ID
    fakePi.setContextResolver((): Record<string, string> => {
      const cases = repo.getCasesByStatus('running').concat(repo.getCasesByStatus('repairing')).concat(repo.getCasesByStatus('waiting_review'));
      for (const c of cases) {
        const issues = repo.getIssuesByCase(c.case_id as string);
        if (issues.length > 0) {
          const issueIds = issues.map((i) => i.issue_id as string);
          return { 'PLACEHOLDER_ISSUE_ID': issueIds[0] };
        }
      }
      return {} as Record<string, string>;
    });
    pi = fakePi;
  } else if (piMode === 'real') {
    // 真实 Pi adapter（基于 @earendil-works/pi-ai SDK）
    // 铁律 6：API Key 从环境变量读取，不进日志/数据库
    if (!process.env.DEEPSEEK_API_KEY) {
      console.error('  错误: 真实 Pi 模式需要设置 DEEPSEEK_API_KEY 环境变量');
      process.exit(1);
    }
    const modelId = process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';
    pi = new RealPiAdapter({ modelId });
    console.log(`  真实 Pi adapter 已初始化 (model: deepseek/${modelId})`);
  } else {
    console.error(`  错误: 未知的 PI_MODE: ${piMode}（支持 fake | real）`);
    process.exit(1);
  }

  // 初始化服务
  const caseService = new CaseService(repo, clock, idGen);
  const turnExecutor = new TurnExecutor(repo, clock, idGen, pi);
  const recoveryService = new RecoveryService(repo, clock);

  // 崩溃恢复检查
  const casesNeedingRecovery = recoveryService.findCasesNeedingRecovery();
  let resumeCaseId: string | null = null;
  let resumeAgentKey: string | null = null;
  let resumeMessage: string | null = null;

  if (casesNeedingRecovery.length > 0) {
    console.log(`\n[恢复] 发现 ${casesNeedingRecovery.length} 个需要恢复的 Case`);
    for (const caseId of casesNeedingRecovery) {
      const result = recoveryService.recoverCase(caseId);
      console.log(`  ${caseId}: ${result.detail}`);
      // 记录第一个成功恢复的 Case，准备续跑
      if (result.recovered && !resumeCaseId) {
        resumeCaseId = caseId;
        // 从最后完成的 Turn 的工具调用推断续跑起点
        const lastTurn = repo.getLastCompletedTurn(caseId);
        // Fake Pi：把脚本计数器对齐到"最后完成 Turn 的下一个"，避免续跑时脚本错位
        if (fakePi && lastTurn) {
          fakePi.setTurnCounter(scenarioConfig.scenario.id, lastTurn.sequence as number);
        }
        if (lastTurn) {
          const actions = repo.getToolActionsByTurn(lastTurn.turn_id as string);
          for (const action of actions) {
            if (action.tool_name === 'route_message' && action.result) {
              const routeOutput = JSON.parse(action.result as string);
              if (routeOutput.success) {
                const args = JSON.parse(action.arguments as string);
                resumeAgentKey = args.target_agent;
                resumeMessage = args.instruction;
              }
            }
          }
        }
        // 如果无法从工具调用推断（例如最后完成的是 generator 的 publish 或 reviewer 的
        // submit_evaluation，这些不走 route_message），用 start_agent 续跑，并附 Case 状态
        // 摘要--否则一句模糊的"续跑"会让模型停滞（真实 Pi 崩溃恢复实测卡在 waiting_review）。
        if (!resumeAgentKey) {
          resumeAgentKey = scenarioConfig.start_agent;
          resumeMessage = buildResumeContextMessage(caseId, repo, scenarioConfig);
        }
      }
    }
  }

  // 确定要执行的 Case：优先续跑恢复的 Case，否则创建新 Case
  let caseId: string;
  let currentAgentKey: string;
  let currentMessage: string;

  if (resumeCaseId) {
    // 续跑已恢复的 Case（12.2 崩溃恢复验收）
    caseId = resumeCaseId;
    currentAgentKey = resumeAgentKey!;
    currentMessage = resumeMessage!;
    console.log(`\n[Case] 续跑: ${caseId} (从 agent: ${currentAgentKey} 继续)`);
  } else {
    // 创建新 Case（铁律 1：输入从外部/示例文件读，不写死在源码）
    const inputPayload = resolveInputPayload(scenarioPath, scenarioConfig);

    caseId = caseService.createCase({
      title: `${scenarioConfig.scenario.name} - ${new Date().toISOString().slice(0, 10)}`,
      scenarioConfig,
      inputPayload,
    });
    console.log(`\n[Case] 创建: ${caseId}`);

    // 启动 Case
    caseService.startCase(caseId);
    console.log(`[Case] 启动: ${caseId}`);

    currentAgentKey = scenarioConfig.start_agent;
    currentMessage = renderInputMessage(inputPayload, scenarioConfig);
  }

  // 执行 Turn 循环
  // MAX_TURNS：测试钩子，限制本轮执行的 Turn 数（模拟"跑到一半进程退出"，用于崩溃恢复测试）
  const maxTurns = parseInt(process.env.MAX_TURNS ?? '20', 10);
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;

  for (let turnNum = 0; turnNum < maxTurns; turnNum++) {
    const caseRecord = repo.getCase(caseId);
    if (!caseRecord) break;

    const caseStatus = caseRecord.status as string;
    if (caseStatus === 'approved' || caseStatus === 'failed' || caseStatus === 'stopped') {
      console.log(`\n[Case] 终态: ${caseStatus}`);
      break;
    }
    if (caseStatus === 'waiting_human') {
      console.log(`\n[Case] 等待人工输入，停止`);
      break;
    }

    // 获取或创建 session（cold_per_version 策略：每次调用都创建全新 Session）
    const agentConfig = scenarioConfig.agents.find((a) => a.key === currentAgentKey);
    if (!agentConfig) {
      console.error(`[错误] 未找到 agent 配置: ${currentAgentKey}`);
      break;
    }

    let session = repo.getActiveSession(caseId, currentAgentKey);
    let sessionId: string;

    // cold_per_version：关闭旧 Session，确保每次调用都是独立冷启动
    if (session && agentConfig.session.policy === 'cold_per_version') {
      repo.updateSession(session.session_id as string, { status: 'closed', closed_at: clock.now() });
      if (pi instanceof RealPiAdapter) {
        await pi.closeSession(session.pi_session_ref as string);
      }
      session = null;
    }

    if (!session) {
      sessionId = idGen.generate('sess');
      const piSession = await pi.createSession(currentAgentKey, agentConfig.session.policy);
      repo.insertSession({
        session_id: sessionId,
        case_id: caseId,
        agent_key: currentAgentKey,
        session_policy: agentConfig.session.policy,
        scope_key: null,
        pi_session_ref: piSession.session_ref,
        status: 'active',
        opened_at: clock.now(),
        closed_at: null,
      });
      // 对于真实 Pi adapter，注册 DB session_id -> 刚创建的 pi_session_ref 的别名
      if (pi instanceof RealPiAdapter) {
        pi.registerSession(sessionId, piSession.session_ref);
      }
    } else {
      // persistent 策略：复用已有 Session（继承历史上下文）
      sessionId = session.session_id as string;
      if (pi instanceof RealPiAdapter) {
        // 跨进程恢复（2.3 硬指标）：进程重启后 adapter 内存 sessions map 为空，
        // registerSession 会因 this.sessions.get(pi_session_ref)===undefined 而成为 no-op，
        // 随后 executeTurn({session_ref: sessionId}) 会报 "Session not found"。
        // 必须先 resumeSession 把 persistent session 从磁盘文件加载回内存（恢复完整对话历史），
        // 再 registerSession 建 DB session_id -> pi_session_ref 别名。
        // resumeSession 幂等：同一进程内已加载则直接返回，不重复读盘。
        await pi.resumeSession(session.pi_session_ref as string);
        pi.registerSession(sessionId, session.pi_session_ref as string);
      }
    }

    // 加载提示词
    let systemPrompt = `你是 ${agentConfig.name}。`;
    try {
      const promptPath = resolve(dirname(scenarioPath), agentConfig.prompt);
      systemPrompt = configLoader.loadPrompt(promptPath);
    } catch {
      // 使用默认提示词
    }

    // 过滤该 agent 可用的工具
    const agentTools = TOOL_DEFINITIONS.filter((t) => agentConfig.tools.includes(t.name));

    console.log(`\n[Turn ${turnNum + 1}] Agent: ${currentAgentKey} (${agentConfig.name})`);

    // 执行 Turn
    const result = await turnExecutor.executeTurn({
      caseId,
      sessionId,
      agentKey: currentAgentKey,
      scenarioConfig,
      systemPrompt,
      userMessage: currentMessage,
      tools: agentTools,
    });

    if (result.status === 'failed') {
      consecutiveErrors++;
      console.log(`  [失败] ${result.error}`);
      if (consecutiveErrors >= maxConsecutiveErrors) {
        console.error(`\n[停止] 连续 ${maxConsecutiveErrors} 次异常，停下汇报`);
        caseService.transitionCaseStatus(caseId, 'failed');
        break;
      }
      continue;
    }

    consecutiveErrors = 0;
    console.log(`  [完成] Turn: ${result.turnId}`);

    // 解析工具调用结果，决定下一步
    const routeResult = result.toolCallResults.find((r) => r.revision_instruction_id !== undefined || r.success !== undefined) as Record<string, unknown> | undefined;

    // 检查是否有 route_message 结果（决定下一个 agent）
    const toolActions = repo.getToolActionsByTurn(result.turnId);
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
            caseService.transitionCaseStatus(caseId, 'repairing');
          } else {
            const cr = repo.getCase(caseId);
            if (cr && cr.status === 'running') {
              caseService.transitionCaseStatus(caseId, 'waiting_review');
            }
          }
          break;
        }
      }

      if (action.tool_name === 'approve_delivery' && action.result) {
        const deliveryOutput = JSON.parse(action.result as string);
        if (deliveryOutput.gate_passed) {
          caseService.transitionCaseStatus(caseId, 'approved');
          repo.closeSessionsByCase(caseId);
          console.log(`\n[交付] 门禁通过，Case 已交付！`);
        } else {
          console.log(`  [门禁] 未通过: ${JSON.stringify(deliveryOutput.checks?.filter((c: any) => !c.passed))}`);
          // 回到总控
          currentAgentKey = scenarioConfig.start_agent;
          currentMessage = `交付门禁未通过，请检查原因并决定下一步。门禁结果：${JSON.stringify(deliveryOutput.checks)}`;
          routed = true;
        }
      }

      if (action.tool_name === 'submit_evaluation' && action.result) {
        const evalOutput = JSON.parse(action.result as string);
        const evalArgs = JSON.parse(action.arguments as string);
        if (evalArgs.verdict === 'approve') {
          // 审核通过，回到总控
          currentAgentKey = scenarioConfig.start_agent;
          currentMessage = `审核已通过。产物已通过复审验证。请决定是否申请交付。`;
          routed = true;
          const cr = repo.getCase(caseId);
          if (cr && (cr.status === 'repairing' || cr.status === 'waiting_review')) {
            caseService.transitionCaseStatus(caseId, 'running');
          }
        } else {
          // 审核不通过，回到总控
          currentAgentKey = scenarioConfig.start_agent;
          // 把 issue 详情（problem/anchor/evidence）带进消息，否则总控无法构造 editable/frozen 返修范围
          const issueDetails = ((evalOutput.issue_ids as string[]) ?? [])
            .map((id) => {
              const iss = repo.getIssue(id);
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
          const cr = repo.getCase(caseId);
          if (cr && cr.status === 'waiting_review') {
            caseService.transitionCaseStatus(caseId, 'running');
          }
        }
      }

      if (action.tool_name === 'publish_artifact' && action.result) {
        const pubOutput = JSON.parse(action.result as string);
        if (pubOutput.success) {
          console.log(`  [产物] v${pubOutput.version} 已发布`);
          // 发布后自动路由到审核（根据配置）
          const nextRoute = scenarioConfig.routes.find(
            (r) => r.from === currentAgentKey && r.to.length > 0,
          );
          if (nextRoute && !routed) {
            // 检查是否有到 reviewer 的路由
            const reviewerRoute = scenarioConfig.routes.find(
              (r) => r.from === currentAgentKey,
            );
            if (reviewerRoute) {
              const targetKey = reviewerRoute.to.find((t) => {
                const targetAgent = scenarioConfig.agents.find((a) => a.key === t);
                return targetAgent?.tools.includes('submit_evaluation');
              });
              if (targetKey) {
                currentAgentKey = targetKey;
                currentMessage = `请审核最新版本的产物。`;
                routed = true;
                const cr = repo.getCase(caseId);
                // 初版发布：running -> waiting_review；
                // 返修版发布：repairing -> waiting_review（否则 case 卡在 repairing，
                // 后续 reviewer 再判 repair、supervisor 再发返修会触发 repairing->repairing 非法转换）
                if (cr && (cr.status === 'running' || cr.status === 'repairing')) {
                  caseService.transitionCaseStatus(caseId, 'waiting_review');
                }
              }
            }
          }
        }
      }

      if (action.tool_name === 'request_human_input') {
        caseService.transitionCaseStatus(caseId, 'waiting_human');
        console.log(`  [人工] Case 进入 waiting_human 状态`);
      }
    }

    if (!routed) {
      // 没有路由发生，检查是否应该结束
      const cr = repo.getCase(caseId);
      if (cr && (cr.status === 'approved' || cr.status === 'waiting_human')) {
        break;
      }
      // 默认：如果当前 agent 没有产生路由，结束循环
      if (result.toolCallResults.length === 0) {
        console.log(`  [结束] Agent 未产生工具调用，循环结束`);
        break;
      }
    }
  }

  // 最终状态
  const finalCase = repo.getCase(caseId);
  console.log(`\n[最终] Case ${caseId} 状态: ${finalCase?.status}`);

  repo.close();
  console.log(`[Forge AI Worker] 完成`);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
