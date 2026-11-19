import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRouterModelState, openBetterSqlite3 } from '@routersync/core';
import { buildStaleReport, classifyComboStep } from '../src/commands/combos-stale.js';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c19-stale-'));
  return path.join(dir, 'data.sqlite');
}

function readableDb(): string {
  const dbPath = tmpDb();
  const db = openBetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE _meta (key TEXT, value TEXT);
    INSERT INTO _meta VALUES ('appVersion', '0.5.119');
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
    CREATE TABLE providerConnections (provider TEXT, name TEXT, data TEXT);
    INSERT INTO providerConnections VALUES ('alpha', 'a1', '{"providerSpecificData":{"enabledModels":["known"]}}');
    INSERT INTO combos VALUES ('c1', 'agent', '["alpha/known", "alpha/missing", "beta/custom-one"]');
  `);
  db.close();
  return dbPath;
}

describe('C19 W7 (G1/G2): unreadable router evidence is UNKNOWN, never a clean report', () => {
  it('reads a healthy database and reports diagnostics', () => {
    const dbPath = readableDb();
    const state = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });

    expect(state.diagnostics.dbResolved).toBe(true);
    expect(state.diagnostics.dbOpened).toBe(true);
    expect(state.diagnostics.missingTables).toEqual([]);
    expect(state.diagnostics.availabilitySource).toBe('direct');
    expect(state.diagnostics.dbName).toBe('data.sqlite');

    const report = buildStaleReport(['9router'], new Map([['9router', state]]), 'direct');
    expect(report.status).toBe('OK');
    expect(report.unavailable).toEqual([]);
    expect(report.counts.PRESENT).toBe(1);
    expect(report.counts.ABSENT).toBe(1);
  });

  it('missing database file -> UNKNOWN with a reason and no rows', () => {
    const dbPath = path.join(path.dirname(tmpDb()), 'does-not-exist.sqlite');
    const state = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });

    expect(state.diagnostics.dbOpened).toBe(false);
    const report = buildStaleReport(['9router'], new Map([['9router', state]]), 'direct');
    expect(report.status).toBe('UNKNOWN');
    expect(report.unavailable[0]?.reason).toMatch(/could not be opened/);
    expect(report.rows).toEqual([]);
    expect(report.counts.ABSENT).toBe(0);
  });

  it('corrupt database file -> UNKNOWN with a reason and no rows', () => {
    const dbPath = tmpDb();
    fs.writeFileSync(dbPath, 'not a sqlite database at all');
    const state = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });

    // SQLite can open the handle lazily and only fail on the first query, so
    // the contract is the report status, not dbOpened.
    expect(state.diagnostics.missingTables.join(',')).toMatch(/unreadable/);
    const report = buildStaleReport(['9router'], new Map([['9router', state]]), 'direct');
    expect(report.status).toBe('UNKNOWN');
    expect(report.rows).toEqual([]);
  });
});

describe('C19 W7 (G3): UNVERIFIABLE is separate from ABSENT', () => {
  it('custom provider without connection evidence is UNVERIFIABLE, not ABSENT', () => {
    const dbPath = readableDb();
    const state = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });

    const report = buildStaleReport(['9router'], new Map([['9router', state]]), 'direct');
    const beta = report.rows.find((row) => row.step === 'beta/custom-one');
    expect(beta?.status).toBe('UNVERIFIABLE');
    expect(report.counts.UNVERIFIABLE).toBe(1);
    expect(report.note).toContain('UNVERIFIABLE');
  });

  it('provider with evidence still reports ABSENT for a missing model', () => {
    const dbPath = readableDb();
    const state = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });
    expect(classifyComboStep('alpha/missing', state)).toBe('ABSENT');
  });
});
