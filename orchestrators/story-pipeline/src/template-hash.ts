import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { TemplateIdentity } from './manifest.js';
import { sha256 } from './quality.js';

const IGNORED_DIRECTORIES = new Set(['__pycache__', '.pytest_cache']);

function ignoredFile(name: string): boolean {
  return name === '.DS_Store'
    || name.endsWith('.pyc')
    || name.endsWith('.pyo')
    || name.endsWith('.tmp')
    || name.endsWith('~');
}

export function hashTemplateDirectory(path: string): string {
  const entries: Array<{ path: string; content: Buffer }> = [];
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (IGNORED_DIRECTORIES.has(name) || ignoredFile(name)) continue;
      const target = join(current, name);
      const stat = statSync(target);
      if (stat.isDirectory()) {
        visit(target);
      } else if (stat.isFile()) {
        entries.push({
          path: relative(path, target).replaceAll('\\', '/'),
          content: readFileSync(target),
        });
      }
    }
  };
  visit(path);
  return sha256(Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.path}\0`, 'utf8'),
    entry.content,
    Buffer.from('\0', 'utf8'),
  ])));
}

export function identifyTemplateDirectory(path: string): TemplateIdentity {
  return {
    algorithm: 'source-tree-sha256-v2',
    content_sha256: hashTemplateDirectory(path),
    equivalence: 'verified',
  };
}

export type TemplateIdentityComparison =
  | 'equal'
  | 'content_changed'
  | 'migration_required';

export function compareTemplateIdentity(
  left: TemplateIdentity,
  right: TemplateIdentity,
): TemplateIdentityComparison {
  if (left.algorithm !== right.algorithm) return 'migration_required';
  return left.content_sha256 === right.content_sha256 ? 'equal' : 'content_changed';
}
