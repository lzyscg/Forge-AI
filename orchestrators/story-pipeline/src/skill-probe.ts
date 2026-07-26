/**
 * 零 Token 探针：确认五套故事模板声明的 Skill 都能被 Pi Runtime 发现。
 * 只创建内存 Session，不向模型发送 prompt。
 */
import { resolve } from 'node:path';
import { RealPiAdapter } from '../../../packages/adapters/src/pi-adapter.js';

const checks: Array<{
  name: string;
  skillsPath: string;
  expected: string[];
}> = [
  {
    name: 'outline',
    skillsPath: 'scenarios/zhihu-story-outline/skills',
    expected: ['zhihu-salt-outline-designer'],
  },
  {
    name: 'packet',
    skillsPath: 'scenarios/zhihu-chapter-packet/skills',
    expected: ['zhihu-salt-chapter-packet'],
  },
  {
    name: 'draft',
    skillsPath: 'scenarios/zhihu-chapter-draft/skills',
    expected: ['zhihu-salt-chapter-drafter', 'zhihu-salt-chapter-packet'],
  },
  {
    name: 'ledger',
    skillsPath: 'scenarios/zhihu-story-ledger/skills',
    expected: ['zhihu-salt-chapter-packet'],
  },
  {
    name: 'final',
    skillsPath: 'scenarios/zhihu-story-final/skills',
    expected: ['zhihu-salt-production-director'],
  },
];

const adapter = new RealPiAdapter({});
let failed = false;

for (const check of checks) {
  const session = await adapter.createSession(check.name, 'cold_per_version', undefined, {
    scenarioId: check.name,
    scenarioSkillsPath: resolve(check.skillsPath),
    agentSkills: check.expected,
  });
  const loaded = adapter.getSkills(session.session_ref).map((skill) => skill.name);
  const missing = check.expected.filter((name) => !loaded.includes(name));
  process.stdout.write(
    `${check.name}: ${missing.length === 0 ? 'PASS' : 'FAIL'} [${loaded.join(', ')}]\n`,
  );
  if (missing.length > 0) failed = true;
  await adapter.closeSession(session.session_ref);
}

process.exitCode = failed ? 1 : 0;
