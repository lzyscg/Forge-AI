// 端到端崩溃恢复测试（交付标准 2.3）
// 方式：worker 用 MAX_TURNS=3 真实跑 3 个 Turn 后进程退出（=跑到一半停止，DB 是真实状态），
// 再用同一 DB 重启 worker，验证：恢复触发 -> 从 Turn 4 续跑 -> approved -> 已完成 Turn/产物不变。
// 这是进程级恢复（worker 进程退出 + 重启），不是内存态模拟。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const D = require('better-sqlite3');

const DB = './data/crash-e2e.db';
try { fs.unlinkSync(DB); } catch {}

function runWorker(env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/main.ts'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', d => buf += d);
    child.stderr.on('data', d => buf += d);
    const timer = setTimeout(() => killTree(child.pid), timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve(buf); });
  });
}
function killTree(pid) { try { execSync(`taskkill /F /T /PID ${pid}`, {stdio:'ignore'}); } catch {} }
function snap() {
  const db = new D(DB, {readonly:true});
  const cases = db.prepare("SELECT case_id, status FROM cases").all();
  const turns = db.prepare("SELECT sequence, status, output_message_id FROM turns ORDER BY sequence").all();
  const versions = db.prepare("SELECT version, content_hash, status FROM artifact_versions ORDER BY version").all();
  const issues = db.prepare("SELECT status FROM evaluation_issues").all();
  const events = db.prepare("SELECT event_type FROM control_events WHERE event_type LIKE 'recovery%'").all();
  const gate = db.prepare("SELECT status, checks FROM delivery_gate_results").all();
  db.close();
  return { cases, turns, versions, issues, events, gate };
}

(async () => {
  console.log('=== Phase 1: worker runs 3 turns then exits (MAX_TURNS=3) ===');
  await runWorker({ PI_MODE: 'fake', DB_PATH: DB, SCENARIO_PATH: './scenarios/songwriting/scenario.yaml', MAX_TURNS: '3' });
  const s1 = snap();
  console.log('cases:', JSON.stringify(s1.cases));
  console.log('turns:', s1.turns.map(t=>`${t.sequence}:${t.status}`).join(' '));
  console.log('versions:', s1.versions.map(v=>`v${v.version}:${v.status}:${v.content_hash.slice(0,8)}`).join(' '));
  console.log('issues:', s1.issues.map(i=>i.status).join(','));
  const turn1Msg = s1.turns[0]?.output_message_id;
  const v1Hash = s1.versions[0]?.content_hash;
  const caseId = s1.cases[0]?.case_id;

  console.log('\n=== Phase 2: restart worker (same DB, no MAX_TURNS) -> should resume ===');
  const out2 = await runWorker({ PI_MODE: 'fake', DB_PATH: DB, SCENARIO_PATH: './scenarios/songwriting/scenario.yaml' });
  console.log('worker stdout (filtered):');
  console.log(out2.split('\n').filter(l => /\[恢复\]|\[Case\] 续跑|\[交付\]|\[最终\]/.test(l)).join('\n'));
  const s2 = snap();
  console.log('cases:', JSON.stringify(s2.cases));
  console.log('turns:', s2.turns.map(t=>`${t.sequence}:${t.status}`).join(' '));
  console.log('versions:', s2.versions.map(v=>`v${v.version}:${v.status}:${v.content_hash.slice(0,8)}`).join(' '));
  console.log('issues:', s2.issues.map(i=>i.status).join(','));
  console.log('recovery events:', s2.events.map(e=>e.event_type).join(','));
  console.log('gate:', s2.gate.map(g=>g.status).join(','));

  console.log('\n=== VERDICT ===');
  const finalCase = s2.cases.find(c => c.case_id === caseId);
  const newCases = s2.cases.filter(c => c.case_id !== caseId);
  console.log('1. original case resumed (no new case):', finalCase ? 'YES' : 'NO', '| new cases:', newCases.length);
  console.log('2. recovery triggered:', s2.events.length > 0 ? 'YES' : 'NO');
  console.log('3. final status approved:', finalCase?.status === 'approved' ? 'YES' : `NO (${finalCase?.status})`);
  console.log('4. resumed from Turn 4 (not rerun Turn 1-3):', s2.turns.length >= 7 && s2.turns[0]?.output_message_id === turn1Msg ? 'YES' : 'NO');
  console.log('5. Turn 1 output_message_id unchanged:', s2.turns[0]?.output_message_id === turn1Msg ? 'YES' : 'NO');
  console.log('6. v1 content_hash unchanged:', s2.versions[0]?.content_hash === v1Hash ? 'YES' : 'NO');
  console.log('7. v2 delivered:', s2.versions.some(v=>v.version===2 && v.status==='delivered') ? 'YES' : 'NO');
  console.log('8. gate passed:', s2.gate.some(g=>g.status==='pass') ? 'YES' : 'NO');
})();
