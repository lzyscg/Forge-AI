/**
 * forge case create / run / status / list / resume / stop
 */
import { Command } from 'commander';
import { CaseRunner, ConcurrentCaseError, type Logger } from '@forge-ai/application';
import { resolveFromRoot, FakePiAdapter } from '@forge-ai/adapters';
import type { ResultJson } from '@forge-ai/contracts';
import { writeFirstLine, writeResultLine, writeErrorLine, writeStdoutLine } from '../output.js';
import { createFileLogger, stderrLogger } from '../logger.js';
import {
  resolveDbPath, resolveMode, resolveScenarioPath, resolveInputPayload,
  initInfra, createPiAdapter, TOOL_DEFINITIONS,
} from '../setup.js';

/** 所有已知状态（用于 case list 全量查询） */
const ALL_STATUSES = ['created', 'running', 'waiting_review', 'repairing', 'waiting_human', 'approved', 'failed', 'stopped'];

export function registerCaseCommand(program: Command): void {
  const caseCmd = program.command('case').description('Case 生命周期管理');

  // forge case create
  caseCmd
    .command('create')
    .description('创建新 Case')
    .requiredOption('--template <name|path>', '场景模板名称或路径')
    .option('--input <json>', '输入 JSON')
    .option('--db <path>', '数据库路径')
    .option('--mode <mode>', 'Pi 模式 (fake|real)')
    .option('--title <title>', 'Case 标题')
    .option('--human', '人类可读格式输出')
    .action((opts) => {
      try {
        const dbPath = resolveDbPath(opts.db);
        const mode = resolveMode(opts.mode);
        const scenarioPath = resolveScenarioPath(opts.template);
        const { repo, clock, idGen, configLoader } = initInfra(dbPath);

        const scenarioConfig = configLoader.loadScenario(scenarioPath);
        const pi = createPiAdapter(mode, scenarioPath, scenarioConfig, stderrLogger);

        const runner = new CaseRunner({
          repo, clock, idGen, pi,
          scenarioConfig,
          scenarioPath,
          configLoader,
          toolDefinitions: TOOL_DEFINITIONS,
          logger: stderrLogger,
        });

        const inputPayload = resolveInputPayload(scenarioPath, scenarioConfig, opts.input);
        const title = opts.title ?? `${scenarioConfig.scenario.name} - ${new Date().toISOString().slice(0, 10)}`;
        const caseId = runner.createCase({ title, inputPayload });

        writeFirstLine(caseId);
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });

  // forge case run <id>
  caseCmd
    .command('run <id>')
    .description('运行 Case（默认阻塞到终态）')
    .option('--wait', '阻塞等待完成（默认）', true)
    .option('--max-turns <n>', '最大 Turn 数', '20')
    .option('--db <path>', '数据库路径')
    .option('--mode <mode>', 'Pi 模式 (fake|real)')
    .option('--human', '人类可读格式输出')
    .action(async (id: string, opts) => {
      const dbPath = resolveDbPath(opts.db);
      const mode = resolveMode(opts.mode);
      const logPath = resolveFromRoot('data', `case-${id}.log`);
      const logger = createFileLogger(logPath);

      try {
        const { repo, clock, idGen, configLoader } = initInfra(dbPath);

        // 从 case 记录获取 scenario 信息
        const caseRecord = repo.getCase(id);
        if (!caseRecord) {
          writeErrorLine(`Case not found: ${id}`);
          repo.close();
          process.exit(1);
        }

        const scenarioSnapshot = JSON.parse(caseRecord.scenario_snapshot as string);
        const scenarioPath = resolveScenarioPath(scenarioSnapshot.scenario?.id ?? 'songwriting');

        // 尝试从 snapshot 恢复完整 scenarioConfig
        let scenarioConfig;
        try {
          scenarioConfig = configLoader.loadScenario(scenarioPath);
        } catch {
          // 如果文件不存在，使用 snapshot
          scenarioConfig = scenarioSnapshot;
        }

        const pi = createPiAdapter(mode, scenarioPath, scenarioConfig, logger);
        const maxTurns = parseInt(opts.maxTurns, 10);

        const runner = new CaseRunner({
          repo, clock, idGen, pi,
          scenarioConfig,
          scenarioPath,
          configLoader,
          toolDefinitions: TOOL_DEFINITIONS,
          logger,
          maxTurns,
        });

        runner.assertNoConcurrentCase(id); // 先检查并发
        writeFirstLine(id);                // 通过后才写第一行

        const result = await runner.runCase(id, { maxTurns });
        writeResultLine(result);
        repo.close();
      } catch (e) {
        if (e instanceof ConcurrentCaseError) {
          writeErrorLine(e.message, e.runningCaseId);
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          writeErrorLine(msg);
        }
        process.exit(1);
      }
    });

  // forge case status <id>
  caseCmd
    .command('status <id>')
    .description('查看 Case 状态')
    .option('--db <path>', '数据库路径')
    .option('--human', '人类可读格式输出')
    .action((id: string, opts) => {
      try {
        const dbPath = resolveDbPath(opts.db);
        const { repo, clock, idGen, configLoader } = initInfra(dbPath);

        const caseRecord = repo.getCase(id);
        if (!caseRecord) {
          writeErrorLine(`Case not found: ${id}`);
          repo.close();
          process.exit(1);
        }

        const scenarioSnapshot = JSON.parse(caseRecord.scenario_snapshot as string);
        const scenarioPath = resolveScenarioPath(scenarioSnapshot.scenario?.id ?? 'songwriting');
        let scenarioConfig;
        try {
          scenarioConfig = configLoader.loadScenario(scenarioPath);
        } catch {
          scenarioConfig = scenarioSnapshot;
        }

        // 构造一个轻量 runner 只为调 buildResultJson
        const fakePi = new FakePiAdapter();
        fakePi.registerScript(scenarioConfig.scenario?.id ?? 'unknown', { turns: [] });

        const runner = new CaseRunner({
          repo, clock, idGen, pi: fakePi,
          scenarioConfig,
          scenarioPath,
          configLoader,
          toolDefinitions: TOOL_DEFINITIONS,
          logger: stderrLogger,
        });

        const result = runner.buildResultJson(id);

        if (opts.human) {
          process.stdout.write(`Case: ${result.case_id}\n`);
          process.stdout.write(`状态: ${result.status}\n`);
          process.stdout.write(`成功: ${result.success ? '是' : '否'}\n`);
          process.stdout.write(`Turns: ${result.turns.count}\n`);
          if (result.final_artifact) {
            process.stdout.write(`最终产物: v${result.final_artifact.version} (${result.final_artifact.status})\n`);
          }
          if (result.issues.length > 0) {
            process.stdout.write(`Issues: ${result.issues.length}\n`);
          }
          if (result.gate) {
            process.stdout.write(`门禁: ${result.gate.status}\n`);
          }
        } else {
          writeStdoutLine(result);
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });

  // forge case list
  caseCmd
    .command('list')
    .description('列出所有 Case')
    .option('--db <path>', '数据库路径')
    .option('--human', '人类可读格式输出')
    .action((opts) => {
      try {
        const dbPath = resolveDbPath(opts.db);
        const { repo } = initInfra(dbPath);

        const allCases: Record<string, unknown>[] = [];
        for (const status of ALL_STATUSES) {
          allCases.push(...repo.getCasesByStatus(status));
        }

        const summaries = allCases.map((c) => ({
          case_id: c.case_id,
          title: c.title,
          status: c.status,
          created_at: c.created_at,
        }));

        if (opts.human) {
          if (summaries.length === 0) {
            process.stdout.write('没有 Case。\n');
          } else {
            process.stdout.write(`${'ID'.padEnd(28)} ${'状态'.padEnd(16)} ${'标题'}\n`);
            process.stdout.write('-'.repeat(70) + '\n');
            for (const s of summaries) {
              process.stdout.write(`${String(s.case_id).padEnd(28)} ${String(s.status).padEnd(16)} ${s.title}\n`);
            }
          }
        } else {
          writeStdoutLine(summaries);
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });

  // forge case resume <id>
  caseCmd
    .command('resume <id>')
    .description('人工输入后续跑 Case')
    .requiredOption('--answer <text>', '人工回答')
    .option('--db <path>', '数据库路径')
    .option('--mode <mode>', 'Pi 模式 (fake|real)')
    .option('--human', '人类可读格式输出')
    .action(async (id: string, opts) => {
      const dbPath = resolveDbPath(opts.db);
      const mode = resolveMode(opts.mode);
      const logPath = resolveFromRoot('data', `case-${id}.log`);
      const logger = createFileLogger(logPath);

      try {
        const { repo, clock, idGen, configLoader } = initInfra(dbPath);

        const caseRecord = repo.getCase(id);
        if (!caseRecord) {
          writeErrorLine(`Case not found: ${id}`);
          repo.close();
          process.exit(1);
        }

        const scenarioSnapshot = JSON.parse(caseRecord.scenario_snapshot as string);
        const scenarioPath = resolveScenarioPath(scenarioSnapshot.scenario?.id ?? 'songwriting');
        let scenarioConfig;
        try {
          scenarioConfig = configLoader.loadScenario(scenarioPath);
        } catch {
          scenarioConfig = scenarioSnapshot;
        }

        const pi = createPiAdapter(mode, scenarioPath, scenarioConfig, logger);

        const runner = new CaseRunner({
          repo, clock, idGen, pi,
          scenarioConfig,
          scenarioPath,
          configLoader,
          toolDefinitions: TOOL_DEFINITIONS,
          logger,
        });

        runner.assertNoConcurrentCase(id); // 先检查并发
        writeFirstLine(id);                // 通过后才写第一行
        const result = await runner.resumeCaseWithHumanInput(id, opts.answer);
        writeResultLine(result);
        repo.close();
      } catch (e) {
        if (e instanceof ConcurrentCaseError) {
          writeErrorLine(e.message, e.runningCaseId);
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          writeErrorLine(msg);
        }
        process.exit(1);
      }
    });

  // forge case stop <id>
  caseCmd
    .command('stop <id>')
    .description('停止 Case')
    .option('--db <path>', '数据库路径')
    .option('--human', '人类可读格式输出')
    .action((id: string, opts) => {
      try {
        const dbPath = resolveDbPath(opts.db);
        const { repo, clock } = initInfra(dbPath);

        const caseRecord = repo.getCase(id);
        if (!caseRecord) {
          writeErrorLine(`Case not found: ${id}`);
          repo.close();
          process.exit(1);
        }

        const status = caseRecord.status as string;
        const terminalStatuses = ['approved', 'failed', 'stopped'];
        if (terminalStatuses.includes(status)) {
          writeErrorLine(`Case already in terminal state: ${status}`);
          repo.close();
          process.exit(1);
        }
        if (status === 'running') {
          writeErrorLine(`Cannot stop a running case. Wait for it to finish or crash.`);
          repo.close();
          process.exit(1);
        }

        repo.updateCase(id, { status: 'stopped', updated_at: clock.now(), completed_at: clock.now() });

        if (opts.human) {
          process.stdout.write(`Case ${id} 已停止。\n`);
        } else {
          writeStdoutLine({ case_id: id, status: 'stopped' });
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });
}
