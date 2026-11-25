#!/usr/bin/env node
/**
 * tools/agent/security-audit.mjs
 *
 * Milestone M4-02 (P7): Multi-Surface Security Auditor & Router Write-Gate Checklist.
 *
 * Surfaces audited:
 *   1. `scanRepoFiles(root)`        — tracked & non-ignored working-tree files, `.env` check, K6.2 git strings.
 *   2. `scanEvidenceRefs(root)`     — all `evidence/*` git refs via `git ls-tree` + `git cat-file --batch` (0 checkout).
 *   3. `scanPackedTarballs(root)`   — all 8 publishable workspace tarballs (or `--tarballs-dir`), allowlist + content scan.
 *   4. `scanRecentCiLogs(opts)`     — recent GitHub Actions workflow logs when `--with-ci-logs` is passed.
 *   5. `auditRouterWriteGates()`    — programmatic checklist in `os.tmpdir()` (`grant`, `approval-token`, `--yes-write-router`).
 *
 * STRICT ZERO-LEAK INVARIANT:
 *   Never print or serialize matched secret substrings, API tokens, usernames, hostnames,
 *   private provider names, or personal paths in stdout, stderr, or JSON. Every finding
 *   contains ONLY `{ id, surface, location, rule, severity, count, remediation }`.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FORBIDDEN_PATTERNS,
  PRIVATE_PATTERNS_FILE,
  ALLOW_MARKER as SECRET_ALLOW_MARKER,
  BARE_MARKER as SECRET_BARE_MARKER,
  buildGuardPatterns,
} from '../guard/no-secrets.mjs';
import {
  ALLOW_MARKER as PERSONAL_ALLOW_MARKER,
  NEVER_ALLOW_RULES,
  buildPatterns as buildPersonalPatterns,
  loadPrivatePatterns as loadPersonalPrivatePatterns,
} from '../guard/no-personal-paths.mjs';
import { buildMatchers } from './scan-private-names.mjs';
import { effectivePrivateNames } from './private-names.mjs';
import { auditTarballEntries, packAndAuditWorkspacePackages } from './pack-verify.mjs';
import { ghExecutable, ghSpawnOptions } from './ci-watch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');

export const SEVERITY = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|ico|pdf|zip|gz|tgz|mp4|webm|woff2?|ttf|exe|dll|node|sqlite|sqlite3)$/i;
const DOTENV_BASENAME_RE = /^\.env(?:\..+)?$/i;

// Construct extra credential & K6.2 patterns from split segments so static guards never match literal tokens.
const EXTRA_SECRET_RULES = Object.freeze([
  {
    rule: 'github-token',
    regex: new RegExp(['github', '_pat_', '[A-Za-z0-9_]{20,}'].join(''), 'g'),
    remediation: 'Revoke and remove GitHub fine-grained PAT; store tokens only in OS secret storage.',
  },
  {
    rule: 'gitlab-token',
    regex: new RegExp(['glpat', '-', '[A-Za-z0-9_-]{20,}'].join(''), 'g'),
    remediation: 'Revoke and remove GitLab personal access token.',
  },
  {
    rule: 'slack-token',
    regex: new RegExp(['xox', '[baprs]-', '[A-Za-z0-9-]{10,}'].join(''), 'g'),
    remediation: 'Revoke and remove Slack API token.',
  },
]);

const K62_FORBIDDEN_GIT_STRINGS = Object.freeze([
  ['push', 'origin', 'master'].join(' '),
  ['--', 'tags'].join(''),
  ['git push', '--all'].join(' '),
]);

const PERSONAL_GUARD_SELF_FILES = new Set([
  'tools/guard/no-personal-paths.mjs',
  'tools/guard/no-secrets.mjs',
  'tools/agent/security-audit.mjs',
  'test/no-personal-paths-guard.test.mjs',
  'test/no-secrets-guard.test.mjs',
  'test/agent/security-audit.node.test.mjs',
]);

const LIVE_ROUTER_PORTS = new Set([20128, 30128, 3128]);
const CLOUD_DRIVE_RULE_RE = new RegExp(['One', 'Drive Personal Path'].join(''), 'i');
const CLOUD_DRIVE_RULE_SLUG = ['one', 'drive-personal-path'].join('');

/**
 * Normalize internal guard rule names to fixed slugs so OS usernames, hostnames,
 * and private provider names embedded in `rule.name` NEVER leak into findings.
 */
function canonicalizeRuleSlug(rawRuleName) {
  const s = String(rawRuleName ?? '');
  if (/OpenAI\/Compatible API Key/i.test(s)) return 'openai-api-key';
  if (/Bearer Token/i.test(s)) return 'bearer-token';
  if (/JWT Token/i.test(s)) return 'jwt-token';
  if (/GitHub token/i.test(s)) return 'github-token';
  if (/Google API key/i.test(s)) return 'google-api-key';
  if (/Private key block/i.test(s)) return 'pem-private-key';
  if (/Windows.*Path/i.test(s)) return 'personal-windows-path';
  if (/POSIX.*Path/i.test(s)) return 'personal-posix-path';
  if (CLOUD_DRIVE_RULE_RE.test(s)) return CLOUD_DRIVE_RULE_SLUG;
  if (/AppData Roaming Personal Path/i.test(s)) return 'appdata-personal-path';
  if (/Absolute file URL/i.test(s)) return 'file-url';
  if (/Email/i.test(s)) return 'email-address';
  if (/Current OS Username/i.test(s)) return 'os-username';
  if (/Current OS Hostname/i.test(s)) return 'os-hostname';
  if (/Private provider/i.test(s) || s === '<private>') return 'private-provider-name';
  return 'private-pattern';
}

function remediationForRule(ruleSlug) {
  switch (ruleSlug) {
    case 'dotenv-file':
      return 'Remove .env file from git/tarball; commit only .env.example with safe placeholder URLs.';
    case 'k6-2-git-publish':
      return 'Replace broad git push flags with an explicit ref push such as git push origin v0.1.0.';
    case 'bare-allow-marker':
      return 'Provide an explicit justification after allow marker or remove the secret/path.';
    case 'tarball-forbidden-entry':
    case 'tarball-allowlist-violation':
      return 'Restrict package.json files array to dist/, README.md, and LICENSE; rebuild and re-verify.';
    case 'write-gate-bypass':
      return 'Restore fail-closed validation on human-gated router write path before merging or releasing.';
    case 'ci-log-fetch-failed':
      return 'Ensure network connectivity and gh authentication before running --with-ci-logs; never treat unreachable CI logs as clean.';
    case 'ci-log-empty-runs':
      return 'Verify GitHub Actions has completed workflow runs for the target branch before running --with-ci-logs.';
    case 'personal-windows-path':
    case 'personal-posix-path':
    case CLOUD_DRIVE_RULE_SLUG:
    case 'appdata-personal-path':
    case 'file-url':
    case 'os-username':
    case 'os-hostname':
    case 'private-provider-name':
      return 'Replace host-specific paths and identifiers with <REPO_ROOT>, <USER_DIR>, %APPDATA%, or ~.';
    default:
      return 'Revoke any real credential and remove token/secret material from repository artifacts.';
  }
}

