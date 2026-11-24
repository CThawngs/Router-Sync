/**
 * packages/cli/test/c45-wp2-harness-write.test.ts
 *
 * C45-WP2 Red-First Contract & Mutation-Killing Suite (Phục vụ: S3):
 *  - Full lossless Direction A adapters (plan, apply, rollback, read-back) for:
 *    1. hermes (YAML with # comments + sibling .env key check)
 *    2. openmausbot (JSON instances.<id>.config.managedModels; reloadRequired: true; refuses bots.json/routines.json)
 *    3. opencode (JSONC with // and block comments)
 *    4. dsh (YAML Cordis patch with # comments, full row preservation & running process detection)
 *  - Deterministic report-only refusal + Vietnamese guidance for:
 *    claude-code, codex, antigravity, cursor, grok-bot
 *  - Strict invariants tested to kill M1..M5:
 *    M1: Keyless provider never receives additions/removals
 *    M2: Default model slot never mutated even when deprecated (emits defaultSlotWarnings)
 *    M3: YAML/JSONC comments & unchanged sections preserved byte-for-byte
 *    M4: Auto-rollback to exact preSha256 on post-write read-back mismatch
 *    M5: Refuses apply on report-only harnesses and refuses real os.homedir() paths
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import type { HarnessCatalogInput } from '@routersync/adapter-sdk';
import { AGENT_APP_ADAPTERS } from '../src/apps/inspect.js';
import {
  assertHarnessWriteSandboxAllowed,
  detectRunningHarnessProcesses,
  getHarnessWriteAdapter,
  listHarnessWriteAdapters,
} from '../src/apps/write-adapter.js';
import {
  runAppsApplyCommand,
  runAppsPlanCommand,
  runAppsRollbackCommand,
} from '../src/commands/apps.js';

const FAKE_SECRET_A = ['sk', 'syntheticTestKeyAlpha987654'].join('-');
const FAKE_SECRET_B = ['sk', 'syntheticTestKeyBeta123456'].join('-');

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('C45-WP2: Harness Write Adapters & Safety Invariants', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c45-wp2-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps AGENT_APP_ADAPTERS inspect() strictly readOnly: true for backward compatibility', () => {
    expect(listHarnessWriteAdapters().length).toBe(9);
    for (const roAdapter of AGENT_APP_ADAPTERS) {
      expect('apply' in roAdapter).toBe(false);
    }
  });

  it('1. hermes (YAML): updates keyed providers (inline key & sibling .env), skips keyless (M1), warns without mutating default slots (M2), preserves comments & CRLF byte-for-byte (M3), and rolls back identically', async () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, `NINE_ROUTER_API_KEY=${FAKE_SECRET_A}\n`, 'utf8');

    const initialYaml = [
      '# Hermes top banner comment — MUST stay byte-identical',
      'model:',
      '  provider: 9router',
      '  default: deprecated-coder-v1 # inline default slot comment',
      '  base_url: http://127.0.0.1:9/v1',
      'cron:',
      '  model: deprecated-coder-v1',
      '  model_provider: 9router',
      'providers:',
      '  9router:',
      '    # Keyed via sibling .env',
      '    base_url: http://127.0.0.1:9/v1',
      '    key_env: NINE_ROUTER_API_KEY',
      '    models:',
      '      # Keep surviving model entry & its custom metadata',
      '      - id: keep-model-1',
      '        name: Keep Model One',
      '      - id: deprecated-coder-v1',
      '  keyless_provider:',
      '    # No key in YAML and no key in .env -> MUST NOT BE TOUCHED (M1)',
      '    base_url: https://example.invalid/v1',
      '    models:',
      '      - id: keyless-old-model',
      'custom_providers:',
      '  - name: custom_keyed',
      '    base_url: https://example.invalid/custom',
      `    api_key: ${FAKE_SECRET_B}`,
      '    model: custom-keep',
      '    models:',
      '      - id: custom-keep',
      '      - id: custom-deprecated',
      '# Trailing Hermes comment',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, initialYaml, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const catalog: HarnessCatalogInput = {
      '9router': {
        liveModels: ['keep-model-1', 'new-verified-pro-2'],
        deprecatedModels: ['deprecated-coder-v1'],
      },
      keyless_provider: {
        liveModels: ['should-never-be-added'],
        deprecatedModels: ['keyless-old-model'],
      },
      custom_keyed: {
        liveModels: ['custom-keep', 'custom-new-v2'],
        deprecatedModels: ['custom-deprecated'],
      },
    };

    const adapter = getHarnessWriteAdapter('hermes');
    expect(adapter).toBeDefined();

    const plan = await adapter!.plan({
      configPath,
      catalog,
      processRunner: () => ['hermes.exe', 'explorer.exe'],
    });

    expect(plan.editable).toBe(true);
    expect(plan.directionAMode).toBe('write-adapter');
    expect(plan.reloadRequired).toBe(true);
    expect(plan.runningProcesses).toContain('hermes.exe');
    expect(plan.targetProviders.sort()).toEqual(['9router', 'custom_keyed']);
    expect(plan.targetProviders).not.toContain('keyless_provider');
    expect(plan.additions).toEqual([
      { provider: '9router', model: 'new-verified-pro-2' },
      { provider: 'custom_keyed', model: 'custom-new-v2' },
    ]);
    expect(plan.removals.map((r) => ({ provider: r.provider, model: r.model }))).toEqual([
      { provider: '9router', model: 'deprecated-coder-v1' },
      { provider: 'custom_keyed', model: 'custom-deprecated' },
    ]);
    // M2: Default slots deprecated -> warn only, never mutate
    expect(plan.defaultSlotWarnings.some((w) => w.slot === 'model.default' && w.currentModel === 'deprecated-coder-v1')).toBe(true);
    expect(plan.defaultSlotWarnings.some((w) => w.slot === 'cron.model' && w.currentModel === 'deprecated-coder-v1')).toBe(true);
    // Zero secret leakage
    expect(JSON.stringify(plan)).not.toContain(FAKE_SECRET_A);
    expect(JSON.stringify(plan)).not.toContain(FAKE_SECRET_B);

    const applyRes = await adapter!.apply({
      configPath,
      catalog,
      expectedPlanHash: plan.planHash,
      processRunner: () => ['hermes.exe'],
    });

    expect(applyRes.applied).toBe(true);
    expect(applyRes.rolledBack).toBe(false);
    expect(applyRes.readBackVerified).toBe(true);
    expect(applyRes.preSha256).toBe(preSha);
    expect(applyRes.postSha256).not.toBe(preSha);
    expect(JSON.stringify(applyRes)).not.toContain(FAKE_SECRET_A);
    expect(JSON.stringify(applyRes)).not.toContain(FAKE_SECRET_B);

    const afterText = fs.readFileSync(configPath, 'utf8');
    // M3: Comments, CRLF, secrets, URLs, default slots, and keyless section byte-preserved
    expect(afterText).toContain('# Hermes top banner comment — MUST stay byte-identical\r\n');
    expect(afterText).toContain('  default: deprecated-coder-v1 # inline default slot comment\r\n');
    expect(afterText).toContain('  model: deprecated-coder-v1\r\n');
    expect(afterText).toContain('# No key in YAML and no key in .env -> MUST NOT BE TOUCHED (M1)\r\n');
    expect(afterText).toContain('# Trailing Hermes comment\r\n');
    expect(afterText).toContain(`    api_key: ${FAKE_SECRET_B}\r\n`);

    const parsed = parseDocument(afterText).toJS() as Record<string, any>;
    expect(parsed.model.default).toBe('deprecated-coder-v1');
    expect(parsed.cron.model).toBe('deprecated-coder-v1');
    expect(parsed.providers['9router'].models.map((m: any) => m.id ?? m)).toEqual([
      'keep-model-1',
      'new-verified-pro-2',
    ]);
    expect(parsed.providers['9router'].models[0].name).toBe('Keep Model One');
    expect(parsed.providers.keyless_provider.models).toEqual([{ id: 'keyless-old-model' }]);
    expect(parsed.custom_providers[0].models.map((m: any) => m.id ?? m)).toEqual([
      'custom-keep',
      'custom-new-v2',
    ]);

    // Rollback restores 100% byte-identical file
    const rb = await adapter!.rollback({
      configPath,
      backupPath: applyRes.backupPath,
      expectedPreSha256: preSha,
    });
    expect(rb.restored).toBe(true);
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
  });

  it('2. openmausbot (JSON): updates instances.<id>.config.managedModels on keyed openai-compat only (M1), preserves key/url/model & warns on deprecated default (M2), refuses bots.json & routines.json, and round-trips byte-identically', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const initialJson = [
      '{',
      '  "defaultModelSelection": "old-omb-default",',
      '  "instances": {',
      '    "openai-compat-keyed": {',
      '      "driver": "openai-compat",',
      '      "config": {',
      '        "url": "http://127.0.0.1:9/v1",',
      `        "key": "${FAKE_SECRET_A}",`,
      '        "model": "old-omb-default",',
      '        "managedModels": [',
      '          "keep-omb-1",',
      '          "old-omb-default"',
      '        ]',
      '      }',
      '    },',
      '    "openai-compat-keyless": {',
      '      "driver": "openai-compat",',
      '      "config": {',
      '        "url": "https://example.invalid/v1",',
      '        "model": "keyless-m1",',
      '        "managedModels": ["keyless-m1"]',
      '      }',
      '    },',
      '    "builtin-openai": {',
      '      "driver": "openai",',
      '      "config": {',
      `        "key": "${FAKE_SECRET_B}",`,
      '        "model": "gpt-5"',
      '      }',
      '    }',
      '  },',
      '  "mcpServers": {',
      '    "keep-mcp": { "command": "node", "args": ["srv.js"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initialJson, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const catalog: HarnessCatalogInput = {
      'openai-compat-keyed': {
        liveModels: ['keep-omb-1', 'new-omb-2'],
        deprecatedModels: ['old-omb-default'],
      },
      'openai-compat-keyless': {
        liveModels: ['never-inject'],
        deprecatedModels: ['keyless-m1'],
      },
      'builtin-openai': {
        liveModels: ['never-inject-builtin'],
        deprecatedModels: ['gpt-5'],
      },
    };

    const adapter = getHarnessWriteAdapter('openmausbot')!;
    const plan = await adapter.plan({
      configPath,
      catalog,
      processRunner: () => ['OpenMausBot.exe'],
    });

    expect(plan.editable).toBe(true);
    expect(plan.reloadRequired).toBe(true);
    expect(plan.runningProcesses).toContain('OpenMausBot.exe');
    expect(plan.targetProviders).toEqual(['openai-compat-keyed']);
    expect(plan.additions).toEqual([{ provider: 'openai-compat-keyed', model: 'new-omb-2' }]);
    expect(plan.removals.map((r) => r.model)).toEqual(['old-omb-default']);
    expect(plan.defaultSlotWarnings.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(plan)).not.toContain(FAKE_SECRET_A);

    const applyRes = await adapter.apply({ configPath, catalog });
    expect(applyRes.applied).toBe(true);
    expect(applyRes.readBackVerified).toBe(true);
    expect(applyRes.reloadRequired).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, any>;
    expect(parsed.defaultModelSelection).toBe('old-omb-default');
    expect(parsed.instances['openai-compat-keyed'].config.model).toBe('old-omb-default');
    expect(parsed.instances['openai-compat-keyed'].config.key).toBe(FAKE_SECRET_A);
    expect(parsed.instances['openai-compat-keyed'].config.url).toBe('http://127.0.0.1:9/v1');
    expect(parsed.instances['openai-compat-keyed'].config.managedModels).toEqual(['keep-omb-1', 'new-omb-2']);
    expect(parsed.instances['openai-compat-keyless'].config.managedModels).toEqual(['keyless-m1']);
    expect(parsed.instances['builtin-openai'].config.managedModels).toBeUndefined();
    expect(parsed.mcpServers).toEqual({ 'keep-mcp': { command: 'node', args: ['srv.js'], enabled: true } });

    const rb = await adapter.rollback({ configPath, backupPath: applyRes.backupPath });
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);

    // Explicitly refuse bots.json and routines.json even inside tmpDir
    for (const forbiddenFile of ['bots.json', 'routines.json']) {
      const p = path.join(tmpDir, forbiddenFile);
      fs.writeFileSync(p, '{}', 'utf8');
      await expect(adapter.plan({ configPath: p, catalog })).rejects.toThrow(/bots\.json|routines\.json/i);
      await expect(adapter.apply({ configPath: p, catalog })).rejects.toThrow(/bots\.json|routines\.json/i);
    }
  });

  it('3. opencode (JSONC): updates keyed provider models preserving // and /* */ comments & exact surrounding bytes (M1, M2, M3)', async () => {
    const configPath = path.join(tmpDir, 'opencode.jsonc');
    const initialJsonc = [
      '{',
      '  // Leading JSONC line comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "model": "9router/old-oc-model",',
      '  "small_model": "9router/keep-oc-model",',
      '  /* Block comment before provider map */',
      '  "provider": {',
      '    "9router": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "options": {',
      '        "baseURL": "http://127.0.0.1:9/v1",',
      `        "apiKey": "${FAKE_SECRET_A}" // inline secret comment`,
      '      },',
      '      "models": {',
      '        "keep-oc-model": { "name": "Keep OC", "limit": { "context": 128000, "output": 8192 } },',
      '        "old-oc-model": { "name": "Deprecated OC" }',
      '      }',
      '    },',
      '    "keyless-oc": {',
      '      "options": { "baseURL": "https://example.invalid/v1" },',
      '      "models": {',
      '        "untouched-model": { "name": "Untouched" }',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initialJsonc, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const catalog: HarnessCatalogInput = {
      '9router': {
        liveModels: ['keep-oc-model', 'new-oc-sonnet'],
        deprecatedModels: ['old-oc-model'],
      },
      'keyless-oc': {
        liveModels: ['never-add-to-keyless'],
        deprecatedModels: ['untouched-model'],
      },
    };

    const adapter = getHarnessWriteAdapter('opencode')!;
    const plan = await adapter.plan({ configPath, catalog });
    expect(plan.editable).toBe(true);
    expect(plan.targetProviders).toEqual(['9router']);
    expect(plan.additions).toEqual([{ provider: '9router', model: 'new-oc-sonnet' }]);
    expect(plan.removals.map((r) => r.model)).toEqual(['old-oc-model']);
    expect(plan.defaultSlotWarnings.some((w) => w.slot === 'model')).toBe(true);

    const applyRes = await adapter.apply({ configPath, catalog });
    expect(applyRes.applied).toBe(true);
    expect(applyRes.readBackVerified).toBe(true);

    const afterText = fs.readFileSync(configPath, 'utf8');
    expect(afterText).toContain('// Leading JSONC line comment');
    expect(afterText).toContain('/* Block comment before provider map */');
    expect(afterText).toContain('// inline secret comment');
    expect(afterText).toContain('"model": "9router/old-oc-model"');
    expect(afterText).toContain('"keep-oc-model": { "name": "Keep OC", "limit": { "context": 128000, "output": 8192 } }');
    expect(afterText).toContain('"new-oc-sonnet"');
    expect(afterText).not.toContain('"old-oc-model": { "name": "Deprecated OC" }');
    expect(afterText).toContain('"untouched-model": { "name": "Untouched" }');
    expect(afterText).not.toContain('never-add-to-keyless');

    // Second apply with identical catalog is a strict no-op (byte-identical)
    const afterFirstSha = sha256(fs.readFileSync(configPath));
    const noopRes = await adapter.apply({ configPath, catalog });
    expect(noopRes.preSha256).toBe(afterFirstSha);
    expect(noopRes.postSha256).toBe(afterFirstSha);

    const rb = await adapter.rollback({ configPath, backupPath: applyRes.backupPath });
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
  });

  it('4. dsh (YAML Cordis patch): updates keyed llm-pi-ai providers only, preserves sibling Cordis rows & comments byte-for-byte, and detects running DSH process (M1, M2, M3)', async () => {
    const configPath = path.join(tmpDir, 'cordis.patch.yml');
    const initialCordis = [
      '# DSH Cordis Patch — critical boot file',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: 9router',
      '    model: dsh-old-default',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    selectedDefault: 9router/dsh-old-default',
      '    providers:',
      '      "9router":',
      '        displayName: Local Router',
      '        apiKeyEnv: ROUTER_API_KEY',
      '        baseURL: http://127.0.0.1:9/v1',
      '        models:',
      '          # Keep custom contextWindow metadata',
      '          - id: dsh-keep-1',
      '            name: DSH Keep 1',
      '            contextWindow: 200000',
      '          - id: dsh-old-default',
      '      "keyless-dsh":',
      '        displayName: Keyless',
      '        baseURL: https://example.invalid/v1',
      '        models:',
      '          - id: keyless-stay',
      '- id: unrelated-plugin',
      '  name: "@deepseek-ai/dsh-other"',
      '  config:',
      '    keepFlag: true',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initialCordis, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const catalog: HarnessCatalogInput = {
      '9router': {
        liveModels: ['dsh-keep-1', 'dsh-new-v3'],
        deprecatedModels: ['dsh-old-default'],
      },
      'keyless-dsh': {
        liveModels: ['never-added'],
        deprecatedModels: ['keyless-stay'],
      },
    };

    const adapter = getHarnessWriteAdapter('dsh')!;
    const plan = await adapter.plan({
      configPath,
      catalog,
      processRunner: () => ['dsh.exe'],
    });
    expect(plan.editable).toBe(true);
    expect(plan.reloadRequired).toBe(false);
    expect(plan.runningProcesses).toContain('dsh.exe');
    expect(plan.targetProviders).toEqual(['9router']);
    expect(plan.defaultSlotWarnings.length).toBeGreaterThanOrEqual(1);

    const applyRes = await adapter.apply({
      configPath,
      catalog,
      processRunner: () => ['dsh.exe'],
    });
    expect(applyRes.applied).toBe(true);
    expect(applyRes.readBackVerified).toBe(true);

    const afterText = fs.readFileSync(configPath, 'utf8');
    expect(afterText).toContain('# DSH Cordis Patch — critical boot file');
    expect(afterText).toContain('# Keep custom contextWindow metadata');
    expect(afterText).toContain('model: dsh-old-default');
    expect(afterText).toContain('selectedDefault: 9router/dsh-old-default');

    const rows = parseDocument(afterText).toJS() as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.config.model).toBe('dsh-old-default');
    expect(rows[2]?.config.keepFlag).toBe(true);
    const piProviders = rows[1]?.config.providers;
    expect(piProviders['9router'].displayName).toBe('Local Router');
    expect(piProviders['9router'].models.map((m: any) => m.id)).toEqual(['dsh-keep-1', 'dsh-new-v3']);
    expect(piProviders['9router'].models[0].contextWindow).toBe(200000);
    expect(piProviders['keyless-dsh'].models).toEqual([{ id: 'keyless-stay' }]);

    const rb = await adapter.rollback({ configPath, backupPath: applyRes.backupPath });
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
  });

  it('5. Auto-rolls back immediately when post-write read-back mismatches or corrupts (kills M4)', async () => {
    const configPath = path.join(tmpDir, 'opencode-fault.jsonc');
    const initial = [
      '{',
      '  // Must survive failed apply via automatic rollback',
      '  "provider": {',
      '    "9router": {',
      `      "options": { "apiKey": "${FAKE_SECRET_A}" },`,
      '      "models": { "m1": { "name": "M1" } }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const adapter = getHarnessWriteAdapter('opencode')!;
    await expect(
      adapter.apply({
        configPath,
        catalog: { '9router': { liveModels: ['m1', 'm2'], deprecatedModels: [] } },
        injectReadBackFault: () => {
          // Simulate mid-flight corruption before read-back verification
          fs.writeFileSync(configPath, '{ "provider": { "9router": { "models": {} } } }', 'utf8');
        },
      })
    ).rejects.toThrow(/read-back|rollback/i);

    // File on disk MUST be restored to exact pre-apply bytes!
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(initial);
  });

  it('6. Enforces report-only refusal for claude-code, codex, antigravity, cursor, grok-bot AND refuses real os.homedir() paths (kills M5)', async () => {
    const reportOnlyIds = ['claude-code', 'codex', 'antigravity', 'cursor', 'grok-bot'] as const;
    const catalog: HarnessCatalogInput = {
      openai: { liveModels: ['gpt-5'], deprecatedModels: [] },
    };

    for (const id of reportOnlyIds) {
      const adapter = getHarnessWriteAdapter(id);
      expect(adapter).toBeDefined();
      expect(adapter!.directionAMode).toBe('report-only');

      const target = path.join(tmpDir, `${id}-cfg.json`);
      const plan = await adapter!.plan({ configPath: target, catalog });
      expect(plan.editable).toBe(false);
      expect(plan.directionAMode).toBe('report-only');
      expect(plan.guidance.length).toBeGreaterThan(0);

      await expect(adapter!.apply({ configPath: target, catalog })).rejects.toThrow(/report-only|chỉ báo cáo/i);
      expect(fs.existsSync(target)).toBe(false);
    }

    // Real os.homedir() path outside os.tmpdir() MUST be refused deterministically
    const liveHermesPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    expect(() => assertHarnessWriteSandboxAllowed(liveHermesPath)).toThrow(/homedir|home|sandbox/i);

    const hermes = getHarnessWriteAdapter('hermes')!;
    await expect(hermes.apply({ configPath: liveHermesPath, catalog })).rejects.toThrow(/homedir|home|sandbox/i);
  });

  it('7. CLI subcommands `apps plan`, `apps apply --sandbox-copy`, and `apps rollback` execute end-to-end in os.tmpdir() and refuse live homedir', async () => {
    const configPath = path.join(tmpDir, 'cli-opencode.jsonc');
    const catalogPath = path.join(tmpDir, 'catalog.json');
    const initial = `{\n  // CLI E2E JSONC\n  "provider": {\n    "9router": {\n      "options": { "apiKey": "${FAKE_SECRET_A}" },\n      "models": { "m1": { "name": "M1" } }\n    }\n  }\n}\n`;
    fs.writeFileSync(configPath, initial, 'utf8');
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ '9router': { liveModels: ['m1', 'm2-cli'], deprecatedModels: [] } }),
      'utf8'
    );
    const preSha = sha256(fs.readFileSync(configPath));

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });

    await runAppsPlanCommand({ app: 'opencode', config: configPath, catalog: catalogPath, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(planJson.editable).toBe(true);
    expect(planJson.additions).toEqual([{ provider: '9router', model: 'm2-cli' }]);

    await runAppsApplyCommand({
      app: 'opencode',
      config: configPath,
      catalog: catalogPath,
      sandboxCopy: true,
      planHash: planJson.planHash,
      json: true,
    });
    const applyJson = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(applyJson.applied).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('m2-cli');

    await runAppsRollbackCommand({
      app: 'opencode',
      config: configPath,
      backup: applyJson.backupPath,
      json: true,
    });
    const rbJson = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(rbJson.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);

    // Detect running processes helper is hermetic with custom runner
    expect(detectRunningHarnessProcesses('dsh', () => ['dsh.exe'])).toEqual(['dsh.exe']);
  });
});
