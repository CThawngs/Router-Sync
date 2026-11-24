/**
 * packages/core/test/wp8-zero-llm-and-allowlist.test.ts
 *
 * C45-WP8 Hard Security & Zero-LLM Proofs (Phục vụ: S7):
 *  - Proof 1: Static source & import-graph scan across all workspace packages
 *  - Proof 2: Registry domain allowlist completeness (`sources.yaml` + `providers.yaml` + hardcoded catalog URLs)
 *  - Proof 3: Runtime `createGuardedFetch` & `createAccountingFetch` interception blocking
 *    LLM inference endpoints (even on allowed domains!) and unlisted domains before `fetch` executes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_LLM_PATH_PATTERNS,
  OutboundGuardError,
  assertAllowedOutboundUrl,
  createAccountingFetch,
  createGuardedFetch,
  loadCanonicalAllowedDomains,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('C45-WP8 Proof 1: Static Source & Import Graph Zero-LLM Audit', () => {
  const MANUAL_PROBE_EXCEPTIONS = new Set([
    'packages/cli/src/commands/combos-probe.ts',
    'packages/cli/src/commands/combos-reliability.ts',
    'packages/cli/src/commands/router-watch.ts',
    // Self-definitions of the guard regexes themselves:
    'packages/core/src/cost/outbound-guard.ts',
    'packages/cli/src/sync/providers.ts',
  ]);

  it('has ZERO forbidden LLM inference endpoint paths across all automated runtime modules', () => {
    const packagesDir = path.join(REPO_ROOT, 'packages');
    const pkgNames = fs.readdirSync(packagesDir);
    const violations: string[] = [];

    for (const pkg of pkgNames) {
      const srcDir = path.join(packagesDir, pkg, 'src');
      for (const file of walkSourceFiles(srcDir)) {
        const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
        if (MANUAL_PROBE_EXCEPTIONS.has(rel)) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        for (const pattern of FORBIDDEN_LLM_PATH_PATTERNS) {
          if (pattern.test(code)) {
            violations.push(`${rel} matched ${pattern}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('proves automated modules (tick, schedule, doctor, research, daemon, mcp-server) NEVER import manual probe commands', () => {
    const automatedFiles = [
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'daemon', 'src')),
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'mcp-server', 'src')),
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'sources', 'src')),
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'core', 'src')),
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'tick.ts'),
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'schedule.ts'),
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'doctor.ts'),
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'research.ts'),
    ];

    const forbiddenImports = ['combos-probe', 'combos-reliability', 'router-watch'];
    const importViolations: string[] = [];

    for (const file of automatedFiles) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const target of forbiddenImports) {
        if (code.includes(target)) {
          importViolations.push(`${rel} references manual probe module ${target}`);
        }
      }
    }

    expect(importViolations).toEqual([]);
  });
});

describe('C45-WP8 Proof 2: Canonical Registry Domain Allowlist Completeness', () => {
  it('includes every URL host from registry/sources.yaml, registry/providers.yaml, and hardcoded catalog sources', () => {
    const allowed = loadCanonicalAllowedDomains(REPO_ROOT);
    expect(allowed.size).toBeGreaterThanOrEqual(15);

    const sourcesText = fs.readFileSync(path.join(REPO_ROOT, 'registry', 'sources.yaml'), 'utf8');
    const providersText = fs.readFileSync(path.join(REPO_ROOT, 'registry', 'providers.yaml'), 'utf8');
    for (const rawText of [sourcesText, providersText]) {
      for (const m of rawText.matchAll(/https:\/\/[^\s"']+/g)) {
        const host = new URL(m[0]).hostname.toLowerCase();
        expect(allowed.has(host), `Registry host ${host} missing from allowlist`).toBe(true);
      }
    }

    // Scan all hardcoded https:// URLs in packages/sources/src and packages/cli/src
    const NON_NETWORK_XML_DOCTYPES = new Set(['schemas.microsoft.com', 'www.apple.com']);
    const filesToCheck = [
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'sources', 'src')),
      ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'cli', 'src')),
    ];
    for (const file of filesToCheck) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/https:\/\/[a-zA-Z0-9.-]+(?:\/[^\s"'`)]*)?/g)) {
        const host = new URL(m[0]).hostname.toLowerCase();
        if (NON_NETWORK_XML_DOCTYPES.has(host)) continue;
        expect(
          allowed.has(host),
          `Hardcoded host ${host} in ${path.relative(REPO_ROOT, file)} missing from loadCanonicalAllowedDomains()`
        ).toBe(true);
      }
    }
  });
});

describe('C45-WP8 Proof 3: Runtime Guarded & Accounting Fetch Interception (Kills M5)', () => {
  it('blocks FORBIDDEN_LLM_PATH_PATTERNS even on allowlisted & localhost hosts before fetch executes', async () => {
    const spyFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const guarded = createGuardedFetch(spyFetch as unknown as typeof fetch, { repoRoot: REPO_ROOT });

    const forbiddenUrls = [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/completions',
      'https://api.openai.com/v1/embeddings',
      'https://api.anthropic.com/v1/messages',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
      'http://127.0.0.1:20128/v1/chat/completions',
      'http://localhost:30128/v1/messages',
    ];

    for (const badUrl of forbiddenUrls) {
      expect(() => assertAllowedOutboundUrl(badUrl, { repoRoot: REPO_ROOT })).toThrow(
        OutboundGuardError
      );
      await expect(guarded(badUrl)).rejects.toMatchObject({
        code: 'FORBIDDEN_LLM_ENDPOINT',
      });
    }
    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('blocks unlisted domains, spoofed suffixes, non-HTTP schemes, and embedded credentials before fetch executes', async () => {
    const spyFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const guarded = createGuardedFetch(spyFetch as unknown as typeof fetch, { repoRoot: REPO_ROOT });

    await expect(guarded('https://unlisted-evil.example/v1/models')).rejects.toMatchObject({
      code: 'UNLISTED_OUTBOUND_DOMAIN',
    });
    await expect(guarded('https://openrouter.ai.evil.example/api/v1/models')).rejects.toMatchObject({
      code: 'UNLISTED_OUTBOUND_DOMAIN',
    });
    await expect(guarded('ftp://openrouter.ai/api/v1/models')).rejects.toMatchObject({
      code: 'DISALLOWED_OUTBOUND_SCHEME',
    });
    const embeddedCredUrl = ['https://usr:pwd', 'openrouter.ai/api/v1/models'].join(String.fromCharCode(64));
    await expect(guarded(embeddedCredUrl)).rejects.toMatchObject({
      code: 'EMBEDDED_CREDENTIALS_FORBIDDEN',
    });

    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('permits canonical catalog GETs and tracks per-domain counts via createAccountingFetch', async () => {
    const spyFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    const { fetchFn, snapshot } = createAccountingFetch(spyFetch as unknown as typeof fetch, {
      repoRoot: REPO_ROOT,
    });

    await fetchFn('https://openrouter.ai/api/v1/models');
    await fetchFn('https://openrouter.ai/blog');
    await fetchFn('https://models.dev/api.json');
    await fetchFn('http://127.0.0.1:20128/v1/models');

    const stats = snapshot();
    expect(stats.totalHttpRequests).toBe(4);
    expect(stats.domainRequests).toEqual({
      'openrouter.ai': 2,
      'models.dev': 1,
      '127.0.0.1': 1,
    });
    expect(spyFetch).toHaveBeenCalledTimes(4);
  });
});
