import Database from 'better-sqlite3';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioConfig } from '@forge-ai/contracts';
import {
  computeScenarioBundleSha256,
  SqliteRepository,
} from '@forge-ai/adapters';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fileSystemTreatingAsSymlink(targetPath: string) {
  const normalizedTarget = realpathSync(targetPath);
  return {
    lstatSync(path: string) {
      const stat = lstatSync(path);
      if (realpathSync(path) !== normalizedTarget) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === 'isSymbolicLink') return () => true;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    readdirSync,
    readFileSync,
    realpathSync,
  };
}

describe('scenario bundle identity', () => {
  it('tracks scenario, prompt, skill, and validator sources but ignores runtime files', () => {
    const root = temporaryRoot('forge-scenario-bundle-');
    mkdirSync(join(root, 'prompts'));
    mkdirSync(join(root, 'skills', 'writer', 'scripts'), { recursive: true });
    mkdirSync(join(root, 'validators'));
    writeFileSync(join(root, 'scenario.yaml'), 'scenario: identity\n', 'utf8');
    writeFileSync(join(root, 'prompts', 'writer.md'), 'prompt v1\n', 'utf8');
    writeFileSync(join(root, 'skills', 'writer', 'SKILL.md'), 'skill v1\n', 'utf8');
    writeFileSync(join(root, 'skills', 'writer', 'scripts', 'validate.py'), 'print("v1")\n', 'utf8');
    writeFileSync(join(root, 'validators', 'surface.py'), 'print("surface v1")\n', 'utf8');
    writeFileSync(join(root, 'validators', 'helper.py'), 'VALUE = "v1"\n', 'utf8');
    const config = {
      scenario: { id: 'identity', name: 'Identity', version: 1 },
      input_fields: [],
      agents: [{
        key: 'writer',
        name: 'Writer',
        model: 'test',
        session: { policy: 'persistent' },
        prompt: 'prompts/writer.md',
        skills: ['writer'],
        tools: [],
      }],
      start_agent: 'writer',
      routes: [],
      context_rules: {},
      artifact_types: [{ type: 'draft', diff: 'line' }],
      delivery: {
        deliverable_artifact_type: 'draft',
        validators: [{
          id: 'surface',
          command: 'python',
          entrypoint: 'validators/surface.py',
        }],
      },
    } satisfies ScenarioConfig;
    const scenarioPath = join(root, 'scenario.yaml');
    const original = computeScenarioBundleSha256(scenarioPath, config);

    writeFileSync(join(root, 'input.example.json'), '{"runtime":true}', 'utf8');
    mkdirSync(join(root, 'skills', 'writer', '__pycache__'));
    writeFileSync(
      join(root, 'skills', 'writer', '__pycache__', 'validate.pyc'),
      'generated',
      'utf8',
    );
    mkdirSync(join(root, 'validators', '__pycache__'));
    writeFileSync(
      join(root, 'validators', '__pycache__', 'helper.pyc'),
      'generated validator cache',
      'utf8',
    );
    expect(computeScenarioBundleSha256(scenarioPath, config)).toBe(original);

    writeFileSync(join(root, 'prompts', 'writer.md'), 'prompt v2\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);

    writeFileSync(join(root, 'prompts', 'writer.md'), 'prompt v1\n', 'utf8');
    writeFileSync(join(root, 'skills', 'writer', 'SKILL.md'), 'skill v2\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);

    writeFileSync(join(root, 'skills', 'writer', 'SKILL.md'), 'skill v1\n', 'utf8');
    writeFileSync(join(root, 'validators', 'surface.py'), 'print("surface v2")\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);

    writeFileSync(join(root, 'validators', 'surface.py'), 'print("surface v1")\n', 'utf8');
    writeFileSync(join(root, 'validators', 'helper.py'), 'VALUE = "v2"\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);

    writeFileSync(join(root, 'validators', 'helper.py'), 'VALUE = "v1"\n', 'utf8');
    writeFileSync(join(root, 'scenario.yaml'), 'scenario: changed\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);
  });

  it.each([
    { kind: 'file', relativeTarget: ['linked-source.md'] },
    { kind: 'directory', relativeTarget: ['linked-directory'] },
  ])('rejects a symbolic link $kind in a skill bundle', ({ kind, relativeTarget }) => {
    const root = temporaryRoot(`forge-scenario-symlink-${kind}-`);
    mkdirSync(join(root, 'prompts'));
    const skillRoot = join(root, 'skills', 'writer');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(root, 'scenario.yaml'), 'scenario: identity\n', 'utf8');
    writeFileSync(join(root, 'prompts', 'writer.md'), 'prompt\n', 'utf8');
    writeFileSync(join(skillRoot, 'SKILL.md'), 'skill\n', 'utf8');
    const target = join(skillRoot, ...relativeTarget);
    if (kind === 'directory') {
      mkdirSync(target);
      writeFileSync(join(target, 'secret.txt'), 'sensitive-content\n', 'utf8');
    } else {
      writeFileSync(target, 'sensitive-content\n', 'utf8');
    }
    const config = {
      scenario: { id: 'identity', name: 'Identity', version: 1 },
      input_fields: [],
      agents: [{
        key: 'writer',
        name: 'Writer',
        model: 'test',
        session: { policy: 'persistent' },
        prompt: 'prompts/writer.md',
        skills: ['writer'],
        tools: [],
      }],
      start_agent: 'writer',
      routes: [],
      context_rules: {},
      artifact_types: [{ type: 'draft', diff: 'line' }],
      delivery: { deliverable_artifact_type: 'draft' },
    } satisfies ScenarioConfig;

    let message = '';
    try {
      computeScenarioBundleSha256(
        join(root, 'scenario.yaml'),
        config,
        fileSystemTreatingAsSymlink(target),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/symbolic link/i);
    expect(message).not.toContain(root);
    expect(message).not.toContain('sensitive-content');
  });

  it('rejects a symbolic link directory in a configured prompt path', () => {
    const root = temporaryRoot('forge-scenario-prompt-symlink-');
    const promptDirectory = join(root, 'prompts');
    mkdirSync(promptDirectory);
    writeFileSync(join(root, 'scenario.yaml'), 'scenario: identity\n', 'utf8');
    writeFileSync(join(promptDirectory, 'writer.md'), 'prompt\n', 'utf8');
    const config = {
      scenario: { id: 'identity', name: 'Identity', version: 1 },
      input_fields: [],
      agents: [{
        key: 'writer',
        name: 'Writer',
        model: 'test',
        session: { policy: 'persistent' },
        prompt: 'prompts/writer.md',
        skills: [],
        tools: [],
      }],
      start_agent: 'writer',
      routes: [],
      context_rules: {},
      artifact_types: [{ type: 'draft', diff: 'line' }],
      delivery: { deliverable_artifact_type: 'draft' },
    } satisfies ScenarioConfig;

    expect(() => computeScenarioBundleSha256(
      join(root, 'scenario.yaml'),
      config,
      fileSystemTreatingAsSymlink(promptDirectory),
    )).toThrow(/symbolic link/i);
  });

  it('excludes root runtime fixtures while tracking root validator helper and data files', () => {
    const root = temporaryRoot('forge-root-validator-bundle-');
    const scenarioPath = join(root, 'scenario.yaml');
    writeFileSync(scenarioPath, 'scenario: identity\n', 'utf8');
    writeFileSync(join(root, 'validator.py'), 'from helper import VALUE\n', 'utf8');
    writeFileSync(join(root, 'helper.py'), 'VALUE = "v1"\n', 'utf8');
    writeFileSync(join(root, 'rules.json'), '{"minimum":1}\n', 'utf8');
    writeFileSync(join(root, 'input.example.json'), '{"sample":"v1"}\n', 'utf8');
    writeFileSync(join(root, 'fake-pi-script.json'), '{"turns":[]}\n', 'utf8');
    const config = {
      scenario: { id: 'identity', name: 'Identity', version: 1 },
      input_fields: [],
      agents: [],
      start_agent: 'validator',
      routes: [],
      context_rules: {},
      artifact_types: [{ type: 'draft', diff: 'line' }],
      delivery: {
        deliverable_artifact_type: 'draft',
        validators: [{
          id: 'surface',
          command: 'python',
          entrypoint: 'validator.py',
        }],
      },
    } satisfies ScenarioConfig;
    const original = computeScenarioBundleSha256(scenarioPath, config);

    writeFileSync(join(root, 'input.example.json'), '{"sample":"v2"}\n', 'utf8');
    writeFileSync(join(root, 'fake-pi-script.json'), '{"turns":[{"runtime":true}]}\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).toBe(original);

    writeFileSync(join(root, 'helper.py'), 'VALUE = "v2"\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);

    writeFileSync(join(root, 'helper.py'), 'VALUE = "v1"\n', 'utf8');
    writeFileSync(join(root, 'rules.json'), '{"minimum":2}\n', 'utf8');
    expect(computeScenarioBundleSha256(scenarioPath, config)).not.toBe(original);
  });
});

describe('SQLite identity migration', () => {
  it('migrates an old database in place without inventing identities for legacy rows', () => {
    const root = temporaryRoot('forge-identity-migration-');
    const dbPath = join(root, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE cases (
        case_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        scenario_snapshot TEXT NOT NULL,
        input_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE artifact_versions (
        artifact_version_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        source_message_id TEXT,
        source_turn_id TEXT,
        parent_version_id TEXT,
        diff TEXT,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE delivery_gate_results (
        gate_result_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        artifact_version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        checks TEXT NOT NULL,
        blocking_issue_ids TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO cases VALUES (
        'legacy-case', 'legacy', 'created', 'init', '{}', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
    `);
    legacy.close();

    const firstOpen = new SqliteRepository(dbPath);
    let dbInstanceId: string;
    try {
      const migrated = firstOpen.getCase('legacy-case')!;
      expect(migrated.scenario_snapshot_sha256).toBeNull();
      expect(migrated.input_payload_sha256).toBeNull();
      expect(migrated.run_id).toBeNull();
      dbInstanceId = firstOpen.getDbInstanceId();
      expect(dbInstanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(dbInstanceId).not.toContain(root);
    } finally {
      firstOpen.close();
    }

    const secondOpen = new SqliteRepository(dbPath);
    try {
      expect(secondOpen.getDbInstanceId()).toBe(dbInstanceId!);
    } finally {
      secondOpen.close();
    }
  });
});
