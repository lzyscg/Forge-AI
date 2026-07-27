/**
 * 路径基准工具
 * 铁律 5：运行时关注点放 adapters 层。
 *
 * 基于 import.meta.url 定位 monorepo 根目录（forge-ai/package.json 所在目录）。
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 返回 monorepo 根目录绝对路径。
 * 当前文件位于 packages/adapters/src/paths.ts，向上 3 级即包根。
 */
export function getPackageRoot(): string {
  return resolve(__dirname, '..', '..', '..');
}

/**
 * 相对 monorepo 根目录解析路径。
 */
export function resolveFromRoot(...segments: string[]): string {
  return resolve(getPackageRoot(), ...segments);
}

// === 两库（生产/测试）+ env 选择器 ===
// 硬编码两个 env（不做 N 库可扩展，简单）。以后要多库再重构。

/** 单个库的 env（写操作必须指定单个） */
export type SingleDbEnv = 'production' | 'test';
/** env（含 all 聚合，仅用于读操作） */
export type DbEnv = SingleDbEnv | 'all';

/** 两个命名库的默认相对路径（相对 monorepo 根）。
 *  可用 FORGE_DB_PRODUCTION / FORGE_DB_TEST 环境变量覆盖绝对路径。 */
export const DB_ENVS: Record<SingleDbEnv, string> = {
  production: 'data/production.db',
  test: 'data/test.db',
};

/**
 * 默认 env：FORGE_ENV 环境变量可覆盖，否则 production。
 */
export function defaultDbEnv(): SingleDbEnv {
  return process.env.FORGE_ENV === 'test' ? 'test' : 'production';
}

/**
 * 解析单个 env 的 DB 绝对路径（写操作用）。
 * 支持 FORGE_DB_PRODUCTION / FORGE_DB_TEST 环境变量覆盖。
 */
export function resolveSingleDbPath(env: SingleDbEnv): string {
  const overrideKey = env === 'production' ? 'FORGE_DB_PRODUCTION' : 'FORGE_DB_TEST';
  const override = process.env[overrideKey];
  if (override && override.trim() !== '') {
    return resolve(override);
  }
  return resolveFromRoot(DB_ENVS[env]);
}

/**
 * 解析 env -> 1 或 2 个 DB 绝对路径（读操作用）。
 * production/test 返回单元素，all 返回两个库（聚合）。
 */
export function resolveDbPaths(env: DbEnv): string[] {
  if (env === 'all') {
    return [resolveSingleDbPath('production'), resolveSingleDbPath('test')];
  }
  return [resolveSingleDbPath(env)];
}

