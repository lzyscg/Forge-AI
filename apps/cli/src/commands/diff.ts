/**
 * forge diff <case_id> — 版本 diff（含 editable/frozen/violation）
 */
import { Command } from 'commander';
import { writeStdoutLine, writeErrorLine } from '../output.js';
import { resolveReadDbPaths, findCaseInfra } from '../setup.js';

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <case_id>')
    .description('查看产物版本 diff')
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

        const scenarioSnapshot = JSON.parse(caseRecord.scenario_snapshot as string);
        const deliverableType = scenarioSnapshot.delivery?.deliverable_artifact_type;
        if (!deliverableType) {
          writeErrorLine('No deliverable artifact type configured');
          repo.close();
          process.exit(1);
        }

        const artifact = repo.getArtifactByTypeAndCase(caseId, deliverableType);
        if (!artifact) {
          writeErrorLine(`No artifact found for case ${caseId}`);
          repo.close();
          process.exit(1);
        }

        const versions = repo.getVersionsByArtifact(artifact.artifact_id as string);
        if (versions.length < 2) {
          writeStdoutLine({
            case_id: caseId,
            message: 'Only one version available, no diff to show',
            from_version: versions[0]?.version ?? 0,
            to_version: versions[0]?.version ?? 0,
            changed: [],
            frozen: [],
            violations: [],
          });
          repo.close();
          return;
        }

        // 取最后两个版本做 diff
        const sorted = [...versions].sort((a, b) => (a.version as number) - (b.version as number));
        const prev = sorted[sorted.length - 2];
        const curr = sorted[sorted.length - 1];

        const prevLines = (prev.content as string).split('\n');
        const currLines = (curr.content as string).split('\n');

        // 简单行 diff：找出变化的行号
        const changed: number[] = [];
        const maxLen = Math.max(prevLines.length, currLines.length);
        for (let i = 0; i < maxLen; i++) {
          if (prevLines[i] !== currLines[i]) {
            changed.push(i + 1); // 1-based
          }
        }

        // 从 revision instructions 获取 frozen anchors
        const revisions = repo.getActiveRevisionInstructions(caseId);
        const frozen: number[] = [];
        const violations: string[] = [];

        for (const rev of revisions) {
          try {
            const scope = JSON.parse(rev.scope as string);
            if (scope.frozen_anchors) {
              for (const anchor of scope.frozen_anchors) {
                // anchor 格式: "line:N"
                const match = String(anchor).match(/line:(\d+)/);
                if (match) {
                  const lineNum = parseInt(match[1], 10);
                  frozen.push(lineNum);
                  // 检查违规：frozen 行是否被修改
                  if (changed.includes(lineNum)) {
                    violations.push(`Frozen line ${lineNum} was modified`);
                  }
                }
              }
            }
          } catch { /* skip parse errors */ }
        }

        const diffResult = {
          case_id: caseId,
          from_version: prev.version,
          to_version: curr.version,
          changed,
          frozen,
          violations,
        };

        if (opts.human) {
          process.stdout.write(`Diff: v${prev.version} → v${curr.version}\n`);
          process.stdout.write(`变更行: ${changed.length > 0 ? changed.join(', ') : '无'}\n`);
          process.stdout.write(`冻结行: ${frozen.length > 0 ? frozen.join(', ') : '无'}\n`);
          if (violations.length > 0) {
            process.stdout.write(`违规:\n`);
            for (const v of violations) {
              process.stdout.write(`  ⚠ ${v}\n`);
            }
          } else {
            process.stdout.write(`违规: 无\n`);
          }
        } else {
          writeStdoutLine(diffResult);
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });
}
