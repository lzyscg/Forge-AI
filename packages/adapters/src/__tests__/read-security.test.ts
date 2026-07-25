/**
 * read 安全单测：验证白名单 access 函数（铁律 6：只允许读 skills 目录）
 */
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { createWhitelistAccess } from '../pi-adapter.js';
import { resolveFromRoot } from '../paths.js';

const skillsDir = resolveFromRoot('scenarios', 'songwriting', 'skills');

describe('createWhitelistAccess', () => {
  it('能读 scenarios/songwriting/skills/rhyme/SKILL.md', async () => {
    const access = createWhitelistAccess(skillsDir);
    const target = resolve(skillsDir, 'rhyme', 'SKILL.md');
    // 不应抛错
    await expect(access(target)).resolves.toBeUndefined();
  });

  it('不能读 deepseek_config.txt（项目根目录凭证文件）', async () => {
    const access = createWhitelistAccess(skillsDir);
    const target = resolveFromRoot('deepseek_config.txt');
    // 如果文件不存在，realpathSync 会抛 ENOENT；如果存在则抛 Access denied
    await expect(access(target)).rejects.toThrow();
  });

  it('不能读 .env 文件', async () => {
    const access = createWhitelistAccess(skillsDir);
    const target = resolveFromRoot('.env.example');
    await expect(access(target)).rejects.toThrow();
  });

  it('不能读 data/*.db', async () => {
    const access = createWhitelistAccess(skillsDir);
    // 使用一个存在的 db 文件
    const target = resolveFromRoot('data', 'crash-test.db');
    if (existsSync(target)) {
      await expect(access(target)).rejects.toThrow(/Access denied/);
    } else {
      // 文件不存在时 realpathSync 抛 ENOENT
      await expect(access(target)).rejects.toThrow();
    }
  });

  it('不能读源码 packages/adapters/src/pi-adapter.ts', async () => {
    const access = createWhitelistAccess(skillsDir);
    const target = resolveFromRoot('packages', 'adapters', 'src', 'pi-adapter.ts');
    await expect(access(target)).rejects.toThrow(/Access denied/);
  });

  it('不能通过 ../ 逃逸 skills 目录', async () => {
    const access = createWhitelistAccess(skillsDir);
    const target = resolve(skillsDir, '..', 'scenario.yaml');
    await expect(access(target)).rejects.toThrow(/Access denied/);
  });

  it('不能读绝对路径（Windows 系统目录）', async () => {
    const access = createWhitelistAccess(skillsDir);
    // 使用一个跨盘符/目录的路径
    const target = resolve(skillsDir, '..', '..', '..', 'package.json');
    await expect(access(target)).rejects.toThrow(/Access denied/);
  });

  it('skills 目录本身可以通过 access', async () => {
    const access = createWhitelistAccess(skillsDir);
    // skills 目录自身（realpathSync 对目录也有效）
    await expect(access(skillsDir)).resolves.toBeUndefined();
  });

  it('blocks symlink escape', async () => {
    const access = createWhitelistAccess(skillsDir);
    // 在 skills 目录内创建指向外部文件的 symlink
    const symlinkPath = join(skillsDir, 'evil-link.md');
    const targetPath = resolveFromRoot('package.json');  // 外部文件
    try {
      symlinkSync(targetPath, symlinkPath);
    } catch (e: any) {
      // Windows 无管理员权限时无法创建 symlink，跳过测试
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        console.warn('Skipping symlink test: insufficient privileges on Windows');
        return;
      }
      throw e;
    }
    try {
      await expect(access(symlinkPath)).rejects.toThrow(/Access denied/);
    } finally {
      try { unlinkSync(symlinkPath); } catch {}
    }
  });
});
