/**
 * test/acceptance/at-113.test.ts
 *
 * Acceptance Test AT-113 (Gate R, 2026-10-15):
 *  - `dbPath` alone must NOT disable the /v1/models serving-path probe.
 *    Linux/Docker users who set db_path previously got silently degraded to
 *    db-only because `isCustomDbPath` gated probing.
 *  - Probing is disabled ONLY by the explicit isolation flag (`isolated: true`),
 *    used for fully isolated copies (tests, lab sandboxes).
 *  - Both branches are tested:
 *      A) isolated: true  → zero HTTP requests, db-only, written-pending-reload
 *      B) isolated: false (default) + custom fetch → probe happens,
 *         existence-only verified path works with a dbPath set.
 *
 * Evidence label: FIXTURE (fixture DB + mock fetch), Windows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import { RouterSyncConfigSchema } from '../../packages/cli/src/config/schema.js';
import type { Plan } from '@routersync/adapter-sdk';

const ORIGINAL_ENV = { ...process.env };
const KEY_VARS = [
  'NINEROUTER_CLIENT_KEY', 'NINEROUTER_ADMIN_KEY', 'NINEROUTER_API_KEY',
  'NINE_ROUTER_CLIENT_KEY', 'NINE_ROUTER_API_KEY',
];

describe('Acceptance Test AT-113: explicit isolation flag replaces isCustomDbPath probe gating', () => {
  let tmpNinePath: string;

  beforeEach(() => {
    for (const k of KEY_VARS) delete process.env[k];
    tmpNinePath = path.join(
      os.tmpdir(),
      `at113_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    const db = openBetterSqlite3(tmpNinePath);
    db.exec(`
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
    db.close();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    fs.rmSync(tmpNinePath, { force: true });
  });

  const makePlan = (id: string): Plan => ({
    id: `plan_at113_${id}`,
    target: '9router',
    timestamp: new Date().toISOString(),
    additions: [
      { id: 'at113_combo', name: 'AT113 Combo', strategy: 'fallback', models: ['provider/model-x'], managed: true },
    ],
    modifications: [],
    deletions: [],
    reasons: {},
  });

  it('branch A: isolated: true → zero HTTP probes, db-only, written-pending-reload', async () => {
    let fetchCalls = 0;
    const explodingFetch = (() => {
      fetchCalls++;
      throw new Error('PROBE MUST NOT HAPPEN when isolated: true');
    }) as unknown as typeof fetch;

    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      isolated: true,
      fetchFn: explodingFetch,
    });

    const res = await adapter.applyPlan(makePlan('iso'));
    expect(fetchCalls).toBe(0);
    expect(res.success).toBe(true);
    expect(res.readBackLevel).toBe('db-only (degraded)');
    expect(res.applyState).toBe('written-pending-reload');
  });

  it('branch B: dbPath WITHOUT isolated → probe happens; mock serving path verifies', async () => {
    let fetchCalls = 0;
    const mockFetch = (async (url: string) => {
      fetchCalls++;
      const u = String(url);
      if (u.includes('/api/health')) {
        return new Response('{"ok":true}', { status: 200 });
      }
      if (u.includes('/v1/models')) {
        // serving path lists the combo written by the adapter
        return new Response(
          JSON.stringify({ data: [{ id: 'at113_combo', object: 'model', owned_by: 'combo' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    // NOTE: dbPath is set and isolated is NOT set — probing must still happen.
    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      clientApiKey: 'canary-at113-client-key-0123456789',
      fetchFn: mockFetch,
    });

    const res = await adapter.applyPlan(makePlan('probe'));
    expect(fetchCalls).toBeGreaterThan(0);
    expect(res.success).toBe(true);
    expect(res.readBackLevel).toBe('existence-only');
    expect(res.applyState).toBe('verified');
  });

  it('config schema: isolated defaults to false; explicit true validates', () => {
    const def = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'nine', adapter: '9router' as const, db: { path: '/data/9router.sqlite' } }],
      policy: { mode: 'manual' },
    });
    expect(def.success).toBe(true);
    if (def.success) {
      expect(def.data.routers[0]?.isolated).toBe(false);
    }

    const iso = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'nine', adapter: '9router' as const, db: { path: '/data/9router.sqlite' }, isolated: true }],
      policy: { mode: 'manual' },
    });
    expect(iso.success).toBe(true);
    if (iso.success) {
      expect(iso.data.routers[0]?.isolated).toBe(true);
    }
  });
});
