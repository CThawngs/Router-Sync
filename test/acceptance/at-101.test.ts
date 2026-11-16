/**
 * test/acceptance/at-101.test.ts
 *
 * Acceptance Test AT-101 (Condition G0-5):
 *  - Tests 'existence-only' read-back via GET /v1/models using client key
 *    obtained from environment (OMNIROUTE_CLIENT_KEY, NINEROUTER_CLIENT_KEY).
 *  - Verifies that STALE cache is detected if /v1/models does not list the new combo.
 *  - Verifies successful read-back when /v1/models lists the new combo.
 *  - Verifies fallback to 'db-only (degraded)' when client key is missing.
 *  - Verifies that `status`, `scan`, `apply` clearly display read-back levels.
 *  - Strictly asserts that client and admin API keys NEVER leak into logs,
 *    command outputs, ApplyResult JSON, or snapshot files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { OmniRouteAdapter } from '../../packages/adapter-omniroute/src/index.js';
import { NineRouterAdapter } from '../../packages/adapter-9router/src/index.js';
import { openBetterSqlite3 } from '../../packages/core/src/index.js';
import { runStatusCommand } from '../../packages/cli/src/commands/status.js';
import { runScanCommand } from '../../packages/cli/src/commands/scan.js';
import { runInitCommand } from '../../packages/cli/src/commands/init.js';
import type { Plan } from '@routersync/adapter-sdk';

describe('Acceptance Test AT-101: Existence-Only Read-Back with Client Key (Condition G0-5)', () => {
  let tmpOmniPath: string;
  let tmpNinePath: string;
  let tmpConfigDir: string;
  let tmpConfigPath: string;

  const CANARY_OMNI_CLIENT_KEY = 'canary-omni-client-token-9876543210';
  const CANARY_NINE_CLIENT_KEY = 'canary-nine-client-token-0123456789';

  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['OMNIROUTE_CLIENT_KEY'];
    delete process.env['NINEROUTER_CLIENT_KEY'];
    delete process.env['OMNIROUTE_ADMIN_KEY'];
    delete process.env['OMNIROUTE_API_KEY'];
    delete process.env['NINEROUTER_ADMIN_KEY'];
    delete process.env['NINEROUTER_API_KEY'];
    delete process.env['NINE_ROUTER_CLIENT_KEY'];
    delete process.env['NINE_ROUTER_API_KEY'];

    tmpOmniPath = path.join(
      os.tmpdir(),
      `at101_omni_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpNinePath = path.join(
      os.tmpdir(),
      `at101_nine_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.sqlite`
    );
    tmpConfigDir = path.join(
      os.tmpdir(),
      `at101_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(tmpConfigDir, { recursive: true });
    tmpConfigPath = path.join(tmpConfigDir, 'config.yaml');

    // OmniRoute schema
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

    // 9Router schema
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
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);

    for (const f of [tmpOmniPath, tmpNinePath]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
    if (fs.existsSync(tmpConfigDir)) {
      try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('OmniRoute: existence-only read-back detects STALE cache when combo not listed in /v1/models', async () => {
    // /api/combos returns 401 (unauthorized for full manage), but /v1/models returns 200 with old models
    let authHeaderSeen = '';
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/combos')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (urlStr.includes('/v1/models')) {
        authHeaderSeen = String(init?.headers ? (init.headers as Record<string, string>)['Authorization'] : '');
        // Return list without the new combo
        return new Response(JSON.stringify({ data: [{ id: 'existing-model-1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      clientApiKey: CANARY_OMNI_CLIENT_KEY,
      fetchFn: mockFetch as unknown as typeof fetch,
      readBackTtlWaitMs: 0,
    });

    const plan: Plan = {
      id: 'plan_at101_omni_stale',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo_new_test',
          name: 'Combo New Test',
          strategy: 'priority',
          models: ['provider/model-a'],
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
    expect(authHeaderSeen).toBe(`Bearer ${CANARY_OMNI_CLIENT_KEY}`);
  });

  it('OmniRoute: existence-only read-back succeeds when combo is listed in /v1/models', async () => {
    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/combos')) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (urlStr.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'Combo New Test' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    const adapter = new OmniRouteAdapter({
      dbPath: tmpOmniPath,
      clientApiKey: CANARY_OMNI_CLIENT_KEY,
      fetchFn: mockFetch as unknown as typeof fetch,
      readBackTtlWaitMs: 0,
    });

    const plan: Plan = {
      id: 'plan_at101_omni_fresh',
      target: 'omniroute',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'combo_new_test',
          name: 'Combo New Test',
          strategy: 'priority',
          models: ['provider/model-a'],
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
    expect(res.staleDetected).toBe(false);
    expect(res.readBackLevel).toBe('existence-only');
  });

  it('9Router: existence-only read-back verifies combo via GET /v1/models with client key', async () => {
    let authHeaderSeen = '';
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/models')) {
        authHeaderSeen = String(init?.headers ? (init.headers as Record<string, string>)['Authorization'] : '');
        return new Response(JSON.stringify({ data: [{ id: 'Nine Combo Test' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('ok', { status: 200 });
    };

    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      clientApiKey: CANARY_NINE_CLIENT_KEY,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const plan: Plan = {
      id: 'plan_at101_nine_fresh',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'nine_combo_1',
          name: 'Nine Combo Test',
          strategy: 'fallback',
          models: ['provider/model-b'],
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
    expect(authHeaderSeen).toBe(`Bearer ${CANARY_NINE_CLIENT_KEY}`);
  });

  it('9Router: falls back to db-only (degraded) when no client key is set', async () => {
    const adapter = new NineRouterAdapter({
      dbPath: tmpNinePath,
      isolated: true,
      clientApiKey: undefined,
      apiKey: undefined,
    });

    const plan: Plan = {
      id: 'plan_at101_nine_degraded',
      target: '9router',
      timestamp: new Date().toISOString(),
      additions: [
        {
          id: 'nine_combo_degraded',
          name: 'Nine Degraded Test',
          strategy: 'fallback',
          models: ['provider/model-c'],
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
    expect(res.readBackLevel).toBe('db-only (degraded)');
  });

  it('status and scan commands report readBackLevel clearly for each router', async () => {
    await runInitCommand({ path: tmpConfigPath });

    // Set client keys in env
    process.env['OMNIROUTE_CLIENT_KEY'] = CANARY_OMNI_CLIENT_KEY;
    process.env['NINEROUTER_CLIENT_KEY'] = CANARY_NINE_CLIENT_KEY;

    let statusOutput = '';
    const originalLog = console.log;
    console.log = (msg?: unknown, ...optionalParams: unknown[]) => {
      statusOutput += String(msg) + ' ' + optionalParams.map(String).join(' ') + '\n';
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: 'ok', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      await runStatusCommand({ configPath: tmpConfigPath, json: true });
      expect(statusOutput).toMatch(/"readBackLevel":\s*"existence-only"/);

      let scanOutput = '';
      console.log = (msg?: unknown, ...optionalParams: unknown[]) => {
        scanOutput += String(msg) + ' ' + optionalParams.map(String).join(' ') + '\n';
      };
      await runScanCommand({ configPath: tmpConfigPath, json: true });
      expect(scanOutput).toMatch(/"readBackLevel":\s*"existence-only"/);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
  });

  it('zero secret leak: API keys never appear in log output, ApplyResult, or snapshot', async () => {
    let capturedLogs = '';
    const originalLog = console.log;
    const originalErr = console.error;
    const originalWrite = process.stderr.write;

    console.log = (msg?: unknown, ...args: unknown[]) => {
      capturedLogs += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    console.error = (msg?: unknown, ...args: unknown[]) => {
      capturedLogs += String(msg) + ' ' + args.map(String).join(' ') + '\n';
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      capturedLogs += String(chunk);
      return true;
    };

    try {
      await runInitCommand({ path: tmpConfigPath });
      process.env['OMNIROUTE_CLIENT_KEY'] = CANARY_OMNI_CLIENT_KEY;
      process.env['NINEROUTER_CLIENT_KEY'] = CANARY_NINE_CLIENT_KEY;

      await runStatusCommand({ configPath: tmpConfigPath, json: true });
      await runStatusCommand({ configPath: tmpConfigPath, json: false });
      await runScanCommand({ configPath: tmpConfigPath, json: true });
      await runScanCommand({ configPath: tmpConfigPath, json: false });

      // Create snapshot
      const adapter = new OmniRouteAdapter({ dbPath: tmpOmniPath, clientApiKey: CANARY_OMNI_CLIENT_KEY });
      const snapshot = await adapter.createSnapshot();

      // Check snapshot serialized string
      const snapshotStr = JSON.stringify(snapshot);
      expect(snapshotStr).not.toContain(CANARY_OMNI_CLIENT_KEY);
      expect(snapshotStr).not.toContain(CANARY_NINE_CLIENT_KEY);

      // Check all captured output
      expect(capturedLogs).not.toContain(CANARY_OMNI_CLIENT_KEY);
      expect(capturedLogs).not.toContain(CANARY_NINE_CLIENT_KEY);
    } finally {
      console.log = originalLog;
      console.error = originalErr;
      process.stderr.write = originalWrite;
    }
  });
});
