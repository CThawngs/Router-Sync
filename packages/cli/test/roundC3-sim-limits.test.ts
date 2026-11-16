import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '@routersync/core';
import { runSimSimulation, planDrops, SIM_MIN_STEPS, SIM_DAY_CAP } from '../src/commands/sim.js';

const TWO_STEPS = ['sim/keep-1', 'sim/dead-beta'];

let dir: string;
let nine: string;
let omni: string;

function makeNine(p: string, steps: string[]): void {
  const db = openBetterSqlite3(p, { busyTimeoutMs: 5000 });
  try {
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, models TEXT, updatedAt TEXT)');
    // Real 9router schema (C2b fix writes to the scoped kv table).
    db.exec('CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))');
    db.prepare('INSERT INTO combos (id, name, models, updatedAt) VALUES (?, ?, ?, ?)')
      .run('c1', 'alpha', JSON.stringify(steps), '2026-11-04T00:00:00Z');
  } finally { db.close(); }
}

function makeOmni(p: string, steps: string[]): void {
  const db = openBetterSqlite3(p, { busyTimeoutMs: 5000 });
  try {
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT, updated_at TEXT)');
    db.prepare('INSERT INTO combos (id, name, data, updated_at) VALUES (?, ?, ?, ?)')
      .run('c1', 'alpha', JSON.stringify({ models: [...steps] }), '2026-11-04T00:00:00Z');
  } finally { db.close(); }
}

function stepsOf(p: string, router: '9router' | 'omniroute'): string[] {
  const db = openBetterSqlite3(p, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    if (router === '9router') {
      const row = db.prepare('SELECT models FROM combos WHERE id = ?').get('c1') as Record<string, unknown>;
      return JSON.parse(String(row['models'] ?? '[]')) as string[];
    }
    const row = db.prepare('SELECT data FROM combos WHERE id = ?').get('c1') as Record<string, unknown>;
    const data = JSON.parse(String(row['data'] ?? '{}')) as { models?: unknown };
    return Array.isArray(data.models) ? (data.models as string[]) : [];
  } finally { db.close(); }
}

describe('G6 sim limits: minSteps guard + day cap', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-simlim-'));
    nine = path.join(dir, 'nine.sqlite');
    omni = path.join(dir, 'omni.sqlite');
    makeNine(nine, TWO_STEPS);
    makeOmni(omni, TWO_STEPS);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('limits are explicit constants', () => {
    expect(SIM_MIN_STEPS).toBe(2);
    expect(SIM_DAY_CAP).toBe(8);
  });

  it('planDrops refuses to go below minSteps and counts the blocked drop', () => {
    const plan = planDrops(['sim/a', 'sim/b'], ['sim/b']);
    expect(plan.removed).toEqual([]);
    expect(plan.protectedCount).toBe(1);
    expect(plan.next).toEqual(['sim/a', 'sim/b']);
  });

  it('planDrops removes normally when the combo stays at or above minSteps', () => {
    const plan = planDrops(['sim/a', 'sim/b', 'sim/c', 'sim/d'], ['sim/c', 'sim/a']);
    expect(plan.removed).toEqual(['sim/c', 'sim/a']);
    expect(plan.protectedCount).toBe(0);
    expect(plan.next).toEqual(['sim/b', 'sim/d']);
  });

  it('planDrops protects the dropped step once the combo reaches minSteps', () => {
    const plan = planDrops(['sim/a', 'sim/b', 'sim/c'], ['sim/c', 'sim/b']);
    expect(plan.removed).toEqual(['sim/c']);
    expect(plan.protectedCount).toBe(1);
    expect(plan.next).toEqual(['sim/a', 'sim/b']);
  });

  it('planDrops stops at the per-day cap and ignores absent models', () => {
    const steps = ['s1', 's2', 's3', 's4', 's5'];
    const plan = planDrops(steps, ['absent', 's1', 's2', 's3', 's4', 's5'], SIM_MIN_STEPS, 3);
    expect(plan.removed).toEqual(['s1', 's2', 's3']);
    expect(plan.next).toEqual(['s4', 's5']);
    expect(plan.protectedCount).toBe(0);
  });

  it('a full run never leaves a combo under minSteps and undo is exact', () => {
    const r = runSimSimulation({ nine, omni }, 7);
    expect(r.undone).toBe(true);
    expect(stepsOf(nine, '9router').length).toBeGreaterThanOrEqual(SIM_MIN_STEPS);
    expect(stepsOf(omni, 'omniroute').length).toBeGreaterThanOrEqual(SIM_MIN_STEPS);
    expect(stepsOf(nine, '9router')).toEqual(TWO_STEPS);
    expect(stepsOf(omni, 'omniroute')).toEqual(TWO_STEPS);
    for (const k of Object.keys(r.hashStart)) expect(r.hashUndone[k]).toBe(r.hashStart[k]);
  });
});