function createFindingCounter() {
  let seq = 0;
  return function makeFinding({ surface, location, rule, severity = SEVERITY.HIGH, count = 1, remediation }) {
    seq += 1;
    // Enforce exact 7-key zero-leak schema.
    return {
      id: `SEC-${String(seq).padStart(4, '0')}`,
      surface: String(surface),
      location: String(location),
      rule: String(rule),
      severity: String(severity),
      count: Number(count),
      remediation: String(remediation ?? remediationForRule(rule)),
    };
  };
}

/**
 * Strip safe CI runner directories (`runner`, `runneradmin`, `dependabot`, `linuxbrew`)
 * and masked `<HOME>` / `<USER_DIR>` placeholders before testing generic path/file-URL
 * regexes so GitHub Actions runner paths and already-masked evidence transcripts never
 * trigger false positives.
 */
function maskSafeRunnerAndPlaceholders(line, surface = '') {
  let out = line
    .replace(/file:\/\/\/<(?:HOME|USER|USER_DIR|REPO_ROOT)>/gi, 'https://placeholder.invalid')
    .replace(
      /[A-Za-z]:[\\/]+Users[\\/]+(?:runneradmin|runner|dependabot|circleci|appveyor|tester|someone|public|default)\b/gi,
      '<RUNNER_HOME>'
    )
    .replace(
      /(?:\/Users|\/home)\/(?:runner|runneradmin|dependabot|linuxbrew|circleci|appveyor|tester|someone|admin)\b/gi,
      '<RUNNER_HOME>'
    );

  if (surface === 'ci-logs') {
    out = out.replace(
      /[A-Za-z0-9._%+-]+@(?:users\.noreply\.github\.com|github\.com)\b/gi,
      'bot@example.com'
    );
  }
  return out;
}

function buildScannerContext(patternRoot = DEFAULT_REPO_ROOT) {
  const effectiveRoot = fs.existsSync(path.join(patternRoot, 'tools', 'guard'))
    ? patternRoot
    : DEFAULT_REPO_ROOT;

  const secretExtra = buildGuardPatterns(effectiveRoot);
  const personalRules = [
    ...buildPersonalPatterns({ root: effectiveRoot }),
    ...loadPersonalPrivatePatterns(effectiveRoot),
  ];
  const privateNameMatchers = buildMatchers(effectivePrivateNames(), false);

  return {
    secretExtra,
    personalRules,
    privateNameMatchers,
  };
}

/**
 * Scan UTF-8 text line-by-line and return sanitized rule hits (`{ lineNo, rule }`)
 * without ever retaining matched text.
 */
function scanTextContent(text, ctx, { surface, relPath = '' } = {}) {
  const hits = [];
  const normalizedRel = relPath.replace(/\\/g, '/');
  const skipPersonalSelf =
    (surface === 'repo-files' || surface === 'evidence-refs') &&
    PERSONAL_GUARD_SELF_FILES.has(normalizedRel);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine) continue;
    const lineNo = i + 1;

    const hasSecretAllow = SECRET_ALLOW_MARKER.test(rawLine);
    const hasPersonalAllow = PERSONAL_ALLOW_MARKER.test(rawLine);

    if (surface === 'repo-files' && !hasSecretAllow && SECRET_BARE_MARKER.test(rawLine)) {
      hits.push({ lineNo, rule: 'bare-allow-marker' });
      continue;
    }

    const maskedForPaths = maskSafeRunnerAndPlaceholders(rawLine, surface);
    const lineFlaggedRules = new Set();

    // 1. Secret & credential rules (`no-secrets.mjs` + extra PAT/GitLab/Slack shapes)
    if (!hasSecretAllow) {
      for (const p of [...FORBIDDEN_PATTERNS, ...ctx.secretExtra]) {
        const slug = canonicalizeRuleSlug(p.name);
        const targetStr =
          slug === 'personal-windows-path' ||
          slug === 'personal-posix-path' ||
          slug === 'file-url' ||
          (surface === 'ci-logs' && slug === 'email-address')
            ? maskedForPaths
            : rawLine;
        p.regex.lastIndex = 0;
        if (p.regex.test(targetStr)) {
          lineFlaggedRules.add(slug);
        }
      }
      for (const extra of EXTRA_SECRET_RULES) {
        extra.regex.lastIndex = 0;
        if (extra.regex.test(rawLine)) {
          lineFlaggedRules.add(extra.rule);
        }
      }
    }

    // 2. Personal path & host identity rules (`no-personal-paths.mjs` + `scan-private-names.mjs`)
    if (!skipPersonalSelf) {
      for (const p of ctx.personalRules) {
        const isHard = NEVER_ALLOW_RULES.test(p.name);
        if (!isHard && hasPersonalAllow) continue;
        const slug = canonicalizeRuleSlug(p.name);
        const targetStr =
          slug === 'personal-windows-path' ||
          slug === 'personal-posix-path' ||
          slug === CLOUD_DRIVE_RULE_SLUG ||
          slug === 'appdata-personal-path'
            ? maskedForPaths
            : rawLine;
        p.regex.lastIndex = 0;
        if (p.regex.test(targetStr)) {
          lineFlaggedRules.add(slug);
        }
      }

      for (const m of ctx.privateNameMatchers) {
        m.regex.lastIndex = 0;
        if (m.regex.test(rawLine)) {
          lineFlaggedRules.add('private-provider-name');
        }
      }
    }

    for (const rule of lineFlaggedRules) {
      hits.push({ lineNo, rule });
    }
  }

  return hits;
}

function listRepoFiles(root) {
  const listed = new Set();
  const gitRes = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (gitRes.status === 0 && gitRes.stdout) {
    for (const f of gitRes.stdout.split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) listed.add(trimmed.replace(/\\/g, '/'));
    }
  } else {
    // Fallback walk if not a git repo
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.agent', '.phase0-scratch']);
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) listed.add(path.relative(root, full).replace(/\\/g, '/'));
      }
    };
    walk(root);
  }
  return [...listed].sort();
}

/**
 * Surface 1: Scan tracked and non-ignored repository files on disk.
 */
