/**
 * packages/cli/test/apps.test.ts
 *
 * Read-only contract tests for the agent app inspection adapters.
 * Fixtures are synthetic: key values are `<KEY>`, URLs use example.invalid.
 * The fake-key case builds its key at runtime so no key-looking literal lands
 * in a tracked file (tools/guard/no-secrets.mjs).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_APP_ADAPTERS,
  dshAdapter,
  hermesAdapter,
  opencodeAdapter,
  type AgentAppId,
} from '../src/apps/inspect.js';
import { runAppsInspectCommand } from '../src/commands/apps.js';

const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/agent-apps/', import.meta.url));

// Built at runtime: never a literal `sk-...` token in this file.
const FAKE_KEY = ['sk', 'fakeFAKEfakeFAKEfakeFAKE123456'].join('-');

const tmpDirs: string[] = [];

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-apps-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Case {
  app: AgentAppId;
  fixture: string;
  corrupt: string;
  missing: string;
  fakeKeyConfig: string;
  expectedProvider: string;
  expectedModel: string;
  expectedActive: string;
}

const cases: Case[] = [
  {
    app: 'hermes',
    fixture: 'hermes.config.yaml',
    corrupt: 'key: value: extra\n',
    missing: 'agent:\n  max_turns: 5\n',
    fakeKeyConfig: `custom_providers:\n  - name: leak-check\n    base_url: https://example.invalid/v1\n    api_key: ${FAKE_KEY}\n`,
    expectedProvider: '9router',
    expectedModel: '9Router-Coder-1',
    expectedActive: '9router/9Router-Coder-1',
  },
  {
    app: 'dsh',
    fixture: 'dsh.cordis.patch.yml',
    corrupt: 'key: value: extra\n',
    missing: '- id: unrelated\n  config:\n    value: 1\n',
    fakeKeyConfig: `- id: llm-pi-ai\n  config:\n    providers:\n      leak-check:\n        apiKeyEnv: LEAK_CHECK\n        apiKey: ${FAKE_KEY}\n        baseURL: https://example.invalid/v1\n`,
    expectedProvider: '9router',
    expectedModel: '9Router-Coder-1',
    expectedActive: '9router/9Router-Coder-1',
  },
  {
    app: 'opencode',
    fixture: 'opencode.json',
    corrupt: '{ "provider": ',
    missing: '{ "mcp": {} }\n',
    fakeKeyConfig: JSON.stringify({
      provider: { 'leak-check': { options: { baseURL: 'https://example.invalid/v1', apiKey: FAKE_KEY } } },
    }),
    expectedProvider: '9router',
    expectedModel: '9Router-Coder-1',
    expectedActive: 'UNKNOWN',
  },
];

const adapters = { hermes: hermesAdapter, dsh: dshAdapter, opencode: opencodeAdapter };

describe('agent app inspection contract', () => {
  it('exposes exactly the supported apps and is read-only', () => {
    expect(AGENT_APP_ADAPTERS.map((a) => a.app)).toEqual(['hermes', 'dsh', 'opencode']);
    for (const adapter of AGENT_APP_ADAPTERS) {
      expect('write' in adapter).toBe(false);
      expect('apply' in adapter).toBe(false);
    }
  });
});

describe.each(cases)('$app adapter', (testCase) => {
  const adapter = adapters[testCase.app];

  it('normalizes a valid config without exposing values', async () => {
    const result = await adapter.inspect({ configPath: path.join(FIXTURES, testCase.fixture) });

    expect(result.readOnly).toBe(true);
    expect(result.app).toBe(testCase.app);
    expect(result.format).toBe(adapter.format);
    expect(result.providers.map((p) => p.id)).toContain(testCase.expectedProvider);
    expect(result.models.map((m) => m.id)).toContain(testCase.expectedModel);
    expect(result.activeModel).toBe(testCase.expectedActive);
    for (const provider of result.providers) {
      expect(typeof provider.baseUrlPresent).toBe('boolean');
      expect(typeof provider.keyPresent).toBe('boolean');
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('https://example.invalid');
    expect(serialized).not.toContain('<KEY>');
  });

  it('records warnings and UNKNOWN state when a field is missing', async () => {
    const file = tmpFile(`missing-${testCase.app}`, testCase.missing);
    const result = await adapter.inspect({ configPath: file });

    expect(result.activeModel).toBe('UNKNOWN');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.certainty).toBe('C');
  });

  it('rejects a corrupt file with PARSE', async () => {
    const file = tmpFile(`corrupt-${testCase.app}`, testCase.corrupt);
    await expect(adapter.inspect({ configPath: file })).rejects.toMatchObject({ code: 'PARSE' });
  });

  it('rejects a very large file with TOO_LARGE', async () => {
    const file = tmpFile(`large-${testCase.app}`, 'a'.repeat(4096));
    await expect(adapter.inspect({ configPath: file, maxBytes: 1024 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
  });

  it('rejects a nonexistent path with ENOENT', async () => {
    const file = path.join(os.tmpdir(), `rs-apps-missing-${testCase.app}-${Date.now()}`, 'nope');
    await expect(adapter.inspect({ configPath: file })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never leaks a fake key into the result, the log or the CLI output', async () => {
    const file = tmpFile(`leak-${testCase.app}`, testCase.fakeKeyConfig);
    const result = await adapter.inspect({ configPath: file });

    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(result.warnings.join(' ')).not.toContain(FAKE_KEY);
    expect(result.providers.some((p) => p.keyPresent)).toBe(true);

    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAppsInspectCommand({ app: testCase.app, config: file, json: true });
    await runAppsInspectCommand({ app: testCase.app, config: file });

    const output = written.join('');
    expect(output).toContain(testCase.app);
    expect(output).not.toContain(FAKE_KEY);
    expect(output).not.toMatch(/sk-[a-zA-Z0-9]/);
  });
});

describe('apps inspect command', () => {
  it('masks the home directory and prints the four table columns', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-apps-home-'));
    tmpDirs.push(home);
    fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'hermes.config.yaml'), path.join(home, '.hermes', 'config.yaml'));

    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

    await runAppsInspectCommand({ app: 'hermes', home });

    const output = written.join('');
    expect(output).toMatch(/app\s+provider\s+model\s+trạng thái/);
    expect(output).not.toContain(home);
    expect(output).toMatch(/<HOME>|\.hermes/);
  });

  it('exits 1 for an unsupported app name', async () => {
    const savedExit = process.exitCode;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    try {
      await runAppsInspectCommand({ app: 'not-an-app' });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExit;
    }
  });
});
