/**
 * test/acceptance/at-109.test.ts
 *
 * Acceptance Test AT-109 (Spec §33.3, Gate L, 2026-10-15):
 *  - Apply on a db-only router with unconfirmed serving path returns
 *    applyState = 'written-pending-reload' (never 'verified').
 *  - CLI `status` reports applyState per router (JSON + human output).
 *  - MCP `status` tool reports applyStates + pendingReloadRouters.
 *  - MCP `inbox_list` emits a system-sourced pending-reload item
 *    (proposed_by.kind = 'system').
 *  - D26: configs containing a 9Router are capped at policy.mode manual/shadow.
 *
 * Evidence labels: FIXTURE (adapter/CLI/MCP on fixture DB + mocks, Windows).
 * The daemon assertion (daemon must not count written-pending-reload as success)
 * is deferred to P3b (B2/B3) — the daemon does not exist yet in this slice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3, saveSnapshot } from '../../packages/core/src/index.js';
import { runStatusCommand } from '../../packages/cli/src/commands/status.js';
import { RouterSyncConfigSchema } from '../../packages/cli/src/config/schema.js';
import type { Plan } from '@routersync/adapter-sdk';

const ORIGINAL_ENV = { ...process.env };
const KEY_VARS = [
  'OMNIROUTE_CLIENT_KEY', 'OMNIROUTE_ADMIN_KEY', 'OMNIROUTE_API_KEY',
  'NINEROUTER_CLIENT_KEY', 'NINEROUTER_ADMIN_KEY', 'NINEROUTER_API_KEY',
  'NINE_ROUTER_CLIENT_KEY', 'NINE_ROUTER_API_KEY',
];

describe('Acceptance Test AT-109: written-pending-reload apply state (Spec §33.3, Gate L)', () => {
  let tmpNinePath: string;
  let tmpConfigDir: string;
  let tmpConfigPath: string;
  /**
   * R19-2: the state directory is the place where the evidence of a write
   * lives, so the test points it at a throwaway directory. Without that the
   * result would depend on whatever the machine happens to have written
   * before, and the expectation below would be a coin toss.
   */
  let tmpStateDir: string;

  beforeEach(() => {
    for (const k of KEY_VARS) delete process.env[k];

    tmpStateDir = path.join(
      os.tmpdir(),
      `at109_state_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(tmpStateDir, { recursive: true });
    process.env['ROUTERSYNC_STATE_DIR'] = tmpStateDir;

    tmpNinePath = path.join(
      os.tmpdir(),
      `at109_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpConfigDir = path.join(
      os.tmpdir(),
      `at109_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    tmpConfigPath = path.join(tmpConfigDir, 'routersync.yaml');

    // 9Router schema fixture (FIXTURE)
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

    // Minimal valid config pointing the 9Router at the fixture DB.
    // baseUrl points at a closed port so no request ever leaves the machine.
    fs.writeFileSync(
      tmpConfigPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine-fixture',
        '    adapter: 9router',
        '    baseUrl: http://127.0.0.1:9',
        '    write: db',
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
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    fs.rmSync(tmpNinePath, { force: true });
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  it('adapter: apply on db-only router returns applyState = written-pending-reload', async () => {
    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      isolated: true,
      apiBaseUrl: 'http://127.0.0.1:9',
    });

    const plan: Plan = {
      id: 'plan_at109',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'at109_combo_1',
          name: 'AT109 Combo',
          strategy: 'fallback',
          models: ['provider/model-x'],
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
    // Spec §33.3 / AT-109: NEVER 'verified' when serving path is unconfirmed
    expect(res.applyState).toBe('written-pending-reload');
    expect(res.applyState).not.toBe('verified');
  });

  /**
   * Runs `routersync status --json` against a healthy mock router and returns
   * the parsed JSON. The mock server and the config are rebuilt for every
   * call, so one run never inherits the state of another.
   */
  async function runCliStatusAgainstHealthyMock(): Promise<{
    routers: Array<{
      id: string;
      adapter: string;
      readBackLevel: string;
      applyState?: string;
    }>;
  }> {
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

    // Update config to point baseUrl to the healthy mock server
    fs.writeFileSync(
      tmpConfigPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine-fixture',
        '    adapter: 9router',
        `    baseUrl: http://127.0.0.1:${address.port}`,
        '    write: db',
        '    db:',
        `      path: ${tmpNinePath.replace(/\\/g, '\\\\')}`,
        'sources: {}',
        'policy:',
        '  mode: manual',
      ].join('\n'),
      'utf-8'
    );

    // Capture console.log via direct assignment (same pattern as AT-101)
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

  it('CLI status: reports applyState unwritten for a db-only router WITHOUT evidence of a write', async () => {
    // R19-2 (DECISIONS 2026-10-18-01): 'written-pending-reload' describes a
    // WRITE. This scenario never wrote anything (the state directory is
    // empty), so the CLI must say 'unwritten' instead of claiming a write.
    const parsed = await runCliStatusAgainstHealthyMock();
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.readBackLevel).toBe('db-only (degraded)');
    expect(nine.applyState).toBe('unwritten');
    expect(nine.applyState).not.toBe('written-pending-reload');
  });

  it('CLI status: reports applyState written-pending-reload for a db-only router WITH evidence of a write', async () => {
    // The same scenario, but the state directory now holds a snapshot of the
    // 9Router target: that IS the evidence of a write, so the old value comes
    // back. (The snapshot is written through the real `saveSnapshot`.)
    saveSnapshot({
      id: 'snap_at109_nine',
      target: '9router',
      timestamp: new Date().toISOString(),
      combos: [],
    });

    const parsed = await runCliStatusAgainstHealthyMock();
    const nine = parsed.routers.find((r) => r.adapter === '9router');
    expect(nine).toBeDefined();
    if (!nine) throw new Error('the status output has no 9router router');
    expect(nine.readBackLevel).toBe('db-only (degraded)');
    expect(nine.applyState).toBe('written-pending-reload');
  });

  // NOTE: the MCP portion of AT-109 (status tool + inbox_list via InMemoryTransport)
  // lives in packages/mcp-server/test/at-109-mcp.test.ts, where the MCP SDK resolves.

  it('D26: config containing 9Router is capped at policy.mode manual/shadow', () => {
    const base = {
      version: 1 as const,
      routers: [{ id: 'nine', adapter: '9router' as const }],
    };

    const auto = RouterSyncConfigSchema.safeParse({ ...base, policy: { mode: 'auto' } });
    expect(auto.success).toBe(false);
    expect(JSON.stringify(auto.error?.issues ?? [])).toContain('D26');

    const autoLow = RouterSyncConfigSchema.safeParse({ ...base, policy: { mode: 'auto-low-risk' } });
    expect(autoLow.success).toBe(false);

    const manual = RouterSyncConfigSchema.safeParse({ ...base, policy: { mode: 'manual' } });
    expect(manual.success).toBe(true);

    const shadow = RouterSyncConfigSchema.safeParse({ ...base, policy: { mode: 'shadow' } });
    expect(shadow.success).toBe(true);

    // OmniRoute-only config is NOT capped by D26 (still subject to G0-7 unvalidated rule)
    const omniAuto = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'omni', adapter: 'omniroute' as const, validated: true }],
      policy: { mode: 'auto' },
    });
    expect(omniAuto.success).toBe(true);
  });
});
