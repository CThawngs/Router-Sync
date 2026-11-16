/**
 * test/acceptance/at-157-status-unwritten.test.ts
 *
 * Acceptance Test AT-157 (R19-2, DECISIONS 2026-10-18-01):
 * the CLI `status` tells the truth about a write it has no evidence of.
 *
 * The decision adds ONE value to the `applyState` enum — 'unwritten' — and
 * keeps the two existing values. The rule it installs:
 *
 *   evidence of a write  +  router healthy  +  read-back only `db-only`
 *        -> 'written-pending-reload'   (the write happened, the serving path
 *                                        did not confirm it)
 *   evidence of a write  +  the serving path reads back enough
 *        -> 'verified'
 *   NO evidence of a write
 *        -> 'unwritten'
 *
 * "Evidence of a write" for a target is: a snapshot of that target in the
 * snapshot directory, OR an entry of the managed-id ledger that belongs to
 * that target. A missing ledger or a missing snapshot directory means NO
 * evidence — the check is read-only and never creates a file or a directory.
 *
 * The storage reality (read from the code, not guessed) is that the ledger
 * `managed-ids.json` is a FLAT array of ids with no target column, and only
 * the 9Router adapter writes it. A ledger entry therefore counts as evidence
 * for the 9Router target and for nothing else; the case below pins that rule
 * so a write of one router can never be reported as a write of another.
 *
 * Everything here is hermetic: a throwaway config, a throwaway fixture DB, a
 * throwaway state directory and a loopback mock server. No real router is
 * touched, no real state directory is read or written.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { openBetterSqlite3, saveSnapshot } from '../../packages/core/src/index.js';
import { runStatusCommand } from '../../packages/cli/src/commands/status.js';

const ORIGINAL_ENV = { ...process.env };
const KEY_VARS = [
  'OMNIROUTE_CLIENT_KEY', 'OMNIROUTE_ADMIN_KEY', 'OMNIROUTE_API_KEY',
  'NINEROUTER_CLIENT_KEY', 'NINEROUTER_ADMIN_KEY', 'NINEROUTER_API_KEY',
  'NINE_ROUTER_CLIENT_KEY', 'NINE_ROUTER_API_KEY',
];

interface StatusRouter {
  id: string;
  adapter: string;
  readBackLevel: string;
  applyState?: string;
}

/** Every path under `root`, relative and sorted (the "tree" of a directory). */
function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out;
}

