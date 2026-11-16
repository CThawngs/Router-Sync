#!/usr/bin/env node
/**
 * tools/guard/no-personal-paths.mjs
 *
 * PURPOSE:
 * Pre-commit & CI guard to prevent personal machine paths, OS user accounts,
 * OneDrive sync folders, personal emails, or machine hostnames from leaking
 * into tracked files.
 *
 * READ-ONLY GUARANTEE:
 * Inspects file contents only; never modifies files.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Allowed placeholders:
// <USER_DIR>, <REPO_ROOT>, ~, %APPDATA%, YOUR_USER, tester, someone, runner
const ALLOWED_TEST_USERS = '(?:<USER_DIR>|<REPO_ROOT>|YOUR_USER|tester|someone|runner|runneradmin|circleci|appveyor|root)';

export const PRIVATE_PATTERNS_FILE = 'tools/guard/private-patterns.local.json';

/**
 * Load owner-specific patterns from private-patterns.local.json when present.
 * The file is git-ignored and never committed to the public repo.
 */
export function loadPrivatePatterns(root = process.cwd()) {
  const file = path.join(root, PRIVATE_PATTERNS_FILE);
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed?.patterns ?? []);
  const rules = [];
  for (const entry of list) {
    if (!entry || typeof entry.regex !== 'string') continue;
    try {
      rules.push({
        name: typeof entry.name === 'string' ? entry.name : 'Private pattern',
        regex: new RegExp(entry.regex, typeof entry.flags === 'string' ? entry.flags : 'gi'),
      });
    } catch {
      // Ignore a malformed private rule instead of failing the whole scan.
    }
  }
  return rules;
}

export function buildPatterns(options = {}) {
  const patterns = [
    {
      name: 'Windows User Path ([A-Za-z]:\\Users\\...)',
      regex: new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+(?!${ALLOWED_TEST_USERS}\\b)[a-zA-Z0-9._-]+`, 'gi'),
    },
    {
      name: 'POSIX User Path (/Users/... or /home/...)', // no-secrets:allow: guard's own pattern definition
      regex: new RegExp(`(?:^|[ \\t"'])(?:/Users|/home)/(?!${ALLOWED_TEST_USERS}\\b)[a-zA-Z0-9._-]+`, 'gi'),
    },
    {
      name: 'OneDrive Personal Path',
      regex: /[A-Za-z]:[\\/]+[^< \n\r\t"']*OneDrive[\\/]+(?:Documents|Desktop|Projects)/gi,
    },
    {
      name: 'AppData Roaming Personal Path',
      regex: /[A-Za-z]:[\\/]+Users[\\/]+[^< \n\r\t"']+[\\/]AppData[\\/]Roaming/gi,
    },
    {
      name: 'Personal Email Address',
      regex: /[a-zA-Z0-9._%+-]+@(?!example\.(?:com|net|org)\b)(?![a-zA-Z0-9.-]*\.(?:test|example|invalid|localhost)\b)(?:gmail\.com|yahoo\.com|outlook\.com|hotmail\.com)/gi,
    },
  ];

  const username = options.username ?? (os.userInfo() ? os.userInfo().username : '');
  if (
    username &&
    username.length > 2 &&
    !['root', 'runner', 'runneradmin', 'tester', 'circleci', 'appveyor', 'administrator', 'system'].includes(username.toLowerCase())
  ) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push({
      name: `Current OS Username (${username})`,
      regex: new RegExp(`\\b${escaped}\\b`, 'i'),
    });
  }

  const hostname = options.hostname ?? os.hostname();
  if (
    hostname &&
    hostname.length > 3 &&
    !['localhost', 'github-runner', 'runner'].includes(hostname.toLowerCase())
  ) {
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push({
      name: `Current OS Hostname (${hostname})`,
      regex: new RegExp(`\\b${escaped}\\b`, 'i'),
    });
  }

  return patterns;
}

export const ALLOW_MARKER = /(?:no-personal-paths|no-secrets):allow:\s*(\S.*)$/;

export function scanLine(line, patterns = buildPatterns()) {
  if (ALLOW_MARKER.test(line)) {
    return { ok: true, allowed: true };
  }
  for (const rule of patterns) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(line)) {
      return { ok: false, violation: rule.name };
    }
  }
  return { ok: true, allowed: false };
}

export function scanFile(filePath, patterns = buildPatterns()) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const res = scanLine(line, patterns);
      if (!res.ok) {
        violations.push({
          line: i + 1,
          rule: res.violation,
          snippet: line.trim().slice(0, 80),
        });
      }
    }
    return violations;
  } catch {
    return [];
  }
}

export function getTrackedAndStagedFiles(root = process.cwd()) {
  try {
    const output = execSync('git ls-files -co --exclude-standard', { cwd: root, encoding: 'utf8' }).trim();
    if (output) {
      return output.split(/\r?\n/).filter(Boolean);
    }
  } catch {}
  return [];
}

export function runGuard(root = process.cwd(), options = {}) {
  const privateRules = options.loadPrivatePatterns !== false ? loadPrivatePatterns(root) : [];
  const patterns = [...buildPatterns(options), ...privateRules];
  const files = getTrackedAndStagedFiles(root);
  const excluded = new Set([
    'tools/guard/no-personal-paths.mjs',
    'tools/guard/no-secrets.mjs',
    'test/no-personal-paths-guard.test.mjs',
    'test/no-secrets-guard.test.mjs',
    '.agent/send-final/C4x/evidence.txt',
    '.agent/send-final/C4x/CLEAN-REPORT.md',
    '.agent/send-final/C4x/REPORT.md',
  ]);

  let totalViolations = 0;
  for (const f of files) {
    if (excluded.has(f.replace(/\\/g, '/'))) continue;
    const fullPath = path.join(root, f);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
    const vios = scanFile(fullPath, patterns);
    if (vios.length > 0) {
      totalViolations += vios.length;
      for (const v of vios) {
        console.error(`[PERSONAL-PATH-VIOLATION] ${f}:${v.line} [${v.rule}]`);
      }
    }
  }

  if (totalViolations > 0) {
    console.error(`\n[FAIL] Found ${totalViolations} personal path violation(s).`);
    return { ok: false, violations: totalViolations };
  }

  console.log(`[PASS] No personal paths detected across ${files.length} tracked/staged files.`);
  return { ok: true, violations: 0 };
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = runGuard();
  process.exit(result.ok ? 0 : 1);
}
