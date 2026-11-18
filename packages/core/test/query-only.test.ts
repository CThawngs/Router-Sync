import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '../src/index.js';
import { openReadOnlyDb } from '../src/readonly.js';

describe('C14 (c): query_only on read-only connections', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-query-only-'));
    dbPath = path.join(dir, 't.sqlite');
    const db = openBetterSqlite3(dbPath, { restrictToDir: dir });
    db.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a');");
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('openBetterSqlite3 readOnly:true enables query_only', () => {
    const db = openBetterSqlite3(dbPath, { readOnly: true });
    try {
      expect(db.pragma('query_only')).toBe(1);
      expect(() => db.prepare("INSERT INTO t VALUES ('b')").run()).toThrow();
    } finally { db.close(); }
  });

  it('openBetterSqlite3 writable connection leaves query_only off', () => {
    const db = openBetterSqlite3(dbPath, { restrictToDir: dir });
    try {
      expect(db.pragma('query_only')).toBe(0);
    } finally { db.close(); }
  });

  it('openReadOnlyDb enables query_only', () => {
    const db = openReadOnlyDb(dbPath, { timeoutMs: 1000 });
    try {
      expect(db.pragma('query_only', { simple: true })).toBe(1);
    } finally { db.close(); }
  });
});
