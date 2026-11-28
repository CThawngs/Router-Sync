/**
 * packages/cli/test/c51-rs-field-02-03.test.ts
 *
 * Tickets RS-FIELD-02, RS-FIELD-03, P2-2 & P2-3 (C51):
 *  - RS-FIELD-02: Out-of-repo `os.tmpdir()` working directory resolves shipped
 *    `registry/providers.yaml`, `registry/gateways.yaml`, and `registry/sources.yaml`
 *    via `import.meta.url` fallback while preserving explicit synthetic `cwd` precedence
 *    and Security Condition Z1 (`findLocalProviderRegistryFile` never walks up).
 *  - RS-FIELD-03 + P2-2 + P2-3: `readDirectRouterModelsFor` resolves router direct
 *    catalog models via `ProviderTarget.id` (custom-node IDs) and `canonicalPrefix(prefix)`
 *    (registry aliases even when `ProviderTarget.id` is a custom node ID, killing M6),
 *    returns `null` (never `[]`) when router availability evidence is absent (killing M8),
 *    emits `PROVIDER_ROUTER_LIST_MISMATCH` (`warn`), and emits `0` false
 *    `COMBO_MODEL_MISSING_FROM_CATALOGS` anomalies while genuine absence still flags.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBetterSqlite3 } from '@routersync/core';
import { runFieldReportCommand } from '../src/commands/field-report.js';
import { runTickCommand } from '../src/commands/tick.js';
import {
  findLocalProviderRegistryFile,
  findProviderRegistryFile,
  loadProviderRegistry,
} from '../src/sync/provider-registry.js';
import {
  findGatewaysFile,
  loadGatewayRegistry,
  providerHasSingleModelGet,
} from '../src/verify/gateways.js';
import { readRegistrySources } from '../src/verify/l3-scanner.js';

describe('C51 RS-FIELD-02: Out-of-repo CWD shipped registry fallback & Condition Z1', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f02-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves shipped providers.yaml, gateways.yaml, and sources.yaml from an empty external os.tmpdir() cwd', () => {
    const emptyExternalCwd = path.join(tmpDir, 'external-scheduler-cwd');
    const emptyStateDir = path.join(tmpDir, 'empty-state');
    fs.mkdirSync(emptyExternalCwd, { recursive: true });
    fs.mkdirSync(emptyStateDir, { recursive: true });
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';
    process.env['ROUTERSYNC_LOCAL_REGISTRY'] = '';
    process.env['ROUTERSYNC_STATE_DIR'] = emptyStateDir;

    vi.spyOn(process, 'cwd').mockReturnValue(emptyExternalCwd);

    const provFile = findProviderRegistryFile(emptyExternalCwd);
    expect(provFile).not.toBeNull();
    expect(provFile!.replace(/\\/g, '/')).toMatch(/\/registry\/providers\.yaml$/);

    const pubReg = loadProviderRegistry({ cwd: emptyExternalCwd, localPath: null });
    expect(pubReg.providers['openrouter']).toBe('https://openrouter.ai/api/v1');
    expect(pubReg.alias['hf']).toBe('huggingface');

    const gwFile = findGatewaysFile(emptyExternalCwd);
    expect(gwFile).not.toBeNull();
    expect(gwFile!.replace(/\\/g, '/')).toMatch(/\/registry\/gateways\.yaml$/);

    const gateways = loadGatewayRegistry(emptyExternalCwd);
    expect(gateways.length).toBeGreaterThan(0);
    expect(providerHasSingleModelGet('node-b', emptyExternalCwd)).toBe(false);

    const sources = readRegistrySources();
    expect(sources.length).toBeGreaterThan(0);
  });

  it('preserves synthetic cwd fixture precedence and enforces Z1 no-walkup for providers.local.yaml', () => {
    const parentWithRogueLocal = path.join(tmpDir, 'parent-dir');
    const synthRepoCwd = path.join(parentWithRogueLocal, 'synth-workspace');
    fs.mkdirSync(path.join(synthRepoCwd, 'registry'), { recursive: true });

    // Rogue providers.local.yaml in both parent and cwd MUST be ignored (Condition Z1)
    fs.writeFileSync(
      path.join(parentWithRogueLocal, 'providers.local.yaml'),
      'providers:\n  rogue-parent: https://rogue-parent.example.test/v1\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(synthRepoCwd, 'providers.local.yaml'),
      'providers:\n  rogue-cwd: https://rogue-cwd.example.test/v1\n',
      'utf8'
    );

    // Explicit synthetic registry files under synthRepoCwd/registry must win over shipped fallback
    fs.writeFileSync(
      path.join(synthRepoCwd, 'registry', 'providers.yaml'),
      [
        'version: 1',
        'providers:',
        '  synth-public: https://synth-public.example.test/v1',
        'alias:',
        '  sp: synth-public',
        'noKeyPublic: []',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(synthRepoCwd, 'registry', 'gateways.yaml'),
      [
        'gateways:',
        '  - id: synth-gw',
        '    name: Synthetic Gateway',
        '    hasSingleModelGet: false',
        '    reason: synthetic test fixture',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(synthRepoCwd, 'registry', 'sources.yaml'),
      [
        'sources:',
        '  - id: synth-changelog',
        '    url: https://openrouter.ai/docs/changelog',
        '    loai: changelog',
        '    reliability: 1',
        '',
      ].join('\n'),
      'utf8'
    );

    const emptyStateDir = path.join(tmpDir, 'z1-empty-state');
    fs.mkdirSync(emptyStateDir, { recursive: true });
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';
    process.env['ROUTERSYNC_LOCAL_REGISTRY'] = '';
    process.env['ROUTERSYNC_STATE_DIR'] = emptyStateDir;

    vi.spyOn(process, 'cwd').mockReturnValue(synthRepoCwd);

    expect(findLocalProviderRegistryFile(synthRepoCwd)).toBeNull();
    const reg = loadProviderRegistry({ cwd: synthRepoCwd });
    expect(reg.providers['synth-public']).toBe('https://synth-public.example.test/v1');
    expect(reg.providers['openrouter']).toBeUndefined();
    expect(reg.providers['rogue-parent']).toBeUndefined();
    expect(reg.providers['rogue-cwd']).toBeUndefined();

    const gws = loadGatewayRegistry(synthRepoCwd);
    expect(gws).toHaveLength(1);
    expect(gws[0]?.id).toBe('synth-gw');
    expect(providerHasSingleModelGet('synth-gw', synthRepoCwd)).toBe(false);

    const sources = readRegistrySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe('synth-changelog');
  });
});

describe('C51 RS-FIELD-03, P2-2 & P2-3: readDirectRouterModelsFor alias resolution & null-on-no-evidence', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c51-f03-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...origEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves custom-node IDs, exclusive canonicalPrefix(prefix) aliases (kills M6), and returns null when router evidence is absent (kills M8)', async () => {
    const stateDir = path.join(tmpDir, 'state');
    const outDir = path.join(tmpDir, 'field-out');
    const emptyHome = path.join(tmpDir, 'isolated-home');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(emptyHome, { recursive: true });

    const nowMs = Date.parse('2026-11-28T11:00:00.000Z');
    const nowIso = new Date(nowMs).toISOString();

    // Fresh L2/L3 caches so tick makes zero external L2/L3 HTTP requests
    fs.writeFileSync(
      path.join(stateDir, 'l2-cache.json'),
      JSON.stringify({ version: 1, updatedAt: nowIso, models: {} }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(stateDir, 'l3-cache.json'),
      JSON.stringify({ version: 1, updatedAt: nowIso, sourceHashes: {}, notices: [] }),
      'utf8'
    );

    const customNodeId = 'openai-compatible-chat-00000000-0000-4000-8000-000000000001';
    const customPrefix = 'synth-alias';

    // M6 killer: bind prefix 'hf' to a custom provider_nodes ID so ProviderTarget.prefix === 'hf'
    // and ProviderTarget.id === hfNodeId (NEITHER equals 'huggingface'), while syncedAvailableModels
    // in key_value is keyed under canonical 'huggingface:conn-hf-canon'. Deleting line 994
    // (`...getProviderAliases(canonicalPrefix(prefix))`) makes hf routerModels drop to null!
    const hfCustomNodeId = 'openai-compatible-chat-00000000-0000-4000-8000-000000000002';

    // M8 killer: provider with an upstream connection & scanned models, but ZERO rows in
    // key_value (`syncedAvailableModels` / `customModels` / `modelAliases`) -> routerModels MUST be null (not []).
    const noEvidenceNodeId = 'openai-compatible-chat-00000000-0000-4000-8000-000000000003';
    const noEvidencePrefix = 'synth-no-evidence';

    // Empty 9Router DB for isolation
    const nineDbPath = path.join(tmpDir, 'synth-9router.sqlite');
    const nineDb = openBetterSqlite3(nineDbPath, { restrictToDir: tmpDir });
    nineDb.exec(`
      CREATE TABLE providerConnections (provider TEXT, name TEXT, authType TEXT, isActive INTEGER, data TEXT);
      CREATE TABLE providerNodes (id TEXT, data TEXT);
      CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);
      CREATE TABLE kv (scope TEXT, key TEXT, value TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    nineDb.close();

    const omniDbPath = path.join(tmpDir, 'synth-omni.sqlite');
    const omniDb = openBetterSqlite3(omniDbPath, { restrictToDir: tmpDir });
    omniDb.exec(`
      CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, auth_type TEXT, is_active INTEGER, api_key TEXT, provider_specific_data TEXT);
      CREATE TABLE provider_nodes (id TEXT PRIMARY KEY, prefix TEXT, base_url TEXT);
      CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE, data TEXT, created_at TEXT, updated_at TEXT, sort_order INTEGER, system_message TEXT);
      CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
    `);

    omniDb
      .prepare('INSERT INTO provider_nodes (id, prefix, base_url) VALUES (?, ?, ?)')
      .run(customNodeId, customPrefix, 'https://synth-node.example.test/v1');
    omniDb
      .prepare('INSERT INTO provider_nodes (id, prefix, base_url) VALUES (?, ?, ?)')
      .run(hfCustomNodeId, 'hf', 'https://huggingface.co/api/v1');
    omniDb
      .prepare('INSERT INTO provider_nodes (id, prefix, base_url) VALUES (?, ?, ?)')
      .run(noEvidenceNodeId, noEvidencePrefix, 'https://synth-no-evidence.example.test/v1');

    omniDb
      .prepare(
        'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'conn-node-1',
        customNodeId,
        'Synthetic Custom Node',
        'api_key',
        1,
        'synth-key-placeholder-node',
        JSON.stringify({ prefix: customPrefix, baseUrl: 'https://synth-node.example.test/v1' })
      );

    omniDb
      .prepare(
        'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'conn-hf-node',
        hfCustomNodeId,
        'Synthetic HF Custom Node',
        'api_key',
        1,
        'synth-key-placeholder-hf',
        JSON.stringify({ prefix: 'hf', baseUrl: 'https://huggingface.co/api/v1' })
      );

    omniDb
      .prepare(
        'INSERT INTO provider_connections (id, provider, name, auth_type, is_active, api_key, provider_specific_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'conn-no-ev-1',
        noEvidenceNodeId,
        'Synthetic Unsynced Node',
        'api_key',
        1,
        'synth-key-placeholder-no-ev',
        JSON.stringify({
          prefix: noEvidencePrefix,
          baseUrl: 'https://synth-no-evidence.example.test/v1',
        })
      );

    omniDb
      .prepare(
        'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'combo-1',
        'synth-combo-main',
        JSON.stringify({
          models: [
            { model: 'synth-alias/vendor/synth-shared-v1' },
            { model: 'synth-alias/vendor/synth-router-only-v1' },
            { model: 'hf/org/synth-hf-shared-v1' },
            { model: 'hf/org/synth-hf-router-only-v1' },
            { model: `${noEvidencePrefix}/vendor/synth-upstream-only-v1` },
          ],
          strategy: 'priority',
        }),
        nowIso,
        nowIso,
        0,
        ''
      );

    omniDb
      .prepare(
        'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'combo-2',
        'synth-combo-missing',
        JSON.stringify({
          models: [
            { model: 'synth-alias/vendor/synth-shared-v1' },
            { model: 'synth-alias/vendor/synth-truly-missing-v1' },
          ],
          strategy: 'priority',
        }),
        nowIso,
        nowIso,
        1,
        ''
      );

    omniDb
      .prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)')
      .run(
        'syncedAvailableModels',
        `${customNodeId}:conn-node-1`,
        JSON.stringify([
          { id: 'vendor/synth-shared-v1' },
          { id: 'vendor/synth-router-only-v1' },
        ])
      );

    omniDb
      .prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)')
      .run(
        'syncedAvailableModels',
        'huggingface:conn-hf-canon',
        JSON.stringify([
          { id: 'org/synth-hf-shared-v1' },
          { id: 'org/synth-hf-router-only-v1' },
        ])
      );
    // Deliberately NO key_value entry for noEvidenceNodeId / noEvidencePrefix!

    omniDb.close();

    const configPath = path.join(tmpDir, 'routersync-synth.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: synth-omni',
        '    adapter: omniroute',
        '    baseUrl: "http://127.0.0.1:9/v1"',
        '    db:',
        `      path: "${omniDbPath.replace(/\\/g, '/')}"`,
        '    isolated: true',
        'policy:',
        '  mode: shadow',
        '  schedule:',
        '    sync: "every 15m"',
        '    health: "every 5m"',
        'combos:',
        '  - name: synth-combo-main',
        '    role: coding',
        '    routers: [synth-omni]',
        '    size: 5',
        '  - name: synth-combo-missing',
        '    role: coding',
        '    routers: [synth-omni]',
        '    size: 2',
        '',
      ].join('\n'),
      'utf8'
    );

    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    process.env['ROUTERSYNC_HOME'] = emptyHome;
    process.env['ROUTERSYNC_9ROUTER_DB'] = nineDbPath;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = omniDbPath;
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';

    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('synth-node.example.test')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'vendor/synth-shared-v1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('huggingface.co')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'org/synth-hf-shared-v1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('synth-no-evidence.example.test')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'vendor/synth-upstream-only-v1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch URL in RS-FIELD-03 test: ${url}`);
    };

    await runTickCommand({
      configPath,
      stateDir,
      homeDir: emptyHome,
      mode: 'observe',
      nowMs,
      fetchFn: mockFetch,
      env: process.env,
      json: true,
    });

    const tickLogRaw = fs.readFileSync(path.join(stateDir, 'tick.log'), 'utf8').trim();
    const teleMatch = tickLogRaw.match(/field_telemetry=(\{.+?\})(?:\s|$)/) ?? tickLogRaw.match(/field_telemetry=(\{.+\})$/);
    expect(teleMatch).not.toBeNull();
    const tele = JSON.parse(teleMatch![1]!) as {
      providers: Array<{
        providerId: string;
        scannedModels: string[] | null;
        routerModels: string[] | null;
      }>;
    };

    const synthProv = tele.providers.find((p) => p.providerId === customPrefix);
    expect(synthProv).toBeDefined();
    expect(synthProv!.scannedModels).toEqual(['vendor/synth-shared-v1']);
    expect(synthProv!.routerModels).toEqual([
      'vendor/synth-router-only-v1',
      'vendor/synth-shared-v1',
    ]);

    // P2-3 (kills M6): hf resolved ONLY via canonicalPrefix('hf') -> 'huggingface'
    const hfProv = tele.providers.find((p) => p.providerId === 'hf');
    expect(hfProv).toBeDefined();
    expect(hfProv!.scannedModels).toEqual(['org/synth-hf-shared-v1']);
    expect(hfProv!.routerModels).toEqual([
      'org/synth-hf-router-only-v1',
      'org/synth-hf-shared-v1',
    ]);

    // P2-2 (kills M8): no router availability evidence MUST return null, NEVER []
    const noEvidenceProv = tele.providers.find((p) => p.providerId === noEvidencePrefix);
    expect(noEvidenceProv).toBeDefined();
    expect(noEvidenceProv!.scannedModels).toEqual(['vendor/synth-upstream-only-v1']);
    expect(noEvidenceProv!.routerModels).toBeNull();

    await runFieldReportCommand({
      out: outDir,
      stateDir,
      config: configPath,
      nowMs: nowMs + 60_000,
      silent: true,
    });

    const anomaliesDoc = JSON.parse(
      fs.readFileSync(path.join(outDir, 'anomalies.json'), 'utf8')
    ) as {
      anomalies: Array<{
        code: string;
        severity: string;
        subject: string;
        metrics: Record<string, unknown>;
      }>;
    };

    const mismatches = anomaliesDoc.anomalies.filter(
      (a) => a.code === 'PROVIDER_ROUTER_LIST_MISMATCH'
    );
    const synthMismatch = mismatches.find((a) => a.subject === `provider:${customPrefix}`);
    expect(synthMismatch).toBeDefined();
    expect(synthMismatch!.severity).toBe('warn');
    expect(synthMismatch!.metrics['onlyInRouterCount']).toBe(1);

    const hfMismatch = mismatches.find((a) => a.subject === 'provider:hf');
    expect(hfMismatch).toBeDefined();
    expect(hfMismatch!.severity).toBe('warn');
    expect(hfMismatch!.metrics['onlyInRouterCount']).toBe(1);

    // P2-2: Unsynced provider (routerModels === null) MUST NOT emit a false PROVIDER_ROUTER_LIST_MISMATCH
    expect(
      mismatches.find((a) => a.subject === `provider:${noEvidencePrefix}`)
    ).toBeUndefined();

    const missingCatalogAnomalies = anomaliesDoc.anomalies.filter(
      (a) => a.code === 'COMBO_MODEL_MISSING_FROM_CATALOGS'
    );
    // Zero false positives on synth-combo-main!
    expect(
      missingCatalogAnomalies.filter((a) => a.subject.endsWith('/synth-combo-main'))
    ).toEqual([]);

    // Genuine absence from BOTH upstream and router catalogs on synth-combo-missing STILL flags!
    const genuineMissing = missingCatalogAnomalies.find((a) =>
      a.subject.endsWith('/synth-combo-missing')
    );
    expect(genuineMissing).toBeDefined();
    expect(genuineMissing!.severity).toBe('high');
    expect(genuineMissing!.metrics['missingModels']).toEqual([
      'synth-alias/vendor/synth-truly-missing-v1',
    ]);
  });
});
