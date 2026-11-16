/**
 * packages/cli/test/agents.test.ts
 *
 * Tests for agent harness config discovery, dry-run diffing, atomic backup,
 * apply, readback, and rollback (Hermes Agent & DeepSeek Harness).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  discoverAgentConfig,
  dryRunAgentModelUpdate,
  applyAgentModelUpdate,
  readbackAgentConfig,
  rollbackAgentModelUpdate,
  checkAgentWriteAuthorization,
  countOtherLinesChanged,
  hash16,
} from '../src/commands/agents.js';
import { createGrantFile, generateGrantSecret } from '../src/maintain/grant.js';

describe('Agent Harness Configuration Management', () => {
  let tmpHome: string;
  let hermesDir: string;
  let dshDir: string;
  let hermesConfigPath: string;
  let dshConfigPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_agent_test_'));
    hermesDir = path.join(tmpHome, '.hermes');
    dshDir = path.join(tmpHome, '.dsh', 'profiles', 'desktop');

    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(dshDir, { recursive: true });

    hermesConfigPath = path.join(hermesDir, 'config.yaml');
    dshConfigPath = path.join(dshDir, 'cordis.patch.yml');

    const sampleHermesYaml = [
      'model:',
      '  provider: 9router',
      '  default: test-1',
      'toolsets:',
      '  - web_search',
    ].join('\n') + '\n';

    const sampleDshYaml = [
      'providers:',
      '  nine-router:',
      '    displayName: 9Router',
      '    baseURL: http://127.0.0.1:20128/v1',
      '    models:',
      '      - id: existing-model',
      '        name: Existing Model',
      '  omniroute:',
      '    displayName: OmniRoute',
      '    baseURL: http://127.0.0.1:30128/v1',
    ].join('\n') + '\n';

    fs.writeFileSync(hermesConfigPath, sampleHermesYaml, 'utf8');
    fs.writeFileSync(dshConfigPath, sampleDshYaml, 'utf8');
  });

  afterEach(() => {
    delete process.env.ROUTERSYNC_GRANT_SECRET;
    if (fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('discovers Hermes and DSH configuration files', () => {
    const hermesRes = discoverAgentConfig('hermes', tmpHome);
    expect(hermesRes.verified).toBe(true);
    expect(hermesRes.exists).toBe(true);
    expect(hermesRes.format).toBe('yaml');

    const dshRes = discoverAgentConfig('dsh', tmpHome);
    expect(dshRes.verified).toBe(true);
    expect(dshRes.exists).toBe(true);
    expect(dshRes.format).toBe('yaml');
  });

  it('performs dry-run with other_lines_changed=0 for Hermes and DSH', () => {
    const hermesDry = dryRunAgentModelUpdate('hermes', {
      customHome: tmpHome,
      models: ['test-3'],
    });

    expect(hermesDry.wouldAdd).toBe(1);
    expect(hermesDry.wouldRemove).toBe(0);
    expect(hermesDry.otherLinesChanged).toBe(0);
    expect(hermesDry.updatedContent).toContain('test-3');

    const dshDry = dryRunAgentModelUpdate('dsh', {
      customHome: tmpHome,
      models: ['test-3'],
    });

    expect(dshDry.wouldAdd).toBe(1);
    expect(dshDry.wouldRemove).toBe(0);
    expect(dshDry.otherLinesChanged).toBe(0);
    expect(dshDry.updatedContent).toContain('test-3');
  });

  it('handles apply, readback, and rollback lifecycle with exact hash restoration', async () => {
    const originalHermes = fs.readFileSync(hermesConfigPath, 'utf8');
    const shaOrig = hash16(originalHermes);

    // Write valid grant file into temporary stateDir
    const stateDir = path.join(tmpHome, '.routersync');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    const grant = {
      version: 1,
      id: '0123456789abcdef',
      combos: ['test-1', 'test-2', 'test-3'],
      agents: ['hermes', 'dsh'],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    } as const;
    const secret = generateGrantSecret();
    process.env.ROUTERSYNC_GRANT_SECRET = secret;
    fs.writeFileSync(
      path.join(stateDir, 'apply-grant.json'),
      JSON.stringify(createGrantFile(grant, secret), null, 2),
      'utf8'
    );

    const applyRes = await applyAgentModelUpdate('hermes', {
      customHome: tmpHome,
      models: ['test-3'],
      stateDir,
    });

    expect(applyRes.added).toBe(1);
    expect(applyRes.shaBefore).toBe(shaOrig);
    expect(applyRes.shaAfter).not.toBe(shaOrig);
    expect(fs.existsSync(applyRes.backupPath)).toBe(true);

    // Readback verification
    const readback = readbackAgentConfig('hermes', hermesConfigPath);
    expect(readback.parseOk).toBe(true);

    // Rollback verification
    const rollback = rollbackAgentModelUpdate('hermes', {
      configPath: hermesConfigPath,
      backupPath: applyRes.backupPath,
      originalContent: applyRes.originalContent,
    });

    expect(rollback.shaEqualsBefore).toBe(true);
    const restoredContent = fs.readFileSync(hermesConfigPath, 'utf8');
    expect(hash16(restoredContent)).toBe(shaOrig);
  });

  it('countOtherLinesChanged accurately detects changes outside model blocks', () => {
    const orig = 'model:\n  provider: 9router\n';
    const modified = 'model:\n  provider: omniroute\n';
    expect(countOtherLinesChanged(orig, modified)).toBe(1);

    const modelAdded = 'model:\n  models:\n    - id: m1\n      name: m1\n  provider: 9router\n';
    expect(countOtherLinesChanged(orig, modelAdded)).toBe(0);
  });

  it('dry-run returns wouldAdd=0 when model already exists in configuration', () => {
    const dryFirst = dryRunAgentModelUpdate('dsh', {
      customHome: tmpHome,
      models: ['existing-model'],
    });
    expect(dryFirst.wouldAdd).toBe(0);
    expect(dryFirst.updatedContent).toBe(dryFirst.originalContent);
  });

  it('checkAgentWriteAuthorization rejects unauthorized write with grant-scope or no-tty', () => {
    // Grant without hermes in agents scope
    const stateDir = path.join(tmpHome, '.routersync_scope');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    const grant = {
      version: 1,
      id: '0123456789abcdef',
      combos: ['test-1'],
      agents: ['dsh'],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    } as const;
    const secret = generateGrantSecret();
    process.env.ROUTERSYNC_GRANT_SECRET = secret;
    fs.writeFileSync(
      path.join(stateDir, 'apply-grant.json'),
      JSON.stringify(createGrantFile(grant, secret), null, 2),
      'utf8'
    );

    // Save stdin TTY state and test
    const origIsTTY = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const auth = checkAgentWriteAuthorization({
        agent: 'hermes',
        stateDir,
      });
      expect(auth.authorized).toBe(false);
      expect(auth.reason).toBe('grant-scope');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('readbackAgentConfig reports parseOk=false for malformed configuration files', () => {
    const malformedPath = path.join(tmpHome, 'broken.yaml');
    fs.writeFileSync(malformedPath, ':: invalid yaml: [unclosed', 'utf8');
    const readback = readbackAgentConfig('hermes', malformedPath);
    expect(readback.parseOk).toBe(false);
  });

  it('rollbackAgentModelUpdate throws when backup content is missing', () => {
    expect(() =>
      rollbackAgentModelUpdate('hermes', {
        configPath: hermesConfigPath,
        backupPath: path.join(tmpHome, 'nonexistent.bak'),
      })
    ).toThrow(/backup content missing/);
  });
});
