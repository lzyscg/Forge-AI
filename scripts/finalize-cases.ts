// 把所有非终态 case 标记为 stopped，保留为记录但不会被下次启动的 recovery 拉起
import Database from 'better-sqlite3';
const db = process.argv[2] ? new Database(process.argv[2]) : new Database('./data/real-pi-multi.db');
const NON_TERMINAL = ['running', 'waiting_review', 'repairing', 'waiting_recovery', 'waiting_human'];
const rows = db.prepare(`SELECT case_id, status FROM cases WHERE status IN (${NON_TERMINAL.map(() => '?').join(',')})`).all(...NON_TERMINAL) as any[];
for (const r of rows) {
  db.prepare("UPDATE cases SET status = 'stopped' WHERE case_id = ?").run(r.case_id);
  console.log('stopped:', r.case_id, '(', r.status, '-> stopped)');
}
if (rows.length === 0) console.log('no non-terminal cases');
db.close();
