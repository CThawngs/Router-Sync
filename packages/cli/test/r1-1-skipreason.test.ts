/**
 * packages/cli/test/r1-1-skipreason.test.ts
 *
 * Dedicated test for R1.1:
 * Verified 3-cycle sequence:
 * Cycle 1: 429 sets skipReason and verify marks the model 'CHƯA-QUÉT' (unscanned).
 * Cycle 2: 304 clears skipReason (undefined) and verify marks the model 'ĐÃ-XÁC-NHẬN-CÒN'.
 * Cycle 3: 200 with unchanged hash keeps skipReason cleared (undefined) and verify marks the model 'ĐÃ-XÁC-NHẬN-CÒN'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTickCommand } from '../src/commands/tick.js';
import { runVerifyCommand } from '../src/commands/verify.js';
import { openBetterSqlite3 } from '@routersync/core';
import { clearInstalledRouterDbPaths } from '../src/config/loader.js';

describe('R1.1: skipReason reset on 304 and unchanged-hash branches', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-r1-1-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    dbPath = path.join(tmpDir, '9router-data.sqlite');

    // Create fake 9Router DB with 1 combo and 1 provider
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
      JSON.stringify(['fake-r1/model-alpha']),
      nowIso,
      nowIso
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, name, authType, isActive, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-fake-r1',
      'fake-r1',
      'Fake R1 Provider',
      'apikey',
      1,
      JSON.stringify({
        apiKey: 'sk-fake-secret',
        baseUrl: 'https://api.fake-r1.example/v1',
        prefix: 'fake-r1',
      })
    );
    db.close();

    // Create config.yaml pointing to this DB and combo
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

    // Seed baseline in tick-catalog.json
    const catalogPath = path.join(stateDir, 'tick-catalog.json');
    const realHash = '2446f2cd6f782eac';
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        updatedAt: nowIso,
        providers: {
          'fake-r1': {
            prefix: 'fake-r1',
            router: '9router-test',
            contentHash: realHash,
            serverEtag: '"etag-v1"',
            hash: realHash,
            ids: ['model-alpha'],
            absenceCounts: {},
            firstAbsentAt: {},
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

  it('Cycle 1 (429) -> Cycle 2 (304) -> Cycle 3 (200 unchanged hash)', async () => {
    const catalogPath = path.join(stateDir, 'tick-catalog.json');
    const statusPath = path.join(stateDir, 'status.json');

    // ========================================================
    // Cycle 1: Provider returns 429
    // ========================================================
    const fetchCycle1 = async (url: string | URL | Request) => {
      return new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await runTickCommand({
      configPath,
      stateDir,
      nowMs: Date.parse('2026-11-15T10:00:00.000Z'),
      fetchFn: fetchCycle1 as unknown as typeof fetch,
      mode: 'propose',
    });

    const cat1 = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    expect(cat1.providers['fake-r1'].skipReason).toBe('QUOTA');
    expect(cat1.providers['fake-r1'].lastStatus).toBe(429);

    const st1 = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const pSt1 = st1.providers.find((p: { prefix: string }) => p.prefix === 'fake-r1');
    expect(pSt1.skipReason).toBe('QUOTA');

    const mockVerifyFetch = async () => new Response('Not found', { status: 404 });

    // Verify phase check: model is marked CHƯA-QUÉT due to provider skipReason
    const v1 = await runVerifyCommand({ configPath, stateDir, fetchFn: mockVerifyFetch as unknown as typeof fetch });
    const r1 = v1.records.find((r) => r.fullStep === 'fake-r1/model-alpha');
    expect(r1).toBeDefined();
    expect(r1?.label).toBe('CHƯA-QUÉT');
    expect(r1?.unscannedReason).toBe('QUOTA');

    // ========================================================
    // Cycle 2: Provider returns 304 Not Modified
    // ========================================================
    const fetchCycle2 = async (url: string | URL | Request) => {
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag-v1"' },
      });
    };

    await runTickCommand({
      configPath,
      stateDir,
      nowMs: Date.parse('2026-11-15T10:15:00.000Z'),
      fetchFn: fetchCycle2 as unknown as typeof fetch,
      mode: 'propose',
    });

    const cat2 = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    expect(cat2.providers['fake-r1'].skipReason).toBeUndefined();
    expect(cat2.providers['fake-r1'].lastStatus).toBe(304);
    expect(cat2.providers['fake-r1'].lastLabel).toBe('UNCHANGED');

    const st2 = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const pSt2 = st2.providers.find((p: { prefix: string }) => p.prefix === 'fake-r1');
    expect(pSt2.status).toBe(304);
    expect(pSt2.label).toBe('UNCHANGED');

    // Verify phase check: skipReason cleared, model is now ĐÃ-XÁC-NHẬN-CÒN
    const v2 = await runVerifyCommand({ configPath, stateDir, fetchFn: mockVerifyFetch as unknown as typeof fetch });
    const r2 = v2.records.find((r) => r.fullStep === 'fake-r1/model-alpha');
    expect(r2).toBeDefined();
    expect(r2?.label).toBe('ĐÃ-XÁC-NHẬN-CÒN');
    expect(r2?.unscannedReason).toBeUndefined();

    // Re-poison skipReason in catalog to test Cycle 3 unchanged hash clearing
    const catPoison = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    catPoison.providers['fake-r1'].skipReason = 'incomplete-pagination';
    fs.writeFileSync(catalogPath, JSON.stringify(catPoison), 'utf8');

    // ========================================================
    // Cycle 3: Provider returns 200 with identical model list
    // ========================================================
    const fetchCycle3 = async (url: string | URL | Request) => {
      return new Response(JSON.stringify({ data: [{ id: 'model-alpha' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"etag-v1"' },
      });
    };

    await runTickCommand({
      configPath,
      stateDir,
      nowMs: Date.parse('2026-11-15T10:30:00.000Z'),
      fetchFn: fetchCycle3 as unknown as typeof fetch,
      mode: 'propose',
    });

    const cat3 = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    expect(cat3.providers['fake-r1'].skipReason).toBeUndefined();
    expect(cat3.providers['fake-r1'].lastStatus).toBe(200);
    expect(cat3.providers['fake-r1'].lastLabel).toBe('UNCHANGED');

    const st3 = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const pSt3 = st3.providers.find((p: { prefix: string }) => p.prefix === 'fake-r1');
    expect(pSt3.skipReason).toBeUndefined();

    // Verify phase check: skipReason cleared, model is ĐÃ-XÁC-NHẬN-CÒN
    const v3 = await runVerifyCommand({ configPath, stateDir, fetchFn: mockVerifyFetch as unknown as typeof fetch });
    const r3 = v3.records.find((r) => r.fullStep === 'fake-r1/model-alpha');
    expect(r3).toBeDefined();
    expect(r3?.label).toBe('ĐÃ-XÁC-NHẬN-CÒN');
    expect(r3?.unscannedReason).toBeUndefined();
  });
});
