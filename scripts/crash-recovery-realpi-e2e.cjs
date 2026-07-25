// 真实 Pi 崩溃恢复端到端测试（交付标准 2.3 硬指标 + 第五章 item 3）
//
// 与 Fake Pi 的 crash-recovery-e2e.cjs 区别：
//   - --mode real，真实 DeepSeek 模型调用
//   - 真正的 taskkill /F /T（SIGKILL 等价），不是 max-turns 干净退出
//   - 断言 persistent session 跨进程历史续跑（2.3 第三条）：
//       1) 重启后从 Turn N+1 续跑（不重跑 1..N），已完成 Turn 哈希不变
//       2) persistent session 的 .jsonl 文件在续跑后条目数增加（同一文件被延续，历史未丢）
//       3) 续跑后 persistent agent 的 context_snapshot 仍包含崩溃前产物内容（current_artifact_version 规则）
//
// 铁律 6：API Key 只从环境变量读，不写死、不进日志。
// 用法：DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const D = require('better-sqlite3');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('错误：需要 DEEPSEEK_API_KEY 环境变量（铁律 6：不写死、不进日志）');
  console.error('用法：DEEPSEEK_API_KEY=sk-xxxx node scripts/crash-recovery-realpi-e2e.cjs');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'apps', 'cli', 'bin.js');
const DB = path.resolve(ROOT, process.env.CRASH_DB || 'data/crash-realpi.db');
const SESSION_DIR = path.resolve(ROOT, process.env.CRASH_SESSION_DIR || 'data/crash-realpi-sessions');
const MODEL = process.env.PI_MODEL_ID || 'deepseek-v4-flash';
const KILL_AFTER_TURNS = parseInt(process.env.KILL_AFTER_TURNS || '2', 10);
const PHASE1_DEADLINE_MS = 6 * 60 * 1000;  // 等 real Pi 跑到 N 个 turn：最多 6 分钟
const PHASE2_DEADLINE_MS = 12 * 60 * 1000; // 续跑完成：最多 12 分钟

// 干净起跑
try { fs.unlinkSync(DB); } catch {}
try { fs.unlinkSync(DB + '-shm'); } catch {}
try { fs.unlinkSync(DB + '-wal'); } catch {}
try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openDB() { return new D(DB, { readonly: true }); }

function completedTurnCount() {
  let d;
  try { d = openDB(); } catch { return 0; }
  try {
    return d.prepare("SELECT COUNT(*) AS c FROM turns WHERE status='completed'").get().c;
  } finally { d.close(); }
}

function snap() {
  const d = openDB();
  const cases = d.prepare("SELECT case_id, status FROM cases").all();
  const turns = d.prepare("SELECT sequence, status, output_message_id, produced_artifact_version_ids FROM turns ORDER BY sequence").all();
  const versions = d.prepare("SELECT version, content_hash, status, content FROM artifact_versions ORDER BY version").all();
  const events = d.prepare("SELECT event_type FROM control_events WHERE event_type LIKE 'recovery%' ORDER BY created_at").all();
  const gate = d.prepare("SELECT status FROM delivery_gate_results").all();
  const sessions = d.prepare("SELECT session_id, agent_key, session_policy, pi_session_ref, status FROM agent_sessions WHERE session_policy='persistent'").all();
  d.close();
  return { cases, turns, versions, events, gate, sessions };
}

/** 数 persistent session .jsonl 的条目数 */
function countSessionEntries(piSessionRef) {
  const dir = path.join(SESSION_DIR, piSessionRef);
  if (!fs.existsSync(dir)) return 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return 0; }
  let lines = 0;
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    lines += content.split('\n').filter((l) => l.trim().length > 0).length;
  }
  return lines;
}

/** 取 post-resume 阶段的 persistent agent turn 的 context_snapshot.rendered_context */
function postResumeRenderedContexts(killSeq) {
  const d = openDB();
  const rows = d.prepare(
    `SELECT t.sequence, s.agent_key, ctx.rendered_context
     FROM turns t
     JOIN agent_sessions s ON s.session_id = t.session_id
     JOIN context_snapshots ctx ON ctx.context_snapshot_id = t.context_snapshot_id
     WHERE t.sequence > ? AND s.session_policy='persistent' AND t.status='completed'
     ORDER BY t.sequence`,
  ).all(killSeq);
  d.close();
  return rows;
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* already gone */ }
}

