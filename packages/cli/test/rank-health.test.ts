/**
 * packages/cli/test/rank-health.test.ts
 *
 * Tests K3: 7-day health query logic for 9Router and OmniRoute.
 * Verifies handling of both ISO 8601 string timestamps (with 'T') and epoch timestamps (ms/s),
 * as well as unrecognized types returning UNKNOWN.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '@routersync/core';
import { compute7DayHealthFromDb } from '../src/commands/rank.js';

describe('K3: compute7DayHealthFromDb', () => {
  const tempFiles: string[] = [];

  function createTempDb(): { db: ReturnType<typeof openBetterSqlite3>; path: string } {
    const p = path.join(os.tmpdir(), `test-health-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    tempFiles.push(p);
    const db = openBetterSqlite3(p);
    return { db, path: p };
  }

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
    tempFiles.length = 0;
  });

  it('handles 9Router with ISO 8601 string timestamps', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp TEXT, status TEXT);
        INSERT INTO usageHistory (timestamp, status) VALUES
          ('${new Date().toISOString()}', 'ok'),
          ('${new Date(Date.now() - 2 * 86400 * 1000).toISOString()}', 'ok'),
          ('${new Date(Date.now() - 30 * 86400 * 1000).toISOString()}', 'ok');
      `);

      const health = compute7DayHealthFromDb(db, '9router');
      expect(health).toContain('2 request trong 7 ngày');
    } finally {
      db.close();
    }
  });

  it('handles 9Router with epoch milliseconds timestamps', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp INTEGER, status TEXT);
        INSERT INTO usageHistory (timestamp, status) VALUES
          (${Date.now()}, 'ok'),
          (${Date.now() - 86400 * 1000}, 'ok'),
          (${Date.now() - 20 * 86400 * 1000}, 'ok');
      `);

      const health = compute7DayHealthFromDb(db, '9router');
      expect(health).toContain('2 request trong 7 ngày');
    } finally {
      db.close();
    }
  });

  it('handles 9Router with epoch seconds timestamps', () => {
    const { db } = createTempDb();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp INTEGER, status TEXT);
        INSERT INTO usageHistory (timestamp, status) VALUES
          (${nowSec}, 'ok'),
          (${nowSec - 86400}, 'ok'),
          (${nowSec - 20 * 86400}, 'ok');
      `);

      const health = compute7DayHealthFromDb(db, '9router');
      expect(health).toContain('2 request trong 7 ngày');
    } finally {
      db.close();
    }
  });

  it('calculates error rate for 9Router when usageHistory records non-ok status', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp TEXT, status TEXT);
        INSERT INTO usageHistory (timestamp, status) VALUES
          ('${new Date().toISOString()}', 'ok'),
          ('${new Date(Date.now() - 86400 * 1000).toISOString()}', 'error'),
          ('${new Date(Date.now() - 20 * 86400 * 1000).toISOString()}', 'ok');
      `);

      const health = compute7DayHealthFromDb(db, '9router');
      expect(health).toContain('1/2 thành công (50.0%)');
    } finally {
      db.close();
    }
  });

  it('handles OmniRoute with ISO 8601 string timestamps and integer status', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE call_logs (id TEXT PRIMARY KEY, timestamp TEXT, status INTEGER);
        INSERT INTO call_logs (id, timestamp, status) VALUES
          ('1', '${new Date().toISOString()}', 200),
          ('2', '${new Date(Date.now() - 86400 * 1000).toISOString()}', 500),
          ('3', '${new Date(Date.now() - 20 * 86400 * 1000).toISOString()}', 200);
      `);

      const health = compute7DayHealthFromDb(db, 'omniroute');
      expect(health).toContain('1/2 thành công (50.0%)');
    } finally {
      db.close();
    }
  });

  it('handles OmniRoute with epoch milliseconds timestamps', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE call_logs (id TEXT PRIMARY KEY, timestamp INTEGER, status INTEGER);
        INSERT INTO call_logs (id, timestamp, status) VALUES
          ('1', ${Date.now()}, 200),
          ('2', ${Date.now() - 86400 * 1000}, 200),
          ('3', ${Date.now() - 20 * 86400 * 1000}, 500);
      `);

      const health = compute7DayHealthFromDb(db, 'omniroute');
      expect(health).toContain('2/2 thành công (100.0%)');
    } finally {
      db.close();
    }
  });

  it('returns UNKNOWN when timestamp type is unrecognized (e.g. BLOB)', () => {
    const { db } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE usageHistory (id INTEGER PRIMARY KEY, timestamp BLOB, status TEXT);
        INSERT INTO usageHistory (timestamp, status) VALUES
          (X'DEADBEEF', 'ok');
      `);

      const health = compute7DayHealthFromDb(db, '9router');
      expect(health).toBe('UNKNOWN');
    } finally {
      db.close();
    }
  });

  it('returns UNKNOWN when required tables or columns are missing', () => {
    const { db } = createTempDb();
    try {
      db.exec(`CREATE TABLE wrong_table (id INTEGER PRIMARY KEY);`);
      expect(compute7DayHealthFromDb(db, '9router')).toBe('UNKNOWN');
      expect(compute7DayHealthFromDb(db, 'omniroute')).toBe('UNKNOWN');
    } finally {
      db.close();
    }
  });
});
