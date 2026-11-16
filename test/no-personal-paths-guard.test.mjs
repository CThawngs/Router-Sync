import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanLine,
  buildPatterns,
  runGuard,
  loadPrivatePatterns,
  PRIVATE_PATTERNS_FILE,
} from '../tools/guard/no-personal-paths.mjs';

describe('tools/guard/no-personal-paths.mjs - Personal Path Guard Tests (X3)', () => {
  const patterns = buildPatterns({ username: 'fakeuser99', hostname: 'fakehost88' });

  it('catches synthetic Windows personal path', () => {
    const line = 'const p = "C:\\\\Users\\\\alice123\\\\project\\\\file.txt";'; // no-secrets:allow: synthetic test line
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(false);
    expect(res.violation).toMatch(/Windows User Path/);
  });

  it('catches synthetic POSIX personal path', () => {
    const line = 'const p = "/home/bob456/.config/app";'; // no-secrets:allow: synthetic test line
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(false);
    expect(res.violation).toMatch(/POSIX User Path/);
  });

  it('catches synthetic OneDrive personal path', () => {
    const line = 'const p = "C:\\\\Users\\\\bob456\\\\OneDrive\\\\Documents\\\\Projects\\\\test";'; // no-secrets:allow: synthetic test line
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(false);
  });

  it('catches synthetic personal email', () => {
    const line = 'author email: dev.person@gmail.com'; // no-secrets:allow: synthetic test line
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(false);
    expect(res.violation).toMatch(/Personal Email/);
  });

  it('catches current OS username if configured in patterns', () => {
    const line = 'const path = "foo/fakeuser99/bar";'; // no-secrets:allow: synthetic test line
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(false);
    expect(res.violation).toMatch(/Current OS Username/);
  });

  it('allows <USER_DIR> placeholder', () => {
    const line = 'const cfg = "<USER_DIR>/AppData/Roaming/routersync/config.yaml";';
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(true);
  });

  it('allows <REPO_ROOT> placeholder', () => {
    const line = 'const src = "<REPO_ROOT>/packages/core/src/index.ts";';
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(true);
  });

  it('allows tilde ~ placeholder', () => {
    const line = 'const cfg = "~/.routersync/tick-catalog.json";';
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(true);
  });

  it('allows standard test/doc placeholders like tester and YOUR_USER', () => {
    expect(scanLine('/home/tester/repo', patterns).ok).toBe(true); // no-secrets:allow: synthetic test line
    expect(scanLine('/Users/YOUR_USER/Library', patterns).ok).toBe(true);
    expect(scanLine('c:/Users/someone/project', patterns).ok).toBe(true); // no-secrets:allow: synthetic test line
  });

  it('exempts line with allow marker', () => {
    const line = 'const p = "C:\\\\Users\\\\realuser\\\\path"; // no-secrets:allow: test verification'; // no-secrets:allow: test verification
    const res = scanLine(line, patterns);
    expect(res.ok).toBe(true);
    expect(res.allowed).toBe(true);
  });

  it('loads owner-specific rules from private-patterns.local.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-guard-private-'));
    try {
      const guardDir = path.join(tmpDir, 'tools', 'guard');
      fs.mkdirSync(guardDir, { recursive: true });
      const patternFile = path.join(tmpDir, PRIVATE_PATTERNS_FILE);
      fs.writeFileSync(
        patternFile,
        JSON.stringify([
          {
            name: 'Custom Private Token Pattern',
            regex: 'SECRET_CUSTOM_TOKEN_[A-Z0-9]+',
            flags: 'g',
          },
        ]),
        'utf8'
      );

      const loaded = loadPrivatePatterns(tmpDir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('Custom Private Token Pattern');

      const testLine = 'const key = "SECRET_CUSTOM_TOKEN_XYZ123";';
      const scanRes = scanLine(testLine, loaded);
      expect(scanRes.ok).toBe(false);
      expect(scanRes.violation).toBe('Custom Private Token Pattern');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles missing or malformed private-patterns.local.json gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-guard-missing-'));
    try {
      expect(loadPrivatePatterns(tmpDir)).toEqual([]);

      const guardDir = path.join(tmpDir, 'tools', 'guard');
      fs.mkdirSync(guardDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, PRIVATE_PATTERNS_FILE), '{ malformed json', 'utf8');
      expect(loadPrivatePatterns(tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
