import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-multi.db');
const caseId = 'case_76df4a8fe5e9474e';
console.log('=== ISSUE EVENTS ===');
const issues = db.prepare('SELECT issue_id FROM evaluation_issues WHERE case_id=?').all(caseId) as any[];
for (const i of issues) {
  const evs = db.prepare('SELECT event_type, actor FROM issue_events WHERE issue_id=? ORDER BY rowid').all(i.issue_id) as any[];
  console.log(i.issue_id, '->', evs.map((e) => `${e.event_type}(${e.actor})`).join(' > '));
}
console.log('\n=== REVISION INSTRUCTIONS ===');
const ris = db.prepare('SELECT revision_instruction_id, status, issue_ids, editable_anchors, frozen_anchors FROM revision_instructions WHERE case_id=?').all(caseId) as any[];
for (const r of ris) console.log(r.revision_instruction_id, '| status:', r.status, '| issue_ids:', r.issue_ids, '| editable:', r.editable_anchors, '| frozen:', r.frozen_anchors);
console.log('\n=== Turn 4 route_message scope ===');
const t4 = db.prepare('SELECT turn_id FROM turns WHERE case_id=? AND sequence=4').get(caseId) as any;
const act = db.prepare("SELECT arguments FROM tool_actions WHERE turn_id=? AND tool_name='route_message'").get(t4.turn_id) as any;
const args = JSON.parse(act.arguments);
console.log('scope:', JSON.stringify(args.scope));
db.close();
