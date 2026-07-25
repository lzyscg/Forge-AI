// 端到端崩溃恢复测试（交付标准 2.3）
// 方式：CLI case run --max-turns 3 真实跑 3 个 Turn 后自然退出（=跑到一半停止，DB 是真实状态），
// 再用 CLI case run 续跑同一 Case，验证：恢复触发 -> 从 Turn 4 续跑 -> approved -> 已完成 Turn/产物不变。
// 这是进程级恢复（CLI 进程退出 + 重启），不是内存态模拟。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB = path.resolve(ROOT, 'data', 'crash-e2e.db');
const CLI = path.join(ROOT, 'apps', 'cli', 'bin.js');

// 干净起跑
try { fs.unlinkSync(DB); } catch {}
try { fs.unlinkSync(DB + '-shm'); } catch {}
try { fs.unlinkSync(DB + '-wal'); } catch {}

/** 同步执行 CLI 命令，返回 stdout 文本（使用 execFileSync 避免 shell 注入） */
function cliSync(args, opts = {}) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: ROOT,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout || 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // 即使非零退出码也返回 stdout（Phase 1 max-turns 退出可能带非零码）
    return (e.stdout || '') + (e.stderr || '');
  }
}

/** 从 CLI stdout 第一行解析 case_id */
function parseCaseId(stdout) {
  const lines = stdout.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.case_id) return obj.case_id;
    } catch {}
  }
  return null;
}

function snap() {
  const db = new D(DB, { readonly: true });
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
  console.log('=== Phase 1: CLI create + run --max-turns 3 (自然退出) ===');

  // 1a. 创建 Case
  const createOut = cliSync(['case', 'create', '--template', 'songwriting', '--db', DB]);
  const caseId = parseCaseId(createOut);
  if (!caseId) {
    console.error('FATAL: 无法从 create 输出解析 case_id');
    console.error(createOut);
    process.exit(1);
  }
  console.log('case_id:', caseId);

  // 1b. 跑 3 个 Turn（CLI 阻塞，max-turns=3 让它跑完 3 turn 后自然退出）
  const runOut = cliSync(['case', 'run', caseId, '--max-turns', '3', '--db', DB], { timeout: 60000 });
  console.log('run (max-turns 3) 完成');

  const s1 = snap();
  console.log('cases:', JSON.stringify(s1.cases));
  console.log('turns:', s1.turns.map(t => `${t.sequence}:${t.status}`).join(' '));
  console.log('versions:', s1.versions.map(v => `v${v.version}:${v.status}:${v.content_hash.slice(0, 8)}`).join(' '));
  console.log('issues:', s1.issues.map(i => i.status).join(','));
  const turn1Msg = s1.turns[0]?.output_message_id;
  const v1Hash = s1.versions[0]?.content_hash;

  console.log('\n=== Phase 2: CLI case run 续跑（自动检测 running 状态并恢复） ===');
  const run2Out = cliSync(['case', 'run', caseId, '--db', DB], { timeout: 60000 });
  console.log('run (续跑) 完成');

  const s2 = snap();
  console.log('cases:', JSON.stringify(s2.cases));
  console.log('turns:', s2.turns.map(t => `${t.sequence}:${t.status}`).join(' '));
  console.log('versions:', s2.versions.map(v => `v${v.version}:${v.status}:${v.content_hash.slice(0, 8)}`).join(' '));
  console.log('issues:', s2.issues.map(i => i.status).join(','));
  console.log('recovery events:', s2.events.map(e => e.event_type).join(','));
  console.log('gate:', s2.gate.map(g => g.status).join(','));

  console.log('\n=== VERDICT ===');
  const finalCase = s2.cases.find(c => c.case_id === caseId);
  const newCases = s2.cases.filter(c => c.case_id !== caseId);
  console.log('1. original case resumed (no new case):', finalCase ? 'YES' : 'NO', '| new cases:', newCases.length);
  console.log('2. recovery triggered:', s2.events.length > 0 ? 'YES' : 'NO');
  console.log('3. final status approved:', finalCase?.status === 'approved' ? 'YES' : `NO (${finalCase?.status})`);
  console.log('4. resumed from Turn 4 (not rerun Turn 1-3):', s2.turns.length >= 7 && s2.turns[0]?.output_message_id === turn1Msg ? 'YES' : 'NO');
  console.log('5. Turn 1 output_message_id unchanged:', s2.turns[0]?.output_message_id === turn1Msg ? 'YES' : 'NO');
  console.log('6. v1 content_hash unchanged:', s2.versions[0]?.content_hash === v1Hash ? 'YES' : 'NO');
  console.log('7. v2 delivered:', s2.versions.some(v => v.version === 2 && v.status === 'delivered') ? 'YES' : 'NO');
  console.log('8. gate passed:', s2.gate.some(g => g.status === 'pass') ? 'YES' : 'NO');

  const results = [
    !!finalCase && newCases.length === 0,
    s2.events.length > 0,
    finalCase?.status === 'approved',
    s2.turns.length >= 7 && s2.turns[0]?.output_message_id === turn1Msg,
    s2.turns[0]?.output_message_id === turn1Msg,
    s2.versions[0]?.content_hash === v1Hash,
    s2.versions.some(v => v.version === 2 && v.status === 'delivered'),
    s2.gate.some(g => g.status === 'pass'),
  ];
  const allYes = results.every(Boolean);
  console.log(allYes ? '\nALL PASS' : '\nFAIL');
  process.exit(allYes ? 0 : 1);
})();
