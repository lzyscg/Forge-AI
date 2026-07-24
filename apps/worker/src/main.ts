/**
 * Worker 主入口
 * 加载配置 → 初始化 SQLite → 选择 Pi adapter（Fake/Real）→ 创建/恢复 Case → 顺序执行 Turn 循环
 * 单 Case 顺序执行，不做并发。
 */

import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { PiPort, PiToolDefinition, ScenarioConfig } from '@forge-ai/contracts';
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
  if (casesNeedingRecovery.length > 0) {
    console.log(`\n[恢复] 发现 ${casesNeedingRecovery.length} 个需要恢复的 Case`);
    for (const caseId of casesNeedingRecovery) {
      const result = recoveryService.recoverCase(caseId);
      console.log(`  ${caseId}: ${result.detail}`);
    }
  }

  // 创建新 Case
  const inputPayload = {
    reference_lyrics: '月光洒在老路上\n你的影子在前方\n我们走过的地方\n花开满了山岗\n风吹过耳旁\n像你说的晚安',
    fixed_phrase: '你是我的山歌',
  };

  const caseId = caseService.createCase({
    title: `歌词生产 - ${new Date().toISOString().slice(0, 10)}`,
    scenarioConfig,
    inputPayload,
  });
  console.log(`\n[Case] 创建: ${caseId}`);

  // 启动 Case
  caseService.startCase(caseId);
  console.log(`[Case] 启动: ${caseId}`);

  // 执行 Turn 循环
  const maxTurns = 20; // 安全上限
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;

  // 确定当前活跃的 agent 和消息
  let currentAgentKey = scenarioConfig.start_agent;
  let currentMessage = `请开始执行任务。用户输入：\n参考歌词：${inputPayload.reference_lyrics}\n固定金句：${inputPayload.fixed_phrase}`;

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

    // 获取或创建 session
    const agentConfig = scenarioConfig.agents.find((a) => a.key === currentAgentKey);
    if (!agentConfig) {
      console.error(`[错误] 未找到 agent 配置: ${currentAgentKey}`);
      break;
    }

    let session = repo.getActiveSession(caseId, currentAgentKey);
    let sessionId: string;

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
      // 对于真实 Pi adapter，注册 DB session_id 以便 turn-executor 可以使用
      if (pi instanceof RealPiAdapter) {
        pi.registerSession(sessionId, currentAgentKey, agentConfig.session.policy);
      }
    } else {
      sessionId = session.session_id as string;
      // 对于真实 Pi adapter，确保 session 已注册（用于崩溃恢复场景）
      if (pi instanceof RealPiAdapter) {
        pi.registerSession(sessionId, currentAgentKey, agentConfig.session.policy);
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
          if (cr && cr.status === 'repairing') {
            caseService.transitionCaseStatus(caseId, 'running');
          }
        } else {
          // 审核不通过，回到总控
          currentAgentKey = scenarioConfig.start_agent;
          currentMessage = `审核未通过。发现问题：${evalOutput.issue_ids?.join(', ')}。请决定返修方案。`;
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
                if (cr && cr.status === 'running') {
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
