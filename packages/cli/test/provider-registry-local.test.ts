/**
 * packages/cli/test/provider-registry-local.test.ts
 *
 * Verification of public provider registry integrity, local layering mechanism,
 * and key-routing credential isolation (Condition Y1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findProviderRegistryFile,
  loadProviderRegistry,
} from '../src/sync/provider-registry.js';
import { resolveProviderTargets } from '../src/sync/providers.js';
import { openBetterSqlite3 } from '@routersync/core';

describe('Condition Y1: Provider Registry and Local Layering', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-reg-test-'));
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';
  });

  afterEach(() => {
    process.env = { ...origEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // (a) registry công khai không chứa host giả hay alias trỏ sai
  it('(a) public registry contains no synthetic hosts, unroutable example.com URLs, or cross-mapped aliases', () => {
    const regFile = findProviderRegistryFile();
    expect(regFile).not.toBeNull();
    const content = fs.readFileSync(regFile!, 'utf8');

    // Must not contain fake/synthetic hostnames or test domains in public registry
    expect(content).not.toContain('zen-gateway');
    expect(content).not.toContain('example.com');
    expect(content).not.toContain('bzl-gateway');
    expect(content).not.toContain('custom-node');

    const reg = loadProviderRegistry({ cwd: path.dirname(path.dirname(regFile!)), localPath: null });
    // bzl alias must NOT point to huggingface
    expect(reg.alias['bzl']).toBeUndefined();
    expect(reg.providers['zen-gateway']).toBeUndefined();

    // Verify catalog-trust.yaml does not contain fake nodes
    const trustFile = path.join(path.dirname(regFile!), 'catalog-trust.yaml');
    if (fs.existsSync(trustFile)) {
      const trustContent = fs.readFileSync(trustFile, 'utf8');
      expect(trustContent).not.toContain('custom-node');
      expect(trustContent).not.toContain('bzl-gateway');
    }
  });

  // (b) nạp file cục bộ làm provider riêng quét được ở bước dry-run trên fixture
  it('(b) loads local provider registry override and resolves private provider targets in dry-run', () => {
    const localYaml = path.join(tmpDir, 'providers.local.yaml');
    fs.writeFileSync(
      localYaml,
      `
providers:
  privategw: https://privategw.test/v1
alias:
  pgw: privategw
noKeyPublic:
  - privategw
`,
      'utf8'
    );

    // Verify local layering merges over public registry
    const reg = loadProviderRegistry({ localPath: localYaml });
    expect(reg.providers['privategw']).toBe('https://privategw.test/v1');
    expect(reg.alias['pgw']).toBe('privategw');
    expect(reg.noKeyPublic).toContain('privategw');

    // Create a mock router sqlite DB with connection for privategw
    const dbPath = path.join(tmpDir, '9router.sqlite');
    const db = openBetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE providerConnections (
        provider TEXT,
        name TEXT,
        authType TEXT,
        isActive INTEGER,
        data TEXT
      );
      CREATE TABLE providerNodes (
        id TEXT,
        data TEXT
      );
      INSERT INTO providerConnections VALUES (
        'privategw',
        'Private Gateway Node',
        'apikey',
        1,
        '{"apiKey":"test-secret-key-123","baseUrl":"https://privategw.test/v1"}'
      );
    `);
    db.close();

    // Set env to use local registry and mock DB for target resolution
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = localYaml;
    process.env['ROUTERSYNC_9ROUTER_DB'] = dbPath;

    // Dry-run target resolution
    const targets = resolveProviderTargets('9router', ['pgw']);
    expect(targets.length).toBe(1);
    const target = targets[0]!;
    expect(target.prefix).toBe('pgw');
    expect(target.id).toBe('privategw');
    expect(target.baseUrl).toBe('https://privategw.test/v1');
    expect(target.apiKey).toBe('test-secret-key-123');
    expect(target.keySource).toBe('9router-key');
    expect(target.skipReason).toBeUndefined();
  });

  // (c) provider khai báo cục bộ không bị gửi khóa tới host khác
  it('(c) credentials for locally declared providers are strictly isolated and never routed to public hosts', () => {
    const localYaml = path.join(tmpDir, 'providers.local.yaml');
    fs.writeFileSync(
      localYaml,
      `
providers:
  private-vault: https://vault.private.internal/api/v1
alias:
  pv: private-vault
`,
      'utf8'
    );
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = localYaml;

    // Mock DB with connections for private-vault AND huggingface
    const dbPath = path.join(tmpDir, 'test-isolation.sqlite');
    const db = openBetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE providerConnections (
        provider TEXT,
        name TEXT,
        authType TEXT,
        isActive INTEGER,
        data TEXT
      );
      CREATE TABLE providerNodes (
        id TEXT,
        data TEXT
      );
      INSERT INTO providerConnections VALUES (
        'private-vault',
        'Private Vault',
        'apikey',
        1,
        '{"apiKey":"private-vault-secret-key","baseUrl":"https://vault.private.internal/api/v1"}'
      );
      INSERT INTO providerConnections VALUES (
        'huggingface',
        'Public HuggingFace',
        'apikey',
        1,
        '{"apiKey":"hf-public-key"}'
      );
    `);
    db.close();

    process.env['ROUTERSYNC_9ROUTER_DB'] = dbPath;

    // Resolve targets for both private-vault prefix 'pv' and public 'hf'
    const targets = resolveProviderTargets('9router', ['pv', 'hf']);
    expect(targets.length).toBe(2);

    const pvTarget = targets.find((t) => t.prefix === 'pv');
    const hfTarget = targets.find((t) => t.prefix === 'hf');

    expect(pvTarget).toBeDefined();
    expect(hfTarget).toBeDefined();

    // STRICT ISOLATION ASSERTIONS:
    // 1. Private vault key must ONLY be sent to vault.private.internal
    expect(pvTarget!.baseUrl).toBe('https://vault.private.internal/api/v1');
    expect(pvTarget!.apiKey).toBe('private-vault-secret-key');
    expect(pvTarget!.baseUrl).not.toContain('huggingface.co');
    expect(pvTarget!.baseUrl).not.toContain('example.com');

    // 2. Public HuggingFace must receive hf-public-key at huggingface.co, never the private key
    expect(hfTarget!.apiKey).toBe('hf-public-key');
    expect(hfTarget!.apiKey).not.toBe('private-vault-secret-key');
    expect(hfTarget!.baseUrl).toContain('huggingface.co');

    // 3. Alias 'bzl' (if not declared in local registry) must NOT alias to huggingface
    const reg = loadProviderRegistry();
    if (reg.alias['bzl']) {
      expect(reg.alias['bzl']).not.toBe('huggingface');
    }
  });

  // Condition Z1 (a): providers.local.yaml in working directory outside allowed paths is strictly ignored
  it('Z1 (a): providers.local.yaml in working directory is strictly ignored unless in allowed stateDir, env, or explicit path', () => {
    // Create a fake working directory with an unpermitted providers.local.yaml
    const fakeCwd = path.join(tmpDir, 'fake-repo-workdir');
    fs.mkdirSync(fakeCwd, { recursive: true });
    const rogueYaml = path.join(fakeCwd, 'providers.local.yaml');
    fs.writeFileSync(
      rogueYaml,
      `
providers:
  rogue-provider: https://rogue.malicious.internal/v1
`,
      'utf8'
    );

    // Ensure ROUTERSYNC_PROVIDERS_LOCAL is empty and ROUTERSYNC_STATE_DIR points to an empty dir
    const emptyStateDir = path.join(tmpDir, 'empty-state-dir');
    fs.mkdirSync(emptyStateDir, { recursive: true });
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = '';
    process.env['ROUTERSYNC_STATE_DIR'] = emptyStateDir;

    // Loading registry with cwd = fakeCwd must NOT pick up rogueYaml
    const reg = loadProviderRegistry({ cwd: fakeCwd });
    expect(reg.providers['rogue-provider']).toBeUndefined();
  });

  // Condition Z1 (b): local registry entry colliding with public provider cannot override URL and emits warning
  it('Z1 (b): local registry entry cannot override URL of existing public provider; drops collision and warns without secrets', () => {
    const localYaml = path.join(tmpDir, 'providers.local.yaml');
    fs.writeFileSync(
      localYaml,
      `
providers:
  openrouter: https://evil-hijack.attacker.com/v1
  my-private-gw: https://legit-private.internal/v1
alias:
  hf: rogue-hf-hijack
  my-alias: my-private-gw
`,
      'utf8'
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };

    try {
      const reg = loadProviderRegistry({ localPath: localYaml });

      // 1. openrouter must retain genuine public URL, NOT the attacker URL
      expect(reg.providers['openrouter']).toBe('https://openrouter.ai/api/v1');
      expect(reg.providers['openrouter']).not.toBe('https://evil-hijack.attacker.com/v1');

      // 2. Non-conflicting private gateway IS preserved
      expect(reg.providers['my-private-gw']).toBe('https://legit-private.internal/v1');

      // 3. Alias 'hf' must retain public target 'huggingface'
      expect(reg.alias['hf']).toBe('huggingface');
      expect(reg.alias['my-alias']).toBe('my-private-gw');

      // 4. Warning was emitted naming the provider, but no secrets or credentials
      expect(warnings.some((w) => w.includes('openrouter') && w.includes('already exists in public registry'))).toBe(true);
      expect(warnings.some((w) => w.includes('hf') && w.includes('already exists in public registry'))).toBe(true);
      for (const w of warnings) {
        expect(w).not.toContain('apiKey');
        expect(w).not.toContain('secret');
        expect(w).not.toContain('token');
      }
    } finally {
      console.warn = origWarn;
    }
  });
});
