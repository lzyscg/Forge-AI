import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import type { ScenarioConfig } from '@forge-ai/contracts';

const IGNORED_DIRECTORIES = new Set(['__pycache__', '.pytest_cache']);

export interface ScenarioBundleFileSystem {
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  readFileSync(path: string): Buffer;
  realpathSync(path: string): string;
}

const NODE_FILE_SYSTEM: ScenarioBundleFileSystem = {
  lstatSync,
  readdirSync: (path) => readdirSync(path),
  readFileSync: (path) => readFileSync(path),
  realpathSync: (path) => realpathSync(path),
};

function isIgnoredFile(name: string): boolean {
  return name === '.DS_Store'
    || name.endsWith('.pyc')
    || name.endsWith('.pyo')
    || name.endsWith('.tmp')
    || name.endsWith('~');
}

function assertInside(
  root: string,
  target: string,
  description: string,
  allowRoot = false,
): void {
  const rel = relative(root, target);
  if ((!allowRoot && rel === '') || rel.startsWith('..') || isAbsolute(rel)) {
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
  fileSystem: ScenarioBundleFileSystem = NODE_FILE_SYSTEM,
): string {
  const requestedRoot = dirname(resolve(scenarioPath));
  if (fileSystem.lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error('Scenario bundle cannot contain a symbolic link (scenario directory)');
  }
  const root = fileSystem.realpathSync(requestedRoot);
  const entries = new Map<string, Buffer>();

  const lstatWithoutSymlink = (path: string, description: string) => {
    const stat = fileSystem.lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Scenario bundle cannot contain a symbolic link (${description})`);
    }
    return stat;
  };

  const assertPathHasNoSymlink = (path: string, description: string): void => {
    assertInside(root, path, description, true);
    const rel = relative(root, path);
    let current = root;
    for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
      current = resolve(current, segment);
      lstatWithoutSymlink(current, description);
    }
  };

  const addFile = (path: string, description: string): void => {
    assertPathHasNoSymlink(path, description);
    const stat = lstatWithoutSymlink(path, description);
    if (!stat.isFile()) {
      throw new Error(`${description} is not a file`);
    }
    const realPath = fileSystem.realpathSync(path);
    assertInside(root, realPath, description);
    entries.set(
      relative(root, realPath).replaceAll('\\', '/'),
      fileSystem.readFileSync(realPath),
    );
  };

  const resolveConfiguredPath = (configuredPath: string, description: string): string => {
    if (isAbsolute(configuredPath)) {
      throw new Error(`${description} must be relative to the scenario directory`);
    }
    const target = resolve(root, configuredPath);
    assertInside(root, target, description);
    return target;
  };

  const addConfiguredFile = (configuredPath: string, description: string): string => {
    const target = resolveConfiguredPath(configuredPath, description);
    addFile(target, description);
    return target;
  };

  const visitDirectory = (directory: string, description: string): void => {
    assertPathHasNoSymlink(directory, description);
    const directoryStat = lstatWithoutSymlink(directory, description);
    if (!directoryStat.isDirectory()) {
      throw new Error(`${description} is not a directory`);
    }
    const realDirectory = fileSystem.realpathSync(directory);
    assertInside(root, realDirectory, description, true);
    for (const name of fileSystem.readdirSync(realDirectory).sort()) {
      const target = resolve(realDirectory, name);
      const stat = lstatWithoutSymlink(target, description);
      if (IGNORED_DIRECTORIES.has(name) || isIgnoredFile(name)) continue;
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
    const entrypoint = addConfiguredFile(
      validator.entrypoint,
      `Validator ${validator.id}`,
    );
    visitDirectory(dirname(entrypoint), `Validator ${validator.id} bundle`);
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
