/**
 * packages/adapter-omniroute/test/omniroute.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OmniRouteAdapter } from '../src/index.js';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { DatabaseSync } = require('node:sqlite');
import type { Plan } from '@routersync/adapter-sdk';
import { applyPlanSafe } from '@routersync/core';
import { FakeRouter } from '../../../test/harness/fake-router.js';

describe('OmniRouteAdapter (Tier 3 SQLite + Health)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `omniroute_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.sqlite`);
    const db = new DatabaseSync(tmpDbPath);
    db.exec(`
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

    const adapter = new OmniRouteAdapter({
      dbPath: tmpDbPath,
      healthUrl: 'http://localhost:30128/api/health',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const health = await adapter.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reads combos from SQLite table', async () => {
    const db = new DatabaseSync(tmpDbPath);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO combos (id, name, data, created_at, updated_at, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'fast-coding',
      'Fast Coding',
      JSON.stringify({
        strategy: 'priority',
        models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini'],
        managed: true,
      }),
      now,
      now,
      0
    );
    db.close();

    const adapter = new OmniRouteAdapter({ dbPath: tmpDbPath });
    const combos = await adapter.readCombos();

    expect(combos).toHaveLength(1);
    expect(combos[0]?.id).toBe('fast-coding');
    expect(combos[0]?.strategy).toBe('priority');
    expect(combos[0]?.models).toEqual(['deepseek/deepseek-chat', 'openai/gpt-4o-mini']);
  });

  it('applies a plan and supports rollback to snapshot', async () => {
    const adapter = new OmniRouteAdapter({ dbPath: tmpDbPath });

    // 1. Initial snapshot of empty DB
    const initialSnapshot = await adapter.createSnapshot();
    expect(initialSnapshot.combos).toHaveLength(0);

    // 2. Apply plan
    const plan: Plan = {
      id: 'plan_omni_1',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo-1',
          name: 'Combo 1',
          strategy: 'weighted',
          models: ['model-1', 'model-2'],
          managed: true,
        },
      ],
      modifications: [],
      deletions: [],
      reasons: {},
    };

    const applyResult = await adapter.applyPlan(plan);
    expect(applyResult.success).toBe(true);

    const combosAfterApply = await adapter.readCombos();
    expect(combosAfterApply).toHaveLength(1);
    expect(combosAfterApply[0]?.id).toBe('combo-1');
    expect(combosAfterApply[0]?.strategy).toBe('weighted');

    // 3. Rollback to initial snapshot
    const rollbackSuccess = await adapter.rollback(initialSnapshot);
    expect(rollbackSuccess).toBe(true);

    const combosAfterRollback = await adapter.readCombos();
    expect(combosAfterRollback).toHaveLength(0);
  });
});

/**
 * M2-03 Phase 1 — Red-Before serving-path read-back tests.
 * Every assertion below targets behavior that does not exist on unpatched main.
 */
