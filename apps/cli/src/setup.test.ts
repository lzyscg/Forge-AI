/**
 * setup.ts 单测：CLI dbPath 解析优先级链 + findCaseInfra 聚合查找。
 * 覆盖 parseDbEnv / resolveReadDbPaths / resolveWriteDbPath（--db > --env > DB_PATH > default，
 * all 写操作抛错）+ findCaseInfra（跳过不存在库 / 命中返回 / 未命中返回 null 且关闭 repo）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDbEnv,
  resolveReadDbPaths,
  resolveWriteDbPath,
  findCaseInfra,
  initInfra,
} from './setup.js';
import { resolveSingleDbPath, defaultDbEnv } from '@forge-ai/adapters';

const ENV_KEYS = ['DB_PATH', 'FORGE_ENV', 'FORGE_DB_PRODUCTION', 'FORGE_DB_TEST'] as const;
const saved: Record<string, string | undefined> = {};
const tmpRoots: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

describe('parseDbEnv', () => {
  it('合法值原样返回', () => {
    expect(parseDbEnv('production')).toBe('production');
    expect(parseDbEnv('test')).toBe('test');
    expect(parseDbEnv('all')).toBe('all');
  });

  it('undefined 回退默认（FORGE_ENV=test -> test）', () => {
    expect(parseDbEnv(undefined)).toBe('production');
    process.env.FORGE_ENV = 'test';
    expect(parseDbEnv(undefined)).toBe('test');
  });

  it('非法值抛错', () => {
    expect(() => parseDbEnv('garbage')).toThrow(/无效的 --env/);
    expect(() => parseDbEnv('staging')).toThrow(/无效的 --env/);
  });
});

describe('resolveReadDbPaths 优先级链', () => {
  it('--db 优先级最高（覆盖 --env 与 DB_PATH）', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    const paths = resolveReadDbPaths('/explicit.db', 'test');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(resolve('/explicit.db'));
  });

  it('--env 次之（覆盖 DB_PATH）', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    const paths = resolveReadDbPaths(undefined, 'test');
    expect(paths).toEqual([resolveSingleDbPath('test')]);
  });

  it('DB_PATH 再次之', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    const paths = resolveReadDbPaths(undefined, undefined);
    expect(paths).toEqual([resolve('/tmp/from-db-path.db')]);
  });

  it('都未设 -> 默认 production 单库', () => {
    const paths = resolveReadDbPaths(undefined, undefined);
    expect(paths).toEqual([resolveSingleDbPath('production')]);
  });

  it('--env all 返回两个库（聚合）', () => {
    const paths = resolveReadDbPaths(undefined, 'all');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(resolveSingleDbPath('production'));
    expect(paths[1]).toBe(resolveSingleDbPath('test'));
  });

  it('DB_PATH 空字符串被忽略', () => {
    process.env.DB_PATH = '   ';
    const paths = resolveReadDbPaths(undefined, undefined);
    expect(paths).toEqual([resolveSingleDbPath(defaultDbEnv())]);
  });
});

describe('resolveWriteDbPath 优先级链', () => {
  it('--db 优先级最高', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    expect(resolveWriteDbPath('/explicit.db', 'test')).toBe(resolve('/explicit.db'));
  });

  it('--env 单库解析', () => {
    expect(resolveWriteDbPath(undefined, 'test')).toBe(resolveSingleDbPath('test'));
    expect(resolveWriteDbPath(undefined, 'production')).toBe(resolveSingleDbPath('production'));
  });

  it('--env all 抛错（写操作必须单库）', () => {
    expect(() => resolveWriteDbPath(undefined, 'all')).toThrow(/写操作必须指定单个库/);
  });

  it('--env all 即使有 DB_PATH 也抛错（--env 优先级高于 DB_PATH）', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    expect(() => resolveWriteDbPath(undefined, 'all')).toThrow(/写操作必须指定单个库/);
  });

  it('DB_PATH 回退', () => {
    process.env.DB_PATH = '/tmp/from-db-path.db';
    expect(resolveWriteDbPath(undefined, undefined)).toBe(resolve('/tmp/from-db-path.db'));
  });

  it('都未设 -> 默认 production', () => {
    expect(resolveWriteDbPath(undefined, undefined)).toBe(resolveSingleDbPath('production'));
  });

  it('FORGE_ENV=test 影响默认', () => {
    process.env.FORGE_ENV = 'test';
    expect(resolveWriteDbPath(undefined, undefined)).toBe(resolveSingleDbPath('test'));
  });
});

describe('findCaseInfra', () => {
  function seedCase(dbPath: string, caseId: string): void {
    const infra = initInfra(dbPath);
    infra.repo.insertCase({
      case_id: caseId,
      title: 'test case',
      status: 'created',
      current_stage: 'init',
      scenario_snapshot: '{}',
      input_payload: '{}',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      completed_at: null,
    });
    infra.repo.close();
  }

  it('跳过不存在的库文件（不创建空库），命中后续库', () => {
    const dir = tmpDir('forge-findcase-');
    const existingDb = join(dir, 'has-case.db');
    const caseId = 'case_hit_001';
    seedCase(existingDb, caseId);
    const nonExistent = join(dir, 'does-not-exist.db');
    expect(existsSync(nonExistent)).toBe(false);

    const found = findCaseInfra([nonExistent, existingDb], caseId);
    expect(found).not.toBeNull();
    expect(found!.dbPath).toBe(existingDb);
    expect(found!.repo.getCase(caseId)).not.toBeNull();
    expect(existsSync(nonExistent)).toBe(false); // 跳过的库未被创建
    found!.repo.close();
  });

  it('未命中返回 null（库存在但无该 case）', () => {
    const dir = tmpDir('forge-findcase-miss-');
    const dbWithoutCase = join(dir, 'no-case.db');
    initInfra(dbWithoutCase).repo.close(); // 创建空库（无 case）

    const found = findCaseInfra([dbWithoutCase], 'case_not_there');
    expect(found).toBeNull();
  });

  it('多个库中跳过未命中的、返回命中库（miss repo 被关闭）', () => {
    const dir = tmpDir('forge-findcase-multi-');
    const db1 = join(dir, 'miss.db');
    const db2 = join(dir, 'hit.db');
    const caseId = 'case_in_db2';
    initInfra(db1).repo.close(); // db1 无 case
    seedCase(db2, caseId);

    const found = findCaseInfra([db1, db2], caseId);
    expect(found).not.toBeNull();
    expect(found!.dbPath).toBe(db2); // 确认跳过 db1 命中 db2
    found!.repo.close();
  });

  it('全部库都不存在 -> 返回 null', () => {
    const dir = tmpDir('forge-findcase-none-');
    const found = findCaseInfra([join(dir, 'a.db'), join(dir, 'b.db')], 'case_x');
    expect(found).toBeNull();
  });
});
