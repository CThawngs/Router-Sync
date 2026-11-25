/**
 * packages/cli/test/wp4-controlled-automation.test.ts
 *
 * C45-WP4 Red-First End-to-End CLI Controlled Automation Suite (Phục vụ: S3, S4, S9):
 *  1. Default empty policy [] (removes hardcoded ^test-\d+$, allows real combo names once consented)
 *  2. `consent grant` TTY + `'consent'` confirmation + C45 §3.2 promotion gate (`propose` -> `auto-safe`)
 *  3. `applyPlanSafe` unconditional rollback on write/read-back failure (M5)
 *  4. `tick --mode auto-safe` verified removal + addition + I1..I8 invariants (M6) + inbox/webhook
 *  5. `freeze` / `unfreeze` emergency circuit breaker across CLI, Daemon, and `status` (read-only AT-157 M7)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  openBetterSqlite3,
  NINE_ROUTER_EXPECTED_APP_VERSION,
  appendResearchEvidence,
  applyPlanSafe,
  readApplyHistory,
  readFreezeState,
} from '@routersync/core';
import { createDaemonServer, createApprovalToken, resetTokenRegistry } from '@routersync/daemon';
import { setupDaemonFixture } from '../../../test/harness/daemon-fixture.js';
import {
  runConsentGrantCommand,
  runConsentStatusCommand,
  runConsentRevokeCommand,
} from '../src/commands/consent.js';
import { runFreezeCommand, runUnfreezeCommand } from '../src/commands/freeze.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runApplyCommand } from '../src/commands/apply.js';
import { runMaintainApplyCommand, runMaintainPlanCommand } from '../src/commands/maintain.js';
import { runTickCommand } from '../src/commands/tick.js';

const ORIGINAL_ENV = { ...process.env };

class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`EXIT_${code}`);
    this.code = code;
  }
}

async function captureCli(fn: () => Promise<unknown>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(typeof code === 'number' ? code : Number(code ?? 0));
  }) as never);

  let exitCode = 0;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitSignal) {
      exitCode = e.code;
    } else {
      err.push(e instanceof Error ? e.message : String(e));
      exitCode = process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 1;
    }
  } finally {
    process.exitCode = 0;
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('C45-WP4 Controlled Automation CLI Lifecycle', () => {
  interface Wp4TestContext {
    readonly tmpRoot: string;
    readonly stateDir: string;
    readonly nineDbPath: string;
    readonly configPath: string;
    readonly webhookServer: http.Server;
    readonly webhookBodies: Array<Record<string, unknown>>;
    readonly seedNineDb: () => void;
    readonly readComboModels: (name: string) => string[];
  }

  const activeContexts: Wp4TestContext[] = [];
  let currentCtx: Wp4TestContext;

  function seedNineDbAt(dbPath: string): void {
    const db = openBetterSqlite3(dbPath, { allowLiveDbWrite: true });
    const now = '2026-11-24T00:00:00.000Z';
    db.exec(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER DEFAULT 1,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providerNodes (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        data TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        isActive INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      DELETE FROM combos;
      DELETE FROM providerConnections;
      DELETE FROM models;
      DELETE FROM settings;
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      DELETE FROM _meta;
      INSERT INTO settings (id, data) VALUES (1, '{}');
      INSERT INTO models (id, provider, modelId, isActive) VALUES
        ('openai/gpt-4o-legacy', 'openai', 'gpt-4o-legacy', 1),
        ('openai/gpt-4.1', 'openai', 'gpt-4.1', 1),
        ('openai/gpt-4.1-mini', 'openai', 'gpt-4.1-mini', 1),
        ('openai/gpt-4.1-nano', 'openai', 'gpt-4.1-nano', 1),
        ('openai/o3-mini', 'openai', 'o3-mini', 1),
        ('openai/o4-mini', 'openai', 'o4-mini', 1),
        ('openai/gpt-4o', 'openai', 'gpt-4o', 1),
        ('openai/gpt-4o-mini', 'openai', 'gpt-4o-mini', 1),
        ('openai/gpt-4.5', 'openai', 'gpt-4.5', 1),
        ('openai/gpt-5-nano', 'openai', 'gpt-5-nano', 1);
    `);
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run('appVersion', NINE_ROUTER_EXPECTED_APP_VERSION);
    db.prepare(
      'INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-openai',
      'openai',
      'apikey',
      'OpenAI Sandbox',
      null,
      1,
      1,
      JSON.stringify({
        apiKey: 'dummy-openai-sandbox-key',
        baseUrl: 'https://api.openai.com/v1',
        prefix: 'openai',
      }),
      now,
      now
    );

    // 10 models in coding-primary so removing 1 is 1/10 = 10% (<= 10% shrink cap!)
    const initialModels = [
      'openai/gpt-4o-legacy',
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
      'openai/gpt-4.1-nano',
      'openai/o3-mini',
      'openai/o4-mini',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/gpt-4.5',
      'openai/gpt-5-nano',
    ];
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('coding-primary', 'coding-primary', null, JSON.stringify(initialModels), now, now);
    db.close();
  }

  function readComboModelsAt(dbPath: string, name: string): string[] {
    const db = openBetterSqlite3(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get(name, name) as { models: string } | undefined;
      return row ? (JSON.parse(row.models) as string[]) : [];
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    const localTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp4-cli-'));
    const localStateDir = path.join(localTmpRoot, 'state');
    fs.mkdirSync(localStateDir, { recursive: true });
    const localNineDbPath = path.join(localTmpRoot, 'nine.sqlite');
    seedNineDbAt(localNineDbPath);

    const localWebhookBodies: Array<Record<string, unknown>> = [];
    const localWebhookServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += String(c);
      });
      req.on('end', () => {
        try {
          localWebhookBodies.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          // ignore
        }
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => localWebhookServer.listen(0, '127.0.0.1', () => resolve()));
    const whPort = (localWebhookServer.address() as AddressInfo).port;

    const localConfigPath = path.join(localTmpRoot, 'routersync.yaml');
    fs.writeFileSync(
      localConfigPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    isolated: true',
        '    baseUrl: http://127.0.0.1:9',
        '    db:',
        `      path: ${localNineDbPath}`,
        '    reload:',
        '      type: none',
        'policy:',
        '  mode: manual',
        'combos:',
        '  - name: coding-primary',
        '    routers:',
        '      - nine',
        '    size: 10',
        '    constraints:',
        '      freeOnly: false',
        '    pin:',
        '      - openai/gpt-4.1',
        '      - openai/gpt-4.1-mini',
        '      - openai/gpt-4.1-nano',
        '      - openai/o3-mini',
        '      - openai/o4-mini',
        '      - openai/gpt-4o',
        '      - openai/gpt-4o-mini',
        '      - openai/gpt-4.5',
        '      - openai/gpt-5-nano',
        '      - openai/gpt-4o-legacy',
        '    autoMaintain: true',
        'adopt:',
        '  - router: nine',
        '    name: coding-primary',
        '    mode: full',
        'webhook:',
        '  enabled: true',
        `  url: http://127.0.0.1:${whPort}/hook`,
        '',
      ].join('\n'),
      'utf8'
    );

    const ctx: Wp4TestContext = {
      tmpRoot: localTmpRoot,
      stateDir: localStateDir,
      nineDbPath: localNineDbPath,
      configPath: localConfigPath,
      webhookServer: localWebhookServer,
      webhookBodies: localWebhookBodies,
      seedNineDb: () => seedNineDbAt(localNineDbPath),
      readComboModels: (name: string) => readComboModelsAt(localNineDbPath, name),
    };
    activeContexts.push(ctx);
    currentCtx = ctx;

    process.env['ROUTERSYNC_STATE_DIR'] = localStateDir;
    process.env['ROUTERSYNC_CONFIG'] = localConfigPath;
    process.env['ROUTERSYNC_9ROUTER_DB'] = localNineDbPath;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(localTmpRoot, 'nonexistent-omniroute.sqlite');
    process.env['ROUTERSYNC_HOME'] = path.join(localTmpRoot, 'home');
    process.env['APPDATA'] = path.join(localTmpRoot, 'appdata');
    process.env['LOCALAPPDATA'] = path.join(localTmpRoot, 'local');
    resetTokenRegistry();
  });

  afterEach(async () => {
    resetTokenRegistry();
    const toClean = activeContexts.splice(0);
    for (const ctx of toClean) {
      if (ctx.webhookServer.listening) {
        await new Promise<void>((resolve) => ctx.webhookServer.close(() => resolve()));
      }
    }
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
    for (const ctx of toClean) {
      fs.rmSync(ctx.tmpRoot, { recursive: true, force: true });
    }
  });

  it('keeps status strictly read-only on an empty stateDir (AT-157 / M7) and rejects unconsented combos including test-1 with only-pattern', async () => {
    const { tmpRoot, configPath } = currentCtx;
    const emptyState = path.join(tmpRoot, 'pristine-empty-state');
    fs.mkdirSync(emptyState, { recursive: true });
    process.env['ROUTERSYNC_STATE_DIR'] = emptyState;

    const statusRes = await captureCli(() =>
      runStatusCommand({ configPath, stateDir: emptyState, json: true })
    );
    expect(statusRes.exitCode).toBe(0);
    // ZERO files or directories created in emptyState! (kills M7)
    expect(fs.readdirSync(emptyState)).toEqual([]);
    const parsedStatus = JSON.parse(statusRes.stdout) as Record<string, any>;
    expect(parsedStatus['frozen']).toBe(false);
    expect(Array.isArray(parsedStatus['targets'])).toBe(true);

    // Without standing-consent.json or apply-grant.json, BOTH coding-primary AND test-1 fail closed with only-pattern (kills M7)
    for (const unconsented of ['coding-primary', 'test-1']) {
      const ref = await captureCli(() =>
        runMaintainApplyCommand({
          only: unconsented,
          configPath,
          router: 'nine',
          stateDir: emptyState,
          planHash: '0000000000000000',
          isTTY: true,
          promptFn: async () => 'chay',
        })
      );
      expect(ref.exitCode).toBe(1);
      expect(ref.stderr).toContain('MAINTAIN-REFUSED reason=only-pattern');
    }
  }, 60_000);

  it('executes full progression: deny auto-safe (M1) -> grant propose -> propose apply on real combo coding-primary -> promote auto-safe -> tick auto-safe -> freeze/unfreeze', async () => {
    const { tmpRoot, stateDir, nineDbPath, configPath, webhookBodies, seedNineDb, readComboModels } =
      currentCtx;
    // 1. Reject --yes and non-TTY on consent grant
    const yesConsent = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'propose',
        stateDir,
        yes: true,
        isTTY: true,
      })
    );
    expect(yesConsent.exitCode).toBe(1);
    expect(yesConsent.stderr).toContain('reason=yes-flag');

    const noTtyConsent = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'propose',
        stateDir,
        isTTY: false,
      })
    );
    expect(noTtyConsent.exitCode).toBe(1);
    expect(noTtyConsent.stderr).toContain('reason=no-tty');

    // 2. Reject auto-safe promotion BEFORE verified propose receipt (kills M1)
    const prematureAutoSafe = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
      })
    );
    expect(prematureAutoSafe.exitCode).toBe(1);
    expect(prematureAutoSafe.stderr + prematureAutoSafe.stdout).toContain(
      'AUTO_SAFE_PROMOTION_DENIED'
    );

    // 3. Grant propose consent via interactive TTY + 'consent'
    const grantPropose = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'propose',
        days: 30,
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(grantPropose.exitCode).toBe(0);

    // Consent status is read-only and leaks zero signing keys or HMAC hex
    const cStatus = await captureCli(() => runConsentStatusCommand({ stateDir, json: true }));
    expect(cStatus.exitCode).toBe(0);
    const keyHex = fs.readFileSync(path.join(stateDir, 'consent-signing.key'), 'utf8').trim();
    const diskPolicy = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'standing-consent.json'), 'utf8')
    ) as { hmacSha256: string };
    expect(cStatus.stdout).not.toContain(keyHex);
    expect(cStatus.stdout).not.toContain(diskPolicy.hmacSha256);

    // 4. Real combo name `coding-primary` (NOT ^test-\d+$!) works in maintain apply & non-TTY apply --write!
    const mPlan = await captureCli(() =>
      runMaintainPlanCommand({ configPath, router: 'nine', stateDir, json: true })
    );
    expect(mPlan.exitCode).toBe(0);
    const { planHash } = JSON.parse(mPlan.stdout) as { planHash: string };

    const mApply = await captureCli(() =>
      runMaintainApplyCommand({
        only: 'coding-primary',
        configPath,
        router: 'nine',
        stateDir,
        planHash,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    );
    expect(mApply.exitCode).toBe(0);

    // C46-F1: Non-TTY `apply --write` MUST be rejected while consent is only `propose`,
    // while interactive TTY typing `'chay'` succeeds and records `appliedAtLevel: 'propose'`!
    const nonTtyAtPropose = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(nonTtyAtPropose.exitCode).toBe(1);

    seedNineDb();
    const ttyProposeApply = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(ttyProposeApply.exitCode).toBe(0);

    // Verify propose receipt recorded -> now promote coding-primary to auto-safe!
    const histBeforePromote = readApplyHistory(stateDir);
    expect(histBeforePromote.receipts.length).toBeGreaterThanOrEqual(1);
    expect(
      histBeforePromote.receipts[histBeforePromote.receipts.length - 1]?.appliedAtLevel
    ).toBe('propose');
    const promoteAutoSafe = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(promoteAutoSafe.exitCode).toBe(0);

    // AFTER promotion to auto-safe, non-TTY `apply --write` succeeds without prompt and records `auto-safe`!
    seedNineDb();
    const nonTtyAutoSafeApply = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(nonTtyAutoSafeApply.exitCode).toBe(0);
    const histAfterAutoSafe = readApplyHistory(stateDir);
    expect(
      histAfterAutoSafe.receipts[histAfterAutoSafe.receipts.length - 1]?.appliedAtLevel
    ).toBe('auto-safe');
    expect(
      histAfterAutoSafe.receipts[histAfterAutoSafe.receipts.length - 1]?.authorizedVia
    ).toBe('standing-consent');

    // 5. Run scheduled `tick` in `auto-safe` mode with official deprecation of gpt-4o-legacy + new gpt-5.5-codex
    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-24T10:00:00.000Z',
        providers: {
          openai: {
            prefix: 'openai',
            router: '9router',
            contentHash: 'seed-hash',
            hash: 'seed-hash',
            ids: [
              'gpt-4o-legacy',
              'gpt-4.1',
              'gpt-4.1-mini',
              'gpt-4.1-nano',
              'o3-mini',
              'o4-mini',
              'gpt-4o',
              'gpt-4o-mini',
              'gpt-4.5',
              'gpt-5-nano',
            ],
            absenceCounts: {},
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: '2026-11-24T10:00:00.000Z',
          },
        },
      }),
      'utf8'
    );

    appendResearchEvidence(stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'gpt-4o-legacy shut down on 2026-11-01.',
      shutdownDate: '2026-11-01',
      publishedAt: '2026-11-01T00:00:00.000Z',
      submittedVia: 'cli',
    });

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4.1' },
              { id: 'gpt-4.1-mini' },
              { id: 'gpt-4.1-nano' },
              { id: 'o3-mini' },
              { id: 'o4-mini' },
              { id: 'gpt-4o' },
              { id: 'gpt-4o-mini' },
              { id: 'gpt-4.5' },
              { id: 'gpt-5-nano' },
              { id: 'gpt-5.5-codex' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('http://127.0.0.1:')) {
        return globalThis.fetch(input, init);
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const tickSummary = await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: baseMs,
      minScanIntervalMs: 0,
      fetchFn: mockFetch,
      harnessTargets: [],
    });
    expect(tickSummary.effectiveMode).toBe('auto-safe');

    const postTickModels = readComboModels('coding-primary');
    expect(postTickModels).not.toContain('openai/gpt-4o-legacy');
    expect(postTickModels).toContain('openai/gpt-5.5-codex');

    const inboxText = fs.readFileSync(path.join(stateDir, 'inbox.json'), 'utf8');
    expect(inboxText).toContain('[AUTO-SAFE-APPLIED]');
    expect(webhookBodies.length).toBeGreaterThanOrEqual(1);

    // 6. Emergency `freeze` blocks CLI apply, maintain apply, tick auto-safe, AND daemon /api/v1/changes/approve
    const freezeRes = await captureCli(() =>
      runFreezeCommand({ reason: 'emergency-stop-test', stateDir, json: true })
    );
    expect(freezeRes.exitCode).toBe(0);

    const statusFrozen = await captureCli(() =>
      runStatusCommand({ configPath, stateDir, json: true })
    );
    expect(statusFrozen.exitCode).toBe(0);
    const statusJson = JSON.parse(statusFrozen.stdout) as Record<string, any>;
    expect(statusJson['frozen']).toBe(true);
    const targetItem = (statusJson['targets'] as Array<Record<string, any>>).find(
      (t) => t['target'] === 'router:nine/coding-primary'
    );
    expect(targetItem?.['effectiveLevel']).toBe('FROZEN');
    expect(targetItem?.['configuredLevel']).toBe('auto-safe');

    // CLI apply --write blocked while frozen
    const frozenApply = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir })
    );
    expect(frozenApply.exitCode).toBe(1);
    expect(frozenApply.stderr + frozenApply.stdout).toMatch(/FROZEN|frozen/i);

    // CLI maintain apply blocked while frozen
    const frozenMaintain = await captureCli(() =>
      runMaintainApplyCommand({
        only: 'coding-primary',
        configPath,
        router: 'nine',
        stateDir,
        planHash,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    );
    expect(frozenMaintain.exitCode).toBe(1);
    expect(frozenMaintain.stderr).toContain('MAINTAIN-REFUSED reason=frozen');

    // Tick in auto-safe skips writes and reports effectiveMode: 'FROZEN'
    const frozenTick = await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: baseMs + 60_000,
      minScanIntervalMs: 0,
      fetchFn: mockFetch,
      harnessTargets: [],
    });
    expect(frozenTick.effectiveMode).toBe('FROZEN');

    // Daemon /api/v1/changes/approve blocked with 403 write_frozen (hermetic R12-4)
    const daemonFx = await setupDaemonFixture();
    try {
      await captureCli(() =>
        runFreezeCommand({ reason: 'emergency-stop-daemon', stateDir: daemonFx.stateDir, json: true })
      );
      const daemonSrv = createDaemonServer({ host: '127.0.0.1' });
      await new Promise<void>((r) => daemonSrv.listen(0, '127.0.0.1', () => r()));
      try {
        const dPort = (daemonSrv.address() as AddressInfo).port;
        const tok = createApprovalToken('hash-frozen');
        const dRes = await fetch(`http://127.0.0.1:${dPort}/api/v1/changes/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planHash: 'hash-frozen', token: tok.token }),
        });
        expect(dRes.status).toBe(403);
        const dBody = (await dRes.json()) as Record<string, any>;
        expect(dBody['meta']?.['reason']).toBe('write_frozen');
      } finally {
        await new Promise<void>((r) => daemonSrv.close(() => r()));
      }
    } finally {
      daemonFx.restore();
      if (fs.existsSync(tmpRoot)) {
        process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
        process.env['ROUTERSYNC_CONFIG'] = configPath;
        process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
        process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpRoot, 'nonexistent-omniroute.sqlite');
      }
    }

    // Unfreeze rejects --yes and non-TTY, then succeeds with interactive 'unfreeze'
    const badUnfreezeYes = await captureCli(() =>
      runUnfreezeCommand({ stateDir, yes: true, isTTY: true })
    );
    expect(badUnfreezeYes.exitCode).toBe(1);

    const badUnfreezeNoTty = await captureCli(() =>
      runUnfreezeCommand({ stateDir, isTTY: false })
    );
    expect(badUnfreezeNoTty.exitCode).toBe(1);

    const okUnfreeze = await captureCli(() =>
      runUnfreezeCommand({
        stateDir,
        isTTY: true,
        promptFn: async () => 'unfreeze',
        json: true,
      })
    );
    expect(okUnfreeze.exitCode).toBe(0);

    const statusRestored = await captureCli(() =>
      runStatusCommand({ configPath, stateDir, json: true })
    );
    const restoredJson = JSON.parse(statusRestored.stdout) as Record<string, any>;
    expect(restoredJson['frozen']).toBe(false);
    const restoredTarget = (restoredJson['targets'] as Array<Record<string, any>>).find(
      (t) => t['target'] === 'router:nine/coding-primary'
    );
    expect(restoredTarget?.['effectiveLevel']).toBe('auto-safe');

    // Revoke consent
    const revokeRes = await captureCli(() =>
      runConsentRevokeCommand({ target: 'router:nine/coding-primary', stateDir, json: true })
    );
    expect(revokeRes.exitCode).toBe(0);
  }, 60_000);

  it('enforces unconditional adapter.rollback(snapshot) in applyPlanSafe even when staleDetected is false (M5) and blocks I6 invariant violations in auto-safe tick (M6)', async () => {
    const { stateDir, nineDbPath, configPath, readComboModels } = currentCtx;
    let rollbackCalled = false;
    const mockFailingAdapter = {
      name: 'mock-router',
      createSnapshot: async () => ({
        id: 'snap-1',
        router: 'mock-router',
        timestamp: '2026-11-24T00:00:00.000Z',
        combos: [],
      }),
      applyPlan: async () => ({
        success: false,
        target: 'mock-router',
        appliedAt: '2026-11-24T00:00:00.000Z',
        planId: 'p1',
        readBackVerified: false,
        staleDetected: false, // Previously skipped rollback! Must now rollback unconditionally!
        error: 'Partial SQLite write failure',
      }),
      readCombos: async () => [],
      rollback: async () => {
        rollbackCalled = true;
        return true;
      },
    };

    const failRes = await applyPlanSafe(
      mockFailingAdapter as any,
      {
        id: 'p1',
        target: 'mock-router',
        timestamp: '2026-11-24T00:00:00.000Z',
        additions: [{ id: 'c1', name: 'c1', models: ['a/m1', 'b/m2'], managed: true }],
        modifications: [],
        deletions: [],
      },
      { dryRun: false }
    );
    expect(failRes.success).toBe(false);
    expect(rollbackCalled).toBe(true);
    expect(failRes.rollbackExecuted).toBe(true);

    // M6 check in tick auto-safe: configure coding-primary as freeOnly: true and introduce a paid model -> MUST NOT add paid model!
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf8').replace('      freeOnly: false', '      freeOnly: true'),
      'utf8'
    );
    const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
    db.prepare("UPDATE combos SET kind = 'free' WHERE name = 'coding-primary'").run();
    db.close();

    // Seed verified propose receipt + auto-safe consent + L2 paid model price
    await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'propose',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
      })
    );
    const mPlan2 = await captureCli(() =>
      runMaintainPlanCommand({ configPath, router: 'nine', stateDir, json: true })
    );
    const { planHash: ph2 } = JSON.parse(mPlan2.stdout) as { planHash: string };
    await captureCli(() =>
      runMaintainApplyCommand({
        only: 'coding-primary',
        configPath,
        router: 'nine',
        stateDir,
        planHash: ph2,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    );
    await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
      })
    );

    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-24T10:00:00.000Z',
        providers: {
          openai: {
            prefix: 'openai',
            router: '9router',
            contentHash: 'seed-free',
            hash: 'seed-free',
            ids: [
              'gpt-4o-legacy',
              'gpt-4.1',
              'gpt-4.1-mini',
              'gpt-4.1-nano',
              'o3-mini',
              'o4-mini',
              'gpt-4o',
              'gpt-4o-mini',
              'gpt-4.5',
              'gpt-5-nano',
            ],
            absenceCounts: {},
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: '2026-11-24T10:00:00.000Z',
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(stateDir, 'l2-cache.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-24T12:30:00.000Z',
        models: {
          'openai/gpt-4o-legacy': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4.1': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4.1-mini': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4.1-nano': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/o3-mini': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/o4-mini': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4o': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4o-mini': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-4.5': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-5-nano': { price: 0, source: 'both', isZeroPriceHidden: false },
          'openai/gpt-5-paid-ultra': { price: 25, source: 'both', isZeroPriceHidden: false },
        },
      }),
      'utf8'
    );

    await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: Date.parse('2026-11-24T13:00:00.000Z'),
      minScanIntervalMs: 0,
      fetchFn: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('api.openai.com')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-4o-legacy' },
                { id: 'gpt-4.1' },
                { id: 'gpt-4.1-mini' },
                { id: 'gpt-4.1-nano' },
                { id: 'o3-mini' },
                { id: 'o4-mini' },
                { id: 'gpt-4o' },
                { id: 'gpt-4o-mini' },
                { id: 'gpt-4.5' },
                { id: 'gpt-5-nano' },
                { id: 'gpt-5-paid-ultra' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      harnessTargets: [],
    });

    // Metered model MUST NOT be added to freeOnly combo (kills M6)
    expect(readComboModels('coding-primary')).not.toContain('openai/gpt-5-paid-ultra');
  }, 60_000);

  it('F5: emits sanitized [AUTO-ROLLBACK] to inbox.json + outbound webhook (auto_rollback) and trips emergency freeze.json circuit breaker on auto-safe rollback', async () => {
    const { stateDir, nineDbPath, configPath, webhookBodies, readComboModels } = currentCtx;
    const preComboModels = readComboModels('coding-primary');

    // Promote router:nine/coding-primary to auto-safe via verified propose receipt
    await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'propose',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
      })
    );
    const mPlan = await captureCli(() =>
      runMaintainPlanCommand({ configPath, router: 'nine', stateDir, json: true })
    );
    const { planHash } = JSON.parse(mPlan.stdout) as { planHash: string };
    await captureCli(() =>
      runMaintainApplyCommand({
        only: 'coding-primary',
        configPath,
        router: 'nine',
        stateDir,
        planHash,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    );
    await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
      })
    );

    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-24T10:00:00.000Z',
        providers: {
          openai: {
            prefix: 'openai',
            router: '9router',
            contentHash: 'seed-f5',
            hash: 'seed-f5',
            ids: [
              'gpt-4o-legacy',
              'gpt-4.1',
              'gpt-4.1-mini',
              'gpt-4.1-nano',
              'o3-mini',
              'o4-mini',
              'gpt-4o',
              'gpt-4o-mini',
              'gpt-4.5',
              'gpt-5-nano',
            ],
            absenceCounts: {},
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: '2026-11-24T10:00:00.000Z',
          },
        },
      }),
      'utf8'
    );

    // Install SQLite AFTER UPDATE trigger that corrupts writes containing 'gpt-5.5-codex',
    // forcing post-write read-back mismatch and real snapshot rollback in tick auto-safe!
    const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
    db.exec(`
      CREATE TRIGGER f5_simulate_corrupt_write
      AFTER UPDATE ON combos
      WHEN NEW.models LIKE '%gpt-5.5-codex%'
      BEGIN
        UPDATE combos SET models = '[]' WHERE id = NEW.id;
      END;
    `);
    db.close();

    webhookBodies.length = 0;

    await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: Date.parse('2026-11-24T14:00:00.000Z'),
      minScanIntervalMs: 0,
      fetchFn: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('api.openai.com')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-4o-legacy' },
                { id: 'gpt-4.1' },
                { id: 'gpt-4.1-mini' },
                { id: 'gpt-4.1-nano' },
                { id: 'o3-mini' },
                { id: 'o4-mini' },
                { id: 'gpt-4o' },
                { id: 'gpt-4o-mini' },
                { id: 'gpt-4.5' },
                { id: 'gpt-5-nano' },
                { id: 'gpt-5.5-codex' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.startsWith('http://127.0.0.1:')) {
          return globalThis.fetch(input, init);
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      harnessTargets: [],
    });

    // 1. Pre-apply combo models restored cleanly by snapshot rollback
    expect(readComboModels('coding-primary')).toEqual(preComboModels);

    // 2. Apply history records rolledBack: true receipt
    const receipts = readApplyHistory(stateDir).receipts;
    const autoSafeReceipt = receipts.find((r) => r.appliedAtLevel === 'auto-safe');
    expect(autoSafeReceipt?.rolledBack).toBe(true);
    expect(autoSafeReceipt?.success).toBe(false);

    // 3. inbox.json contains sanitized [AUTO-ROLLBACK] notification
    const inboxRaw = fs.readFileSync(path.join(stateDir, 'inbox.json'), 'utf8');
    expect(inboxRaw).toContain('[AUTO-ROLLBACK]');
    expect(inboxRaw).not.toContain('dummy-openai-sandbox-key');

    // 4. Outbound webhook received auto_rollback alert
    const rawWebhook = JSON.stringify(webhookBodies);
    expect(rawWebhook).toContain('auto_rollback');
    expect(rawWebhook).toContain('AUTO_ROLLBACK');
    expect(rawWebhook).not.toContain('dummy-openai-sandbox-key');

    // 5. Emergency freeze circuit breaker tripped automatically
    const freeze = readFreezeState(stateDir);
    expect(freeze.frozen).toBe(true);
  }, 60_000);
});
