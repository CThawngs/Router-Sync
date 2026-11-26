/**
 * packages/cli/test/c46-f2-live-gate-hint.test.ts
 *
 * Ticket C46-F2 (`Phục vụ: S9, I4, I5`) — Red-First TDD Suite:
 *  1. `live_gate_hint` (7th read-only check in `routersync live-check`)
 *  2. `assertHarnessWriteSandboxAllowed` unified with `assertControlledWriteSandbox`
 *     (`SANDBOX_OUTSIDE_TMPDIR` for any path outside `os.tmpdir()`, including paths outside `os.homedir()`)
 *  3. 3-Case `<repoRoot>/.tmp-f2-outside-<uuid>` Automated Verification:
 *     - Case 1: Outside `os.tmpdir()`, live flags unset -> `chưa đặt` + `SANDBOX_OUTSIDE_TMPDIR`
 *     - Case 2: Outside `os.tmpdir()`, live flags `=1` in `try/finally` -> `đã đặt` + write & rollback succeed
 *     - Case 3: Inside `os.tmpdir()`, live flags unset -> `trong os.tmpdir() — không cần cờ` + write & rollback succeed
 */

import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NINE_ROUTER_EXPECTED_APP_VERSION,
  appendTickCostEntry,
  getDefaultRestrictDir,
  isPathInsideDir,
  openBetterSqlite3,
  resolveDeepCanonicalPath,
  setDefaultRestrictDir,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { assertHarnessWriteSandboxAllowed } from '../src/apps/write-adapter.js';
import { runApplyCommand } from '../src/commands/apply.js';
import { runAppsApplyCommand, runAppsRollbackCommand } from '../src/commands/apps.js';
import { runLiveCheckCommand } from '../src/commands/live-check.js';
import { runRollbackCommand } from '../src/commands/rollback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const INITIAL_MODELS = [
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

