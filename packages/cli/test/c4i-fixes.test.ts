/**
 * packages/cli/test/c4i-fixes.test.ts
 *
 * Proofs for the nine known bugs fixed in round C4i (K4.1 - K4.9).
 * Every test states the bug it covers so the evidence in RUN.txt can be
 * traced back to the issue.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { providerHasSingleModelGet, loadGatewayRegistry } from '../src/verify/gateways.js';
import { normalizeConfirmWord, confirmWordMatches, stateDirForTest } from '../src/commands/sync/sync-state.js';
import { loadRankingConfig } from '../src/rank/config.js';
import { resolveCatalogPresence, type ProviderCatalogEntry } from '../src/commands/tick.js';
import { classifyVerificationLabel } from '../src/verify/verifier.js';
import { loadProviderRegistry } from '../src/sync/provider-registry.js';
import { loadDeadModelsConfig } from '../src/commands/dead-models.js';
import { openBetterSqlite3 } from '@routersync/core';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('K4.1 - the gateway without single-model GET comes from the registry', () => {
  it('reads the gateway list from registry/gateways.yaml', () => {
    const gateways = loadGatewayRegistry(repoRoot);
    const nodeB = gateways.find((g) => g.id === 'node-b');
    expect(nodeB, 'node-b must be listed in registry/gateways.yaml').toBeDefined();
    expect(nodeB?.hasSingleModelGet).toBe(false);
  });

  it('a gateway without single-model GET is detected by name, not by a hardcoded string', () => {
    expect(providerHasSingleModelGet('node-b', repoRoot)).toBe(false);
    expect(providerHasSingleModelGet('NODE-B', repoRoot)).toBe(false);
    // A normal provider keeps the single-model GET.
    expect(providerHasSingleModelGet('groq', repoRoot)).toBe(true);
  });

  it('the source no longer contains the hardcoded gateway name', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'packages', 'cli', 'src', 'commands', 'tick.ts'),
      'utf8'
    );
    expect(source).not.toContain("includes('node-b')");
    expect(source).toContain('providerHasSingleModelGet');
  });
});

describe('K4.3 - the confirmation word accepts both spellings', () => {
  it('folds a typed answer to a comparable form', () => {
    expect(normalizeConfirmWord('  CHAY  ')).toBe('chay');
    expect(normalizeConfirmWord('chay')).toBe('chay');
  });

  it('matches the accented and the plain spelling of the same word', () => {
    const accented = 'ch' + String.fromCharCode(0x1EA1) + 'y';
    expect(confirmWordMatches(accented, 'chay')).toBe(true);
    expect(confirmWordMatches('chay', accented)).toBe(true);
    expect(confirmWordMatches('CHAY', accented)).toBe(true);
  });

  it('rejects a different word', () => {
    expect(confirmWordMatches('yes', 'chay')).toBe(false);
    expect(confirmWordMatches('', 'chay')).toBe(false);
  });
});

describe('K4.5 - a tick does not print the missing-policy banner', () => {
  const missingPolicy = path.join(os.tmpdir(), 'routersync-c4i-missing', 'ranking.yaml');

  it('the quiet load prints nothing on stderr', () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      const result = loadRankingConfig(missingPolicy, { quiet: true });
      expect(result.isDefault).toBe(true);
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(captured).toBe('');
  });

  it('the normal load still prints the guidance (a write path needs it)', () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      loadRankingConfig(missingPolicy);
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    expect(captured).toContain('ranking.yaml');
  });
});

describe('K4.8 - a failed scan never produces "confirmed alive"', () => {
  function providerEntry(overrides: Partial<ProviderCatalogEntry>): ProviderCatalogEntry {
    return {
      prefix: 'demo',
      router: '9router',
      hash: 'h',
      ids: ['model-a'],
      absenceCounts: {},
      consecutiveFailures: 1,
      backoffUntilMs: 0,
      lastStatus: 200,
      lastLabel: 'OK',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('a 401 scan leaves the old list unconfirmed', () => {
    const presence = resolveCatalogPresence(
      providerEntry({ lastStatus: 401 }),
      'model-a'
    );
    expect(presence.scanFailed).toBe(true);
    expect(presence.l1Exists).toBe(false);
    expect(presence.absenceCount).toBe(0);
  });

  it('a 500 scan leaves the old list unconfirmed', () => {
    const presence = resolveCatalogPresence(
      providerEntry({ lastStatus: 500 }),
      'model-a'
    );
    expect(presence.l1Exists).toBe(false);
  });

  it('the label of a model from a failed scan is CHƯA-XÁC-MINH, not ĐÃ-XÁC-NHẬN-CÒN', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 401 }), 'model-a');
    const label = classifyVerificationLabel(
      {
        exists: presence.l1Exists,
        status: 401,
        absenceCount: presence.absenceCount,
        isUnscanned: false,
      },
      { exists: false },
      { hasNotice: false },
      true
    );
    expect(label).toBe('CHƯA-XÁC-MINH');
    expect(label).not.toBe('ĐÃ-XÁC-NHẬN-CÒN');
  });

  it('a successful scan still confirms the model', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 200 }), 'model-a');
    expect(presence.l1Exists).toBe(true);
    const label = classifyVerificationLabel(
      { exists: presence.l1Exists, status: 200, absenceCount: 0, isUnscanned: false },
      { exists: false },
      { hasNotice: false },
      true
    );
    expect(label).toBe('ĐÃ-XÁC-NHẬN-CÒN');
  });

  it('a 429 (quota) keeps the previous catalog valid', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 429 }), 'model-a');
    expect(presence.scanFailed).toBe(false);
    expect(presence.l1Exists).toBe(true);
  });

  it('J4 - status 0 (network failure / connection error) marks scanFailed and leaves list unconfirmed', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 0 }), 'model-a');
    expect(presence.scanFailed).toBe(true);
    expect(presence.l1Exists).toBe(false);
    expect(presence.absenceCount).toBe(0);
  });

  it('J4 - status 408 (timeout) marks scanFailed', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 408 }), 'model-a');
    expect(presence.scanFailed).toBe(true);
    expect(presence.l1Exists).toBe(false);
  });

  it('J4 - status 304 (not modified) keeps the previous catalog valid', () => {
    const presence = resolveCatalogPresence(providerEntry({ lastStatus: 304 }), 'model-a');
    expect(presence.scanFailed).toBe(false);
    expect(presence.l1Exists).toBe(true);
  });
});

describe('K4.9 - a missing router database explains what to do', () => {
  it('the error names the file, the override variables and the standard paths', () => {
    const missing = path.join(os.tmpdir(), 'routersync-c4i-missing-db', 'data.sqlite');
    let message = '';
    try {
      openBetterSqlite3(missing, { readOnly: true });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('ROUTERSYNC_9ROUTER_DB');
    expect(message).toContain('ROUTERSYNC_OMNIROUTE_DB');
    expect(message).toContain('9router');
    expect(message).toContain('omniroute');
    // The library message is kept for debugging, but the friendly guidance
    // comes first.
    expect(message).toContain('The file (or its folder) does not exist');
    expect(message.indexOf('The file (or its folder) does not exist')).toBeLessThan(
      message.indexOf('Original error:')
    );
  });
});


describe('J7 - sync state directory is platform-aware and can be overridden', () => {
  it('macOS uses $XDG_STATE_HOME/routersync', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-state-xdg-'));
    try {
      const env = { XDG_STATE_HOME: tmpDir, HOME: '/home/tester' }; // no-secrets:allow: synthetic test path
      const dir = stateDirForTest(env, 'darwin');
      expect(dir).toContain(path.join(tmpDir, 'routersync'));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Linux falls back to ~/.local/state/routersync when $XDG_STATE_HOME is absent', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-state-home-'));
    try {
      const env = { HOME: tmpHome };
      const dir = stateDirForTest(env, 'linux');
      expect(dir).toBe(path.join(tmpHome, '.local', 'state', 'routersync'));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('Windows uses %LOCALAPPDATA%\\routersync', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-state-win-'));
    try {
      const env = { LOCALAPPDATA: tmpDir };
      const dir = stateDirForTest(env, 'win32');
      expect(dir).toBe(path.join(tmpDir, 'routersync'));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ROUTERSYNC_SYNC_STATE_DIR overrides on every platform', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-state-override-'));
    try {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const env = { ROUTERSYNC_SYNC_STATE_DIR: tmpDir };
        const dir = stateDirForTest(env, platform);
        expect(dir).toBe(path.resolve(tmpDir));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('K2 and K4.6 - owner-specific data lives in the registry, not in the source', () => {
  it('the provider table is shared data and holds no private provider', () => {
    const registry = loadProviderRegistry(repoRoot);
    expect(Object.keys(registry.providers).length).toBeGreaterThan(0);
    expect(registry.providers['openrouter']).toBeTruthy();
    // The names below are private to the machine owner and must not be in the
    // published provider table.
    for (const privateId of ['node-a', 'ocz', 'opencode-zen', 'provider-o']) {
      expect(registry.providers[privateId], privateId + ' must not be a published provider').toBeUndefined();
      expect(registry.noKeyPublic).not.toContain(privateId);
    }
  });

  it('the dead-model command has no built-in model list', () => {
    const config = loadDeadModelsConfig(repoRoot);
    expect(Array.isArray(config.candidates)).toBe(true);
    expect(config.catalogSizes).toEqual([]);

    const source = fs.readFileSync(
      path.join(repoRoot, 'packages', 'cli', 'src', 'commands', 'dead-models.ts'),
      'utf8'
    );
    expect(source).not.toContain('apodex-1.1-mini-sale');
    expect(source).not.toContain('node-a.example.vn');
  });
});
