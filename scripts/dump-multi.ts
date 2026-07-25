import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-multi.db', { readonly: true });
const q = (sql: string) => { try { return db.prepare(sql).all() as any[]; } catch (e) { return [`ERR ${e}`]; } };

console.log('=== CASES ===');
console.table(q("SELECT case_id, status FROM cases"));

console.log('=== TURNS ===');
console.table(q("SELECT sequence, status FROM turns ORDER BY sequence"));

console.log('=== TOOL ACTIONS (full) ===');
for (const r of q("SELECT tool_name, arguments, result FROM tool_actions ORDER BY created_at")) {
  console.log(`\n--- [${r.tool_name}] ---`);
  console.log('ARGS:', r.arguments);
  if (r.result) console.log('RESULT:', r.result);
}

console.log('\n=== ISSUES ===');
console.table(q("SELECT severity, status, substr(problem,1,60) AS problem, anchor FROM evaluation_issues"));

console.log('=== ISSUE EVENTS ===');
console.table(q("SELECT event_type, actor FROM issue_events ORDER BY created_at"));

console.log('=== ARTIFACT VERSIONS ===');
console.table(q("SELECT version, status FROM artifact_versions ORDER BY version"));

db.close();
