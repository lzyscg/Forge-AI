import Database from 'better-sqlite3';
const db = new Database(process.argv[2] ?? './data/real-pi-multi.db');
const caseId = process.argv[3];
const turns = db.prepare(`
  SELECT t.turn_id, t.sequence, t.status, t.output_message_id, t.provider_error, s.agent_key
  FROM turns t JOIN agent_sessions s ON t.session_id = s.session_id
  WHERE t.case_id = ? ORDER BY t.sequence`).all(caseId) as any[];
for (const t of turns) {
  console.log(`\n=== Turn ${t.sequence} | ${t.agent_key} | ${t.status} ===`);
  if (t.provider_error) console.log('  [provider_error]:', String(t.provider_error).slice(0, 500));
  if (t.output_message_id) {
    const m = db.prepare('SELECT content, message_type FROM messages WHERE message_id = ?').get(t.output_message_id) as any;
    if (m) {
      console.log('  [output msg type]:', m.message_type);
      console.log('  [assistant output]:', String(m.content).slice(0, 1200));
    }
  }
  const acts = db.prepare('SELECT tool_name, arguments, result, status FROM tool_actions WHERE turn_id = ? ORDER BY rowid').all(t.turn_id) as any[];
  for (const a of acts) {
    console.log('  [action]', a.tool_name, '| status:', a.status, '| args:', String(a.arguments).slice(0, 400), '| result:', String(a.result ?? '').slice(0, 300));
  }
}
db.close();
