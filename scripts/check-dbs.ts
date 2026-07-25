import Database from 'better-sqlite3';
const files = ['data/song-fake.db', 'data/song-fake2.db', 'data/copy-fake.db', 'data/real-pi-full.db'];
for (const p of files) {
  try {
    const db = new Database(p, { readonly: true });
    const c = db.prepare('SELECT status, title FROM cases').get() as any;
    const v = db.prepare('SELECT count(*) AS n FROM artifact_versions').get() as any;
    const vers = db.prepare('SELECT version, status FROM artifact_versions ORDER BY version').all() as any[];
    const i = db.prepare('SELECT count(*) AS n FROM evaluation_issues').get() as any;
    const g = db.prepare('SELECT count(*) AS n FROM delivery_gate_results').get() as any;
    console.log(p);
    console.log('  case:', c?.status, '|', c?.title);
    console.log('  versions:', v.n, vers.map(x => `v${x.version}:${x.status}`).join(' '));
    console.log('  issues:', i.n, '| gates:', g.n);
    db.close();
  } catch (e) {
    console.log(p, 'ERR', e instanceof Error ? e.message : e);
  }
}
