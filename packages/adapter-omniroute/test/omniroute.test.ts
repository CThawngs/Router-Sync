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
