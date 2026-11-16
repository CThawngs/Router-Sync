import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { readRouterCombosCount } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

describe('Acceptance Test AT-122: Read-Only DB Safety & Lock Degradation (B-2 / B-3)', () => {
  // R11-0: hermetic fixture — tmp SQLite DB (1 combo `routersync-fast`), explicit
  // env overrides, restored after the suite. No real router DB is ever touched.
  let fixture: DaemonFixture | undefined;
  let testDbPath: string;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
    testDbPath = fixture.omniDbPath;
  });

  afterAll(() => {
    fixture?.restore();
  });

  function getFileHash(p: string): string {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  it('guarantees ZERO file modification and NO wal/shm creation on read (B-3)', () => {
    const statBefore = fs.statSync(testDbPath);
    const hashBefore = getFileHash(testDbPath);

    const walFile = `${testDbPath}-wal`;
    const shmFile = `${testDbPath}-shm`;
    expect(fs.existsSync(walFile)).toBe(false);
    expect(fs.existsSync(shmFile)).toBe(false);

    // Perform read via daemon db reader
    const result = readRouterCombosCount('omniroute');
    expect(result.ok).toBe(true);
    expect(result.data?.count).toBe(1);

    const statAfter = fs.statSync(testDbPath);
    const hashAfter = getFileHash(testDbPath);

    // Strictly identical hash and size
    expect(statAfter.size).toBe(statBefore.size);
    expect(hashAfter).toBe(hashBefore);

    // No temporary journal or wal/shm artifacts created
    expect(fs.existsSync(walFile)).toBe(false);
    expect(fs.existsSync(shmFile)).toBe(false);
  });

  it('handles database lock contention as soft degradation (db_busy) without crashing (B-2)', () => {
    // Acquire an exclusive lock with a separate connection
    const lockingDb = new DatabaseSync(testDbPath);
    lockingDb.exec('BEGIN EXCLUSIVE;');

    try {
      // Reader attempts to read while locked
      const result = readRouterCombosCount('omniroute');

      // Must catch the lock contention and report soft unavailable status
      if (!result.ok) {
        expect(result.meta.source).toBe('unavailable');
        expect(['db_busy', 'db_unreadable']).toContain(result.meta.reason);
      } else {
        // SQLite may allow shared reads depending on journal mode, which is also safe
        expect(result.data?.count).toBe(1);
      }
    } finally {
      lockingDb.exec('ROLLBACK;');
      lockingDb.close();
    }
  });
});
