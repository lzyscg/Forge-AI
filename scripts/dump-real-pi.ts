// 查询真实 Pi 运行后的 DB 状态
import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-probe.db', { readonly: true });

const q = (sql: string) => { try { return db.prepare(sql).all(); } catch (e) { return [`ERR ${e}`]; } };

console.log('=== CASES ===');
console.table(q("SELECT case_id, status, current_stage FROM cases"));

console.log('=== TURNS ===');
console.table(q("SELECT turn_id, sequence, status, substr(provider_error,1,60) AS err FROM turns ORDER BY sequence"));

console.log('=== TOOL ACTIONS ===');
console.table(q("SELECT tool_name, substr(arguments,1,80) AS args, status FROM tool_actions ORDER BY created_at"));

console.log('=== ARTIFACT VERSIONS ===');
console.table(q("SELECT version, status, substr(content,1,40) AS content_head FROM artifact_versions ORDER BY version"));

console.log('=== EVALUATION ISSUES ===');
console.table(q("SELECT severity, substr(problem,1,50) AS problem, status FROM evaluation_issues"));

console.log('=== ISSUE EVENTS ===');
console.table(q("SELECT issue_id, event_type, actor FROM issue_events ORDER BY created_at"));

console.log('=== CONTEXT SNAPSHOTS count ===');
console.table(q("SELECT count(*) AS n FROM context_snapshots"));

console.log('=== rendered context of turn 1 (first 600 chars) ===');
const cs = q("SELECT substr(rendered_context,1,600) AS ctx FROM context_snapshots ORDER BY created_at LIMIT 1");
console.log((cs as any[])[0]?.ctx);

db.close();
