/**
 * forge gate <case_id> — 门禁逐项结果
 */
import { Command } from 'commander';
import { writeStdoutLine, writeErrorLine } from '../output.js';
import { resolveReadDbPaths, findCaseInfra } from '../setup.js';
import type { GateCheckResult } from '@forge-ai/contracts';

export function registerGateCommand(program: Command): void {
  program
    .command('gate <case_id>')
    .description('查看交付门禁结果')
    .option('--db <path>', '数据库路径（显式覆盖，优先级最高）')
    .option('--env <production|test|all>', '数据库环境（all 时在两库中查找）')
    .option('--human', '人类可读格式输出')
    .action((caseId: string, opts) => {
      try {
        const dbPaths = resolveReadDbPaths(opts.db, opts.env);
        const found = findCaseInfra(dbPaths, caseId);
        if (!found) {
          writeErrorLine(`Case not found: ${caseId}`);
          process.exit(1);
        }
        const { repo } = found;

        const caseRecord = repo.getCase(caseId);
        if (!caseRecord) {
          writeErrorLine(`Case not found: ${caseId}`);
          repo.close();
          process.exit(1);
        }

        const gateResults = repo.getDeliveryGateResults(caseId);
        if (gateResults.length === 0) {
          if (opts.human) {
            process.stdout.write(`Case ${caseId} 尚无门禁记录。\n`);
          } else {
            writeStdoutLine({ case_id: caseId, gate: null, message: 'No gate results yet' });
          }
          repo.close();
          return;
        }

        const lastGate = gateResults[gateResults.length - 1];
        let checks: { name: string; passed: boolean }[] = [];
        try {
          const parsed: GateCheckResult[] = JSON.parse(lastGate.checks as string);
          checks = parsed.map((c) => ({ name: c.check, passed: c.passed }));
        } catch { /* empty */ }

        const gateOutput = {
          case_id: caseId,
          gate_status: lastGate.status,
          checks,
          created_at: lastGate.created_at,
        };

        if (opts.human) {
          const statusIcon = lastGate.status === 'pass' ? '✓' : '✗';
          process.stdout.write(`门禁结果: ${statusIcon} ${lastGate.status}\n`);
          process.stdout.write(`检查项:\n`);
          for (const c of checks) {
            const icon = c.passed ? '  ✓' : '  ✗';
            process.stdout.write(`${icon} ${c.name}\n`);
          }
        } else {
          writeStdoutLine(gateOutput);
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });
}
