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
 *  - Strict invariants tested to kill M1..M5 and QA Q1..Q6:
 *    M1: Keyless provider never receives additions/removals (including `.env` inline `# comment` & `maxTokens`)
 *    M2: Default model slot (incl. `automaticRecovery.backup`) & `baseURL`/`base_url`/`url` never mutated (kills Q1)
 *    M3: YAML/JSONC comments (incl. inline & mid-sequence inside `models:` and flow `models: [...]`) preserved
 *    M4: Auto-rollback to exact preSha256 on post-write read-back mismatch (incl. `baseURL` drift)
 *    M5: Refuses apply on report-only harnesses and refuses direct + symlink/junction `os.homedir()` paths
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import type { HarnessCatalogInput } from '@routersync/adapter-sdk';
import {
  appendApplyReceipt,
  appendResearchEvidence,
  readApplyHistory,
  researchEvidenceIdentity,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { AGENT_APP_ADAPTERS } from '../src/apps/inspect.js';
import { parseJsoncObject } from '../src/apps/lossless-edit.js';
import {
  assertHarnessWriteSandboxAllowed,
  detectRunningHarnessProcesses,
  getHarnessWriteAdapter,
  inspectTierAHarnessForTick,
  isHarnessRemovalProtectedDefaultSlot,
  listHarnessWriteAdapters,
} from '../src/apps/write-adapter.js';
import {
  runAppsApplyCommand,
  runAppsPlanCommand,
  runAppsRollbackCommand,
} from '../src/commands/apps.js';
import { runPilotReportCommand } from '../src/commands/pilot-report.js';

const FAKE_SECRET_A = ['sk', 'syntheticTestKeyAlpha987654'].join('-');
const FAKE_SECRET_B = ['sk', 'syntheticTestKeyBeta123456'].join('-');

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stubSimulatedHomeAndTmp(simulatedHome: string, simulatedTmp: string): void {
  vi.stubEnv('HOME', simulatedHome);
  vi.stubEnv('USERPROFILE', simulatedHome);
  vi.stubEnv('TMPDIR', simulatedTmp);
  vi.stubEnv('TEMP', simulatedTmp);
  vi.stubEnv('TMP', simulatedTmp);
}

describe('C45-WP2: Harness Write Adapters & Safety Invariants', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c45-wp2-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    fs.writeFileSync(
      envPath,
      [
        `NINE_ROUTER_API_KEY=${FAKE_SECRET_A}`,
        'COMMENTED_OUT_EMPTY_KEY= # not set yet',
        'QUOTED_EMPTY_KEY="" # empty quotes',
        '',
      ].join('\n'),
      'utf8'
    );

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
      '      - id: keep-model-1 # inline id comment preserved',
      '        name: Keep Model One # inline name comment preserved',
      '      - id: deprecated-coder-v1',
      '      # Mid-sequence comment inside models list MUST survive',
      '      - id: keep-model-2 # second surviving inline comment',
      '  keyless_provider:',
      '    # No key in YAML and only empty inline comment in .env -> MUST NOT BE TOUCHED (M1 / Bug #5)',
      '    base_url: https://example.invalid/v1',
      '    key_env: COMMENTED_OUT_EMPTY_KEY',
      '    models:',
      '      - id: keyless-old-model',
      'custom_providers:',
      '  - name: custom_keyed',
      '    base_url: https://example.invalid/custom',
      `    api_key: ${FAKE_SECRET_B}`,
      '    model: custom-keep',
      '    models: ["custom-keep", "custom-deprecated"] # flow models comment preserved',
      '# Trailing Hermes comment',
      '',
    ].join('\r\n');
    fs.writeFileSync(configPath, initialYaml, 'utf8');
    const preSha = sha256(fs.readFileSync(configPath));

    const catalog: HarnessCatalogInput = {
      '9router': {
        liveModels: ['keep-model-1', 'keep-model-2', 'new-verified-pro-2'],
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
    // M3 & Bug #2: Comments (including inline & mid-sequence inside models: and flow comment), CRLF, secrets, URLs, default slots preserved
    expect(afterText).toContain('# Hermes top banner comment — MUST stay byte-identical\r\n');
    expect(afterText).toContain('  default: deprecated-coder-v1 # inline default slot comment\r\n');
    expect(afterText).toContain('  model: deprecated-coder-v1\r\n');
    expect(afterText).toContain('# inline id comment preserved\r\n');
    expect(afterText).toContain('# inline name comment preserved\r\n');
    expect(afterText).toContain('# Mid-sequence comment inside models list MUST survive\r\n');
    expect(afterText).toContain('# second surviving inline comment\r\n');
    expect(afterText).toContain('# flow models comment preserved\r\n');
    expect(afterText).toContain('# No key in YAML and only empty inline comment in .env -> MUST NOT BE TOUCHED (M1 / Bug #5)\r\n');
    expect(afterText).toContain('# Trailing Hermes comment\r\n');
    expect(afterText).toContain(`    api_key: ${FAKE_SECRET_B}\r\n`);

    const parsed = parseDocument(afterText).toJS() as Record<string, any>;
    expect(parsed.model.default).toBe('deprecated-coder-v1');
    expect(parsed.cron.model).toBe('deprecated-coder-v1');
    expect(parsed.providers['9router'].base_url).toBe('http://127.0.0.1:9/v1');
    expect(parsed.providers.keyless_provider.base_url).toBe('https://example.invalid/v1');
    expect(parsed.custom_providers[0].base_url).toBe('https://example.invalid/custom');
    expect(parsed.providers['9router'].models.map((m: any) => m.id ?? m)).toEqual([
      'keep-model-1',
      'keep-model-2',
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

  it('2. openmausbot (JSON): updates instances.<id>.config.managedModels on keyed openai-compat only (M1), preserves key/url/model & automaticRecovery.backup (M2 / Bug #3), ignores maxTokens false-positive (Bug #5), refuses bots.json & routines.json, and round-trips byte-identically', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const initialJson = [
      '{',
      '  "defaultModelSelection": "old-omb-default",',
      '  "automaticRecovery": {',
      '    "backup": "old-omb-recovery-model"',
      '  },',
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
      '        "maxTokens": "8192",',
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
        deprecatedModels: ['old-omb-default', 'old-omb-recovery-model'],
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
    expect(plan.defaultSlotWarnings.some((w) => w.slot === 'defaultModelSelection')).toBe(true);
    expect(
      plan.defaultSlotWarnings.some(
        (w) => w.slot === 'automaticRecovery.backup' && w.currentModel === 'old-omb-recovery-model'
      )
    ).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(FAKE_SECRET_A);

    const applyRes = await adapter.apply({ configPath, catalog });
    expect(applyRes.applied).toBe(true);
    expect(applyRes.readBackVerified).toBe(true);
    expect(applyRes.reloadRequired).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, any>;
    expect(parsed.defaultModelSelection).toBe('old-omb-default');
    expect(parsed.automaticRecovery.backup).toBe('old-omb-recovery-model');
    expect(parsed.instances['openai-compat-keyed'].config.model).toBe('old-omb-default');
    expect(parsed.instances['openai-compat-keyed'].config.key).toBe(FAKE_SECRET_A);
    expect(parsed.instances['openai-compat-keyed'].config.url).toBe('http://127.0.0.1:9/v1');
    expect(parsed.instances['openai-compat-keyed'].config.managedModels).toEqual(['keep-omb-1', 'new-omb-2']);
    expect(parsed.instances['openai-compat-keyless'].config.url).toBe('https://example.invalid/v1');
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

  it('3. opencode (JSONC): updates keyed providers (options.apiKey & provider.<id>.env), preserves // and /* */ comments, baseURL & exact surrounding bytes (M1, M2, M3, Q1)', async () => {
    const configPath = path.join(tmpDir, 'opencode.jsonc');
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        `ENV_KEYED_OC_SECRET=${FAKE_SECRET_B}`,
        'ENV_COMMENT_ONLY= # not set yet',
        '',
      ].join('\n'),
      'utf8'
    );
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
      '    "env-keyed-oc": {',
      '      "env": ["ENV_KEYED_OC_SECRET"],',
      '      "options": { "baseURL": "https://api.env-keyed.invalid/v1" },',
      '      "models": {',
      '        "env-keep": { "name": "Env Keep" }',
      '      }',
      '    },',
      '    "keyless-oc": {',
      '      "env": ["ENV_COMMENT_ONLY"],',
      '      "options": { "baseURL": "https://example.invalid/v1", "maxTokens": "4096" },',
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
      'env-keyed-oc': {
        liveModels: ['env-keep', 'env-added-model'],
        deprecatedModels: [],
      },
      'keyless-oc': {
        liveModels: ['never-add-to-keyless'],
        deprecatedModels: ['untouched-model'],
      },
    };

    const adapter = getHarnessWriteAdapter('opencode')!;
    const plan = await adapter.plan({ configPath, catalog });
    expect(plan.editable).toBe(true);
    expect(plan.targetProviders).toEqual(['9router', 'env-keyed-oc']);
    expect(plan.additions).toEqual([
      { provider: '9router', model: 'new-oc-sonnet' },
      { provider: 'env-keyed-oc', model: 'env-added-model' },
    ]);
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
    expect(afterText).toContain('"env-added-model"');
    expect(afterText).not.toContain('"old-oc-model": { "name": "Deprecated OC" }');
    expect(afterText).toContain('"untouched-model": { "name": "Untouched" }');
    expect(afterText).not.toContain('never-add-to-keyless');

    // Kills Q1: explicitly verify baseURL & apiKey/env preservation across every OpenCode provider
    const parsedAfter = parseJsoncObject(afterText).value as Record<string, any>;
    expect(parsedAfter.provider['9router'].options.baseURL).toBe('http://127.0.0.1:9/v1');
    expect(parsedAfter.provider['9router'].options.apiKey).toBe(FAKE_SECRET_A);
    expect(parsedAfter.provider['env-keyed-oc'].options.baseURL).toBe('https://api.env-keyed.invalid/v1');
    expect(parsedAfter.provider['env-keyed-oc'].env).toEqual(['ENV_KEYED_OC_SECRET']);
    expect(parsedAfter.provider['keyless-oc'].options.baseURL).toBe('https://example.invalid/v1');

    // Second apply with identical catalog is a strict no-op (byte-identical)
    const afterFirstSha = sha256(fs.readFileSync(configPath));
    const noopRes = await adapter.apply({ configPath, catalog });
    expect(noopRes.preSha256).toBe(afterFirstSha);
    expect(noopRes.postSha256).toBe(afterFirstSha);

    const rb = await adapter.rollback({ configPath, backupPath: applyRes.backupPath });
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
  });

  it('4. dsh (YAML Cordis patch): updates keyed llm-pi-ai providers (block & flow models[]), preserves baseURL, sibling Cordis rows & comments byte-for-byte (M1, M2, M3, Bug #2)', async () => {
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
      '          - id: dsh-keep-1 # inline dsh comment',
      '            name: DSH Keep 1',
      '            contextWindow: 200000',
      '          - id: dsh-old-default',
      '      "flow-dsh":',
      '        displayName: Flow Provider',
      '        apiKeyEnv: FLOW_API_KEY',
      '        baseURL: https://api.flow-dsh.invalid/v1',
      '        models: ["flow-dsh-keep", "flow-dsh-drop"]',
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
      'flow-dsh': {
        liveModels: ['flow-dsh-keep', 'flow-dsh-added'],
        deprecatedModels: ['flow-dsh-drop'],
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
    expect(plan.targetProviders).toEqual(['9router', 'flow-dsh']);
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
    expect(afterText).toContain('# inline dsh comment');
    expect(afterText).toContain('model: dsh-old-default');
    expect(afterText).toContain('selectedDefault: 9router/dsh-old-default');

    const rows = parseDocument(afterText).toJS() as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.config.model).toBe('dsh-old-default');
    expect(rows[2]?.config.keepFlag).toBe(true);
    const piProviders = rows[1]?.config.providers;
    expect(piProviders['9router'].displayName).toBe('Local Router');
    expect(piProviders['9router'].baseURL).toBe('http://127.0.0.1:9/v1');
    expect(piProviders['9router'].models.map((m: any) => m.id)).toEqual(['dsh-keep-1', 'dsh-new-v3']);
    expect(piProviders['9router'].models[0].contextWindow).toBe(200000);
    expect(piProviders['flow-dsh'].baseURL).toBe('https://api.flow-dsh.invalid/v1');
    expect(piProviders['flow-dsh'].models.map((m: any) => m.id ?? m)).toEqual([
      'flow-dsh-keep',
      'flow-dsh-added',
    ]);
    expect(piProviders['keyless-dsh'].baseURL).toBe('https://example.invalid/v1');
    expect(piProviders['keyless-dsh'].models).toEqual([{ id: 'keyless-stay' }]);

    const rb = await adapter.rollback({ configPath, backupPath: applyRes.backupPath });
    expect(rb.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
  });

  it('5. Auto-rolls back immediately when post-write read-back detects model OR baseURL/endpoint corruption (kills M4 & Q1)', async () => {
    const configPath = path.join(tmpDir, 'opencode-fault.jsonc');
    const initial = [
      '{',
      '  // Must survive failed apply via automatic rollback',
      '  "provider": {',
      '    "9router": {',
      `      "options": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "${FAKE_SECRET_A}" },`,
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
          // Simulate mid-flight model corruption before read-back verification
          fs.writeFileSync(configPath, '{ "provider": { "9router": { "models": {} } } }', 'utf8');
        },
      })
    ).rejects.toThrow(/read-back|rollback/i);

    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(initial);

    // Bug #5 / Q1: If baseURL is altered while model list matches expected, read-back MUST reject & rollback!
    await expect(
      adapter.apply({
        configPath,
        catalog: { '9router': { liveModels: ['m1', 'm2'], deprecatedModels: [] } },
        injectReadBackFault: (writtenText) => {
          fs.writeFileSync(
            configPath,
            writtenText.replace('http://127.0.0.1:9/v1', 'https://hijacked.invalid/v1'),
            'utf8'
          );
        },
      })
    ).rejects.toThrow(/baseURL|endpoint|read-back/i);

    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(initial);
  });

  it('6. Enforces report-only refusal for claude-code, codex, antigravity, cursor, grok-bot AND refuses direct + symlink/junction os.homedir() paths (kills M5 & Bug #1)', async () => {
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

    // Bug #1: Symlink / Windows junction inside os.tmpdir() pointing to os.homedir()
    // with non-existent nested subdirectory MUST be refused deterministically.
    const simulatedHome = path.join(tmpDir, 'sim-real-home');
    const simulatedTmp = path.join(tmpDir, 'sim-os-tmp');
    fs.mkdirSync(simulatedHome, { recursive: true });
    fs.mkdirSync(simulatedTmp, { recursive: true });

    const homeJunction = path.join(simulatedTmp, 'junction-to-home');
    fs.symlinkSync(
      simulatedHome,
      homeJunction,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    stubSimulatedHomeAndTmp(simulatedHome, simulatedTmp);

    const sneakyNestedPath = path.join(homeJunction, 'nonexistent-subdir', 'config.yaml');
    expect(() => assertHarnessWriteSandboxAllowed(sneakyNestedPath)).toThrow(/homedir|home|sandbox/i);
    await expect(hermes.apply({ configPath: sneakyNestedPath, catalog })).rejects.toThrow(/homedir|home|sandbox/i);
    expect(fs.existsSync(path.join(simulatedHome, 'nonexistent-subdir'))).toBe(false);
  });

  it('7. CLI subcommands `apps plan`, `apps apply --sandbox-copy`, and `apps rollback` execute end-to-end in os.tmpdir(), isolate host os.homedir(), and honor symmetric `--home` (Bug #4)', async () => {
    // Simulate a host machine whose real os.homedir() has OpenCode auth.json for 'host-leaked-prov'
    const simulatedHostHome = path.join(tmpDir, 'sim-host-home');
    const simulatedTmpRoot = path.join(tmpDir, 'sim-tmp-root');
    const explicitSandboxHome = path.join(simulatedTmpRoot, 'custom-sandbox-home');
    fs.mkdirSync(path.join(simulatedHostHome, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(simulatedHostHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ 'host-leaked-prov': { key: FAKE_SECRET_B } }),
      'utf8'
    );
    fs.mkdirSync(path.join(explicitSandboxHome, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(explicitSandboxHome, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ 'sandbox-auth-prov': { key: FAKE_SECRET_A } }),
      'utf8'
    );

    stubSimulatedHomeAndTmp(simulatedHostHome, simulatedTmpRoot);

    const configPath = path.join(simulatedTmpRoot, 'cli-opencode.jsonc');
    const catalogPath = path.join(simulatedTmpRoot, 'catalog.json');
    const initial = [
      '{',
      '  // CLI E2E JSONC',
      '  "provider": {',
      '    "9router": {',
      `      "options": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "${FAKE_SECRET_A}" },`,
      '      "models": { "m1": { "name": "M1" } }',
      '    },',
      '    "host-leaked-prov": {',
      '      "options": { "baseURL": "https://host-leak.invalid/v1" },',
      '      "models": { "leak-m1": { "name": "Leak M1" } }',
      '    },',
      '    "sandbox-auth-prov": {',
      '      "options": { "baseURL": "https://sandbox-auth.invalid/v1" },',
      '      "models": { "sb-m1": { "name": "SB M1" } }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, initial, 'utf8');
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        '9router': { liveModels: ['m1', 'm2-cli'], deprecatedModels: [] },
        'host-leaked-prov': { liveModels: ['leak-m1', 'leak-injected'], deprecatedModels: [] },
        'sandbox-auth-prov': { liveModels: ['sb-m1', 'sb-m2-home'], deprecatedModels: [] },
      }),
      'utf8'
    );
    const preSha = sha256(fs.readFileSync(configPath));

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });

    // (a) Without --home: MUST NOT leak simulatedHostHome auth.json, and planHash MUST match apply!
    await runAppsPlanCommand({ app: 'opencode', config: configPath, catalog: catalogPath, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(planJson.editable).toBe(true);
    expect(planJson.targetProviders).toEqual(['9router']);
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
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('leak-injected');

    await runAppsRollbackCommand({
      app: 'opencode',
      config: configPath,
      backup: applyJson.backupPath,
      json: true,
    });
    const rbJson = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(rbJson.byteIdenticalToPreApply).toBe(true);
    expect(sha256(fs.readFileSync(configPath))).toBe(preSha);

    // (b) With explicit symmetric --home: plan & apply both use explicitSandboxHome and match planHash!
    await runAppsPlanCommand({
      app: 'opencode',
      config: configPath,
      catalog: catalogPath,
      home: explicitSandboxHome,
      json: true,
    });
    const planWithHome = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(planWithHome.targetProviders).toEqual(['9router', 'sandbox-auth-prov']);

    await runAppsApplyCommand({
      app: 'opencode',
      config: configPath,
      catalog: catalogPath,
      home: explicitSandboxHome,
      sandboxCopy: true,
      planHash: planWithHome.planHash,
      json: true,
    });
    const applyWithHome = JSON.parse(out.splice(0).join('')) as Record<string, any>;
    expect(applyWithHome.applied).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('sb-m2-home');
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('leak-injected');

    // Detect running processes helper is hermetic with custom runner
    expect(detectRunningHarnessProcesses('dsh', () => ['dsh.exe'])).toEqual(['dsh.exe']);
  });
});

