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
