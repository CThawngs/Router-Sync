import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRouterModelState, openBetterSqlite3 } from '@routersync/core';
import {
  buildStaleReport,
  classifyComboStep,
  runCombosStaleCommand,
  serializeStaleReport,
  serializeStaleReportJson,
} from '../src/commands/combos-stale.js';

function state(overrides: Record<string, unknown> = {}) {
  return {
    router: '9router',
    enabledModels: new Set<string>(),
    disabledModels: new Set<string>(),
    comboModels: new Set<string>(),
    customModels: new Set<string>(),
    catalogModels: new Set<string>(),
    availableModels: new Set<string>(),
    connectionEnabledModels: new Set<string>(),
    availabilityProviders: new Set<string>(),
    classify: () => ({ tier: 'A', inCombo: true, inconsistent: false }),
    diagnostics: {
      dbResolved: true,
      dbOpened: true,
      missingTables: [],
      parseErrors: 0,
      versionMismatch: false,
      availabilitySource: 'direct',
      dbName: 'data.sqlite',
    },
    ...overrides,
  } as never;
}

function readableDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c20-stale-'));
  const dbPath = path.join(dir, 'data.sqlite');
  const db = openBetterSqlite3(dbPath);
  db.exec(`
    CREATE TABLE _meta (key TEXT, value TEXT);
    INSERT INTO _meta VALUES ('appVersion', '0.5.119');
    CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    CREATE TABLE combos (id TEXT, name TEXT, models TEXT);
    CREATE TABLE providerConnections (provider TEXT, name TEXT, data TEXT);
    INSERT INTO providerConnections VALUES ('alpha', 'a1', '{"providerSpecificData":{"enabledModels":["known"]}}');
    INSERT INTO kv VALUES ('disabledModels', 'gemini', '["gemini-pro"]');
    INSERT INTO combos VALUES ('c1', 'agent', '["alpha/known", "alpha/missing", "beta/custom-one", "gemini/gemini-pro"]');
  `);
  db.close();
  return dbPath;
}

describe('C20 X3.2: DISABLED comes from the router disabledModels evidence', () => {
  it('reports DISABLED when the router lists the model as disabled', () => {
    const dbPath = readableDb();
    const routerState = readRouterModelState('9router', { dbPath, availabilitySource: 'direct' });

    expect(routerState.disabledModels.has('gemini/gemini-pro')).toBe(true);
    expect(classifyComboStep('gemini/gemini-pro', routerState)).toBe('DISABLED');

    const report = buildStaleReport(['9router'], new Map([['9router', routerState]]), 'direct');
    expect(report.counts.DISABLED).toBeGreaterThan(0);
  });

  it('still separates UNVERIFIABLE from ABSENT', () => {
    const routerState = state({
      availableModels: new Set(['alpha/known']),
      availabilityProviders: new Set(['alpha']),
    });
    expect(classifyComboStep('alpha/missing', routerState)).toBe('ABSENT');
    expect(classifyComboStep('beta/custom-one', routerState)).toBe('UNVERIFIABLE');
  });
});

const sampleReport = {
  generatedAt: '2026-11-19T00:00:00.000Z',
  status: 'OK' as const,
  unavailable: [],
  source: 'direct' as const,
  note: 'note',
  routers: ['9router'],
  omittedRouters: [],
  rows: [{ router: '9router', step: 'alpha/known', status: 'PRESENT' as const }],
  counts: { PRESENT: 1, 'PRESENT-NORMALIZED': 0, DISABLED: 0, ABSENT: 0, UNVERIFIABLE: 0 },
};

describe('C20 X3.3: the evidence source is always printed', () => {
  it('text output starts with the source line', () => {
    expect(serializeStaleReport(sampleReport).split('\n')[0]).toBe('source=direct');
  });

  it('json output carries the source field', () => {
    expect(JSON.parse(serializeStaleReportJson(sampleReport)).source).toBe('direct');
  });

  it('the command logs the source in text mode and in json mode', async () => {
    const dbPath = readableDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.env.ROUTERSYNC_9ROUTER_DB;
    process.env.ROUTERSYNC_9ROUTER_DB = dbPath;
    try {
      // Text mode is the default (no --json flag); passing json:false prints nothing.
      await runCombosStaleCommand({ router: '9router', source: 'direct' });
      const text = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(text.split('\n')[0]).toBe('source=direct');

      log.mockClear();
      await runCombosStaleCommand({ router: '9router', source: 'direct', json: true });
      const json = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(JSON.parse(json).source).toBe('direct');
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.ROUTERSYNC_9ROUTER_DB;
      else process.env.ROUTERSYNC_9ROUTER_DB = previous;
    }
  });
});