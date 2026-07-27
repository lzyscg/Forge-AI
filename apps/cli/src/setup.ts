/**
 * CLI 初始化：凭证加载、DB 路径解析、Pi adapter 选择
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { getPackageRoot, resolveFromRoot, resolveDbPaths, resolveSingleDbPath, defaultDbEnv, type DbEnv } from '@forge-ai/adapters';
import {
  SqliteRepository,
  FakePiAdapter,
  RealPiAdapter,
  SystemClock,
  UuidGenerator,
  FileConfigLoader,
  computeScenarioBundleSha256,
} from '@forge-ai/adapters';
import type { FakePiScript } from '@forge-ai/adapters';
import type { PiPort, PiToolDefinition, ScenarioConfig } from '@forge-ai/contracts';
import type { Logger } from '@forge-ai/application';
import { writeErrorLine } from './output.js';

// CLI 启动即加载 .env（相对包根）
config({ path: resolveFromRoot('.env') });

/** 合法 env 取值 */
const VALID_DB_ENVS = new Set<string>(['production', 'test', 'all']);

/**
 * 校验并解析 --env 字符串为 DbEnv。
 * 传入 undefined 时返回默认 env（production，可被 FORGE_ENV 覆盖）。
 */
export function parseDbEnv(envOption?: string): DbEnv {
  const env = envOption ?? defaultDbEnv();
  if (!VALID_DB_ENVS.has(env)) {
    throw new Error(`无效的 --env: ${env}（支持 production | test | all）`);
  }
  return env as DbEnv;
}

/**
 * 解析 DB 路径用于读操作（--env all 时返回两个库做聚合）。
 * 优先级：--db > --env > DB_PATH(回退，向后兼容) > 默认 production。
 */
export function resolveReadDbPaths(dbOption?: string, envOption?: string): string[] {
  if (dbOption) return [resolve(dbOption)];
  if (envOption) return resolveDbPaths(parseDbEnv(envOption));
  if (process.env.DB_PATH && process.env.DB_PATH.trim() !== '') {
    return [resolve(process.env.DB_PATH)];
  }
  return resolveDbPaths(defaultDbEnv());
}

/**
 * 解析 DB 路径用于写操作（必须单库，--env all 报错）。
 * 优先级：--db > --env > DB_PATH(回退，向后兼容) > 默认 production。
 */
export function resolveWriteDbPath(dbOption?: string, envOption?: string): string {
  if (dbOption) return resolve(dbOption);
  if (envOption) {
    const env = parseDbEnv(envOption);
    if (env === 'all') {
      throw new Error('写操作必须指定单个库（--env production|test），不支持 --env all');
    }
    return resolveSingleDbPath(env);
  }
  if (process.env.DB_PATH && process.env.DB_PATH.trim() !== '') {
    return resolve(process.env.DB_PATH);
  }
  return resolveSingleDbPath(defaultDbEnv());
}

/** @deprecated 用 resolveReadDbPaths / resolveWriteDbPath 代替。保留供旧调用回退。 */
export function resolveDbPath(dbOption?: string): string {
  return resolve(dbOption ?? process.env.DB_PATH ?? resolveFromRoot('data', 'forge.db'));
}

export function resolveMode(modeOption?: string): string {
  const mode = modeOption ?? process.env.PI_MODE ?? 'fake';
  if (mode === 'real' && !process.env.DEEPSEEK_API_KEY) {
    process.stderr.write('[FATAL] --mode real 需要 DEEPSEEK_API_KEY 环境变量\n');
    writeErrorLine('--mode real 需要 DEEPSEEK_API_KEY 环境变量');
    process.exit(1);
  }
  return mode;
}

