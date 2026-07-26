// 验证 Feature 2: skill 注入 (getSkills 含 rhyme) + read 工具装配
// 只建 session 不调模型，零 token
import { RealPiAdapter } from '../packages/adapters/src/pi-adapter.js';
import { resolveFromRoot } from '../packages/adapters/src/paths.js';

const adapter = new RealPiAdapter({});
const skillsPath = resolveFromRoot('scenarios', 'songwriting', 'skills');

const session = await adapter.createSession('generator', 'cold_per_version', undefined, {
  scenarioId: 'songwriting',
  scenarioSkillsPath: skillsPath,
  agentSkills: ['rhyme'],
});

const skills = adapter.getSkills(session.session_ref);
console.log('getSkills:', JSON.stringify(skills.map(s => ({ name: s.name, desc: s.description }))));

const hasRhyme = skills.some(s => s.name === 'rhyme');
console.log(hasRhyme ? 'PASS: rhyme skill discovered' : 'FAIL: rhyme not found');

await adapter.closeSession(session.session_ref);
process.exit(hasRhyme ? 0 : 1);
