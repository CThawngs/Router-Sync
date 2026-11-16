/**
 * packages/cli/test/agents-update-chain.test.ts
 *
 * Exercises the unified `agents update` handler against real files in a
 * throwaway home directory: apply -> readback -> rollback -> re-apply.
 * The assertions read the actual emitted lines and the actual file bytes,
 * so a mocked or hard-coded evidence line cannot pass this suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runAgentsUpdateCommand, hash16 } from '../src/commands/agents.js';
import { createGrantFile, generateGrantSecret } from '../src/maintain/grant.js';

describe('agents update chain (apply -> readback -> rollback -> re-apply)', () => {
  let tmpHome: string;
  let hermesConfigPath: string;
  let dshConfigPath: string;
  let stateDir: string;
  let lines: string[];

  const grantFile = (agents: string[]): void => {
    const now = Date.now();
    const secret = generateGrantSecret();
    process.env.ROUTERSYNC_GRANT_SECRET = secret;
    const grant = {
      version: 1 as const,
      id: 'fedcba9876543210',
      combos: ['test-1', 'test-2', 'test-3'],
      agents,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600 * 1000).toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, 'apply-grant.json'),
      JSON.stringify(createGrantFile(grant, secret), null, 2),
      'utf8'
    );
  };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_chain_'));
    const hermesDir = path.join(tmpHome, '.hermes');
    const dshDir = path.join(tmpHome, '.dsh', 'profiles', 'desktop');
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(dshDir, { recursive: true });

    hermesConfigPath = path.join(hermesDir, 'config.yaml');
    dshConfigPath = path.join(dshDir, 'cordis.patch.yml');
    stateDir = path.join(tmpHome, '.routersync');
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      hermesConfigPath,
      [
        'model:',
        '  provider: 9router',
        '  default: test-1',
        'toolsets:',
        '  - web_search',
        '',
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      dshConfigPath,
      [
        'providers:',
        '  nine-router:',
        '    displayName: 9Router',
        '    models:',
        '      - id: existing-model',
        '        name: Existing Model',
        '  omniroute:',
        '    displayName: OmniRoute',
        '    models:',
        '',
      ].join('\n'),
      'utf8'
    );

    grantFile(['hermes', 'dsh']);
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ROUTERSYNC_GRANT_SECRET;
    if (fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('emits the full chain for hermes on a non-default provider and leaves the applied state', async () => {
    const shaOrig = hash16(fs.readFileSync(hermesConfigPath, 'utf8'));

    await runAgentsUpdateCommand({
      agent: 'hermes',
      provider: 'omniroute',
      models: 'test-3',
      home: tmpHome,
      stateDir,
    });

    const apply = lines.find((l) => /^AGENT-APPLY agent=hermes /.test(l));
    expect(apply).toBeDefined();
    expect(apply).toMatch(/provider=omniroute\b/);
    expect(apply).toMatch(/added=1 removed=0\b/);
    expect(apply).toMatch(/sha_before=[0-9a-f]{16} sha_after=[0-9a-f]{16}/);
    expect(apply).toContain(`sha_before=${shaOrig}`);

    const readback = lines.find((l) => /^AGENT-READBACK agent=hermes /.test(l));
    expect(readback).toBe('AGENT-READBACK agent=hermes parse_ok=yes');

    const rollback = lines.find((l) => /^AGENT-ROLLBACK agent=hermes /.test(l));
    expect(rollback).toBe('AGENT-ROLLBACK agent=hermes sha_equals_before=yes');

    const final = lines.find((l) => /^AGENT-FINAL agent=hermes /.test(l));
    expect(final).toBeDefined();
    const finalMatch = /^AGENT-FINAL agent=hermes provider=omniroute sha=([0-9a-f]{16}) equals_applied=yes$/.exec(
      final ?? ''
    );
    expect(finalMatch).not.toBeNull();

    const appliedSha = /sha_after=([0-9a-f]{16})/.exec(apply ?? '')?.[1];
    expect(finalMatch?.[1]).toBe(appliedSha);
    expect(hash16(fs.readFileSync(hermesConfigPath, 'utf8'))).toBe(appliedSha);
    expect(fs.readFileSync(hermesConfigPath, 'utf8')).toContain('test-3');
  });

  it('keeps unrelated lines untouched for both agents', async () => {
    const dshOrig = fs.readFileSync(dshConfigPath, 'utf8');

    await runAgentsUpdateCommand({
      agent: 'dsh',
      provider: 'omniroute',
      models: 'test-3',
      home: tmpHome,
      stateDir,
    });

    expect(lines.some((l) => /^AGENT-FINAL agent=dsh provider=omniroute sha=[0-9a-f]{16} equals_applied=yes$/.test(l))).toBe(
      true
    );
    const dshNow = fs.readFileSync(dshConfigPath, 'utf8');
    expect(dshNow).toContain('displayName: 9Router');
    expect(dshNow).toContain('displayName: OmniRoute');
    expect(dshNow.length).toBeGreaterThan(dshOrig.length);
  });

  it('reports AGENT-SKIPPED with a reason instead of crashing when nothing can be added', async () => {
    await runAgentsUpdateCommand({
      agent: 'hermes',
      provider: 'omniroute',
      models: 'test-3',
      home: tmpHome,
      stateDir,
    });
    const firstFinal = lines.find((l) => /^AGENT-FINAL agent=hermes/.test(l));
    expect(firstFinal).toBeDefined();

    lines = [];
    await runAgentsUpdateCommand({
      agent: 'hermes',
      provider: 'omniroute',
      models: 'test-3',
      home: tmpHome,
      stateDir,
    });

    const skipped = lines.find((l) => /^AGENT-SKIPPED agent=hermes reason=/.test(l));
    expect(skipped).toBeDefined();
    expect(skipped).toMatch(/reason=\S+/);
    expect(lines.some((l) => /^AGENT-FINAL agent=hermes/.test(l))).toBe(false);
  });

  it('dry-run through the update handler reports other_lines_changed=0 for both agents', async () => {
    await runAgentsUpdateCommand({
      agent: 'all',
      provider: 'omniroute',
      models: 'test-3',
      home: tmpHome,
      stateDir,
      dryRun: true,
    });

    const dryLines = lines.filter((l) => /^AGENT-DRYRUN /.test(l));
    expect(dryLines).toHaveLength(2);
    for (const l of dryLines) {
      expect(l).toMatch(/^AGENT-DRYRUN agent=(hermes|dsh) provider=omniroute would_add=1 would_remove=0 other_lines_changed=0$/);
    }
  });
});