describe('Acceptance Test AT-157: the CLI status says "unwritten" when it has no evidence of a write', () => {
  let tmpNinePath: string;
  let tmpConfigDir: string;
  let tmpConfigPath: string;
  let tmpStateDir: string;

  beforeEach(() => {
    for (const k of KEY_VARS) delete process.env[k];

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    tmpNinePath = path.join(os.tmpdir(), `at157_nine_${stamp}.sqlite`);
    tmpConfigDir = path.join(os.tmpdir(), `at157_cfg_${stamp}`);
    tmpStateDir = path.join(os.tmpdir(), `at157_state_${stamp}`);
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    fs.mkdirSync(tmpStateDir, { recursive: true });
    tmpConfigPath = path.join(tmpConfigDir, 'routersync.yaml');
    process.env['ROUTERSYNC_STATE_DIR'] = tmpStateDir;

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
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    fs.rmSync(tmpNinePath, { force: true });
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  /**
   * Writes the config, starts a healthy mock router, runs `status --json` and
   * returns the parsed routers.
   *
   * Every router points at a THROWAWAY database: without `db.path` the
   * adapter would open the database of the router installed on this machine,
   * and this test must never read a real router.
   */
  async function runStatus(
    routers: Array<{ id: string; adapter: '9router' | 'omniroute' }>
  ): Promise<{ routers: StatusRouter[] }> {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };

    const lines = ['version: 1', 'routers:'];
    for (const router of routers) {
      const dbPath =
        router.adapter === '9router'
          ? tmpNinePath
          : path.join(tmpConfigDir, `${router.id}-omni.sqlite`);
      lines.push(`  - id: ${router.id}`);
      lines.push(`    adapter: ${router.adapter}`);
      lines.push(`    baseUrl: http://127.0.0.1:${address.port}`);
      lines.push('    write: db');
      lines.push('    db:');
      lines.push(`      path: ${dbPath.replace(/\\/g, '\\\\')}`);
    }
    lines.push('sources: {}');
    lines.push('policy:');
    lines.push('  mode: manual');
    fs.writeFileSync(tmpConfigPath, lines.join('\n'), 'utf-8');

    let captured = '';
    const originalLog = console.log;
    console.log = (msg?: unknown, ...args: unknown[]) => {
      captured += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    let thrown: unknown = null;
    try {
      await runStatusCommand({ configPath: tmpConfigPath, json: true });
    } catch (err) {
      thrown = err;
    } finally {
      console.log = originalLog;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (thrown) {
      throw new Error(`runStatusCommand threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    if (captured.trim() === '') {
      throw new Error('runStatusCommand produced no console.log output (json=true)');
    }
    return JSON.parse(captured.trim());
  }

  it('(a) no ledger and no snapshot -> "unwritten"', async () => {
    const parsed = await runStatus([{ id: 'nine-fixture', adapter: '9router' }]);
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.readBackLevel).toBe('db-only (degraded)');
    expect(nine.applyState).toBe('unwritten');
    expect(nine.applyState).not.toBe('written-pending-reload');
    expect(nine.applyState).not.toBe('verified');
  });

  it('(b) a managed-id entry of the target + db-only read-back -> "written-pending-reload"', async () => {
    // The ledger of the 9Router target: exactly what the apply path writes.
    fs.writeFileSync(
      path.join(tmpStateDir, 'managed-ids.json'),
      JSON.stringify(['routersync-fast'], null, 2),
      'utf-8',
    );

    const parsed = await runStatus([{ id: 'nine-fixture', adapter: '9router' }]);
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.readBackLevel).toBe('db-only (degraded)');
    expect(nine.applyState).toBe('written-pending-reload');
  });

  it('(b2) a snapshot of the target + db-only read-back -> "written-pending-reload"', async () => {
    saveSnapshot({
      id: 'snap_at157_nine',
      target: '9router',
      timestamp: new Date().toISOString(),
      combos: [],
    });

    const parsed = await runStatus([{ id: 'nine-fixture', adapter: '9router' }]);
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.applyState).toBe('written-pending-reload');
  });

  it('(b3) the ledger of ANOTHER router is not evidence for this one', async () => {
    // The ledger on disk carries no target column; only the 9Router adapter
    // writes it. A write of the 9Router must never be reported as a write of
    // the OmniRoute.
    fs.writeFileSync(
      path.join(tmpStateDir, 'managed-ids.json'),
      JSON.stringify(['routersync-fast'], null, 2),
      'utf-8',
    );

    const parsed = await runStatus([{ id: 'omni-fixture', adapter: 'omniroute' }]);
    const omni = parsed.routers.find((r) => r.adapter === 'omniroute');
    expect(omni).toBeDefined();
    if (!omni) throw new Error('the status output has no omniroute router');
    expect(omni.applyState).toBe('unwritten');
  });

  it('(c) the "verified" path is unchanged: evidence + a serving path that reads back', async () => {
    // A client key makes the read-back 'existence-only' instead of 'db-only',
    // so the serving path IS confirmed: with evidence the state is 'verified'.
    process.env['NINEROUTER_CLIENT_KEY'] = 'at157-dummy-client-key';
    saveSnapshot({
      id: 'snap_at157_verified',
      target: '9router',
      timestamp: new Date().toISOString(),
      combos: [],
    });

    const parsed = await runStatus([{ id: 'nine-fixture', adapter: '9router' }]);
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.readBackLevel).toBe('existence-only');
    expect(nine.applyState).toBe('verified');
  });

  it('(d) running status creates no file and no directory', async () => {
    const before = treeOf(tmpStateDir);

    const parsed = await runStatus([{ id: 'nine-fixture', adapter: '9router' }]);
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.applyState).toBe('unwritten');

    // The state directory is still exactly as empty as it was: the evidence
    // check never writes a ledger, a snapshot or a directory.
    expect(treeOf(tmpStateDir)).toEqual(before);
    expect(treeOf(tmpStateDir)).toEqual([]);
    // The CLI added nothing next to the config it read.
    expect(treeOf(tmpConfigDir)).toEqual(['routersync.yaml']);
  });
});