/** 同步执行 CLI 命令（用于 create 等短命令） */
function cliSync(args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: ROOT,
      env: { ...process.env, DEEPSEEK_API_KEY: API_KEY, PI_MODEL_ID: MODEL, PI_SESSION_DIR: SESSION_DIR },
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

/** 从 CLI stdout 解析 case_id */
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

/** 后台 spawn CLI case run，返回 child 进程 */
function spawnCliRun(caseId) {
  const child = spawn(process.execPath, [CLI, 'case', 'run', caseId, '--mode', 'real', '--db', DB], {
    cwd: ROOT,
    env: { ...process.env, DEEPSEEK_API_KEY: API_KEY, PI_MODEL_ID: MODEL, PI_SESSION_DIR: SESSION_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function collect(child) {
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  return {
    get text() { return buf; },
    done: () => new Promise((r) => child.on('exit', (code) => r(code))),
  };
}

(async () => {
  console.log(`=== 配置 ===`);
  console.log(`  model: deepseek/${MODEL}`);
  console.log(`  db: ${DB}`);
  console.log(`  session_dir: ${SESSION_DIR}`);
  console.log(`  kill_after_turns: ${KILL_AFTER_TURNS}`);
  console.log('');

  // ---------- Phase 1: CLI create + run (real Pi)，跑到 N 个 completed turn 后 taskkill /F ----------
  console.log(`=== Phase 1: CLI create + run (real Pi)，跑到 ${KILL_AFTER_TURNS} 个 completed turn 后 kill -9 ===`);

  // 1a. 创建 Case
  const createOut = cliSync(['case', 'create', '--template', 'songwriting', '--mode', 'real', '--db', DB]);
  const caseId = parseCaseId(createOut);
  if (!caseId) {
    console.error('FATAL: 无法从 create 输出解析 case_id');
    console.error(createOut);
    process.exit(1);
  }
  console.log(`  case_id: ${caseId}`);

  // 1b. 后台启动 CLI case run
  const child1 = spawnCliRun(caseId);
  const c1 = collect(child1);

  let killed = false;
  const phase1Start = Date.now();
  while (Date.now() - phase1Start < PHASE1_DEADLINE_MS) {
    await sleep(3000);
    if (child1.exitCode !== null) break; // 进程自己退了
    const n = completedTurnCount();
    process.stdout.write(`  completed turns: ${n}\r`);
    if (n >= KILL_AFTER_TURNS) {
      console.log(`\n  达到 ${KILL_AFTER_TURNS} 个 completed turn，taskkill /F /T /PID ${child1.pid}（真实 kill，非干净退出）`);
      killTree(child1.pid);
      killed = true;
      break;
    }
  }
  if (!killed && child1.exitCode === null) {
    console.log('\n  超时未达到目标 turn 数，强制 kill');
    killTree(child1.pid);
  }
  await c1.done();
  console.log('  CLI run 1 已退出');

  const s1 = snap();
  if (!s1.cases.length) {
    console.error('  Phase 1 未创建任何 Case，无法继续。stdout 末尾：');
    console.error(c1.text.split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
  const killSeq = s1.turns.filter((t) => t.status === 'completed').length;
  console.log(`  case: ${caseId}`);
  console.log(`  turns: ${s1.turns.map((t) => `${t.sequence}:${t.status}`).join(' ')}`);
  console.log(`  versions: ${s1.versions.map((v) => `v${v.version}:${v.status}:${v.content_hash.slice(0, 8)}`).join(' ')}`);
  console.log(`  persistent sessions: ${s1.sessions.map((s) => `${s.agent_key}(${s.pi_session_ref.slice(0, 24)}...)`).join(', ')}`);

  // 记录 kill 时刻的持久状态
  const preKillTurnMsgs = s1.turns.map((t) => t.output_message_id);
  const preKillVersionHashes = s1.versions.map((v) => v.content_hash);
  const preKillEntries = new Map();
  for (const s of s1.sessions) {
    preKillEntries.set(s.pi_session_ref, countSessionEntries(s.pi_session_ref));
  }
  console.log(`  pre-kill .jsonl 条目数: ${[...preKillEntries.entries()].map(([k, v]) => `${k.slice(0, 24)}=${v}`).join(', ')}`);

  // ---------- Phase 2: CLI case run 续跑（同一 DB + 同一 session dir） ----------
  console.log(`\n=== Phase 2: CLI case run 续跑（同一 DB + 同一 session dir） ===`);
  const child2 = spawnCliRun(caseId);
  const c2 = collect(child2);

  // 等它跑完（approved / failed / stopped / timeout）
  const phase2Start = Date.now();
  let phase2Done = false;
  const exitPromise = c2.done().then((code) => { phase2Done = true; return code; });
  while (!phase2Done && Date.now() - phase2Start < PHASE2_DEADLINE_MS) {
    await sleep(5000);
    let st = null;
    try { const d = openDB(); st = d.prepare("SELECT status FROM cases WHERE case_id=?").get(caseId)?.status; d.close(); } catch {}
    if (st === 'approved' || st === 'failed' || st === 'stopped' || st === 'waiting_human') {
      console.log(`  Case 终态: ${st}，kill CLI run 2`);
      killTree(child2.pid);
      break;
    }
  }
  if (!phase2Done) {
    console.log('  超时，kill CLI run 2');
    killTree(child2.pid);
  }
  await exitPromise;
  console.log('  CLI run 2 已退出');

  const s2 = snap();
  console.log(`  cases: ${JSON.stringify(s2.cases)}`);
  console.log(`  turns: ${s2.turns.map((t) => `${t.sequence}:${t.status}`).join(' ')}`);
  console.log(`  versions: ${s2.versions.map((v) => `v${v.version}:${v.status}:${v.content_hash.slice(0, 8)}`).join(' ')}`);
  console.log(`  issues: ${(() => { const d = openDB(); const r = d.prepare("SELECT status FROM evaluation_issues").all(); d.close(); return r.map(i => i.status).join(','); })()}`);
  console.log(`  recovery events: ${s2.events.map((e) => e.event_type).join(', ')}`);
  console.log(`  gate: ${s2.gate.map((g) => g.status).join(',')}`);

  // ---------- VERDICT ----------
  console.log(`\n=== VERDICT ===`);
  const finalCase = s2.cases.find((c) => c.case_id === caseId);
  const newCases = s2.cases.filter((c) => c.case_id !== caseId);

  const v = {};
  // 1. 原 Case 被续跑（没新建 Case）
  v['1. original case resumed (no new case)'] = finalCase && newCases.length === 0 ? 'YES' : 'NO';
  // 2. 恢复触发（有 recovery_* 控制事件）
  v['2. recovery triggered (control events)'] = s2.events.length > 0 ? 'YES' : 'NO';
  // 3. 从 Turn N+1 续跑（不重跑 1..N）
  const turnsUnchanged = s2.turns.slice(0, killSeq).every((t, i) => t.output_message_id === preKillTurnMsgs[i]);
  v[`3. resumed from Turn ${killSeq + 1} (not rerun 1..${killSeq})`] =
    s2.turns.length > killSeq && turnsUnchanged ? 'YES' : 'NO';
  // 4. 已完成 Turn 的 output_message_id 不变（铁律 4）
  v['4. pre-kill Turn output_message_id unchanged'] = turnsUnchanged ? 'YES' : 'NO';
  // 5. 已完成产物 content_hash 不变（铁律 4）
  const hashesUnchanged = preKillVersionHashes.every((h, i) => s2.versions[i] && s2.versions[i].content_hash === h);
  v['5. pre-kill artifact content_hash unchanged'] = hashesUnchanged ? 'YES' : 'NO';
  // 6. persistent session .jsonl 条目数增加（跨进程历史续跑 -- 2.3 灵魂断言）
  let historyGrew = false;
  const entryDeltas = [];
  for (const s of s2.sessions) {
    const pre = preKillEntries.get(s.pi_session_ref) ?? 0;
    const post = countSessionEntries(s.pi_session_ref);
    entryDeltas.push(`${s.agent_key}: ${pre}->${post}`);
    if (post > pre && pre > 0) historyGrew = true;
  }
  v['6. persistent session .jsonl grew (history retained across process)'] = historyGrew ? 'YES' : 'NO';
  console.log(`  .jsonl 条目变化: ${entryDeltas.join(', ')}`);
  // 7. 续跑后 persistent agent 的 context_snapshot 仍含崩溃前产物内容
  let ctxHasPrior = false;
  const postCtxs = postResumeRenderedContexts(killSeq);
  const priorContentMarker = s1.versions.length > 0 ? String(s1.versions[s1.versions.length - 1].content).slice(0, 40) : '';
  for (const row of postCtxs) {
    const rc = String(row.rendered_context);
    if (priorContentMarker && rc.includes(priorContentMarker)) { ctxHasPrior = true; break; }
    if (rc.includes('当前产物 v1') || rc.includes('当前产物 v2')) { ctxHasPrior = true; break; }
  }
  v['7. post-resume context_snapshot contains prior artifact content'] = ctxHasPrior ? 'YES' : 'NO';
  console.log(`  post-resume persistent turns: ${postCtxs.map((r) => `Turn${r.sequence}(${r.agent_key})`).join(', ') || '(none)'}`);
  // 8. 最终 approved
  v['8. final status approved'] = finalCase?.status === 'approved' ? 'YES' : `NO (${finalCase?.status})`;
  // 9. 门禁 pass
  v['9. delivery gate passed'] = s2.gate.some((g) => g.status === 'pass') ? 'YES' : 'NO';

  let allCore = true;
  for (const [k, val] of Object.entries(v)) {
    console.log(`  ${k}: ${val}`);
    if (val !== 'YES' && k !== '8. final status approved' && k !== '9. delivery gate passed') allCore = false;
  }

  console.log('\n=== SUMMARY ===');
  const allYes = Object.values(v).every((x) => x === 'YES');
  console.log(allYes ? 'ALL PASS' : (allCore ? 'CORE RECOVERY PASS (approved/gate 受模型稳定性影响，见上)' : 'CORE RECOVERY FAIL'));
  console.log('\nCLI run 2 stdout（filtered）:');
  console.log(c2.text.split('\n').filter((l) => /\[恢复\]|\[Case\] 续跑|\[Turn|\[交付\]|\[最终\]|\[失败\]|\[停止\]|\[Fatal\]/.test(l)).join('\n'));

  process.exit(allYes ? 0 : (allCore ? 0 : 1));
})();
