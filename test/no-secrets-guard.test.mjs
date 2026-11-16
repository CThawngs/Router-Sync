import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { scanLine, FORBIDDEN_PATTERNS, loadPrivatePatterns, getStagedOrTrackedFiles, runGuard } from '../tools/guard/no-secrets.mjs';

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
