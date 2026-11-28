/**
 * packages/cli/test/c50-k1-secret-matrix.test.ts
 *
 * Ticket C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 *  - >= 28 real provider/env/config secret formats + 10 short (18–22 char) prefixed keys.
 *  - Stage-1 scrubber: array parentKey inheritance, vendor/custom prefixes, raw + URL-encoded
 *    literal env values, high-entropy hex/alnum/base64url tokens, and hash/model-ID allowlists.
 *  - Stage-2 scanner: strict static & behavioral independence from Stage-1 vendor prefixes.
 *  - Negative suite: 0 false positives on sha256, planHash, receipt/snapshot IDs, UUIDs, & long model IDs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RouterSyncConfigSchema } from '../src/config/schema.js';
import { scanSerializedFieldReportOutputs } from '../src/commands/field-report-scanner.js';
import {
  scrubFieldReportString,
  scrubFieldReportValue,
} from '../src/commands/field-report-scrubber.js';
import {
  C50_CFG_SECRET_RAW,
  C50_ENV_SECRET_RAW,
  SHORT_PREFIXED_KEYS_M4,
  buildC50SecretFormatsFixture,
} from './helpers/c50-secret-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('C50-K1: Two-Stage Secret Matrix, Short Prefixes, Independence & Negative Suite', () => {
  it('supports optional fieldReport.{extraSecretPrefixes,extraSecretEnvVars} in schema.ts', () => {
    const valid = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'omni', adapter: 'omniroute', isolated: true }],
      fieldReport: {
        extraSecretPrefixes: ['mycorp_', 'org-tok-'],
        extraSecretEnvVars: ['MY_CUSTOM_ROUTER_CRED'],
      },
    });
    expect(valid.success).toBe(true);
    expect((valid.data as Record<string, unknown>)['fieldReport']).toEqual({
      extraSecretPrefixes: ['mycorp_', 'org-tok-'],
      extraSecretEnvVars: ['MY_CUSTOM_ROUTER_CRED'],
    });

    const tooShortPrefix = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'omni', adapter: 'omniroute', isolated: true }],
      fieldReport: { extraSecretPrefixes: ['x'] },
    });
    expect(tooShortPrefix.success).toBe(false);
  });

  it('propagates sensitive parentKey into array elements (kills M3)', () => {
    const res = scrubFieldReportValue({
      apiKeys: ['shortVal1', 'shortVal2'],
      secrets: ['tiny99'],
      refreshTokens: ['miniTok'],
      harmlessList: ['keepMe1', 'keepMe2'],
    });
    expect(res.value).toEqual({
      apiKeys: ['[REDACTED_SECRET]', '[REDACTED_SECRET]'],
      secrets: ['[REDACTED_SECRET]'],
      refreshTokens: ['[REDACTED_SECRET]'],
      harmlessList: ['keepMe1', 'keepMe2'],
    });
    expect(res.redactedCount).toBe(4);
  });

  it('redacts short 18–22 char vendor & custom prefixed keys below the 28-char entropy cutoff (kills M4)', () => {
    for (const shortKey of SHORT_PREFIXED_KEYS_M4) {
      expect(shortKey.length).toBeLessThan(24);
      const res = scrubFieldReportValue(
        { note: `Auth failed for ${shortKey}` },
        { extraPrefixes: ['mycorp_'] }
      );
      expect(res.value.note, `Short prefixed key leaked: ${shortKey}`).toBe(
        'Auth failed for [REDACTED_SECRET]'
      );
      expect(res.redactedCount).toBe(1);
    }
  });

  it('redacts all 28 secret formats in Stage 1 under harmless { note } key (kills M1, M2, M4)', () => {
    const fixtures = buildC50SecretFormatsFixture();
    expect(fixtures.length).toBeGreaterThanOrEqual(28);

    for (const item of fixtures) {
      const res = scrubFieldReportValue(
        { note: `Diagnostic: ${item.value}` },
        {
          extraPrefixes: ['mycorp_'],
          extraLiterals: [C50_ENV_SECRET_RAW, C50_CFG_SECRET_RAW],
        }
      );
      expect(res.redactedCount, `Stage 1 did not redact ${item.id}`).toBeGreaterThanOrEqual(1);
      expect(res.value.note, `Stage 1 leaked ${item.id}`).not.toContain(item.probeToken);
    }
  });

  it('enforces Stage-2 static & behavioral independence from Stage-1 vendor prefixes (kills M5)', () => {
    const scannerPath = path.join(
      REPO_ROOT,
      'packages',
      'cli',
      'src',
      'commands',
      'field-report-scanner.ts'
    );
    const scannerSrc = fs.readFileSync(scannerPath, 'utf8');

    expect(scannerSrc).not.toContain('field-report-scrubber');
    const forbiddenVendorPrefixes = [
      ['s', 'k-'].join(''),
      ['gsk', '_'].join(''),
      ['hf', '_'].join(''),
      ['nvapi', '-'].join(''),
      ['xai', '-'].join(''),
      ['pplx', '-'].join(''),
      ['r8', '_'].join(''),
      ['sk', '-or-'].join(''),
      ['csk', '-'].join(''),
      ['key', '-'].join(''),
      ['AI', 'za'].join(''),
      ['ghp', '_'].join(''),
      ['github', '_pat_'].join(''),
    ];
    for (const pfx of forbiddenVendorPrefixes) {
      expect(scannerSrc, `Scanner contains vendor prefix ${pfx}`).not.toContain(pfx);
    }
    expect(scannerSrc).not.toMatch(/\['s',\s*'k',\s*'-'\]|\['A',\s*'I',\s*'z',\s*'a'\]/);

    const fixtures = buildC50SecretFormatsFixture();
    for (const item of fixtures) {
      const scanRes = scanSerializedFieldReportOutputs(
        { 'timeline.jsonl': `${JSON.stringify({ id: 'evt-0001', metadata: { note: item.value } })}\n` },
        { secretLiterals: [C50_ENV_SECRET_RAW, C50_CFG_SECRET_RAW] }
      );
      expect(scanRes.clean, `Stage 2 missed ${item.id} (${item.label})`).toBe(false);
      expect(JSON.stringify(scanRes.violations)).not.toContain(item.probeToken);
    }
  });

  it('preserves hashes, receipt/snapshot IDs, UUIDs, and long model IDs with 0 false positives', () => {
    const hex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const longModels = [
      'openrouter/anthropic/claude-3.7-sonnet-20250219:thinking',
      'togethercomputer/Meta-Llama-3.1-405B-Instruct-Turbo',
      'accounts/fireworks/models/deepseek-r1-distill-llama-70b',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'Meta-Llama-3.1-405B-Instruct-Turbo',
      'deepseek-r1-distill-llama-70b',
    ];
    const payload = {
      sha256: hex64,
      planHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
      stdoutSha12: 'a1b2c3d4e5f6',
      stderrSha12: '0123456789ab',
      receiptId: `rcpt-${uuid}`,
      snapshotId: `snap-${hex64.slice(0, 32)}`,
      snapshotOrBackupRef: `backup-${hex64}`,
      id: uuid,
      uuid,
      models: longModels,
      note: `Verified sha256:${hex64} uuid=${uuid} models=${longModels.join(', ')}`,
    };

    const scrubRes = scrubFieldReportValue(payload, {
      osUsername: 'nonMatchingTestAcct99',
      hostname: 'nonMatchingTestHost99',
      extraPrefixes: ['mycorp_'],
      extraLiterals: [C50_ENV_SECRET_RAW, C50_CFG_SECRET_RAW],
    });

    expect(scrubRes.redactedCount).toBe(0);
    expect(scrubRes.value).toEqual(payload);
    expect(
      scrubFieldReportString(payload.note, {
        osUsername: 'nonMatchingTestAcct99',
        hostname: 'nonMatchingTestHost99',
      }).redactedCount
    ).toBe(0);

    const scanRes = scanSerializedFieldReportOutputs(
      {
        'summary.json': JSON.stringify(payload, null, 2),
        'README.md': `# Check\nDigest sha256:${hex64} on ${longModels.join(' ')}\n`,
      },
      {
        osUsername: 'nonMatchingTestAcct99',
        hostname: 'nonMatchingTestHost99',
        secretLiterals: [C50_ENV_SECRET_RAW, C50_CFG_SECRET_RAW],
      }
    );
    expect(scanRes.violations).toEqual([]);
    expect(scanRes.clean).toBe(true);
  });
});
