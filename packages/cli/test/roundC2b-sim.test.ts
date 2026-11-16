import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '@routersync/core';
import {
  runSimSimulation,
  decideSimMode,
  customModelKey,
  customModelValue,
  buildSimScenario,
} from '../src/commands/sim.js';

const STEPS = [
  'sim/keep-1',
  'sim/keep-2',
  'sim/keep-3',
  'sim/keep-4',
  'sim/dead-beta',
  'sim/dead-delta',
  'sim/dead-epsilon',
  'sim/dead-zeta',
  'sim/keep-5',
  'sim/keep-6',
];

let dir: string;
let nine: string;
let omni: string;

function makeNine(p: string): void {
  const db = openBetterSqlite3(p, { busyTimeoutMs: 5000 });
  try {
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, models TEXT, updatedAt TEXT)');
    // Real 9router schema (C2b fix writes to the scoped kv table).
    db.exec('CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))');
    db.exec('CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, data TEXT)');
    db.prepare('INSERT INTO combos (id, name, models, updatedAt) VALUES (?, ?, ?, ?)')
      .run('c1', 'alpha', JSON.stringify(STEPS), '2026-11-04T00:00:00Z');
    db.prepare('INSERT INTO providerConnections (id, provider, data) VALUES (?, ?, ?)')
      .run('p1', 'sim', JSON.stringify({ providerSpecificData: { enabledModels: [] } }));
  } finally { db.close(); }
}

function makeOmni(p: string): void {
  const db = openBetterSqlite3(p, { busyTimeoutMs: 5000 });
  try {
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT, updated_at TEXT)');
    // Real 9router schema (C2b fix writes to the scoped kv table).
    db.exec('CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (scope, key))');
    db.prepare('INSERT INTO combos (id, name, data, updated_at) VALUES (?, ?, ?, ?)')
      .run('c1', 'alpha', JSON.stringify({ models: [...STEPS] }), '2026-11-04T00:00:00Z');
  } finally { db.close(); }
}

describe('C2b A6 sim engine', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-sim-'));
    nine = path.join(dir, 'nine.sqlite');
    omni = path.join(dir, 'omni.sqlite');
    makeNine(nine);
    makeOmni(omni);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('decideSimMode: >10% removals => propose, reorder => auto-safe', () => {
    expect(decideSimMode({ removals: 0, steps: 10, breakerTripped: false })).toBe('auto-safe');
    expect(decideSimMode({ removals: 2, steps: 10, breakerTripped: false })).toBe('propose');
    expect(decideSimMode({ removals: 0, steps: 10, breakerTripped: true })).toBe('propose');
  });

  it('customModels key/value shape: provider|modelId|type -> JSON', () => {
    expect(customModelKey('sim', 'free-alpha')).toBe('sim|free-alpha|chat');
    expect(JSON.parse(customModelValue('sim', 'free-alpha', 'sim/free-alpha'))).toEqual({
      providerAlias: 'sim',
      id: 'free-alpha',
      type: 'chat',
      name: 'sim/free-alpha',
    });
  });

  it('scenario has 7 days in exact order', () => {
    const s = buildSimScenario(7);
    expect(s.map((d) => `${d.day}:${d.kind}`)).toEqual([
      '1:ADD', '2:REMOVE', '3:REMOVE', '4:REMOVE', '5:REMOVE', '6:REMOVE', '7:REMOVE',
    ]);
  });

  it('run: undo hash before==after, day6 auto-safe, day7 propose', () => {
    const r = runSimSimulation({ nine, omni }, 7);
    expect(r.undone).toBe(true);
    for (const k of Object.keys(r.hashStart)) expect(r.hashUndone[k]).toBe(r.hashStart[k]);
    expect(r.days).toHaveLength(7);
    expect(r.days.map((d) => d.mode)).toEqual([
      'auto-safe', 'auto-safe', 'auto-safe', 'propose', 'propose', 'propose', 'propose',
    ]);
    expect(r.days[5]?.mode).toBe('propose');
    expect(r.days[3]?.readBack).toBe('SKIPPED-STALE');
    expect(r.days[4]?.readBack).toBe('SKIPPED-CAP');
    expect(r.days[5]?.readBack).toBe('SKIPPED-PROPOSE');
    expect(r.days[6]?.mode).toBe('propose');
    expect(r.days[6]?.readBack).toBe('SKIPPED-PROPOSE');
    expect(r.days[0]?.readBack).toBe('EXACT');
  });
});
