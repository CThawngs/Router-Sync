/**
 * packages/core/test/sqlite-concurrency.test.ts
 *
 * Verifies Condition A4 (T2-11, T2-12):
 *  - WAL mode and busy_timeout behaviour
 *  - BEGIN IMMEDIATE blocks concurrent writers
 *  - When timeout expires on lock contention, fails cleanly without corrupting the DB
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { openBetterSqlite3 } from '../src/index.js';

describe('SQLite Concurrency & Safe Write Protocol (Condition A4)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `concurrency_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    const db = openBetterSqlite3(tmpDbPath);
    // Initialize DB and enable WAL mode (as OmniRoute and 9Router do)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE test_data (
        id TEXT PRIMARY KEY,
        val INTEGER NOT NULL
      );
    `);
    db.close();
  });

  afterEach(() => {
    const files = [tmpDbPath, `${tmpDbPath}-wal`, `${tmpDbPath}-shm`];
    for (const f of files) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
    }
  });

  it('respects WAL mode and applies busy_timeout', () => {
    const db = openBetterSqlite3(tmpDbPath, { busyTimeoutMs: 3000 });
    const journalMode = db.pragma('journal_mode');
    expect(journalMode).toBe('wal');

    const timeout = db.pragma('busy_timeout');
    expect(Number(timeout)).toBe(3000);
    db.close();
  });

  it('handles write contention safely with BEGIN IMMEDIATE without corrupting database', () => {
    // Connection 1: opens with a short timeout
    const db1 = openBetterSqlite3(tmpDbPath, { busyTimeoutMs: 200 });
    // Connection 2: opens with a short timeout
    const db2 = openBetterSqlite3(tmpDbPath, { busyTimeoutMs: 200 });

    // Connection 1 begins an immediate write transaction and holds it open
    db1.exec('BEGIN IMMEDIATE;');
    db1.prepare('INSERT INTO test_data (id, val) VALUES (?, ?)').run('row-1', 100);

    // Connection 2 attempts an immediate transaction — should fail with SQLITE_BUSY after 200ms
    let db2FailedCleanly = false;
    try {
      db2.transaction(() => {
        db2.prepare('INSERT INTO test_data (id, val) VALUES (?, ?)').run('row-2', 200);
      });
    } catch (err) {
      db2FailedCleanly = true;
      expect(String(err)).toMatch(/busy|locked/i);
    }
    expect(db2FailedCleanly).toBe(true);

    // Connection 1 commits cleanly
    db1.exec('COMMIT;');
    db1.close();
    db2.close();

    // Reopen DB to verify integrity
    const dbVerify = openBetterSqlite3(tmpDbPath, { readOnly: true });
    const rows = dbVerify.prepare('SELECT id, val FROM test_data').all() as Array<{ id: string; val: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('row-1');
    expect(rows[0]?.val).toBe(100);

    // PRAGMA quick_check verifies no database corruption
    const integrity = dbVerify.pragma('quick_check');
    expect(integrity).toBe('ok');
    dbVerify.close();
  });
});
