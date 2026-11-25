/**
 * packages/cli/test/c46-f1-propose-gate.test.ts
 *
 * Ticket C46-F1 Red-First CLI Suite (Ph?c v?: S3, S4, S9):
 * Enforces human approval on `propose` across `routersync apply --write`,
 * verifies `auto-safe` runtime receipt integrity (`AUTO_SAFE_RECEIPT_MISSING`),
 * records accurate `appliedAtLevel` & `authorizedVia`, blocks `standing-consent`
 * receipts from satisfying `findVerifiedProposeReceipt`, and guards `maintain`/`tick`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openBetterSqlite3,
  NINE_ROUTER_EXPECTED_APP_VERSION,
  appendApplyReceipt,
  appendResearchEvidence,
  assertEligibleForAutoSafe,
  canonicalJsonStringify,
  computeHmacSha256Hex,
  ConsentValidationError,
  ensureConsentSigningKey,
  findVerifiedProposeReceipt,
  readApplyHistory,
  readStandingConsent,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { resetTokenRegistry } from '@routersync/daemon';
import { runConsentGrantCommand } from '../src/commands/consent.js';
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

describe('C46-F1 CLI Propose Human-Approval Gate & Receipt Integrity', () => {
  let tmpRoot: string;
  let stateDir: string;
  let nineDbPath: string;
  let configPath: string;

  const INITIAL_COMBO_MODELS = [
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

  const PLANNED_PIN_MODELS_V1 = [
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1-nano',
    'openai/o3-mini',
    'openai/o4-mini',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-4.5',
    'openai/gpt-5-nano',
    'openai/gpt-4o-legacy',
  ];

  const PLANNED_PIN_MODELS_V2 = [
    'openai/gpt-4.1-mini',
    'openai/gpt-4.1',
    'openai/gpt-4.1-nano',
    'openai/o3-mini',
    'openai/o4-mini',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-4.5',
    'openai/gpt-5-nano',
    'openai/gpt-4o-legacy',
  ];

  function writeConfig(pinnedModels: string[]): void {
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    isolated: false',
        '    baseUrl: http://127.0.0.1:9',
        '    db:',
        `      path: ${nineDbPath}`,
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
        ...pinnedModels.map((m) => `      - ${m}`),
        '    autoMaintain: true',
        'adopt:',
        '  - router: nine',
        '    name: coding-primary',
        '    mode: full',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  function seedNineDb(models: string[] = INITIAL_COMBO_MODELS): void {
    const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
    const now = '2026-11-25T00:00:00.000Z';
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
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      DELETE FROM combos;
      DELETE FROM providerConnections;
      DELETE FROM models;
      DELETE FROM settings;
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
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
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
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('coding-primary', 'coding-primary', null, JSON.stringify(models), now, now);
    db.close();
  }

  function readComboModels(name: string): string[] {
    const db = openBetterSqlite3(nineDbPath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
        .get(name, name) as { models: string } | undefined;
      return row ? (JSON.parse(row.models) as string[]) : [];
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f1-cli-'));
    stateDir = path.join(tmpRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    nineDbPath = path.join(tmpRoot, 'nine-sandbox.sqlite');
    configPath = path.join(tmpRoot, 'routersync.yaml');

    seedNineDb(INITIAL_COMBO_MODELS);
    writeConfig(PLANNED_PIN_MODELS_V1);

    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_CONFIG'] = configPath;
    process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpRoot, 'nonexistent-omniroute.sqlite');
    process.env['ROUTERSYNC_HOME'] = path.join(tmpRoot, 'home');
    process.env['APPDATA'] = path.join(tmpRoot, 'appdata');
    process.env['LOCALAPPDATA'] = path.join(tmpRoot, 'local');
    process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] = '1';
    resetTokenRegistry();
  });

  afterEach(() => {
    resetTokenRegistry();
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIGINAL_ENV);
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('1. REJECTS non-TTY apply --write when standing consent is only propose (0 DB changes, 0 receipts ? kills M1)', async () => {
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });

    const nonTtyRes = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(nonTtyRes.exitCode).toBe(1);
    expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(0);
  });

  it('2. REQUIRES interactive TTY typing chay at propose; cancels on no/empty and records interactive-tty + propose on chay (still rejects non-TTY afterwards while at propose)', async () => {
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });

    for (const rejectWord of ['no', '']) {
      const cancelled = await captureCli(() =>
        runApplyCommand({
          configPath,
          write: true,
          stateDir,
          isTTY: true,
          promptFn: async () => rejectWord,
          json: true,
        })
      );
      expect(cancelled.exitCode).toBe(0);
      expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);
      expect(readApplyHistory(stateDir).receipts).toHaveLength(0);
    }

    const approved = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(approved.exitCode).toBe(0);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);

    const hist = readApplyHistory(stateDir);
    expect(hist.valid).toBe(true);
    expect(hist.receipts).toHaveLength(1);
    expect(hist.receipts[0]?.target).toBe('router:nine/coding-primary');
    expect(hist.receipts[0]?.authorizedVia).toBe('interactive-tty');
    expect(hist.receipts[0]?.appliedAtLevel).toBe('propose');

    // Even AFTER a verified propose receipt exists, if level is still 'propose' (not promoted to auto-safe),
    // non-TTY apply --write MUST STILL be rejected! (kills M1 even if receipt check is combined)
    writeConfig(PLANNED_PIN_MODELS_V2);
    const stillProposeNonTty = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(stillProposeNonTty.exitCode).toBe(1);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(1);
  });

  it('3. SUCCEEDS without prompting in non-TTY apply --write AFTER promotion to auto-safe and records standing-consent + auto-safe (kills M3)', async () => {
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });

    const firstPropose = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(firstPropose.exitCode).toBe(0);

    const promoteRes = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(promoteRes.exitCode).toBe(0);

    // Introduce a new combo diff and run non-TTY apply --write without prompt
    writeConfig(PLANNED_PIN_MODELS_V2);
    const autoSafeApply = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: false,
        promptFn: async () => {
          throw new Error('promptFn must NOT be called for verified auto-safe standing consent');
        },
        json: true,
      })
    );
    expect(autoSafeApply.exitCode).toBe(0);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V2);

    const hist = readApplyHistory(stateDir);
    expect(hist.valid).toBe(true);
    expect(hist.receipts).toHaveLength(2);
    const latest = hist.receipts[hist.receipts.length - 1]!;
    expect(latest.target).toBe('router:nine/coding-primary');
    expect(latest.authorizedVia).toBe('standing-consent');
    expect(latest.appliedAtLevel).toBe('auto-safe');
  });

  it('4. REJECTS auto-safe apply --write with AUTO_SAFE_RECEIPT_MISSING when apply-history.json is deleted or propose receipt has rolledBack: true (kills M2)', async () => {
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });
    const firstPropose = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(firstPropose.exitCode).toBe(0);

    const promoteRes = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(promoteRes.exitCode).toBe(0);

    // (a) Delete apply-history.json -> must fail closed with AUTO_SAFE_RECEIPT_MISSING and 0 DB writes
    writeConfig(PLANNED_PIN_MODELS_V2);
    const historyFile = path.join(stateDir, 'apply-history.json');
    const savedHistoryRaw = fs.readFileSync(historyFile, 'utf8');
    fs.unlinkSync(historyFile);

    const missingHistRes = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(missingHistRes.exitCode).toBe(1);
    expect(missingHistRes.stdout + missingHistRes.stderr).toContain('AUTO_SAFE_RECEIPT_MISSING');
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);

    // (b) Re-sign apply-history.json with rolledBack: true on the propose receipt -> must fail closed with AUTO_SAFE_RECEIPT_MISSING
    const parsedHist = JSON.parse(savedHistoryRaw) as {
      version: 1;
      updatedAt: string;
      receipts: Array<Record<string, unknown>>;
    };
    parsedHist.receipts[0]!['rolledBack'] = true;
    const signingKey = ensureConsentSigningKey(stateDir);
    const canonical = canonicalJsonStringify({
      version: 1,
      updatedAt: parsedHist.updatedAt,
      receipts: parsedHist.receipts,
    });
    const reSigned = {
      version: 1,
      updatedAt: parsedHist.updatedAt,
      receipts: parsedHist.receipts,
      hmacSha256: computeHmacSha256Hex(signingKey, canonical),
    };
    fs.writeFileSync(historyFile, JSON.stringify(reSigned, null, 2), 'utf8');

    const rolledBackHistRes = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(rolledBackHistRes.exitCode).toBe(1);
    expect(rolledBackHistRes.stdout + rolledBackHistRes.stderr).toContain(
      'AUTO_SAFE_RECEIPT_MISSING'
    );
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);
  });

  it('5. NEVER accepts a standing-consent receipt in findVerifiedProposeReceipt even if appliedAtLevel is propose (kills M5)', async () => {
    appendApplyReceipt(stateDir, {
      target: 'router:nine/coding-primary',
      planHash: 'abcdef0123456789',
      appliedAt: '2026-11-25T01:00:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'standing-consent',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-forged-standing',
    });

    expect(findVerifiedProposeReceipt(stateDir, 'router:nine/coding-primary')).toBeNull();
    expect(() =>
      assertEligibleForAutoSafe(stateDir, 'router:nine/coding-primary')
    ).toThrowError(ConsentValidationError);

    const denyGrant = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(denyGrant.exitCode).toBe(1);
    expect(denyGrant.stdout + denyGrant.stderr).toContain('AUTO_SAFE_PROMOTION_DENIED');

    // Human-approved authorizedVia values ARE accepted
    for (const validVia of ['interactive-tty', 'approval-token', 'legacy-grant'] as const) {
      const subState = fs.mkdtempSync(path.join(tmpRoot, `via-${validVia}-`));
      appendApplyReceipt(subState, {
        target: 'router:nine/coding-primary',
        planHash: 'abcdef0123456789',
        appliedAt: '2026-11-25T01:05:00.000Z',
        appliedAtLevel: 'propose',
        authorizedVia: validVia,
        success: true,
        readBackVerified: true,
        readBackLevel: 'db-only',
        rolledBack: false,
        snapshotOrBackupRef: `snap-${validVia}`,
      });
      expect(findVerifiedProposeReceipt(subState, 'router:nine/coding-primary')?.authorizedVia).toBe(
        validVia
      );
    }
  });

  it('6. Regression guards: maintain apply refuses non-TTY without grant at propose, and tick performs 0 writes on propose-only targets in both propose and auto-safe modes', async () => {
    const harnessPath = path.join(tmpRoot, 'opencode.jsonc');
    const initialHarnessRaw = [
      '{',
      '  "model": "openai/gpt-4.1",',
      '  "provider": {',
      '    "openai": {',
      '      "options": {',
      '        "apiKey": "dummy-openai-sandbox-key",',
      '        "baseURL": "https://api.openai.com/v1"',
      '      },',
      '      "models": {',
      '        "gpt-4o-legacy": { "name": "GPT-4o Legacy" },',
      '        "gpt-4.1": { "name": "GPT-4.1" }',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(harnessPath, initialHarnessRaw, 'utf8');

    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });
    upsertStandingConsentTarget(stateDir, {
      target: 'harness:opencode',
      level: 'propose',
    });

    // (a) maintain apply with propose consent and isTTY: false (no grant) -> refused with reason=no-tty
    const mPlan = await captureCli(() =>
      runMaintainPlanCommand({ configPath, router: 'nine', stateDir, json: true })
    );
    expect(mPlan.exitCode).toBe(0);
    const { planHash } = JSON.parse(mPlan.stdout) as { planHash: string };

    const mRefused = await captureCli(() =>
      runMaintainApplyCommand({
        only: 'coding-primary',
        configPath,
        router: 'nine',
        stateDir,
        planHash,
        isTTY: false,
      })
    );
    expect(mRefused.exitCode).toBe(1);
    expect(mRefused.stderr).toContain('MAINTAIN-REFUSED reason=no-tty');
    expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);

    // (b) tick in --mode propose and --mode auto-safe on propose-only targets performs 0 router/harness writes
    const baseMs = Date.parse('2026-11-25T12:00:00.000Z');
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-25T10:00:00.000Z',
        providers: {
          openai: {
            prefix: 'openai',
            router: '9router',
            contentHash: 'seed-hash',
            hash: 'seed-hash',
            ids: [...INITIAL_COMBO_MODELS.map((m) => m.replace('openai/', ''))],
            absenceCounts: {},
            consecutiveFailures: 0,
            backoffUntilMs: 0,
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: '2026-11-25T10:00:00.000Z',
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

    const mockFetch: typeof globalThis.fetch = async (input) => {
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
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const tickPropose = await runTickCommand({
      configPath,
      stateDir,
      mode: 'propose',
      nowMs: baseMs,
      minScanIntervalMs: 0,
      fetchFn: mockFetch,
      harnessTargets: [
        {
          harnessId: 'opencode',
          configPath: harnessPath,
          defaultModels: ['openai/gpt-4.1'],
          providers: [
            {
              providerId: 'openai',
              models: ['gpt-4o-legacy', 'gpt-4.1'],
              keyPresent: true,
            },
          ],
        },
      ],
    });
    expect(tickPropose.effectiveMode).toBe('propose');
    expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);
    expect(fs.readFileSync(harnessPath, 'utf8')).toBe(initialHarnessRaw);

    const tickAutoSafeOnProposeOnly = await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: baseMs + 60_000,
      minScanIntervalMs: 0,
      fetchFn: mockFetch,
      harnessTargets: [
        {
          harnessId: 'opencode',
          configPath: harnessPath,
          defaultModels: ['openai/gpt-4.1'],
          providers: [
            {
              providerId: 'openai',
              models: ['gpt-4o-legacy', 'gpt-4.1'],
              keyPresent: true,
            },
          ],
        },
      ],
    });
    expect(tickAutoSafeOnProposeOnly.effectiveMode).toBe('auto-safe');
    expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);
    expect(fs.readFileSync(harnessPath, 'utf8')).toBe(initialHarnessRaw);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(0);
  });

  it('7. REJECTS non-TTY apply --write on mixed multi-combo batch (1 auto-safe + 1 propose) with 0 DB mutations on both combos, and stamps interactive-tty + propose on chay (kills Q1b)', async () => {
    const seedSecondaryCombo = (models: string[] = INITIAL_COMBO_MODELS): void => {
      const db = openBetterSqlite3(nineDbPath, { allowLiveDbWrite: true });
      const now = '2026-11-25T00:00:00.000Z';
      db.prepare(
        'INSERT OR REPLACE INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('coding-secondary', 'coding-secondary', null, JSON.stringify(models), now, now);
      db.close();
    };

    const writeTwoComboConfig = (primaryPin: string[], secondaryPin: string[]): void => {
      fs.writeFileSync(
        configPath,
        [
          'version: 1',
          'routers:',
          '  - id: nine',
          '    adapter: 9router',
          '    isolated: false',
          '    baseUrl: http://127.0.0.1:9',
          '    db:',
          `      path: ${nineDbPath}`,
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
          ...primaryPin.map((m) => `      - ${m}`),
          '    autoMaintain: true',
          '  - name: coding-secondary',
          '    routers:',
          '      - nine',
          '    size: 10',
          '    constraints:',
          '      freeOnly: false',
          '    pin:',
          ...secondaryPin.map((m) => `      - ${m}`),
          '    autoMaintain: true',
          'adopt:',
          '  - router: nine',
          '    name: coding-primary',
          '    mode: full',
          '  - router: nine',
          '    name: coding-secondary',
          '    mode: full',
          '',
        ].join('\n'),
        'utf8'
      );
    };

    // 1) Obtain a verified propose receipt for coding-primary and promote it to auto-safe
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });
    const firstPrimaryPropose = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(firstPrimaryPropose.exitCode).toBe(0);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);

    const promotePrimary = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:nine/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(promotePrimary.exitCode).toBe(0);

    // 2) Add coding-secondary at propose with pending changes on BOTH combos
    seedSecondaryCombo(INITIAL_COMBO_MODELS);
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-secondary',
      level: 'propose',
    });
    writeTwoComboConfig(PLANNED_PIN_MODELS_V2, PLANNED_PIN_MODELS_V1);

    const receiptsBeforeMixed = readApplyHistory(stateDir).receipts.length;
    expect(receiptsBeforeMixed).toBe(1);

    // Non-TTY apply --write MUST fail with 0 DB mutations on BOTH combos and 0 new receipts
    const mixedNonTty = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(mixedNonTty.exitCode).toBe(1);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);
    expect(readComboModels('coding-secondary')).toEqual(INITIAL_COMBO_MODELS);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(receiptsBeforeMixed);

    // Interactive TTY confirming 'chay' MUST succeed and stamp interactive-tty + propose
    const mixedTtyApproved = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(mixedTtyApproved.exitCode).toBe(0);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V2);
    expect(readComboModels('coding-secondary')).toEqual(PLANNED_PIN_MODELS_V1);

    const histAfterApproved = readApplyHistory(stateDir);
    expect(histAfterApproved.valid).toBe(true);
    const newReceipts = histAfterApproved.receipts.slice(receiptsBeforeMixed);
    expect(newReceipts).toHaveLength(2);
    expect(newReceipts.map((r) => r.target).sort()).toEqual([
      'router:nine/coding-primary',
      'router:nine/coding-secondary',
    ]);
    for (const r of newReceipts) {
      expect(r.authorizedVia).toBe('interactive-tty');
      expect(r.appliedAtLevel).toBe('propose');
    }

    // Symmetric order guard (coding-primary propose + coding-secondary auto-safe)
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });
    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-secondary',
      level: 'auto-safe',
    });
    writeTwoComboConfig(INITIAL_COMBO_MODELS, PLANNED_PIN_MODELS_V2);
    const receiptsBeforeReverse = readApplyHistory(stateDir).receipts.length;

    const reverseMixedNonTty = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(reverseMixedNonTty.exitCode).toBe(1);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V2);
    expect(readComboModels('coding-secondary')).toEqual(PLANNED_PIN_MODELS_V1);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(receiptsBeforeReverse);
  });

  it('8. REJECTS non-TTY apply --write on dual-scope conflict when router:9router/coding-primary is auto-safe and router:nine/coding-primary is propose (kills Q1a)', async () => {
    appendApplyReceipt(stateDir, {
      target: 'router:9router/coding-primary',
      planHash: 'abcdef0123456789',
      appliedAt: '2026-11-25T01:00:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-adapter-propose',
    });

    const grantAdapterAutoSafe = await captureCli(() =>
      runConsentGrantCommand({
        target: 'router:9router/coding-primary',
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      })
    );
    expect(grantAdapterAutoSafe.exitCode).toBe(0);

    upsertStandingConsentTarget(stateDir, {
      target: 'router:nine/coding-primary',
      level: 'propose',
    });

    const standing = readStandingConsent(stateDir);
    expect(standing.valid).toBe(true);
    expect(standing.activeTargets.map((e) => `${e.target}:${e.level}`).sort()).toEqual([
      'router:9router/coding-primary:auto-safe',
      'router:nine/coding-primary:propose',
    ]);

    const conflictNonTty = await captureCli(() =>
      runApplyCommand({ configPath, write: true, stateDir, isTTY: false, json: true })
    );
    expect(conflictNonTty.exitCode).toBe(1);
    expect(readComboModels('coding-primary')).toEqual(INITIAL_COMBO_MODELS);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(1);

    const conflictTtyApproved = await captureCli(() =>
      runApplyCommand({
        configPath,
        write: true,
        stateDir,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      })
    );
    expect(conflictTtyApproved.exitCode).toBe(0);
    expect(readComboModels('coding-primary')).toEqual(PLANNED_PIN_MODELS_V1);
    const latestReceipt = readApplyHistory(stateDir).receipts.at(-1)!;
    expect(latestReceipt.target).toBe('router:nine/coding-primary');
    expect(latestReceipt.authorizedVia).toBe('interactive-tty');
    expect(latestReceipt.appliedAtLevel).toBe('propose');
  });

  it('9. ISOLATES single negative flags in findVerifiedProposeReceipt (readBackVerified=false, success=false, appliedAtLevel=auto-safe) with valid HMAC (kills Q2b, Q2c, Q2d)', () => {
    const assertRejectedCase = (subState: string): void => {
      const hist = readApplyHistory(subState);
      expect(hist.valid).toBe(true);
      expect(hist.receipts).toHaveLength(1);
      expect(findVerifiedProposeReceipt(subState, 'router:nine/coding-primary')).toBeNull();
      let caught: unknown;
      try {
        assertEligibleForAutoSafe(subState, 'router:nine/coding-primary');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConsentValidationError);
      expect((caught as ConsentValidationError).code).toBe('AUTO_SAFE_PROMOTION_DENIED');
    };

    // Q2b: readBackVerified: false ONLY (every other field valid)
    const q2bState = fs.mkdtempSync(path.join(tmpRoot, 'q2b-unverified-'));
    appendApplyReceipt(q2bState, {
      target: 'router:nine/coding-primary',
      planHash: 'abcdef0123456789',
      appliedAt: '2026-11-25T02:00:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: false,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-q2b-only',
    });
    assertRejectedCase(q2bState);

    // Q2c: success: false ONLY (every other field valid)
    const q2cState = fs.mkdtempSync(path.join(tmpRoot, 'q2c-unsuccessful-'));
    appendApplyReceipt(q2cState, {
      target: 'router:nine/coding-primary',
      planHash: 'abcdef0123456789',
      appliedAt: '2026-11-25T02:01:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: false,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-q2c-only',
    });
    assertRejectedCase(q2cState);

    // Q2d: appliedAtLevel: 'auto-safe' ONLY (authorizedVia='approval-token', success=true, readBackVerified=true, rolledBack=false)
    const q2dState = fs.mkdtempSync(path.join(tmpRoot, 'q2d-autosafe-level-'));
    appendApplyReceipt(q2dState, {
      target: 'router:nine/coding-primary',
      planHash: 'abcdef0123456789',
      appliedAt: '2026-11-25T02:02:00.000Z',
      appliedAtLevel: 'auto-safe',
      authorizedVia: 'approval-token',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-q2d-only',
    });
    assertRejectedCase(q2dState);
  });
});