describe('C48 apps apply removal gate', () => {
  const day = 86_400_000;
  const targetScope = 'harness:hermes';
  const provider = 'openai';
  const model = 'gpt-fixture-retired';
  const fullStep = `${provider}/${model}`;
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c48-apps-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(testCase: string, level: 'propose' | 'auto-safe' = 'auto-safe') {
    const stateDir = path.join(root, 'state');
    const config = path.join(root, 'config.yaml');
    const backup = path.join(root, 'backup.yaml');
    const now = Date.now();
    const iso = (time: number) => new Date(time).toISOString();
    const first = now - (testCase === 'three scans under 24h' ? 3_600_000 : day + 60_000);
    const count = testCase === 'two scans' ? 2
      : ['synthetic official', 'genuine official', 'wrong evidence'].includes(testCase) ? 0 : 3;
    const liveModels = ['gpt-4.1', ...Array.from({ length: testCase === 'shrink cap' ? 3 : 8 }, (_, index) => `gpt-fixture-${index}`)];
    fs.writeFileSync(path.join(root, '.env'), ['OPENAI_API_KEY', FAKE_SECRET_A].join('='));
    fs.writeFileSync(config, [
      'model:', '  provider: openai', `  default: openai/${testCase === 'protected default' ? model : 'gpt-4.1'}`, 'providers:',
      '  openai:', '    base_url: https://api.openai.com/v1', '    api_key_env: OPENAI_API_KEY',
      '    models:', ...[...liveModels, model].map((id) => `      - ${id}`), '',
    ].join('\n'));
    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'propose', nowMs: now - 5_000 });
    appendApplyReceipt(stateDir, {
      target: targetScope, planHash: 'fixture-initial-plan', appliedAt: iso(now - 4_000),
      appliedAtLevel: 'propose', authorizedVia: 'interactive-tty', snapshotOrBackupRef: 'fixture-initial-backup',
      success: true, readBackVerified: true, readBackLevel: 'file-byte-verified', rolledBack: false,
    });
    if (level === 'auto-safe') upsertStandingConsentTarget(stateDir, { target: targetScope, level, nowMs: now - 3_000 });
    const episodeId = `ep-${JSON.stringify([provider, model, first])}`;
    const official = count === 0 || ['manual synthetic', 'withdrawn', 'future official'].includes(testCase)
      ? appendResearchEvidence(stateDir, {
      provider, modelId: model, url: 'https://platform.openai.com/docs/deprecations', verdict: 'deprecated',
      quote: 'Fixture notice of a now-effective retirement.', publishedAt: iso(first - day),
      shutdownDate: iso(testCase === 'future official' ? now + day : first - 3_600_000), submittedAt: iso(first - 1_000),
      synthetic: ['synthetic official', 'manual synthetic'].includes(testCase), submittedVia: 'cli',
    }) : null;
    if (testCase === 'withdrawn') {
      appendResearchEvidence(stateDir, {
        provider, modelId: model, url: 'https://platform.openai.com/docs/deprecations', verdict: 'active',
        quote: 'Fixture notice withdrawal.', submittedAt: iso(now - 2_000), submittedVia: 'cli',
      });
    }
    const evidenceId = official && testCase !== 'wrong evidence' ? researchEvidenceIdentity(official) : 'different-claim';
    fs.writeFileSync(path.join(stateDir, 'tick-catalog.json'), JSON.stringify({
      version: 1, updatedAt: iso(now - 1_000),
      providers: {
        openai: {
          prefix: provider, ids: liveModels, absenceCounts: { [model]: count },
          firstAbsentAt: testCase === 'missing firstAbsentAt' ? {} : { [model]: iso(first) },
          pendingEpisodes: { [model]: testCase === 'wrong episode' ? 'different-episode' : episodeId },
          qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 1_000)],
          lastStatus: testCase === 'unverifiable' ? 503 : 200,
          lastLabel: testCase === 'unverifiable' ? 'API_ERROR' : 'OK', updatedAt: iso(now - 1_000),
        },
      },
      absenceDetections: count === 0 ? [] : [{
        episodeId, provider: testCase === 'wrong provider' ? 'other-provider' : provider,
        modelId: model, fullStep, status: 'model_pending', scanStartedAt: iso(first),
        modelPendingAt: iso(first + 90), detectionMs: 90,
        targetsAffected: [testCase === 'wrong target' ? 'harness:opencode' : targetScope],
      }],
      officialNoticeDetections: !official ? [] : [{
        recordKey: JSON.stringify([fullStep, evidenceId, iso(first)]),
        evidenceId, provider, modelId: model, fullStep, firstQualifyingScanStartedAt: iso(first),
        episodeStartedAt: iso(first), firstPlanCreatedAt: iso(first + 90), detectionMs: 90,
        sourcePublishedAt: official.publishedAt, publicationToPlanMs: day + 90,
        targetsAffected: [targetScope], synthetic: official.synthetic === true,
      }],
    }));
    return {
      args: { app: 'hermes', config, stateDir, backup, home: root, write: true, isTTY: false, json: true },
      config, backup, stateDir, configBefore: fs.readFileSync(config),
      receiptBefore: fs.readFileSync(path.join(stateDir, 'apply-history.json')),
    };
  }

  it.each(['two scans', 'three scans under 24h', 'synthetic official', 'wrong target', 'wrong episode',
    'wrong provider', 'wrong evidence'])('C48 apps blocks %s before any write', async (scenario) => {
    const fx = fixture(scenario);
    await expect(runAppsApplyCommand(fx.args)).rejects.toThrow('C48_REMOVAL_INELIGIBLE');
    expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
    expect(fs.existsSync(fx.backup)).toBe(false);
    expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
  });

  it('C48 apps rejects a custom catalog under auto-safe even with qualified evidence', async () => {
    const fx = fixture('qualified absence');
    const catalog = path.join(root, 'explicit-catalog.json');
    const authoritative = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8'));
    fs.writeFileSync(catalog, JSON.stringify({
      openai: { liveModels: authoritative.providers.openai.ids, deprecatedModels: [model] },
    }));
    await expect(runAppsApplyCommand({ ...fx.args, catalog })).rejects.toThrow('CUSTOM_CATALOG_FORBIDDEN');
    expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
    expect(fs.existsSync(fx.backup)).toBe(false);
    expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
  });

  it.each(['qualified absence', 'genuine official'])('C48 apps applies %s and signs its episode', async (scenario) => {
    const fx = fixture(scenario);
    const apply = vi.spyOn(getHarnessWriteAdapter('hermes')!, 'apply');
    await runAppsApplyCommand(fx.args);
    expect(fs.readFileSync(fx.config, 'utf8')).not.toContain(model);
    expect(fs.readFileSync(fx.backup)).toEqual(fx.configBefore);
    const history = readApplyHistory(fx.stateDir);
    expect(history.valid).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0].expectedPlanHash).toBe(history.receipts.at(-1)?.planHash);
    const catalog = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8'));
    const episodes = scenario === 'genuine official' ? catalog.officialNoticeDetections : catalog.absenceDetections;
    expect(episodes[0].removedAt).toBe(history.receipts.at(-1)?.appliedAt);
    expect(history.receipts.at(-1)).toMatchObject({
      target: targetScope, appliedAtLevel: 'auto-safe', success: true, readBackVerified: true,
      removedModels: [{
        provider, modelId: model, inProviderCatalog: false, detectionEpisodeId: expect.any(String),
        ...(scenario === 'genuine official'
          ? { removalPath: 'official-notice', detectionEvidenceId: expect.any(String), syntheticNotice: false }
          : { removalPath: 'absence-only', qualifyingScanCount: 3 }),
      }],
    });
  });

  it.each([
    ['shrink cap', 'SHRINK_CAP_EXCEEDED'],
    ['protected default', 'DEFAULT_SLOT_PROTECTED'],
  ])('C48 apps blocks %s without touching the target', async (scenario, reason) => {
    const fx = fixture(scenario);
    await expect(runAppsApplyCommand(fx.args)).rejects.toThrow(reason);
    expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
    expect(fs.existsSync(fx.backup)).toBe(false);
    expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
  });

  it.each(['two scans', 'manual synthetic', 'unverifiable', 'withdrawn', 'future official'])(
    'C48 manual hard-blocks %s even with TTY', async (scenario) => {
      const fx = fixture(scenario, 'propose');
      const catalog = path.join(root, 'manual-candidate.json');
      fs.writeFileSync(catalog, JSON.stringify({ openai: { liveModels: [], deprecatedModels: [model] } }));
      const promptFn = vi.fn(async () => 'chay');
      await expect(runAppsApplyCommand({ ...fx.args, catalog, isTTY: true, promptFn }))
        .rejects.toThrow('C48_REMOVAL_INELIGIBLE');
      expect(promptFn).not.toHaveBeenCalled();
      expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
      expect(fs.existsSync(fx.backup)).toBe(false);
      expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
    }
  );

  it.each(['three scans under 24h', 'missing firstAbsentAt'])(
    'C48 manual shows the %s override before explicit confirmation', async (scenario) => {
      const fx = fixture(scenario, 'propose');
      const catalog = path.join(root, 'manual-candidate.json');
      fs.writeFileSync(catalog, JSON.stringify({ openai: { liveModels: [], deprecatedModels: [model] } }));
      const promptFn = vi.fn(async () => 'chay');
      await expect(runAppsApplyCommand({ ...fx.args, catalog, promptFn })).rejects.toThrow('TTY_REQUIRED');
      expect(promptFn).not.toHaveBeenCalled();
      expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
      const write = vi.spyOn(process.stderr, 'write');
      await runAppsApplyCommand({ ...fx.args, catalog, isTTY: true, promptFn: async () => 'cancel' });
      expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
      const preview = write.mock.calls.map(([message]) => String(message)).join('');
      expect(preview).toContain('C48_TTY_OVERRIDE');
      expect(preview).toContain(`Remove ${fullStep}`);
      expect(preview).toContain(scenario === 'missing firstAbsentAt' ? 'firstAbsentAt is missing' : 'under 24 hours');
      await runAppsApplyCommand({ ...fx.args, catalog, isTTY: true, promptFn });
      expect(promptFn).toHaveBeenCalledOnce();
      expect(fs.readFileSync(fx.config, 'utf8')).not.toContain(model);
      const receipt = readApplyHistory(fx.stateDir).receipts.at(-1);
      expect(receipt).toMatchObject({
        appliedAtLevel: 'propose', authorizedVia: 'interactive-tty', success: true,
        removedModels: [{ provider, modelId: model, detectionEpisodeId: expect.any(String) }],
      });
      const savedCatalog = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'tick-catalog.json'), 'utf8'));
      expect(savedCatalog.absenceDetections[0].removedAt).toBe(receipt?.appliedAt);
      const report = await runPilotReportCommand({ stateDir: fx.stateDir, nowMs: Date.now() + 1_000, silent: true });
      expect(report.blockingReasons.join('\n')).not.toContain('S9_REMOVAL_DETECTION_INCOMPLETE');
      expect(report.removalSettle.status).toBe(scenario === 'missing firstAbsentAt' ? 'INCOMPLETE' : 'FAIL');
    }
  );

  it('C48 apps leaves the episode open when the adapter rolls back a failed read-back', async () => {
    const fx = fixture('qualified absence');
    const adapter = getHarnessWriteAdapter('hermes')!;
    const apply = adapter.apply.bind(adapter);
    vi.spyOn(adapter, 'apply').mockImplementationOnce((options) => apply({ ...options, injectReadBackFault: true }));
    const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
    const before = fs.readFileSync(catalogPath);
    await expect(runAppsApplyCommand(fx.args)).rejects.toThrow('read-back');
    expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
    expect(fs.readFileSync(catalogPath)).toEqual(before);
    expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
  });

  it.each(['A', 'B', 'C'])('C48 sandbox-copy accepts Format %s without writing C48 state', async (format) => {
    const fx = fixture('two scans');
    const catalog = path.join(root, 'sandbox-catalog.json');
    const stateDir = path.join(root, 'sandbox-only-state');
    const candidate = { liveModels: [], deprecatedModels: [model] };
    fs.writeFileSync(catalog, JSON.stringify(format === 'A' ? { openai: candidate }
      : format === 'B' ? { providers: { openai: candidate } }
        : { providers: { openai: { ids: ['gpt-4.1'], absenceCounts: { [model]: 2 } } } }));
    await runAppsApplyCommand({ ...fx.args, stateDir, catalog, write: false, sandboxCopy: true });
    expect(fs.readFileSync(fx.config, 'utf8')).not.toContain(model);
    expect(fs.readFileSync(fx.backup)).toEqual(fx.configBefore);
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.readFileSync(path.join(fx.stateDir, 'apply-history.json'))).toEqual(fx.receiptBefore);
  });

  it.each(['hermes', 'openmausbot'] as const)(
    'QA-FINAL-1: blocks auto-safe removal of slashed default slot (%s openrouter openai/gpt-or-retired) until a verified live replacement exists',
    async (appName) => {
      const stateDir = path.join(root, `state-qaf1-${appName}`);
      const target = `harness:${appName}`;
      const prov = 'openrouter';
      const slashedRetired = 'openai/gpt-or-retired';
      const slashedStep = `${prov}/${slashedRetired}`;
      const liveOrModels = Array.from({ length: 9 }, (_, i) => `openai/gpt-live-${i}`);
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const first = now - day - 60_000;

      const configPath =
        appName === 'hermes'
          ? path.join(root, 'hermes-or.yaml')
          : path.join(root, 'openmausbot-models.json');
      const backupPath = `${configPath}.bak`;

      if (appName === 'hermes') {
        fs.writeFileSync(path.join(root, '.env'), `OPENROUTER_API_KEY=${FAKE_SECRET_A}\n`);
        fs.writeFileSync(
          configPath,
          [
            'model:',
            '  provider: openrouter',
            `  default: ${slashedRetired}`,
            'providers:',
            '  openrouter:',
            '    base_url: https://openrouter.ai/api/v1',
            '    api_key_env: OPENROUTER_API_KEY',
            '    models:',
            ...[...liveOrModels, slashedRetired].map((m) => `      - ${m}`),
            '',
          ].join('\n')
        );
      } else {
        fs.writeFileSync(
          configPath,
          JSON.stringify(
            {
              defaultModel: slashedRetired,
              instances: {
                openrouter: {
                  driver: 'openai-compat',
                  config: {
                    baseUrl: 'https://openrouter.ai/api/v1',
                    apiKey: FAKE_SECRET_A,
                    managedModels: [...liveOrModels, slashedRetired],
                  },
                },
              },
            },
            null,
            2
          )
        );
      }

      upsertStandingConsentTarget(stateDir, { target, level: 'propose', nowMs: now - 5_000 });
      appendApplyReceipt(stateDir, {
        target,
        planHash: 'qaf1-initial',
        appliedAt: iso(now - 4_000),
        appliedAtLevel: 'propose',
        authorizedVia: 'interactive-tty',
        snapshotOrBackupRef: 'qaf1-initial-bak',
        success: true,
        readBackVerified: true,
        readBackLevel: 'file-byte-verified',
        rolledBack: false,
      });
      upsertStandingConsentTarget(stateDir, { target, level: 'auto-safe', nowMs: now - 3_000 });

      const noticeNoReplacement = appendResearchEvidence(stateDir, {
        provider: prov,
        modelId: slashedRetired,
        url: 'https://openrouter.ai/docs/models',
        verdict: 'deprecated',
        quote: 'Retired slashed OpenRouter model without live replacement.',
        publishedAt: iso(first - day),
        shutdownDate: iso(first - 3_600_000),
        submittedAt: iso(first - 1_000),
        submittedVia: 'cli',
      });
      const writeCatalogFor = (evId: string, pubIso: string) => {
        fs.writeFileSync(
          path.join(stateDir, 'tick-catalog.json'),
          JSON.stringify({
            version: 1,
            updatedAt: iso(now - 500),
            providers: {
              // Also include 'openai' in catalog to prove openrouter/openai/... never misroutes to catalog['openai']
              openai: {
                prefix: 'openai',
                ids: ['gpt-4.1'],
                absenceCounts: {},
                qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 500)],
                lastStatus: 200,
                lastLabel: 'OK',
                updatedAt: iso(now - 500),
              },
              openrouter: {
                prefix: prov,
                ids: liveOrModels,
                absenceCounts: { [slashedRetired]: 3 },
                firstAbsentAt: { [slashedRetired]: iso(first) },
                qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 500)],
                lastStatus: 200,
                lastLabel: 'OK',
                updatedAt: iso(now - 500),
              },
            },
            absenceDetections: [],
            officialNoticeDetections: [
              {
                recordKey: JSON.stringify([slashedStep, evId, iso(first)]),
                evidenceId: evId,
                provider: prov,
                modelId: slashedRetired,
                fullStep: slashedStep,
                firstQualifyingScanStartedAt: iso(first),
                episodeStartedAt: iso(first),
                firstPlanCreatedAt: iso(first + 90),
                detectionMs: 90,
                sourcePublishedAt: pubIso,
                publicationToPlanMs: day + 90,
                targetsAffected: [target],
                synthetic: false,
              },
            ],
          })
        );
      };

      writeCatalogFor(researchEvidenceIdentity(noticeNoReplacement), iso(first - day));

      const planOut: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
        planOut.push(String(c));
        return true;
      });
      await runAppsPlanCommand({ app: appName, config: configPath, stateDir, home: root, json: true });
      const parsedPlan = JSON.parse(planOut.splice(0).join('')) as {
        defaultSlotWarnings: Array<{ slot: string; currentModel: string; suggestion: string }>;
      };
      expect(parsedPlan.defaultSlotWarnings).toContainEqual(
        expect.objectContaining({
          currentModel: slashedRetired,
          suggestion: liveOrModels[0],
        })
      );

      const beforeBytes = fs.readFileSync(configPath);
      const historyBefore = fs.readFileSync(path.join(stateDir, 'apply-history.json'));

      await expect(
        runAppsApplyCommand({
          app: appName,
          config: configPath,
          backup: backupPath,
          stateDir,
          home: root,
          write: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow('DEFAULT_SLOT_PROTECTED');
      expect(fs.readFileSync(configPath)).toEqual(beforeBytes);
      expect(fs.existsSync(backupPath)).toBe(false);
      expect(fs.readFileSync(path.join(stateDir, 'apply-history.json'))).toEqual(historyBefore);

      // Now submit an updated genuine notice with a verified live slashed replacement
      const noticeWithReplacement = appendResearchEvidence(stateDir, {
        provider: prov,
        modelId: slashedRetired,
        url: 'https://openrouter.ai/docs/models',
        verdict: 'deprecated',
        quote: 'Retired slashed OpenRouter model with live replacement.',
        publishedAt: iso(first - day),
        shutdownDate: iso(first - 3_600_000),
        submittedAt: iso(now - 800),
        replacementModelId: liveOrModels[0]!,
        submittedVia: 'cli',
      });
      writeCatalogFor(researchEvidenceIdentity(noticeWithReplacement), iso(first - day));

      await runAppsApplyCommand({
        app: appName,
        config: configPath,
        backup: backupPath,
        stateDir,
        home: root,
        write: true,
        isTTY: false,
        json: true,
      });
      expect(fs.readFileSync(configPath, 'utf8')).not.toContain(`- ${slashedRetired}`);
      if (appName === 'openmausbot') {
        const afterJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(afterJson.instances.openrouter.config.managedModels).not.toContain(slashedRetired);
        // Active default slot itself is never rewritten automatically
        expect(afterJson.defaultModel).toBe(slashedRetired);
      }
    }
  );

  it('QA-FINAL-2: filters premature/L2/synthetic/live/active-corrected candidates in apps plan & allows eligible candidate when paired with ineligible candidate in auto-safe', async () => {
    const stateDir = path.join(root, 'state-qaf2');
    const configPath = path.join(root, 'config-qaf2.yaml');
    const backupPath = path.join(root, 'backup-qaf2.yaml');
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const settledStart = now - day - 60_000;
    const recentStart = now - 3_600_000;

    const liveModels = Array.from({ length: 9 }, (_, i) => `gpt-live-${i}`);
    const eligibleDead = 'gpt-eligible-dead';
    const twoScansModel = 'gpt-premature-2scans';
    const under24hModel = 'gpt-under-24h';
    const l2Model = 'gpt-in-l2';
    const activeCorrected = 'gpt-active-corrected';
    const syntheticOnly = 'gpt-synthetic-only';
    const stillLiveInIds = liveModels[0]!;

    fs.writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${FAKE_SECRET_A}\n`);
    fs.writeFileSync(
      configPath,
      [
        'model:',
        '  provider: openai',
        `  default: openai/${liveModels[1]}`,
        'providers:',
        '  openai:',
        '    base_url: https://api.openai.com/v1',
        '    api_key_env: OPENAI_API_KEY',
        '    models:',
        ...[
          ...liveModels,
          eligibleDead,
          twoScansModel,
          under24hModel,
          l2Model,
          activeCorrected,
          syntheticOnly,
        ].map((m) => `      - ${m}`),
        '',
      ].join('\n')
    );

    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'propose', nowMs: now - 5_000 });
    appendApplyReceipt(stateDir, {
      target: targetScope,
      planHash: 'qaf2-initial',
      appliedAt: iso(now - 4_000),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: 'qaf2-initial-bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
    });
    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'auto-safe', nowMs: now - 3_000 });

    // Older deprecated notice followed by newer active correction on activeCorrected
    appendResearchEvidence(stateDir, {
      provider,
      modelId: activeCorrected,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'deprecated',
      quote: 'Older retirement notice later rescinded.',
      publishedAt: iso(settledStart - day),
      shutdownDate: iso(settledStart - 3_600_000),
      submittedAt: iso(settledStart - 2_000),
      submittedVia: 'cli',
    });
    appendResearchEvidence(stateDir, {
      provider,
      modelId: activeCorrected,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'active',
      quote: 'Model remains active; prior deprecation withdrawn.',
      submittedAt: iso(now - 2_000),
      submittedVia: 'cli',
    });

    // Deprecated notice for a model that is STILL LIVE in entry.ids -> must NOT be removed
    appendResearchEvidence(stateDir, {
      provider,
      modelId: stillLiveInIds,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'deprecated',
      quote: 'Notice on model still returned by live /v1/models.',
      publishedAt: iso(settledStart - day),
      shutdownDate: iso(settledStart - 3_600_000),
      submittedAt: iso(settledStart - 2_000),
      submittedVia: 'cli',
    });

    // Synthetic notice -> must NOT enter deprecatedModels
    appendResearchEvidence(stateDir, {
      provider,
      modelId: syntheticOnly,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'deprecated',
      quote: 'Synthetic drill notice.',
      publishedAt: iso(settledStart - day),
      shutdownDate: iso(settledStart - 3_600_000),
      submittedAt: iso(settledStart - 2_000),
      synthetic: true,
      submittedVia: 'cli',
    });

    // L2 cache corroborates l2Model
    fs.writeFileSync(
      path.join(stateDir, 'l2-cache.json'),
      JSON.stringify({
        updatedAt: iso(now - 1_000),
        models: { [`:unused:`]: {}, [`${provider}/${l2Model}`]: { id: `${provider}/${l2Model}`, provider } },
      })
    );

    const eligibleEpId = `ep-${JSON.stringify([provider, eligibleDead, settledStart])}`;
    const twoScansEpId = `ep-${JSON.stringify([provider, twoScansModel, settledStart])}`;
    const under24hEpId = `ep-${JSON.stringify([provider, under24hModel, recentStart])}`;
    const l2EpId = `ep-${JSON.stringify([provider, l2Model, settledStart])}`;

    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: iso(now - 500),
        providers: {
          openai: {
            prefix: provider,
            ids: liveModels,
            absenceCounts: {
              [eligibleDead]: 3,
              [twoScansModel]: 2,
              [under24hModel]: 3,
              [l2Model]: 3,
              [activeCorrected]: 4,
            },
            firstAbsentAt: {
              [eligibleDead]: iso(settledStart),
              [twoScansModel]: iso(settledStart),
              [under24hModel]: iso(recentStart),
              [l2Model]: iso(settledStart),
              [activeCorrected]: iso(settledStart),
            },
            pendingEpisodes: {
              [eligibleDead]: eligibleEpId,
              [twoScansModel]: twoScansEpId,
              [under24hModel]: under24hEpId,
              [l2Model]: l2EpId,
            },
            qualifyingScanTimestamps: [iso(settledStart), iso(recentStart), iso(now - 500)],
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: iso(now - 500),
          },
        },
        absenceDetections: [
          {
            episodeId: eligibleEpId,
            provider,
            modelId: eligibleDead,
            fullStep: `${provider}/${eligibleDead}`,
            status: 'model_pending',
            scanStartedAt: iso(settledStart),
            modelPendingAt: iso(settledStart + 50),
            detectionMs: 50,
            targetsAffected: [targetScope],
          },
          {
            episodeId: twoScansEpId,
            provider,
            modelId: twoScansModel,
            fullStep: `${provider}/${twoScansModel}`,
            status: 'model_pending',
            scanStartedAt: iso(settledStart),
            modelPendingAt: iso(settledStart + 50),
            detectionMs: 50,
            targetsAffected: [targetScope],
          },
          {
            episodeId: under24hEpId,
            provider,
            modelId: under24hModel,
            fullStep: `${provider}/${under24hModel}`,
            status: 'model_pending',
            scanStartedAt: iso(recentStart),
            modelPendingAt: iso(recentStart + 50),
            detectionMs: 50,
            targetsAffected: [targetScope],
          },
          {
            episodeId: l2EpId,
            provider,
            modelId: l2Model,
            fullStep: `${provider}/${l2Model}`,
            status: 'model_pending',
            scanStartedAt: iso(settledStart),
            modelPendingAt: iso(settledStart + 50),
            detectionMs: 50,
            targetsAffected: [targetScope],
          },
        ],
        officialNoticeDetections: [],
      })
    );

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });

    await runAppsPlanCommand({ app: 'hermes', config: configPath, stateDir, home: root, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as {
      additions: Array<{ provider: string; model: string }>;
      removals: Array<{ provider: string; model: string }>;
    };
    expect(planJson.additions).toEqual([]);
    expect(planJson.removals).toEqual([{ provider: 'openai', model: eligibleDead, reason: 'deprecated-upstream' }]);

    // Auto-safe apply removes ONLY eligibleDead without being poisoned by the ineligible siblings
    await runAppsApplyCommand({
      app: 'hermes',
      config: configPath,
      backup: backupPath,
      stateDir,
      home: root,
      write: true,
      isTTY: false,
      json: true,
    });
    const afterYaml = fs.readFileSync(configPath, 'utf8');
    expect(afterYaml).not.toContain(eligibleDead);
    expect(afterYaml).toContain(stillLiveInIds);
    expect(afterYaml).toContain(twoScansModel);
    expect(afterYaml).toContain(under24hModel);
    expect(afterYaml).toContain(l2Model);
    expect(afterYaml).toContain(activeCorrected);
    expect(afterYaml).toContain(syntheticOnly);

    // Under manual propose (reading tick-catalog.json directly without --catalog), under24hModel (>=3 scans, !L2)
    // surfaces with WARNING C48_TTY_OVERRIDE while l2Model / 2-scan / activeCorrected remain excluded.
    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'propose', nowMs: now - 100 });
    const errOut: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      errOut.push(String(c));
      return true;
    });
    await runAppsApplyCommand({
      app: 'hermes',
      config: configPath,
      backup: backupPath,
      stateDir,
      home: root,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(errOut.join('')).toContain(`C48_TTY_OVERRIDE: ${provider}/${under24hModel}`);
    const afterProposeYaml = fs.readFileSync(configPath, 'utf8');
    expect(afterProposeYaml).not.toContain(under24hModel);
    expect(afterProposeYaml).toContain(l2Model);
    expect(afterProposeYaml).toContain(twoScansModel);
    expect(afterProposeYaml).toContain(activeCorrected);
  });

  it.each(['qualified absence', 'genuine official'])(
    'QA-FINAL-4: apps rollback reconciles episode & pendingEpisodes only on byte-exact restore and allows clean reapply preserving detectionMs (%s)',
    async (scenario) => {
      const fx = fixture(scenario);
      await runAppsApplyCommand(fx.args);
      expect(fs.readFileSync(fx.config, 'utf8')).not.toContain(model);

      const catalogPath = path.join(fx.stateDir, 'tick-catalog.json');
      const readCat = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      const getEp = (cat: any) =>
        scenario === 'genuine official' ? cat.officialNoticeDetections[0] : cat.absenceDetections[0];

      const catAfterFirstApply = readCat();
      expect(getEp(catAfterFirstApply).removedAt).toEqual(expect.any(String));
      if (scenario === 'qualified absence') {
        expect(catAfterFirstApply.providers.openai.pendingEpisodes?.[model]).toBeUndefined();
      }
      const postFirstApplyConfigBytes = fs.readFileSync(fx.config);

      // Failed rollback with mismatched expectedPreSha256 must NOT overwrite config, mark verified, or reopen episode
      await expect(
        runAppsRollbackCommand({
          app: 'hermes',
          config: fx.config,
          backup: fx.backup,
          expectedPreSha256: '0'.repeat(64),
          stateDir: fx.stateDir,
          json: true,
        })
      ).rejects.toThrow(/Rollback verification failed/);
      process.exitCode = 0;
      expect(fs.readFileSync(fx.config)).toEqual(postFirstApplyConfigBytes);
      expect(getEp(readCat()).removedAt).toEqual(expect.any(String));
      expect(readApplyHistory(fx.stateDir).receipts.at(-1)?.rolledBack).toBe(false);

      // Valid byte-exact rollback restores config, marks receipt rolledBack+rollbackVerified, and reopens episode
      await runAppsRollbackCommand({
        app: 'hermes',
        config: fx.config,
        backup: fx.backup,
        expectedPreSha256: sha256(fx.configBefore),
        stateDir: fx.stateDir,
        json: true,
      });
      expect(fs.readFileSync(fx.config)).toEqual(fx.configBefore);
      const rolledReceipt = readApplyHistory(fx.stateDir).receipts.at(-1);
      expect(rolledReceipt).toMatchObject({ rolledBack: true, rollbackVerified: true });

      const catAfterRollback = readCat();
      expect(getEp(catAfterRollback).removedAt).toBeUndefined();
      expect(getEp(catAfterRollback).detectionMs).toBe(90);
      if (scenario === 'qualified absence') {
        expect(catAfterRollback.providers.openai.pendingEpisodes?.[model]).toBe(
          catAfterRollback.absenceDetections[0].episodeId
        );
      }

      // Subsequent reapply succeeds cleanly and preserves original 90ms detectionMs without laundering
      await runAppsApplyCommand(fx.args);
      expect(fs.readFileSync(fx.config, 'utf8')).not.toContain(model);
      const catAfterReapply = readCat();
      expect(getEp(catAfterReapply).removedAt).toEqual(expect.any(String));
      expect(getEp(catAfterReapply).detectionMs).toBe(90);
    }
  );

  it('AC3-A: Hermes main provider openai + default/cron openrouter/openai/... blocks active default removal until verified live replacement', async () => {
    const stateDir = path.join(root, 'state-ac3-hermes');
    const hermesHome = path.join(root, 'home-ac3-hermes');
    const hermesDir = path.join(hermesHome, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    const configPath = path.join(hermesDir, 'config.yaml');
    const backupPath = `${configPath}.bak`;

    const prov = 'openrouter';
    const retiredDefault = 'openai/gpt-or-default-retired';
    const retiredCron = 'openai/gpt-or-cron-retired';
    const liveOrModels = Array.from({ length: 18 }, (_, i) => `openai/gpt-or-live-${i}`);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const first = now - day - 60_000;

    fs.writeFileSync(
      path.join(hermesDir, '.env'),
      [`OPENAI_API_KEY=${FAKE_SECRET_A}`, `OPENROUTER_API_KEY=${FAKE_SECRET_B}`, ''].join('\n')
    );
    fs.writeFileSync(
      configPath,
      [
        'model:',
        '  provider: openai',
        `  default: openrouter/${retiredDefault}`,
        'cron:',
        `  model: openrouter/${retiredCron}`,
        'providers:',
        '  openai:',
        '    base_url: https://api.openai.com/v1',
        '    api_key_env: OPENAI_API_KEY',
        '    models:',
        '      - gpt-4.1',
        '  openrouter:',
        '    base_url: https://openrouter.ai/api/v1',
        '    api_key_env: OPENROUTER_API_KEY',
        '    models:',
        ...[...liveOrModels, retiredDefault, retiredCron].map((m) => `      - ${m}`),
        '',
      ].join('\n')
    );

    const tickDiscovered = inspectTierAHarnessForTick('hermes', hermesHome);
    expect(tickDiscovered?.defaultModels).toContain(`openrouter/${retiredDefault}`);
    expect(tickDiscovered?.defaultModels).toContain(`openrouter/${retiredCron}`);

    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'propose', nowMs: now - 5_000 });
    appendApplyReceipt(stateDir, {
      target: targetScope,
      planHash: 'ac3-hermes-init',
      appliedAt: iso(now - 4_000),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: 'ac3-hermes-init.bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
    });
    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'auto-safe', nowMs: now - 3_000 });

    const noticeDefNoRep = appendResearchEvidence(stateDir, {
      provider: prov,
      modelId: retiredDefault,
      url: 'https://openrouter.ai/docs/models',
      verdict: 'deprecated',
      quote: 'Retired nested default model without replacement.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 3_600_000),
      submittedAt: iso(first - 1_000),
      submittedVia: 'cli',
    });
    const noticeCronNoRep = appendResearchEvidence(stateDir, {
      provider: prov,
      modelId: retiredCron,
      url: 'https://openrouter.ai/docs/models',
      verdict: 'deprecated',
      quote: 'Retired nested cron model without replacement.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 3_600_000),
      submittedAt: iso(first - 1_000),
      submittedVia: 'cli',
    });

    const writeCat = (evDef: string, evCron: string) => {
      fs.writeFileSync(
        path.join(stateDir, 'tick-catalog.json'),
        JSON.stringify({
          version: 1,
          updatedAt: iso(now - 500),
          providers: {
            openai: {
              prefix: 'openai',
              ids: ['gpt-4.1'],
              absenceCounts: {},
              qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 500)],
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: iso(now - 500),
            },
            openrouter: {
              prefix: prov,
              ids: liveOrModels,
              absenceCounts: { [retiredDefault]: 3, [retiredCron]: 3 },
              firstAbsentAt: { [retiredDefault]: iso(first), [retiredCron]: iso(first) },
              qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 500)],
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: iso(now - 500),
            },
          },
          absenceDetections: [],
          officialNoticeDetections: [
            {
              recordKey: JSON.stringify([`${prov}/${retiredDefault}`, evDef, iso(first)]),
              evidenceId: evDef,
              provider: prov,
              modelId: retiredDefault,
              fullStep: `${prov}/${retiredDefault}`,
              firstQualifyingScanStartedAt: iso(first),
              episodeStartedAt: iso(first),
              firstPlanCreatedAt: iso(first + 90),
              detectionMs: 90,
              sourcePublishedAt: iso(first - day),
              publicationToPlanMs: day + 90,
              targetsAffected: [targetScope],
              synthetic: false,
            },
            {
              recordKey: JSON.stringify([`${prov}/${retiredCron}`, evCron, iso(first)]),
              evidenceId: evCron,
              provider: prov,
              modelId: retiredCron,
              fullStep: `${prov}/${retiredCron}`,
              firstQualifyingScanStartedAt: iso(first),
              episodeStartedAt: iso(first),
              firstPlanCreatedAt: iso(first + 90),
              detectionMs: 90,
              sourcePublishedAt: iso(first - day),
              publicationToPlanMs: day + 90,
              targetsAffected: [targetScope],
              synthetic: false,
            },
          ],
        })
      );
    };

    writeCat(researchEvidenceIdentity(noticeDefNoRep), researchEvidenceIdentity(noticeCronNoRep));

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    await runAppsPlanCommand({ app: 'hermes', config: configPath, stateDir, home: hermesHome, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as {
      defaultSlotWarnings: Array<{ slot: string; currentModel: string; suggestion: string }>;
    };
    expect(planJson.defaultSlotWarnings).toEqual(
      expect.arrayContaining([
        {
          slot: 'model.default',
          currentModel: `openrouter/${retiredDefault}`,
          suggestion: `openrouter/${liveOrModels[0]}`,
        },
        {
          slot: 'cron.model',
          currentModel: `openrouter/${retiredCron}`,
          suggestion: `openrouter/${liveOrModels[0]}`,
        },
      ])
    );

    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: configPath,
        backup: backupPath,
        stateDir,
        home: hermesHome,
        write: true,
        isTTY: false,
        json: true,
      })
    ).rejects.toThrow('DEFAULT_SLOT_PROTECTED');

    // Supply verified live replacements for both slots -> auto-safe removal succeeds cleanly
    const noticeDefWithRep = appendResearchEvidence(stateDir, {
      provider: prov,
      modelId: retiredDefault,
      url: 'https://openrouter.ai/docs/models',
      verdict: 'deprecated',
      quote: 'Retired nested default model with live replacement.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 3_600_000),
      submittedAt: iso(now - 800),
      replacementModelId: liveOrModels[0]!,
      submittedVia: 'cli',
    });
    const noticeCronWithRep = appendResearchEvidence(stateDir, {
      provider: prov,
      modelId: retiredCron,
      url: 'https://openrouter.ai/docs/models',
      verdict: 'deprecated',
      quote: 'Retired nested cron model with live replacement.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 3_600_000),
      submittedAt: iso(now - 800),
      replacementModelId: liveOrModels[1]!,
      submittedVia: 'cli',
    });
    writeCat(researchEvidenceIdentity(noticeDefWithRep), researchEvidenceIdentity(noticeCronWithRep));

    await runAppsApplyCommand({
      app: 'hermes',
      config: configPath,
      backup: backupPath,
      stateDir,
      home: hermesHome,
      write: true,
      isTTY: false,
      json: true,
    });
    const afterYaml = fs.readFileSync(configPath, 'utf8');
    expect(afterYaml).not.toContain(`      - ${retiredDefault}`);
    expect(afterYaml).not.toContain(`      - ${retiredCron}`);
    expect(afterYaml).toContain(`  default: openrouter/${retiredDefault}`);
    expect(afterYaml).toContain(`  model: openrouter/${retiredCron}`);
  });

  it('AC3-B: OpenMausBot decider.openrouterModel scopes to openrouter without false-positiving against openai catalog', async () => {
    const stateDir = path.join(root, 'state-ac3-omb');
    const ombHome = path.join(root, 'home-ac3-omb');
    const ombDir = path.join(ombHome, '.openmausbot');
    fs.mkdirSync(ombDir, { recursive: true });
    const configPath = path.join(ombDir, 'config.json');
    const backupPath = `${configPath}.bak`;
    const target = 'harness:openmausbot';
    const retiredOpenAiModel = 'gpt-4o-legacy';
    const liveOpenAiModels = Array.from({ length: 9 }, (_, i) => `gpt-live-${i}`);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const first = now - day - 60_000;

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          decider: {
            openrouterModel: `openai/${retiredOpenAiModel}`,
          },
          instances: {
            openai: {
              driver: 'openai-compat',
              config: {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: FAKE_SECRET_A,
                managedModels: [...liveOpenAiModels, retiredOpenAiModel],
              },
            },
            corpProxy: {
              driver: 'anthropic',
              config: {
                baseUrl: 'https://proxy.corp.example/v1',
                apiKey: FAKE_SECRET_B,
                model: `openai/${retiredOpenAiModel}`,
              },
            },
          },
        },
        null,
        2
      )
    );

    const tickDiscovered = inspectTierAHarnessForTick('openmausbot', ombHome);
    expect(tickDiscovered?.defaultModels).toEqual([
      `openrouter/openai/${retiredOpenAiModel}`,
      `corpProxy/openai/${retiredOpenAiModel}`,
    ]);
    expect(tickDiscovered?.defaultModels).not.toContain(`openai/${retiredOpenAiModel}`);

    upsertStandingConsentTarget(stateDir, { target, level: 'propose', nowMs: now - 5_000 });
    appendApplyReceipt(stateDir, {
      target,
      planHash: 'ac3-omb-init',
      appliedAt: iso(now - 4_000),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: 'ac3-omb-init.bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
    });
    upsertStandingConsentTarget(stateDir, { target, level: 'auto-safe', nowMs: now - 3_000 });

    const epId = `ep-${JSON.stringify(['openai', retiredOpenAiModel, first])}`;
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({
        version: 1,
        updatedAt: iso(now - 500),
        providers: {
          openai: {
            prefix: 'openai',
            ids: liveOpenAiModels,
            absenceCounts: { [retiredOpenAiModel]: 3 },
            firstAbsentAt: { [retiredOpenAiModel]: iso(first) },
            pendingEpisodes: { [retiredOpenAiModel]: epId },
            qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 500)],
            lastStatus: 200,
            lastLabel: 'OK',
            updatedAt: iso(now - 500),
          },
        },
        absenceDetections: [
          {
            episodeId: epId,
            provider: 'openai',
            modelId: retiredOpenAiModel,
            fullStep: `openai/${retiredOpenAiModel}`,
            status: 'model_pending',
            scanStartedAt: iso(first),
            modelPendingAt: iso(first + 40),
            detectionMs: 40,
            targetsAffected: [target],
          },
        ],
        officialNoticeDetections: [],
      })
    );

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    await runAppsPlanCommand({ app: 'openmausbot', config: configPath, stateDir, home: ombHome, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as {
      defaultSlotWarnings: unknown[];
      removals: Array<{ provider: string; model: string }>;
    };
    expect(planJson.defaultSlotWarnings).toEqual([]);
    expect(planJson.removals).toEqual([
      { provider: 'openai', model: retiredOpenAiModel, reason: 'deprecated-upstream' },
    ]);

    await runAppsApplyCommand({
      app: 'openmausbot',
      config: configPath,
      backup: backupPath,
      stateDir,
      home: ombHome,
      write: true,
      isTTY: false,
      json: true,
    });
    const afterJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(afterJson.instances.openai.config.managedModels).not.toContain(retiredOpenAiModel);
    expect(afterJson.decider.openrouterModel).toBe(`openai/${retiredOpenAiModel}`);
  });

  it('AC4: shared resolveCatalogPresence allows official deprecation on graceAbsent model while excluding graceAbsent from live additions and live replacements', async () => {
    const stateDir = path.join(root, 'state-ac4-grace');
    const configPath = path.join(root, 'config-ac4-grace.yaml');
    const backupPath = path.join(root, 'backup-ac4-grace.yaml');
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const first = now - 3_600_000;

    const liveModels = Array.from({ length: 9 }, (_, i) => `gpt-live-${i}`);
    const graceDeprecatedModel = 'gpt-grace-official-retired';
    const graceCandidateReplacement = 'gpt-grace-not-live';

    fs.writeFileSync(path.join(root, '.env'), `OPENAI_API_KEY=${FAKE_SECRET_A}\n`);
    fs.writeFileSync(
      configPath,
      [
        'model:',
        '  provider: openai',
        `  default: openai/${graceDeprecatedModel}`,
        'providers:',
        '  openai:',
        '    base_url: https://api.openai.com/v1',
        '    api_key_env: OPENAI_API_KEY',
        '    models:',
        ...[...liveModels, graceDeprecatedModel].map((m) => `      - ${m}`),
        '',
      ].join('\n')
    );

    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'propose', nowMs: now - 5_000 });
    appendApplyReceipt(stateDir, {
      target: targetScope,
      planHash: 'ac4-grace-init',
      appliedAt: iso(now - 4_000),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      snapshotOrBackupRef: 'ac4-grace-init.bak',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
    });
    upsertStandingConsentTarget(stateDir, { target: targetScope, level: 'auto-safe', nowMs: now - 3_000 });

    // 1. Official notice pointing replacementModelId at a grace-absent model -> must NOT count as live replacement!
    const noticeGraceReplacement = appendResearchEvidence(stateDir, {
      provider: 'openai',
      modelId: graceDeprecatedModel,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'deprecated',
      quote: 'Retired during grace cycle; replacement is itself grace-absent.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 600_000),
      submittedAt: iso(first - 1_000),
      replacementModelId: graceCandidateReplacement,
      submittedVia: 'cli',
    });

    const writeGraceCatalog = (evId: string) => {
      fs.writeFileSync(
        path.join(stateDir, 'tick-catalog.json'),
        JSON.stringify({
          version: 1,
          updatedAt: iso(now - 500),
          providers: {
            openai: {
              prefix: 'openai',
              // Both grace-absent models remain in entry.ids just as tick.ts persists effectiveIds
              ids: [...liveModels, graceDeprecatedModel, graceCandidateReplacement],
              absenceCounts: {
                [graceDeprecatedModel]: 1,
                [graceCandidateReplacement]: 1,
              },
              firstAbsentAt: {
                [graceDeprecatedModel]: iso(first),
                [graceCandidateReplacement]: iso(first),
              },
              qualifyingScanTimestamps: [iso(first), iso(now - 500)],
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: iso(now - 500),
            },
          },
          absenceDetections: [],
          officialNoticeDetections: [
            {
              recordKey: JSON.stringify([`openai/${graceDeprecatedModel}`, evId, iso(first)]),
              evidenceId: evId,
              provider: 'openai',
              modelId: graceDeprecatedModel,
              fullStep: `openai/${graceDeprecatedModel}`,
              firstQualifyingScanStartedAt: iso(first),
              episodeStartedAt: iso(first),
              firstPlanCreatedAt: iso(first + 75),
              detectionMs: 75,
              sourcePublishedAt: iso(first - day),
              publicationToPlanMs: day + 75,
              targetsAffected: [targetScope],
              synthetic: false,
            },
          ],
        })
      );
    };

    writeGraceCatalog(researchEvidenceIdentity(noticeGraceReplacement));

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    await runAppsPlanCommand({ app: 'hermes', config: configPath, stateDir, home: root, json: true });
    const planJson = JSON.parse(out.splice(0).join('')) as {
      additions: Array<{ provider: string; model: string }>;
      removals: Array<{ provider: string; model: string }>;
    };
    // graceCandidateReplacement is NOT offered as a live addition; graceDeprecatedModel IS planned via official notice!
    expect(planJson.additions).toEqual([]);
    expect(planJson.removals).toEqual([
      { provider: 'openai', model: graceDeprecatedModel, reason: 'deprecated-upstream' },
    ]);

    // Auto-safe apply blocks because graceCandidateReplacement is grace-absent (l1Exists === false), not live!
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: configPath,
        backup: backupPath,
        stateDir,
        home: root,
        write: true,
        isTTY: false,
        json: true,
      })
    ).rejects.toThrow('DEFAULT_SLOT_PROTECTED');

    // 2. Update official notice with truly live replacement -> graceDeprecatedModel removes cleanly!
    const noticeLiveReplacement = appendResearchEvidence(stateDir, {
      provider: 'openai',
      modelId: graceDeprecatedModel,
      url: 'https://platform.openai.com/docs/deprecations',
      verdict: 'deprecated',
      quote: 'Retired during grace cycle with verified live replacement.',
      publishedAt: iso(first - day),
      shutdownDate: iso(first - 600_000),
      submittedAt: iso(now - 200),
      replacementModelId: liveModels[0]!,
      submittedVia: 'cli',
    });
    writeGraceCatalog(researchEvidenceIdentity(noticeLiveReplacement));

    await runAppsApplyCommand({
      app: 'hermes',
      config: configPath,
      backup: backupPath,
      stateDir,
      home: root,
      write: true,
      isTTY: false,
      json: true,
    });
    const afterYaml = fs.readFileSync(configPath, 'utf8');
    expect(afterYaml).not.toContain(`      - ${graceDeprecatedModel}`);
    expect(afterYaml).not.toContain(graceCandidateReplacement);
  });
  it('P1-Probe6-TwoProposeHarnesses: shared [harness:hermes, harness:openmausbot] episode stays open after first propose apply and while second harness still lists model until second propose apply succeeds', async () => {
    const stateDir = path.join(root, 'state-probe6-two-propose');
    const sharedHome = path.join(root, 'home-probe6-two-propose');
    const hermesDir = path.join(sharedHome, '.hermes');
    const ombDir = path.join(sharedHome, '.openmausbot');
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(ombDir, { recursive: true });
    const hermesCfg = path.join(hermesDir, 'config.yaml');
    const ombCfg = path.join(ombDir, 'config.json');
    const retiredModel = 'gpt-4o-legacy';
    const liveModels = Array.from({ length: 9 }, (_, i) => `gpt-live-${i}`);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const first = now - 25 * 3_600_000;

    fs.writeFileSync(
      hermesCfg,
      [
        'providers:',
        '  openai:',
        `    api_key: ${FAKE_SECRET_A}`,
        '    models:',
        ...[...liveModels, retiredModel].map((m) => `      - ${m}`),
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      ombCfg,
      JSON.stringify(
        {
          instances: {
            openai: {
              driver: 'openai-compat',
              config: {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: FAKE_SECRET_A,
                managedModels: [...liveModels, retiredModel],
              },
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'propose', nowMs: now - 10_000 });
    upsertStandingConsentTarget(stateDir, { target: 'harness:openmausbot', level: 'propose', nowMs: now - 10_000 });

    const epId = `ep-${JSON.stringify(['openai', retiredModel, first])}`;
    const catalogFile = path.join(stateDir, 'tick-catalog.json');
    fs.writeFileSync(
      catalogFile,
      JSON.stringify(
        {
          version: 1,
          updatedAt: iso(now - 1_000),
          providers: {
            openai: {
              prefix: 'openai',
              ids: liveModels,
              absenceCounts: { [retiredModel]: 3 },
              firstAbsentAt: { [retiredModel]: iso(first) },
              pendingEpisodes: { [retiredModel]: epId },
              qualifyingScanTimestamps: [iso(first), iso(first + 900_000), iso(now - 1_000)],
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: iso(now - 1_000),
            },
          },
          absenceDetections: [
            {
              episodeId: epId,
              provider: 'openai',
              modelId: retiredModel,
              fullStep: `openai/${retiredModel}`,
              status: 'model_pending',
              scanStartedAt: iso(first),
              modelPendingAt: iso(first + 45),
              detectionMs: 45,
              targetsAffected: ['harness:hermes', 'harness:openmausbot'],
            },
          ],
          officialNoticeDetections: [],
        },
        null,
        2
      ),
      'utf8'
    );

    // 1. Apply first propose harness (hermes) -> accepted, but openmausbot still lists retiredModel so episode MUST stay open!
    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesCfg,
      backup: `${hermesCfg}.bak`,
      stateDir,
      home: sharedHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(fs.readFileSync(hermesCfg, 'utf8')).not.toContain(retiredModel);
    expect(fs.readFileSync(ombCfg, 'utf8')).toContain(retiredModel);

    const catAfterFirst = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    expect(catAfterFirst.absenceDetections[0].removedAt).toBeUndefined();
    expect(catAfterFirst.providers.openai.pendingEpisodes[retiredModel]).toBe(epId);

    // 2. Apply second propose harness (openmausbot) -> MUST be accepted and now close the shared episode!
    await runAppsApplyCommand({
      app: 'openmausbot',
      config: ombCfg,
      backup: `${ombCfg}.bak`,
      stateDir,
      home: sharedHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(fs.readFileSync(ombCfg, 'utf8')).not.toContain(retiredModel);

    const catAfterSecond = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    expect(catAfterSecond.absenceDetections[0].removedAt).toEqual(expect.any(String));
    expect(catAfterSecond.providers.openai.pendingEpisodes[retiredModel]).toBeUndefined();

    // 3. Verified rollback on second harness reopens the shared episode and restores pendingEpisodes while preserving anchor
    const origAnchor = catAfterSecond.absenceDetections[0].scanStartedAt;
    const origLatency = catAfterSecond.absenceDetections[0].detectionMs;
    await runAppsRollbackCommand({
      app: 'openmausbot',
      config: ombCfg,
      backup: ombCfg + ".bak",
      stateDir,
      json: true,
    });
    expect(fs.readFileSync(ombCfg, 'utf8')).toContain(retiredModel);
    const catAfterRollback = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    expect(catAfterRollback.absenceDetections[0].removedAt).toBeUndefined();
    expect(catAfterRollback.absenceDetections[0].scanStartedAt).toBe(origAnchor);
    expect(catAfterRollback.absenceDetections[0].detectionMs).toBe(origLatency);
    expect(catAfterRollback.providers.openai.pendingEpisodes[retiredModel]).toBe(epId);
  });

  it.each([
    { agg: 'together', envKey: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', nativeMulti: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', deepMulti: 'openai/accounts/gpt-oss-120b' },
    { agg: 'fireworks', envKey: 'FIREWORKS_API_KEY', baseUrl: 'https://api.fireworks.ai/inference/v1', nativeMulti: 'accounts/fireworks/models/deepseek-v3', deepMulti: 'openai/accounts/fireworks/gpt-oss-120b' },
    { agg: 'groq', envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', nativeMulti: 'meta-llama/llama-4-scout-17b-16e-instruct', deepMulti: 'openai/preview/gpt-oss-20b' },
  ])(
    'AC3-Aggregator-DefaultSlots ($agg + openai): scopes multi-segment IDs without cross-provider false-positive defaultSlotWarnings (kills M03 & M04)',
    async ({ agg, envKey, baseUrl, nativeMulti, deepMulti }) => {
      const adapter = getHarnessWriteAdapter('hermes');
      expect(adapter).toBeDefined();

      // Direction 1: Aggregator as hint (`model.provider: <agg>`) while `openai` is ALSO configured
      // - `model.default: openai/gpt-4o-legacy` (deprecated in `openai` -> kills M03 Step 3 guard!)
      // - `cron.model: openai/gpt-oss-120b` (unlisted in `openai` -> kills M04 Step 5 guard!)
      const homeA = path.join(root, "home-ac3-" + agg + "-hint");
      const dirA = path.join(homeA, '.hermes');
      fs.mkdirSync(dirA, { recursive: true });
      fs.writeFileSync(path.join(dirA, '.env'), 'OPENAI_API_KEY=' + FAKE_SECRET_A + '\n' + envKey + '=' + FAKE_SECRET_B + '\n', 'utf8');
      const cfgA = path.join(dirA, 'config.yaml');
      fs.writeFileSync(
        cfgA,
        [
          'model:',
          '  provider: ' + agg,
          '  default: openai/gpt-4o-legacy',
          'cron:',
          '  model: openai/gpt-oss-120b',
          'providers:',
          '  openai:',
          '    base_url: https://api.openai.com/v1',
          '    api_key_env: OPENAI_API_KEY',
          '    models:',
          '      - gpt-4.1',
          '      - gpt-4o-legacy',
          '  ' + agg + ':',
          '    base_url: ' + baseUrl,
          '    api_key_env: ' + envKey,
          '    models:',
          '      - ' + nativeMulti,
          '',
        ].join('\n'),
        'utf8'
      );

      const catalogCrossDeprecated: HarnessCatalogInput = {
        openai: { liveModels: ['gpt-4.1'], deprecatedModels: ['gpt-4o-legacy'] },
        [agg]: { liveModels: [nativeMulti, 'openai/gpt-4o-legacy', 'openai/gpt-oss-120b'], deprecatedModels: [] },
      };

      const discoveredA = inspectTierAHarnessForTick('hermes', homeA);
      expect(discoveredA?.defaultModels).toContain(agg + '/openai/gpt-4o-legacy');
      expect(discoveredA?.defaultModels).toContain(agg + '/openai/gpt-oss-120b');
      expect(discoveredA?.defaultModels).not.toContain('openai/gpt-4o-legacy');
      expect(discoveredA?.defaultModels).not.toContain('openai/gpt-oss-120b');

      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgA, homeA, 'openai', 'gpt-4o-legacy', catalogCrossDeprecated)).toBe(false);
      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgA, homeA, 'openai', 'gpt-oss-120b', catalogCrossDeprecated)).toBe(false);
      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgA, homeA, agg, 'openai/gpt-4o-legacy', catalogCrossDeprecated)).toBe(true);
      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgA, homeA, agg, 'openai/gpt-oss-120b', catalogCrossDeprecated)).toBe(true);

      const planA = await adapter!.plan({ configPath: cfgA, homeDir: homeA, catalog: catalogCrossDeprecated });
      expect(planA.defaultSlotWarnings).toEqual([]);

      // Also verify 3+-segment vendor-namespaced ID (`openai/.../...`) under aggregator hint stays on `<agg>`
      fs.writeFileSync(
        cfgA,
        fs.readFileSync(cfgA, 'utf8').replace('  model: openai/gpt-oss-120b', '  model: ' + deepMulti),
        'utf8'
      );
      const discoveredDeep = inspectTierAHarnessForTick('hermes', homeA);
      expect(discoveredDeep?.defaultModels).toContain(agg + '/' + deepMulti);
      expect(discoveredDeep?.defaultModels).not.toContain(deepMulti);

      // Direction 2: `openai` as hint (`model.provider: openai`) with explicit `<agg>/<multi-segment>` override
      // - `model.default: <agg>/<nativeMulti>` (in `<agg>` models -> exercises Step 3 branch)
      // - `cron.model: <agg>/openai/gpt-oss-unlisted` (unlisted in `<agg>` models while `<agg>` is configured -> kills M04 Step 5 branch deletion!)
      const homeB = path.join(root, "home-ac3-" + agg + "-nested");
      const dirB = path.join(homeB, '.hermes');
      fs.mkdirSync(dirB, { recursive: true });
      fs.writeFileSync(path.join(dirB, '.env'), 'OPENAI_API_KEY=' + FAKE_SECRET_A + '\n' + envKey + '=' + FAKE_SECRET_B + '\n', 'utf8');
      const cfgB = path.join(dirB, 'config.yaml');
      fs.writeFileSync(
        cfgB,
        [
          'model:',
          '  provider: openai',
          '  default: ' + agg + '/' + nativeMulti,
          'cron:',
          '  model: ' + agg + '/openai/gpt-oss-unlisted',
          'providers:',
          '  openai:',
          '    base_url: https://api.openai.com/v1',
          '    api_key_env: OPENAI_API_KEY',
          '    models:',
          '      - gpt-4.1',
          '  ' + agg + ':',
          '    base_url: ' + baseUrl,
          '    api_key_env: ' + envKey,
          '    models:',
          '      - ' + nativeMulti,
          '',
        ].join('\n'),
        'utf8'
      );

      const discoveredB = inspectTierAHarnessForTick('hermes', homeB);
      expect(discoveredB?.defaultModels).toContain(agg + '/' + nativeMulti);
      expect(discoveredB?.defaultModels).toContain(agg + '/openai/gpt-oss-unlisted');
      expect(discoveredB?.defaultModels).not.toContain('openai/' + agg + '/' + nativeMulti);
      expect(discoveredB?.defaultModels).not.toContain('openai/' + agg + '/openai/gpt-oss-unlisted');

      const catalogAggDep: HarnessCatalogInput = {
        openai: { liveModels: ['gpt-4.1'], deprecatedModels: [] },
        [agg]: { liveModels: [], deprecatedModels: [nativeMulti, 'openai/gpt-oss-unlisted'] },
      };
      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgB, homeB, agg, nativeMulti, catalogAggDep)).toBe(true);
      expect(isHarnessRemovalProtectedDefaultSlot('hermes', cfgB, homeB, agg, 'openai/gpt-oss-unlisted', catalogAggDep)).toBe(true);
      const planB = await adapter!.plan({ configPath: cfgB, homeDir: homeB, catalog: catalogAggDep });
      expect(planB.defaultSlotWarnings).toHaveLength(2);
    }
  );

  it('AC4-ExplicitCatalogTtyOverride: manual propose with explicit --catalog emits C48_TTY_OVERRIDE diagnostic even when provider entry is absent from tick-catalog.json', async () => {
    const stateDir = path.join(root, 'state-ac4-explicit-cat');
    const homeDir = path.join(root, 'home-ac4-explicit-cat');
    const hermesDir = path.join(homeDir, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(hermesDir, '.env'), 'OPENAI_API_KEY=' + FAKE_SECRET_A + '\n', 'utf8');
    const cfg = path.join(hermesDir, 'config.yaml');
    fs.writeFileSync(
      cfg,
      [
        'model:',
        '  provider: openai',
        '  default: gpt-4.1',
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
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), providers: {} }),
      'utf8'
    );
    const explicitCat = path.join(root, 'ac4-explicit-catalog.json');
    fs.writeFileSync(
      explicitCat,
      JSON.stringify({ openai: { liveModels: ['gpt-4.1'], deprecatedModels: ['gpt-4o-legacy'] } }),
      'utf8'
    );
    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'propose', nowMs: Date.now() - 1_000 });
    const errBuf: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errBuf.push(String(chunk));
      return true;
    });
    await runAppsApplyCommand({
      app: 'hermes',
      config: cfg,
      backup: cfg + ".bak",
      catalog: explicitCat,
      stateDir,
      home: homeDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'cancel',
      json: true,
    });
    expect(errBuf.join('')).toContain('C48_TTY_OVERRIDE: openai/gpt-4o-legacy: explicit --catalog file override.');
  });
});
