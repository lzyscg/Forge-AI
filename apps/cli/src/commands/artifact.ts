/**
 * forge artifact get <case_id> [--version N]
 */
import { Command } from 'commander';
import { writeStdoutLine, writeErrorLine } from '../output.js';
import { resolveReadDbPaths, findCaseInfra } from '../setup.js';
import { stderrLogger } from '../logger.js';

export function registerArtifactCommand(program: Command): void {
  program
    .command('artifact')
    .description('产物管理')
    .command('get <case_id>')
    .description('获取产物内容')
    .option('--version <n>', '指定版本号')
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
          writeErrorLine(`No artifact found for case ${caseId} type ${deliverableType}`);
          repo.close();
          process.exit(1);
        }

        let versionRecord: Record<string, unknown> | null;
        if (opts.version) {
          const versions = repo.getVersionsByArtifact(artifact.artifact_id as string);
          versionRecord = versions.find((v) => v.version === parseInt(opts.version, 10)) ?? null;
        } else {
          versionRecord = repo.getLatestVersion(artifact.artifact_id as string);
        }

        if (!versionRecord) {
          writeErrorLine(`Version not found`);
          repo.close();
          process.exit(1);
        }

        if (opts.human) {
          process.stdout.write(`产物类型: ${deliverableType}\n`);
          process.stdout.write(`版本: v${versionRecord.version}\n`);
          process.stdout.write(`状态: ${versionRecord.status}\n`);
          process.stdout.write(`---\n`);
          process.stdout.write(`${versionRecord.content}\n`);
        } else {
          writeStdoutLine({
            case_id: caseId,
            artifact_id: artifact.artifact_id,
            type: deliverableType,
            version: versionRecord.version,
            status: versionRecord.status,
            content: versionRecord.content,
          });
        }
        repo.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        writeErrorLine(msg);
        process.exit(1);
      }
    });
}
