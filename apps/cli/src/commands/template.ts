/**
 * forge template list / show / validate
 */
import { Command } from 'commander';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveFromRoot } from '@forge-ai/adapters';
import { validateScenario } from '@forge-ai/contracts';
import { writeStdoutLine } from '../output.js';

export function registerTemplateCommand(program: Command): void {
  const template = program.command('template').description('场景模板管理');

  // forge template list
  template
    .command('list')
    .description('列出所有可用场景模板')
    .option('--human', '人类可读格式输出')
    .action((opts) => {
      const scenariosDir = resolveFromRoot('scenarios');
      const results: { name: string; path: string }[] = [];

      if (existsSync(scenariosDir)) {
        const entries = readdirSync(scenariosDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const yamlPath = join(scenariosDir, entry.name, 'scenario.yaml');
            if (existsSync(yamlPath)) {
              results.push({ name: entry.name, path: `scenarios/${entry.name}/scenario.yaml` });
            }
          }
        }
      }

      if (opts.human) {
        if (results.length === 0) {
          process.stdout.write('没有找到场景模板。\n');
        } else {
          process.stdout.write('可用场景模板：\n');
          for (const r of results) {
            process.stdout.write(`  ${r.name}  (${r.path})\n`);
          }
        }
      } else {
        writeStdoutLine(results);
      }
    });

  // forge template show <name>
  template
    .command('show <name>')
    .description('显示场景模板详情')
    .option('--human', '人类可读格式输出')
    .action((name: string, opts) => {
      const yamlPath = resolveFromRoot('scenarios', name, 'scenario.yaml');
      if (!existsSync(yamlPath)) {
        process.stderr.write(`[ERROR] 场景模板不存在: ${name} (${yamlPath})\n`);
        process.exit(1);
      }

      const content = readFileSync(yamlPath, 'utf-8');
      const config = parseYaml(content);

      if (opts.human) {
        const sc = config.scenario ?? {};
        process.stdout.write(`场景: ${sc.name ?? name} (id: ${sc.id ?? name}, v${sc.version ?? '?'})\n`);
        process.stdout.write(`起始 Agent: ${config.start_agent ?? '?'}\n`);
        process.stdout.write(`Agents:\n`);
        for (const agent of config.agents ?? []) {
          process.stdout.write(`  - ${agent.key} (${agent.name}) tools: [${(agent.tools ?? []).join(', ')}]\n`);
        }
        process.stdout.write(`产物类型: ${(config.artifact_types ?? []).map((a: any) => a.type).join(', ')}\n`);
        process.stdout.write(`输入字段: ${(config.input_fields ?? []).map((f: any) => f.key).join(', ')}\n`);
      } else {
        writeStdoutLine(config);
      }
    });

  // forge template validate <yaml>
  template
    .command('validate <yaml>')
    .description('校验场景 YAML 配置')
    .option('--human', '人类可读格式输出')
    .action((yamlPath: string, opts) => {
      const resolvedPath = resolve(yamlPath);
      if (!existsSync(resolvedPath)) {
        process.stderr.write(`[ERROR] 文件不存在: ${resolvedPath}\n`);
        process.exit(1);
      }

      try {
        const content = readFileSync(resolvedPath, 'utf-8');
        const parsed = parseYaml(content);
        const config = validateScenario(parsed);

        // 检查引用的 prompt 文件是否存在
        const missingFiles: string[] = [];
        const scenarioDir = resolve(resolvedPath, '..');
        for (const agent of config.agents) {
          const promptPath = join(scenarioDir, agent.prompt);
          if (!existsSync(promptPath)) {
            missingFiles.push(agent.prompt);
          }
        }
        // 检查 fake-pi-script.json
        const scriptPath = join(scenarioDir, 'fake-pi-script.json');
        if (!existsSync(scriptPath)) {
          missingFiles.push('fake-pi-script.json (可选)');
        }

        if (opts.human) {
          process.stdout.write(`✓ 场景配置校验通过: ${config.scenario.name}\n`);
          if (missingFiles.length > 0) {
            process.stdout.write(`⚠ 缺失文件:\n`);
            for (const f of missingFiles) {
              process.stdout.write(`  - ${f}\n`);
            }
          }
        } else {
          writeStdoutLine({ valid: true, scenario: config.scenario, missing_files: missingFiles });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (opts.human) {
          process.stdout.write(`✗ 校验失败:\n${msg}\n`);
        } else {
          writeStdoutLine({ valid: false, error: msg });
        }
        process.exit(1);
      }
    });
}