const UPDATED_MODELS = [
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

interface SyntheticPilotEnv {
  rootDir: string;
  stateDir: string;
  fakeHome: string;
  routerDbPath: string;
  configPath: string;
  harnessConfigPath: string;
  catalogPath: string;
  nowMs: number;
}

function createSyntheticPilotAt(rootDir: string): SyntheticPilotEnv {
  const stateDir = path.join(rootDir, 'state');
  const fakeHome = path.join(rootDir, 'fake-home');
  const routerDir = path.join(rootDir, 'router');
  const harnessDir = path.join(rootDir, 'harness');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(routerDir, { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });

  const nowMs = Date.parse('2026-11-25T08:00:00.000Z');
  const nowIso = new Date(nowMs - 5 * 60_000).toISOString();
  const routerDbPath = path.join(routerDir, 'nine-pilot.sqlite');

  // Seed synthetic SQLite DB directly inside synthetic routerDir
  const db = openBetterSqlite3(routerDbPath, { restrictToDir: routerDir, allowLiveDbWrite: true });
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
  for (const fullId of INITIAL_MODELS) {
    const modId = fullId.split('/')[1]!;
    db.prepare('INSERT INTO models (id, provider, modelId, isActive) VALUES (?, ?, ?, 1)').run(
      fullId,
      'openai',
      modId
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
    'OpenAI Synthetic',
    null,
    1,
    1,
    JSON.stringify({
      apiKey: 'dummy-synthetic-openai-key',
      baseUrl: 'https://api.openai.com/v1',
      prefix: 'openai',
    }),
    nowIso,
    nowIso
  );
  db.prepare(
    'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('coding-main', 'coding-main', null, JSON.stringify(INITIAL_MODELS), nowIso, nowIso);
  db.close();

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
      'research:',
      '  maxWeeklyResearchSessions: 5',
      'combos:',
      '  - name: coding-main',
      '    routers:',
      '      - nine',
      '    size: 10',
      '    constraints:',
      '      freeOnly: false',
      '    pin:',
      ...UPDATED_MODELS.map((m) => `      - ${m}`),
      '    autoMaintain: true',
      'adopt:',
      '  - router: nine',
      '    name: coding-main',
      '    mode: full',
      '',
    ].join('\n'),
    'utf8'
  );

  // Hermes YAML with sibling .env key so `openai` is a keyed provider
  fs.writeFileSync(path.join(harnessDir, '.env'), 'OPENAI_API_KEY=dummy-hermes-key\n', 'utf8');
  const harnessConfigPath = path.join(harnessDir, 'config.yaml');
  fs.writeFileSync(
    harnessConfigPath,
    [
      '# Hermes synthetic config — keep comments intact',
      'model:',
      '  provider: openai',
      '  default: openai/gpt-4.1',
      'providers:',
      '  openai:',
      '    base_url: https://api.openai.com/v1',
      '    api_key_env: OPENAI_API_KEY',
      '    models:',
      '      - gpt-4.1',
      '      - gpt-4o-legacy',
      '',
    ].join('\n'),
    'utf8'
  );

  const catalogPath = path.join(rootDir, 'catalog.json');
  fs.writeFileSync(
    catalogPath,
    JSON.stringify(
      {
        openai: {
          liveModels: ['gpt-4.1', 'gpt-4.1-mini'],
          deprecatedModels: ['gpt-4o-legacy'],
        },
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'status.json'),
    `${JSON.stringify({ timestamp: nowIso, mode: 'observe', ok: true }, null, 2)}\n`,
    'utf8'
  );

  appendTickCostEntry(stateDir, {
    nowMs: nowMs - 5 * 60_000,
    mode: 'observe',
    totalHttpRequests: 1,
    domainRequests: { 'api.openai.com': 1 },
  });

  upsertStandingConsentTarget(stateDir, {
    target: 'router:nine/coding-main',
    level: 'propose',
    nowMs,
  });
  upsertStandingConsentTarget(stateDir, {
    target: 'harness:hermes',
    level: 'propose',
    nowMs,
  });

  return {
    rootDir,
    stateDir,
    fakeHome,
    routerDbPath,
    configPath,
    harnessConfigPath,
    catalogPath,
    nowMs,
  };
}

function readNineComboModels(dbPath: string, comboName: string): string[] {
  const db = openBetterSqlite3(dbPath, { readOnly: true, restrictToDir: path.dirname(dbPath) });
  try {
    const row = db
      .prepare('SELECT models FROM combos WHERE name = ? OR id = ?')
      .get(comboName, comboName) as { models: string } | undefined;
    return row ? (JSON.parse(row.models) as string[]) : [];
  } finally {
    db.close();
  }
}

describe('C46-F2: live_gate_hint & Unified Sandbox Write Guard (3-Case Suite)', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    process.exitCode = 0;
    delete process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'];
    delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ensures `<repoRoot>/.tmp-f2-outside-<uuid>` is genuinely outside `os.tmpdir()`,
   * even if QA checks out the repo inside `/tmp` (`os.tmpdir()`).
   */
  function ensureRepoOutsideTmpDir(): void {
    const canonRepo = resolveDeepCanonicalPath(REPO_ROOT);
    const canonTmp = resolveDeepCanonicalPath(os.tmpdir());
    if (isPathInsideDir(canonRepo, canonTmp)) {
      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-f2-subtmp-'));
      cleanupDirs.push(isolatedTmp);
      vi.stubEnv('TMPDIR', isolatedTmp);
      vi.stubEnv('TEMP', isolatedTmp);
      vi.stubEnv('TMP', isolatedTmp);
    }
  }

  it('Case 1 (Outside os.tmpdir(), flags unset): live_gate_hint reports "chưa đặt" for both vars & blocks writes with SANDBOX_OUTSIDE_TMPDIR', async () => {
    ensureRepoOutsideTmpDir();
    delete process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'];
    delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];

    const outsideDir = path.join(REPO_ROOT, `.tmp-f2-outside-${crypto.randomUUID()}`);
    const prevRestrict = getDefaultRestrictDir();
    try {
      fs.mkdirSync(outsideDir, { recursive: true });
      setDefaultRestrictDir(outsideDir);
      const fx = createSyntheticPilotAt(outsideDir);
      const envSnapshotBefore = { ...process.env };
      const preRouterSha = sha256File(fx.routerDbPath);
      const preHarnessSha = sha256File(fx.harnessConfigPath);

      const report = await runLiveCheckCommand({
        routerTarget: 'router:nine/coding-main',
        harnessTarget: 'harness:hermes',
        harnessConfigPath: fx.harnessConfigPath,
        configPath: fx.configPath,
        stateDir: fx.stateDir,
        homeDir: fx.fakeHome,
        repoRoot: REPO_ROOT,
        nowMs: fx.nowMs,
        silent: true,
      });

      // Must NOT mutate process.env and must pass Section 2 pre-flight (passed: true)
      expect(process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE']).toBeUndefined();
      expect(process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE']).toBeUndefined();
      expect(process.env).toEqual(envSnapshotBefore);
      expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');

      const gateHint = report.checks.find((c) => c.id === 'live_gate_hint');
      expect(gateHint).toBeDefined();
      expect(gateHint!.passed).toBe(true);
      expect(gateHint!.detail).toContain('ngoài os.tmpdir()');
      expect(gateHint!.detail).toContain('ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1');
      expect(gateHint!.detail).toContain('ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1');
      expect(gateHint!.detail.match(/chưa đặt/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(gateHint!.detail).not.toContain('đã đặt');
      expect(
        report.ownerNextCommands.some((cmd) => cmd.includes('ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1'))
      ).toBe(true);
      expect(
        report.ownerNextCommands.some((cmd) => cmd.includes('ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1'))
      ).toBe(true);

      // Direct write-adapter sandbox guard blocks non-homedir path outside os.tmpdir()
      expect(() => assertHarnessWriteSandboxAllowed(fx.harnessConfigPath)).toThrow(
        /SANDBOX_OUTSIDE_TMPDIR/
      );

      // Controlled router write blocked with SANDBOX_OUTSIDE_TMPDIR (0 bytes mutated)
      await expect(
        runApplyCommand({
          configPath: fx.configPath,
          stateDir: fx.stateDir,
          write: true,
          isTTY: true,
          promptFn: async () => 'chay',
          json: true,
        })
      ).rejects.toThrow(/SANDBOX_OUTSIDE_TMPDIR/);
      expect(sha256File(fx.routerDbPath)).toBe(preRouterSha);

      // Controlled harness write blocked with SANDBOX_OUTSIDE_TMPDIR (0 bytes mutated)
      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: fx.harnessConfigPath,
          catalog: fx.catalogPath,
          stateDir: fx.stateDir,
          write: true,
          isTTY: true,
          promptFn: async () => 'chay',
          json: true,
        })
      ).rejects.toThrow(/SANDBOX_OUTSIDE_TMPDIR/);
      expect(sha256File(fx.harnessConfigPath)).toBe(preHarnessSha);
    } finally {
      setDefaultRestrictDir(prevRestrict);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
    expect(fs.existsSync(outsideDir)).toBe(false);
  });

  it('Case 2 (Outside os.tmpdir(), flags =1 in try/finally): live_gate_hint reports "đã đặt" & controlled write + rollback succeed', async () => {
    ensureRepoOutsideTmpDir();
    const outsideDir = path.join(REPO_ROOT, `.tmp-f2-outside-${crypto.randomUUID()}`);
    const prevRestrict = getDefaultRestrictDir();

    try {
      fs.mkdirSync(outsideDir, { recursive: true });
      setDefaultRestrictDir(outsideDir);
      const fx = createSyntheticPilotAt(outsideDir);
      const preHarnessSha = sha256File(fx.harnessConfigPath);

      try {
        process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] = '1';
        process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'] = '1';

        const report = await runLiveCheckCommand({
          routerTarget: 'router:nine/coding-main',
          harnessTarget: 'harness:hermes',
          harnessConfigPath: fx.harnessConfigPath,
          configPath: fx.configPath,
          stateDir: fx.stateDir,
          homeDir: fx.fakeHome,
          repoRoot: REPO_ROOT,
          nowMs: fx.nowMs,
          silent: true,
        });

        expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
        const gateHint = report.checks.find((c) => c.id === 'live_gate_hint');
        expect(gateHint).toBeDefined();
        expect(gateHint!.passed).toBe(true);
        expect(gateHint!.detail).toContain('ngoài os.tmpdir()');
        expect(gateHint!.detail.match(/đã đặt/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
        expect(gateHint!.detail).not.toContain('chưa đặt');

        // 1. Controlled router write + rollback on synthetic file inside .tmp-f2-outside-*
        const routerReport = await runApplyCommand({
          configPath: fx.configPath,
          stateDir: fx.stateDir,
          write: true,
          isTTY: true,
          promptFn: async () => 'chay',
          json: true,
        });
        expect(routerReport.status).toBe('SUCCESS');
        expect(readNineComboModels(fx.routerDbPath, 'coding-main')).toEqual(UPDATED_MODELS);

        const snapId = routerReport.snapshots?.[0]?.snapshotId;
        expect(snapId).toBeTruthy();
        await runRollbackCommand({
          configPath: fx.configPath,
          stateDir: fx.stateDir,
          snapshotId: snapId,
          write: true,
          isTTY: true,
          promptFn: async () => 'chay',
          json: true,
        });
        expect(readNineComboModels(fx.routerDbPath, 'coding-main')).toEqual(INITIAL_MODELS);

        // 2. Controlled harness write + byte-exact rollback on synthetic file inside .tmp-f2-outside-*
        await runAppsApplyCommand({
          app: 'hermes',
          config: fx.harnessConfigPath,
          catalog: fx.catalogPath,
          stateDir: fx.stateDir,
          write: true,
          isTTY: true,
          promptFn: async () => 'chay',
          json: true,
        });
        const updatedYaml = fs.readFileSync(fx.harnessConfigPath, 'utf8');
        expect(updatedYaml).toContain('gpt-4.1-mini');
        expect(updatedYaml).not.toContain('gpt-4o-legacy');

        await runAppsRollbackCommand({
          app: 'hermes',
          config: fx.harnessConfigPath,
          stateDir: fx.stateDir,
          json: true,
        });
        expect(sha256File(fx.harnessConfigPath)).toBe(preHarnessSha);
      } finally {
        delete process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'];
        delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];
      }
    } finally {
      setDefaultRestrictDir(prevRestrict);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
    expect(fs.existsSync(outsideDir)).toBe(false);
  });

  it('C47: a flagged CLI child still refuses noninteractive propose, missing consent and protected files', () => {
    ensureRepoOutsideTmpDir();
    const root = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-c47-approval-'));
    cleanupDirs.push(root);
    expect(
      isPathInsideDir(resolveDeepCanonicalPath(root), resolveDeepCanonicalPath(os.tmpdir()))
    ).toBe(false);

    const previousRestriction = getDefaultRestrictDir();
    setDefaultRestrictDir(root);
    try {
      const fixture = createSyntheticPilotAt(root);
      upsertStandingConsentTarget(fixture.stateDir, { target: 'harness:hermes', level: 'propose' });
      const harnessBytes = fs.readFileSync(fixture.harnessConfigPath);
      const catalog = fixture.catalogPath;
      const noConsentState = path.join(root, 'no-consent');
      fs.mkdirSync(noConsentState);
      const run = (config: string, stateDir: string, expected: RegExp) => {
        const result = spawnSync(process.execPath, [
          path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js'),
          'apps', 'apply', '--app', 'hermes', '--config', config, '--home', fixture.fakeHome,
          '--catalog', catalog, '--state-dir', stateDir, '--write', '--json',
        ], {
          cwd: root,
          env: { ...process.env, ROUTERSYNC_ALLOW_LIVE_HOME_WRITE: '1' },
          input: '',
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(expected);
        expect(fs.existsSync(`${config}.routersync.bak`)).toBe(false);
      };

      run(fixture.harnessConfigPath, fixture.stateDir, /TTY_REQUIRED/);
      run(fixture.harnessConfigPath, noConsentState, /CONSENT_REQUIRED/);
      expect(fs.readFileSync(fixture.harnessConfigPath)).toEqual(harnessBytes);

      for (const name of ['bots.json', 'routines.json']) {
        const protectedFixture = path.join(path.dirname(fixture.harnessConfigPath), name);
        fs.writeFileSync(protectedFixture, '{}\n');
        run(protectedFixture, fixture.stateDir, /OpenMausBot safety guard/);
        expect(fs.readFileSync(protectedFixture, 'utf8')).toBe('{}\n');
      }
    } finally {
      setDefaultRestrictDir(previousRestriction);
    }
  }, 60_000);

  it('Case 3 (Inside os.tmpdir(), flags unset): live_gate_hint reports inside os.tmpdir() & controlled write + rollback succeed without flags', async () => {
    delete process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'];
    delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];

    const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-f2-inside-'));
    cleanupDirs.push(insideDir);

    const fx = createSyntheticPilotAt(insideDir);
    const preHarnessSha = sha256File(fx.harnessConfigPath);

    const report = await runLiveCheckCommand({
      routerTarget: 'router:nine/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });

    expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    const gateHint = report.checks.find((c) => c.id === 'live_gate_hint');
    expect(gateHint).toBeDefined();
    expect(gateHint!.passed).toBe(true);
    expect(gateHint!.detail).toContain('trong os.tmpdir() — không cần cờ');
    expect(gateHint!.detail).not.toContain('chưa đặt');

    // Controlled router write + rollback succeeds without live flags
    const routerReport = await runApplyCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(routerReport.status).toBe('SUCCESS');
    expect(readNineComboModels(fx.routerDbPath, 'coding-main')).toEqual(UPDATED_MODELS);

    const snapId = routerReport.snapshots?.[0]?.snapshotId;
    expect(snapId).toBeTruthy();
    await runRollbackCommand({
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      snapshotId: snapId,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(readNineComboModels(fx.routerDbPath, 'coding-main')).toEqual(INITIAL_MODELS);

    // Controlled harness write + byte-exact rollback succeeds without live flags
    await runAppsApplyCommand({
      app: 'hermes',
      config: fx.harnessConfigPath,
      catalog: fx.catalogPath,
      stateDir: fx.stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(fs.readFileSync(fx.harnessConfigPath, 'utf8')).toContain('gpt-4.1-mini');

    await runAppsRollbackCommand({
      app: 'hermes',
      config: fx.harnessConfigPath,
      stateDir: fx.stateDir,
      json: true,
    });
    expect(sha256File(fx.harnessConfigPath)).toBe(preHarnessSha);
  });
});
