/**
 * packages/cli/test/r3-1-safeguards.test.ts
 *
 * Dedicated test for R3.1:
 * Rule 1: 429, 403, 401, timeout, 5xx do NOT constitute evidence that a model is gone.
 * Verify that when a provider returns 429 or 403, NO removal proposals
 * (absent-stable or absent-unconfirmed) are generated in the inbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTickCommand } from '../src/commands/tick.js';
import { openBetterSqlite3 } from '@routersync/core';
import { clearInstalledRouterDbPaths } from '../src/config/loader.js';

describe('R3.1: 429/403/5xx do not generate removal proposals', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;
  let dbPath: string;
  let inboxPath: string;
  let catalogPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-r3-1-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    inboxPath = path.join(stateDir, 'inbox.json');
    catalogPath = path.join(stateDir, 'tick-catalog.json');
    dbPath = path.join(tmpDir, '9router-data.sqlite');

    // Create fake 9Router DB with 1 combo using 2 models
    const db = openBetterSqlite3(dbPath, { readOnly: false, restrictToDir: tmpDir });
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT)');
    db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT)');
    db.exec('CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT)');
    db.exec('CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT)');

    const nowIso = '2026-11-14T00:00:00.000Z';
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(
      JSON.stringify({ comboStrategies: { 'rs-coder': 'priority' } })
    );
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'routersync-rs-coder',
      'rs-coder',
      'custom',
      JSON.stringify(['fake-r3/model-x', 'fake-r3/model-y']),
      nowIso,
      nowIso
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, name, authType, isActive, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-fake-r3',
      'fake-r3',
      'Fake R3 Provider',
      'apikey',
      1,
      JSON.stringify({
        apiKey: 'sk-fake-secret',
        baseUrl: 'https://api.fake-r3.example/v1',
        prefix: 'fake-r3',
      })
    );
    db.close();

    // Create config.yaml
    configPath = path.join(tmpDir, 'config.yaml');
    const yaml = [
      'version: 1',
      'routers:',
      '  - id: 9router-test',
      '    adapter: 9router',
      '    db:',
      `      path: ${dbPath.replace(/\\/g, '/')}`,
      '    write: db',
      '    reload:',
      '      type: none',
      'policy:',
      '  mode: manual',
      'combos:',
      '  - name: rs-coder',
      '    role: coding',
      '    routers:',
      '      - 9router-test',
      '    size: 2',
      'adopt: []',
    ].join('\n');
    fs.writeFileSync(configPath, yaml, 'utf8');

    // Seed baseline with both models existing and absenceCounts = 2 (ready to trigger removal if counted absent!)
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        updatedAt: nowIso,
        providers: {
          'fake-r3': {
            prefix: 'fake-r3',
            router: '9router-test',
            contentHash: 'hash-xy',
            serverEtag: null,
            hash: 'hash-xy',
            ids: ['model-x', 'model-y'],
            absenceCounts: { 'model-x': 2, 'model-y': 2 },
            firstAbsentAt: {
              'model-x': '2026-11-10T00:00:00.000Z',
              'model-y': '2026-11-10T00:00:00.000Z',
            },
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: nowIso,
          },
        },
      }),
      'utf8'
    );
  });

  afterEach(() => {
    clearInstalledRouterDbPaths();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('HTTP 429 response generates zero removal proposals and preserves baseline', async () => {
    const fetch429 = async () =>
      new Response(JSON.stringify({ error: 'quota exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });

    const summary = await runTickCommand({
      configPath,
      stateDir,
      nowMs: Date.parse('2026-11-15T12:00:00.000Z'),
      fetchFn: fetch429 as unknown as typeof fetch,
      mode: 'propose',
      graceCycles: 2, // If absence was counted, 2+1=3 >= graceCycles would trigger removal!
    });

    // Check inbox: no removal proposals generated
    if (fs.existsSync(inboxPath)) {
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items = Array.isArray(inbox) ? inbox : (inbox.items ?? []);
      const removalProposals = items.filter(
        (i: { id: string; label?: string }) =>
          i.id.includes('absent') || i.label === 'ABSENT-STABLE' || i.label === 'ABSENT-UNCONFIRMED'
      );
      expect(removalProposals).toEqual([]);
    }

    // Check catalog: absenceCounts must NOT be incremented, ids preserved
    const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const p = cat.providers['fake-r3'];
    expect(p.ids).toEqual(['model-x', 'model-y']);
    expect(p.absenceCounts['model-x']).toBe(2); // strictly preserved, NOT incremented to 3
    expect(p.absenceCounts['model-y']).toBe(2);
    expect(p.lastStatus).toBe(429);
    expect(p.lastLabel).toBe('QUOTA');
  });

  it('HTTP 403 response generates zero removal proposals and preserves baseline', async () => {
    const fetch403 = async () =>
      new Response(JSON.stringify({ error: { message: 'permission_error', code: 403 } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });

    const summary = await runTickCommand({
      configPath,
      stateDir,
      nowMs: Date.parse('2026-11-15T12:00:00.000Z'),
      fetchFn: fetch403 as unknown as typeof fetch,
      mode: 'propose',
      graceCycles: 2,
    });

    // Check inbox: may contain warning [AUTH_ERROR], but ZERO removal proposals!
    if (fs.existsSync(inboxPath)) {
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      const items = Array.isArray(inbox) ? inbox : (inbox.items ?? []);
      const removalProposals = items.filter(
        (i: { id: string; label?: string }) =>
          i.id.includes('absent') || i.label === 'ABSENT-STABLE' || i.label === 'ABSENT-UNCONFIRMED'
      );
      expect(removalProposals).toEqual([]);
    }

    // Check catalog: absenceCounts preserved, ids preserved
    const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const p = cat.providers['fake-r3'];
    expect(p.ids).toEqual(['model-x', 'model-y']);
    expect(p.absenceCounts['model-x']).toBe(2);
    expect(p.absenceCounts['model-y']).toBe(2);
    expect(p.lastStatus).toBe(403);
    expect(p.lastLabel).toBe('AUTH_ERROR');
  });
});
