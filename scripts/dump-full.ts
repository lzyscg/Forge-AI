import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-full.db', { readonly: true });
const q = (sql: string) => { try { return db.prepare(sql).all(); } catch (e) { return [`ERR ${e}`]; } };
console.log('=== CASE ==='); console.table(q("SELECT status, current_stage, completed_at FROM cases"));
console.log('=== TURNS ==='); console.table(q("SELECT sequence, status, agent_session_ref FROM turns ORDER BY sequence"));
console.log('=== TOOL ACTIONS (full args) ===');
for (const r of q("SELECT tool_name, arguments FROM tool_actions ORDER BY created_at") as any[]) {
  console.log(`\n[${r.tool_name}]`); console.log(r.arguments);
}
console.log('\n=== ARTIFACT VERSIONS ==='); console.table(q("SELECT version, status FROM artifact_versions ORDER BY version"));
console.log('=== DELIVERY GATE RESULTS ===');
for (const r of q("SELECT status, checks FROM delivery_gate_results") as any[]) {
  console.log(`gate status: ${r.status}`); console.log(JSON.stringify(JSON.parse(r.checks), null, 2));
}
console.log('=== ISSUES count ==='); console.table(q("SELECT count(*) AS n FROM evaluation_issues"));
console.log('=== SESSIONS (policy) ==='); console.table(q("SELECT agent_key, session_policy, status FROM agent_sessions"));
db.close();
