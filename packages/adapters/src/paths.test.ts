/**
 * paths.ts 单测：两库（生产/测试）+ env 选择器的纯函数。
 * 覆盖 resolveDbPaths / resolveSingleDbPath / defaultDbEnv + FORGE_DB_* 覆盖 + all 返回两路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import {
  resolveDbPaths,
  resolveSingleDbPath,
  defaultDbEnv,
  DB_ENVS,
  type SingleDbEnv,
} from './paths.js';
import { resolveFromRoot } from './paths.js';

const ENV_KEYS = ['FORGE_ENV', 'FORGE_DB_PRODUCTION', 'FORGE_DB_TEST'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('defaultDbEnv', () => {
  it('默认 production', () => {
    expect(defaultDbEnv()).toBe('production');
  });

  it('FORGE_ENV=test -> test', () => {
    process.env.FORGE_ENV = 'test';
    expect(defaultDbEnv()).toBe('test');
  });

  it('FORGE_ENV 非 test 值回退 production', () => {
    process.env.FORGE_ENV = 'all';
    expect(defaultDbEnv()).toBe('production');
    process.env.FORGE_ENV = 'garbage';
    expect(defaultDbEnv()).toBe('production');
  });
});

describe('resolveSingleDbPath', () => {
  it('production 解析到 monorepo 根的 data/production.db（绝对路径）', () => {
    const p = resolveSingleDbPath('production');
    expect(p).toBe(resolveFromRoot(DB_ENVS.production));
    expect(p.endsWith('data/production.db') || p.endsWith('data\\production.db')).toBe(true);
  });

  it('test 解析到 data/test.db', () => {
    const p = resolveSingleDbPath('test');
    expect(p).toBe(resolveFromRoot(DB_ENVS.test));
  });

  it('FORGE_DB_PRODUCTION 覆盖绝对路径', () => {
    process.env.FORGE_DB_PRODUCTION = '/tmp/custom-prod.db';
    expect(resolveSingleDbPath('production')).toBe(resolve('/tmp/custom-prod.db'));
  });

  it('FORGE_DB_TEST 覆盖绝对路径', () => {
    process.env.FORGE_DB_TEST = '/tmp/custom-test.db';
    expect(resolveSingleDbPath('test')).toBe(resolve('/tmp/custom-test.db'));
  });

  it('空字符串的 FORGE_DB_* 被忽略，回退默认', () => {
    process.env.FORGE_DB_PRODUCTION = '  ';
    expect(resolveSingleDbPath('production')).toBe(resolveFromRoot(DB_ENVS.production));
  });

  it('FORGE_DB_* 只覆盖对应 env（production 覆盖不影响 test）', () => {
    process.env.FORGE_DB_PRODUCTION = '/tmp/prod-only.db';
    expect(resolveSingleDbPath('test')).toBe(resolveFromRoot(DB_ENVS.test));
  });
});

describe('resolveDbPaths', () => {
  it('production 返回单元素', () => {
    const paths = resolveDbPaths('production');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(resolveSingleDbPath('production'));
  });

  it('test 返回单元素', () => {
    const paths = resolveDbPaths('test');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(resolveSingleDbPath('test'));
  });

  it('all 返回两个库（production + test，顺序固定）', () => {
    const paths = resolveDbPaths('all');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(resolveSingleDbPath('production'));
    expect(paths[1]).toBe(resolveSingleDbPath('test'));
  });

  it('all 两个路径互不相同', () => {
    const paths = resolveDbPaths('all');
    expect(paths[0]).not.toBe(paths[1]);
  });
});

describe('DB_ENVS 常量', () => {
  it('恰好两个 env', () => {
    const keys = Object.keys(DB_ENVS) as SingleDbEnv[];
    expect(keys).toHaveLength(2);
    expect(keys).toContain('production');
    expect(keys).toContain('test');
  });
});
