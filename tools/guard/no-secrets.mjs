#!/usr/bin/env node
/**
 * tools/guard/no-secrets.mjs
 * 
 * PURPOSE:
 * Pre-commit & CI security guard. Scans tracked and staged files for accidental
 * API keys, secret tokens, and personal user home paths.
 * 
 * READ-ONLY GUARANTEE:
 * This script only inspects file contents. It never alters files or transmits data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadLocalProviderNames, buildProviderPatterns } from './local-provider-names.mjs';

/**
 * Public patterns only: generic credential shapes, personal home paths and
 * email addresses. They carry no owner-specific string, so this file is safe
 * to publish.
 *
 * Owner-specific patterns (a real login handle, a machine-specific harness
 * path) live in `tools/guard/private-patterns.local.json`, which is
 * git-ignored and excluded from the public export.
 */
export const FORBIDDEN_PATTERNS = [
  { name: 'OpenAI/Compatible API Key (sk-...)', regex: /sk-[a-zA-Z0-9_\-]{20,}/g },
  { name: 'Bearer Token', regex: /Bearer\s+[a-zA-Z0-9_.\-~+/=]{25,}/gi },
  { name: 'JWT Token (eyJ...)', regex: /eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}/g },
  { name: 'Personal Windows Path ([A-Za-z]:[/\\\\]+Users[/\\\\]+...)', regex: /[a-zA-Z]:[\\/]+Users[\\/]+(?!(?:alice|bob|user|example|test|mock)\b)[a-zA-Z0-9._-]+/gi }, // no-secrets:allow: guard's own pattern definition
  { name: 'Personal POSIX Path (/home/...)', regex: /\/home\/(?!(?:alice|bob|user|example|test|mock)\b)[a-zA-Z0-9._-]+/gi }, // no-secrets:allow: guard's own pattern definition
  { name: 'Absolute file URL (file:///)', regex: /file:\/\/\//gi }, // no-secrets:allow: guard's own pattern definition
  // Email address. Domains reserved for documentation (RFC 2606 / RFC 6761:
  // example.com/.net/.org and the .test/.example/.invalid/.localhost TLDs)
  // are exempt because documentation examples are not leaked addresses.
  { name: 'Email address', regex: /[a-zA-Z0-9._%+-]+@(?!example\.(?:com|net|org)\b)(?![a-zA-Z0-9.-]*\.(?:test|example|invalid|localhost)\b)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g }, // no-secrets:allow: guard's own pattern definition
  { name: 'GitHub token (ghp_)', regex: /ghp_[a-zA-Z0-9]{20,}/g }, // no-secrets:allow: guard's own pattern definition
  { name: 'Google API key (AIza)', regex: /AIza[0-9A-Za-z_-]{35}/g }, // no-secrets:allow: guard's own pattern definition
  { name: 'Private key block', regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g }, // no-secrets:allow: guard's own pattern definition
];

/** Relative path of the local, git-ignored pattern file. */
export const PRIVATE_PATTERNS_FILE = 'tools/guard/private-patterns.local.json';

/**
 * Load owner-specific patterns from the local pattern file when it exists.
 * The file is never committed and never exported, so a real login handle never
 * reaches the public repository.
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

// no-secrets:allow:<reason>  — line-level exemption, reason required
export const ALLOW_MARKER = /no-secrets:allow:\s*(\S.*)$/;
// A bare marker without a reason is a violation (prevents lazy blanket allows)
export const BARE_MARKER = /no-secrets:allow(?!:)/; // no-secrets:allow: guard defines its own marker syntax

export function scanLine(line, extraPatterns = []) {
  // A valid allow marker exempts the whole line (checked first).
  if (ALLOW_MARKER.test(line)) {
    return { ok: true, allowed: true };
  }
  // A bare marker without a reason is a violation (prevents lazy blanket allows)
  if (BARE_MARKER.test(line)) {
    return { ok: false, error: 'bare-marker' };
  }
  for (const rule of [...FORBIDDEN_PATTERNS, ...extraPatterns]) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(line)) {
      return { ok: false, violation: rule.name };
    }
  }
  return { ok: true, allowed: false };
}

export function getStagedOrTrackedFiles(root = process.cwd()) {
  try {
    const output = execSync('git ls-files -co --exclude-standard', { cwd: root, encoding: 'utf8' }).trim();
    if (output) {
      return output.split(/\r?\n/).filter(Boolean);
    }
  } catch {}

  // Non-git directory-walk fallback: scan all files under repo root
  // (excluding node_modules, .git, dist, and common scratch dirs)
  const repoRoot = root;
  const excluded = new Set([
    'node_modules', '.git', 'dist', 'coverage', '.phase0-scratch',
    '.agent', '.cursor', '.dsh-code-index',
  ]);
  const files = [];

  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (excluded.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkDir(full);
      } else if (ent.isFile()) {
        files.push(path.relative(repoRoot, full));
      }
    }
  }

  walkDir(repoRoot);
  return files;
}

/** Mẫu dùng chung cho runGuard và test: thêm tên cổng riêng từ registry cục bộ. */
export function buildGuardPatterns(root = process.cwd()) {
  const localProviderNames = loadLocalProviderNames(root);
  return [
    ...loadPrivatePatterns(root),
    ...buildProviderPatterns(localProviderNames),
  ];
}

export function runGuard(root = process.cwd()) {
  let violations = 0;
  const files = getStagedOrTrackedFiles(root);
  const privatePatterns = buildGuardPatterns(root);

  for (const relPath of files) {
    const normalized = relPath.replace(/\\/g, '/');
    // Only untracked scratch dirs are skipped wholesale; everything else is scanned line by line.
    if (normalized.startsWith('.phase0-scratch/')) {
      continue;
    }
    // The private pattern file holds the patterns themselves; never scan it.
    if (normalized === PRIVATE_PATTERNS_FILE) {
      continue;
    }

    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue; // Skip binary or unreadable files
    }

    const lines = content.split(/\r?\n/);
    let allowedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      const result = scanLine(line, privatePatterns);
      if (result.allowed) {
        allowedLines++;
        continue;
      }
      if (!result.ok) {
        if (result.error === 'bare-marker') {
          console.error(`[SECURITY GUARD VIOLATION] ${relPath}:${lineNo}: 'no-secrets:allow' marker without a reason`); // no-secrets:allow: self-referential violation message
        } else {
          console.error(`[SECURITY GUARD VIOLATION] ${relPath}:${lineNo}: Detected ${result.violation}`);
        }
        violations++;
      }
    }
    if (allowedLines > 0 && process.env['NO_SECRETS_VERBOSE']) {
      console.log(`[SECURITY GUARD] ${relPath}: ${allowedLines} line-level exemption(s)`);
    }
  }

  return violations;
}

const isDirectRun = Boolean(process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/guard/no-secrets.mjs'));

if (isDirectRun) {
  const files = getStagedOrTrackedFiles();
  const violations = runGuard();
  if (violations > 0) {
    console.error(`\nFound ${violations} security violation(s) across ${files.length} scanned files. Commit/Check aborted!`);
    console.error('Fix: redact credentials, replace personal paths with <USER_DIR> or ~/.config,');
    console.error('or annotate a synthetic test string with:  // no-secrets:allow: <reason>');
    process.exit(1);
  } else {
    console.log(`[SECURITY GUARD] Clean. Scanned ${files.length} files (tracked + untracked). No secrets or personal paths detected.`);
    process.exit(0);
  }
}
