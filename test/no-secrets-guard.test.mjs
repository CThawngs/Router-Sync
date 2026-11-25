import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { scanLine, FORBIDDEN_PATTERNS, loadPrivatePatterns, getStagedOrTrackedFiles, runGuard, buildGuardPatterns } from '../tools/guard/no-secrets.mjs';
import { loadLocalProviderNames, buildProviderPatterns } from '../tools/guard/local-provider-names.mjs';
import { buildPatterns as buildPathPatterns } from '../tools/guard/no-personal-paths.mjs';

describe('tools/guard/no-secrets.mjs - Security Guard & Personal Path Tests (R7B-4)', () => {
  it('catches forward-slash Windows personal path', () => {
    const forwardSlashLine = 'const filePath = "c:/Users/someone/project/file.txt";'; // no-secrets:allow: synthetic test path for guard verification
    const result = scanLine(forwardSlashLine);
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Personal Windows Path/);
  });

  it('catches backslash Windows personal path', () => {
    const backslashLine = 'const filePath = "C:\\\\Users\\\\someone\\\\project\\\\file.txt";'; // no-secrets:allow: synthetic test path for guard verification
    const result = scanLine(backslashLine);
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Personal Windows Path/);
  });

  it('catches file URL pattern', () => {
    const fileUrlLine = 'See details at [SPEC](file:///c:/some/path/SPEC.md)'; // no-secrets:allow: synthetic test URL for guard verification
    const result = scanLine(fileUrlLine);
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Absolute file URL/);
  });

  it('exempts line with valid allow marker even if it contains forward-slash path', () => {
    const allowedLine = 'const synthetic = "c:/Users/testuser/fixture"; // no-secrets:allow: synthetic test fixture'; // no-secrets:allow: synthetic fixture with allow marker
    const result = scanLine(allowedLine);
    expect(result.ok).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it('rejects line with bare allow marker missing reason', () => {
    const bareLine = 'const synthetic = "c:/Users/testuser/fixture"; // no-secrets:allow'; // no-secrets:allow: synthetic bare marker test string
    const result = scanLine(bareLine);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bare-marker');
  });

  it('passes clean line without forbidden patterns', () => {
    const cleanLine = 'const projectDir = path.join(os.homedir(), ".config", "routersync");';
    const result = scanLine(cleanLine);
    expect(result.ok).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('catches email address', () => {
    const result = scanLine('contact: admin@mail.router-sync-guard.dev'); // no-secrets:allow: synthetic email for guard verification
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Email address/);
  });

  it('ignores addresses in documentation-reserved domains', () => {
    // RFC 2606 / RFC 6761 reserve example.com/.net/.org and the
    // .test/.example/.invalid/.localhost TLDs for documentation only.
    for (const line of ['contact: demo@example.com', 'contact: a@foo.invalid', 'contact: b@foo.test']) {
      expect(scanLine(line).ok).toBe(true);
    }
  });

  it('catches an owner-specific handle loaded from the local private pattern file', () => {
    // The real handle lives only in tools/guard/private-patterns.local.json
    // (git-ignored, never exported). The test uses a stand-in string.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-private-patterns-'));
    try {
      const guardDir = path.join(tmp, 'tools', 'guard');
      fs.mkdirSync(guardDir, { recursive: true });
      fs.writeFileSync(
        path.join(guardDir, 'private-patterns.local.json'),
        JSON.stringify({ patterns: [{ name: 'Owner handle', regex: 'exampleowner', flags: 'gi' }] }),
        'utf8'
      );

      const privatePatterns = loadPrivatePatterns(tmp);
      expect(privatePatterns.length).toBe(1);

      const result = scanLine('author: exampleowner', privatePatterns);
      expect(result.ok).toBe(false);
      expect(result.violation).toMatch(/Owner handle/);

      // Without the private rules the same line is clean.
      expect(scanLine('author: exampleowner').ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('catches GitHub token ghp_', () => { // no-secrets:allow: test name contains ghp_ pattern
    const result = scanLine('const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";'); // no-secrets:allow: synthetic GitHub token
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/GitHub token/);
  });

  it('catches Google API key AIza', () => { // no-secrets:allow: test name contains AIza pattern
    const result = scanLine('const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";'); // no-secrets:allow: synthetic Google key
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Google API key/);
  });

  it('catches private key block', () => {
    const result = scanLine('-----BEGIN PRIVATE KEY-----'); // no-secrets:allow: synthetic private key marker
    expect(result.ok).toBe(false);
    expect(result.violation).toMatch(/Private key block/);
  });

  it('J3 - catches secrets in untracked files via git ls-files -co --exclude-standard', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-guard-untracked-'));
    try {
      execSync('git init', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmp, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: tmp, stdio: 'ignore' });
      // Create tracked file
      fs.writeFileSync(path.join(tmp, 'tracked.txt'), 'clean file content', 'utf8');
      execSync('git add tracked.txt', { cwd: tmp, stdio: 'ignore' });
      execSync('git commit -m "initial"', { cwd: tmp, stdio: 'ignore' });

      // Create UNTRACKED file with forbidden pattern
      fs.writeFileSync(
        path.join(tmp, 'untracked-secret.txt'),
        'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";', // no-secrets:allow: synthetic key in test
        'utf8'
      );

      const files = getStagedOrTrackedFiles(tmp);
      expect(files).toContain('untracked-secret.txt');

      const violations = runGuard(tmp);
      expect(violations).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('local provider registryNames are forbidden but public codes are not', () => {
  function withFakeRegistry(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-guard-registry-'));
    const localDir = path.join(tmp, '.routersync');
    fs.mkdirSync(localDir, { recursive: true });
    const registry = path.join(localDir, 'providers.local.yaml');
    fs.writeFileSync(
      registry,
      'version: 1\nproviders:\n  fake-private-gateway: https://example.invalid/v1\n  aihm: https://example.invalid/v2\n',
      'utf8'
    );
    const previous = process.env['ROUTERSYNC_PROVIDERS_LOCAL'];
    process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = registry;
    try {
      fn(tmp, registry);
    } finally {
      if (previous === undefined) delete process.env['ROUTERSYNC_PROVIDERS_LOCAL'];
      else process.env['ROUTERSYNC_PROVIDERS_LOCAL'] = previous;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('reads only non-public names from a fake local registry', () => {
    withFakeRegistry((tmp) => {
      const names = loadLocalProviderNames(tmp);
      expect(names).toContain('fake-private-gateway');
      expect(names).not.toContain('aihm');
    });
  });

  it('catches a fake private name and skips a public code', () => {
    withFakeRegistry((tmp) => {
      const patterns = buildProviderPatterns(loadLocalProviderNames(tmp));
      expect(scanLine('route via fake-private-gateway now', patterns).ok).toBe(false);
      expect(scanLine('route via aihm/gpt-oss', patterns).ok).toBe(true);
    });
  });

  it('no-secrets and no-personal-paths both include registry names in their patterns', () => {
    withFakeRegistry(() => {
      const secretPatterns = buildGuardPatterns();
      expect(scanLine('FAKE-PRIVATE-GATEWAY/model', secretPatterns).ok).toBe(false);
      expect(scanLine('aihm/model', secretPatterns).ok).toBe(true);
      const pathPatterns = buildPathPatterns({ hostname: 'localhost', username: 'tester' });
      expect(scanLine('FAKE-PRIVATE-GATEWAY/model', pathPatterns).ok).toBe(false);
      expect(scanLine('aihm/model', pathPatterns).ok).toBe(true);
    });
  });

  it('matches by word boundary, not substring', () => {
    const patterns = buildProviderPatterns(['mb', 'bai']);
    expect(scanLine('combos and baidu are fine', patterns).ok).toBe(true);
    expect(scanLine('mb/config', patterns).ok).toBe(false);
  });
});

describe('C46-F4B: Personal POSIX Path (/home/...) root-boundary & username validation', () => {
  it('allows sandbox mid-path /home/ segments and relative/URL /home/ paths (true negatives)', () => {
    const cleanCases = [
      'const p = "/tmp/rs-c46-f3-e2e-0CXhOp/home/.hermes/config.yaml";',
      'const p = "/tmp/rs-c46-f3-e2e-0CXhOp/home/pilotuser/config.yaml";',
      'const p = "/private/var/folders/xx/yy/T/rs-123/home/custom/file.json";',
      'RUNNER_HOME_DIR/AppData/Local/Temp/rs-123/home/custom/file.json',
      'RUNNER_HOME_DIR/home/custom/file.json',
      'PLACEHOLDER_DIR/home/custom/file.json',
      './home/custom/file.json',
      '../home/custom/file.json',
      '~/home/custom/file.json',
      'https://github.com/home/settings',
    ];
    for (const line of cleanCases) {
      const res = scanLine(line);
      expect(res, `Expected true negative for: ${line}`).toEqual({ ok: true, allowed: false });
    }
  });

  it('allows invalid POSIX usernames starting with dot or hyphen under /home/', () => {
    const invalidUsernameCases = [
      '/home/.hermes/config.yaml',
      '"/home/.hermes/config.yaml"',
      '/home/-flag',
      'cmd /home/-v',
    ];
    for (const line of invalidUsernameCases) {
      const res = scanLine(line);
      expect(res, `Expected true negative for invalid username: ${line}`).toEqual({ ok: true, allowed: false });
    }
  });

  it('allows synthetic exempted POSIX users (alice, bob, user, example, test, mock)', () => {
    for (const u of ['alice', 'bob', 'user', 'example', 'test', 'mock']) {
      expect(scanLine(`/home/${u}`)).toEqual({ ok: true, allowed: false });
      expect(scanLine(`"/home/${u}/.config/app.yaml"`)).toEqual({ ok: true, allowed: false });
    }
  });

  it('catches root-anchored /home/<username> across start-of-line, quotes, whitespace, and all delimiters (true positives)', () => {
    const forbiddenCases = [
      '/home/realperson/.config/app.yaml', // no-secrets:allow: synthetic POSIX home test fixture
      'cd /home/realperson', // no-secrets:allow: synthetic POSIX home test fixture
      '"/home/realperson/.hermes/config.yaml"', // no-secrets:allow: synthetic POSIX home test fixture
      "'/home/realperson/file'", // no-secrets:allow: synthetic POSIX home test fixture
      '`/home/realperson/file`', // no-secrets:allow: synthetic POSIX home test fixture
      'HOME=/home/realperson', // no-secrets:allow: synthetic POSIX home test fixture
      'PATH=/usr/bin:/home/realperson/bin', // no-secrets:allow: synthetic POSIX home test fixture
      '(/home/realperson)', // no-secrets:allow: synthetic POSIX home test fixture
      '[/home/realperson]', // no-secrets:allow: synthetic POSIX home test fixture
      '{/home/realperson}', // no-secrets:allow: synthetic POSIX home test fixture
      'a,/home/realperson', // no-secrets:allow: synthetic POSIX home test fixture
      'a;/home/realperson', // no-secrets:allow: synthetic POSIX home test fixture
      '<dir>/home/realperson</dir>', // no-secrets:allow: synthetic POSIX home test fixture
      '/home/_svc/key', // no-secrets:allow: synthetic POSIX home test fixture
      '/home/x/key', // no-secrets:allow: synthetic POSIX home test fixture
    ];
    for (const line of forbiddenCases) {
      const res = scanLine(line);
      expect(res.ok, `Expected violation for: ${line}`).toBe(false);
      expect(res.violation).toBe('Personal POSIX Path (/home/...)'); // no-secrets:allow: rule name assertion
    }
  });

  it('flags file:///home/realperson/doc.md and matches Personal POSIX Path rule', () => { // no-secrets:allow: test description references file URI shape
    const uri = 'file:///home/realperson/doc.md'; // no-secrets:allow: synthetic file URI test fixture
    const res = scanLine(uri);
    expect(res.ok).toBe(false);
    expect(res.violation).toMatch(/Personal POSIX Path|Absolute file URL/);
    const posixRule = FORBIDDEN_PATTERNS.find((r) => r.name === 'Personal POSIX Path (/home/...)'); // no-secrets:allow: rule name lookup
    expect(posixRule).toBeDefined();
    posixRule.regex.lastIndex = 0;
    expect(posixRule.regex.test(uri)).toBe(true);
  });
});
