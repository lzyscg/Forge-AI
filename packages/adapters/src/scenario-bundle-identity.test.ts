import Database from 'better-sqlite3';
import {
  mkdtempSync,
  mkdirSync,
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
    writeFileSync(join(root, 'scenario.yaml'), 'scenario: changed\n', 'utf8');
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
