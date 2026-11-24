/**
 * packages/cli/test/c45-wp1-matrix.test.ts
 *
 * C45-WP1 Red-First Contract Suite (Phục vụ: S2, S3, S6):
 *  - Byte/JSON equality between root harness-matrix.json and packages/core/src/harness/harness-matrix.json
 *  - Typed matrix helpers in @routersync/core (loadHarnessMatrix, getHarnessCapability, listHarnessCapabilities)
 *  - Dynamic 9-harness `routersync mcp install` (dry-run, print, sandbox write + .bak + atomic + read-back + rollback)
 *  - Dynamic 9-harness `routersync schedule` (--harness <id>: 0-token native descriptors for hermes & antigravity; OS scheduler rationale for remaining 7)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import {
  getHarnessCapability,
  listHarnessCapabilities,
  loadHarnessMatrix,
} from '@routersync/core';
import { runMcpInstallCommand } from '../src/commands/mcp-install.js';
import {
  resolveHarnessSchedulePlan,
  runScheduleCommand,
} from '../src/commands/schedule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const ALL_HARNESS_IDS = [
  'hermes',
  'claude-code',
  'codex',
  'antigravity',
  'opencode',
  'cursor',
  'grok-bot',
  'openmausbot',
  'dsh',
] as const;

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

describe('C45-WP1: Canonical Harness Capability Matrix', () => {
  it('maintains byte-for-byte & JSON equality between root harness-matrix.json and packages/core/src/harness/harness-matrix.json', () => {
    const rootPath = path.join(REPO_ROOT, 'harness-matrix.json');
    const coreSrcPath = path.join(REPO_ROOT, 'packages', 'core', 'src', 'harness', 'harness-matrix.json');

    expect(fs.existsSync(rootPath)).toBe(true);
    expect(fs.existsSync(coreSrcPath)).toBe(true);

    const rootRaw = fs.readFileSync(rootPath);
    const coreRaw = fs.readFileSync(coreSrcPath);
    expect(sha256(rootRaw)).toBe(sha256(coreRaw));
    expect(JSON.parse(rootRaw.toString('utf8'))).toEqual(JSON.parse(coreRaw.toString('utf8')));
  });

  it('exposes all 9 harnesses via loadHarnessMatrix, listHarnessCapabilities, and getHarnessCapability', () => {
    const matrix = loadHarnessMatrix();
    expect(matrix.version).toBe(1);
    expect(matrix.serves).toEqual(['S2', 'S3', 'S6']);

    const list = listHarnessCapabilities();
    expect(list.map((h) => h.id)).toEqual([...ALL_HARNESS_IDS]);

    const writeHarnesses = list.filter((h) => h.directionAMode === 'write-adapter').map((h) => h.id);
    expect(writeHarnesses.sort()).toEqual(['dsh', 'hermes', 'opencode', 'openmausbot']);

    const reportHarnesses = list.filter((h) => h.directionAMode === 'report-only').map((h) => h.id);
    expect(reportHarnesses.sort()).toEqual(['antigravity', 'claude-code', 'codex', 'cursor', 'grok-bot']);

    const zeroTokenSchedulers = list.filter((h) => h.scheduler.zeroTokenScriptCapable).map((h) => h.id);
    expect(zeroTokenSchedulers.sort()).toEqual(['antigravity', 'hermes']);

    for (const id of ALL_HARNESS_IDS) {
      const cap = getHarnessCapability(id);
      expect(cap).toBeDefined();
      expect(cap?.id).toBe(id);
      expect(['A', 'B', 'C']).toContain(cap?.tier);
    }
    expect(getHarnessCapability('non-existent-harness')).toBeUndefined();
  });
});

describe('C45-WP1: 9-Harness MCP Install (dry-run, print, sandbox write, backup, read-back, rollback)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c45-wp1-mcp-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(ALL_HARNESS_IDS)('supports --dry-run and --print for %s without touching disk', async (client) => {
    const target = path.join(tmpDir, `${client}-dry-target.cfg`);
    const dryRes = await runMcpInstallCommand({
      client,
      dryRun: true,
      ...(client === 'grok-bot' ? {} : { targetFile: target }),
      json: true,
    });
    expect(dryRes.mode).toBe('dry-run');
    expect(dryRes.success).toBe(true);
    expect(fs.existsSync(target)).toBe(false);

    const printRes = await runMcpInstallCommand({
      client,
      print: true,
    });
    expect(printRes.mode).toBe('dry-run');
    expect(printRes.success).toBe(true);
    expect(printRes.diff.length).toBeGreaterThan(10);
  });

  it('hermes YAML: merges mcp_servers.routersync preserving comments, creates .bak, and verifies read-back', async () => {
    const target = path.join(tmpDir, 'config.yaml');
    const initial = [
      '# Hermes user config header comment',
      'model:',
      '  provider: 9router',
      '  default: 9Router-Coder-1',
      'mcp_servers:',
      '  # Existing MCP comment',
      '  existing_fs:',
      '    command: npx',
      '    args:',
      '      - "-y"',
      '      - "server-fs"',
      '# Footer comment preserved',
      '',
    ].join('\n');
    fs.writeFileSync(target, initial, 'utf8');

    const res = await runMcpInstallCommand({
      client: 'hermes',
      write: true,
      allowNonTtyForTest: true,
      targetFile: target,
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(`${target}.bak`)).toBe(true);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(initial);

    const updated = fs.readFileSync(target, 'utf8');
    expect(updated).toContain('# Hermes user config header comment');
    expect(updated).toContain('# Existing MCP comment');
    expect(updated).toContain('# Footer comment preserved');

    const parsed = parseDocument(updated).toJS() as Record<string, any>;
    expect(parsed.mcp_servers.existing_fs.command).toBe('npx');
    expect(parsed.mcp_servers.routersync.command).toBe('node');
    expect(Array.isArray(parsed.mcp_servers.routersync.args)).toBe(true);
  });

  it('hermes YAML flow maps (Bug #2): handles empty `mcp_servers: {}` and non-empty flow `mcp_servers: { ... }` without syntax corruption', async () => {
    const emptyFlowTarget = path.join(tmpDir, 'hermes-empty-flow.yaml');
    const initialEmptyFlow = [
      '# Hermes default empty flow mcp_servers',
      'model:',
      '  default: gpt-4o',
      'mcp_servers: {} # keep empty flow comment',
      '# Bottom comment',
      '',
    ].join('\n');
    fs.writeFileSync(emptyFlowTarget, initialEmptyFlow, 'utf8');

    const resEmpty = await runMcpInstallCommand({
      client: 'hermes',
      write: true,
      allowNonTtyForTest: true,
      targetFile: emptyFlowTarget,
    });
    expect(resEmpty.success).toBe(true);
    const updatedEmpty = fs.readFileSync(emptyFlowTarget, 'utf8');
    expect(updatedEmpty).toContain('# Hermes default empty flow mcp_servers');
    expect(updatedEmpty).toContain('# keep empty flow comment');
    expect(updatedEmpty).toContain('# Bottom comment');
    const parsedEmpty = parseDocument(updatedEmpty).toJS() as Record<string, any>;
    expect(parsedEmpty.mcp_servers.routersync.command).toBe('node');

    const populatedFlowTarget = path.join(tmpDir, 'hermes-populated-flow.yaml');
    const initialPopulatedFlow = [
      'model:',
      '  default: gpt-4o',
      'mcp_servers: { existing_srv: { command: "npx", args: ["-y", "srv"] } } # flow comment',
      '',
    ].join('\n');
    fs.writeFileSync(populatedFlowTarget, initialPopulatedFlow, 'utf8');

    const resPopulated = await runMcpInstallCommand({
      client: 'hermes',
      write: true,
      allowNonTtyForTest: true,
      targetFile: populatedFlowTarget,
    });
    expect(resPopulated.success).toBe(true);
    const updatedPopulated = fs.readFileSync(populatedFlowTarget, 'utf8');
    expect(updatedPopulated).toContain('# flow comment');
    const parsedPopulated = parseDocument(updatedPopulated).toJS() as Record<string, any>;
    expect(parsedPopulated.mcp_servers.existing_srv.command).toBe('npx');
    expect(parsedPopulated.mcp_servers.routersync.command).toBe('node');
  });

  it('antigravity JSON: writes mcpServers.routersync WITHOUT "type" field and preserves existing servers', async () => {
    const target = path.join(tmpDir, 'mcp_config.json');
    const initial = JSON.stringify(
      {
        mcpServers: {
          playwright: { command: 'npx', args: ['@playwright/mcp'] },
        },
      },
      null,
      2
    );
    fs.writeFileSync(target, initial, 'utf8');

    const res = await runMcpInstallCommand({
      client: 'antigravity',
      write: true,
      allowNonTtyForTest: true,
      targetFile: target,
    });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(initial);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, any>;
    expect(parsed.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp'] });
    expect(parsed.mcpServers.routersync.command).toBe('node');
    expect('type' in parsed.mcpServers.routersync).toBe(false);
  });

  it('claude-code, cursor, and openmausbot JSON: preserve all unrelated keys & instances with .bak backup, while openmausbot refuses bots.json & routines.json (Bug #3)', async () => {
    for (const client of ['claude-code', 'cursor', 'openmausbot'] as const) {
      const target = path.join(tmpDir, `${client}.json`);
      const initialObj = {
        instances: { 'openai-compat-1': { config: { model: 'm1', url: 'http://127.0.0.1:9/v1' } } },
        mcpServers: { other: { command: 'uvx', args: ['other'] } },
      };
      const initial = JSON.stringify(initialObj, null, 2);
      fs.writeFileSync(target, initial, 'utf8');

      const res = await runMcpInstallCommand({
        client,
        write: true,
        allowNonTtyForTest: true,
        targetFile: target,
      });

      expect(res.success).toBe(true);
      expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(initial);
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, any>;
      expect(parsed.instances).toEqual(initialObj.instances);
      expect(parsed.mcpServers.other).toEqual(initialObj.mcpServers.other);
      expect(parsed.mcpServers.routersync.command).toBe('node');
    }

    // Bug #3: openmausbot MUST refuse bots.json and routines.json before reading/writing
    for (const forbidden of ['bots.json', 'routines.json'] as const) {
      const forbiddenPath = path.join(tmpDir, forbidden);
      fs.writeFileSync(forbiddenPath, '{"untouched":true}', 'utf8');
      await expect(
        runMcpInstallCommand({
          client: 'openmausbot',
          write: true,
          allowNonTtyForTest: true,
          targetFile: forbiddenPath,
        })
      ).rejects.toThrow(/bots\.json|routines\.json/i);
      await expect(
        runMcpInstallCommand({
          client: 'openmausbot',
          dryRun: true,
          targetFile: forbiddenPath,
        })
      ).rejects.toThrow(/bots\.json|routines\.json/i);
      expect(fs.readFileSync(forbiddenPath, 'utf8')).toBe('{"untouched":true}');
    }
  });

  it('opencode JSONC: merges mcp.routersync with { type: "local", command: ["node", ...] } preserving // and /* */ comments', async () => {
    const target = path.join(tmpDir, 'opencode.jsonc');
    const initial = [
      '{',
      '  // OpenCode top-level comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  /* Keep provider configuration untouched */',
      '  "provider": {',
      '    "9router": {',
      '      "models": { "m1": { "name": "M1" } }',
      '    }',
      '  },',
      '  "mcp": {',
      '    // Existing local tool',
      '    "existing": { "type": "local", "command": ["npx", "demo"] }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(target, initial, 'utf8');

    const res = await runMcpInstallCommand({
      client: 'opencode',
      write: true,
      allowNonTtyForTest: true,
      targetFile: target,
    });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(initial);

    const updated = fs.readFileSync(target, 'utf8');
    expect(updated).toContain('// OpenCode top-level comment');
    expect(updated).toContain('/* Keep provider configuration untouched */');
    expect(updated).toContain('// Existing local tool');
    expect(updated).toContain('"type": "local"');
    expect(updated).toContain('"routersync"');
  });

  it('codex TOML: appends [mcp_servers.routersync] after top-level keys while preserving comments and top-level order', async () => {
    const target = path.join(tmpDir, 'config.toml');
    const initial = [
      '# Codex global settings',
      'model = "gpt-5-codex"',
      'model_provider = "openai"',
      '',
      '[model_providers.openai]',
      'name = "OpenAI"',
      '',
    ].join('\n');
    fs.writeFileSync(target, initial, 'utf8');

    const res = await runMcpInstallCommand({
      client: 'codex',
      write: true,
      allowNonTtyForTest: true,
      targetFile: target,
    });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe(initial);

    const updated = fs.readFileSync(target, 'utf8');
    expect(updated).toContain('# Codex global settings');
    const firstTableIdx = updated.indexOf('[');
    const modelIdx = updated.indexOf('model = "gpt-5-codex"');
    const mcpIdx = updated.indexOf('[mcp_servers.routersync]');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(firstTableIdx);
    expect(mcpIdx).toBeGreaterThan(firstTableIdx);
    expect(updated).toContain('command = "node"');
  });

  it('grok-bot: refuses blind local --write without explicit targetFile, and explains Remote HTTPS vs companion CLI in dry-run', async () => {
    const dry = await runMcpInstallCommand({
      client: 'grok-bot',
      dryRun: true,
    });
    expect(dry.success).toBe(true);
    expect(dry.diff).toMatch(/HTTPS|grok/i);

    await expect(
      runMcpInstallCommand({
        client: 'grok-bot',
        write: true,
        allowNonTtyForTest: true,
      })
    ).rejects.toThrow(/grok-bot|HTTPS|target|--file/i);
  });

  it('auto-rolls back from .bak when post-write read-back fails and blocks direct + symlink/junction writes into os.homedir() (Bug #1)', async () => {
    const target = path.join(tmpDir, 'cursor-rollback.json');
    const initial = JSON.stringify({ mcpServers: { keep: { command: 'node', args: ['a.js'] } } }, null, 2);
    fs.writeFileSync(target, initial, 'utf8');

    await expect(
      runMcpInstallCommand({
        client: 'cursor',
        write: true,
        allowNonTtyForTest: true,
        targetFile: target,
        injectReadBackFault: true,
      })
    ).rejects.toThrow(/read-back|rollback/i);

    expect(fs.readFileSync(target, 'utf8')).toBe(initial);

    const liveHomeTarget = path.join(os.homedir(), '.cursor', 'mcp.json');
    await expect(
      runMcpInstallCommand({
        client: 'cursor',
        write: true,
        allowNonTtyForTest: true,
        targetFile: liveHomeTarget,
      })
    ).rejects.toThrow(/homedir|home|sandbox/i);

    // Bug #1: Symlink / Windows junction inside os.tmpdir() pointing to os.homedir()
    // (including non-existent nested subdirectory) MUST be blocked deterministically.
    const simulatedHome = path.join(tmpDir, 'sim-real-home');
    const simulatedTmp = path.join(tmpDir, 'sim-os-tmp');
    fs.mkdirSync(simulatedHome, { recursive: true });
    fs.mkdirSync(simulatedTmp, { recursive: true });

    const homeLink = path.join(simulatedTmp, 'home-junction');
    fs.symlinkSync(
      simulatedHome,
      homeLink,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    stubSimulatedHomeAndTmp(simulatedHome, simulatedTmp);

    const nestedViaJunction = path.join(homeLink, 'missing-subdir', 'mcp.json');
    await expect(
      runMcpInstallCommand({
        client: 'cursor',
        write: true,
        allowNonTtyForTest: true,
        targetFile: nestedViaJunction,
      })
    ).rejects.toThrow(/homedir|home|sandbox/i);
    expect(fs.existsSync(path.join(simulatedHome, 'missing-subdir'))).toBe(false);
  });
});

