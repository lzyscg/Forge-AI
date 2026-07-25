import Database from 'better-sqlite3';
const db = new Database('./data/real-pi-multi.db');
const caseId = process.argv[2] ?? 'case_a0e2f9df46054bf8';
console.log(`=== Case ${caseId} ===`);
const issues = db.prepare('SELECT issue_id, severity, status FROM evaluation_issues WHERE case_id=?').all(caseId) as any[];
console.log('--- ISSUES ---');
for (const i of issues) {
  const evs = db.prepare('SELECT event_type FROM issue_events WHERE issue_id=? ORDER BY rowid').all(i.issue_id) as any[];
  console.log(`  ${i.issue_id} | ${i.severity} | final=${i.status} | events: ${evs.map((e) => e.event_type).join(' -> ')}`);
}
console.log('--- REVISION INSTRUCTIONS ---');
const ris = db.prepare('SELECT status, issue_ids, editable_anchors, frozen_anchors FROM revision_instructions WHERE case_id=?').all(caseId) as any[];
for (const r of ris) console.log(`  status=${r.status} | issue_ids=${r.issue_ids} | editable=${r.editable_anchors} | frozen=${r.frozen_anchors}`);
console.log('--- ARTIFACT VERSIONS ---');
const avs = db.prepare('SELECT av.version, av.status FROM artifact_versions av JOIN artifacts a ON av.artifact_id=a.artifact_id WHERE a.case_id=? ORDER BY av.version').all(caseId) as any[];
for (const v of avs) console.log(`  v${v.version} | ${v.status}`);
const gate = db.prepare('SELECT gate_passed FROM delivery_gate_results WHERE case_id=?').get(caseId) as any;
console.log('--- GATE passed:', gate?.gate_passed);
const cs = db.prepare('SELECT status FROM cases WHERE case_id=?').get(caseId) as any;
console.log('--- CASE status:', cs?.status);
db.close();
