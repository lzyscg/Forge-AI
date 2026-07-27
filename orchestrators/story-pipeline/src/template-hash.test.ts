import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareTemplateIdentity,
  hashTemplateDirectory,
  identifyTemplateDirectory,
} from './template-hash.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hashTemplateDirectory', () => {
  it('ignores Python bytecode caches but changes for source edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-template-hash-'));
    roots.push(root);
    writeFileSync(join(root, 'scenario.yaml'), 'version: 1\n', 'utf8');
    writeFileSync(join(root, 'validator.py'), 'print("v1")\n', 'utf8');
    const sourceHash = hashTemplateDirectory(root);

    mkdirSync(join(root, '__pycache__'));
    writeFileSync(join(root, '__pycache__', 'validator.cpython-314.pyc'), 'generated', 'utf8');
    expect(hashTemplateDirectory(root)).toBe(sourceHash);

    writeFileSync(join(root, 'validator.py'), 'print("v2")\n', 'utf8');
    expect(hashTemplateDirectory(root)).not.toBe(sourceHash);
  });
});

describe('template identity', () => {
  it('requires migration instead of treating different algorithms as content changes', () => {
    expect(compareTemplateIdentity(
      {
        algorithm: 'legacy-unversioned-v1',
        content_sha256: 'same-bytes',
        equivalence: 'unknown',
      },
      {
        algorithm: 'source-tree-sha256-v2',
        content_sha256: 'same-bytes',
        equivalence: 'verified',
      },
    )).toBe('migration_required');
  });

  it('fails closed when either same-algorithm identity has unknown equivalence', () => {
    expect(compareTemplateIdentity(
      {
        algorithm: 'source-tree-sha256-v2',
        content_sha256: 'same-bytes',
        equivalence: 'unknown',
      },
      {
        algorithm: 'source-tree-sha256-v2',
        content_sha256: 'same-bytes',
        equivalence: 'verified',
      },
    )).toBe('migration_required');
  });

  it('identifies source trees with the versioned algorithm while still ignoring runtime files', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-template-identity-'));
    roots.push(root);
    writeFileSync(join(root, 'scenario.yaml'), 'version: 1\n', 'utf8');
    const beforeRuntimeFile = identifyTemplateDirectory(root);

    mkdirSync(join(root, '__pycache__'));
    writeFileSync(join(root, '__pycache__', 'validator.pyc'), 'runtime-only', 'utf8');

    expect(identifyTemplateDirectory(root)).toEqual(beforeRuntimeFile);
    expect(beforeRuntimeFile).toEqual({
      algorithm: 'source-tree-sha256-v2',
      content_sha256: hashTemplateDirectory(root),
      equivalence: 'verified',
    });
  });
});
