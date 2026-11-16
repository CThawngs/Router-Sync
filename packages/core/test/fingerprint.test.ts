/**
 * packages/core/test/fingerprint.test.ts
 *
 * Tests for SchemaFingerprinter (AT-97):
 *  - Matching schema passes
 *  - Missing required column throws SchemaError
 *  - Wrong column type affinity throws SchemaError
 *  - Extra nullable column generates warning, does not block
 *  - Extra NOT NULL column with no default blocks write
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  openBetterSqlite3,
  fingerprint,
  assertFingerprint,
  SchemaError,
  type TableSpec,
} from '../src/index.js';

describe('SchemaFingerprinter (AT-97)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `fingerprint_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDbPath)) {
      try {
        fs.unlinkSync(tmpDbPath);
      } catch {
        // ignore
      }
    }
  });

  const sampleSpec: TableSpec[] = [
    {
      tableName: 'combos',
      requiredColumns: [
        { name: 'id', type: 'TEXT', required: true },
        { name: 'name', type: 'TEXT', required: true },
        { name: 'data', type: 'TEXT', required: true },
        { name: 'sort_order', type: 'INTEGER', required: true },
      ],
    },
  ];

  it('passes on an exact matching schema', () => {
    const db = openBetterSqlite3(tmpDbPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
    `);

    const result = fingerprint(db, sampleSpec);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.logHash).toBeTypeOf('string');
    expect(result.logHash.length).toBeGreaterThan(0);
    expect(() => assertFingerprint(db, sampleSpec)).not.toThrow();
    db.close();
  });

  it('rejects when a required column is missing (AT-97)', () => {
    const db = openBetterSqlite3(tmpDbPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    const result = fingerprint(db, sampleSpec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.column === 'data')).toBe(true);
    expect(result.issues.some((i) => i.column === 'sort_order')).toBe(true);

    expect(() => assertFingerprint(db, sampleSpec)).toThrow(SchemaError);
    db.close();
  });

  it('rejects when column type affinity is mismatched (AT-97)', () => {
    const db = openBetterSqlite3(tmpDbPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data BLOB NOT NULL,
        sort_order INTEGER NOT NULL
      );
    `);

    const result = fingerprint(db, sampleSpec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.column === 'data' && i.message.includes('affinity'))).toBe(true);
    expect(() => assertFingerprint(db, sampleSpec)).toThrow(SchemaError);
    db.close();
  });

  it('allows extra nullable column or column with default, flagging warning only (AT-97)', () => {
    const db = openBetterSqlite3(tmpDbPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        tags TEXT DEFAULT NULL,
        priority INTEGER DEFAULT 10
      );
    `);

    const result = fingerprint(db, sampleSpec);
    expect(result.ok).toBe(true);
    expect(result.extraColumns).toHaveLength(2);
    expect(result.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(() => assertFingerprint(db, sampleSpec)).not.toThrow();
    db.close();
  });

  it('rejects extra column that is NOT NULL with no default (AT-97 write protection)', () => {
    const db = openBetterSqlite3(tmpDbPath);
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        mystery_mandatory_column TEXT NOT NULL
      );
    `);

    const result = fingerprint(db, sampleSpec);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.column === 'mystery_mandatory_column' && i.severity === 'error'
      )
    ).toBe(true);
    expect(() => assertFingerprint(db, sampleSpec)).toThrow(SchemaError);
    db.close();
  });
});
