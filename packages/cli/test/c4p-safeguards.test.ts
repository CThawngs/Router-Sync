/**
 * packages/cli/test/c4p-safeguards.test.ts
 *
 * Comprehensive hermetic tests for rounds C4p & C4q:
 * - P1 / Q3 / Q4: Unified DB path resolution across Core, CLI, Daemon, and MCP
 *   (`firstNonEmpty`, `resolveConfiguredDbPaths`, platform defaults, daemon vs CLI parity)
 * - P2 / Q2: Incomplete pagination & blocked redirect handling in `providers.ts` and `tick.ts`
 *   with pre-seeded `tick-catalog.json` baselines (`ids`, `absenceCounts`, `firstAbsentAt`)
 * - P3: Strict numeric validation for `--max-shrink-ratio`, `--grace-cycles`, `--interval-minutes`
 * - P4: Default autonomy mode `'propose'`
 * - P5: Doctor `configError` tracking and `ready: false` status
 * - P6: 7-layer safe GET transport guards across `fetchModelList` and `fetchModelEntries`
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { openBetterSqlite3 } from '@routersync/core';
import {
  locateRouterDb as locateCoreRouterDb,
  setConfiguredRouterDbPaths,
  clearConfiguredRouterDbPaths,
  firstNonEmpty,
  resolveConfiguredDbPaths,
} from '@routersync/core/readonly';
import {
  locateRouterDb as locateDaemonRouterDb,
  readRouterCombos,
} from '@routersync/daemon';
import {
  fetchModelList,
  fetchModelEntries,
  detectNextPage,
  readBodyCapped,
  SCAN_MAX_BYTES_PER_PAGE,
  SCAN_MAX_MODELS,
  SCAN_MAX_PAGES,
  type ProviderTarget,
} from '../src/sync/providers.js';
import {
  resolveAutonomyMode,
  validateGraceCycles,
  validateMaxShrinkRatio,
  runTickCommand,
} from '../src/commands/tick.js';
import {
  validateIntervalMinutes,
  buildTickScheduleArtifacts,
} from '../src/commands/schedule.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import {
  loadConfigFile,
  clearInstalledRouterDbPaths,
} from '../src/config/loader.js';
import { buildViews } from '../src/commands/sync/sync-plan.js';
import { RouterSyncConfigSchema } from '../src/config/schema.js';

const HERMETIC_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'ROUTERSYNC_CONFIG',
  'ROUTERSYNC_STATE_DIR',
  'ROUTERSYNC_SYNC_STATE_DIR',
  'ROUTERSYNC_OMNIROUTE_DB',
  'ROUTERSYNC_9ROUTER_DB',
  'OMNIROUTE_DB_PATH',
  'NINEROUTER_DB_PATH',
  'NINE_ROUTER_DB_PATH',
  'DATA_DIR',
] as const;

function makeFakeTarget(overrides: Partial<ProviderTarget> = {}): ProviderTarget {
  return {
    id: 'fake-prov',
    label: 'Fake Provider',
    prefix: 'fake-prov',
    baseUrl: 'https://api.fake-prov.example/v1',
    apiKey: 'sk-fake-secret',
    keySource: '9router-key',
    ...overrides,
  };
}

function createFake9RouterDbWithProvider(dbFile: string): void {
  const db = openBetterSqlite3(dbFile, { readOnly: false, restrictToDir: path.dirname(dbFile) });
  db.exec(
    'CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT)'
  );
  db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT)');
  db.exec(
    'CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT)'
  );
  db.exec('CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT)');

  const nowIso = '2026-11-14T00:00:00.000Z';
  db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(
    JSON.stringify({ comboStrategies: { 'rs-coder': 'priority' } })
  );
  db.prepare(
    'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    'routersync-rs-coder',
    'rs-coder',
    'custom',
    JSON.stringify(['fake-prov/model-a', 'fake-prov/model-b']),
    nowIso,
    nowIso
  );
  db.prepare(
    'INSERT INTO providerConnections (id, provider, name, authType, isActive, data) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    'conn-fake-prov',
    'fake-prov',
    'Fake Provider',
    'apikey',
    1,
    JSON.stringify({
      apiKey: 'sk-fake-secret',
      baseUrl: 'https://api.fake-prov.example/v1',
      prefix: 'fake-prov',
    })
  );
  db.close();
}

function createFakeOmniRouteDb(dbFile: string, comboName: string, models: string[]): void {
  const db = openBetterSqlite3(dbFile, { readOnly: false, restrictToDir: path.dirname(dbFile) });
  db.exec(
    'CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT, created_at TEXT, updated_at TEXT, sort_order INTEGER, system_message TEXT)'
  );
  db.exec(
    'CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT)'
  );
  db.exec(
    'CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, prefix TEXT, base_url TEXT)'
  );
  const nowIso = '2026-11-14T00:00:00.000Z';
  db.prepare(
    'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    `routersync-${comboName}`,
    comboName,
    JSON.stringify({ strategy: 'priority', models, managed: true }),
    nowIso,
    nowIso,
    0,
    null
  );
  db.prepare(
    'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'conn-fake-prov',
    'fake-prov',
    'Fake Provider',
    'apikey',
    1,
    'sk-fake-omni',
    JSON.stringify({
      baseUrl: 'https://api.fake-prov.example/v1',
      prefix: 'fake-prov',
    })
  );
  db.close();
}

interface SeededTickEnv {
  configPath: string;
  stateDir: string;
  catalogPath: string;
  inboxPath: string;
  nowMs: number;
  seededProvider: {
    prefix: string;
    router: string;
    contentHash: string;
    serverEtag: string | null;
    hash: string;
    ids: string[];
    absenceCounts: Record<string, number>;
    firstAbsentAt: Record<string, string>;
    consecutiveFailures: number;
    backoffUntilMs: number;
    lastStatus: number;
    lastLabel: string;
    updatedAt: string;
  };
}

function setupHermeticTickWithBaseline(baseDir: string): SeededTickEnv {
  const dbFile = path.join(baseDir, 'fake-9router.sqlite');
  createFake9RouterDbWithProvider(dbFile);

  const configPath = path.join(baseDir, 'config.yaml');
  const yaml = [
    'version: 1',
    'routers:',
    '  - id: nine',
    '    adapter: 9router',
    '    db:',
    `      path: ${dbFile.replace(/\\/g, '/')}`,
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
    '    size: 2',
    'adopt: []',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, yaml, 'utf8');

  const stateDir = path.join(baseDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const catalogPath = path.join(stateDir, 'tick-catalog.json');
  const inboxPath = path.join(stateDir, 'inbox.json');

  // Seed baseline more than 1 hour before nowMs so minScanIntervalMs freshness gate does not skip.
  const seededUpdatedAt = '2026-11-14T10:00:00.000Z';
  const nowMs = Date.parse('2026-11-14T12:00:00.000Z');
  const seededProvider = {
    prefix: 'fake-prov',
    router: '9router',
    contentHash: 'seeded-hash-abc123',
    serverEtag: '"etag-seeded-1"',
    hash: 'seeded-hash-abc123',
    ids: ['model-a', 'model-b'],
    absenceCounts: { 'model-b': 1 },
    firstAbsentAt: { 'model-b': '2026-11-14T09:45:00.000Z' },
    consecutiveFailures: 0,
    backoffUntilMs: 0,
    lastStatus: 200,
    lastLabel: 'OK',
    updatedAt: seededUpdatedAt,
  };

  fs.writeFileSync(
    catalogPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: seededUpdatedAt,
        providers: {
          'fake-prov': seededProvider,
        },
      },
      null,
      2
    ),
    'utf8'
  );

  return { configPath, stateDir, catalogPath, inboxPath, nowMs, seededProvider };
}

describe('Round C4p & C4q Hermetic Safeguards & Verifications', () => {
  let hermeticRoot = '';
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of HERMETIC_ENV_KEYS) {
      savedEnv.set(k, process.env[k]);
    }
    hermeticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c4q-hermetic-'));
    const homeDir = path.join(hermeticRoot, 'home');
    const appDataDir = path.join(hermeticRoot, 'appdata');
    const xdgDir = path.join(hermeticRoot, 'xdg');
    const stateDir = path.join(hermeticRoot, 'state');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.mkdirSync(xdgDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    process.env['HOME'] = homeDir;
    process.env['USERPROFILE'] = homeDir;
    process.env['APPDATA'] = appDataDir;
    process.env['XDG_CONFIG_HOME'] = xdgDir;
    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;

    delete process.env['ROUTERSYNC_CONFIG'];
    delete process.env['ROUTERSYNC_OMNIROUTE_DB'];
    delete process.env['ROUTERSYNC_9ROUTER_DB'];
    delete process.env['OMNIROUTE_DB_PATH'];
    delete process.env['NINEROUTER_DB_PATH'];
    delete process.env['NINE_ROUTER_DB_PATH'];
    delete process.env['DATA_DIR'];

    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
  });

  afterEach(() => {
    clearInstalledRouterDbPaths();
    clearConfiguredRouterDbPaths();
    vi.restoreAllMocks();
    for (const k of HERMETIC_ENV_KEYS) {
      const prev = savedEnv.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    try {
      fs.rmSync(hermeticRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  describe('P1, Q3 & Q4: Daemon / CLI / MCP DB Resolution Parity & Path Priority', () => {
    it('shares locateRouterDb implementation across core and daemon', () => {
      expect(locateDaemonRouterDb).toBe(locateCoreRouterDb);
    });

    it('prioritizes config-installed path over environment variables and platform default', () => {
      const mockEnv = {
        ROUTERSYNC_OMNIROUTE_DB: '/env/omni.sqlite',
        OMNIROUTE_DB_PATH: '/legacy/omni.sqlite',
      };
      setConfiguredRouterDbPaths({ omniroute: '/config/omni.sqlite' }, { source: 'config' });
      expect(locateCoreRouterDb('omniroute', mockEnv)).toBe(path.resolve('/config/omni.sqlite'));
    });

    it('prioritizes ROUTERSYNC_* env over legacy env aliases', () => {
      const mockEnv = {
        ROUTERSYNC_OMNIROUTE_DB: '/env/omni.sqlite',
        OMNIROUTE_DB_PATH: '/legacy/omni.sqlite',
        ROUTERSYNC_9ROUTER_DB: '/env/nine.sqlite',
        NINEROUTER_DB_PATH: '/legacy/nine.sqlite',
      };
      expect(locateCoreRouterDb('omniroute', mockEnv)).toBe(path.resolve('/env/omni.sqlite'));
      expect(locateCoreRouterDb('9router', mockEnv)).toBe(path.resolve('/env/nine.sqlite'));
    });

    it('falls back to legacy env aliases when ROUTERSYNC_* is not set', () => {
      const mockEnv = {
        OMNIROUTE_DB_PATH: '/legacy/omni.sqlite',
        NINEROUTER_DB_PATH: '/legacy/nine.sqlite',
      };
      expect(locateCoreRouterDb('omniroute', mockEnv)).toBe(path.resolve('/legacy/omni.sqlite'));
      expect(locateCoreRouterDb('9router', mockEnv)).toBe(path.resolve('/legacy/nine.sqlite'));
    });

    it('Q4: firstNonEmpty falls back to NINE_ROUTER_DB_PATH when NINEROUTER_DB_PATH is empty or whitespace', () => {
      expect(firstNonEmpty('', '   ', ' /valid/path ')).toBe('/valid/path');
      expect(firstNonEmpty('', '   ')).toBeUndefined();

      const emptyFirstEnv = {
        NINEROUTER_DB_PATH: '',
        NINE_ROUTER_DB_PATH: '/fallback/nine.sqlite',
      };
      expect(locateCoreRouterDb('9router', emptyFirstEnv)).toBe(
        path.resolve('/fallback/nine.sqlite')
      );

      const whitespaceFirstEnv = {
        NINEROUTER_DB_PATH: '   ',
        NINE_ROUTER_DB_PATH: '/fallback-ws/nine.sqlite',
      };
      expect(locateCoreRouterDb('9router', whitespaceFirstEnv)).toBe(
        path.resolve('/fallback-ws/nine.sqlite')
      );
    });

    it('enforces that config source beats daemon source in setConfiguredRouterDbPaths (depends on hermetic env clearing)', () => {
      // Note (Q3): Because `source: 'daemon'` has lower precedence than env overrides
      // (`ROUTERSYNC_OMNIROUTE_DB` / `OMNIROUTE_DB_PATH`), this test relies on `beforeEach`
      // clearing those env vars so `locateCoreRouterDb('omniroute')` reaches the daemon entry.
      setConfiguredRouterDbPaths({ omniroute: '/from/config.sqlite' }, { source: 'config' });
      setConfiguredRouterDbPaths({ omniroute: '/from/daemon.sqlite' }, { source: 'daemon' });
      expect(locateCoreRouterDb('omniroute')).toBe(path.resolve('/from/config.sqlite'));

      clearConfiguredRouterDbPaths();
      setConfiguredRouterDbPaths({ omniroute: '/from/daemon.sqlite' }, { source: 'daemon' });
      expect(locateCoreRouterDb('omniroute')).toBe(path.resolve('/from/daemon.sqlite'));
      setConfiguredRouterDbPaths({ omniroute: '/from/config.sqlite' }, { source: 'config' });
      expect(locateCoreRouterDb('omniroute')).toBe(path.resolve('/from/config.sqlite'));
    });

    it('Q3: resolves platform default paths deterministically across win32, darwin, and linux', () => {
      const mockEnv = {
        HOME: '/mock/home',
        USERPROFILE: 'C:\\MockUsers\\Alice',
        APPDATA: 'C:\\MockUsers\\Alice\\AppData\\Roaming',
      };

      expect(locateCoreRouterDb('omniroute', mockEnv, 'linux')).toBe(
        path.resolve(path.join('/mock/home', '.omniroute', 'storage.sqlite'))
      );
      expect(locateCoreRouterDb('9router', mockEnv, 'darwin')).toBe(
        path.resolve(path.join('/mock/home', '.9router', 'db', 'data.sqlite'))
      );
      expect(locateCoreRouterDb('9router', mockEnv, 'linux')).toBe(
        path.resolve(path.join('/mock/home', '.9router', 'db', 'data.sqlite'))
      );
      expect(locateCoreRouterDb('9router', mockEnv, 'win32')).toBe(
        path.resolve(path.join('C:\\MockUsers\\Alice\\AppData\\Roaming', '9router', 'db', 'data.sqlite'))
      );
    });

    it('Q3: daemon readRouterCombos and CLI buildViews read the exact same OmniRoute DB when only ROUTERSYNC_OMNIROUTE_DB is set', async () => {
      const omniDbFile = path.join(hermeticRoot, 'parity-omni.sqlite');
      createFakeOmniRouteDb(omniDbFile, 'rs-omni-parity', [
        'fake-prov/model-1',
        'fake-prov/model-2',
      ]);

      process.env['ROUTERSYNC_OMNIROUTE_DB'] = omniDbFile;

      const daemonResult = readRouterCombos('omniroute');
      expect(daemonResult.ok).toBe(true);
      expect(daemonResult.dbPath).toBe(path.resolve(omniDbFile));
      expect(daemonResult.data?.map((c) => c.name)).toEqual(['rs-omni-parity']);
      expect(daemonResult.data?.[0]?.models).toEqual(['fake-prov/model-1', 'fake-prov/model-2']);

      const cliConfig = RouterSyncConfigSchema.parse({
        version: 1,
        routers: [
          {
            id: 'omni',
            adapter: 'omniroute',
            write: 'db',
          },
        ],
        policy: {
          mode: 'manual',
        },
        combos: [
          {
            name: 'rs-omni-parity',
            role: 'coding',
            routers: ['omni'],
            size: 2,
          },
        ],
        adopt: [],
      });

      const views = await buildViews(cliConfig, 'omniroute');
      expect(views).toHaveLength(1);
      expect(views[0]?.dbPath).toBe(daemonResult.dbPath);
      expect(views[0]?.combos.map((c) => c.name)).toEqual(['rs-omni-parity']);
      expect(views[0]?.combos[0]?.steps).toEqual(daemonResult.data?.[0]?.models);
    });

    it('Q4: CLI loadConfigFile and MCP server resolve relative routers[].db.path against configDir identically', async () => {
      const nestedConfigDir = path.join(hermeticRoot, 'nested', 'cfg-dir');
      fs.mkdirSync(nestedConfigDir, { recursive: true });
      const expectedDbPath = path.join(nestedConfigDir, 'sub', 'rel-nine.sqlite');
      fs.mkdirSync(path.dirname(expectedDbPath), { recursive: true });
      createFake9RouterDbWithProvider(expectedDbPath);

      const configPath = path.join(nestedConfigDir, 'config.yaml');
      const yaml = [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    db:',
        '      path: ./sub/rel-nine.sqlite',
        '    write: db',
        'policy:',
        '  mode: manual',
        'combos: []',
        'adopt: []',
        '',
      ].join('\n');
      fs.writeFileSync(configPath, yaml, 'utf8');

      // 1. Direct shared helper check
      const direct = resolveConfiguredDbPaths(
        { routers: [{ adapter: '9router', db: { path: './sub/rel-nine.sqlite' } }] },
        nestedConfigDir
      );
      expect(direct.paths['9router']).toBe(path.resolve(expectedDbPath));

      // 2. CLI loadConfigFile resolution
      clearInstalledRouterDbPaths();
      clearConfiguredRouterDbPaths();
      loadConfigFile(configPath);
      const cliResolved = locateCoreRouterDb('9router');
      expect(cliResolved).toBe(path.resolve(expectedDbPath));

      // 3. MCP server path resolution via direct helper and server startup simulation
      clearInstalledRouterDbPaths();
      clearConfiguredRouterDbPaths();
      const rawYaml = fs.readFileSync(configPath, 'utf8');
      const { parse: parseYaml } = await import('yaml');
      const parsed = parseYaml(rawYaml);
      const mcpResult = resolveConfiguredDbPaths(parsed, path.dirname(path.resolve(configPath)));
      setConfiguredRouterDbPaths(mcpResult.paths, { source: 'config' });
      const mcpResolved = locateCoreRouterDb('9router');
      expect(mcpResolved).toBe(path.resolve(expectedDbPath));
      expect(mcpResolved).toBe(cliResolved);
    });
  });

  describe('P2, Q2 & P6: Incomplete Scan Safeguards, Baseline Preservation & 7-Layer Safe GET', () => {
    it('P6 Layer 1 & 2 & 3: blocks cross-origin and forbidden-inference redirects in fetchModelList and fetchModelEntries', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('manual');
        if (url === 'https://api.fake-prov.example/v1/models') {
          return new Response(null, {
            status: 302,
            headers: { Location: '/v1/chat/completions' },
          });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const target = makeFakeTarget();

      const listRes = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });
      expect(listRes.ok).toBe(false);
      expect(listRes.incomplete).toBe(false);
      expect(listRes.skipReason).toBe('redirect-blocked');
      expect(listRes.error).toContain('forbidden inference path');

      const entriesRes = await fetchModelEntries(target, { fetchFn: mockFetch });
      expect(entriesRes.ok).toBe(false);
      expect(entriesRes.error).toContain('forbidden inference path');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('P6 Layer 4 & 6: aborts fetchModelEntries on content-length > 10 MiB and joins relative next URLs in fetchModelList', async () => {
      const mockLargeHeaderFetch = vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(SCAN_MAX_BYTES_PER_PAGE + 500) },
        })
      );

      const target = makeFakeTarget();
      const result = await fetchModelEntries(target, { fetchFn: mockLargeHeaderFetch });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('payload-too-large');

      let callCount = 0;
      const mockRelativeNextFetch = vi.fn().mockImplementation(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          expect(url).toBe('https://api.fake-prov.example/v1/models');
          return new Response(
            JSON.stringify({
              data: [{ id: 'model-1' }],
              next_url: '/v1/models?page=2',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        expect(url).toBe('https://api.fake-prov.example/v1/models?page=2');
        return new Response(JSON.stringify({ data: [{ id: 'model-2' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const listOut = await fetchModelList(target, {
        fetchFn: mockRelativeNextFetch,
        retryDelaysMs: [],
      });
      expect(listOut.ok).toBe(true);
      expect(listOut.models).toEqual(['model-1', 'model-2']);
      expect(listOut.incomplete).toBe(false);
    });

    it('P6 Layer 7: enforces SCAN_MAX_PAGES ceiling and marks scan incomplete when more pages remain', async () => {
      let page = 0;
      const mockManyPagesFetch = vi.fn().mockImplementation(async () => {
        page++;
        return new Response(
          JSON.stringify({
            data: [{ id: `model-p${page}` }],
            next: `https://api.fake-prov.example/v1/models?page=${page + 1}`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const out = await fetchModelList(makeFakeTarget(), {
        fetchFn: mockManyPagesFetch,
        retryDelaysMs: [],
      });
      expect(out.pages).toBe(SCAN_MAX_PAGES);
      expect(out.incomplete).toBe(true);
      expect(out.skipReason).toBe('incomplete-pagination');
    });

    it('Q2(a): has_more: true without cursor sets signalWithoutCursor, marks tick TRANSIENT/INCOMPLETE-PAGINATION, and preserves seeded baseline', async () => {
      const nextInfo = detectNextPage({ data: [{ id: 'model-a' }], has_more: true });
      expect(nextInfo.url).toBe('');
      expect(nextInfo.signalWithoutCursor).toBe(true);

      const env = setupHermeticTickWithBaseline(hermeticRoot);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: 'model-a' }, { id: 'unexpected-new-model' }],
            has_more: true, // missing cursor!
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const summary = await runTickCommand({
        configPath: env.configPath,
        stateDir: env.stateDir,
        nowMs: env.nowMs,
        fetchFn: mockFetch,
        mode: 'propose',
      });

      const provSummary = summary.providers.find((p) => p.prefix === 'fake-prov');
      expect(provSummary).toBeDefined();
      expect(provSummary?.label).toBe('TRANSIENT');
      expect(provSummary?.skipReason).toBe('incomplete-pagination');

      const afterCatalog = JSON.parse(fs.readFileSync(env.catalogPath, 'utf8'));
      const afterProv = afterCatalog.providers['fake-prov'];
      expect(afterProv.ids).toEqual(env.seededProvider.ids);
      expect(afterProv.absenceCounts).toEqual(env.seededProvider.absenceCounts);
      expect(afterProv.firstAbsentAt).toEqual(env.seededProvider.firstAbsentAt);
      expect(afterProv.lastLabel).toBe('TRANSIENT');
      expect(afterProv.skipReason).toBe('incomplete-pagination');

      if (fs.existsSync(env.inboxPath)) {
        const inboxRaw = JSON.parse(fs.readFileSync(env.inboxPath, 'utf8'));
        const items = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw.items ?? []);
        const bad = items.filter(
          (i: { label?: string }) =>
            i.label === 'NEW-CANDIDATE' || (typeof i.label === 'string' && i.label.startsWith('ABSENT-'))
        );
        expect(bad).toHaveLength(0);
      }
    });

    it('Q2(b): detectNextPage discarding a FORBIDDEN_INFERENCE_PATH_PATTERN URL sets forbiddenDiscarded, marks tick TRANSIENT/INCOMPLETE-PAGINATION, and preserves seeded baseline', async () => {
      const nextInfo = detectNextPage({
        data: [{ id: 'model-a' }],
        next: 'https://api.fake-prov.example/v1/chat/completions?page=2',
      });
      expect(nextInfo.url).toBeNull();
      expect(nextInfo.forbiddenDiscarded).toBe(true);

      const env = setupHermeticTickWithBaseline(hermeticRoot);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: 'model-a' }, { id: 'unexpected-new-model' }],
            next: 'https://api.fake-prov.example/v1/chat/completions?page=2',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const summary = await runTickCommand({
        configPath: env.configPath,
        stateDir: env.stateDir,
        nowMs: env.nowMs,
        fetchFn: mockFetch,
        mode: 'propose',
      });

      // L1 scan for fake-prov fetched once and stopped because detectNextPage discarded the forbidden URL
      const l1Calls = mockFetch.mock.calls.filter(([url]) =>
        String(url).includes('api.fake-prov.example')
      );
      expect(l1Calls.length).toBe(1);
      const provSummary = summary.providers.find((p) => p.prefix === 'fake-prov');
      expect(provSummary?.label).toBe('TRANSIENT');
      expect(provSummary?.skipReason).toBe('incomplete-pagination');

      const afterCatalog = JSON.parse(fs.readFileSync(env.catalogPath, 'utf8'));
      const afterProv = afterCatalog.providers['fake-prov'];
      expect(afterProv.ids).toEqual(env.seededProvider.ids);
      expect(afterProv.absenceCounts).toEqual(env.seededProvider.absenceCounts);
      expect(afterProv.firstAbsentAt).toEqual(env.seededProvider.firstAbsentAt);
      expect(afterProv.lastLabel).toBe('TRANSIENT');
      expect(afterProv.skipReason).toBe('incomplete-pagination');

      if (fs.existsSync(env.inboxPath)) {
        const inboxRaw = JSON.parse(fs.readFileSync(env.inboxPath, 'utf8'));
        const items = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw.items ?? []);
        const bad = items.filter(
          (i: { label?: string }) =>
            i.label === 'NEW-CANDIDATE' || (typeof i.label === 'string' && i.label.startsWith('ABSENT-'))
        );
        expect(bad).toHaveLength(0);
      }
    });

    it('Q2(c): single page returning > SCAN_MAX_MODELS (rawCount > all.length) sets incomplete: true, marks tick TRANSIENT/INCOMPLETE-PAGINATION, and preserves seeded baseline', async () => {
      const env = setupHermeticTickWithBaseline(hermeticRoot);
      const oversizedModels = Array.from({ length: SCAN_MAX_MODELS + 5 }, (_, idx) => ({
        id: `model-${idx}`,
      }));

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: oversizedModels }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const summary = await runTickCommand({
        configPath: env.configPath,
        stateDir: env.stateDir,
        nowMs: env.nowMs,
        fetchFn: mockFetch,
        mode: 'propose',
      });

      const provSummary = summary.providers.find((p) => p.prefix === 'fake-prov');
      expect(provSummary?.label).toBe('TRANSIENT');
      expect(provSummary?.skipReason).toBe('incomplete-pagination');

      const afterCatalog = JSON.parse(fs.readFileSync(env.catalogPath, 'utf8'));
      const afterProv = afterCatalog.providers['fake-prov'];
      expect(afterProv.ids).toEqual(env.seededProvider.ids);
      expect(afterProv.absenceCounts).toEqual(env.seededProvider.absenceCounts);
      expect(afterProv.firstAbsentAt).toEqual(env.seededProvider.firstAbsentAt);
      expect(afterProv.lastLabel).toBe('TRANSIENT');
      expect(afterProv.skipReason).toBe('incomplete-pagination');

      if (fs.existsSync(env.inboxPath)) {
        const inboxRaw = JSON.parse(fs.readFileSync(env.inboxPath, 'utf8'));
        const items = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw.items ?? []);
        const bad = items.filter(
          (i: { label?: string }) =>
            i.label === 'NEW-CANDIDATE' || (typeof i.label === 'string' && i.label.startsWith('ABSENT-'))
        );
        expect(bad).toHaveLength(0);
      }
    });

    it('Q2(d): blocked redirect returns skipReason: redirect-blocked (not incomplete-pagination), marks tick TRANSIENT/redirect-blocked, and preserves seeded baseline', async () => {
      const env = setupHermeticTickWithBaseline(hermeticRoot);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://foreign-attacker.example/v1/models' },
        })
      );

      const summary = await runTickCommand({
        configPath: env.configPath,
        stateDir: env.stateDir,
        nowMs: env.nowMs,
        fetchFn: mockFetch,
        mode: 'propose',
      });

      const provSummary = summary.providers.find((p) => p.prefix === 'fake-prov');
      expect(provSummary?.label).toBe('TRANSIENT');
      expect(provSummary?.skipReason).toBe('redirect-blocked');

      const afterCatalog = JSON.parse(fs.readFileSync(env.catalogPath, 'utf8'));
      const afterProv = afterCatalog.providers['fake-prov'];
      expect(afterProv.ids).toEqual(env.seededProvider.ids);
      expect(afterProv.absenceCounts).toEqual(env.seededProvider.absenceCounts);
      expect(afterProv.firstAbsentAt).toEqual(env.seededProvider.firstAbsentAt);
      expect(afterProv.lastLabel).toBe('TRANSIENT');
      expect(afterProv.skipReason).toBe('redirect-blocked');

      if (fs.existsSync(env.inboxPath)) {
        const inboxRaw = JSON.parse(fs.readFileSync(env.inboxPath, 'utf8'));
        const items = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw.items ?? []);
        const bad = items.filter(
          (i: { label?: string }) =>
            i.label === 'NEW-CANDIDATE' || (typeof i.label === 'string' && i.label.startsWith('ABSENT-'))
        );
        expect(bad).toHaveLength(0);
      }
    });

    it('Q2(e): readBodyCapped cancels res.body.getReader() mid-stream when chunks exceed SCAN_MAX_BYTES_PER_PAGE and preserves seeded baseline in tick', async () => {
      let chunksPulled = 0;
      let cancelCalled = false;
      const chunkSize = 4 * 1024 * 1024; // 4 MiB per chunk -> 3rd chunk crosses 10 MiB

      const createOversizedStreamResponse = (): Response => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksPulled++;
            if (chunksPulled > 3) {
              throw new Error('Stream should have been cancelled on chunk 3 before chunk 4');
            }
            controller.enqueue(new Uint8Array(chunkSize));
          },
          cancel() {
            cancelCalled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      // Direct unit check on readBodyCapped
      const directRes = await readBodyCapped(
        createOversizedStreamResponse(),
        SCAN_MAX_BYTES_PER_PAGE
      );
      expect(directRes.ok).toBe(false);
      if (!directRes.ok) {
        expect(directRes.error).toContain('payload-too-large');
      }
      expect(cancelCalled).toBe(true);
      expect(chunksPulled).toBe(3);

      // End-to-end check through runTickCommand with pre-seeded baseline
      chunksPulled = 0;
      cancelCalled = false;
      const env = setupHermeticTickWithBaseline(hermeticRoot);
      const mockFetch = vi.fn().mockImplementation(async () => createOversizedStreamResponse());

      const summary = await runTickCommand({
        configPath: env.configPath,
        stateDir: env.stateDir,
        nowMs: env.nowMs,
        fetchFn: mockFetch,
        mode: 'propose',
      });

      expect(cancelCalled).toBe(true);
      expect(chunksPulled).toBeGreaterThanOrEqual(3);

      const provSummary = summary.providers.find((p) => p.prefix === 'fake-prov');
      expect(provSummary?.label).toBe('TRANSIENT');

      const afterCatalog = JSON.parse(fs.readFileSync(env.catalogPath, 'utf8'));
      const afterProv = afterCatalog.providers['fake-prov'];
      expect(afterProv.ids).toEqual(env.seededProvider.ids);
      expect(afterProv.absenceCounts).toEqual(env.seededProvider.absenceCounts);
      expect(afterProv.firstAbsentAt).toEqual(env.seededProvider.firstAbsentAt);
      expect(afterProv.lastLabel).toBe('TRANSIENT');

      if (fs.existsSync(env.inboxPath)) {
        const inboxRaw = JSON.parse(fs.readFileSync(env.inboxPath, 'utf8'));
        const items = Array.isArray(inboxRaw) ? inboxRaw : (inboxRaw.items ?? []);
        const bad = items.filter(
          (i: { label?: string }) =>
            i.label === 'NEW-CANDIDATE' || (typeof i.label === 'string' && i.label.startsWith('ABSENT-'))
        );
        expect(bad).toHaveLength(0);
      }
    });
  });

  describe('P3: Strict Numeric Validation', () => {
    it('validates --max-shrink-ratio correctly', () => {
      expect(validateMaxShrinkRatio(undefined)).toBe(0.3);
      expect(validateMaxShrinkRatio(0.3)).toBe(0.3);
      expect(validateMaxShrinkRatio('0.5')).toBe(0.5);
      expect(validateMaxShrinkRatio(1)).toBe(1);

      expect(() => validateMaxShrinkRatio(0)).toThrow(/Invalid --max-shrink-ratio/);
      expect(() => validateMaxShrinkRatio(-0.1)).toThrow(/Invalid --max-shrink-ratio/);
      expect(() => validateMaxShrinkRatio(1.1)).toThrow(/Invalid --max-shrink-ratio/);
      expect(() => validateMaxShrinkRatio('invalid')).toThrow(/Invalid --max-shrink-ratio/);
      expect(() => validateMaxShrinkRatio(NaN)).toThrow(/Invalid --max-shrink-ratio/);
    });

    it('validates --grace-cycles correctly', () => {
      expect(validateGraceCycles(undefined)).toBe(2);
      expect(validateGraceCycles(2)).toBe(2);
      expect(validateGraceCycles('3')).toBe(3);
      expect(validateGraceCycles(1)).toBe(1);

      expect(() => validateGraceCycles(0)).toThrow(/Invalid --grace-cycles/);
      expect(() => validateGraceCycles(-1)).toThrow(/Invalid --grace-cycles/);
      expect(() => validateGraceCycles(1.5)).toThrow(/Invalid --grace-cycles/);
      expect(() => validateGraceCycles('foo')).toThrow(/Invalid --grace-cycles/);
      expect(() => validateGraceCycles(NaN)).toThrow(/Invalid --grace-cycles/);
    });

    it('validates --interval-minutes in schedule correctly', () => {
      expect(validateIntervalMinutes(undefined)).toBe(15);
      expect(validateIntervalMinutes(15)).toBe(15);
      expect(validateIntervalMinutes('60')).toBe(60);
      expect(validateIntervalMinutes(1)).toBe(1);

      expect(() => validateIntervalMinutes(0)).toThrow(/Invalid --interval-minutes/);
      expect(() => validateIntervalMinutes(-5)).toThrow(/Invalid --interval-minutes/);
      expect(() => validateIntervalMinutes(2.5)).toThrow(/Invalid --interval-minutes/);
      expect(() => validateIntervalMinutes('abc')).toThrow(/Invalid --interval-minutes/);
      expect(() => validateIntervalMinutes(NaN)).toThrow(/Invalid --interval-minutes/);
    });
  });

  describe('P4: Default Autonomy Mode', () => {
    it('resolves undefined mode to propose', () => {
      expect(resolveAutonomyMode(undefined)).toBe('propose');
      expect(resolveAutonomyMode('')).toBe('propose');
      expect(resolveAutonomyMode('observe')).toBe('observe');
      expect(resolveAutonomyMode('propose')).toBe('propose');
    });

    it('defaults scheduled tick artifacts to propose mode', () => {
      const artifacts = buildTickScheduleArtifacts();
      expect(artifacts.windowsXml).toContain('--mode propose');
      expect(artifacts.systemdUnit).toContain('--mode propose');
      expect(artifacts.launchdPlist).toContain('<string>propose</string>');
    });
  });

  describe('P5: Doctor Diagnostics for Invalid Config', () => {
    it('records configError and marks ready: false when config file is invalid YAML or schema', async () => {
      const tmpConfig = path.join(hermeticRoot, 'bad-config.yaml');
      fs.writeFileSync(tmpConfig, 'routers:\n  - invalid_yaml: [}', 'utf8');

      const report = await runDoctorCommand({ configPath: tmpConfig });
      expect(report.ready).toBe(false);
      expect(report.configError).toBeTruthy();
      expect(report.nextSteps.some((s) => s.includes('Sửa lỗi tệp cấu hình'))).toBe(true);
    });
  });
});