// === 工具定义（注册给 Pi 的） ===
export const TOOL_DEFINITIONS: PiToolDefinition[] = [
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
 * 解析场景路径：name → scenarios/<name>/scenario.yaml，path 直接用
 */
export function resolveScenarioPath(templateOption: string): string {
  // 如果包含路径分隔符或以 .yaml 结尾，视为直接路径
  if (templateOption.includes('/') || templateOption.includes('\\') || templateOption.endsWith('.yaml')) {
    return resolve(templateOption);
  }
  return resolveFromRoot('scenarios', templateOption, 'scenario.yaml');
}

export function resolveScenarioBundleSha256(
  scenarioPath: string,
  scenarioConfig: ScenarioConfig,
): string {
  return computeScenarioBundleSha256(scenarioPath, scenarioConfig);
}

/**
 * 创建 Pi adapter（fake / real）
 */
export function createPiAdapter(mode: string, scenarioPath: string, scenarioConfig: ScenarioConfig, logger: Logger): PiPort {
  if (mode === 'fake') {
    const fakePi = new FakePiAdapter();
    const scriptPath = resolve(dirname(scenarioPath), 'fake-pi-script.json');
    try {
      const scriptContent = readFileSync(scriptPath, 'utf-8');
      const script: FakePiScript = JSON.parse(scriptContent);
      fakePi.registerScript(scenarioConfig.scenario.id, script);
      logger.info(`Fake Pi 脚本已加载: ${scriptPath}`);
    } catch {
      logger.warn(`未找到 Fake Pi 脚本 (${scriptPath})，使用空脚本`);
      fakePi.registerScript(scenarioConfig.scenario.id, { turns: [] });
    }
    return fakePi;
  } else if (mode === 'real') {
    const modelId = process.env.PI_MODEL_ID ?? 'deepseek-v4-flash';
    logger.info(`真实 Pi adapter 已初始化 (model: deepseek/${modelId})`);
    return new RealPiAdapter({ modelId });
  } else {
    process.stderr.write(`[FATAL] 未知的 PI_MODE: ${mode}（支持 fake | real）\n`);
    writeErrorLine(`未知的 PI_MODE: ${mode}`);
    process.exit(1);
  }
}

/**
 * 初始化基础设施（repo, clock, idGen, configLoader）
 */
export function initInfra(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const repo = new SqliteRepository(dbPath);
  const clock = new SystemClock();
  const idGen = new UuidGenerator();
  const configLoader = new FileConfigLoader();
  return { repo, clock, idGen, configLoader };
}

function initReadInfra(dbPath: string) {
  const repo = new SqliteRepository(dbPath, { readonly: true });
  const clock = new SystemClock();
  const idGen = new UuidGenerator();
  const configLoader = new FileConfigLoader();
  return { repo, clock, idGen, configLoader };
}

/**
 * 在多个库中查找包含指定 case 的库（读操作 --env all 聚合搜索用）。
 * 跳过不存在的库文件（不创建空库）。返回首个命中的 infra + dbPath，未命中返回 null。
 * 命中库的 repo 保持打开，调用方负责关闭。
 */
export function findCaseInfra(
  dbPaths: string[],
  caseId: string,
): { dbPath: string; repo: SqliteRepository; clock: SystemClock; idGen: UuidGenerator; configLoader: FileConfigLoader } | null {
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    const infra = initReadInfra(dbPath);
    if (infra.repo.getCase(caseId)) {
      return { dbPath, ...infra };
    }
    infra.repo.close();
  }
  return null;
}

/**
 * 解析 Case 输入 payload
 * 优先级：--input 参数 > FORGE_INPUT 环境变量 > FORGE_INPUT_FILE > input.example.json
 */
export function resolveInputPayload(
  scenarioPath: string,
  scenarioConfig: ScenarioConfig,
  inputOption?: string,
): Record<string, unknown> {
  let raw: string;
  let source: string;

  if (inputOption) {
    raw = inputOption;
    source = '--input';
  } else if (process.env.FORGE_INPUT) {
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
        `未提供 Case 输入：请使用 --input '<json>' 或设置 FORGE_INPUT/FORGE_INPUT_FILE，` +
        `或在 ${samplePath} 放置示例输入。期望字段：${scenarioConfig.input_fields.map((f) => f.key).join(', ')}`,
      );
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`输入 JSON 解析失败(来源 ${source})：${e instanceof Error ? e.message : e}`);
  }

  const missing = scenarioConfig.input_fields.filter((f) => !(f.key in payload)).map((f) => f.key);
  if (missing.length > 0) {
    throw new Error(
      `输入缺少必填字段(来源 ${source})：${missing.join(', ')}。` +
      `scenario.input_fields 要求：${scenarioConfig.input_fields.map((f) => f.key).join(', ')}`,
    );
  }

  process.stderr.write(`[INFO] 输入来源: ${source}\n`);
  return payload;
}
