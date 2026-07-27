/**
 * Worker 主入口（薄封装）
 * 加载配置 → 初始化 SQLite → 选择 Pi adapter（Fake/Real）→ 构造 CaseRunner → 执行
 * 核心逻辑已提取到 @forge-ai/application 的 CaseRunner。
 */

import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import type { PiPort, PiToolDefinition, ScenarioConfig } from '@forge-ai/contracts';
import { CaseRunner, RecoveryService, type Logger } from '@forge-ai/application';
import {
  SqliteRepository,
  FakePiAdapter,
  RealPiAdapter,
  SystemClock,
  UuidGenerator,
  FileConfigLoader,
  ScriptArtifactValidator,
  resolveSingleDbPath,
  defaultDbEnv,
} from '@forge-ai/adapters';
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

// === Logger 实现（console） ===
const consoleLogger: Logger = {
  info: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
  warn: (msg: string) => console.warn(msg),
};

async function main() {
  // 读取环境变量
  const piMode = process.env.PI_MODE ?? 'fake';
  // 两库模型：DB_PATH 显式覆盖优先级最高；否则按 FORGE_ENV 选 production(默认)/test 库。
  // 与 CLI/web 共用 resolveSingleDbPath/defaultDbEnv（计划第 2 节：配置共享）。
  const dbEnv = defaultDbEnv();
  const dbPath = process.env.DB_PATH ?? resolveSingleDbPath(dbEnv);
  const scenarioPath = process.env.SCENARIO_PATH ?? './scenarios/songwriting/scenario.yaml';

  console.log(`[Forge AI Worker] 启动`);
  console.log(`  PI_MODE: ${piMode}`);
  console.log(`  DB_ENV: ${dbEnv}`);
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

  if (piMode === 'fake') {
    const fakePi = new FakePiAdapter();
    // 加载 Fake Pi 脚本
    const scriptPath = resolve(scenarioPath).replace('scenario.yaml', 'fake-pi-script.json');
    try {
      const scriptContent = readFileSync(scriptPath, 'utf-8');
      const script: FakePiScript = JSON.parse(scriptContent);
      fakePi.registerScript(scenarioConfig.scenario.id, script);
      console.log(`  Fake Pi 脚本已加载: ${scriptPath}`);
    } catch {
      console.log(`  警告: 未找到 Fake Pi 脚本 (${scriptPath})，使用空脚本`);
      fakePi.registerScript(scenarioConfig.scenario.id, { turns: [] });
    }
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

  // 构造 CaseRunner
  const runner = new CaseRunner({
    repo,
    clock,
    idGen,
    pi,
    scenarioConfig,
    scenarioPath: resolve(scenarioPath),
    configLoader,
    toolDefinitions: TOOL_DEFINITIONS,
    logger: consoleLogger,
    artifactValidator: new ScriptArtifactValidator(dirname(resolve(scenarioPath))),
    maxTurns: parseInt(process.env.MAX_TURNS ?? '20', 10),
  });

  // 崩溃恢复检查：如果有需恢复的 Case → 续跑
  const recoveryService = new RecoveryService(repo, clock);
  const casesNeedingRecovery = recoveryService.findCasesNeedingRecovery();

  if (casesNeedingRecovery.length > 0) {
    console.log(`\n[恢复] 发现 ${casesNeedingRecovery.length} 个需要恢复的 Case`);
    const caseId = casesNeedingRecovery[0];
    console.log(`\n[Case] 续跑: ${caseId}`);
    const result = await runner.runCase(caseId);
    console.log(`\n[最终] Case ${result.case_id} 状态: ${result.status}`);
  } else {
    // 创建新 Case
    const inputPayload = resolveInputPayload(scenarioPath, scenarioConfig);
    const caseId = runner.createCase({
      title: `${scenarioConfig.scenario.name} - ${new Date().toISOString().slice(0, 10)}`,
      inputPayload,
    });
    console.log(`\n[Case] 创建: ${caseId}`);

    const result = await runner.runCase(caseId);
    console.log(`\n[最终] Case ${result.case_id} 状态: ${result.status}`);
  }

  repo.close();
  console.log(`[Forge AI Worker] 完成`);
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
