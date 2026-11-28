/**
 * packages/cli/test/c50-k1-secret-matrix.test.ts
 *
 * Ticket C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 *  - >= 28 real provider/env/config secret formats + 10 short (18–22 char) prefixed keys.
 *  - Stage-1 scrubber & Stage-2 independent scanner (RFC-3986/form-urlencoded literals,
 *    sensitive object/array keys, entropy, camelCase/model-slug & ID-field allowlists).
 *  - Strict <= 340 line-count gate on C50 modules.
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
  C50_ENV_SECRET_ENCODED,
  C50_ENV_SECRET_RAW,
  C50_ENV_SECRET_RFC3986,
  SHORT_PREFIXED_KEYS_M4,
  buildC50SecretFormatsFixture,
} from './helpers/c50-secret-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('C50-K1: Two-Stage Secret Matrix, Short Prefixes, Independence & QA Probes A–E', () => {
  it('enforces <= 340 lines on C50 security modules (P1-2)', () => {
    const modules = [
      'packages/cli/src/commands/field-report-scrubber.ts',
      'packages/cli/src/commands/field-report-scanner.ts',
      'packages/cli/src/commands/field-report-secrets-context.ts',
    ];
    for (const rel of modules) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const lineCount = text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0);
      expect(lineCount, `${rel} exceeded 340 lines`).toBeLessThanOrEqual(340);
    }
  });

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

    const tooShortPrefix = RouterSyncConfigSchema.safeParse({
      version: 1,
      routers: [{ id: 'omni', adapter: 'omniroute', isolated: true }],
      fieldReport: { extraSecretPrefixes: ['x'] },
    });
    expect(tooShortPrefix.success).toBe(false);
  });

  it('propagates sensitive parentKey into array elements in BOTH Stage 1 & Stage 2 (M3 & Probe E)', () => {
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

    // Probe E: Stage 2 independently refuses unredacted short secrets in sensitive object/array fields
    const sensitivePayloads: Array<Record<string, unknown>> = [
      { apiKeys: ['shortVal'] },
      { apiKey: 'shortVal' },
      { secrets: ['tiny99'] },
      { secret: 'tiny99' },
      { password: 'pw1234' },
      { passwd: 'pw1234' },
      { token: 'tok123' },
      { tokens: ['tok123'] },
      { accessToken: 'at123' },
      { refreshToken: 'rt123' },
      { clientSecret: 'cs123' },
      { privateKey: 'pk123' },
      { authorization: 'auth123' },
      { cookie: 'sid=123' },
      { bearer: 'br123' },
    ];
    for (const badObj of sensitivePayloads) {
      const scanBad = scanSerializedFieldReportOutputs(
        { 'summary.json': JSON.stringify(badObj, null, 2) },
        { osUsername: 'nonMatchUser99', hostname: 'nonMatchHost99' }
      );
      expect(scanBad.clean, `Stage 2 missed ${JSON.stringify(badObj)}`).toBe(false);
    }

    // Numeric tokens and safe metadata booleans/counters remain clean
    const safeMetaScan = scanSerializedFieldReportOutputs(
      {
        'summary.json': JSON.stringify({
          tokens: 1234,
          hasApiKey: true,
          hasWebhookUrl: false,
          keyPresent: true,
          redactedCount: 5,
          apiKeys: ['[REDACTED_SECRET]'],
        }),
      },
      { osUsername: 'nonMatchUser99', hostname: 'nonMatchHost99' }
    );
    expect(safeMetaScan.clean).toBe(true);
  });

  it('catches JS encodeURIComponent, strict RFC-3986 (%21%40), and form-urlencoded (+) literals in BOTH stages (Probe D)', () => {
    const literals = [C50_ENV_SECRET_RAW, 'MyRtrSec99!@', "Spc Key(1)*'%", 'TrailPct99%'];
    const encodedVariants = [
      C50_ENV_SECRET_RAW,
      C50_ENV_SECRET_ENCODED,
      C50_ENV_SECRET_RFC3986,
      'MyRtrSec99!@',
      'MyRtrSec99!%40',
      'MyRtrSec99%21%40',
      'MyRtrSec99%21@',
      'Spc%20Key%281%29%2A%27%25',
      'Spc+Key%281%29%2a%27%25',
      'TrailPct99%25',
    ];
    for (const variant of encodedVariants) {
      const s1 = scrubFieldReportValue({ note: `Leak=${variant}` }, { extraLiterals: literals });
      expect(s1.value.note, `Stage 1 leaked ${variant}`).toBe('Leak=[REDACTED_SECRET]');
      expect(s1.redactedCount).toBe(1);

      const s2 = scanSerializedFieldReportOutputs(
        { 'timeline.jsonl': `${JSON.stringify({ note: variant })}\n` },
        { secretLiterals: literals, osUsername: 'nonMatchUser99', hostname: 'nonMatchHost99' }
      );
      expect(s2.clean, `Stage 2 missed ${variant}`).toBe(false);
      expect(s2.violations.some((v) => v.ruleCode === 'UNREDACTED_LITERAL_SECRET')).toBe(true);
    }
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

  it('preserves hashes, UUIDs, model slugs, camelCase identifiers & ID fields while catching pure-letter random secrets (Probes A, B, C)', () => {
    const hex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const longModels = [
      'openrouter/anthropic/claude-3.7-sonnet-20250219:thinking',
      'togethercomputer/Meta-Llama-3.1-405B-Instruct-Turbo',
      'accounts/fireworks/models/deepseek-r1-distill-llama-70b',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'Meta-Llama-3-1-405B-Instruct-Turbo',
      'Qwen2-5-Coder-32B-Instruct-AWQ-Int4',
      'DeepSeek-R1-Distill-Qwen-32B-AWQ',
    ];
    const camelFlag = 'allowUnvalidatedShadowModeFallbackConfiguration';
    const pascalFlag = 'AllowUnvalidatedShadowModeFallbackConfiguration';
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
      modelId: 'Qwen2-5-Coder-32B-Instruct-AWQ-Int4-Custom9876543210AbCd',
      fullStep: 'omni/Qwen2-5-Coder-32B-Instruct-AWQ-Int4',
      providerId: 'providerIdentifierCustom9876543210AbCd',
      blockedModels: ['omni/Meta-Llama-3-1-405B-Instruct-Turbo'],
      inCombos: ['omni/rsPrimaryFallbackCombo9876543210AbCd'],
      targetId: 'routerTargetIdentifier9876543210AbCd',
      target: 'router:omni/rs-main-9876543210AbCdEfGh',
      models: longModels,
      featureFlag: camelFlag,
      className: pascalFlag,
      note: `Verified sha256:${hex64} uuid=${uuid} flag=${camelFlag} models=${longModels.join(', ')}`,
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
        'README.md': `# Check\nDigest sha256:${hex64} ${camelFlag} ${longModels.join(' ')}\n`,
      },
      {
        osUsername: 'nonMatchingTestAcct99',
        hostname: 'nonMatchingTestHost99',
        secretLiterals: [C50_ENV_SECRET_RAW, C50_CFG_SECRET_RAW],
      }
    );
    expect(scanRes.violations).toEqual([]);
    expect(scanRes.clean).toBe(true);

    // Pure-letter random mixed-case secrets MUST still be caught by BOTH stages
    const pureLetterHf = ['hf', '_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh'].join('');
    const pureLetterBare = 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
    for (const randTok of [pureLetterHf, pureLetterBare]) {
      const s1 = scrubFieldReportValue({ note: randTok });
      expect(s1.redactedCount).toBe(1);
      expect(s1.value.note).toBe('[REDACTED_SECRET]');
      const s2 = scanSerializedFieldReportOutputs(
        { 'summary.json': JSON.stringify({ note: randTok }) },
        { osUsername: 'nonMatchingTestAcct99', hostname: 'nonMatchingTestHost99' }
      );
      expect(s2.clean).toBe(false);
    }

    // Literal & prefix rules MUST remain active even on allowlisted ID fields
    const leakInTarget = scrubFieldReportValue(
      { target: `router:${C50_ENV_SECRET_RFC3986}` },
      { extraLiterals: [C50_ENV_SECRET_RAW] }
    );
    expect(leakInTarget.value.target).toBe('router:[REDACTED_SECRET]');
  });
});
