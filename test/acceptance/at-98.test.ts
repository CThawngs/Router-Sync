/**
 * test/acceptance/at-98.test.ts
 *
 * Acceptance Test AT-98:
 * Serving-path read-back with simulated stale cache:
 *  - Write to DB succeeds
 *  - API read-back observes stale cache (old data)
 *  - Detected as STALE -> automatic rollback triggered
 *  - If cache invalidates / matches within retry window -> succeeds
 *  - Router with no serving path declares degraded status clearly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import type { Plan } from '@routersync/adapter-sdk';

function computeOmniLogicHash(dbPath: string): string {
  const db = openBetterSqlite3(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, name, sort_order, system_message FROM combos ORDER BY id ASC').all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally {
    db.close();
  }
}

describe('Acceptance Test AT-98: Serving-Path Read-Back & Stale Cache Detection', () => {
  let tmpOmniPath: string;
  let tmpNinePath: string;

  beforeEach(() => {
    tmpOmniPath = path.join(
      os.tmpdir(),
      `at98_omni_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpNinePath = path.join(
      os.tmpdir(),
      `at98_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );

    // Initialize OmniRoute valid schema
    const omniDb = openBetterSqlite3(tmpOmniPath);
    omniDb.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        system_message TEXT DEFAULT NULL
      );
    `);
    omniDb.close();

    // Initialize 9Router valid schema
    const nineDb = openBetterSqlite3(tmpNinePath);
    nineDb.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      INSERT INTO settings (id, data) VALUES (1, '{}');
    `);
    nineDb.close();
  });

  afterEach(() => {
    for (const f of [tmpOmniPath, tmpNinePath]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  });

  it('OmniRoute: detects STALE when API serving-path returns old cache, fails with stale error', async () => {
    // Mock API that continues returning empty array (simulating stale cache)
    const mockStaleFetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      apiKey: 'test-token',
      readBackTtlWaitMs: 0, // Instant for unit test
      fetchFn: mockStaleFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_stale',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-cached',
          name: 'Cached Combo',
          strategy: 'priority',
          models: ['model-1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(false);
    expect(res.staleDetected).toBe(true);
    expect(res.readBackLevel).toBe('full');
    expect(res.error).toMatch(/STALE/i);
  });

  it('OmniRoute: verifies full read-back when API serving-path returns updated combo', async () => {
    // Mock API that returns the updated combo
    const mockFreshFetch = async () =>
      new Response(JSON.stringify([{ name: 'Cached Combo' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      apiKey: 'test-token',
      readBackTtlWaitMs: 0,
      fetchFn: mockFreshFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_fresh',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-cached',
          name: 'Cached Combo',
          strategy: 'priority',
          models: ['model-1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.staleDetected).toBe(false);
    expect(res.readBackVerified).toBe(true);
    expect(res.readBackLevel).toBe('full');
  });

  it('OmniRoute: falls back to existence-only via /v1/models when /api/combos is 404', async () => {
    const mockFallbackFetch = async (url: string) => {
      if (url.includes('/api/combos')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'Cached Combo' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Error', { status: 500 });
    };

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      apiKey: 'test-token',
      readBackTtlWaitMs: 0,
      fetchFn: mockFallbackFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_omni_existence',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-cached',
          name: 'Cached Combo',
          strategy: 'priority',
          models: ['model-1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackVerified).toBe(true);
    expect(res.readBackLevel).toBe('existence-only');
  });

  it('OmniRoute: verifies full read-back against real envelope fixture where items only have id (no name)', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/omniroute-api-combos.json');
    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const mockFixtureFetch = async (url: string) => {
      if (url.includes('/api/combos')) {
        return new Response(JSON.stringify(fixtureData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      apiKey: 'admin-token',
      readBackTtlWaitMs: 0,
      fetchFn: mockFixtureFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_real_envelope',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'sample-agent-combo',
          name: 'Sample-Agent-Combo',
          strategy: 'priority',
          models: ['model-sample-1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackVerified).toBe(true);
    expect(res.readBackLevel).toBe('full');
  });

  it('OmniRoute: read-back id mismatch triggers rollback restoring exact pre-write logic hash', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/omniroute-api-combos.json');
    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    // Compute pre-write logic hash
    const hashBefore = computeOmniLogicHash(tmpOmniPath);

    const mockFixtureFetch = async (url: string) => {
      if (url.includes('/api/combos')) {
        return new Response(JSON.stringify(fixtureData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      apiKey: 'admin-token',
      readBackTtlWaitMs: 0,
      fetchFn: mockFixtureFetch as unknown as typeof fetch,
    });

    const snapshot = await adapter.createSnapshot();

    const plan: Plan = {
      id: 'plan_at98_mismatch_rollback',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'unmatched-combo-id-999',
          name: 'OmniRoute-Agent-2', // Name matches fixture item, but id does not!
          strategy: 'priority',
          models: ['model-sample-1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(false);
    expect(res.staleDetected).toBe(true);
    expect(res.error).toMatch(/unmatched-combo-id-999/);

    // Rollback
    const rolledBack = await adapter.rollback(snapshot);
    expect(rolledBack).toBe(true);

    const hashAfter = computeOmniLogicHash(tmpOmniPath);
    expect(hashAfter).toBe(hashBefore);
  });

  it('9Router: verifies existence-only read-back when /v1/models returns added combo', async () => {
    const mockModelsFetch = async (url: string) => {
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'Nine C1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Error', { status: 500 });
    };

    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      fetchFn: mockModelsFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_nine_existence',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'nine-c1',
          name: 'Nine C1',
          strategy: 'round-robin',
          models: ['m1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackVerified).toBe(true);
    expect(res.readBackLevel).toBe('existence-only');
    expect(res.ttlStatus).toBe('verified-immediate');
  });

  it('9Router: detects STALE when /v1/models is missing the added combo', async () => {
    const mockEmptyModelsFetch = async (url: string) => {
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Error', { status: 500 });
    };

    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      fetchFn: mockEmptyModelsFetch as unknown as typeof fetch,
      // STALE-after-poll: mock keeps returning 200-but-not-listed; the adapter
      // polls until the wait ceiling (owner brief §4a). Short ceiling in tests;
      // production default is 60000 ms (>= 60 s).
      servingWaitMs: 100,
    });

    const plan: Plan = {
      id: 'plan_at98_nine_stale',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'nine-c1',
          name: 'Nine C1',
          strategy: 'round-robin',
          models: ['m1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(false);
    expect(res.staleDetected).toBe(true);
    expect(res.readBackLevel).toBe('existence-only');
    expect(res.error).toMatch(/STALE/i);
  });

  it('9Router: flags db-only degraded status clearly when API is unreachable', async () => {
    const mockFailingFetch = async () => {
      throw new Error('Connection refused');
    };

    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      fetchFn: mockFailingFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at98_nine_degraded',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'nine-c1',
          name: 'Nine C1',
          strategy: 'round-robin',
          models: ['m1'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const res = await adapter.applyPlan(plan);
    expect(res.success).toBe(true);
    expect(res.readBackLevel).toBe('db-only (degraded)');
    expect(res.degradedReason).toBe('no-api-path');
    expect(res.ttlStatus).toBe('immediate-assumed');
  });
});
