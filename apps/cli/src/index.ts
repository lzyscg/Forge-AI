/**
 * Forge AI CLI 入口
 * 用法: node apps/cli/bin.js <command> [options]
 */
import { Command } from 'commander';
import { registerTemplateCommand } from './commands/template.js';
import { registerCaseCommand } from './commands/case.js';
import { registerArtifactCommand } from './commands/artifact.js';
import { registerDiffCommand } from './commands/diff.js';
import { registerGateCommand } from './commands/gate.js';

const program = new Command();

program
  .name('forge')
  .description('Forge AI — 多 Agent 协作生产平台 CLI')
  .version('0.1.0');

registerTemplateCommand(program);
registerCaseCommand(program);
registerArtifactCommand(program);
registerDiffCommand(program);
registerGateCommand(program);

program.parse(process.argv);
