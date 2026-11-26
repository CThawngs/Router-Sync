/**
 * packages/cli/test/c48-h1-h2-latency-settle.test.ts
 *
 * Ticket C48-H1-H4 (`Phục vụ: S9`) — Red-First TDD & 5-Case Isolated Fixture Suite:
 *  - H1: Separates absence `detectionMs` (qualifying scan start -> committed `model_pending`
 *    record, single sample per absence episode, distinct timestamps via injectable `clock`)
 *    from `removalSettleMs` (first observed absence -> actual removal, no time ceiling).
 *  - Preserves official-notice `published-to-plan` detection latency and all policy guards
 *    (`60000 ms`, `10%`, `24h`, `>= 2` grace cycles / `>= 3` valid scans).
 *  - Reports `observedScanIntervalMs` when known and `providerToFirstScanMs: null`
 *    (`unobservableWindow: 'provider-to-first-scan'`).
 *  - Rejects legacy ambiguous `ABSENT_STABLE` `detectionLatencyMs` values as new proof.
 *  - H2: Executes the 5-case isolated fixture rehearsal in `os.tmpdir()` over a 10-model
 *    `rs-pilot` combo + Hermes YAML copy with real apply & rollback verification.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NINE_ROUTER_EXPECTED_APP_VERSION,
  appendApplyReceipt,
  appendResearchEvidence,
  canonicalJsonStringify,
  computeHmacSha256Hex,
  markApplyReceiptRolledBack,
  openBetterSqlite3,
  readApplyHistory,
  researchEvidenceIdentity,
  readConsentSigningKeyIfPresent,
  upsertStandingConsentTarget,
} from '@routersync/core';
import * as adaptersMod from '../src/adapters.js';
import { HARNESS_WRITE_ADAPTERS } from '../src/apps/write-adapter.js';
import { runApplyCommand } from '../src/commands/apply.js';
import {
  runAppsApplyCommand,
  runAppsPlanCommand,
  runAppsRollbackCommand,
} from '../src/commands/apps.js';
import { runConsentGrantCommand } from '../src/commands/consent.js';
import { runFreezeCommand, runUnfreezeCommand } from '../src/commands/freeze.js';
import { runLiveCheckCommand } from '../src/commands/live-check.js';
import {
  HARD_PASS_MAX_DETECTION_LATENCY_MS,
  runPilotReportCommand,
} from '../src/commands/pilot-report.js';
import { runPlanCommand } from '../src/commands/plan.js';
import { runRollbackCommand } from '../src/commands/rollback.js';
import { runTickCommand, type TickCatalogState, type TickPlanFile } from '../src/commands/tick.js';
import {
  TARGET_REMOVAL_MAX_SHRINK_RATIO,
  evaluateAbsentStable,
} from '../src/verify/index.js';

const LIVE_NINE_MODELS = [
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

const ABSENT_TENTH_MODEL = 'openai/gpt-4o-legacy';

const INITIAL_TEN_MODELS = [ABSENT_TENTH_MODEL, ...LIVE_NINE_MODELS];
const PROPOSE_REORDERED_TEN_MODELS = [...LIVE_NINE_MODELS, ABSENT_TENTH_MODEL];

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

interface PilotFixtureHarness {
  tmpRoot: string;
  stateDir: string;
  routerDir: string;
  routerDbPath: string;
  configPath: string;
  fakeHome: string;
  hermesConfigPath: string;
  hermesBakPath: string;
  preHermesSha: string;
  baseMs: number;
  readComboRowModels: () => string[];
}

function createIsolatedTenModelPilotFixture(prefix: string): PilotFixtureHarness {
  const tmpRoot = makeTmpDir(prefix);
  const stateDir = path.join(tmpRoot, 'state');
  const fakeHome = path.join(tmpRoot, 'home');
  const routerDir = path.join(tmpRoot, 'router');
  const backupDir = path.join(tmpRoot, 'backups');
  const hermesDir = path.join(fakeHome, '.hermes');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(routerDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(hermesDir, { recursive: true });

  vi.stubEnv('ROUTERSYNC_STATE_DIR', stateDir);
  vi.stubEnv('ROUTERSYNC_HOME', fakeHome);
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fakeHome, '.config'));
  vi.stubEnv('HERMES_HOME', hermesDir);

  const baseMs = Date.parse('2026-11-26T08:00:00.000Z');
  const initialIso = new Date(baseMs - 5 * 60_000).toISOString();
  const routerDbPath = path.join(routerDir, 'nine-c48-pilot.sqlite');

  const db = openBetterSqlite3(routerDbPath, { restrictToDir: routerDir });
  db.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT,
      models TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE providerConnections (
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
    CREATE TABLE providerNodes (
      id TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      data TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      modelId TEXT NOT NULL,
      isActive INTEGER DEFAULT 1
    );
    CREATE TABLE kv (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings (id, data) VALUES (1, '{}');
  `);

  for (const fullId of INITIAL_TEN_MODELS) {
    db.prepare('INSERT INTO models (id, provider, modelId, isActive) VALUES (?, ?, ?, 1)').run(
      fullId,
      'openai',
      fullId.split('/')[1]!
    );
  }
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
    'OpenAI C48 Fixture',
    null,
    1,
    1,
    JSON.stringify({
      apiKey: 'dummy-c48-fixture-key',
      baseUrl: 'https://api.openai.com/v1',
      prefix: 'openai',
    }),
    initialIso,
    initialIso
  );
  db.prepare(
    'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('rs-pilot', 'rs-pilot', null, JSON.stringify(INITIAL_TEN_MODELS), initialIso, initialIso);
  db.close();

  vi.stubEnv('ROUTERSYNC_9ROUTER_DB', routerDbPath);
  vi.stubEnv('ROUTERSYNC_OMNIROUTE_DB', path.join(routerDir, 'absent-omni.sqlite'));

  fs.writeFileSync(path.join(hermesDir, '.env'), 'OPENAI_API_KEY=dummy-hermes-c48-key\n', 'utf8');
  const hermesConfigPath = path.join(hermesDir, 'config.yaml');
  const hermesBakPath = `${hermesConfigPath}.pre-pilot.bak`;
  fs.writeFileSync(
    hermesConfigPath,
    [
      '# Hermes C48 isolated pilot config',
      'model:',
      '  provider: openai',
      '  default: openai/gpt-4.1',
      'providers:',
      '  openai:',
      '    base_url: https://api.openai.com/v1',
      '    api_key_env: OPENAI_API_KEY',
      '    models:',
      '      - gpt-4.1',
      '      - gpt-4.1-mini',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.copyFileSync(hermesConfigPath, hermesBakPath);
  const preHermesSha = sha256File(hermesConfigPath);

  const configPath = path.join(routerDir, 'routersync.yaml');
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
      `      path: ${JSON.stringify(routerDbPath)}`,
      '    reload:',
      '      type: none',
      'schedule:',
      '  intervalMinutes: 15',
      'combos:',
      '  - name: rs-pilot',
      '    routers:',
      '      - nine',
      '    size: 10',
      '    constraints:',
      '      freeOnly: false',
      '    pin:',
      ...PROPOSE_REORDERED_TEN_MODELS.map((m) => `      - ${m}`),
      '    autoMaintain: true',
      'adopt:',
      '  - router: nine',
      '    name: rs-pilot',
      '    mode: full',
      '',
    ].join('\n'),
    'utf8'
  );

  const readComboRowModels = (): string[] => {
    const ro = openBetterSqlite3(routerDbPath, { readOnly: true, restrictToDir: routerDir });
    try {
      const row = ro.prepare('SELECT models FROM combos WHERE name = ?').get('rs-pilot') as {
        models: string;
      };
      return JSON.parse(row.models) as string[];
    } finally {
      ro.close();
    }
  };

  return {
    tmpRoot,
    stateDir,
    routerDir,
    routerDbPath,
    configPath,
    fakeHome,
    hermesConfigPath,
    hermesBakPath,
    preHermesSha,
    baseMs,
    readComboRowModels,
  };
}

async function prepareDay0PilotToAutoSafe(
  fx: PilotFixtureHarness,
  observeFetch: typeof fetch
): Promise<{ snapId: string }> {
  await runTickCommand({
    configPath: fx.configPath,
    stateDir: fx.stateDir,
    mode: 'observe',
    nowMs: fx.baseMs,
    fetchFn: observeFetch,
    json: true,
  });

  const liveCheck = await runLiveCheckCommand({
    config: fx.configPath,
    stateDir: fx.stateDir,
    routerTarget: 'router:nine/rs-pilot',
    harnessTarget: 'harness:hermes',
    harnessConfigPath: fx.hermesConfigPath,
    nowMs: fx.baseMs + 1_000,
    json: true,
  });
  expect(liveCheck.status).toBe('READY_FOR_OWNER_LIVE_PILOT');

  await runConsentGrantCommand({
    target: 'router:nine/rs-pilot',
    level: 'propose',
    stateDir: fx.stateDir,
    isTTY: true,
    promptFn: async () => 'consent',
    json: true,
  });
  await runConsentGrantCommand({
    target: 'harness:hermes',
    level: 'propose',
    stateDir: fx.stateDir,
    isTTY: true,
    promptFn: async () => 'consent',
    json: true,
  });

  await runPlanCommand({ configPath: fx.configPath, json: true });
  await runAppsPlanCommand({
    app: 'hermes',
    config: fx.hermesConfigPath,
    stateDir: fx.stateDir,
    home: fx.fakeHome,
    json: true,
  });

  const applyOut = await runApplyCommand({
    configPath: fx.configPath,
    stateDir: fx.stateDir,
    write: true,
    isTTY: true,
    promptFn: async () => 'chay',
    json: true,
  });
  const snapId = applyOut.snapshots?.[0]?.snapshotId;
  expect(snapId).toBeTruthy();

  await runAppsApplyCommand({
    app: 'hermes',
    config: fx.hermesConfigPath,
    backup: fx.hermesBakPath,
    stateDir: fx.stateDir,
    home: fx.fakeHome,
    write: true,
    isTTY: true,
    promptFn: async () => 'chay',
    json: true,
  });

  expect(sha256File(fx.hermesConfigPath)).not.toBe(fx.preHermesSha);

  await runConsentGrantCommand({
    target: 'router:nine/rs-pilot',
    level: 'auto-safe',
    stateDir: fx.stateDir,
    isTTY: true,
    promptFn: async () => 'consent',
    json: true,
  });
  await runConsentGrantCommand({
    target: 'harness:hermes',
    level: 'auto-safe',
    stateDir: fx.stateDir,
    isTTY: true,
    promptFn: async () => 'consent',
    json: true,
  });

  return { snapId: snapId! };
}

async function runFreezeUnfreezeAndRollback(fx: PilotFixtureHarness, snapId: string): Promise<void> {
  await runFreezeCommand({ reason: 'c48-pilot-drill', stateDir: fx.stateDir, json: true });
  await runUnfreezeCommand({
    stateDir: fx.stateDir,
    isTTY: true,
    promptFn: async () => 'unfreeze',
    json: true,
  });

  await runRollbackCommand({
    configPath: fx.configPath,
    stateDir: fx.stateDir,
    snapshotId: snapId,
    write: true,
    isTTY: true,
    promptFn: async () => 'chay',
    json: true,
  });
  await runAppsRollbackCommand({
    app: 'hermes',
    config: fx.hermesConfigPath,
    backup: fx.hermesBakPath,
    expectedPreSha256: fx.preHermesSha,
    stateDir: fx.stateDir,
    json: true,
  });
}

afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('C48-H1: Detection Latency vs Removal Settlement Separation & Policy Guards', () => {
  it('preserves policy constants: 60000ms detection ceiling, 10% shrink cap, 24h & >=3 scans absence-only gate', () => {
    expect(HARD_PASS_MAX_DETECTION_LATENCY_MS).toBe(60_000);
    expect(TARGET_REMOVAL_MAX_SHRINK_RATIO).toBe(0.10);

    const t0 = Date.parse('2026-11-26T00:00:00.000Z');
    // 23h59m59.999s with 3 scans -> NOT absent stable
    expect(
      evaluateAbsentStable({
        id: 'gpt-4o-legacy',
        prefix: 'openai',
        absenceCount: 3,
        firstAbsentAtMs: t0,
        nowMs: t0 + 86_400_000 - 1,
        lastLabel: 'OK',
        l2ExternalExists: false,
        providerCoveredByExternal: false,
        comboStepCount: 10,
        dropCount: 1,
      }).isAbsentStable
    ).toBe(false);

    // 24h with only 2 scans -> NOT absent stable
    expect(
      evaluateAbsentStable({
        id: 'gpt-4o-legacy',
        prefix: 'openai',
        absenceCount: 2,
        firstAbsentAtMs: t0,
        nowMs: t0 + 86_400_000,
        lastLabel: 'OK',
        l2ExternalExists: false,
        providerCoveredByExternal: false,
        comboStepCount: 10,
        dropCount: 1,
      }).isAbsentStable
    ).toBe(false);

    // Exact 24h with 3 valid scans and 1/10 <= 10% -> absent stable
    expect(
      evaluateAbsentStable({
        id: 'gpt-4o-legacy',
        prefix: 'openai',
        absenceCount: 3,
        firstAbsentAtMs: t0,
        nowMs: t0 + 86_400_000,
        lastLabel: 'OK',
        l2ExternalExists: false,
        providerCoveredByExternal: false,
        comboStepCount: 10,
        dropCount: 1,
      }).isAbsentStable
    ).toBe(true);
  });

  it('records one model_pending detection per absence episode with distinct injectable clock timestamps and rejects legacy ambiguous absence measurements', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h1-episode-');
    let activeModels = LIVE_NINE_MODELS;
    let clockMs = fx.baseMs;
    const clock = () => clockMs;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += 135; // deterministic scan duration before model_pending commit
        return Response.json({ data: activeModels.map((m) => ({ id: m.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) {
        return new Response(null, { status: 404 });
      }
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);

    // Future-dated official evidence must leave the model on the normal absence path.
    appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Future notice fixture.',
      publishedAt: new Date(fx.baseMs + 60 * 60_000).toISOString(),
      submittedAt: new Date(fx.baseMs + 61 * 60_000).toISOString(),
      submittedVia: 'cli',
    });
    // Tick 1 (Day 0, +20m after observe): first qualifying auto-safe scan commits model_pending
    clockMs = fx.baseMs + 20 * 60_000;
    const t1Summary = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(t1Summary.detectionLatency).toEqual({
      measuredCount: 1,
      minMs: 135,
      maxMs: 135,
      p50Ms: 135,
    });

    expect(fx.readComboRowModels()).toHaveLength(10);
    const catAfterT1 = JSON.parse(
      fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')
    ) as TickCatalogState;
    const pendingList = catAfterT1.absenceDetections ?? [];
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      status: 'model_pending',
      detectionMs: 135,
    });
    expect(pendingList[0]!.scanStartedAt).not.toBe(pendingList[0]!.modelPendingAt);
    expect(
      Date.parse(pendingList[0]!.modelPendingAt) - Date.parse(pendingList[0]!.scanStartedAt)
    ).toBe(135);

    // Tick 2 (+40m): same absence episode MUST NOT emit a second detection
    clockMs = fx.baseMs + 40 * 60_000;
    const t2Summary = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(t2Summary.detectionLatency?.measuredCount).toBe(0);
    expect(t2Summary.detectionLatency?.maxMs).toBeNull();

    const catAfterT2 = JSON.parse(
      fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')
    ) as TickCatalogState;
    expect(catAfterT2.absenceDetections).toHaveLength(1);
    expect(catAfterT2.officialNoticeDetections ?? []).toHaveLength(0);

    // Before Day 1 removal: model_pending exists without actual removal -> pilot-report is INCOMPLETE
    await runFreezeUnfreezeAndRollback(fx, snapId);
    process.exitCode = 0;
    const unsettledReport = await runPilotReportCommand({
      stateDir: fx.stateDir,
      nowMs: clockMs + 60_000,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      falseRemovals: 0,
      unplannedInterventions: 0,
      silent: true,
      json: true,
    });
    expect(unsettledReport.status).toBe('INCOMPLETE');
    expect(process.exitCode).toBe(1);
    expect(unsettledReport.removalSettle.status).toBe('INCOMPLETE');
    expect(unsettledReport.removalSettle.removedModelCount).toBe(0);
    expect(unsettledReport.removalSettle.providerToFirstScanMs).toBeNull();
    expect(unsettledReport.removalSettle.unobservableWindow).toBe('provider-to-first-scan');
    expect(unsettledReport.removalSettle.observedScanIntervalMs.sampleCount).toBeGreaterThanOrEqual(2);
    expect(unsettledReport.removalSettle.observedScanIntervalMs.lastMs).toBeGreaterThan(0);

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const expectCatalogFailure = async (detection: (typeof pendingList)[number]) => {
      fs.writeFileSync(catalogPath, JSON.stringify({ ...catAfterT2, absenceDetections: [detection] }));
      const invalidReport = await runPilotReportCommand({
        stateDir: fx.stateDir, routerTarget: 'router:nine/rs-pilot',
        nowMs: clockMs + 60_000, silent: true, json: true,
      });
      expect(invalidReport.status).toBe('FAIL');
      expect(invalidReport.blockingReasons.join('\n')).toContain('TICK_CATALOG_CORRUPT');
    };
    await expectCatalogFailure({ ...pendingList[0]!, detectionMs: 1 });
    await expectCatalogFailure({ ...pendingList[0]!, episodeId: 'unrelated' });
    await expectCatalogFailure({
      ...pendingList[0]!,
      modelPendingAt: new Date(clockMs + 60_001).toISOString(),
      detectionMs: clockMs + 60_001 - Date.parse(pendingList[0]!.scanStartedAt),
    });

    // Also verify legacy ambiguous ABSENT_STABLE detectionLatencyMs (without model_pending episode) is rejected as proof
    const legacyStateDir = path.join(makeTmpDir('rs-c48-legacy-ambig-'), 'state');
    fs.mkdirSync(path.join(legacyStateDir, 'plans'), { recursive: true });
    upsertStandingConsentTarget(legacyStateDir, {
      target: 'router:nine/rs-pilot',
      level: 'propose',
      nowMs: fx.baseMs,
    });
    upsertStandingConsentTarget(legacyStateDir, {
      target: 'harness:hermes',
      level: 'propose',
      nowMs: fx.baseMs,
    });
    const rRec = appendApplyReceipt(legacyStateDir, {
      target: 'router:nine/rs-pilot',
      appliedAtLevel: 'auto-safe',
      authorizedVia: 'standing-consent',
      planHash: 'a'.repeat(64),
      appliedAt: new Date(fx.baseMs + 86_405_000).toISOString(),
      preDigest: '1'.repeat(64),
      postDigest: '2'.repeat(64),
      snapshotOrBackupRef: 'snap_legacy',
      success: true,
      readBackVerified: true,
      readBackLevel: 'full',
      rolledBack: false,
      removedModels: [
        {
          provider: 'openai',
          modelId: 'gpt-4o-legacy',
          inProviderCatalog: false,
          removalPath: 'absence-only',
          firstObservedAbsentAt: new Date(fx.baseMs).toISOString(),
          removedAt: new Date(fx.baseMs + 86_405_000).toISOString(),
          removalSettleMs: 86_405_000,
          qualifyingScanCount: 3,
        },
      ],
    });
    const hRec = appendApplyReceipt(legacyStateDir, {
      target: 'harness:hermes',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      planHash: 'b'.repeat(64),
      appliedAt: new Date(fx.baseMs + 2000).toISOString(),
      preDigest: '3'.repeat(64),
      postDigest: '4'.repeat(64),
      snapshotOrBackupRef: 'hermes.bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'full',
      rolledBack: false,
    });
    for (const rec of [rRec, hRec]) {
      markApplyReceiptRolledBack(legacyStateDir, {
        target: rec.target,
        verifyRollback: () => ({ beforeDigest: rec.preDigest!, afterDigest: rec.preDigest! }),
      });
    }
    // Write legacy ambiguous ABSENT_STABLE action (no detectionKind='absence-settled' and no tick-catalog absenceDetections)
    fs.writeFileSync(
      path.join(legacyStateDir, 'status.json'),
      JSON.stringify({
        timestamp: new Date(fx.baseMs + 86_405_000).toISOString(),
        providers: [],
        tokens: 0,
        llmCalls: 0,
        paidRequests: 0,
        detectionLatency: { measuredCount: 1, minMs: 500, maxMs: 500, p50Ms: 500 },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyStateDir, 'plans', 'tick-plan.json'),
      JSON.stringify({
        planCreatedAt: new Date(fx.baseMs + 86_405_000).toISOString(),
        routerActions: [
          {
            targetType: 'router',
            router: 'nine',
            comboName: 'rs-pilot',
            provider: 'openai',
            modelId: 'gpt-4o-legacy',
            fullStep: 'openai/gpt-4o-legacy',
            action: 'REMOVE_MODEL',
            reason: 'ABSENT_STABLE (absenceCount=3)',
            sourcePublishedAt: null,
            sourceFirstChangedAt: new Date(fx.baseMs + 86_404_500).toISOString(),
            planCreatedAt: new Date(fx.baseMs + 86_405_000).toISOString(),
            detectionLatencyMs: 500,
          },
        ],
        harnessActions: [],
        detectionLatency: { measuredCount: 1, minMs: 500, maxMs: 500, p50Ms: 500 },
        accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyStateDir, 'cost-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date(fx.baseMs + 86_405_000).toISOString(),
        ticks: [],
        researchSessions: [],
      }),
      'utf8'
    );

    process.exitCode = 0;
    const legacyRep = await runPilotReportCommand({
      stateDir: legacyStateDir,
      nowMs: fx.baseMs + 86_500_000,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      silent: true,
      json: true,
    });
    expect(legacyRep.status).toBe('INCOMPLETE');
    expect(process.exitCode).toBe(1);
    expect(legacyRep.criteria.detectionLatencyMs.passed).toBe(false);

    const otherModel = 'unrelated-model';
    const originalEpisode = pendingList[0]!;
    fs.writeFileSync(path.join(legacyStateDir, 'tick-catalog.json'), JSON.stringify({
      absenceDetections: [{
        ...originalEpisode,
        modelId: otherModel,
        fullStep: `openai/${otherModel}`,
        episodeId: `ep-openai-${otherModel}-${Date.parse(originalEpisode.scanStartedAt)}`,
      }],
    }));
    const mixedReport = await runPilotReportCommand({
      stateDir: legacyStateDir,
      nowMs: fx.baseMs + 86_500_000,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      silent: true,
      json: true,
    });
    expect(mixedReport.criteria.detectionLatencyMs).toMatchObject({
      measuredCount: 1, maxMs: 135, source: 'tick-catalog.json',
    });
  });

  it('keeps missing settle policy proof INCOMPLETE while failing premature (<24h or <3 scans) removals', async () => {
    const baseMs = Date.parse('2026-11-26T08:00:00.000Z');
    const buildSeededDir = (removedModel: Record<string, unknown>) => {
      const stateDir = path.join(makeTmpDir('rs-c48-settle-proof-'), 'state');
      fs.mkdirSync(path.join(stateDir, 'plans'), { recursive: true });
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/rs-pilot',
        level: 'propose',
        nowMs: baseMs,
      });
      upsertStandingConsentTarget(stateDir, {
        target: 'harness:hermes',
        level: 'propose',
        nowMs: baseMs,
      });
      const rRec = appendApplyReceipt(stateDir, {
        target: 'router:nine/rs-pilot',
        appliedAtLevel: 'auto-safe',
        authorizedVia: 'standing-consent',
        planHash: 'c'.repeat(64),
        appliedAt: typeof removedModel['removedAt'] === 'string'
          ? removedModel['removedAt'] : new Date(baseMs + 86_400_000).toISOString(),
        preDigest: '1'.repeat(64),
        postDigest: '2'.repeat(64),
        snapshotOrBackupRef: 'snap_settle',
        success: true,
        readBackVerified: true,
        readBackLevel: 'full',
        rolledBack: false,
        removedModels: [removedModel as never],
      });
      const hRec = appendApplyReceipt(stateDir, {
        target: 'harness:hermes',
        appliedAtLevel: 'propose',
        authorizedVia: 'interactive-tty',
        planHash: 'd'.repeat(64),
        appliedAt: new Date(baseMs + 1000).toISOString(),
        preDigest: '3'.repeat(64),
        postDigest: '4'.repeat(64),
        snapshotOrBackupRef: 'hermes.bak',
        success: true,
        readBackVerified: true,
        readBackLevel: 'full',
        rolledBack: false,
      });
      for (const rec of [rRec, hRec]) {
        markApplyReceiptRolledBack(stateDir, {
          target: rec.target,
          verifyRollback: () => ({ beforeDigest: rec.preDigest!, afterDigest: rec.preDigest! }),
        });
      }
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({
          timestamp: new Date(baseMs + 86_400_000).toISOString(),
          providers: [],
          tokens: 0,
          llmCalls: 0,
          paidRequests: 0,
          detectionLatency: { measuredCount: 1, minMs: 40, maxMs: 40, p50Ms: 40 },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: new Date(baseMs + 86_400_000).toISOString(),
          routerActions: [],
          harnessActions: [],
          detectionLatency: { measuredCount: 1, minMs: 40, maxMs: 40, p50Ms: 40 },
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: new Date(baseMs + 86_400_000).toISOString(),
          ticks: [],
          researchSessions: [],
        }),
        'utf8'
      );
      return stateDir;
    };

    // 1) Missing policy proof (no removalPath / timestamps) -> INCOMPLETE
    {
      const stateDir = buildSeededDir({
        provider: 'openai',
        modelId: 'gpt-4o-legacy',
        inProviderCatalog: false,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: baseMs + 86_460_000,
        routerTarget: 'router:nine/rs-pilot',
        harnessTarget: 'harness:hermes',
        unplannedInterventions: 0,
        silent: true,
        json: true,
      });
      expect(rep.status).toBe('INCOMPLETE');
      expect(rep.removalSettle.status).toBe('INCOMPLETE');
      expect(process.exitCode).toBe(1);
    }

    // 2) Premature by 1ms (86_399_999 ms < 86_400_000 ms 24h floor) -> FAIL (kills 24h floor mutation!)
    {
      const stateDir = buildSeededDir({
        provider: 'openai',
        modelId: 'gpt-4o-legacy',
        inProviderCatalog: false,
        removalPath: 'absence-only',
        firstObservedAbsentAt: new Date(baseMs).toISOString(),
        removedAt: new Date(baseMs + 86_400_000 - 1).toISOString(),
        removalSettleMs: 86_400_000 - 1,
        qualifyingScanCount: 3,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: baseMs + 86_460_000,
        routerTarget: 'router:nine/rs-pilot',
        harnessTarget: 'harness:hermes',
        unplannedInterventions: 0,
        silent: true,
        json: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.removalSettle.status).toBe('FAIL');
      expect(rep.removalSettle.policySatisfiedAtRemoval).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    expect(() => buildSeededDir({
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      inProviderCatalog: false,
      removalPath: 'absence-only',
      firstObservedAbsentAt: new Date(baseMs).toISOString(),
      removedAt: new Date(baseMs + 86_400_000).toISOString(),
      removalSettleMs: 86_400_001,
      qualifyingScanCount: 3,
    })).toThrow('Removal settlement evidence has invalid timestamps, duration, or scan count.');

    for (const officialPublishedAt of ['2026-02-30', '2026-11-28T08:00:00.000Z']) {
      expect(() => buildSeededDir({
        provider: 'openai', modelId: 'gpt-4o-legacy', inProviderCatalog: false,
        removalPath: 'official-notice', firstObservedAbsentAt: new Date(baseMs).toISOString(),
        removedAt: new Date(baseMs + 86_400_000).toISOString(),
        removalSettleMs: 86_400_000, qualifyingScanCount: 1,
        officialDomainVerified: true, officialPublishedAt, syntheticNotice: false,
      })).toThrow('Removal settlement evidence has invalid timestamps, duration, or scan count.');
    }

    // 3) Premature scan count (qualifyingScanCount = 2 < 3 at >= 24h) -> FAIL
    {
      const stateDir = buildSeededDir({
        provider: 'openai',
        modelId: 'gpt-4o-legacy',
        inProviderCatalog: false,
        removalPath: 'absence-only',
        firstObservedAbsentAt: new Date(baseMs).toISOString(),
        removedAt: new Date(baseMs + 86_400_000).toISOString(),
        removalSettleMs: 86_400_000,
        qualifyingScanCount: 2,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: baseMs + 86_460_000,
        routerTarget: 'router:nine/rs-pilot',
        harnessTarget: 'harness:hermes',
        unplannedInterventions: 0,
        silent: true,
        json: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.removalSettle.status).toBe('FAIL');
      expect(rep.removalSettle.policySatisfiedAtRemoval).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // Exercise the read-time check against a signed historical receipt.
    const settledState = buildSeededDir({
      provider: 'openai', modelId: 'gpt-4o-legacy', inProviderCatalog: false,
      removalPath: 'absence-only', firstObservedAbsentAt: new Date(baseMs).toISOString(),
      removedAt: new Date(baseMs + 86_400_000).toISOString(),
      removalSettleMs: 86_400_000, qualifyingScanCount: 3,
    });
    const historyPath = path.join(settledState, 'apply-history.json');
    const { version, updatedAt, receipts } = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as {
      version: number; updatedAt: string; receipts: ReturnType<typeof readApplyHistory>['receipts'];
    };
    receipts[0]!.removedModels![0]!.removalSettleMs = 86_400_001;
    const payload = { version, updatedAt, receipts };
    const key = readConsentSigningKeyIfPresent(settledState)!;
    const hmacSha256 = computeHmacSha256Hex(key, canonicalJsonStringify(payload));
    fs.writeFileSync(historyPath, JSON.stringify({ ...payload, hmacSha256 }));
    expect(readApplyHistory(settledState).valid).toBe(true);
    const mismatchedReport = await runPilotReportCommand({
      stateDir: settledState, nowMs: baseMs + 86_460_000, silent: true, json: true,
    });
    expect(mismatchedReport.removalSettle).toMatchObject({
      status: 'FAIL', policySatisfiedAtRemoval: false, removalSettleMs: null,
    });
  });
});

it('QA_D: rejects a clock regression before writing a router removal', async () => {
  const fx = createIsolatedTenModelPilotFixture('rs-c48-qa-d-');
  let activeModels = INITIAL_TEN_MODELS;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({ data: activeModels.map((model) => ({ id: model.split('/')[1]! })) });
    }
    if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
    return Response.json({ data: [] });
  };
  await prepareDay0PilotToAutoSafe(fx, mockFetch);
  activeModels = LIVE_NINE_MODELS;
  const firstAbsentAt = fx.baseMs + 20 * 60_000;
  const tickOptions = {
    configPath: fx.configPath,
    stateDir: fx.stateDir,
    mode: 'auto-safe',
    fetchFn: mockFetch,
    harnessTargets: [],
    json: true,
  };
  for (const scanAt of [firstAbsentAt, firstAbsentAt + 15 * 60_000]) {
    await runTickCommand({ ...tickOptions, clock: () => scanAt });
  }
  const planPath = path.join(fx.stateDir, 'plans', 'tick-plan.json');
  const receiptPath = path.join(fx.stateDir, 'apply-history.json');
  const modelsBefore = fx.readComboRowModels();
  expect(modelsBefore).toHaveLength(10);
  const routerShaBefore = sha256File(fx.routerDbPath);
  const harnessShaBefore = sha256File(fx.hermesConfigPath);
  const receiptShaBefore = sha256File(receiptPath);
  const planMs = firstAbsentAt + 48 * 60 * 60_000;
  const planIso = new Date(planMs).toISOString();
  const clock = vi.fn(() =>
    fs.readFileSync(planPath, 'utf8').includes(planIso) ? firstAbsentAt - 1 : planMs
  );

  const outcome = await runTickCommand({ ...tickOptions, clock }).then(
    () => ({ rejected: false }), () => ({ rejected: true })
  );
  const planned = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  expect(planned.routerActions).toContainEqual(expect.objectContaining({
    action: 'REMOVE_MODEL', fullStep: 'openai/gpt-4o-legacy',
  }));
  expect(clock.mock.results.some((result) => result.value === firstAbsentAt - 1)).toBe(true);
  expect(fx.readComboRowModels()).toEqual(modelsBefore);
  expect(sha256File(fx.routerDbPath)).toBe(routerShaBefore);
  expect(sha256File(fx.hermesConfigPath)).toBe(harnessShaBefore);
  expect(sha256File(receiptPath)).toBe(receiptShaBefore);
  expect(outcome.rejected).toBe(false);
  const inbox = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'inbox.json'), 'utf8'));
  expect(JSON.stringify(inbox)).toContain('REMOVAL_EVIDENCE_INVALID');
  console.log('QA_D', JSON.stringify({
    routerBytesUnchanged: true, harnessBytesUnchanged: true, applyHistoryBytesUnchanged: true,
  }));
}, 60_000);

it.each(['adapter exception', 'unmatched removal'] as const)(
  'QA_D harness: %s cannot claim a successful rollback', async (failure) => {
  const fx = createIsolatedTenModelPilotFixture('rs-c48-qa-d-harness-');
  let activeModels = INITIAL_TEN_MODELS;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({ data: activeModels.map((model) => ({ id: model.split('/')[1]! })) });
    }
    if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
    return Response.json({ data: [] });
  };
  await prepareDay0PilotToAutoSafe(fx, mockFetch);
  const firstAbsentAt = fx.baseMs + 20 * 60_000;
  upsertStandingConsentTarget(fx.stateDir, {
    target: 'router:nine/rs-pilot', level: 'propose', nowMs: firstAbsentAt,
  });
  const harnessModels = INITIAL_TEN_MODELS.map((model) => model.split('/')[1]!);
  fs.writeFileSync(fx.hermesConfigPath, [
    'model:',
    '  provider: openai',
    '  default: openai/gpt-4.1',
    'providers:',
    '  openai:',
    '    base_url: https://api.openai.com/v1',
    '    api_key_env: OPENAI_API_KEY',
    '    models:',
    ...harnessModels.map((model) => `      - ${model}`),
    '',
  ].join('\n'));
  const adapter = HARNESS_WRITE_ADAPTERS.find((candidate) => candidate.app === 'hermes')!;
  const apply = vi.spyOn(adapter, 'apply');
  if (failure === 'adapter exception') {
    apply.mockRejectedValueOnce(new Error('Fixture apply aborted before write'));
  } else {
    const plan = adapter.plan.bind(adapter);
    vi.spyOn(adapter, 'plan').mockImplementationOnce(async (options) => {
      const actual = await plan(options);
      expect(actual.removals).toHaveLength(1);
      return { ...actual, removals: [{ ...actual.removals[0]!, model: 'unmatched-fixture-model' }] };
    });
  }
  activeModels = LIVE_NINE_MODELS;
  const harnessShaBefore = sha256File(fx.hermesConfigPath);
  const routerShaBefore = sha256File(fx.routerDbPath);
  for (const scanAt of [firstAbsentAt, firstAbsentAt + 15 * 60_000, firstAbsentAt + 48 * 60 * 60_000]) {
    await runTickCommand({
      configPath: fx.configPath, stateDir: fx.stateDir, mode: 'auto-safe',
      clock: () => scanAt, fetchFn: mockFetch, json: true,
      harnessTargets: [{
        harnessId: 'hermes', configPath: fx.hermesConfigPath,
        defaultModels: ['openai/gpt-4.1'],
        providers: [{ providerId: 'openai', models: harnessModels, keyPresent: true }],
      }],
    });
  }
  expect(apply).toHaveBeenCalledTimes(failure === 'adapter exception' ? 1 : 0);
  const receipts = readApplyHistory(fx.stateDir).receipts.filter(
    (receipt) => receipt.target === 'harness:hermes' && receipt.appliedAtLevel === 'auto-safe'
  );
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ success: false, readBackVerified: false, rolledBack: false });
  expect(sha256File(fx.hermesConfigPath)).toBe(harnessShaBefore);
  expect(sha256File(fx.routerDbPath)).toBe(routerShaBefore);
  console.log('QA_D_HARNESS', JSON.stringify({ failure, applyCalls: apply.mock.calls.length, harnessBytesUnchanged: true, rolledBack: receipts[0]?.rolledBack }));
}, 60_000);

describe('CTO official-notice clock', () => {
  it.each([
    { name: '30-day publication lead', elapsed: 90, lead: 30 * 86_400_000 },
    { name: 'ledger submitted 15 minutes before scan', elapsed: 90, lead: 86_400_000 },
    { name: 'future-effective notice', elapsed: 90, lead: 86_400_000 },
    { name: 'QA_S2_A L3 without publication', elapsed: 90, lead: 86_400_000 },
    { name: 'slow scan above 60000ms', elapsed: 65_000, lead: 86_400_000 },
    { name: 'missed first plan and repeated ticks (QA_S2_B)', elapsed: 90, lead: 86_400_000 },
    { name: 'QA_S3_B actionable supersession', elapsed: 90, lead: 86_400_000 },
    { name: 'QA_S3_C withdrawal then reassertion', elapsed: 90, lead: 86_400_000 },
    { name: 'QA_S3 verified future-effective gap', elapsed: 90, lead: 86_400_000 },
  ])('$name', async ({ name, elapsed, lead }) => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-cto-clock-');
    const withoutPublication = name.includes('QA_S2_A');
    const l3Url = 'https://platform.openai.com/docs/deprecations';
    const effectiveDate = '2026-11-01';
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((model) => ({ id: model.split('/')[1]! })) });
      }
      if (withoutPublication && url.includes('platform.openai.com/docs/deprecations')) {
        return new Response(`<h2>gpt-4o-legacy shut down ${effectiveDate}</h2>`);
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };
    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);
    activeModels = LIVE_NINE_MODELS;
    const firstScan = fx.baseMs + 40 * 60_000;
    const regularInterval = 20 * 60_000;
    const futureEffective = name === 'future-effective notice';
    const supersede = name.includes('QA_S3_B');
    const reassert = name.includes('QA_S3_C');
    const futureGap = name.includes('verified future-effective gap');
    const restartsAfterGap = reassert || futureGap;
    const repeat = name.includes('QA_S2_B') || supersede || restartsAfterGap;
    const effectiveAt = futureEffective || withoutPublication ? firstScan + regularInterval : firstScan;
    let publishedAt = firstScan - lead;
    const retiredModel = 'gpt-4o-legacy';
    const submitNotice = (modelId: string, verdict: 'active' | 'deprecated', submittedAt: number,
      shutdownAt?: number) => appendResearchEvidence(fx.stateDir, {
      provider: 'openai', modelId, verdict,
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'A genuine provider notice fixture; the word synthetic alone does not set provenance.',
      ...(withoutPublication ? {} : { publishedAt: new Date(publishedAt).toISOString() }),
      submittedAt: new Date(submittedAt).toISOString(),
      ...(shutdownAt === undefined ? {} : { shutdownDate: new Date(shutdownAt).toISOString() }),
      submittedVia: 'cli',
    });
    let evidence = withoutPublication ? null : submitNotice(retiredModel, 'deprecated', firstScan - 15 * 60_000,
      futureEffective ? effectiveAt : undefined);
    const catalogFile = path.join(fx.stateDir, 'tick-catalog.json');
    const planFile = path.join(fx.stateDir, 'plans', 'tick-plan.json');
    const readNotice = () => (JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState)
      .officialNoticeDetections?.find((record) => record.modelId === retiredModel && !record.withdrawnAt && !record.supersededAt);
    const readPlan = () => JSON.parse(fs.readFileSync(planFile, 'utf8')) as TickPlanFile;
    const tick = (at: number, mode: 'auto-safe' | 'propose' = 'auto-safe') => {
      clockMs = at;
      return runTickCommand({
        configPath: fx.configPath, stateDir: fx.stateDir, mode,
        clock: () => clockMs, fetchFn: mockFetch, harnessTargets: [], json: true,
      });
    };

    if (futureEffective || withoutPublication) {
      await tick(firstScan);
      expect(readNotice()).toBeUndefined();
      expect(readPlan().routerActions.filter((action) => action.action === 'REMOVE_MODEL')).toEqual([]);
      expect(fx.readComboRowModels()).toHaveLength(10);
    }
    if (repeat) {
      // Two eligible removals would exceed the target cap, so the first scan cannot produce a plan.
      submitNotice('gpt-4.1-mini', 'deprecated', firstScan - 15 * 60_000);
      await tick(firstScan, 'propose');
      expect(readNotice()).toMatchObject({
        firstQualifyingScanStartedAt: new Date(firstScan).toISOString(),
        firstPlanCreatedAt: null, detectionMs: null,
      });
      expect(readPlan().routerActions.filter((action) => action.action === 'REMOVE_MODEL')).toEqual([]);
      submitNotice('gpt-4.1-mini', 'active', firstScan + 1_000);
      if (restartsAfterGap) {
        const transitionAt = firstScan + 1_000;
        let replacement: ReturnType<typeof submitNotice> | null = null;
        if (futureGap) {
          replacement = submitNotice(retiredModel, 'deprecated', transitionAt, firstScan + 2 * regularInterval);
        } else {
          submitNotice(retiredModel, 'active', transitionAt);
        }
        await tick(firstScan + regularInterval, 'propose');
        expect(readNotice()).toBeUndefined();
        expect(readPlan().routerActions.filter((action) => action.action === 'REMOVE_MODEL')).toEqual([]);
        const assertions = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState;
        expect(assertions.officialNoticeDetections?.find((record) => record.modelId === retiredModel))
          .toMatchObject({
            [futureGap ? 'supersededAt' : 'withdrawnAt']: new Date(transitionAt).toISOString(),
            firstPlanCreatedAt: null,
          });
        const resubmitted = replacement ??
          submitNotice(retiredModel, 'deprecated', firstScan + regularInterval + 1_000);
        if (futureGap) {
          expect(researchEvidenceIdentity(resubmitted)).not.toBe(researchEvidenceIdentity(evidence!));
        } else {
          expect(researchEvidenceIdentity(resubmitted)).toBe(researchEvidenceIdentity(evidence!));
        }
        evidence = resubmitted;
      } else {
        if (supersede) publishedAt = firstScan + 1_500;
        const resubmitted = submitNotice(retiredModel, 'deprecated', firstScan + 2_000);
        expect(resubmitted.recordId).not.toBe(evidence?.recordId);
        if (supersede) {
          expect(researchEvidenceIdentity(resubmitted)).not.toBe(researchEvidenceIdentity(evidence!));
        } else {
          expect(researchEvidenceIdentity(resubmitted)).toBe(researchEvidenceIdentity(evidence!));
        }
        evidence = resubmitted;
      }
    }

    const qualifyingAt = restartsAfterGap ? firstScan + 2 * regularInterval : effectiveAt;
    const planAt = (repeat && !restartsAfterGap ? firstScan + regularInterval : qualifyingAt) + elapsed;
    const firstPlanTick = await tick(planAt - elapsed, repeat && !restartsAfterGap ? 'propose' : 'auto-safe');
    const expectedDetection = planAt - qualifyingAt;
    const expectedPublicationDelay = withoutPublication ? null : planAt - publishedAt;
    const expectedRecord = {
      evidenceId: evidence ? researchEvidenceIdentity(evidence) : JSON.stringify([l3Url, effectiveDate]),
      sourcePublishedAt: withoutPublication ? null : new Date(publishedAt).toISOString(),
      firstQualifyingScanStartedAt: new Date(qualifyingAt).toISOString(),
      firstPlanCreatedAt: new Date(planAt).toISOString(),
      publicationToPlanMs: expectedPublicationDelay,
    };
    expect(readNotice()).toMatchObject({ ...expectedRecord, detectionMs: expectedDetection, synthetic: false });
    expect(readPlan().routerActions.find((action) => action.action === 'REMOVE_MODEL')).toMatchObject({
      ...expectedRecord, detectionLatencyMs: expectedDetection,
    });
    expect(firstPlanTick.detectionLatency?.maxMs).toBe(expectedDetection);
    expect(expectedDetection).toBeGreaterThan(0);

    if (supersede) {
      const history = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState;
      const matching = history.officialNoticeDetections?.filter((record) => record.modelId === retiredModel) ?? [];
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        evidenceId: researchEvidenceIdentity(evidence!),
        firstQualifyingScanStartedAt: new Date(firstScan).toISOString(),
        firstPlanCreatedAt: new Date(planAt).toISOString(),
      });
      expect(matching[0]?.supersededAt).toBeUndefined();
    }
    if (repeat && !restartsAfterGap) {
      const withdrawn = (JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState)
        .officialNoticeDetections?.find((record) => record.modelId === 'gpt-4.1-mini');
      expect(withdrawn).toMatchObject({
        firstPlanCreatedAt: null, withdrawnAt: new Date(firstScan + 1_000).toISOString(),
      });
      const nextTick = await tick(firstScan + 2 * regularInterval);
      expect(nextTick.detectionLatency?.measuredCount).toBe(0);
      expect(readNotice()).toMatchObject({ ...expectedRecord, detectionMs: expectedDetection });
      const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState;
      expect(catalog.officialNoticeDetections?.filter((record) => record.evidenceId === researchEvidenceIdentity(evidence!))).toHaveLength(1);
    }
    expect(fx.readComboRowModels()).toHaveLength(9);
    if (withoutPublication) {
      const history = readApplyHistory(fx.stateDir);
      expect(history.valid).toBe(true);
      expect(history.receipts.flatMap((receipt) => receipt.removedModels ?? [])).toContainEqual(
        expect.objectContaining({
          modelId: retiredModel, removalPath: 'official-notice', officialPublishedAt: null,
          officialShutdownDate: effectiveDate, officialDomainVerified: true, syntheticNotice: false,
        })
      );
    }
    await runFreezeUnfreezeAndRollback(fx, snapId);
    const reportOptions = {
      stateDir: fx.stateDir, config: fx.configPath, routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes', unplannedInterventions: 0,
      nowMs: clockMs + 60_000, silent: true, json: true,
    };
    const report = await runPilotReportCommand(reportOptions);
    expect(report.criteria.detectionLatencyMs).toMatchObject({
      maxMs: expectedDetection, publicationToPlanMs: expectedPublicationDelay,
      passed: expectedDetection <= 60_000,
    });
    expect(report.status, report.blockingReasons.join('\n')).toBe(
      expectedDetection <= 60_000 ? 'PASS' : 'FAIL'
    );
    if (withoutPublication) {
      expect(report.blockingReasons.join('\n')).not.toContain('S9_OFFICIAL_DETECTION_INCOMPLETE');
    }
    if (repeat && !restartsAfterGap) {
      expect(report.blockingReasons.join('\n')).toContain('S9_CRITERION_3_FAILED');
      expect(report.blockingReasons.join('\n')).not.toContain('S9_OFFICIAL_DETECTION_INCOMPLETE');
    }
    if (name === '30-day publication lead') {
      expect(report.criteria.detectionLatencyMs.publicationToPlanMs).toBe(2_592_000_090);
      const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
      const notice = readNotice()!;
      fs.writeFileSync(catalogFile, JSON.stringify({ ...catalog, officialNoticeDetections: [{
        ...notice, firstQualifyingScanStartedAt: undefined, firstPlanCreatedAt: undefined,
        planCreatedAt: notice.firstPlanCreatedAt, detectionMs: expectedPublicationDelay!,
      }] }));
      const legacy = await runPilotReportCommand(reportOptions);
      expect(legacy.status).toBe('INCOMPLETE');
      expect(legacy.criteria.detectionLatencyMs).toMatchObject({ maxMs: null, publicationToPlanMs: null });
      fs.writeFileSync(catalogFile, JSON.stringify({ ...catalog, officialNoticeDetections: [{
        ...notice, firstPlanCreatedAt: new Date(firstScan - 1).toISOString(),
      }] }));
      const reversed = await runPilotReportCommand(reportOptions);
      expect(reversed.status).toBe('FAIL');
      expect(reversed.blockingReasons.join('\n')).toContain('Invalid official notice detection chronology');

      const sharedLegacyKey = `ep-fixture-provider-model-${firstScan}`;
      const absenceDetections = [['fixture-provider', 'model'], ['fixture', 'provider-model']]
        .map(([provider, modelId]) => ({
          episodeId: sharedLegacyKey, provider, modelId, fullStep: `${provider}/${modelId}`,
          status: 'model_pending', scanStartedAt: new Date(firstScan).toISOString(),
          modelPendingAt: new Date(firstScan + 1).toISOString(), detectionMs: 1,
          targetsAffected: ['router:nine/rs-pilot'],
        }));
      fs.writeFileSync(catalogFile, JSON.stringify({
        ...catalog, absenceDetections,
        providers: { openai: {
          activeTargets: ['router:nine/rs-pilot'],
          qualifyingScanTimestamps: [
            new Date(firstScan - 900_000).toISOString(),
            new Date(firstScan).toISOString(),
          ],
        } },
      }));
      const collisionAndCadence = await runPilotReportCommand(reportOptions);
      expect(collisionAndCadence.status).toBe('PASS');
      expect(collisionAndCadence.criteria.detectionLatencyMs.measuredCount).toBe(3);
      expect(collisionAndCadence.removalSettle.observedScanIntervalMs).toMatchObject({
        sampleCount: 1, maxMs: 900_000,
      });
    }
  }, 60_000);
});

describe('C48 detection retention', () => {
  const day = 86_400_000;
  const historicalEpisode = (index: number, start: number) => ({
    episodeId: `ep-${JSON.stringify(['retention-fixture', `model-${index}`, start])}`,
    provider: 'retention-fixture', modelId: `model-${index}`, fullStep: `retention-fixture/model-${index}`,
    status: 'model_pending' as const, scanStartedAt: new Date(start).toISOString(),
    modelPendingAt: new Date(start + 75_000).toISOString(), detectionMs: 75_000,
    targetsAffected: ['router:nine/rs-pilot'],
  });

  it('filters 400-day catalog, status and plan evidence and isolates two explicit pilots', async () => {
    const stateDir = makeTmpDir('rs-c48-retention-report-');
    fs.mkdirSync(path.join(stateDir, 'plans'));
    const now = Date.parse('2026-11-26T10:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const catalogPath = path.join(stateDir, 'tick-catalog.json');
    const writeSummary = (timestamp: number, latency: number) => {
      const sample = { measuredCount: 1, minMs: latency, maxMs: latency, p50Ms: latency };
      fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify({ timestamp: iso(timestamp), detectionLatency: sample }));
      fs.writeFileSync(path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({ planCreatedAt: iso(timestamp), detectionLatency: sample }));
    };
    const runReport = (pilotStartedAt?: string) => runPilotReportCommand({
      stateDir, nowMs: now, silent: true, pilotStartedAt,
    });
    const stale = { ...historicalEpisode(0, now - 400 * day), recoveredAt: iso(now - 399 * day) };
    fs.writeFileSync(catalogPath, JSON.stringify({ absenceDetections: [stale] }));
    writeSummary(now - 400 * day, 85_000);
    const oldOnly = await runReport();
    expect(oldOnly.criteria.detectionLatencyMs).toMatchObject({ measuredCount: 0, maxMs: null });

    const first = { ...historicalEpisode(1, now - 2 * day - 80_000), recoveredAt: iso(now - 2 * day) };
    const second = {
      ...historicalEpisode(2, now - 300_000),
      modelPendingAt: iso(now - 300_000 + 90), detectionMs: 90,
    };
    fs.writeFileSync(catalogPath, JSON.stringify({ absenceDetections: [stale, first, second] }));
    writeSummary(now - 2 * day, 85_000);
    expect((await runReport(iso(now - 2 * day - 90_000))).criteria.detectionLatencyMs)
      .toMatchObject({ measuredCount: 2, maxMs: 85_000 });
    expect((await runReport(iso(now - day))).criteria.detectionLatencyMs)
      .toMatchObject({ measuredCount: 1, maxMs: 90, passed: true });
    expect((await runReport(iso(now - 410 * day))).criteria.detectionLatencyMs)
      .toMatchObject({ measuredCount: 2, maxMs: 85_000 });
    await expect(runReport(iso(now + 1))).rejects.toThrow('--pilot-started-at');
    await expect(runReport('2026-02-30T08:00:00Z')).rejects.toThrow('--pilot-started-at');
    writeSummary(now + 1, 90);
    expect((await runReport()).status).toBe('FAIL');

    writeSummary(now, 90);
    fs.writeFileSync(catalogPath, JSON.stringify({
      absenceDetections: [second],
      providers: { 'retention-fixture': { qualifyingScanTimestamps: [iso(now - day), iso(now + 1)] } },
    }));
    expect((await runReport()).blockingReasons.join('\n')).toContain('Future qualifying scan timestamp');
    fs.writeFileSync(catalogPath, JSON.stringify({
      absenceDetections: Array.from({ length: 501 }, (_, index) => historicalEpisode(index, now - day)),
    }));
    expect((await runReport()).blockingReasons.join('\n')).toContain('DETECTION_HISTORY_CAP_EXCEEDED');
  });

  it.each(['prune', 'update', 'overflow'] as const)(
    'retention cap %s preserves active anchors and fails closed', async (scenario) => {
      const fx = createIsolatedTenModelPilotFixture('rs-c48-retention-cap-');
      let models = INITIAL_TEN_MODELS;
      let clockMs = fx.baseMs;
      const fetchFixture: typeof fetch = async (input) => {
        if (String(input) === 'https://api.openai.com/v1/models') {
          clockMs += 90;
          return Response.json({ data: models.map((model) => ({ id: model.split('/')[1]! })) });
        }
        if (String(input).includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
        return Response.json({ data: [] });
      };
      await prepareDay0PilotToAutoSafe(fx, fetchFixture);
      models = LIVE_NINE_MODELS;
      const scan = fx.baseMs + 40 * 60_000;
      const sourcePublishedAt = new Date(scan - 60 * day).toISOString();
      const claim = appendResearchEvidence(fx.stateDir, {
        provider: 'openai', modelId: 'gpt-4o-legacy', verdict: 'deprecated',
        url: 'https://platform.openai.com/docs/deprecations', quote: 'Genuine fixture notice.',
        publishedAt: sourcePublishedAt, submittedAt: new Date(scan - 60_000).toISOString(),
        submittedVia: 'cli',
      });
      const evidenceId = researchEvidenceIdentity(claim);
      const recordKey = JSON.stringify(['openai/gpt-4o-legacy', evidenceId]);
      const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
      const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const anchor = scan - 40 * day;
      const seeded = Array.from({ length: scenario === 'update' ? 499 : 500 }, (_, index) =>
        ({
          ...historicalEpisode(index, scan - 400 * day + index),
          modelPendingAt: new Date(scan - 400 * day + index + 1).toISOString(), detectionMs: 1,
        }));
      catalog.absenceDetections = seeded.map((episode, index) => scenario === 'prune' && index === 1
        ? { ...episode, recoveredAt: new Date(scan - 31 * day).toISOString() }
        : episode);
      catalog.officialNoticeDetections = scenario === 'update' ? [{
        recordKey, evidenceId, provider: 'openai', modelId: 'gpt-4o-legacy', fullStep: 'openai/gpt-4o-legacy',
        sourcePublishedAt, firstQualifyingScanStartedAt: new Date(anchor).toISOString(),
        firstPlanCreatedAt: null, publicationToPlanMs: null, detectionMs: null,
        synthetic: false, targetsAffected: ['router:nine/rs-pilot'],
      }] : [];
      fs.writeFileSync(catalogPath, JSON.stringify(catalog));
      const dbBefore = sha256File(fx.routerDbPath);
      const harnessBefore = sha256File(fx.hermesConfigPath);
      const historyPath = path.join(fx.stateDir, 'apply-history.json');
      const historyBefore = sha256File(historyPath);
      clockMs = scan;
      const result = await runTickCommand({
        configPath: fx.configPath, stateDir: fx.stateDir, mode: scenario === 'update' ? 'propose' : 'auto-safe',
        clock: () => clockMs, fetchFn: fetchFixture, harnessTargets: [], json: true,
      });
      const after = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
      expect(after.absenceDetections!.length + after.officialNoticeDetections!.length).toBe(500);
      expect(after.absenceDetections?.[0]).toMatchObject(seeded[0]!);
      const report = await runPilotReportCommand({
        stateDir: fx.stateDir, nowMs: clockMs + 60_000, silent: true,
      });
      if (scenario === 'overflow') {
        expect(result.detectionHistoryError).toBe('DETECTION_HISTORY_CAP_EXCEEDED');
        expect(after.absenceDetections).toEqual(seeded);
        expect(sha256File(fx.routerDbPath)).toBe(dbBefore);
        expect(sha256File(fx.hermesConfigPath)).toBe(harnessBefore);
        expect(sha256File(historyPath)).toBe(historyBefore);
        expect(fs.readFileSync(path.join(fx.stateDir, 'inbox.json'), 'utf8')).toContain('INVARIANT-BLOCKED');
        expect(report.status).toBe('FAIL');
        expect(report.blockingReasons.join('\n')).toContain('DETECTION_HISTORY_CAP_EXCEEDED');
        clockMs = scan + 500;
        const skipped = await runTickCommand({
          configPath: fx.configPath, stateDir: fx.stateDir, mode: 'auto-safe',
          clock: () => clockMs, fetchFn: fetchFixture, harnessTargets: [], json: true,
        });
        expect(skipped.detectionHistoryError).toBe('DETECTION_HISTORY_CAP_EXCEEDED');
        expect(sha256File(fx.routerDbPath)).toBe(dbBefore);
        expect(sha256File(historyPath)).toBe(historyBefore);
      } else {
        expect(result.detectionHistoryError).toBeUndefined();
        expect(after.officialNoticeDetections?.[0]).toMatchObject({ evidenceId, sourcePublishedAt });
        if (scenario === 'update') {
          expect(after.officialNoticeDetections?.[0]).toMatchObject({
            firstQualifyingScanStartedAt: new Date(anchor).toISOString(), detectionMs: scan + 90 - anchor,
          });
          expect(sha256File(fx.routerDbPath)).toBe(dbBefore);
        } else {
          expect(after.absenceDetections).not.toContainEqual(expect.objectContaining({ episodeId: seeded[1]!.episodeId }));
          expect(after.officialNoticeDetections?.[0]).toMatchObject({
            detectionMs: 90, publicationToPlanMs: 60 * day + 90,
            removedAt: new Date(scan + 90).toISOString(),
          });
          expect(report.criteria.detectionLatencyMs.maxMs).toBe(90);
          expect(fx.readComboRowModels()).toHaveLength(9);
        }
      }
    }, 60_000
  );
});

describe('C48 Strike-3 lifecycle', () => {
  const day = 86_400_000;

  it.each([29, 31, 40])('QA_S3 unresolved notice remains actionable after %d days', async (age) => {
    const stateDir = makeTmpDir('rs-c48-unresolved-');
    const now = Date.parse('2026-11-26T10:00:00.000Z');
    const anchor = now - age * day;
    const fullStep = 'openai/gpt-4o-legacy';
    const firstPlanCreatedAt = age === 40 ? new Date(now - 1_000).toISOString() : null;
    fs.writeFileSync(path.join(stateDir, 'tick-catalog.json'), JSON.stringify({
      officialNoticeDetections: [{
        recordKey: JSON.stringify([fullStep, 'fixture-evidence']), evidenceId: 'fixture-evidence',
        provider: 'openai', modelId: 'gpt-4o-legacy', fullStep, synthetic: false,
        sourcePublishedAt: null, firstQualifyingScanStartedAt: new Date(anchor).toISOString(),
        firstPlanCreatedAt, detectionMs: firstPlanCreatedAt === null ? null : age * day - 1_000,
        publicationToPlanMs: null, targetsAffected: ['router:nine/rs-pilot'],
      }],
    }));
    const report = await runPilotReportCommand({
      stateDir, nowMs: now, pilotStartedAt: new Date(now - day).toISOString(),
      acceptVacuousDetection: true, silent: true,
    });
    expect(report.status).toBe('FAIL');
    expect(report.criteria.detectionLatencyMs.passed).toBe(false);
    if (firstPlanCreatedAt === null) {
      expect(report.blockingReasons.join('\n')).toContain('S9_OFFICIAL_DETECTION_OVERDUE');
    } else {
      expect(report.criteria.detectionLatencyMs.maxMs).toBe(age * day - 1_000);
      expect(report.blockingReasons.join('\n')).toContain('S9_CRITERION_3_FAILED');
    }
  });

  it.each(['absence', 'official'] as const)('normal wall clock measures %s through the actual endpoint', async (kind) => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-wall-clock-');
    let models = INITIAL_TEN_MODELS;
    let wall = fx.baseMs;
    let measure = false;
    const fetchFixture: typeof fetch = async (input) => {
      if (String(input) === 'https://api.openai.com/v1/models') {
        if (measure) wall += 7_250;
        return Response.json({ data: models.map((model) => ({ id: model.split('/')[1]! })) });
      }
      if (String(input).includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };
    await prepareDay0PilotToAutoSafe(fx, fetchFixture);
    const scan = fx.baseMs + 40 * 60_000;
    wall = scan;
    models = LIVE_NINE_MODELS;
    if (kind === 'official') {
      appendResearchEvidence(fx.stateDir, {
        provider: 'openai', modelId: 'gpt-4o-legacy', verdict: 'deprecated',
        url: 'https://platform.openai.com/docs/deprecations', quote: 'Genuine fixture notice.',
        publishedAt: new Date(scan - day).toISOString(), submittedAt: new Date(scan - 1_000).toISOString(),
        submittedVia: 'cli',
      });
    }
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    measure = true;
    const summary = await runTickCommand({
      configPath: fx.configPath, stateDir: fx.stateDir, mode: 'propose', fetchFn: fetchFixture,
      harnessTargets: [], json: true,
    });
    expect(summary.detectionLatency?.maxMs).toBe(7_250);
    const catalog = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')) as TickCatalogState;
    const startedAt = new Date(scan).toISOString();
    const endedAt = new Date(scan + 7_250).toISOString();
    if (kind === 'official') {
      expect(catalog.officialNoticeDetections?.[0]).toMatchObject({
        firstQualifyingScanStartedAt: startedAt, firstPlanCreatedAt: endedAt, detectionMs: 7_250,
      });
    } else {
      expect(catalog.absenceDetections?.[0]).toMatchObject({
        scanStartedAt: startedAt, modelPendingAt: endedAt, detectionMs: 7_250,
      });
    }
  }, 60_000);

  it('QA_S3_D/F retires unused and manually removed episodes, prunes at idle, and re-pends on return', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-idle-retention-');
    const unused = 'unused-fixture-model';
    const manuallyRemoved = 'manual-fixture-model';
    const fetchFixture: typeof fetch = async (input) => {
      if (String(input) === 'https://api.openai.com/v1/models') {
        return Response.json({ data: INITIAL_TEN_MODELS.map((model) => ({ id: model.split('/')[1]! })) });
      }
      if (String(input).includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };
    await prepareDay0PilotToAutoSafe(fx, fetchFixture);
    const at = fx.baseMs + 40 * 60_000;
    const catalogFile = path.join(fx.stateDir, 'tick-catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    const episode = (model: string, startedAt: number) => ({
      episodeId: `ep-${JSON.stringify(['openai', model, startedAt])}`,
      provider: 'openai', modelId: model, fullStep: `openai/${model}`, status: 'model_pending',
      scanStartedAt: new Date(startedAt).toISOString(), modelPendingAt: new Date(startedAt + 1).toISOString(),
      detectionMs: 1, targetsAffected: ['router:nine/rs-pilot'],
    });
    const unusedRecord = episode(unused, at - 8 * day);
    const expiredRecord = { ...episode('expired-fixture', at - 40 * day), recoveredAt: new Date(at - 35 * day).toISOString() };
    catalog.absenceDetections = [unusedRecord, expiredRecord, episode(manuallyRemoved, at - 2 * day)];
    catalog.providers.openai.firstAbsentAt = { [unused]: unusedRecord.scanStartedAt };
    catalog.providers.openai.absenceCounts = { [unused]: 3 };
    catalog.providers.openai.pendingEpisodes = { [unused]: unusedRecord.episodeId };
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    appendApplyReceipt(fx.stateDir, {
      target: 'router:nine/rs-pilot', planHash: 'fixture-manual-plan',
      appliedAt: new Date(at - day).toISOString(), appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty', snapshotOrBackupRef: 'fixture-snapshot',
      success: true, readBackVerified: true, rolledBack: false, readBackLevel: 'db-only',
      removedModels: [],
    });
    // The old manual receipt lacks model IDs; only a readable target with missing membership can reconcile it.
    // Use a separate target for the abandoned episode so that the manual receipt does not cover it.
    catalog.absenceDetections[0].targetsAffected = ['router:nine/other-fixture-combo'];
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    const tick = (atMs: number) => runTickCommand({
      configPath: fx.configPath, stateDir: fx.stateDir, mode: 'propose',
      clock: () => atMs, fetchFn: fetchFixture, harnessTargets: [], json: true,
    });
    await tick(at);
    const read = () => JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as TickCatalogState;
    expect(read().absenceDetections).toHaveLength(2);
    expect(read().absenceDetections?.find((record) => record.modelId === unused))
      .toMatchObject({ abandonedAt: new Date(at).toISOString() });
    expect(read().providers.openai?.pendingEpisodes?.[unused]).toBeUndefined();
    expect(read().absenceDetections?.find((record) => record.modelId === manuallyRemoved))
      .toMatchObject({ removedAt: new Date(at).toISOString() });

    const models = fx.readComboRowModels();
    const returningDb = path.join(fx.routerDir, 'returning-fixture.sqlite');
    fs.copyFileSync(fx.routerDbPath, returningDb);
    if (fs.existsSync(`${fx.routerDbPath}-wal`)) fs.copyFileSync(`${fx.routerDbPath}-wal`, `${returningDb}-wal`);
    const db = openBetterSqlite3(returningDb, { restrictToDir: fx.routerDir });
    try {
      const cloned = db.prepare('SELECT models FROM combos WHERE name = ?').get('rs-pilot') as { models: string };
      expect(JSON.parse(cloned.models)).toEqual(models);
      db.prepare('UPDATE combos SET models = ? WHERE name = ?')
        .run(JSON.stringify([...models, `openai/${unused}`]), 'rs-pilot');
    } finally {
      db.close();
    }
    vi.stubEnv('ROUTERSYNC_9ROUTER_DB', returningDb);
    const config = fs.readFileSync(fx.configPath, 'utf8');
    expect(config).toContain(JSON.stringify(fx.routerDbPath));
    fs.writeFileSync(fx.configPath, config.replace(JSON.stringify(fx.routerDbPath), JSON.stringify(returningDb)));
    const next = at + 20 * 60_000;
    await tick(next);
    const returning = read().absenceDetections?.filter((record) => record.modelId === unused) ?? [];
    expect(returning).toHaveLength(2);
    expect(returning[1]?.episodeId).not.toBe(returning[0]?.episodeId);
    expect(returning[1]).toMatchObject({ scanStartedAt: new Date(next).toISOString() });
    expect(returning[1]?.abandonedAt).toBeUndefined();
  }, 60_000);
});

describe('C48-H2: 5-Case Isolated Fixture Rehearsal in os.tmpdir()', () => {
  it('Case 1: absence-only tick 3 after 48h -> PASS, detection <= 60000ms, settlement ~ 172800000ms, 1 removed, 0 false, verified rollback', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h2-case1-');
    let clockMs = fx.baseMs;
    const clock = () => clockMs;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += 180; // 180ms deterministic scan-to-pending window
        return Response.json({ data: (clockMs < fx.baseMs + 20 * 60_000 ? INITIAL_TEN_MODELS : LIVE_NINE_MODELS).map((m) => ({ id: m.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);
    expect(fx.readComboRowModels()).toEqual(PROPOSE_REORDERED_TEN_MODELS);

    // Day 0 first auto-safe tick (+20m after observe): commits model_pending
    const firstAbsentScanStart = fx.baseMs + 20 * 60_000;
    clockMs = firstAbsentScanStart;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(fx.readComboRowModels()).toHaveLength(10);

    // Scan 2 still waits. Scan 3 settles the absence after 48 hours.
    clockMs = firstAbsentScanStart + 15 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(fx.readComboRowModels()).toHaveLength(10);

    clockMs = firstAbsentScanStart + 48 * 60 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    const removal = readApplyHistory(fx.stateDir).receipts.flatMap((r) => r.removedModels ?? []);
    expect(removal).toHaveLength(1);
    expect(removal[0]?.qualifyingScanCount).toBe(3);
    // 1 absent model removed (10 -> 9)
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);

    // Freeze, unfreeze, and rollback router combo rows + harness YAML
    await runFreezeUnfreezeAndRollback(fx, snapId);
    expect(fx.readComboRowModels()).toEqual(INITIAL_TEN_MODELS);
    expect(sha256File(fx.hermesConfigPath)).toBe(fx.preHermesSha);

    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: firstAbsentScanStart + 48 * 60 * 60_000 + 60_000,
      silent: true,
      json: true,
    });
    const exitCode = process.exitCode ?? 0;

    console.log(
      'C48_H2_CASE',
      JSON.stringify({
        caseId: 1,
        scenario: 'absence-only-scan3-after-48h',
        qualifyingScanCount: removal[0]?.qualifyingScanCount,
        status: report.status,
        exitCode,
        tickCount: report.tickCount,
        removals: report.criteria.falseRemovals.removedModelCount,
        falseRemovals: report.criteria.falseRemovals.count,
        measuredCount: report.criteria.detectionLatencyMs.measuredCount,
        detectionMs: report.criteria.detectionLatencyMs.maxMs,
        removalSettleMs: report.removalSettle.removalSettleMs,
        observedScanIntervalMs: report.removalSettle.observedScanIntervalMs,
        providerToFirstScanMs: report.removalSettle.providerToFirstScanMs,
        verifiedRollbacks: report.criteria.rollbackByteExactMatch.verifiedReceiptsCount,
        routerComboMatched: JSON.stringify(fx.readComboRowModels()) === JSON.stringify(INITIAL_TEN_MODELS),
        harnessShaMatched: sha256File(fx.hermesConfigPath) === fx.preHermesSha,
      })
    );

    expect(exitCode).toBe(0);
    expect(report.status, report.blockingReasons.join('\n')).toBe('PASS');
    expect(report.criteria.falseRemovals.removedModelCount).toBe(1);
    expect(report.criteria.falseRemovals.count).toBe(0);
    expect(report.criteria.detectionLatencyMs.measuredCount).toBe(1);
    expect(report.criteria.detectionLatencyMs.maxMs).toBe(180);
    expect(report.criteria.detectionLatencyMs.maxMs!).toBeLessThanOrEqual(60_000);
    expect(report.removalSettle.status).toBe('PASS');
    expect(report.removalSettle.removalSettleMs).toBeGreaterThanOrEqual(172_800_000);
    expect(report.removalSettle.removalSettleMs).toBeLessThan(172_805_000);
    expect(report.removalSettle.providerToFirstScanMs).toBeNull();
    expect(report.criteria.rollbackByteExactMatch.passed).toBe(true);
  }, 60_000);

  it('Case 2: early removal evidence deliberately injected in synthetic test data (genuine guard kept) -> FAIL', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h2-case2-');
    let clockMs = fx.baseMs;
    const clock = () => clockMs;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        return Response.json({ data: (clockMs < fx.baseMs + 20 * 60_000 ? INITIAL_TEN_MODELS : LIVE_NINE_MODELS).map((m) => ({ id: m.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);

    // Genuine guard check: 3 qualifying absence scans spanning 40 minutes (< 24h) MUST NOT remove the model!
    const firstAbsentAt = fx.baseMs + 20 * 60_000;
    for (const offsetMin of [0, 20, 40]) {
      clockMs = firstAbsentAt + offsetMin * 60_000;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        mode: 'auto-safe',
        clock,
        fetchFn: mockFetch,
        harnessTargets: [],
        json: true,
      });
    }
    expect(fx.readComboRowModels()).toEqual(PROPOSE_REORDERED_TEN_MODELS);

    const catalog = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')) as TickCatalogState;
    expect(catalog.providers.openai?.absenceCounts['gpt-4o-legacy']).toBe(3);
    expect(catalog.absenceDetections).toHaveLength(1);
    expect(catalog.absenceDetections?.[0]).toMatchObject({
      scanStartedAt: new Date(firstAbsentAt).toISOString(),
      modelPendingAt: new Date(firstAbsentAt + 1).toISOString(),
      detectionMs: 1,
    });
    // Deliberately inject synthetic premature removal receipt (at 23h59m59.999s < 24h)
    const prematureRemovedAtMs = firstAbsentAt + 86_400_000 - 1;
    appendApplyReceipt(fx.stateDir, {
      target: 'router:nine/rs-pilot',
      planHash: 'e'.repeat(64),
      appliedAt: new Date(prematureRemovedAtMs).toISOString(),
      appliedAtLevel: 'auto-safe',
      authorizedVia: 'standing-consent',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: snapId,
      removedModels: [
        {
          provider: 'openai',
          modelId: 'gpt-4o-legacy',
          inProviderCatalog: false,
          removalPath: 'absence-only',
          firstObservedAbsentAt: new Date(firstAbsentAt).toISOString(),
          removedAt: new Date(prematureRemovedAtMs).toISOString(),
          removalSettleMs: 86_400_000 - 1,
          qualifyingScanCount: 3,
        },
      ],
    });

    await runFreezeUnfreezeAndRollback(fx, snapId);
    expect(fx.readComboRowModels()).toEqual(INITIAL_TEN_MODELS);
    expect(sha256File(fx.hermesConfigPath)).toBe(fx.preHermesSha);

    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: prematureRemovedAtMs + 60_000,
      silent: true,
      json: true,
    });
    const exitCode = process.exitCode ?? 0;

    console.log(
      'C48_H2_CASE',
      JSON.stringify({
        caseId: 2,
        scenario: 'synthetic-injected-early-removal',
        qualifyingScanCount: catalog.providers.openai?.absenceCounts['gpt-4o-legacy'],
        status: report.status,
        exitCode,
        tickCount: report.tickCount,
        removals: report.criteria.falseRemovals.removedModelCount,
        falseRemovals: report.criteria.falseRemovals.count,
        measuredCount: report.criteria.detectionLatencyMs.measuredCount,
        detectionMs: report.criteria.detectionLatencyMs.maxMs,
        removalSettleMs: report.removalSettle.removalSettleMs,
        verifiedRollbacks: report.criteria.rollbackByteExactMatch.verifiedReceiptsCount,
        routerComboMatched: JSON.stringify(fx.readComboRowModels()) === JSON.stringify(INITIAL_TEN_MODELS),
        harnessShaMatched: sha256File(fx.hermesConfigPath) === fx.preHermesSha,
      })
    );

    expect(exitCode).toBe(1);
    expect(report.status).toBe('FAIL');
    expect(report.removalSettle.status).toBe('FAIL');
    expect(report.removalSettle.policySatisfiedAtRemoval).toBe(false);
  }, 60_000);

  it('Case 3: synthetic official notice -> isolated rehearsal PASS, live sign-off FAIL', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h2-case3-');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const clock = () => clockMs;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += 90;
        return Response.json({ data: activeModels.map((m) => ({ id: m.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);

    // Submit synthetic official deprecation notice and drop model from catalog
    activeModels = LIVE_NINE_MODELS;
    const noticeTickStart = fx.baseMs + 20 * 60_000;
    appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Synthetic provider notice for C48 H2 isolated fixture.',
      publishedAt: new Date(noticeTickStart - 250).toISOString(),
      synthetic: true,
      submittedAt: new Date(noticeTickStart - 200).toISOString(),
      submittedVia: 'cli',
    });

    const deduped = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Replacement wording without fixture markers.',
      publishedAt: new Date(noticeTickStart - 250).toISOString(),
      submittedAt: new Date(noticeTickStart - 100).toISOString(),
      submittedVia: 'cli',
    });
    expect(deduped.synthetic).toBe(true);
    clockMs = noticeTickStart;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    const modelsBeforeRehearsal = fx.readComboRowModels();
    expect(modelsBeforeRehearsal).toHaveLength(10);

    const fixtureTickStart = noticeTickStart + 15 * 60_000;
    clockMs = fixtureTickStart;
    const rehearsalTick = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      allowSyntheticNoticeFixture: true,
      harnessTargets: [],
      json: true,
    });
    const modelsAfterRehearsal = fx.readComboRowModels();
    const removedModels = modelsBeforeRehearsal.filter((model) => !modelsAfterRehearsal.includes(model));
    expect(rehearsalTick.effectiveMode).toBe('auto-safe');
    expect(modelsAfterRehearsal).toEqual(LIVE_NINE_MODELS);
    expect(removedModels).toEqual(['openai/gpt-4o-legacy']);
    const rehearsalReceipts = readApplyHistory(fx.stateDir).receipts.filter(
      (receipt) => receipt.target === 'router:nine/rs-pilot' &&
        receipt.appliedAtLevel === 'auto-safe' && (receipt.removedModels?.length ?? 0) > 0
    );
    expect(rehearsalReceipts).toHaveLength(1);
    expect(rehearsalReceipts[0]).toMatchObject({
      success: true,
      readBackVerified: true,
      removedModels: [{ provider: 'openai', modelId: 'gpt-4o-legacy', syntheticNotice: true }],
    });
    const catalog = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')) as TickCatalogState;
    expect(catalog.officialNoticeDetections).toHaveLength(1);
    expect(catalog.officialNoticeDetections?.[0]).toMatchObject({
      synthetic: true,
      sourcePublishedAt: new Date(noticeTickStart - 250).toISOString(),
    });

    await runFreezeUnfreezeAndRollback(fx, snapId);
    expect(fx.readComboRowModels()).toEqual(INITIAL_TEN_MODELS);
    expect(sha256File(fx.hermesConfigPath)).toBe(fx.preHermesSha);

    const mdLines: string[] = [];
    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: fixtureTickStart + 60_000,
      writeStdout: (chunk) => mdLines.push(chunk),
    });
    const exitCode = process.exitCode ?? 0;

    expect(exitCode).toBe(1);
    expect(report.status, report.blockingReasons.join('\n')).toBe('FAIL');
    expect(report.criteria.falseRemovals.removedModelCount).toBe(1);
    expect(report.criteria.falseRemovals.count).toBe(0);
    expect(report.criteria.detectionLatencyMs).toMatchObject({ measuredCount: 1, maxMs: 90, source: 'tick-catalog.json' });
    expect(report.removalSettle).toMatchObject({
      status: 'FAIL', policySatisfiedAtRemoval: false, removedModelCount: 1,
      removalPaths: ['official-notice'], noticeOrigin: 'synthetic',
    });
    expect(report.blockingReasons.join('\n')).toContain('SYNTHETIC_OFFICIAL_NOTICE');
    expect(mdLines.join('')).toContain('synthetic');

    console.log(
      'C48_H2_CASE',
      JSON.stringify({
        caseId: 3,
        scenario: 'synthetic-official-notice',
        isolatedRehearsal: 'PASS',
        isolatedRemovedModels: removedModels,
        liveSignOff: report.status,
        liveSignOffExitCode: exitCode,
        tickCount: report.tickCount,
        removals: report.criteria.falseRemovals.removedModelCount,
        falseRemovals: report.criteria.falseRemovals.count,
        measuredCount: report.criteria.detectionLatencyMs.measuredCount,
        detectionMs: report.criteria.detectionLatencyMs.maxMs,
        removalSettleMs: report.removalSettle.removalSettleMs,
        noticeOrigin: report.removalSettle.noticeOrigin,
        verifiedRollbacks: report.criteria.rollbackByteExactMatch.verifiedReceiptsCount,
        routerComboMatched: JSON.stringify(fx.readComboRowModels()) === JSON.stringify(INITIAL_TEN_MODELS),
        harnessShaMatched: sha256File(fx.hermesConfigPath) === fx.preHermesSha,
      })
    );
  }, 60_000);

  it('Case 4: steady 0 samples -> INCOMPLETE / VACUOUS', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h2-case4-');
    let clockMs = fx.baseMs;
    const clock = () => clockMs;

    const steadyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += 80;
        return Response.json({ data: INITIAL_TEN_MODELS.map((m) => ({ id: m.split('/')[1]! })) });
      }
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, steadyFetch);

    clockMs = fx.baseMs + 20 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: steadyFetch,
      harnessTargets: [],
      json: true,
    });
    expect(fx.readComboRowModels()).toEqual(PROPOSE_REORDERED_TEN_MODELS);

    await runFreezeUnfreezeAndRollback(fx, snapId);
    expect(fx.readComboRowModels()).toEqual(INITIAL_TEN_MODELS);
    expect(sha256File(fx.hermesConfigPath)).toBe(fx.preHermesSha);

    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      falseRemovals: 0,
      unplannedInterventions: 0,
      nowMs: fx.baseMs + 25 * 60_000,
      silent: true,
      json: true,
    });
    const exitCode = process.exitCode ?? 0;

    console.log(
      'C48_H2_CASE',
      JSON.stringify({
        caseId: 4,
        scenario: 'steady-zero-samples',
        status: report.status,
        exitCode,
        tickCount: report.tickCount,
        removals: report.criteria.falseRemovals.removedModelCount,
        falseRemovals: report.criteria.falseRemovals.count,
        measuredCount: report.criteria.detectionLatencyMs.measuredCount,
        detectionMs: report.criteria.detectionLatencyMs.maxMs,
        removalSettleMs: report.removalSettle.removalSettleMs,
        verifiedRollbacks: report.criteria.rollbackByteExactMatch.verifiedReceiptsCount,
        routerComboMatched: JSON.stringify(fx.readComboRowModels()) === JSON.stringify(INITIAL_TEN_MODELS),
        harnessShaMatched: sha256File(fx.hermesConfigPath) === fx.preHermesSha,
      })
    );

    expect(exitCode).toBe(1);
    expect(report.status).toBe('INCOMPLETE');
    expect(report.criteria.detectionLatencyMs.measuredCount).toBe(0);
    expect(report.criteria.detectionLatencyMs.maxMs).toBeNull();
    expect(report.criteria.detectionLatencyMs.detail).toContain('VACUOUS');
    expect(report.blockingReasons.join('\n')).toContain('VACUOUS');
    expect(report.removalSettle).toMatchObject({
      status: 'INCOMPLETE', policySatisfiedAtRemoval: null, removedModelCount: 0,
      removalPaths: [], noticeOrigin: 'none', removalSettleMs: null,
    });
  }, 60_000);

  it('Case 5: forced scan time > 60000 ms -> FAIL on Criterion 3', async () => {
    const fx = createIsolatedTenModelPilotFixture('rs-c48-h2-case5-');
    let clockMs = fx.baseMs;
    let forceSlowScan = false;
    const clock = () => clockMs;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += forceSlowScan ? 65_000 : 100;
        return Response.json({ data: LIVE_NINE_MODELS.map((m) => ({ id: m.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);

    // Tick 1: forced slow scan (> 60000ms) during model_pending detection
    const firstAbsentAt = fx.baseMs + 20 * 60_000;
    clockMs = firstAbsentAt;
    forceSlowScan = true;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    forceSlowScan = false;

    clockMs = firstAbsentAt + 20 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });

    clockMs = firstAbsentAt + 24 * 60 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);

    await runFreezeUnfreezeAndRollback(fx, snapId);
    expect(fx.readComboRowModels()).toEqual(INITIAL_TEN_MODELS);
    expect(sha256File(fx.hermesConfigPath)).toBe(fx.preHermesSha);

    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: firstAbsentAt + 24 * 60 * 60_000 + 60_000,
      silent: true,
      json: true,
    });
    const exitCode = process.exitCode ?? 0;

    console.log(
      'C48_H2_CASE',
      JSON.stringify({
        caseId: 5,
        scenario: 'forced-scan-over-60000ms',
        status: report.status,
        exitCode,
        tickCount: report.tickCount,
        removals: report.criteria.falseRemovals.removedModelCount,
        falseRemovals: report.criteria.falseRemovals.count,
        measuredCount: report.criteria.detectionLatencyMs.measuredCount,
        detectionMs: report.criteria.detectionLatencyMs.maxMs,
        removalSettleMs: report.removalSettle.removalSettleMs,
        verifiedRollbacks: report.criteria.rollbackByteExactMatch.verifiedReceiptsCount,
        routerComboMatched: JSON.stringify(fx.readComboRowModels()) === JSON.stringify(INITIAL_TEN_MODELS),
        harnessShaMatched: sha256File(fx.hermesConfigPath) === fx.preHermesSha,
      })
    );

    expect(exitCode).toBe(1);
    expect(report.status).toBe('FAIL');
    expect(report.criteria.detectionLatencyMs.passed).toBe(false);
    expect(report.criteria.detectionLatencyMs.maxMs).toBe(65_000);
    expect(report.blockingReasons.join('\n')).toContain('S9_CRITERION_3_FAILED');
    expect(report.removalSettle.status).toBe('PASS');
  }, 60_000);

  it('QA-FINAL-3: propose plan latch (90ms) survives +20m continuous actionable metadata successor and reports PASS (not 1200090ms FAIL)', async () => {
    const fx = createIsolatedTenModelPilotFixture('qaf3-propose-successor');
    let activeModels = LIVE_NINE_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 90;
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/v1/models')) {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.replace(/^openai\//, '') })) });
      }
      return Response.json({ data: [] });
    };

    activeModels = INITIAL_TEN_MODELS;
    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);
    activeModels = LIVE_NINE_MODELS;

    const firstScan = fx.baseMs + 40 * 60_000;
    const retiredModel = 'gpt-4o-legacy';
    const initialPubAt = firstScan - 3_600_000;

    const v1 = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: retiredModel,
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Initial official retirement notice for gpt-4o-legacy.',
      publishedAt: new Date(initialPubAt).toISOString(),
      shutdownDate: new Date(firstScan - 60_000).toISOString(),
      submittedAt: new Date(firstScan - 30_000).toISOString(),
      submittedVia: 'cli',
    });

    clockMs = firstScan;
    const tick1 = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(tick1.detectionLatency?.maxMs).toBe(elapsed);

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const readNotices = () =>
      (JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState)
        .officialNoticeDetections ?? [];
    expect(readNotices()).toHaveLength(1);
    expect(readNotices()[0]).toMatchObject({
      evidenceId: researchEvidenceIdentity(v1),
      firstQualifyingScanStartedAt: new Date(firstScan).toISOString(),
      firstPlanCreatedAt: new Date(firstScan + elapsed).toISOString(),
      detectionMs: elapsed,
    });

    const successorPubAt = firstScan + 15 * 60_000;
    const v2 = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: retiredModel,
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations#followup',
      quote: 'Updated retirement bulletin adding recommended replacement metadata.',
      publishedAt: new Date(successorPubAt).toISOString(),
      shutdownDate: new Date(firstScan - 60_000).toISOString(),
      replacementModelId: 'gpt-4.1-mini',
      submittedAt: new Date(successorPubAt + 1_000).toISOString(),
      submittedVia: 'cli',
    });
    expect(researchEvidenceIdentity(v2)).not.toBe(researchEvidenceIdentity(v1));

    const secondScan = firstScan + 20 * 60_000;
    clockMs = secondScan;
    const tick2 = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(tick2.detectionLatency?.measuredCount).toBe(0);

    const afterTick2 = readNotices();
    expect(afterTick2).toHaveLength(1);
    expect(afterTick2[0]).toMatchObject({
      evidenceId: researchEvidenceIdentity(v2),
      sourcePublishedAt: new Date(successorPubAt).toISOString(),
      firstQualifyingScanStartedAt: new Date(firstScan).toISOString(),
      firstPlanCreatedAt: new Date(firstScan + elapsed).toISOString(),
      detectionMs: elapsed,
      publicationToPlanMs: firstScan + elapsed - successorPubAt,
    });
    expect(afterTick2[0]?.supersededAt).toBeUndefined();
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);

    await runFreezeUnfreezeAndRollback(fx, snapId);

    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: secondScan + 60_000,
      silent: true,
      json: true,
    });
    expect(report.status, report.blockingReasons.join('\n')).toBe('PASS');
    expect(report.criteria.detectionLatencyMs.maxMs).toBe(elapsed);
    expect(report.criteria.detectionLatencyMs.passed).toBe(true);
  }, 60_000);

  it('QA-FINAL-4: router + harness rollback reopens completed episodes so subsequent tick/apps reapply succeeds preserving original detectionMs', async () => {
    const fx = createIsolatedTenModelPilotFixture('qaf4-rollback-reapply');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 75;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);
    const postDay0HermesBak = `${fx.hermesConfigPath}.post-day0.bak`;
    fs.copyFileSync(fx.hermesConfigPath, postDay0HermesBak);
    const postDay0HermesSha = sha256File(fx.hermesConfigPath);
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).toContain('gpt-4o-legacy');

    activeModels = LIVE_NINE_MODELS;

    const firstAbsentAt = fx.baseMs + 40 * 60_000;
    for (const offset of [0, 20 * 60_000, 25 * 60 * 60_000]) {
      clockMs = firstAbsentAt + offset;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        mode: 'auto-safe',
        clock: () => clockMs,
        fetchFn: mockFetch,
        json: true,
      });
    }
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const readCat = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
    const readEp = () => readCat().absenceDetections?.[0];
    expect(readEp()?.removedAt).toEqual(expect.any(String));
    expect(readEp()?.detectionMs).toBe(elapsed);

    // Rollback router to the auto-safe removal snapshot (keeping Day-0 propose receipt intact) + rollback Hermes to post-Day-0 backup
    const routerAutoSafeSnap = readApplyHistory(fx.stateDir).receipts.find(
      (r) => r.target === 'router:nine/rs-pilot' && r.appliedAtLevel === 'auto-safe' && !r.rolledBack
    )?.snapshotOrBackupRef;
    expect(routerAutoSafeSnap).toBeTruthy();
    expect(routerAutoSafeSnap).not.toBe(snapId);
    await runRollbackCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      snapshotId: routerAutoSafeSnap!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(fx.readComboRowModels()).toContain('openai/gpt-4o-legacy');
    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.hermesConfigPath,
      backup: postDay0HermesBak,
      expectedPreSha256: postDay0HermesSha,
      stateDir: fx.stateDir,
      json: true,
    });
    expect(fx.readComboRowModels()).toHaveLength(10);
    expect(sha256File(fx.hermesConfigPath)).toBe(postDay0HermesSha);
    expect(readEp()?.removedAt).toBeUndefined();
    expect(readEp()?.detectionMs).toBe(elapsed);
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBe(readEp()?.episodeId);

    // Re-apply Hermes via standalone apps apply --write (align wall clock with simulated Day+1 tick)
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(firstAbsentAt + 25 * 60 * 60_000 + 5_000);
      await runAppsApplyCommand({
        app: 'hermes',
        config: fx.hermesConfigPath,
        stateDir: fx.stateDir,
        home: fx.fakeHome,
        write: true,
        isTTY: false,
        json: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');

    // Re-apply router via subsequent auto-safe tick without re-measuring or laundering detectionMs
    clockMs = firstAbsentAt + 26 * 60 * 60_000;
    const reapplyTick = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(reapplyTick.detectionLatency?.measuredCount).toBe(0);
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    expect(readEp()?.removedAt).toEqual(expect.any(String));
    expect(readEp()?.detectionMs).toBe(elapsed);

    // Reverse multi-target order: rollback BOTH again, re-apply router FIRST (while harness stays rolled back),
    // verify episode stays open for harness, then re-apply harness via apps apply --write to close episode cleanly!
    const routerSecondSnap = readApplyHistory(fx.stateDir)
      .receipts.filter((r) => r.target === 'router:nine/rs-pilot' && r.appliedAtLevel === 'auto-safe' && !r.rolledBack)
      .at(-1)?.snapshotOrBackupRef;
    expect(routerSecondSnap).toBeTruthy();
    await runRollbackCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      snapshotId: routerSecondSnap!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.hermesConfigPath,
      backup: postDay0HermesBak,
      expectedPreSha256: postDay0HermesSha,
      stateDir: fx.stateDir,
      json: true,
    });
    expect(readEp()?.removedAt).toBeUndefined();

    clockMs = firstAbsentAt + 27 * 60 * 60_000;
    const routerFirstTick = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(routerFirstTick.detectionLatency?.measuredCount).toBe(0);
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    // Episode remains open because harness:hermes still has an un-reapplied rollback receipt!
    expect(readEp()?.removedAt).toBeUndefined();
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBe(readEp()?.episodeId);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(firstAbsentAt + 27 * 60 * 60_000 + 5_000);
      await runAppsApplyCommand({
        app: 'hermes',
        config: fx.hermesConfigPath,
        stateDir: fx.stateDir,
        home: fx.fakeHome,
        write: true,
        isTTY: false,
        json: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');
    expect(readEp()?.removedAt).toEqual(expect.any(String));
    expect(readEp()?.detectionMs).toBe(elapsed);
  }, 60_000);

  it('QA-FINAL-5 (M4): withdrawal-before-plan never blocks PASS pilot-report and resets anchor on same-gap reassertion without intermediate tick', async () => {
    const fx = createIsolatedTenModelPilotFixture('qaf5-m4-withdrawal-before-plan');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 80;
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/v1/models')) {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.replace(/^openai\//, '') })) });
      }
      return Response.json({ data: [] });
    };

    const { snapId } = await prepareDay0PilotToAutoSafe(fx, mockFetch);

    const firstScan = fx.baseMs + 40 * 60_000;
    const retiredModel = 'gpt-4o-legacy';
    const secondModel = 'gpt-4.1-mini';
    const submit = (modelId: string, verdict: 'active' | 'deprecated', atMs: number) =>
      appendResearchEvidence(fx.stateDir, {
        provider: 'openai',
        modelId,
        verdict,
        url: 'https://platform.openai.com/docs/deprecations',
        quote: 'Official lifecycle transition fixture for M4.',
        ...(verdict === 'deprecated'
          ? { publishedAt: new Date(atMs - 60_000).toISOString(), shutdownDate: new Date(atMs - 30_000).toISOString() }
          : {}),
        submittedAt: new Date(atMs).toISOString(),
        submittedVia: 'cli',
      });

    submit(retiredModel, 'deprecated', firstScan - 10_000);
    submit(secondModel, 'deprecated', firstScan - 10_000);
    clockMs = firstScan;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });

    submit(retiredModel, 'active', firstScan + 1_000);
    submit(secondModel, 'active', firstScan + 1_000);
    const secondScan = firstScan + 20 * 60_000;
    clockMs = secondScan;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });

    process.exitCode = 0;
    const vacuousReport = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      falseRemovals: 0,
      unplannedInterventions: 0,
      acceptVacuousDetection: true,
      nowMs: secondScan + 60_000,
      silent: true,
      json: true,
    });
    expect(vacuousReport.status).toBe('INCOMPLETE');
    expect(vacuousReport.criteria.detectionLatencyMs.passed).toBe(true);
    expect(vacuousReport.blockingReasons.join('\n')).not.toContain('S9_OFFICIAL_DETECTION_OVERDUE');
    expect(vacuousReport.blockingReasons.join('\n')).not.toContain('S9_OFFICIAL_DETECTION_INCOMPLETE');

    const thirdScan = secondScan + 20 * 60_000;
    submit(retiredModel, 'deprecated', thirdScan - 5_000);
    submit(secondModel, 'deprecated', thirdScan - 5_000);
    clockMs = thirdScan;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });

    // Same-gap withdrawal + reassertion without an intermediate tick!
    submit(retiredModel, 'active', thirdScan + 1_000);
    submit(secondModel, 'active', thirdScan + 1_000);
    submit(retiredModel, 'deprecated', thirdScan + 2_000);

    activeModels = LIVE_NINE_MODELS;
    const fourthScan = thirdScan + 20 * 60_000;
    clockMs = fourthScan;
    const fourthTick = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(fourthTick.detectionLatency?.maxMs).toBe(elapsed);
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);

    const cat = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8')) as TickCatalogState;
    const retiredEpisodes = (cat.officialNoticeDetections ?? []).filter((r) => r.modelId === retiredModel);
    expect(retiredEpisodes.at(-2)).toMatchObject({
      firstQualifyingScanStartedAt: new Date(thirdScan).toISOString(),
      firstPlanCreatedAt: null,
      withdrawnAt: new Date(thirdScan + 1_000).toISOString(),
    });
    expect(retiredEpisodes.at(-1)).toMatchObject({
      firstQualifyingScanStartedAt: new Date(fourthScan).toISOString(),
      firstPlanCreatedAt: new Date(fourthScan + elapsed).toISOString(),
      detectionMs: elapsed,
    });

    await runFreezeUnfreezeAndRollback(fx, snapId);
    process.exitCode = 0;
    const finalReport = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: fourthScan + 60_000,
      silent: true,
      json: true,
    });
    expect(finalReport.status, finalReport.blockingReasons.join('\n')).toBe('PASS');
    expect(finalReport.criteria.detectionLatencyMs).toMatchObject({
      measuredCount: 1,
      maxMs: elapsed,
      passed: true,
    });
  }, 60_000);

  it('QA-FINAL-5 (M15): re-pends sole absent returning model despite stale pendingEpisodes and prunes >30d abandoned episodes', async () => {
    const fx = createIsolatedTenModelPilotFixture('qaf5-m15-abandoned-repend');
    const day = 86_400_000;
    const activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 60;
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/v1/models')) {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.replace(/^openai\//, '') })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    await prepareDay0PilotToAutoSafe(fx, mockFetch);

    // Keep ALL 10 initial models live so returningModel is the SOLE absent model on the tick!
    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const oldAbandonedModel = 'gpt-35d-abandoned';
    const returningModel = 'gpt-abandoned-returning';
    const at = fx.baseMs + 45 * day;
    const oldEpId = `ep-${JSON.stringify(['openai', oldAbandonedModel, at - 43 * day])}`;
    const staleEpId = `ep-${JSON.stringify(['openai', returningModel, at - 9 * day])}`;

    const catSeed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    catSeed.providers.openai.ids = INITIAL_TEN_MODELS.map((m) => m.replace(/^openai\//, ''));
    catSeed.providers.openai.absenceCounts = { [returningModel]: 5 };
    catSeed.providers.openai.firstAbsentAt = { [returningModel]: new Date(at - 9 * day).toISOString() };
    catSeed.providers.openai.pendingEpisodes = {
      [returningModel]: staleEpId,
      [oldAbandonedModel]: oldEpId,
    };
    catSeed.absenceDetections = [
      {
        episodeId: oldEpId,
        provider: 'openai',
        modelId: oldAbandonedModel,
        fullStep: `openai/${oldAbandonedModel}`,
        status: 'model_pending',
        scanStartedAt: new Date(at - 43 * day).toISOString(),
        modelPendingAt: new Date(at - 43 * day + 25).toISOString(),
        detectionMs: 25,
        targetsAffected: ['router:nine/other-combo'],
        abandonedAt: new Date(at - 35 * day).toISOString(),
      },
      {
        episodeId: staleEpId,
        provider: 'openai',
        modelId: returningModel,
        fullStep: `openai/${returningModel}`,
        status: 'model_pending',
        scanStartedAt: new Date(at - 9 * day).toISOString(),
        modelPendingAt: new Date(at - 9 * day + 99_000).toISOString(),
        detectionMs: 99_000,
        targetsAffected: ['router:nine/other-combo'],
        abandonedAt: new Date(at - day).toISOString(),
      },
    ];
    fs.writeFileSync(catalogPath, JSON.stringify(catSeed, null, 2));

    const returningDb = path.join(fx.routerDir, 'm15-returning.sqlite');
    fs.copyFileSync(fx.routerDbPath, returningDb);
    if (fs.existsSync(`${fx.routerDbPath}-wal`)) {
      fs.copyFileSync(`${fx.routerDbPath}-wal`, `${returningDb}-wal`);
    }
    const db2 = openBetterSqlite3(returningDb, { restrictToDir: fx.routerDir });
    try {
      db2.prepare('INSERT INTO models (id, provider, modelId, isActive) VALUES (?, ?, ?, 1)').run(
        `openai/${returningModel}`,
        'openai',
        returningModel
      );
      db2.prepare('UPDATE combos SET models = ? WHERE name = ?').run(
        JSON.stringify([...LIVE_NINE_MODELS, `openai/${returningModel}`]),
        'rs-pilot'
      );
    } finally {
      db2.close();
    }
    vi.stubEnv('ROUTERSYNC_9ROUTER_DB', returningDb);
    const cfgRaw = fs.readFileSync(fx.configPath, 'utf8');
    fs.writeFileSync(fx.configPath, cfgRaw.replace(JSON.stringify(fx.routerDbPath), JSON.stringify(returningDb)));

    clockMs = at;
    const tickRes = await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      harnessTargets: [],
      json: true,
    });
    expect(tickRes.detectionLatency).toEqual({
      measuredCount: 1,
      minMs: elapsed,
      maxMs: elapsed,
      p50Ms: elapsed,
    });

    const updatedCat = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
    expect(updatedCat.absenceDetections?.some((ep) => ep.modelId === oldAbandonedModel)).toBe(false);
    expect(updatedCat.providers.openai?.pendingEpisodes?.[oldAbandonedModel]).toBeUndefined();

    const returningEps = (updatedCat.absenceDetections ?? []).filter((ep) => ep.modelId === returningModel);
    expect(returningEps).toHaveLength(2);
    const freshEp = returningEps[1]!;
    expect(freshEp.episodeId).not.toBe(staleEpId);
    expect(freshEp.abandonedAt).toBeUndefined();
    expect(freshEp.detectionMs).toBe(elapsed);
    expect(updatedCat.providers.openai?.pendingEpisodes?.[returningModel]).toBe(freshEp.episodeId);
  }, 60_000);

  it('AC6-Rollback-Verify-Guard: unverified router or harness rollback NEVER reopens closed C48 removal episodes', async () => {
    const fx = createIsolatedTenModelPilotFixture('ac6-rollback-verify-guard-');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 70;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    await prepareDay0PilotToAutoSafe(fx, mockFetch);
    const postDay0HermesBak = `${fx.hermesConfigPath}.post-day0.bak`;
    fs.copyFileSync(fx.hermesConfigPath, postDay0HermesBak);

    activeModels = LIVE_NINE_MODELS;
    const firstAbsentAt = fx.baseMs + 40 * 60_000;
    for (const offset of [0, 20 * 60_000, 25 * 60 * 60_000]) {
      clockMs = firstAbsentAt + offset;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        mode: 'auto-safe',
        clock: () => clockMs,
        fetchFn: mockFetch,
        json: true,
      });
    }

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const readCat = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
    expect(readCat().absenceDetections?.[0]?.removedAt).toEqual(expect.any(String));
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBeUndefined();

    // 1. Router rollback verification failure: adapter.rollback returns true, post-rollback row digest mismatches snapshot
    const routerAutoSafeSnap = readApplyHistory(fx.stateDir).receipts.find(
      (r) => r.target === 'router:nine/rs-pilot' && r.appliedAtLevel === 'auto-safe' && !r.rolledBack
    )?.snapshotOrBackupRef;
    expect(routerAutoSafeSnap).toBeTruthy();

    const origCreate = adaptersMod.createAdapterForRouter.bind(adaptersMod);
    const createSpy = vi.spyOn(adaptersMod, 'createAdapterForRouter').mockImplementationOnce((routerCfg, sDir) => {
      const real = origCreate(routerCfg, sDir);
      vi.spyOn(real, 'rollback').mockResolvedValueOnce(true); // Leaves 9-model row in DB -> afterDigest !== beforeDigest!
      return real;
    });
    await runRollbackCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      snapshotId: routerAutoSafeSnap!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    createSpy.mockRestore();

    const routerRolledBackReceipt = readApplyHistory(fx.stateDir).receipts.find(
      (r) => r.target === 'router:nine/rs-pilot' && r.appliedAtLevel === 'auto-safe'
    );
    expect(routerRolledBackReceipt).toMatchObject({ rolledBack: true, rollbackVerified: false });
    expect(readCat().absenceDetections?.[0]?.removedAt).toEqual(expect.any(String));
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBeUndefined();

    // 2. Harness rollback verification failure (both byteIdenticalToPreApply mismatch AND tampered backup with matching expectedPreSha256)
    const harnessReceipt = readApplyHistory(fx.stateDir).receipts.find(
      (r) => r.target === 'harness:hermes' && r.appliedAtLevel === 'auto-safe' && !r.rolledBack
    );
    expect(harnessReceipt?.snapshotOrBackupRef).toBeTruthy();
    const tamperedBackupPath = harnessReceipt!.snapshotOrBackupRef;
    fs.writeFileSync(
      tamperedBackupPath,
      `${fs.readFileSync(postDay0HermesBak, 'utf8')}\n# tampered-backup-bytes\n`,
      'utf8'
    );
    const tamperedSha = sha256File(tamperedBackupPath);
    expect(tamperedSha).not.toBe(harnessReceipt!.preDigest);

    // 2a. Without expectedPreSha256 -> rejects before receipt/episode touch
    await expect(
      runAppsRollbackCommand({
        app: 'hermes',
        config: fx.hermesConfigPath,
        backup: tamperedBackupPath,
        stateDir: fx.stateDir,
        json: true,
      })
    ).rejects.toThrow('Rollback verification failed');
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('tampered-backup-bytes');
    expect(readCat().absenceDetections?.[0]?.removedAt).toEqual(expect.any(String));
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBeUndefined();

    // 2b. With expectedPreSha256 = tamperedSha -> adapter restores tampered bytes, receiptToVerify marks rollbackVerified: false,
    //     verifiedPivot === false blocks reconcileRolledBackRemovalEpisodes!
    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.hermesConfigPath,
      backup: tamperedBackupPath,
      expectedPreSha256: tamperedSha,
      stateDir: fx.stateDir,
      json: true,
    });
    const harnessAfter = readApplyHistory(fx.stateDir).receipts.find((r) => r.receiptId === harnessReceipt!.receiptId);
    expect(harnessAfter).toMatchObject({ rolledBack: true, rollbackVerified: false });
    expect(readCat().absenceDetections?.[0]?.removedAt).toEqual(expect.any(String));
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBeUndefined();

    process.exitCode = 0;
    const failedReport = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      unplannedInterventions: 0,
      nowMs: firstAbsentAt + 26 * 60 * 60_000,
      silent: true,
      json: true,
    });
    expect(failedReport.status).toBe('FAIL');
    expect(failedReport.blockingReasons.join('\n')).toContain('S9_CRITERION_2_FAILED');
  }, 60_000);

  it('AC6-Withdrawn-Chronology-And-Official-Forgery: rejects invalid withdrawal chronology, preserves slow planned withdrawn notices, and rejects forged official durations in pilot-report and apps apply', async () => {
    const fx = createIsolatedTenModelPilotFixture('ac6-withdrawn-forgery-');
    const now = fx.baseMs + 2 * 3_600_000;
    const start = now - 600_000;
    const pub = start - 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();

    const retiredModel = 'gpt-4o-legacy';
    const fullStep = `openai/${retiredModel}`;
    const ev = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: retiredModel,
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Genuine official deprecation notice for forgery & chronology checks.',
      publishedAt: iso(pub),
      shutdownDate: iso(start - 60_000),
      submittedAt: iso(start - 10_000),
      submittedVia: 'cli',
    });
    const evId = researchEvidenceIdentity(ev);

    // Seed standing consent + verified propose receipt for harness:hermes so auto-safe apps apply reaches readAppsRemovalProofs
    const liveNineShort = LIVE_NINE_MODELS.map((m) => m.split('/')[1]!);
    fs.writeFileSync(
      fx.hermesConfigPath,
      [
        'model:',
        '  provider: openai',
        '  default: openai/gpt-4.1',
        'providers:',
        '  openai:',
        '    base_url: https://api.openai.com/v1',
        '    api_key_env: OPENAI_API_KEY',
        '    models:',
        ...[...liveNineShort, retiredModel].map((m) => `      - ${m}`),
        '',
      ].join('\n'),
      'utf8'
    );
    upsertStandingConsentTarget(fx.stateDir, { target: 'harness:hermes', level: 'propose', nowMs: start - 5_000 });
    appendApplyReceipt(fx.stateDir, {
      target: 'harness:hermes',
      planHash: 'ac6-forgery-init',
      appliedAt: iso(start - 4_000),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: 'ac6-forgery-init.bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
    });
    upsertStandingConsentTarget(fx.stateDir, { target: 'harness:hermes', level: 'auto-safe', nowMs: start - 3_000 });

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const writeNoticeCatalog = (noticeOverride: Record<string, unknown>) => {
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          version: 1,
          updatedAt: iso(now - 1_000),
          providers: {
            openai: {
              prefix: 'openai',
              ids: liveNineShort,
              absenceCounts: { [retiredModel]: 1 },
              firstAbsentAt: { [retiredModel]: iso(start) },
              qualifyingScanTimestamps: [iso(start), iso(now - 1_000)],
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: iso(now - 1_000),
            },
          },
          absenceDetections: [],
          officialNoticeDetections: [
            {
              recordKey: JSON.stringify([fullStep, evId, iso(start)]),
              episodeStartedAt: iso(start),
              evidenceId: evId,
              provider: 'openai',
              modelId: retiredModel,
              fullStep,
              synthetic: false,
              sourcePublishedAt: iso(pub),
              firstQualifyingScanStartedAt: iso(start),
              firstPlanCreatedAt: iso(start + 90),
              detectionMs: 90,
              publicationToPlanMs: start + 90 - pub,
              targetsAffected: ['router:nine/rs-pilot', 'harness:hermes'],
              ...noticeOverride,
            },
          ],
        })
      );
    };

    const runReport = () =>
      runPilotReportCommand({
        stateDir: fx.stateDir,
        config: fx.configPath,
        routerTarget: 'router:nine/rs-pilot',
        harnessTarget: 'harness:hermes',
        nowMs: now,
        silent: true,
        json: true,
      });

    // 1. withdrawnAt === firstQualifyingScanStartedAt (withdrawn <= start) -> FAIL
    writeNoticeCatalog({
      firstPlanCreatedAt: null,
      detectionMs: null,
      publicationToPlanMs: null,
      withdrawnAt: iso(start),
    });
    const equalWithdrawal = await runReport();
    expect(equalWithdrawal.status).toBe('FAIL');
    expect(equalWithdrawal.blockingReasons.join('\n')).toContain('Invalid official notice withdrawal chronology');

    // 2. withdrawnAt > nowMs -> FAIL
    writeNoticeCatalog({
      firstPlanCreatedAt: null,
      detectionMs: null,
      publicationToPlanMs: null,
      withdrawnAt: iso(now + 1_000),
    });
    const futureWithdrawal = await runReport();
    expect(futureWithdrawal.status).toBe('FAIL');
    expect(futureWithdrawal.blockingReasons.join('\n')).toContain('TICK_CATALOG_CORRUPT');

    // 3. Slow planned notice (65_000ms) later withdrawn after plan -> MUST NOT be skipped, still FAILs Criterion 3!
    writeNoticeCatalog({
      firstPlanCreatedAt: iso(start + 65_000),
      detectionMs: 65_000,
      publicationToPlanMs: start + 65_000 - pub,
      withdrawnAt: iso(start + 70_000),
    });
    const slowWithdrawn = await runReport();
    expect(slowWithdrawn.status).toBe('FAIL');
    expect(slowWithdrawn.criteria.detectionLatencyMs.maxMs).toBe(65_000);
    expect(slowWithdrawn.blockingReasons.join('\n')).toContain('S9_CRITERION_3_FAILED');

    // 4. Forged detectionMs mismatch -> rejected by BOTH pilot-report and apps apply --write
    writeNoticeCatalog({
      firstPlanCreatedAt: iso(start + 65_000),
      detectionMs: 50,
      publicationToPlanMs: start + 65_000 - pub,
    });
    const forgedDetReport = await runReport();
    expect(forgedDetReport.status).toBe('FAIL');
    expect(forgedDetReport.blockingReasons.join('\n')).toContain('Invalid official notice detection duration');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: fx.hermesConfigPath,
          stateDir: fx.stateDir,
          home: fx.fakeHome,
          write: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow('C48_REMOVAL_INELIGIBLE');
    } finally {
      vi.useRealTimers();
    }

    // 5. Forged publicationToPlanMs mismatch -> rejected by BOTH pilot-report and apps apply --write
    writeNoticeCatalog({
      firstPlanCreatedAt: iso(start + 90),
      detectionMs: 90,
      publicationToPlanMs: 123,
    });
    const forgedPubReport = await runReport();
    expect(forgedPubReport.status).toBe('FAIL');
    expect(forgedPubReport.blockingReasons.join('\n')).toContain('Invalid official notice detection duration');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: fx.hermesConfigPath,
          stateDir: fx.stateDir,
          home: fx.fakeHome,
          write: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow('C48_REMOVAL_INELIGIBLE');
    } finally {
      vi.useRealTimers();
    }

    // 6. Forged non-null detectionMs on un-planned notice (firstPlanCreatedAt: null) -> rejected by pilot-report
    writeNoticeCatalog({
      firstPlanCreatedAt: null,
      detectionMs: 45,
      publicationToPlanMs: null,
    });
    const forgedNullPlanReport = await runReport();
    expect(forgedNullPlanReport.status).toBe('FAIL');
    expect(forgedNullPlanReport.blockingReasons.join('\n')).toContain('Invalid official notice detection duration');
  }, 60_000);
  it('P1-Probe6: shared [router,harness] episode stays open after auto-safe router removal until propose harness applies, rejects invalid/absent history closure, and preserves rollback reopen + anchor', async () => {
    const fx = createIsolatedTenModelPilotFixture('probe6-router-auto-harness-propose');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 70;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    await prepareDay0PilotToAutoSafe(fx, mockFetch);
    const postDay0HermesBak = `${fx.hermesConfigPath}.probe6-post-day0.bak`;
    fs.copyFileSync(fx.hermesConfigPath, postDay0HermesBak);
    const postDay0HermesSha = sha256File(fx.hermesConfigPath);

    // Keep router:nine/rs-pilot at auto-safe, downgrade harness:hermes to propose
    await runConsentGrantCommand({
      target: 'harness:hermes',
      level: 'propose',
      stateDir: fx.stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });

    activeModels = LIVE_NINE_MODELS;
    const firstAbsentAt = fx.baseMs + 40 * 60_000;
    for (const offset of [0, 20 * 60_000, 25 * 60 * 60_000]) {
      clockMs = firstAbsentAt + offset;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        homeDir: fx.fakeHome,
        mode: 'auto-safe',
        clock: () => clockMs,
        fetchFn: mockFetch,
        json: true,
      });
    }

    // Router auto-applied, while propose harness has NOT applied yet and still lists gpt-4o-legacy
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).toContain('gpt-4o-legacy');

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const readCat = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
    const readEp = () => readCat().absenceDetections?.[0];
    const epAnchorId = readEp()?.episodeId;
    expect(epAnchorId).toBeTruthy();
    expect(readEp()?.targetsAffected).toContain('harness:hermes');
    expect(readEp()?.targetsAffected).toContain('router:nine/rs-pilot');
    expect(readEp()?.scanStartedAt).toBe(new Date(firstAbsentAt).toISOString());
    expect(readEp()?.detectionMs).toBe(elapsed);
    // MUST remain open and pendingEpisodes intact for second target!
    expect(readEp()?.removedAt).toBeUndefined();
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBe(epAnchorId);

    // Target still listing model: even with an unrelated propose receipt on harness:hermes, episode stays open
    appendApplyReceipt(fx.stateDir, {
      target: 'harness:hermes',
      planHash: 'unrelated-addition-only-plan',
      appliedAt: new Date(firstAbsentAt + 25 * 60 * 60_000 + 1_000).toISOString(),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: postDay0HermesBak,
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
      removedModels: [],
    });
    clockMs = firstAbsentAt + 25 * 60 * 60_000 + 20 * 60_000;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      mode: 'propose',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(readEp()?.removedAt).toBeUndefined();
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBe(epAnchorId);

    // Absent or invalid apply-history must NEVER count as settled even if harnessTargets is omitted
    const historyFile = path.join(fx.stateDir, 'apply-history.json');
    const savedHistoryBytes = fs.readFileSync(historyFile);
    try {
      fs.unlinkSync(historyFile);
      clockMs += 20 * 60_000;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        harnessTargets: [],
        mode: 'propose',
        clock: () => clockMs,
        fetchFn: mockFetch,
        json: true,
      });
      expect(readEp()?.removedAt).toBeUndefined();

      fs.writeFileSync(historyFile, '{"version":1,"updatedAt":"bad","receipts":[],"hmacSha256":"00"}', 'utf8');
      clockMs += 20 * 60_000;
      await runTickCommand({
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        harnessTargets: [],
        mode: 'propose',
        clock: () => clockMs,
        fetchFn: mockFetch,
        json: true,
      });
      expect(readEp()?.removedAt).toBeUndefined();
    } finally {
      fs.writeFileSync(historyFile, savedHistoryBytes);
    }

    // Subsequent propose apply on second target (harness:hermes) MUST be accepted and close the episode!
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(clockMs + 5_000);
      await runAppsApplyCommand({
        app: 'hermes',
        config: fx.hermesConfigPath,
        backup: postDay0HermesBak,
        stateDir: fx.stateDir,
        home: fx.fakeHome,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');
    expect(readEp()?.removedAt).toEqual(expect.any(String));
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBeUndefined();

    // Verified rollback on harness:hermes reopens episode and restores pendingEpisodes while preserving anchor
    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.hermesConfigPath,
      backup: postDay0HermesBak,
      expectedPreSha256: postDay0HermesSha,
      stateDir: fx.stateDir,
      json: true,
    });
    expect(sha256File(fx.hermesConfigPath)).toBe(postDay0HermesSha);
    expect(readEp()?.removedAt).toBeUndefined();
    expect(readEp()?.scanStartedAt).toBe(new Date(firstAbsentAt).toISOString());
    expect(readEp()?.detectionMs).toBe(elapsed);
    expect(readCat().providers.openai?.pendingEpisodes?.['gpt-4o-legacy']).toBe(epAnchorId);
  }, 120_000);

  it('P2-Probe3c: rolled-back E1/K1 receipt followed by continuous actionable E2/K2 update and E2 reapply passes pilot-report without false INCOMPLETE while preserving sticky scan/plan latency', async () => {
    const fx = createIsolatedTenModelPilotFixture('probe3c-rollback-e1-update-e2-reapply');
    let activeModels = INITIAL_TEN_MODELS;
    let clockMs = fx.baseMs;
    const elapsed = 65;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.openai.com/v1/models') {
        clockMs += elapsed;
        return Response.json({ data: activeModels.map((id) => ({ id: id.split('/')[1]! })) });
      }
      if (url.includes('api.openai.com/v1/models/')) return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    await prepareDay0PilotToAutoSafe(fx, mockFetch);
    const postDay0HermesBak = `${fx.hermesConfigPath}.probe3c-post-day0.bak`;
    fs.copyFileSync(fx.hermesConfigPath, postDay0HermesBak);
    const postDay0HermesSha = sha256File(fx.hermesConfigPath);

    // Step 1: E1 official deprecation notice -> tick applies removal (R1 records E1/K1)
    const firstScan = fx.baseMs + 40 * 60_000;
    const ev1 = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'Initial official deprecation notice E1 for gpt-4o-legacy.',
      publishedAt: new Date(firstScan - 120_000).toISOString(),
      shutdownDate: new Date(firstScan - 60_000).toISOString(),
      submittedAt: new Date(firstScan - 10_000).toISOString(),
      submittedVia: 'cli',
    });
    const e1Id = researchEvidenceIdentity(ev1);

    activeModels = LIVE_NINE_MODELS;
    clockMs = firstScan;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');

    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const readCat = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as TickCatalogState;
    const k1Key = readCat().officialNoticeDetections?.[0]?.recordKey;
    expect(k1Key).toBeTruthy();
    expect(readCat().officialNoticeDetections?.[0]?.evidenceId).toBe(e1Id);

    // Step 2: Roll back BOTH router and harness receipts (E1/K1 remains in apply-history as rolledBack: true)
    const routerE1Snap = readApplyHistory(fx.stateDir)
      .receipts.filter((r) => r.target === 'router:nine/rs-pilot' && r.appliedAtLevel === 'auto-safe' && !r.rolledBack)
      .at(-1)?.snapshotOrBackupRef;
    expect(routerE1Snap).toBeTruthy();
    await runRollbackCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      snapshotId: routerE1Snap!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.hermesConfigPath,
      backup: postDay0HermesBak,
      expectedPreSha256: postDay0HermesSha,
      stateDir: fx.stateDir,
      json: true,
    });
    expect(fx.readComboRowModels()).toContain('openai/gpt-4o-legacy');
    expect(sha256File(fx.hermesConfigPath)).toBe(postDay0HermesSha);
    expect(readCat().officialNoticeDetections?.[0]?.removedAt).toBeUndefined();

    // Step 3: Actionable metadata follow-up E2 updates same continuous episode -> E2/K2 reapplied
    const secondScan = firstScan + 20 * 60_000;
    const ev2 = appendResearchEvidence(fx.stateDir, {
      provider: 'openai',
      modelId: 'gpt-4o-legacy',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations#gpt-4o-legacy-followup',
      quote: 'Follow-up official deprecation metadata update E2 with replacement.',
      publishedAt: new Date(secondScan - 30_000).toISOString(),
      shutdownDate: new Date(firstScan - 60_000).toISOString(),
      replacementModelId: 'gpt-4.1',
      submittedAt: new Date(secondScan - 5_000).toISOString(),
      submittedVia: 'cli',
    });
    const e2Id = researchEvidenceIdentity(ev2);
    expect(e2Id).not.toBe(e1Id);

    clockMs = secondScan;
    await runTickCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      mode: 'auto-safe',
      clock: () => clockMs,
      fetchFn: mockFetch,
      json: true,
    });
    expect(fx.readComboRowModels()).toEqual(LIVE_NINE_MODELS);
    expect(fs.readFileSync(fx.hermesConfigPath, 'utf8')).not.toContain('gpt-4o-legacy');

    const epAfterE2 = readCat().officialNoticeDetections?.[0];
    expect(epAfterE2?.evidenceId).toBe(e2Id);
    expect(epAfterE2?.recordKey).not.toBe(k1Key);
    expect(epAfterE2?.previousEvidenceIds).toEqual([e1Id]);
    expect(epAfterE2?.previousRecordKeys).toEqual([k1Key]);
    expect(epAfterE2?.firstQualifyingScanStartedAt).toBe(new Date(firstScan).toISOString());
    expect(epAfterE2?.firstPlanCreatedAt).toBe(new Date(firstScan + elapsed).toISOString());
    expect(epAfterE2?.detectionMs).toBe(elapsed);
    expect(epAfterE2?.removedAt).toEqual(expect.any(String));

    // Step 4: pilot-report MUST match BOTH rolled-back E1/K1 receipts and active E2/K2 receipts without false INCOMPLETE!
    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir: fx.stateDir,
      config: fx.configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      falseRemovals: 0,
      unplannedInterventions: 0,
      nowMs: secondScan + 10_000,
      silent: true,
      json: true,
    });
    expect(report.blockingReasons.join('\n')).not.toContain('S9_REMOVAL_DETECTION_INCOMPLETE');
    expect(report.status, report.blockingReasons.join('\n')).toBe('PASS');
    expect(report.passed).toBe(true);
    expect(report.criteria.rollbackByteExactMatch.passed).toBe(true);
    expect(report.criteria.rollbackByteExactMatch.verifiedReceiptsCount).toBeGreaterThanOrEqual(2);
    expect(report.criteria.detectionLatencyMs.maxMs).toBe(elapsed);
    expect(report.removalSettle.status).toBe('PASS');
  }, 120_000);
});