describe('M2-03: OmniRoute serving-path HTTP read-back', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `omniroute_m203_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.sqlite`
    );
    const db = new DatabaseSync(tmpDbPath);
    db.exec(`
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
    db.close();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
  });

  function seed(combo: { id: string; models: string[] }): void {
    const now = new Date().toISOString();
    const db = new DatabaseSync(tmpDbPath);
    db.prepare(
      'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(
      combo.id,
      combo.id,
      JSON.stringify({ strategy: 'priority', models: combo.models, managed: true }),
      now,
      now
    );
    db.close();
  }

  function rows(): Array<{ id: string; data: string }> {
    const db = new DatabaseSync(tmpDbPath);
    try {
      return db.prepare('SELECT id, data FROM combos ORDER BY id').all() as Array<{
        id: string;
        data: string;
      }>;
    } finally {
      db.close();
    }
  }

  function makePlan(
    additions: Plan['additions'],
    modifications: Plan['modifications'],
    deletions: string[] = []
  ): Plan {
    return {
      id: `plan_m203_${Math.random().toString(36).substring(2, 9)}`,
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions,
      modifications,
      deletions,
      reasons: {},
    };
  }

  it('M2-03-T2: /api/combos modification models are polled until the updated models are served', async () => {
    const fake = new FakeRouter({ name: 'fake-omni-m203', reflectAfterPolls: 2 });
    await fake.startServer();
    try {
      seed({ id: 'test-1', models: ['p1/m1', 'p1/m2', 'p1/m3'] });
      const oldCombo = {
        id: 'test-1', name: 'test-1', strategy: 'priority', models: ['p1/m1', 'p1/m2', 'p1/m3'], managed: true,
      };
      const modified = { ...oldCombo, models: ['p1/m1', 'p1/m2'] };
      fake.setPreApplySnapshot([oldCombo] as never);
      fake.setReflectedCombos([modified] as never);
      fake.resetCounters();

      const adapter = new OmniRouteAdapter({
        dbPath: tmpDbPath,
        clientApiKey: 'rs-m2-03-omni-test-key',
        apiBaseUrl: fake.baseUrl,
        servingWaitMs: 250,
      });
      const result = (await applyPlanSafe(adapter, makePlan([], [modified]), {
        dryRun: false,
      })) as unknown as Record<string, unknown>;

      expect(result['success']).toBe(true);
      expect(result['readBackLevel']).toBe('full');
      expect(result['canonicalReadBackLevel']).toBe('api-verified');
      expect(fake.combosRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T3: /v1/models fallback verifies additions, modifications and deletions when /api/combos is 401', async () => {
    const fake = new FakeRouter({
      name: 'fake-omni-fallback',
      requireAuthForCombos: true,
      reflectAfterPolls: 2,
    });
    await fake.startServer();
    try {
      seed({ id: 'test-1', models: ['p1/m1', 'p1/m2'] });
      seed({ id: 'test-2', models: ['p1/m3'] });
      const oldOne = {
        id: 'test-1', name: 'test-1', strategy: 'priority', models: ['p1/m1', 'p1/m2'], managed: true,
      };
      const oldTwo = {
        id: 'test-2', name: 'test-2', strategy: 'priority', models: ['p1/m3'], managed: true,
      };
      const added = { id: 'added-omni', name: 'added-omni', strategy: 'priority', models: ['p1/m4'], managed: true };
      const modified = { ...oldOne, models: ['p1/m1'] };
      fake.setPreApplySnapshot([oldOne, oldTwo] as never);
      fake.setReflectedCombos([modified, added] as never);
      fake.resetCounters();

      const adapter = new OmniRouteAdapter({
        dbPath: tmpDbPath,
        clientApiKey: 'rs-m2-03-omni-test-key',
        apiBaseUrl: fake.baseUrl,
        servingWaitMs: 250,
      });
      const result = (await applyPlanSafe(
        adapter,
        makePlan([added], [modified], ['test-2']),
        { dryRun: false }
      )) as unknown as Record<string, unknown>;

      expect(result['success']).toBe(true);
      expect(result['readBackLevel']).toBe('existence-only');
      expect(result['canonicalReadBackLevel']).toBe('existence-only');
      expect(fake.combosRequests).toBeGreaterThanOrEqual(1);
      expect(fake.modelsRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T4: stale /api/combos (including stale models) triggers rollback and exact SQLite restore', async () => {
    const fake = new FakeRouter({ name: 'fake-omni-stale', staleServingPath: true });
    await fake.startServer();
    try {
      seed({ id: 'test-1', models: ['p1/m1', 'p1/m2'] });
      const oldCombo = {
        id: 'test-1', name: 'test-1', strategy: 'priority', models: ['p1/m1', 'p1/m2'], managed: true,
      };
      const added = { id: 'stale-omni', name: 'stale-omni', strategy: 'priority', models: ['p1/m9'], managed: true };
      const modified = { ...oldCombo, models: ['p1/m1'] };
      fake.setPreApplySnapshot([oldCombo] as never);
      fake.setReflectedCombos([modified, added] as never);
      const before = rows();

      const adapter = new OmniRouteAdapter({
        dbPath: tmpDbPath,
        clientApiKey: 'rs-m2-03-omni-test-key',
        apiBaseUrl: fake.baseUrl,
        servingWaitMs: 200,
      });
      const result = (await applyPlanSafe(adapter, makePlan([added], [modified]), {
        dryRun: false,
      })) as unknown as Record<string, unknown>;

      expect(result['success']).toBe(false);
      expect(result['staleDetected']).toBe(true);
      expect(result['rollbackExecuted']).toBe(true);
      expect(rows()).toEqual(before);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T5: HTTP 503 with credentials reports serving-path-http-503 (not missing credentials)', async () => {
    const fake = new FakeRouter({ name: 'fake-omni-503', servingStatusOverride: 503 });
    await fake.startServer();
    try {
      seed({ id: 'test-1', models: ['p1/m1'] });
      const initial = [
        { id: 'test-1', name: 'test-1', strategy: 'priority', models: ['p1/m1'], managed: true },
      ];
      const added = { id: 'http503-omni', name: 'http503-omni', strategy: 'priority', models: ['p1/m2'], managed: true };
      fake.setPreApplySnapshot(initial as never);

      const adapter = new OmniRouteAdapter({
        dbPath: tmpDbPath,
        clientApiKey: 'rs-m2-03-omni-test-key',
        apiBaseUrl: fake.baseUrl,
        servingWaitMs: 200,
      });
      const result = (await applyPlanSafe(adapter, makePlan([added], []), {
        dryRun: false,
      })) as unknown as Record<string, unknown>;

      expect(result['success']).toBe(true);
      expect(result['readBackLevel']).toBe('db-only (degraded)');
      expect(result['canonicalReadBackLevel']).toBe('db-only');
      expect(result['degradedReason']).toBe('serving-path-http-503');
      expect(result['degradedReason']).not.toBe('no-serving-path-credentials');
    } finally {
      await fake.stopServer();
    }
  });
});
