import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import type { ScenarioConfig } from '@forge-ai/contracts';

const IGNORED_DIRECTORIES = new Set(['__pycache__', '.pytest_cache']);

function isIgnoredFile(name: string): boolean {
  return name === '.DS_Store'
    || name.endsWith('.pyc')
    || name.endsWith('.pyo')
    || name.endsWith('.tmp')
    || name.endsWith('~');
}

function assertInside(root: string, target: string, description: string): void {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${description} must be inside the scenario directory`);
  }
}

/**
 * Hashes the source bundle actually selected by a ScenarioConfig.
 * Runtime fixtures, sample input, and generated caches are deliberately excluded.
 */
export function computeScenarioBundleSha256(
  scenarioPath: string,
  scenarioConfig: ScenarioConfig,
): string {
  const root = realpathSync(dirname(resolve(scenarioPath)));
  const entries = new Map<string, Buffer>();

  const addFile = (path: string, description: string): void => {
    const realPath = realpathSync(path);
    assertInside(root, realPath, description);
    if (!lstatSync(realPath).isFile()) {
      throw new Error(`${description} is not a file`);
    }
    entries.set(relative(root, realPath).replaceAll('\\', '/'), readFileSync(realPath));
  };

  const addConfiguredFile = (configuredPath: string, description: string): void => {
    if (isAbsolute(configuredPath)) {
      throw new Error(`${description} must be relative to the scenario directory`);
    }
    addFile(resolve(root, configuredPath), description);
  };

  const visitDirectory = (directory: string, description: string): void => {
    const realDirectory = realpathSync(directory);
    assertInside(root, realDirectory, description);
    if (!lstatSync(realDirectory).isDirectory()) {
      throw new Error(`${description} is not a directory`);
    }
    for (const name of readdirSync(realDirectory).sort()) {
      if (IGNORED_DIRECTORIES.has(name) || isIgnoredFile(name)) continue;
      const target = resolve(realDirectory, name);
      const stat = lstatSync(target);
      if (stat.isDirectory()) {
        visitDirectory(target, description);
      } else if (stat.isFile()) {
        addFile(target, description);
      }
    }
  };

  addFile(resolve(scenarioPath), 'Scenario file');
  for (const agent of scenarioConfig.agents) {
    addConfiguredFile(agent.prompt, `Prompt for agent ${agent.key}`);
    for (const skill of agent.skills) {
      if (isAbsolute(skill)) {
        throw new Error(`Skill ${skill} must be relative to the scenario directory`);
      }
      visitDirectory(resolve(root, 'skills', skill), `Skill ${skill}`);
    }
  }
  for (const validator of scenarioConfig.delivery.validators ?? []) {
    addConfiguredFile(validator.entrypoint, `Validator ${validator.id}`);
  }

  const hash = createHash('sha256');
  for (const [path, content] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
