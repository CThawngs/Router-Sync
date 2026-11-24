/**
 * packages/cli/test/webhook-notify.test.ts
 *
 * M2-02 Red-Before / Green-After Test Matrix:
 * Outbound Webhook for Actionable Alerts (100% Fake Local 127.0.0.1:0 HTTP Target).
 *
 * Guarantees:
 * - 100% local ephemeral HTTP server bound to 127.0.0.1 port 0 and closed in afterEach.
 * - 0 external network requests; 0 calls to live router ports 20128, 30128, or 3128.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@routersync/core';
import * as coreReadonly from '@routersync/core/readonly';
import {
  openBetterSqlite3,
  clearConfiguredRouterDbPaths,
  NINE_ROUTER_EXPECTED_APP_VERSION,
} from '@routersync/core';
import { clearInstalledRouterDbPaths } from '../src/config/loader.js';
import { RouterSyncConfigSchema } from '../src/config/schema.js';
import { runTickCommand } from '../src/commands/tick.js';

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

interface FakeWebhookServer {
  port: number;
  baseUrl: string;
  requests: CapturedRequest[];
  setHandler: (fn: (req: http.IncomingMessage, res: http.ServerResponse, rawBody: string) => void) => void;
  close: () => Promise<void>;
}

const FORBIDDEN_LIVE_PORTS = new Set([20128, 30128, 3128]);

async function startFakeLocalServer(): Promise<FakeWebhookServer> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const requests: CapturedRequest[] = [];
    let customHandler: ((req: http.IncomingMessage, res: http.ServerResponse, rawBody: string) => void) | null = null;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          rawBody,
        });

        if (customHandler) {
          customHandler(req, res, rawBody);
          return;
        }

        if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                { id: 'gpt-4o-mini' },
                { id: 'gpt-4.1-nano-new' },
              ],
            })
          );
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });

    if (port > 0 && !FORBIDDEN_LIVE_PORTS.has(port)) {
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setHandler(fn) {
          customHandler = fn;
        },
        close() {
          return new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  throw new Error('Could not bind ephemeral local HTTP server on non-router port');
}

function createHermeticNineRouterDb(
  dbPath: string,
  providerBaseUrl: string,
  comboModels: string[] = ['openai/gpt-4o-mini']
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openBetterSqlite3(dbPath);
  try {
    db.exec(`
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);
      CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT);
      CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
    `);
    const nowIso = '2026-11-23T00:00:00.000Z';
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(
      JSON.stringify({ comboStrategies: { 'rs-coder': 'priority' } })
    );
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('routersync-rs-coder', 'rs-coder', 'custom', JSON.stringify(comboModels), nowIso, nowIso);
    db.prepare(
      'INSERT INTO providerConnections (id, provider, name, authType, isActive, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-openai-1',
      'openai',
      'hermetic-openai',
      'apikey',
      1,
      JSON.stringify({
        apiKey: 'hermetic-ram-key',
        baseUrl: providerBaseUrl,
      })
    );
  } finally {
    db.close();
  }
}

function seedFreshL2L3Caches(stateDir: string, nowMs: number): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const nowIso = new Date(nowMs).toISOString();
  fs.writeFileSync(
    path.join(stateDir, 'l2-cache.json'),
    JSON.stringify({ version: 1, updatedAt: nowIso, models: {} }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(stateDir, 'l3-cache.json'),
    JSON.stringify({ version: 1, updatedAt: nowIso, notices: [] }),
    'utf8'
  );
}

function writeHermeticConfig(
  configPath: string,
  dbPath: string,
  webhookSection?: { enabled?: boolean; url?: string; timeoutMs?: number }
): void {
  const lines = [
    'version: 1',
    'routers:',
    '  - id: nine',
    '    adapter: 9router',
    '    isolated: true',
    '    db:',
    `      path: "${dbPath.replace(/\\/g, '/')}"`,
    '    write: db',
    '    reload:',
    '      type: none',
    'policy:',
    '  mode: manual',
    'combos:',
    '  - name: rs-coder',
    '    role: coding',
    '    routers:',
    '      - nine',
    '    size: 3',
    'adopt: []',
  ];
  if (webhookSection) {
    lines.push('webhook:');
    if (webhookSection.enabled !== undefined) lines.push(`  enabled: ${webhookSection.enabled}`);
    if (webhookSection.url !== undefined) lines.push(`  url: "${webhookSection.url}"`);
    if (webhookSection.timeoutMs !== undefined) lines.push(`  timeoutMs: ${webhookSection.timeoutMs}`);
  }
  fs.writeFileSync(configPath, lines.join('\n') + '\n', 'utf8');
}

describe('M2-02: Outbound Webhook for Actionable Alerts (100% Fake Local 127.0.0.1:0 HTTP Target)', () => {
  const nowMs = 1763856000000;
  let tmpDir = '';
  let fakeServer: FakeWebhookServer | null = null;
  let orig9Db: string | undefined;
  let origOmniDb: string | undefined;
  let origWebhookEnv: string | undefined;
  let externalRequests: string[] = [];
  let forbiddenPortRequests: string[] = [];

  function hermeticEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
      APPDATA: tmpDir,
      HOME: tmpDir,
      ...overrides,
    };
  }

  function createGuardedLocalFetch(): typeof globalThis.fetch {
    const realFetch = globalThis.fetch;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(urlStr);
      const portNum = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      if (FORBIDDEN_LIVE_PORTS.has(portNum)) {
        forbiddenPortRequests.push(urlStr);
        throw new Error(`Forbidden router port touched: ${urlStr}`);
      }
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        externalRequests.push(urlStr);
        throw new Error(`External network host touched: ${urlStr}`);
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
  }

  beforeEach(async () => {
    externalRequests = [];
    forbiddenPortRequests = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-m2-02-webhook-'));
    orig9Db = process.env['ROUTERSYNC_9ROUTER_DB'];
    origOmniDb = process.env['ROUTERSYNC_OMNIROUTE_DB'];
    origWebhookEnv = process.env['ROUTERSYNC_WEBHOOK_URL'];

    process.env['ROUTERSYNC_9ROUTER_DB'] = path.join(tmpDir, 'unused-9router.sqlite');
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpDir, 'unused-omniroute.sqlite');
    delete process.env['ROUTERSYNC_WEBHOOK_URL'];

    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();

    fakeServer = await startFakeLocalServer();
  });

  afterEach(async () => {
    if (fakeServer) {
      await fakeServer.close();
      fakeServer = null;
    }
    if (orig9Db !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = orig9Db;
    else delete process.env['ROUTERSYNC_9ROUTER_DB'];
    if (origOmniDb !== undefined) process.env['ROUTERSYNC_OMNIROUTE_DB'] = origOmniDb;
    else delete process.env['ROUTERSYNC_OMNIROUTE_DB'];
    if (origWebhookEnv !== undefined) process.env['ROUTERSYNC_WEBHOOK_URL'] = origWebhookEnv;
    else delete process.env['ROUTERSYNC_WEBHOOK_URL'];

    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore best-effort cleanup
    }

    expect(externalRequests).toEqual([]);
    expect(forbiddenPortRequests).toEqual([]);
  });

  it('M2-02-T1: delivers versioned actionable alert POST via options.env & config.webhook without leaking URL token', async () => {
    // Verify shared exports exist on both @routersync/core and @routersync/core/readonly
    const coreExports = core as Record<string, unknown>;
    const readonlyExports = coreReadonly as Record<string, unknown>;
    expect(typeof coreExports['validateWebhookUrl']).toBe('function');
    expect(typeof coreExports['redactWebhookPayload']).toBe('function');
    expect(typeof coreExports['sendActionableWebhook']).toBe('function');
    expect(typeof readonlyExports['validateWebhookUrl']).toBe('function');
    expect(typeof readonlyExports['redactWebhookPayload']).toBe('function');
    expect(typeof readonlyExports['sendActionableWebhook']).toBe('function');

    // Verify declarative webhook schema support in RouterSyncConfigSchema
    const parsedConfig = RouterSyncConfigSchema.parse({
      version: 1,
      routers: [{ id: 'nine', adapter: '9router', write: 'db' }],
      webhook: { enabled: true, url: `${fakeServer!.baseUrl}/cfg-hook`, timeoutMs: 3000 },
    }) as Record<string, unknown>;
    expect(parsedConfig['webhook']).toEqual({
      enabled: true,
      url: `${fakeServer!.baseUrl}/cfg-hook`,
      timeoutMs: 3000,
    });

    const dbPath = path.join(tmpDir, 'db', 'nine.sqlite');
    const cfgPath = path.join(tmpDir, 'routersync.yaml');
    const stateDir = path.join(tmpDir, 'state');
    createHermeticNineRouterDb(dbPath, `${fakeServer!.baseUrl}/v1`);
    seedFreshL2L3Caches(stateDir, nowMs);
    // Configure fallback URL in YAML, while options.env overrides it with query capability token
    writeHermeticConfig(cfgPath, dbPath, {
      enabled: true,
      url: `${fakeServer!.baseUrl}/fallback-unused`,
      timeoutMs: 4000,
    });

    const secretQueryToken = 'cap_qtok_987654321';
    const envHookUrl = `${fakeServer!.baseUrl}/hook?token=${secretQueryToken}`;

    const summary = await runTickCommand({
      configPath: cfgPath,
      stateDir,
      nowMs,
      mode: 'propose',
      env: hermeticEnv({ ROUTERSYNC_WEBHOOK_URL: envHookUrl }),
      fetchFn: createGuardedLocalFetch(),
    });

    expect(summary.inboxAdded).toBeGreaterThanOrEqual(1);
    expect(summary.paidRequests).toBe(0);
    expect(summary.tokens).toBe(0);
    expect(summary.llmCalls).toBe(0);

    const delivery = (summary as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(delivery).toBeDefined();
    expect(delivery?.['status']).toBe('sent');
    expect(delivery?.['ok']).toBe(true);
    expect(delivery?.['statusCode']).toBe(200);
    expect(typeof delivery?.['durationMs']).toBe('number');

    // Query token and full URL must NEVER appear in TickRunSummary or status.json
    const summaryJson = JSON.stringify(summary);
    const statusDiskRaw = fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8');
    expect(summaryJson).not.toContain(secretQueryToken);
    expect(summaryJson).not.toContain('/hook');
    expect(statusDiskRaw).not.toContain(secretQueryToken);
    expect(statusDiskRaw).not.toContain('/hook');

    const postReqs = fakeServer!.requests.filter((r) => r.method === 'POST');
    expect(postReqs).toHaveLength(1);
    expect(postReqs[0]!.url).toBe(`/hook?token=${secretQueryToken}`);
    expect(postReqs[0]!.headers['content-type']).toContain('application/json');
    expect(postReqs[0]!.headers['user-agent']).toBe('routersync-webhook/1.0');

    const payload = JSON.parse(postReqs[0]!.rawBody) as Record<string, unknown>;
    expect(payload['schemaVersion']).toBe('1.0');
    expect(payload['event']).toBe('routersync.actionable_alert');
    expect(payload['source']).toBe('cli.tick');
    const payloadSummary = payload['summary'] as Record<string, unknown>;
    expect(payloadSummary['alertCount']).toBeGreaterThanOrEqual(1);
    expect(payloadSummary['inboxAdded']).toBe(summary.inboxAdded);
    expect(Array.isArray(payloadSummary['changedProviders'])).toBe(true);
    const alerts = payload['alerts'] as Array<Record<string, unknown>>;
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!['kind']).toBe('inbox_item');

    // Also verify config.webhook fallback when ROUTERSYNC_WEBHOOK_URL is absent
    const stateDir2 = path.join(tmpDir, 'state-cfg');
    seedFreshL2L3Caches(stateDir2, nowMs);
    const summary2 = await runTickCommand({
      configPath: cfgPath,
      stateDir: stateDir2,
      nowMs,
      mode: 'propose',
      env: hermeticEnv(),
      fetchFn: createGuardedLocalFetch(),
    });
    const delivery2 = (summary2 as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(delivery2?.['status']).toBe('sent');
    expect(fakeServer!.requests.some((r) => r.method === 'POST' && r.url === '/fallback-unused')).toBe(true);
  });

  it('M2-02-T2: enforces zero-noise suppression when alerts === 0 or webhook URL is unconfigured/disabled', async () => {
    const dbPath = path.join(tmpDir, 'db', 'nine-quiet.sqlite');
    const cfgPath = path.join(tmpDir, 'routersync-quiet.yaml');
    const stateDir = path.join(tmpDir, 'state-quiet');

    // Make provider return ONLY existing active Tier A combo model -> 0 inbox proposals
    fakeServer!.setHandler((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    createHermeticNineRouterDb(dbPath, `${fakeServer!.baseUrl}/v1`, ['openai/gpt-4o-mini']);
    seedFreshL2L3Caches(stateDir, nowMs);
    writeHermeticConfig(cfgPath, dbPath);

    // Subcase A: Configured URL + 0 actionable alerts -> 0 POST requests
    const quietSummary = await runTickCommand({
      configPath: cfgPath,
      stateDir,
      nowMs,
      mode: 'propose',
      env: hermeticEnv({ ROUTERSYNC_WEBHOOK_URL: `${fakeServer!.baseUrl}/hook` }),
      fetchFn: createGuardedLocalFetch(),
    });
    expect(quietSummary.inboxAdded).toBe(0);
    const quietDelivery = (quietSummary as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(quietDelivery).toEqual({
      status: 'skipped',
      ok: true,
      reason: 'no_actionable_alerts',
      durationMs: 0,
    });
    expect(fakeServer!.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    // Direct helper check for zero-noise gate (also targeted by Mutation M1)
    const sendFn = (core as Record<string, unknown>)['sendActionableWebhook'] as (
      arg: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    expect(typeof sendFn).toBe('function');
    const directZero = await sendFn({
      url: `${fakeServer!.baseUrl}/hook`,
      source: 'cli.tick',
      alerts: [],
      fetchImpl: createGuardedLocalFetch(),
    });
    expect(directZero).toEqual({
      status: 'skipped',
      ok: true,
      reason: 'no_actionable_alerts',
      durationMs: 0,
    });
    expect(fakeServer!.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    // Subcase B: Actionable alerts > 0 + unconfigured URL (and disabled config.webhook) -> 0 POST requests
    fakeServer!.setHandler((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-extra' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const stateDirUnconf = path.join(tmpDir, 'state-unconf');
    const cfgDisabled = path.join(tmpDir, 'routersync-disabled.yaml');
    seedFreshL2L3Caches(stateDirUnconf, nowMs);
    writeHermeticConfig(cfgDisabled, dbPath, {
      enabled: false,
      url: `${fakeServer!.baseUrl}/hook`,
    });

    const unconfSummary = await runTickCommand({
      configPath: cfgDisabled,
      stateDir: stateDirUnconf,
      nowMs,
      mode: 'propose',
      env: hermeticEnv(),
      fetchFn: createGuardedLocalFetch(),
    });
    expect(unconfSummary.inboxAdded).toBeGreaterThanOrEqual(1);
    const unconfDelivery = (unconfSummary as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(unconfDelivery).toEqual({
      status: 'skipped',
      ok: true,
      reason: 'unconfigured',
      durationMs: 0,
    });
    expect(fakeServer!.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('M2-02-T3: handles HTTP 500, 80ms timeout against 2500ms slow target, and 302 redirect non-fatally', async () => {
    const dbPath = path.join(tmpDir, 'db', 'nine-resilience.sqlite');
    createHermeticNineRouterDb(dbPath, `${fakeServer!.baseUrl}/v1`);

    // 1) HTTP 500 -> non-fatal, reason === 'http_500'
    fakeServer!.setHandler((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-500' }] }));
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal Webhook Failure');
    });

    const cfg500 = path.join(tmpDir, 'cfg-500.yaml');
    const state500 = path.join(tmpDir, 'state-500');
    seedFreshL2L3Caches(state500, nowMs);
    writeHermeticConfig(cfg500, dbPath, { enabled: true, url: `${fakeServer!.baseUrl}/hook-500` });

    const sum500 = await runTickCommand({
      configPath: cfg500,
      stateDir: state500,
      nowMs,
      mode: 'propose',
      env: hermeticEnv(),
      fetchFn: createGuardedLocalFetch(),
    });
    expect(sum500.inboxAdded).toBeGreaterThanOrEqual(1);
    const del500 = (sum500 as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(del500?.['status']).toBe('failed');
    expect(del500?.['ok']).toBe(false);
    expect(del500?.['statusCode']).toBe(500);
    expect(del500?.['reason']).toBe('http_500');

    // 2) Timeout resilience: server delays 2500ms while timeoutMs is 80ms
    const pendingTimers: NodeJS.Timeout[] = [];
    let slowHookArrivedAt = 0;
    fakeServer!.setHandler((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-slow' }] }));
        return;
      }
      if ((req.url ?? '').startsWith('/hook-slow')) {
        slowHookArrivedAt = Date.now();
      }
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"late":true}');
        }
      }, 2500);
      pendingTimers.push(timer);
    });

    const cfgSlow = path.join(tmpDir, 'cfg-slow.yaml');
    const stateSlow = path.join(tmpDir, 'state-slow');
    seedFreshL2L3Caches(stateSlow, nowMs);
    writeHermeticConfig(cfgSlow, dbPath, {
      enabled: true,
      url: `${fakeServer!.baseUrl}/hook-slow`,
      timeoutMs: 80,
    });

    const startedMs = Date.now();
    try {
      const sumSlow = await runTickCommand({
        configPath: cfgSlow,
        stateDir: stateSlow,
        nowMs,
        mode: 'propose',
        env: hermeticEnv(),
        fetchFn: createGuardedLocalFetch(),
      });
      const hookFinishedAt = Date.now();
      const elapsedMs = hookFinishedAt - startedMs;
      const delSlow = (sumSlow as unknown as Record<string, unknown>)['webhookDelivery'] as
        | Record<string, unknown>
        | undefined;
      expect(slowHookArrivedAt).toBeGreaterThan(0);
      expect(hookFinishedAt - slowHookArrivedAt).toBeLessThan(1500);
      expect(elapsedMs).toBeLessThan(2000);
      expect(delSlow?.['status']).toBe('failed');
      expect(delSlow?.['ok']).toBe(false);
      expect(delSlow?.['reason']).toBe('timeout');
    } finally {
      for (const t of pendingTimers) clearTimeout(t);
    }

    // 3) HTTP 302 redirect -> rejected via redirect: 'error', never follows redirect
    let redirectedHit = false;
    fakeServer!.setHandler((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1-redir' }] }));
        return;
      }
      if ((req.url ?? '').startsWith('/redirect-target')) {
        redirectedHit = true;
        res.writeHead(200);
        res.end('should-never-reach');
        return;
      }
      res.writeHead(302, { Location: `${fakeServer!.baseUrl}/redirect-target` });
      res.end();
    });

    const cfgRedir = path.join(tmpDir, 'cfg-redir.yaml');
    const stateRedir = path.join(tmpDir, 'state-redir');
    seedFreshL2L3Caches(stateRedir, nowMs);
    writeHermeticConfig(cfgRedir, dbPath, {
      enabled: true,
      url: `${fakeServer!.baseUrl}/hook-302`,
    });

    const sumRedir = await runTickCommand({
      configPath: cfgRedir,
      stateDir: stateRedir,
      nowMs,
      mode: 'propose',
      env: hermeticEnv(),
      fetchFn: createGuardedLocalFetch(),
    });
    const delRedir = (sumRedir as unknown as Record<string, unknown>)['webhookDelivery'] as
      | Record<string, unknown>
      | undefined;
    expect(delRedir?.['status']).toBe('failed');
    expect(delRedir?.['ok']).toBe(false);
    expect(redirectedHit).toBe(false);
  });

  it('M2-02-T4: rejects unsafe URL schemes, embedded credentials, and live router ports with 0 sockets opened', async () => {
    const validateFn = (core as Record<string, unknown>)['validateWebhookUrl'] as (
      u: string | undefined
    ) => Record<string, unknown>;
    const sendFn = (core as Record<string, unknown>)['sendActionableWebhook'] as (
      arg: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;

    expect(typeof validateFn).toBe('function');
    expect(typeof sendFn).toBe('function');

    const fileSchemeUrl = ['file:', '//', '/tmp/evil'].join('');
    const rejectedCases: Array<{ url: string; expectedReason: string }> = [
      { url: fileSchemeUrl, expectedReason: 'unsupported_protocol' },
      { url: 'javascript:alert(1)', expectedReason: 'unsupported_protocol' },
      { url: 'ftp://127.0.0.1/x', expectedReason: 'unsupported_protocol' },
      { url: 'http://user:pass@127.0.0.1:9999/hook', expectedReason: 'embedded_credentials_forbidden' },
      { url: 'http://127.0.0.1:20128/v1/models', expectedReason: 'forbidden_router_port' },
      { url: 'http://localhost:30128/api/combos', expectedReason: 'forbidden_router_port' },
      { url: 'http://127.0.0.1:3128/api/v1/health', expectedReason: 'forbidden_router_port' },
      { url: '::not-a-valid-url::', expectedReason: 'invalid_syntax' },
    ];

    let fetchCalls = 0;
    const zeroSocketFetch = (async () => {
      fetchCalls++;
      throw new Error('Fetch must never be called for rejected URLs');
    }) as unknown as typeof globalThis.fetch;

    for (const testCase of rejectedCases) {
      const validation = validateFn(testCase.url);
      expect(validation).toEqual({
        valid: false,
        status: 'rejected_url',
        reason: testCase.expectedReason,
      });

      const delivery = await sendFn({
        url: testCase.url,
        source: 'cli.tick',
        alerts: [
          {
            kind: 'inbox_item',
            providerOrRouter: 'openai',
            code: 'NEW-CANDIDATE',
            message: 'New model candidate detected',
          },
        ],
        fetchImpl: zeroSocketFetch,
      });

      expect(delivery).toEqual({
        status: 'rejected_url',
        ok: false,
        reason: testCase.expectedReason,
        durationMs: 0,
      });
    }

    expect(fetchCalls).toBe(0);
  });

  it('M2-02-T5: scrubs secrets, sensitive keys, personal paths, non-example emails, username, and hostname before POST', async () => {
    const redactFn = (core as Record<string, unknown>)['redactWebhookPayload'] as <T>(
      val: T,
      opts?: { privateTokens?: string[] }
    ) => T;
    const sendFn = (core as Record<string, unknown>)['sendActionableWebhook'] as (
      arg: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;

    expect(typeof redactFn).toBe('function');
    expect(typeof sendFn).toBe('function');

    const syntheticSk = ['sk', 'proj', '1234567890abcdef9999'].join('-');
    const syntheticBearer = ['Bearer', 'secret-jwt-value-abcdef1234567890'].join(' ');
    const syntheticJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'c2lnbmF0dXJlX3Rlc3RfMTIzNDU2',
    ].join('.');
    const syntheticWinPath = ['C:', 'Users', 'syntheticperson', 'AppData', 'secret.json'].join('\\');
    const syntheticMacPath = ['', 'Users', 'syntheticmac', '.routersync', 'token.txt'].join('/');
    const syntheticPosixPath = ['', 'home', 'syntheticlinux', '.config', 'key.pem'].join('/');
    const syntheticFileUri = ['file:', '//', '/tmp/private-cred.json'].join('');
    const syntheticPrivateEmail = ['alerts.owner', 'corp-internal.io'].join('@');
    const allowedExampleEmail = 'ops@example.com';
    const currentHostname = os.hostname();
    const currentUsername = os.userInfo().username;

    // 1) Verify key-based redaction & allowlist preservation on redactWebhookPayload
    const nested = redactFn(
      {
        schemaVersion: '1.0',
        changedProviders: ['openai'],
        routerId: 'nine',
        alertCount: 1,
        apiKey: 'super-secret',
        auth: { customHeader: 'entire-auth-subtree-secret' },
        nestedContext: {
          accessToken: 'raw-access-val',
          privateNote: 'hidden-note',
          safeField: `Contact ${syntheticPrivateEmail} or ${allowedExampleEmail}`,
        },
      },
      { privateTokens: ['custom-tenant-handle'] }
    ) as Record<string, unknown>;

    expect(nested['schemaVersion']).toBe('1.0');
    expect(nested['changedProviders']).toEqual(['openai']);
    expect(nested['routerId']).toBe('nine');
    expect(nested['alertCount']).toBe(1);
    expect(nested['apiKey']).toBe('[REDACTED]');
    expect(nested['auth']).toBe('[REDACTED]');
    const nestedContext = nested['nestedContext'] as Record<string, unknown>;
    expect(nestedContext['accessToken']).toBe('[REDACTED]');
    expect(nestedContext['privateNote']).toBe('[REDACTED]');
    expect(nestedContext['safeField']).toBe(`Contact <REDACTED_EMAIL> or ${allowedExampleEmail}`);

    // 2) Verify end-to-end HTTP POST body captured by fake local server has 0 leaks
    const noisyMessage = [
      `Key=${syntheticSk}`,
      `Auth=${syntheticBearer}`,
      `JWT=${syntheticJwt}`,
      `Win=${syntheticWinPath}`,
      `Mac=${syntheticMacPath}`,
      `Linux=${syntheticPosixPath}`,
      `URI=${syntheticFileUri}`,
      `Mail=${syntheticPrivateEmail}`,
      `SafeMail=${allowedExampleEmail}`,
      `Host=${currentHostname}`,
      `User=${currentUsername}`,
      `Tenant=custom-tenant-handle`,
    ].join(' | ');

    const delivery = await sendFn({
      url: `${fakeServer!.baseUrl}/hook-redact`,
      source: 'cli.tick',
      changedProviders: ['openai'],
      inboxAdded: 1,
      privateTokens: ['custom-tenant-handle'],
      alerts: [
        {
          kind: 'inbox_item',
          providerOrRouter: 'openai',
          code: 'AUTH_ERROR',
          message: noisyMessage,
        },
      ],
      fetchImpl: createGuardedLocalFetch(),
    });

    expect(delivery['status']).toBe('sent');
    const postReqs = fakeServer!.requests.filter((r) => r.method === 'POST' && r.url === '/hook-redact');
    expect(postReqs).toHaveLength(1);

    const capturedBody = postReqs[0]!.rawBody;
    expect(capturedBody).not.toContain(syntheticSk);
    expect(capturedBody).not.toContain('secret-jwt-value');
    expect(capturedBody).not.toContain(syntheticJwt);
    expect(capturedBody).not.toContain('syntheticperson');
    expect(capturedBody).not.toContain('syntheticmac');
    expect(capturedBody).not.toContain('syntheticlinux');
    expect(capturedBody).not.toContain('private-cred.json');
    expect(capturedBody).not.toContain(syntheticPrivateEmail);
    expect(capturedBody).not.toContain('custom-tenant-handle');
    if (currentHostname.trim().length >= 3) {
      expect(capturedBody.toLowerCase()).not.toContain(currentHostname.trim().toLowerCase());
    }
    if (currentUsername.trim().length >= 3) {
      expect(capturedBody.toLowerCase()).not.toContain(currentUsername.trim().toLowerCase());
    }

    // Confirm expected replacement markers and benign example email preservation
    expect(capturedBody).toContain('[REDACTED]');
    expect(capturedBody).toContain('<USER_PATH>');
    expect(capturedBody).toContain('<REDACTED_EMAIL>');
    expect(capturedBody).toContain('<REDACTED_ID>');
    expect(capturedBody).toContain(allowedExampleEmail);
  });
});
