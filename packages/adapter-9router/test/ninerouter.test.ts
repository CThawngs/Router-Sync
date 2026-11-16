/**
 * packages/adapter-9router/test/ninerouter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NineRouterAdapter } from '../src/index.js';
import { getManagedIds } from '@routersync/core';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Plan } from '@routersync/adapter-sdk';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { DatabaseSync } = require('node:sqlite');

describe('NineRouterAdapter (Tier 3 SQLite + Health)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `9router_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.sqlite`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const db = new DatabaseSync(tmpDbPath);
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
      INSERT INTO settings (id, data) VALUES (1, '{"comboStrategies":{}}');
    `);
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  it('checks health via HTTP probe with 0 tokens', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const adapter = new NineRouterAdapter({
      dbPath: tmpDbPath,
      healthUrl: 'http://localhost:20128/api/health',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const health = await adapter.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reads combos and correlates strategies from settings', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const db = new DatabaseSync(tmpDbPath);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO combos (id, name, kind, models, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'creative-combo',
      'Creative Combo',
      'custom',
      JSON.stringify(['claude-3-5-sonnet', 'gpt-4o']),
      now,
      now
    );

    db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(
      JSON.stringify({
        comboStrategies: {
          'Creative Combo': 'round-robin',
        },
      })
    );
    db.close();

    const adapter = new NineRouterAdapter({ dbPath: tmpDbPath, isolated: true });
    const combos = await adapter.readCombos();

    expect(combos).toHaveLength(1);
    expect(combos[0]?.id).toBe('creative-combo');
    expect(combos[0]?.name).toBe('Creative Combo');
    expect(combos[0]?.strategy).toBe('round-robin');
    expect(combos[0]?.models).toEqual(['claude-3-5-sonnet', 'gpt-4o']);
  });

  it('applies a plan and verifies rollback works seamlessly', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpDbPath, isolated: true });

    const initialSnapshot = await adapter.createSnapshot();
    expect(initialSnapshot.combos).toHaveLength(0);

    const plan: Plan = {
      id: 'plan_9router_1',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-9r',
          name: 'Combo 9R',
          strategy: 'least-used',
          models: ['m1', 'm2'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const applyResult = await adapter.applyPlan(plan);
    expect(applyResult.success).toBe(true);

    const combosAfter = await adapter.readCombos();
    expect(combosAfter).toHaveLength(1);
    expect(combosAfter[0]?.id).toBe('combo-9r');
    expect(combosAfter[0]?.strategy).toBe('least-used');

    // Rollback
    const rollbackOk = await adapter.rollback(initialSnapshot);
    expect(rollbackOk).toBe(true);

    const combosRollback = await adapter.readCombos();
    expect(combosRollback).toHaveLength(0);
  });

  // Owner brief 2026-10-15 §4a: serving-path wait ceiling >= 60 s, poll-based.
  // Fake clock: combo NOT listed at 25 s, listed at 40 s → verified. Proves the
  // DEFAULT ceiling (no override) tolerates the Gate L / AT-111 measured
  // reflection latency (19.7–31.2 s, n=3) — a correct write is never marked
  // STALE and rolled back wrongly.
  it('serving-path poll: not listed at 25 s, listed at 40 s → verified (default >= 60 s ceiling)', async () => {
    vi.useFakeTimers();
    try {
      const writeStart = Date.now();
      const mockFetch = (async (url: string | URL | Request) => {
        if (String(url).includes('/v1/models')) {
          const elapsed = Date.now() - writeStart;
          const data =
            elapsed >= 40_000
              ? [{ id: 'slow-combo' }]
              : [{ id: 'other-combo' }];
          return new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch;

      const adapter = new NineRouterAdapter({
        dbPath: tmpDbPath,
        clientApiKey: 'canar...89',
        fetchFn: mockFetch,
        // NO servingWaitMs override — the production default (>= 60 s) is under test.
      });

      const plan: Plan = {
        id: 'plan_slow_reflect',
        target: '9router',
        timestamp: new Date().toISOString(),
        additions: [
          {
            id: 'slow-combo',
            name: 'Slow Combo',
            strategy: 'fallback',
            models: ['m1'],
            managed: true,
          },
        ],
        modifications: [],
        deletions: [],
        reasons: {},
      };

      const applyPromise = adapter.applyPlan(plan);
      await vi.advanceTimersByTimeAsync(45_000);
      const res = await applyPromise;

      expect(res.success).toBe(true);
      expect(res.readBackVerified).toBe(true);
      expect(res.readBackLevel).toBe('existence-only');
      expect(res.applyState).toBe('verified');
    } finally {
      vi.useRealTimers();
    }
  });

  // Owner brief 2026-10-15 §4b: the ledger write path is real product code
  // (VITEST branch removed). Instance A writes a combo whose id has NO
  // routersync- prefix; the durable ledger in the injected state dir makes
  // instance B's rollback recognize it as managed and delete it.
  it('managed-id ledger: plain id written by instance A is recognized as managed by instance B rollback', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_ledger_test_'));
    try {
      const adapterA = new NineRouterAdapter({
        dbPath: tmpDbPath,
        isolated: true,
        stateDir,
      });
      const snapBefore = await adapterA.createSnapshot();
      expect(snapBefore.combos).toHaveLength(0);

      const planA: Plan = {
        id: 'plan_ledger_a',
        target: '9router',
        timestamp: new Date().toISOString(),
        additions: [
          {
            id: 'plain-managed-001',
            name: 'Plain Managed',
            strategy: 'fallback',
            models: ['m1'],
            managed: true,
          },
        ],
        modifications: [],
        deletions: [],
        reasons: {},
      };
      const resA = await adapterA.applyPlan(planA);
      expect(resA.success).toBe(true);

      // Durable ledger recorded the id (no prefix, cross-process recognition).
      expect(getManagedIds(stateDir)).toContain('plain-managed-001');

      // Instance B: fresh session set, same state dir → rollback deletes the row.
      const adapterB = new NineRouterAdapter({
        dbPath: tmpDbPath,
        isolated: true,
        stateDir,
      });
      const rollbackOk = await adapterB.rollback(snapBefore);
      expect(rollbackOk).toBe(true);

      const combos = await adapterB.readCombos();
      expect(combos.find((c) => c.id === 'plain-managed-001')).toBeUndefined();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
