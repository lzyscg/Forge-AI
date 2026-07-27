import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from './sqlite-repository.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createCaseTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE cases (
      case_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL DEFAULT 'init',
      scenario_snapshot TEXT NOT NULL,
      input_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
}

function insertCase(
  database: Database.Database,
  caseId: string,
  title: string,
  status = 'created',
): void {
  database.prepare(`
    INSERT INTO cases (
      case_id, title, status, current_stage, scenario_snapshot,
      input_payload, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'init', '{}', '{}', ?, ?, NULL)
  `).run(
    caseId,
    title,
    status,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
}

function directoryEvidence(root: string) {
  return readdirSync(root).sort().map((name) => {
    const path = join(root, name);
    const bytes = readFileSync(path);
    return {
      name,
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

function readonlySnapshotDirectories(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('forge-readonly-db-')),
  );
}

function createdSnapshotDirectories(before: Set<string>): string[] {
  return [...readonlySnapshotDirectories()]
    .filter((name) => !before.has(name));
}

function removeSnapshotDirectories(names: string[]): void {
  for (const name of names) {
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for writer');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe('read-only SQLite snapshots', () => {
  it('reads committed WAL content without changing any source DB sidecar', () => {
    const root = temporaryRoot('forge-readonly-wal-');
    const dbPath = join(root, 'forge.db');
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    createCaseTable(writer);
    writer.pragma('wal_checkpoint(TRUNCATE)');
    insertCase(writer, 'case-in-wal', 'latest committed row');
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const before = directoryEvidence(root);

    const repo = new SqliteRepository(dbPath, { readonly: true });
    try {
      expect(repo.getCase('case-in-wal')?.title).toBe(
        'latest committed row',
      );
    } finally {
      repo.close();
    }

    expect(directoryEvidence(root)).toEqual(before);
    writer.close();
  });

  it('returns only coherent committed states during concurrent writes and checkpoints', async () => {
    const root = temporaryRoot('forge-readonly-race-');
    const dbPath = join(root, 'forge.db');
    const readyPath = join(root, 'writer.ready');
    const initial = new Database(dbPath);
    initial.pragma('journal_mode = WAL');
    initial.pragma('wal_autocheckpoint = 0');
    createCaseTable(initial);
    insertCase(initial, 'meta', '0', 'meta');
    initial.close();
    const writerScript = `
      const Database = require('better-sqlite3');
      const fs = require('node:fs');
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.pragma('busy_timeout = 5000');
      const insert = db.prepare(
        "INSERT INTO cases VALUES (?, ?, 'row', 'init', '{}', '{}', ?, ?, NULL)"
      );
      const update = db.prepare("UPDATE cases SET title = ? WHERE case_id = 'meta'");
      const commit = db.transaction((sequence) => {
        insert.run(
          'row-' + sequence,
          String(sequence),
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        );
        update.run(String(sequence));
      });
      fs.writeFileSync(process.argv[2], 'ready');
      for (let sequence = 1; sequence <= 600; sequence += 1) {
        commit(sequence);
        if (sequence % 3 === 0) db.pragma('wal_checkpoint(TRUNCATE)');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      db.close();
    `;
    const child = spawn(
      process.execPath,
      ['-e', writerScript, dbPath, readyPath],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const childCompletion = new Promise<number | null>(
      (resolvePromise, rejectPromise) => {
        child.once('error', rejectPromise);
        child.once('close', resolvePromise);
      },
    );
    let childError = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      childError += chunk.toString('utf8');
    });
    await waitUntil(() => existsSync(readyPath));

    let successes = 0;
    let unsafeSnapshotError: unknown;
    while (child.exitCode === null || successes < 10) {
      try {
        const repo = new SqliteRepository(dbPath, { readonly: true });
        try {
          const sequence = Number(repo.getCase('meta')?.title);
          const rowCount = repo.getCasesByStatus('row').length;
          expect(rowCount).toBe(sequence);
          successes += 1;
        } finally {
          repo.close();
        }
      } catch (error) {
        if (!String(error).includes(
          'could not capture a stable read-only SQLite snapshot',
        )) {
          unsafeSnapshotError = error;
          break;
        }
      }
      if (child.exitCode !== null && successes >= 10) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    }
    const exitCode = await childCompletion;
    expect(exitCode, childError).toBe(0);
    expect(unsafeSnapshotError).toBeUndefined();
    expect(successes).toBeGreaterThanOrEqual(10);
  }, 20_000);

  it.each([
    {
      name: 'copy failure',
      source: (root: string) => join(root, 'missing.db'),
    },
    {
      name: 'open failure',
      source: (root: string) => {
        const path = join(root, 'corrupt.db');
        writeFileSync(path, 'not a SQLite database', 'utf8');
        return path;
      },
    },
  ])('cleans the complete temporary DB after $name', ({ source }) => {
    const root = temporaryRoot('forge-readonly-failure-');
    const dbPath = source(root);
    const before = readonlySnapshotDirectories();
    let caught: unknown;
    try {
      const repo = new SqliteRepository(dbPath, { readonly: true });
      repo.close();
    } catch (error) {
      caught = error;
    }
    const leaked = createdSnapshotDirectories(before);
    removeSnapshotDirectories(leaked);

    expect(caught).toBeInstanceOf(Error);
    expect(leaked).toEqual([]);
  });

  it('restricts its snapshot and removes it on normal close', () => {
    const root = temporaryRoot('forge-readonly-clean-close-');
    const dbPath = join(root, 'forge.db');
    const database = new Database(dbPath);
    createCaseTable(database);
    database.close();
    const before = readonlySnapshotDirectories();

    const repo = new SqliteRepository(dbPath, { readonly: true });
    const during = createdSnapshotDirectories(before);
    expect(during).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(
        statSync(join(tmpdir(), during[0]!)).mode & 0o077,
      ).toBe(0);
      const snapshotPath = join(tmpdir(), during[0]!, 'forge.db');
      expect(statSync(snapshotPath).mode & 0o077).toBe(0);
    }

    repo.close();

    expect(createdSnapshotDirectories(before)).toEqual([]);
  });

  it('keeps the snapshot path retryable while a real query makes close busy', () => {
    const root = temporaryRoot('forge-readonly-busy-close-');
    const dbPath = join(root, 'forge.db');
    const database = new Database(dbPath);
    createCaseTable(database);
    insertCase(database, 'case-1', 'one');
    insertCase(database, 'case-2', 'two');
    database.close();
    const repo = new SqliteRepository(dbPath, { readonly: true });
    const internals = repo as unknown as {
      db: Database.Database;
      readonlySnapshotDirectory: string | null;
    };
    const snapshotDirectory = internals.readonlySnapshotDirectory!;
    const iterator = internals.db.prepare('SELECT * FROM cases').iterate();
    iterator.next();

    try {
      expect(() => repo.close()).toThrow(
        'This database connection is busy executing a query',
      );
      expect(internals.readonlySnapshotDirectory).toBe(snapshotDirectory);
      expect(existsSync(snapshotDirectory)).toBe(true);

      iterator.return?.();
      expect(() => repo.close()).not.toThrow();
      expect(internals.readonlySnapshotDirectory).toBeNull();
      expect(existsSync(snapshotDirectory)).toBe(false);
    } finally {
      iterator.return?.();
      try {
        repo.close();
      } catch {
        // Preserve the assertion failure; the exact directory is removed below.
      }
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  });

  it('retains cleanup state after an injected close failure and succeeds on retry', () => {
    const root = temporaryRoot('forge-readonly-injected-close-');
    const dbPath = join(root, 'forge.db');
    const database = new Database(dbPath);
    createCaseTable(database);
    database.close();
    const repo = new SqliteRepository(dbPath, { readonly: true });
    const internals = repo as unknown as {
      db: Database.Database;
      readonlySnapshotDirectory: string | null;
    };
    const snapshotDirectory = internals.readonlySnapshotDirectory!;
    const realClose = internals.db.close.bind(internals.db);
    let injected = true;
    internals.db.close = () => {
      if (injected) throw new Error('injected SQLite close failure');
      return realClose();
    };

    try {
      expect(() => repo.close()).toThrow('injected SQLite close failure');
      expect(internals.readonlySnapshotDirectory).toBe(snapshotDirectory);
      expect(existsSync(snapshotDirectory)).toBe(true);

      injected = false;
      expect(() => repo.close()).not.toThrow();
      expect(internals.readonlySnapshotDirectory).toBeNull();
      expect(existsSync(snapshotDirectory)).toBe(false);
    } finally {
      injected = false;
      try {
        repo.close();
      } catch {
        // Preserve the assertion failure; the exact directory is removed below.
      }
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  });
});