describe('C45-WP1: 9-Harness Schedule Integration (--harness <id>)', () => {
  it('emits 0-token native descriptors + OS fallback for hermes and antigravity without touching live files', () => {
    const hermesPlan = resolveHarnessSchedulePlan('hermes', { intervalMinutes: 15, mode: 'propose' });
    expect(hermesPlan.harnessId).toBe('hermes');
    expect(hermesPlan.zeroTokenScriptCapable).toBe(true);
    expect(hermesPlan.selectedTier).toBe('harness-native-zero-token');
    expect(hermesPlan.nativePreview).toContain('no_agent');
    expect(hermesPlan.osFallbackArtifacts.windowsXml).toContain('<Task');

    const agyPlan = resolveHarnessSchedulePlan('antigravity', { intervalMinutes: 15, mode: 'propose' });
    expect(agyPlan.harnessId).toBe('antigravity');
    expect(agyPlan.zeroTokenScriptCapable).toBe(true);
    expect(agyPlan.selectedTier).toBe('harness-native-zero-token');
    expect(agyPlan.nativePreview).toContain('"builtin": "schedule"');
  });

  it.each(['claude-code', 'codex', 'opencode', 'cursor', 'grok-bot', 'openmausbot', 'dsh'] as const)(
    'explains why native scheduler is skipped for %s and selects OS scheduler',
    async (harnessId) => {
      const plan = resolveHarnessSchedulePlan(harnessId, { intervalMinutes: 15, mode: 'propose' });
      expect(plan.harnessId).toBe(harnessId);
      expect(plan.zeroTokenScriptCapable).toBe(false);
      expect(plan.selectedTier).toBe('os-scheduler');
      expect(plan.reason.length).toBeGreaterThan(15);
      if (harnessId === 'openmausbot') {
        expect(plan.reason).toContain('routines.json');
      }

      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
        logs.push(String(msg));
      });
      try {
        await runScheduleCommand({ action: 'dry-run', dryRun: true, harness: harnessId, json: true });
        const payload = JSON.parse(logs.join('\n')) as Record<string, any>;
        expect(payload.harnessPlan.harnessId).toBe(harnessId);
        expect(payload.harnessPlan.selectedTier).toBe('os-scheduler');
      } finally {
        spy.mockRestore();
      }
    }
  );
});
