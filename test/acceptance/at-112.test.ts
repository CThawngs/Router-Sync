/**
 * test/acceptance/at-112.test.ts
 *
 * Acceptance Test AT-112 (Gate R, 2026-10-15):
 *  - Snapshots persist durably in the state directory (no keys, outside sync).
 *  - `routersync rollback <id>` loads the snapshot in a separate command run
 *    and performs the adapter's logical rollback (real restore).
 *  - Missing snapshot → hard error, never silent success.
 *  - Snapshot files never contain secret-looking strings.
 *
 * Evidence label: FIXTURE (fixture DB + temp state dir), Windows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Owner brief 2026-10-15 §4c: `rollback --write` requires an interactive TTY
// and an explicit confirmation, exactly like `apply --write`. The interactive
// prompt is mocked here so the write path can be exercised end-to-end.
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb('chay'),
    close: () => {},
  }),
}));
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  getSnapshotsDir,
} from '../../packages/core/src/snapshots/store.js';
import { runRollbackCommand } from '../../packages/cli/src/commands/rollback.js';
import type { Plan, Snapshot } from '@routersync/adapter-sdk';

const KEY_VARS = ['NINEROUTER_CLIENT_KEY', 'NINEROUTER_API_KEY', 'NINE_ROUTER_API_KEY'];

describe('Acceptance Test AT-112: durable snapshots + real rollback (Gate R)', () => {
  let tmpNinePath: string;
  let tmpStateDir: string;
  let tmpConfigDir: string;
  let tmpConfigPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const k of KEY_VARS) delete process.env[k];

    tmpNinePath = path.join(
      os.tmpdir(),
      `at112_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpStateDir = path.join(
      os.tmpdir(),
      `at112_state_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    tmpConfigDir = path.join(
      os.tmpdir(),
      `at112_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    tmpConfigPath = path.join(tmpConfigDir, 'routersync.yaml');
    process.env['ROUTERSYNC_STATE_DIR'] = tmpStateDir;

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

    fs.writeFileSync(
      tmpConfigPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine-fixture',
        '    adapter: 9router',
        '    write: db',
        '    isolated: true',
        '    db:',
        `      path: ${tmpNinePath.replace(/\\/g, '\\\\')}`,
        'sources: {}',
        'policy:',
        '  mode: manual',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    fs.rmSync(tmpNinePath, { force: true });
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  const makePlan = (): Plan => ({
    id: 'plan_at112',
    target: '9router',
    timestamp: new Date().toISOString(),
    additions: [
      { id: 'routersync-at112', name: 'AT112 Combo', strategy: 'fallback', models: ['provider/model-x'], managed: true },
    ],
    modifications: [],
    deletions: [],
    reasons: {},
  });

  const countCombos = (): number => {
    const db = openBetterSqlite3(tmpNinePath, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM combos').get() as { n: number };
    db.close();
    return n.n;
  };

  it('snapshot persists durably and is loadable by a separate command run', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });
    const snap = await adapter.createSnapshot();
    const file = saveSnapshot(snap);

    expect(fs.existsSync(file)).toBe(true);
    expect(getSnapshotsDir()).toContain('at112_state');

    // "separate process" semantics: fresh load from disk
    const loaded = loadSnapshot(snap.id);
    expect(loaded.id).toBe(snap.id);
    expect(loaded.combos).toEqual(snap.combos);

    const listed = listSnapshots();
    expect(listed.some((s) => s.id === snap.id)).toBe(true);
  });

  it('saveSnapshot refuses snapshots containing secret-looking strings', () => {
    const bad: Snapshot = {
      id: 'snap_bad_secret',
      target: '9router',
      timestamp: new Date().toISOString(),
      combos: [],
      metadata: { leak: 'sk-abcdefghijklmnopqrstuvwxyz012345' }, // no-secrets:allow: synthetic string proving saveSnapshot refuses secrets
    };
    expect(() => saveSnapshot(bad)).toThrow(/secret patterns/);
  });

  // ---- Owner brief 2026-10-15 §4c: rollback is DRY-RUN by default ---------
  it('rollback <id> WITHOUT --write is a dry-run: prints the plan, writes nothing', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });
    const snap = await adapter.createSnapshot();
    saveSnapshot(snap);
    await adapter.applyPlan(makePlan());
    expect(countCombos()).toBe(1);

    let captured = '';
    const originalLog = console.log;
    console.log = (msg?: unknown, ...args: unknown[]) => {
      captured += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    let thrown: unknown = null;
    try {
      await runRollbackCommand({ configPath: tmpConfigPath, snapshotId: snap.id });
    } catch (err) {
      thrown = err;
    } finally {
      console.log = originalLog;
    }

    expect(thrown).toBeNull();
    expect(captured).toContain('Rollback DRY-RUN');
    expect(captured).toContain('no writes performed');
    expect(captured).toContain('--write');
    expect(countCombos()).toBe(1); // dry-run performed NO writes
  });

  it('rollback <id> --write on a NON-TTY is blocked and writes nothing', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });
    const snap = await adapter.createSnapshot();
    saveSnapshot(snap);
    await adapter.applyPlan(makePlan());
    expect(countCombos()).toBe(1);

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    let thrown: unknown = null;
    const originalErrorLog = console.error;
    console.error = () => {};
    try {
      await runRollbackCommand({ configPath: tmpConfigPath, snapshotId: snap.id, write: true });
    } catch (err) {
      thrown = err;
    } finally {
      console.error = originalErrorLog;
    }

    expect(thrown).not.toBeNull();
    expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(/interactive TTY/);
    expect(countCombos()).toBe(1); // blocked before any write
  });

  it('rollback <id> --write with TTY + confirmation performs the REAL restore', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });

    // Pre-write snapshot → persisted
    const snap = await adapter.createSnapshot();
    const file = saveSnapshot(snap);
    expect(countCombos()).toBe(0);

    // Apply writes a combo
    await adapter.applyPlan(makePlan());
    expect(countCombos()).toBe(1);

    // CLI rollback --write with the persisted id restores state
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let captured = '';
    const originalLog = console.log;
    console.log = (msg?: unknown, ...args: unknown[]) => {
      captured += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    let thrown: unknown = null;
    try {
      await runRollbackCommand({ configPath: tmpConfigPath, snapshotId: snap.id, write: true });
    } catch (err) {
      thrown = err;
    } finally {
      console.log = originalLog;
    }
    expect(thrown).toBeNull();
    expect(captured).toContain('Rollback of snapshot');
    expect(countCombos()).toBe(0); // REAL restore happened
    void file;
  });

  it('rollback with unknown id is a hard error, never silent success', async () => {
    let captured = '';
    const originalErr = console.error;
    console.error = (msg?: unknown, ...args: unknown[]) => {
      captured += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    let thrown: unknown = null;
    try {
      await runRollbackCommand({ configPath: tmpConfigPath, snapshotId: 'no-such-snapshot' });
    } catch (err) {
      thrown = err;
    } finally {
      console.error = originalErr;
    }
    expect(thrown).not.toBeNull();
    expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(/Snapshot not found/);
    expect(captured).toContain('Snapshot not found');
  });

  it('persisted snapshot file contains no secret-looking strings', async () => {
    const adapter = new NineRouterAdapter({ dbPath: tmpNinePath, isolated: true });
    const snap = await adapter.createSnapshot();
    const file = saveSnapshot(snap);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toMatch(/sk-[a-zA-Z0-9_-]{20,}/);
    expect(content).not.toMatch(/Bearer\s+[a-zA-Z0-9_.-]{25,}/);
    expect(content).not.toMatch(/eyJ[a-zA-Z0-9_-]{12,}\./);
  });
});
