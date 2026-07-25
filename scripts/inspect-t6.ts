import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-multi.db');
const t6 = db.prepare("SELECT * FROM turns WHERE case_id='case_280bef9f58c340ac' AND sequence=6").get() as any;
console.log('turn6 row:', JSON.stringify(t6, null, 2));
if (t6?.context_snapshot_id) {
  const cs = db.prepare('SELECT rendered_context FROM context_snapshots WHERE context_snapshot_id=?').get(t6.context_snapshot_id) as any;
  console.log('\n=== RENDERED CONTEXT (first 3000) ===');
  console.log(String(cs.rendered_context).slice(0, 3000));
}
if (t6?.input_message_id) {
  const im = db.prepare('SELECT content, message_type FROM messages WHERE message_id=?').get(t6.input_message_id) as any;
  console.log('\n=== INPUT MESSAGE ===');
  console.log(JSON.stringify(im, null, 2));
}
// also check output message raw
if (t6?.output_message_id) {
  const om = db.prepare('SELECT content, message_type FROM messages WHERE message_id=?').get(t6.output_message_id) as any;
  console.log('\n=== OUTPUT MESSAGE (raw) ===');
  console.log(JSON.stringify(om));
}
db.close();