export function scanRepoFiles(root = DEFAULT_REPO_ROOT, makeFinding = createFindingCounter()) {
  const ctx = buildScannerContext(root);
  const files = listRepoFiles(root);
  const findings = [];
  let filesScanned = 0;

  for (const relPath of files) {
    if (relPath.startsWith('.phase0-scratch/') || relPath === PRIVATE_PATTERNS_FILE) {
      continue;
    }

    const base = path.posix.basename(relPath);
    if (DOTENV_BASENAME_RE.test(base) && base.toLowerCase() !== '.env.example') {
      findings.push(
        makeFinding({
          surface: 'repo-files',
          location: relPath,
          rule: 'dotenv-file',
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
    }

    if (BINARY_EXT_RE.test(relPath)) continue;
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) continue;
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let buf;
    try {
      buf = fs.readFileSync(fullPath);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    filesScanned += 1;

    const text = buf.toString('utf8');

    // K6.2 check on publishable/tracked non-test files
    if (
      !relPath.startsWith('.agent/') &&
      !relPath.startsWith('test/') &&
      relPath !== 'tools/agent/security-audit.mjs'
    ) {
      for (const forbiddenGit of K62_FORBIDDEN_GIT_STRINGS) {
        if (text.includes(forbiddenGit)) {
          findings.push(
            makeFinding({
              surface: 'repo-files',
              location: relPath,
              rule: 'k6-2-git-publish',
              severity: SEVERITY.HIGH,
              count: 1,
            })
          );
        }
      }
    }

    const hits = scanTextContent(text, ctx, { surface: 'repo-files', relPath });
    for (const hit of hits) {
      findings.push(
        makeFinding({
          surface: 'repo-files',
          location: `${relPath}:${hit.lineNo}`,
          rule: hit.rule,
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
    }
  }

  const highCount = findings.filter((f) => f.severity === SEVERITY.HIGH).length;
  return {
    ok: highCount === 0,
    surface: 'repo-files',
    filesScanned,
    findings,
  };
}

function normalizeEvidenceRefName(ref) {
  return String(ref ?? '')
    .replace(/^refs\/(?:remotes\/)?/, '')
    .replace(/^heads\//, '');
}

function discoverEvidenceRefs(root) {
  const res = spawnSync(
    'git',
    [
      'for-each-ref',
      '--format=%(refname:short) %(objectname)',
      'refs/remotes/origin/evidence',
      'refs/heads/evidence',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  if (res.status !== 0 || !res.stdout) return [];

  const entries = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [refName, sha] = trimmed.split(/\s+/);
    if (!refName || !sha) continue;
    entries.push({ refName: normalizeEvidenceRefName(refName), sha });
  }

  // Prefer remote tracking origin/evidence/* over local evidence/* when both point to the same commit.
  entries.sort((a, b) => {
    const aRemote = a.refName.startsWith('origin/') ? 0 : 1;
    const bRemote = b.refName.startsWith('origin/') ? 0 : 1;
    if (aRemote !== bRemote) return aRemote - bRemote;
    return a.refName < b.refName ? -1 : a.refName > b.refName ? 1 : 0;
  });

  const seenCommitByLogicalName = new Map();
  const selectedRefs = [];
  for (const { refName, sha } of entries) {
    const logical = refName.replace(/^origin\//, '');
    if (seenCommitByLogicalName.get(logical) === sha) continue;
    seenCommitByLogicalName.set(logical, sha);
    selectedRefs.push(refName);
  }
  return selectedRefs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Surface 2: Scan all `evidence/*` git refs via `git ls-tree` + `git cat-file --batch`
 * with zero working-tree checkout and deduplicated blob inspection.
 */
export function scanEvidenceRefs(
  root = DEFAULT_REPO_ROOT,
  refs = undefined,
  makeFinding = createFindingCounter()
) {
  const ctx = buildScannerContext(root);
  const targetRefs = Array.isArray(refs) ? refs : discoverEvidenceRefs(root);
  const findings = [];

  if (targetRefs.length === 0) {
    return {
      ok: true,
      surface: 'evidence-refs',
      refsScanned: 0,
      blobsScanned: 0,
      refNames: [],
      findings,
    };
  }

  // Map blobSha -> Array<{ ref, filePath }>
  const blobOccurrences = new Map();
  const refNames = [];
  let refsScanned = 0;

  for (const ref of targetRefs) {
    const treeRes = spawnSync('git', ['ls-tree', '-r', ref], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (treeRes.status !== 0) continue;
    refsScanned += 1;
    refNames.push(normalizeEvidenceRefName(ref));

    for (const line of treeRes.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = line.slice(0, tabIdx).trim().split(/\s+/);
      const filePath = line.slice(tabIdx + 1).trim();
      const objType = meta[1];
      const blobSha = meta[2];
      if (objType !== 'blob' || !blobSha || !filePath) continue;

      const base = path.posix.basename(filePath);
      if (DOTENV_BASENAME_RE.test(base) && base.toLowerCase() !== '.env.example') {
        findings.push(
          makeFinding({
            surface: 'evidence-refs',
            location: `${ref}:${filePath}`,
            rule: 'dotenv-file',
            severity: SEVERITY.HIGH,
            count: 1,
          })
        );
      }

      if (BINARY_EXT_RE.test(filePath)) continue;
      let list = blobOccurrences.get(blobSha);
      if (!list) {
        list = [];
        blobOccurrences.set(blobSha, list);
      }
      list.push({ ref, filePath });
    }
  }

  const uniqueBlobShas = [...blobOccurrences.keys()];
  let blobsScanned = 0;

  if (uniqueBlobShas.length > 0) {
    const batchRes = spawnSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: `${uniqueBlobShas.join('\n')}\n`,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });

    if (batchRes.status === 0 && Buffer.isBuffer(batchRes.stdout)) {
      const outBuf = batchRes.stdout;
      let offset = 0;
      while (offset < outBuf.length) {
        const nlIdx = outBuf.indexOf(0x0a, offset);
        if (nlIdx === -1) break;
        const header = outBuf.subarray(offset, nlIdx).toString('utf8').trim();
        offset = nlIdx + 1;
        const parts = header.split(' ');
        const sha = parts[0];
        const objType = parts[1];
        const size = Number(parts[2] ?? 0);
        if (objType !== 'blob' || !Number.isFinite(size)) continue;
        const body = outBuf.subarray(offset, offset + size);
        offset += size + 1; // skip trailing LF

        if (body.includes(0)) continue;
        blobsScanned += 1;
        const text = body.toString('utf8');
        const owners = blobOccurrences.get(sha) ?? [];
        const representativeRelPath = owners[0]?.filePath ?? '';
        const hits = scanTextContent(text, ctx, {
          surface: 'evidence-refs',
          relPath: representativeRelPath,
        });
        if (hits.length > 0) {
          for (const owner of owners) {
            // Re-evaluate if a blob appears at multiple paths with different self-guard status
            const ownerHits =
              owner.filePath === representativeRelPath
                ? hits
                : scanTextContent(text, ctx, {
                    surface: 'evidence-refs',
                    relPath: owner.filePath,
                  });
            for (const hit of ownerHits) {
              findings.push(
                makeFinding({
                  surface: 'evidence-refs',
                  location: `${owner.ref}:${owner.filePath}:${hit.lineNo}`,
                  rule: hit.rule,
                  severity: SEVERITY.HIGH,
                  count: 1,
                })
              );
            }
          }
        }
      }
    }
  }

  const highCount = findings.filter((f) => f.severity === SEVERITY.HIGH).length;
  return {
    ok: highCount === 0,
    surface: 'evidence-refs',
    refsScanned,
    blobsScanned,
    refNames,
    findings,
  };
}

function walkDirectoryFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkDirectoryFiles(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function scanTarballFile(tgzPath, ctx, stageParentDir, makeFinding) {
  const findings = [];
  const tarLabel = path.basename(tgzPath);

  const listRes = spawnSync('tar', ['-tzf', tgzPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (listRes.status !== 0) {
    findings.push(
      makeFinding({
        surface: 'tarballs',
        location: tarLabel,
        rule: 'tarball-allowlist-violation',
        severity: SEVERITY.HIGH,
        count: 1,
        remediation: 'Ensure tarball is a valid gzip tar archive readable by tar -tzf.',
      })
    );
    return findings;
  }

  const entries = listRes.stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/\\/g, '/').trim())
    .filter((l) => l.length > 0 && !l.endsWith('/'));

  for (const entry of entries) {
    const base = path.posix.basename(entry);
    if (DOTENV_BASENAME_RE.test(base)) {
      findings.push(
        makeFinding({
          surface: 'tarballs',
          location: `${tarLabel}:${entry}`,
          rule: 'dotenv-file',
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
    }
  }

  const entryAudit = auditTarballEntries(tarLabel, entries);
  if (!entryAudit.ok) {
    findings.push(
      makeFinding({
        surface: 'tarballs',
        location: tarLabel,
        rule: 'tarball-allowlist-violation',
        severity: SEVERITY.HIGH,
        count: entryAudit.violations.length,
      })
    );
  }

  const unpackDir = fs.mkdtempSync(path.join(stageParentDir, 'untar-'));
  const untarRes = spawnSync('tar', ['-xzf', tgzPath, '-C', unpackDir], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (untarRes.status === 0) {
    for (const fullFile of walkDirectoryFiles(unpackDir)) {
      const relInTar = path.relative(unpackDir, fullFile).replace(/\\/g, '/');
      if (BINARY_EXT_RE.test(relInTar)) continue;
      const buf = fs.readFileSync(fullFile);
      if (buf.includes(0)) continue;
      const hits = scanTextContent(buf.toString('utf8'), ctx, {
        surface: 'tarballs',
        relPath: relInTar,
      });
      for (const hit of hits) {
        findings.push(
          makeFinding({
            surface: 'tarballs',
            location: `${tarLabel}:${relInTar}:${hit.lineNo}`,
            rule: hit.rule,
            severity: SEVERITY.HIGH,
            count: 1,
          })
        );
      }
    }
  }

  return findings;
}

/**
 * Surface 3: Audit packed publishable tarballs (either pre-existing `--tarballs-dir`
 * or freshly packed workspace packages in `os.tmpdir()`).
 */
export function scanPackedTarballs(
  root = DEFAULT_REPO_ROOT,
  opts = {},
  makeFinding = createFindingCounter()
) {
  const ctx = buildScannerContext(root);
  const findings = [];
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sec-audit-pack-'));

  try {
    if (opts.tarballsDir) {
      const tgzFiles = fs
        .readdirSync(opts.tarballsDir)
        .filter((f) => f.endsWith('.tgz'))
        .sort()
        .map((f) => path.join(opts.tarballsDir, f));

      for (const tgz of tgzFiles) {
        findings.push(...scanTarballFile(tgz, ctx, tmpWork, makeFinding));
      }

      return {
        ok: findings.filter((f) => f.severity === SEVERITY.HIGH).length === 0,
        surface: 'tarballs',
        status: 'scanned_tarballs_dir',
        packagesScanned: tgzFiles.length,
        findings,
      };
    }

    const packagesDir = path.join(root, 'packages');
    if (!fs.existsSync(packagesDir)) {
      return {
        ok: true,
        surface: 'tarballs',
        status: 'skipped_no_workspace_packages',
        packagesScanned: 0,
        findings,
      };
    }

    const packed = packAndAuditWorkspacePackages({ repoRoot: root, workDir: tmpWork });
    const rawPacksDir = path.join(tmpWork, 'packs-raw');
    const tgzFiles = fs
      .readdirSync(rawPacksDir)
      .filter((f) => f.endsWith('.tgz'))
      .sort()
      .map((f) => path.join(rawPacksDir, f));

    for (const tgz of tgzFiles) {
      findings.push(...scanTarballFile(tgz, ctx, tmpWork, makeFinding));
    }

    return {
      ok: findings.filter((f) => f.severity === SEVERITY.HIGH).length === 0,
      surface: 'tarballs',
      status: 'packed_workspace_packages',
      packagesScanned: packed.packages.length,
      findings,
    };
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
}

function sanitizeRunId(rawId) {
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return rawId;
  const s = String(rawId ?? '');
  return /^[0-9]{1,20}$/.test(s) ? s : 'unknown';
}

function jobNeverExecutedSteps(job) {
  const steps = job?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return true;
  return steps.every((s) => s?.conclusion === 'skipped' || s?.conclusion === 'never_executed');
}

function fetchSingleRunLogs(ghBin, runId, cwd, execFn) {
  try {
    return String(
      execFn(
        ghBin,
        ['run', 'view', String(runId), '--log'],
        { ...ghSpawnOptions(64 * 1024 * 1024), cwd }
      ) ?? ''
    );
  } catch (wholeRunErr) {
    // When a matrix run contains a skipped or capacity-cancelled job with 0 steps,
    // `gh run view <id> --log` exits 1 ("log not found: <jobId>"). Fall back to
    // per-job `--job <jobId> --log` for every job that actually executed steps;
    // fail closed if job metadata or any executed job's log cannot be fetched.
    const jobsRaw = execFn(
      ghBin,
      ['run', 'view', String(runId), '--json', 'jobs'],
      { ...ghSpawnOptions(16 * 1024 * 1024), cwd }
    );
    const parsedJobs = JSON.parse(jobsRaw)?.jobs;
    if (!Array.isArray(parsedJobs) || parsedJobs.length === 0) {
      throw wholeRunErr;
    }
    const executedJobs = parsedJobs.filter(
      (j) =>
        j?.conclusion !== 'skipped' &&
        !(j?.conclusion === 'cancelled' && jobNeverExecutedSteps(j))
    );
    if (executedJobs.length === 0) {
      throw wholeRunErr;
    }
    const chunks = [];
    for (const job of executedJobs) {
      if (!job?.databaseId) {
        throw wholeRunErr;
      }
      const jobLog = execFn(
        ghBin,
        ['run', 'view', String(runId), '--job', String(job.databaseId), '--log'],
        { ...ghSpawnOptions(64 * 1024 * 1024), cwd }
      );
      chunks.push(String(jobLog ?? ''));
    }
    return chunks.join('\n');
  }
}

export function defaultCiLogFetcher(optsOrLimit = 10, legacyCwd = DEFAULT_REPO_ROOT) {
  const opts =
    typeof optsOrLimit === 'object' && optsOrLimit !== null
      ? optsOrLimit
      : { limit: optsOrLimit, branch: 'main', cwd: legacyCwd };
  const {
    limit = 10,
    branch = 'main',
    cwd = DEFAULT_REPO_ROOT,
    execFn = execFileSync,
  } = opts;

  const ghBin = ghExecutable();
  const listArgs = [
    'run',
    'list',
    ...(branch && branch !== 'all' ? ['--branch', String(branch)] : []),
    '--status',
    'completed',
    '--limit',
    String(limit),
    '--json',
    'databaseId,headSha,workflowName,status,headBranch',
  ];
  const listRaw = execFn(ghBin, listArgs, { ...ghSpawnOptions(32 * 1024 * 1024), cwd });
  const runs = JSON.parse(listRaw);
  if (!Array.isArray(runs)) {
    throw new Error('CI_LOG_INVALID_RUN_LIST');
  }

  const fetched = [];
  for (const r of runs) {
    const runId = r?.databaseId;
    if (!runId || r.status !== 'completed') {
      fetched.push({
        id: sanitizeRunId(runId),
        headSha: String(r?.headSha ?? '').slice(0, 7),
        workflowName: String(r?.workflowName ?? 'CI'),
        headBranch: String(r?.headBranch ?? branch ?? ''),
        logError: true,
      });
      continue;
    }
    try {
      const logText = fetchSingleRunLogs(ghBin, runId, cwd, execFn);
      fetched.push({
        id: sanitizeRunId(runId),
        headSha: String(r.headSha ?? '').slice(0, 7),
        workflowName: String(r.workflowName ?? 'CI'),
        headBranch: String(r.headBranch ?? branch ?? ''),
        log: logText,
      });
    } catch {
      fetched.push({
        id: sanitizeRunId(runId),
        headSha: String(r.headSha ?? '').slice(0, 7),
        workflowName: String(r.workflowName ?? 'CI'),
        headBranch: String(r.headBranch ?? branch ?? ''),
        logError: true,
      });
    }
  }
  return fetched;
}

/**
 * Surface 4: Scan recent public GitHub Actions workflow logs when `--with-ci-logs` is enabled.
 * Fails closed on fetch errors, partial per-run log failures, and empty run responses.
 */
export function scanRecentCiLogs(opts = {}, makeFinding = createFindingCounter()) {
  const {
    enabled = false,
    limit = 10,
    branch = 'main',
    root = DEFAULT_REPO_ROOT,
    logFetcher,
    allowEmptyRuns = false,
    execFn,
  } = opts;
  const normalizedBranch = branch === '' ? 'all' : String(branch ?? 'main');

  if (!enabled) {
    return {
      ok: true,
      surface: 'ci-logs',
      status: 'skipped_offline_flag',
      branch: normalizedBranch,
      runsScanned: 0,
      runIds: [],
      findings: [],
    };
  }

  const ctx = buildScannerContext(root);
  const findings = [];
  let runs;
  try {
    runs =
      typeof logFetcher === 'function'
        ? logFetcher(limit, { limit, branch, cwd: root })
        : defaultCiLogFetcher({ limit, branch, cwd: root, execFn });
  } catch (err) {
    const errRunId =
      err && typeof err === 'object' && /^[0-9]{1,20}$/.test(String(err.runId ?? ''))
        ? String(err.runId)
        : null;
    findings.push(
      makeFinding({
        surface: 'ci-logs',
        location: errRunId ? `gh-run:${errRunId}` : 'gh-run:list',
        rule: 'ci-log-fetch-failed',
        severity: SEVERITY.HIGH,
        count: 1,
      })
    );
    return {
      ok: false,
      surface: 'ci-logs',
      status: 'fetch_failed',
      branch: normalizedBranch,
      runsScanned: 0,
      runIds: [],
      findings,
    };
  }

  if (!Array.isArray(runs)) {
    findings.push(
      makeFinding({
        surface: 'ci-logs',
        location: 'gh-run:list',
        rule: 'ci-log-fetch-failed',
        severity: SEVERITY.HIGH,
        count: 1,
      })
    );
    return {
      ok: false,
      surface: 'ci-logs',
      status: 'fetch_failed',
      branch: normalizedBranch,
      runsScanned: 0,
      runIds: [],
      findings,
    };
  }

  if (runs.length === 0) {
    if (!allowEmptyRuns) {
      findings.push(
        makeFinding({
          surface: 'ci-logs',
          location: 'gh-run:list',
          rule: 'ci-log-empty-runs',
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
    }
    return {
      ok: Boolean(allowEmptyRuns),
      surface: 'ci-logs',
      status: allowEmptyRuns ? 'scanned' : 'empty_runs',
      branch: normalizedBranch,
      runsScanned: 0,
      runIds: [],
      findings,
    };
  }

  const runIds = [];
  let hadFetchFailure = false;

  for (const run of runs) {
    const safeId = sanitizeRunId(run?.id);
    if (!run || run.logError || Boolean(run.error) || typeof run.log !== 'string') {
      hadFetchFailure = true;
      findings.push(
        makeFinding({
          surface: 'ci-logs',
          location: `gh-run:${safeId}`,
          rule: 'ci-log-fetch-failed',
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
      continue;
    }

    runIds.push(safeId);
    const hits = scanTextContent(run.log, ctx, { surface: 'ci-logs' });
    for (const hit of hits) {
      findings.push(
        makeFinding({
          surface: 'ci-logs',
          location: `gh-run:${safeId}:line:${hit.lineNo}`,
          rule: hit.rule,
          severity: SEVERITY.HIGH,
          count: 1,
        })
      );
    }
  }

  const hasHighFinding = findings.some((f) => f.severity === SEVERITY.HIGH);
  return {
    ok: !hadFetchFailure && !hasHighFinding,
    surface: 'ci-logs',
    status: hadFetchFailure ? 'fetch_failed' : 'scanned',
    branch: normalizedBranch,
    runsScanned: runIds.length,
    runIds,
    findings,
  };
}

class InterceptedExit extends Error {
  constructor(code) {
    super(`EXIT_${code}`);
    this.code = Number(code ?? 0);
  }
}

async function captureMaintainCall(fn) {
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.error = (...args) => logs.push(args.map(String).join(' '));
  process.exit = (code) => {
    throw new InterceptedExit(code);
  };
  try {
    await fn();
    return { exitCode: 0, output: logs.join('\n') };
  } catch (err) {
    if (err instanceof InterceptedExit) {
      return { exitCode: err.code, output: logs.join('\n') };
    }
    throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
}

/**
 * Surface 5: Programmatic checklist verifying all 3 human-gated router write mechanisms
 * (`grant`, `approval-token`, `--yes-write-router`) in `os.tmpdir()` with 0 live router ports.
 */
export async function auditRouterWriteGates(opts = {}, makeFinding = createFindingCounter()) {
  const simulateBypassGate = opts._simulateBypassGate ?? null;
  const findings = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sec-gates-'));
  const prevStateDir = process.env.ROUTERSYNC_STATE_DIR;
  const prevConfig = process.env.ROUTERSYNC_CONFIG;
  const prevGrantSecret = process.env.ROUTERSYNC_GRANT_SECRET;

  try {
    const stateDir = path.join(tmpDir, 'state');
    const configPath = path.join(tmpDir, 'routersync.yaml');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    baseUrl: http://127.0.0.1:9',
        'policy:',
        '  mode: manual',
        'combos: []',
        'adopt: []',
        '',
      ].join('\n'),
      'utf8'
    );

    process.env.ROUTERSYNC_STATE_DIR = stateDir;
    process.env.ROUTERSYNC_CONFIG = configPath;
    delete process.env.ROUTERSYNC_GRANT_SECRET;

    // -----------------------------------------------------------------------
    // Gate 1: `maintain` GrantFile + scrypt/HMAC + CLI refusal checks
    // -----------------------------------------------------------------------
    const maintainCmdUrl = pathToFileURL(
      path.join(DEFAULT_REPO_ROOT, 'packages', 'cli', 'dist', 'commands', 'maintain.js')
    ).href;
    const grantModUrl = pathToFileURL(
      path.join(DEFAULT_REPO_ROOT, 'packages', 'cli', 'dist', 'maintain', 'grant.js')
    ).href;
    const { runMaintainApplyCommand } = await import(maintainCmdUrl);
    const { createGrantFile, validateGrantFile, generateGrantSecret } = await import(grantModUrl);

    const yesRefusal = await captureMaintainCall(() =>
      runMaintainApplyCommand({ only: 'test-1', yes: true })
    );
    const onlyRefusal = await captureMaintainCall(() =>
      runMaintainApplyCommand({ only: 'prod-combo' })
    );

    const secret = generateGrantSecret();
    const nowMs = Date.now();
    const validApplyGrant = {
      version: 1,
      id: 'a1b2c3d4e5f60001',
      combos: ['test-1'],
      agents: ['hermes'],
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    };
    const grantPath = path.join(tmpDir, 'grant-valid.json');
    fs.writeFileSync(
      grantPath,
      JSON.stringify(createGrantFile(validApplyGrant, secret), null, 2),
      'utf8'
    );
    const wrongSecretCheck = validateGrantFile(grantPath, 'wrong-secret-candidate');

    const expiredGrantPath = path.join(tmpDir, 'grant-expired.json');
    fs.writeFileSync(
      expiredGrantPath,
      JSON.stringify(
        createGrantFile(
          {
            version: 1,
            id: 'a1b2c3d4e5f60002',
            combos: ['test-1'],
            agents: ['hermes'],
            createdAt: new Date(nowMs - 7200_000).toISOString(),
            expiresAt: new Date(nowMs - 3600_000).toISOString(),
          },
          secret
        ),
        null,
        2
      ),
      'utf8'
    );
    const expiredCheck = validateGrantFile(expiredGrantPath, secret);

    const tamperedGrantPath = path.join(tmpDir, 'grant-tampered.json');
    const tamperedParsed = JSON.parse(fs.readFileSync(grantPath, 'utf8'));
    tamperedParsed.combos = ['test-2'];
    fs.writeFileSync(tamperedGrantPath, JSON.stringify(tamperedParsed, null, 2), 'utf8');
    const tamperedMacCheck = validateGrantFile(tamperedGrantPath, secret);

    const grantChecks = [
      yesRefusal.exitCode === 1 && yesRefusal.output.includes('reason=yes-flag'),
      onlyRefusal.exitCode === 1 && onlyRefusal.output.includes('reason=only-pattern'),
      wrongSecretCheck.valid === false && wrongSecretCheck.reason === 'grant-secret-wrong',
      expiredCheck.valid === false && expiredCheck.reason === 'grant-expired',
      tamperedMacCheck.valid === false && tamperedMacCheck.reason === 'grant-mac-invalid',
    ];
    if (simulateBypassGate === 'grant') {
      grantChecks.push(false);
    }
    const grantPassed = grantChecks.filter(Boolean).length;
    const grantOk = grantPassed === grantChecks.length;
    if (!grantOk) {
      findings.push(
        makeFinding({
          surface: 'write-gates',
          location: 'gate:grant',
          rule: 'write-gate-bypass',
          severity: SEVERITY.HIGH,
          count: grantChecks.length - grantPassed,
        })
      );
    }

    // -----------------------------------------------------------------------
    // Gate 2: Daemon `ApprovalToken` HMAC + Origin allowlist + single-use nonce
    // -----------------------------------------------------------------------
    const daemonUrl = pathToFileURL(
      path.join(DEFAULT_REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js')
    ).href;
    const { createDaemonServer, createApprovalToken, resetTokenRegistry } = await import(daemonUrl);
    resetTokenRegistry();

    const server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    let approvalChecks = [];
    try {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      if (LIVE_ROUTER_PORTS.has(boundPort)) {
        throw new Error(`Safety violation: ephemeral port collided with live router port ${boundPort}`);
      }
      const approveUrl = `http://127.0.0.1:${boundPort}/api/v1/changes/approve`;

      // 1. Foreign Origin -> 403 invalid_origin
      const originRes = await fetch(approveUrl, {
        method: 'POST',
        headers: {
          Origin: 'http://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planHash: 'h1', token: 't1' }),
      });
      const originBody = await originRes.json();

      // 2. Forged HMAC signature -> 403 invalid_signature
      const issued = createApprovalToken('plan-hash-gate-check');
      const [nonceHex, sigHex] = String(issued.token).split('.');
      const flippedSig = `${sigHex[0] === '0' ? '1' : '0'}${sigHex.slice(1)}`;
      const forgedRes = await fetch(approveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planHash: 'plan-hash-gate-check',
          token: `${nonceHex}.${flippedSig}`,
        }),
      });
      const forgedBody = await forgedRes.json();

      // 3. Mismatched planHash -> 403 plan_hash_mismatch
      const mismatchRes = await fetch(approveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planHash: 'different-plan-hash',
          token: issued.token,
        }),
      });
      const mismatchBody = await mismatchRes.json();

      // 4. Expired token -> 401 token_expired
      const expiredTok = createApprovalToken('plan-hash-expired', -100);
      const expiredRes = await fetch(approveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planHash: 'plan-hash-expired',
          token: expiredTok.token,
        }),
      });
      const expiredBody = await expiredRes.json();

      // 5. Valid single-use approval -> 200, followed by replay -> 403 token_already_consumed
      const singleUseTok = createApprovalToken('plan-hash-replay-check');
      const okRes = await fetch(approveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planHash: 'plan-hash-replay-check',
          token: singleUseTok.token,
        }),
      });
      const okBody = await okRes.json();

      const replayRes = await fetch(approveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planHash: 'plan-hash-replay-check',
          token: singleUseTok.token,
        }),
      });
      const replayBody = await replayRes.json();

      approvalChecks = [
        originRes.status === 403 && originBody?.error === 'invalid_origin',
        (forgedRes.status === 403 || forgedRes.status === 401) &&
          forgedBody?.meta?.reason === 'invalid_signature',
        mismatchRes.status === 403 && mismatchBody?.meta?.reason === 'plan_hash_mismatch',
        expiredRes.status === 401 && expiredBody?.meta?.reason === 'token_expired',
        okRes.status === 200 &&
          okBody?.approved === true &&
          (replayRes.status === 403 || replayRes.status === 401) &&
          replayBody?.meta?.reason === 'token_already_consumed',
      ];
      if (simulateBypassGate === 'approval-token') {
        approvalChecks.push(false);
      }
    } finally {
      resetTokenRegistry();
      await new Promise((resolve) => server.close(resolve));
    }

    const approvalPassed = approvalChecks.filter(Boolean).length;
    const approvalOk = approvalPassed === approvalChecks.length;
    if (!approvalOk) {
      findings.push(
        makeFinding({
          surface: 'write-gates',
          location: 'gate:approval-token',
          rule: 'write-gate-bypass',
          severity: SEVERITY.HIGH,
          count: approvalChecks.length - approvalPassed,
        })
      );
    }

    // -----------------------------------------------------------------------
    // Gate 3: `nine-router-patch.mjs` `--yes-write-router` + `RS_OWNER_CONFIRMED=chạy`
    // -----------------------------------------------------------------------
    const fakeAppData = path.join(tmpDir, 'appdata');
    const routerAppDir = path.join(fakeAppData, 'npm', 'node_modules', '9router', 'app');
    fs.mkdirSync(routerAppDir, { recursive: true });
    const fakePkgJson = path.join(routerAppDir, 'package.json');
    const fakeCustomServer = path.join(routerAppDir, 'custom-server.js');
    fs.writeFileSync(fakePkgJson, JSON.stringify({ name: '9router', version: '0.5.123' }), 'utf8');
    const originalServerSource = [
      'const http = require("http");',
      'const crypto = require("crypto");',
      'const origCreate = http.createServer.bind(http);',
      'function boot(handler) {',
      '  return origCreate((req, res) => {',
      '    const viaProxy = Boolean(req.headers["x-forwarded-for"]);',
      '    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";',
      '    return handler(req, res);',
      '  });',
      '}',
      'module.exports = { boot };',
      '',
    ].join('\n');
    fs.writeFileSync(fakeCustomServer, originalServerSource, 'utf8');
    const shaBefore = createHash('sha256').update(fs.readFileSync(fakeCustomServer)).digest('hex');

    const patchScript = path.join(DEFAULT_REPO_ROOT, 'tools', 'agent', 'nine-router-patch.mjs');
    const missingFlagRun = spawnSync(process.execPath, [patchScript, 'apply'], {
      cwd: tmpDir,
      env: { ...process.env, APPDATA: fakeAppData, RS_OWNER_CONFIRMED: 'chạy' },
      encoding: 'utf8',
      windowsHide: true,
    });
    const shaAfterMissingFlag = createHash('sha256')
      .update(fs.readFileSync(fakeCustomServer))
      .digest('hex');

    const missingWordRun = spawnSync(
      process.execPath,
      [patchScript, 'apply', '--yes-write-router'],
      {
        cwd: tmpDir,
        env: { ...process.env, APPDATA: fakeAppData, RS_OWNER_CONFIRMED: '' },
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    const shaAfterMissingWord = createHash('sha256')
      .update(fs.readFileSync(fakeCustomServer))
      .digest('hex');

    const patchChecks = [
      shaAfterMissingFlag === shaBefore && String(missingFlagRun.stdout).includes('KHÔNG GHI'),
      shaAfterMissingWord === shaBefore && String(missingWordRun.stdout).includes('KHÔNG GHI'),
    ];
    if (simulateBypassGate === 'yes-write-router') {
      patchChecks.push(false);
    }

    const patchPassed = patchChecks.filter(Boolean).length;
    const patchOk = patchPassed === patchChecks.length;
    if (!patchOk) {
      findings.push(
        makeFinding({
          surface: 'write-gates',
          location: 'gate:yes-write-router',
          rule: 'write-gate-bypass',
          severity: SEVERITY.HIGH,
          count: patchChecks.length - patchPassed,
        })
      );
    }

    const allGatesOk = grantOk && approvalOk && patchOk;
    return {
      ok: allGatesOk,
      surface: 'write-gates',
      gates: {
        grant: { ok: grantOk, checksPassed: grantPassed, checksTotal: grantChecks.length },
        approvalToken: {
          ok: approvalOk,
          checksPassed: approvalPassed,
          checksTotal: approvalChecks.length,
        },
        yesWriteRouter: { ok: patchOk, checksPassed: patchPassed, checksTotal: patchChecks.length },
      },
      findings,
    };
  } finally {
    if (prevStateDir === undefined) delete process.env.ROUTERSYNC_STATE_DIR;
    else process.env.ROUTERSYNC_STATE_DIR = prevStateDir;
    if (prevConfig === undefined) delete process.env.ROUTERSYNC_CONFIG;
    else process.env.ROUTERSYNC_CONFIG = prevConfig;
    if (prevGrantSecret === undefined) delete process.env.ROUTERSYNC_GRANT_SECRET;
    else process.env.ROUTERSYNC_GRANT_SECRET = prevGrantSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Orchestrate all 5 security audit surfaces and compute aggregate verdict.
 */
export async function runSecurityAudit(opts = {}) {
  const {
    repoRoot = DEFAULT_REPO_ROOT,
    tarballsDir = undefined,
    withCiLogs = false,
    ciRunsLimit = 10,
    ciBranch = 'main',
    ciLogFetcher = undefined,
    allowEmptyCiRuns = false,
    skipTarballs = false,
    skipWriteGates = false,
    skipEvidence = false,
  } = opts;

  const makeFinding = createFindingCounter();

  const repoFiles = scanRepoFiles(repoRoot, makeFinding);
  const evidenceRefs = skipEvidence
    ? {
        ok: true,
        surface: 'evidence-refs',
        status: 'skipped_flag',
        refsScanned: 0,
        blobsScanned: 0,
        refNames: [],
        findings: [],
      }
    : scanEvidenceRefs(repoRoot, undefined, makeFinding);
  const tarballs = skipTarballs
    ? { ok: true, surface: 'tarballs', status: 'skipped_flag', packagesScanned: 0, findings: [] }
    : scanPackedTarballs(repoRoot, { tarballsDir }, makeFinding);
  const ciLogs = scanRecentCiLogs(
    {
      enabled: withCiLogs,
      limit: ciRunsLimit,
      branch: ciBranch,
      root: repoRoot,
      logFetcher: ciLogFetcher,
      allowEmptyRuns: allowEmptyCiRuns,
    },
    makeFinding
  );
  const writeGates = skipWriteGates
    ? {
        ok: true,
        surface: 'write-gates',
        status: 'skipped_flag',
        gates: {},
        findings: [],
      }
    : await auditRouterWriteGates({}, makeFinding);

  const findings = [
    ...repoFiles.findings,
    ...evidenceRefs.findings,
    ...tarballs.findings,
    ...ciLogs.findings,
    ...writeGates.findings,
  ];

  const highCount = findings.filter((f) => f.severity === SEVERITY.HIGH).length;
  const mediumCount = findings.filter((f) => f.severity === SEVERITY.MEDIUM).length;
  const lowCount = findings.filter((f) => f.severity === SEVERITY.LOW).length;
  const ok =
    highCount === 0 &&
    repoFiles.ok &&
    evidenceRefs.ok &&
    tarballs.ok &&
    ciLogs.ok &&
    writeGates.ok;

  return {
    ok,
    highCount,
    mediumCount,
    lowCount,
    surfaces: {
      repoFiles: {
        ok: repoFiles.ok,
        filesScanned: repoFiles.filesScanned,
        findingsCount: repoFiles.findings.length,
      },
      evidenceRefs: {
        ok: evidenceRefs.ok,
        refsScanned: evidenceRefs.refsScanned,
        blobsScanned: evidenceRefs.blobsScanned,
        refs: evidenceRefs.refNames ?? [],
        findingsCount: evidenceRefs.findings.length,
      },
      tarballs: {
        ok: tarballs.ok,
        status: tarballs.status,
        packagesScanned: tarballs.packagesScanned,
        findingsCount: tarballs.findings.length,
      },
      ciLogs: {
        ok: ciLogs.ok,
        status: ciLogs.status,
        branch: ciLogs.branch,
        runsScanned: ciLogs.runsScanned,
        runIds: ciLogs.runIds ?? [],
        findingsCount: ciLogs.findings.length,
      },
      writeGates: {
        ok: writeGates.ok,
        gates: writeGates.gates,
        findingsCount: writeGates.findings.length,
      },
    },
    findings,
  };
}

export function parseSecurityAuditArgs(argv = process.argv.slice(2)) {
  const parsed = {
    repoRoot: DEFAULT_REPO_ROOT,
    tarballsDir: undefined,
    withCiLogs: false,
    ciRunsLimit: 10,
    ciBranch: 'main',
    skipTarballs: false,
    skipWriteGates: false,
    skipEvidence: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root') {
      parsed.repoRoot = path.resolve(argv[++i] ?? '');
    } else if (arg === '--tarballs-dir') {
      parsed.tarballsDir = path.resolve(argv[++i] ?? '');
    } else if (arg === '--with-ci-logs') {
      parsed.withCiLogs = true;
    } else if (arg === '--ci-runs-limit') {
      const rawLimit = Number(argv[++i] ?? 10);
      if (!Number.isFinite(rawLimit) || rawLimit < 1) {
        throw new Error('Invalid --ci-runs-limit value: expected positive integer');
      }
      parsed.ciRunsLimit = Math.floor(rawLimit);
    } else if (arg === '--ci-branch') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --ci-branch');
      }
      parsed.ciBranch = String(argv[++i] ?? '');
    } else if (arg === '--skip-tarballs') {
      parsed.skipTarballs = true;
    } else if (arg === '--skip-write-gates') {
      parsed.skipWriteGates = true;
    } else if (arg === '--skip-evidence') {
      parsed.skipEvidence = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else {
      throw new Error(`Unknown security-audit flag: ${arg}`);
    }
  }

  return parsed;
}

async function main() {
  const opts = parseSecurityAuditArgs();
  const report = await runSecurityAudit(opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log(
    `SEC_AUDIT_SURFACE surface=repo-files ok=${report.surfaces.repoFiles.ok} files=${report.surfaces.repoFiles.filesScanned} findings=${report.surfaces.repoFiles.findingsCount}`
  );
  console.log(
    `SEC_AUDIT_SURFACE surface=evidence-refs ok=${report.surfaces.evidenceRefs.ok} refs=${report.surfaces.evidenceRefs.refsScanned} blobs=${report.surfaces.evidenceRefs.blobsScanned} findings=${report.surfaces.evidenceRefs.findingsCount}`
  );
  console.log(
    `SEC_AUDIT_SURFACE surface=tarballs ok=${report.surfaces.tarballs.ok} status=${report.surfaces.tarballs.status} packages=${report.surfaces.tarballs.packagesScanned} findings=${report.surfaces.tarballs.findingsCount}`
  );
  console.log(
    `SEC_AUDIT_SURFACE surface=ci-logs ok=${report.surfaces.ciLogs.ok} status=${report.surfaces.ciLogs.status} runs=${report.surfaces.ciLogs.runsScanned} findings=${report.surfaces.ciLogs.findingsCount}`
  );
  console.log(
    `SEC_AUDIT_SURFACE surface=write-gates ok=${report.surfaces.writeGates.ok} findings=${report.surfaces.writeGates.findingsCount}`
  );

  for (const f of report.findings) {
    console.error(
      `SEC_AUDIT_FINDING id=${f.id} severity=${f.severity} surface=${f.surface} rule=${f.rule} location=${f.location} count=${f.count}`
    );
  }

  console.log(
    `SEC_AUDIT_SUMMARY ok=${report.ok} high=${report.highCount} medium=${report.mediumCount} low=${report.lowCount}`
  );

  process.exit(report.ok ? 0 : 1);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    // Sanitize error message to avoid leaking any path or value
    console.error(`SEC_AUDIT_ERROR type=${err?.name ?? 'Error'}`);
    process.exit(1);
  });
}
