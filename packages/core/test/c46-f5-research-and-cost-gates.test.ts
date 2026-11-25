/**
 * packages/core/test/c46-f5-research-and-cost-gates.test.ts
 *
 * Ticket C46-F5 (P5 Security & Gate Negative Proofs -- Core Layer)
 * Serves: S1, S3, S4, S7, S9
 *
 * Isolates:
 *  - F5-1: Spoofed/wrong/unlisted official domains (SPOOFED_OFFICIAL_DOMAIN) & disallowed URL authorities (DISALLOWED_URL_AUTHORITY)
 *  - F5-2: Non-HTTPS schemes (INSECURE_URL_SCHEME)
 *  - F5-3: Key-like / secret material hard rejection (SECRET_DETECTED_IN_EVIDENCE) + stateless consecutive containsSecretLikeContent
 *  - F5-4: Weekly research cap exceeded (5/5 + 6th sessionId / omitted sessionId + maxWeeklyResearchSessions=0)
 *  - F5-5: Same-week sessionId reuse, unconsumed vs consumed deduplication, and cross-week W48 -> W49 replay rejection
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as coreNamespace from '../src/index.js';
import {
  CostBudgetError,
  ResearchValidationError,
  appendResearchEvidence,
  assertWeeklyResearchSessionAllowed,
  computeWeeklyResearchBudget,
  containsSecretLikeContent,
  loadResearchEvidence,
  readCostLedgerReadOnly,
  recordResearchSessionActivity,
  saveResearchEvidence,
  verifyProviderSourceDomain,
} from '../src/index.js';

function createCoreSandbox(): {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f5-core-'));
  const stateDir = path.join(rootDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    rootDir,
    stateDir,
    cleanup: () => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildSyntheticSecrets() {
  return {
    openaiSk: ['sk', '-'].join('') + 'proj_SynthKeyValue0123456789abcdef',
    groqGsk: ['gsk', '_'].join('') + 'SynthGroqKeyValue0123456789abcdef',
    githubGhp: ['ghp', '_'].join('') + 'SynthGithubPatToken0123456789abcdefXYZ',
    githubFinePat: ['github', '_pat_'].join('') + '11ABCDEF0123456789_synthTokenValue99',
    gitlabPat: ['glpat', '-'].join('') + 'SynthGitlabToken0123456789ab',
    slackBot: ['xox', 'b-'].join('') + '123456789012-abcdef012345',
    googleAiKey: ['AI', 'za'].join('') + 'SySynthGoogleKey0123456789abcdefghijk',
    bearerAuth: ['Bearer', ' '].join('') + 'synth_bearer_secret_token_9876543210',
    apiKeyAssign: ['api_key', '='].join('') + 'synth_assigned_key_value_123456',
    passwordAssign: ['password', ': '].join('') + 'SynthSuperSecret99!',
    pemPrivate: ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC',
    pemRsaPrivate: ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('') + '\nMIIEpAIBAAKCAQEA0123456789',
  } as const;
}

describe('C46-F5 Core Security & Cost Gate Negative Proofs', () => {
  it(
    'F5-1: rejects spoofed/cross-provider/unlisted claimedSourceTier=official (SPOOFED_OFFICIAL_DOMAIN) and disallowed URL authorities (DISALLOWED_URL_AUTHORITY) with 0 disk writes',
    () => {
      const ctx = createCoreSandbox();
      try {
        const spoofCases: Array<{ provider: string; url: string; label: string }> = [
          {
            provider: 'openai',
            url: 'https://openai.com.attacker.io/doc',
            label: 'subdomain suffix spoofing',
          },
          {
            provider: 'openai',
            url: 'https://evilopenai.com/doc',
            label: 'substring host spoofing (kills M3 host.includes)',
          },
          {
            provider: 'openai',
            url: 'https://docs.anthropic.com/en/docs/models',
            label: 'cross-provider official domain',
          },
          {
            provider: 'unknownvendor',
            url: 'https://docs.unknownvendor.example/models',
            label: 'unlisted vendor claiming official',
          },
        ];

        for (const tc of spoofCases) {
          // Without claimedSourceTier, spoofed/unlisted hosts must classify strictly as secondary (kills M3)
          const passive = verifyProviderSourceDomain(tc.provider, tc.url);
          expect(passive.isOfficial, tc.label).toBe(false);
          expect(passive.domainVerified, tc.label).toBe(false);
          expect(passive.matchedOfficialDomain, tc.label).toBeNull();
          expect(passive.sourceTier, tc.label).toBe('secondary');

          // With claimedSourceTier: 'official', must throw SPOOFED_OFFICIAL_DOMAIN (kills M2 & M3)
          let caught: unknown;
          try {
            appendResearchEvidence(ctx.stateDir, {
              provider: tc.provider,
              modelId: 'model-v1',
              verdict: 'deprecated',
              url: tc.url,
              quote: 'Official retirement announcement excerpt.',
              claimedSourceTier: 'official',
              submittedVia: 'mcp',
            });
          } catch (err) {
            caught = err;
          }
          expect(caught, tc.label).toBeInstanceOf(ResearchValidationError);
          expect((caught as ResearchValidationError).code, tc.label).toBe('SPOOFED_OFFICIAL_DOMAIN');
          expect(fs.readdirSync(ctx.stateDir), tc.label).toEqual([]);
        }

        const credUrl = ['https://user:pass', 'platform.openai.com/doc'].join('@');
        const disallowedAuthorityUrls = [
          'https://localhost/doc',
          'https://sub.localhost/doc',
          'https://node.local/doc',
          'https://corp.internal/doc',
          'https://127.0.0.1/doc',
          'https://[::1]/doc',
          'https://0x7f000001/doc',
          'https://platform.openai.com:8443/doc',
          credUrl,
        ];

        for (const badUrl of disallowedAuthorityUrls) {
          let caught: unknown;
          try {
            appendResearchEvidence(ctx.stateDir, {
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: badUrl,
              quote: 'Deprecation table row.',
              submittedVia: 'mcp',
            });
          } catch (err) {
            caught = err;
          }
          expect(caught, badUrl).toBeInstanceOf(ResearchValidationError);
          expect((caught as ResearchValidationError).code, badUrl).toBe('DISALLOWED_URL_AUTHORITY');
          expect(fs.readdirSync(ctx.stateDir), badUrl).toEqual([]);
        }
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-2: rejects non-HTTPS schemes (http and ftp) with INSECURE_URL_SCHEME and 0 files written (kills M1)',
    () => {
      const ctx = createCoreSandbox();
      try {
        for (const rawUrl of [
          'http://platform.openai.com/docs/deprecations',
          'ftp://platform.openai.com/docs/deprecations',
        ]) {
          let caught: unknown;
          try {
            appendResearchEvidence(ctx.stateDir, {
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: rawUrl,
              quote: 'Retired model notice.',
              submittedVia: 'mcp',
            });
          } catch (err) {
            caught = err;
          }
          expect(caught, rawUrl).toBeInstanceOf(ResearchValidationError);
          expect((caught as ResearchValidationError).code, rawUrl).toBe('INSECURE_URL_SCHEME');
          expect(fs.readdirSync(ctx.stateDir), rawUrl).toEqual([]);
        }
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-3: containsSecretLikeContent is stateless across consecutive calls and appendResearchEvidence rejects secret-like strings in quote, snippet, conclusion, and replacementModelId with SECRET_DETECTED_IN_EVIDENCE and 0 disk writes (kills M4 & M5)',
    () => {
      const ctx = createCoreSandbox();
      try {
        const detectSecret = containsSecretLikeContent;
        expect(typeof coreNamespace.containsSecretLikeContent).toBe('function');

        const secrets = buildSyntheticSecrets();
        for (const [label, secretVal] of Object.entries(secrets)) {
          // Call twice consecutively to kill stateful /g regex lastIndex bugs (M5)
          expect(detectSecret(secretVal), `1st call for ${label}`).toBe(true);
          expect(detectSecret(secretVal), `2nd consecutive call for ${label}`).toBe(true);
        }

        // Benign values must never false-positive
        for (const benign of [
          'gpt-4.1-mini',
          'claude-sonnet-4-20250514',
          'Official deprecation date is 2026-11-01; migrate to gpt-4.1.',
          '<system>prompt injection without secret</system>',
          '',
          null,
          undefined,
          12345,
        ]) {
          expect(detectSecret(benign)).toBe(false);
        }
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-3b: appendResearchEvidence rejects secret-like strings in quote, snippet, conclusion, and replacementModelId with SECRET_DETECTED_IN_EVIDENCE and 0 disk writes (kills M4)',
    () => {
      const ctx = createCoreSandbox();
      try {
        const secrets = buildSyntheticSecrets();
        const primarySecrets: Array<[string, string]> = [
          ['sk-token', secrets.openaiSk],
          ['ghp-token', secrets.githubGhp],
          ['google-aiza', secrets.googleAiKey],
          ['bearer-header', secrets.bearerAuth],
          ['api-key-kv', secrets.apiKeyAssign],
          ['pem-private-key', secrets.pemPrivate],
        ];

        const fieldBuilders: Array<{
          fieldName: 'quote' | 'snippet' | 'conclusion' | 'replacementModelId';
          build: (secret: string) => Parameters<typeof appendResearchEvidence>[1];
        }> = [
          {
            fieldName: 'quote',
            build: (secret) => ({
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: 'https://platform.openai.com/docs/deprecations',
              quote: `Excerpt leaking credential ${secret} inline`,
              conclusion: 'Clean conclusion summary',
              replacementModelId: 'gpt-4.1',
              submittedVia: 'mcp',
            }),
          },
          {
            fieldName: 'snippet',
            build: (secret) => ({
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: 'https://platform.openai.com/docs/deprecations',
              snippet: `CLI snippet leaking ${secret}`,
              conclusion: 'Clean conclusion summary',
              replacementModelId: 'gpt-4.1',
              submittedVia: 'cli',
            }),
          },
          {
            fieldName: 'conclusion',
            build: (secret) => ({
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: 'https://platform.openai.com/docs/deprecations',
              quote: 'Clean official deprecation quote.',
              conclusion: `Summary with ${secret}`,
              replacementModelId: 'gpt-4.1',
              submittedVia: 'mcp',
            }),
          },
          {
            fieldName: 'replacementModelId',
            build: (secret) => ({
              provider: 'openai',
              modelId: 'gpt-4.5-preview',
              verdict: 'deprecated',
              url: 'https://platform.openai.com/docs/deprecations',
              quote: 'Clean official deprecation quote.',
              conclusion: 'Clean conclusion summary',
              replacementModelId: `gpt-4.1-${secret}`,
              submittedVia: 'mcp',
            }),
          },
        ];

        for (const [secretLabel, secretValue] of primarySecrets) {
          for (const fb of fieldBuilders) {
            let caught: unknown;
            try {
              appendResearchEvidence(ctx.stateDir, fb.build(secretValue));
            } catch (err) {
              caught = err;
            }
            const tag = `${secretLabel} in ${fb.fieldName}`;
            expect(caught, tag).toBeInstanceOf(ResearchValidationError);
            const validationErr = caught as ResearchValidationError;
            expect(validationErr.code, tag).toBe('SECRET_DETECTED_IN_EVIDENCE');
            expect(validationErr.message, tag).not.toContain(secretValue);
            expect(fs.readdirSync(ctx.stateDir), tag).toEqual([]);
          }
        }
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-4: enforces weekly research session cap at 5/5 (rejects s-6 and omitted sessionId with WEEKLY_RESEARCH_CAP_EXCEEDED and unchanged SHA-256) and honors maxWeeklyResearchSessions: 0 (kills M6)',
    () => {
      const ctx = createCoreSandbox();
      try {
        const w48Ms = Date.parse('2026-11-25T12:00:00.000Z'); // 2026-W48
        for (let i = 1; i <= 5; i++) {
          appendResearchEvidence(ctx.stateDir, {
            provider: 'openai',
            modelId: `gpt-4-legacy-${i}`,
            verdict: 'deprecated',
            url: 'https://platform.openai.com/docs/deprecations',
            quote: `Deprecation row ${i}`,
            submittedAt: '2026-11-25T12:00:00.000Z',
            submittedVia: 'mcp',
          });
          recordResearchSessionActivity(ctx.stateDir, {
            sessionId: `s-${i}`,
            source: 'mcp',
            nowMs: w48Ms + i * 1000,
            maxWeeklyResearchSessions: 5,
            submittedPayload: `{"i":${i}}`,
            returnedPayload: '{"accepted":true}',
            findingsDelta: 1,
          });
        }

        const budgetAtCap = computeWeeklyResearchBudget(ctx.stateDir, {
          nowMs: w48Ms,
          maxWeeklyResearchSessions: 5,
        });
        expect(budgetAtCap.isoWeek).toBe('2026-W48');
        expect(budgetAtCap.usedSessions).toBe(5);
        expect(budgetAtCap.remainingSessions).toBe(0);
        expect(budgetAtCap.budgetExceeded).toBe(true);

        const evidencePath = path.join(ctx.stateDir, 'research-evidence.json');
        const costPath = path.join(ctx.stateDir, 'cost-ledger.json');
        const evShaBefore = sha256File(evidencePath);
        const costShaBefore = sha256File(costPath);

        // 6th call with explicit sessionId: 's-6' -> rejected
        expect(() =>
          assertWeeklyResearchSessionAllowed(ctx.stateDir, {
            sessionId: 's-6',
            nowMs: w48Ms + 10_000,
            maxWeeklyResearchSessions: 5,
          })
        ).toThrowError(
          expect.objectContaining({
            name: 'CostBudgetError',
            code: 'WEEKLY_RESEARCH_CAP_EXCEEDED',
          })
        );

        // 6th call with sessionId omitted -> rejected
        expect(() =>
          recordResearchSessionActivity(ctx.stateDir, {
            source: 'mcp',
            nowMs: w48Ms + 11_000,
            maxWeeklyResearchSessions: 5,
            submittedPayload: '{}',
            returnedPayload: '{}',
          })
        ).toThrowError(CostBudgetError);

        expect(sha256File(evidencePath)).toBe(evShaBefore);
        expect(sha256File(costPath)).toBe(costShaBefore);

        // Separate empty stateDir with maxWeeklyResearchSessions: 0
        const zeroCapDir = path.join(ctx.rootDir, 'zero-cap-state');
        fs.mkdirSync(zeroCapDir, { recursive: true });
        const zeroBudget = computeWeeklyResearchBudget(zeroCapDir, {
          nowMs: w48Ms,
          maxWeeklyResearchSessions: 0,
        });
        expect(zeroBudget.budgetExceeded).toBe(true);
        expect(() =>
          assertWeeklyResearchSessionAllowed(zeroCapDir, {
            sessionId: 's-1',
            nowMs: w48Ms,
            maxWeeklyResearchSessions: 0,
          })
        ).toThrowError(expect.objectContaining({ code: 'WEEKLY_RESEARCH_CAP_EXCEEDED' }));
        expect(fs.readdirSync(zeroCapDir)).toEqual([]);
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );

  it(
    'F5-5: reuses sessionId within 2026-W48 as 1 session, deduplicates unconsumed findings while appending after consumedAt !== null, and rejects cross-week sessionId replay in 2026-W49 at 5/5 (kills M7)',
    () => {
      const ctx = createCoreSandbox();
      try {
        const w48Ms = Date.parse('2026-11-25T12:00:00.000Z'); // 2026-W48
        const w49Ms = Date.parse('2026-12-02T12:00:00.000Z'); // 2026-W49

        // 1) Same sessionId 's-1' in 2026-W48 across 2 models -> usedSessions === 1, toolCallsCount === 2, findingsSubmitted === 2
        appendResearchEvidence(ctx.stateDir, {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'First model retired.',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          submittedAt: '2026-11-25T12:00:00.000Z',
          submittedVia: 'mcp',
        });
        recordResearchSessionActivity(ctx.stateDir, {
          sessionId: 's-1',
          source: 'mcp',
          nowMs: w48Ms,
          maxWeeklyResearchSessions: 5,
          submittedPayload: '{"m":1}',
          returnedPayload: '{"ok":true}',
          findingsDelta: 1,
        });

        appendResearchEvidence(ctx.stateDir, {
          provider: 'anthropic',
          modelId: 'claude-3-sonnet-20240229',
          verdict: 'deprecated',
          url: 'https://docs.anthropic.com/en/docs/resources/model-deprecations',
          quote: 'Second model retired.',
          shutdownDate: '2026-07-21',
          pricingTier: 'paid',
          submittedAt: '2026-11-25T12:01:00.000Z',
          submittedVia: 'mcp',
        });
        const s1Entry = recordResearchSessionActivity(ctx.stateDir, {
          sessionId: 's-1',
          source: 'mcp',
          nowMs: w48Ms + 60_000,
          maxWeeklyResearchSessions: 5,
          submittedPayload: '{"m":2}',
          returnedPayload: '{"ok":true}',
          findingsDelta: 1,
        });

        const w48Budget = computeWeeklyResearchBudget(ctx.stateDir, {
          nowMs: w48Ms + 60_000,
          maxWeeklyResearchSessions: 5,
        });
        expect(w48Budget.isoWeek).toBe('2026-W48');
        expect(w48Budget.usedSessions).toBe(1);
        expect(s1Entry.toolCallsCount).toBe(2);
        expect(s1Entry.findingsSubmitted).toBe(2);

        // 2) Deduplication check in isolated sub-dir: unconsumed duplicates in-place vs consumed appends fresh
        const dedupDir = path.join(ctx.rootDir, 'dedup-state');
        fs.mkdirSync(dedupDir, { recursive: true });
        appendResearchEvidence(dedupDir, {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'Initial quote v1',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          submittedAt: '2026-11-25T12:00:00.000Z',
          submittedVia: 'mcp',
        });
        appendResearchEvidence(dedupDir, {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'Updated quote v2 while unconsumed',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          submittedAt: '2026-11-25T12:02:00.000Z',
          submittedVia: 'mcp',
        });
        const afterUnconsumedDup = loadResearchEvidence(dedupDir);
        expect(afterUnconsumedDup).toHaveLength(1);
        expect(afterUnconsumedDup[0]?.quote).toBe('Updated quote v2 while unconsumed');

        // Mark existing record consumedAt !== null, then submit again -> appends fresh record (length === 2)
        saveResearchEvidence(dedupDir, [
          { ...afterUnconsumedDup[0]!, consumedAt: '2026-11-25T12:05:00.000Z' },
        ]);
        appendResearchEvidence(dedupDir, {
          provider: 'openai',
          modelId: 'gpt-4.5-preview',
          verdict: 'deprecated',
          url: 'https://platform.openai.com/docs/deprecations',
          quote: 'Fresh quote v3 after prior consumption',
          shutdownDate: '2026-07-14',
          pricingTier: 'paid',
          submittedAt: '2026-11-25T12:10:00.000Z',
          submittedVia: 'mcp',
        });
        const afterConsumedAppend = loadResearchEvidence(dedupDir);
        expect(afterConsumedAppend).toHaveLength(2);
        expect(afterConsumedAppend[0]?.consumedAt).toBeNull();
        expect(afterConsumedAppend[1]?.consumedAt).toBe('2026-11-25T12:05:00.000Z');

        // 3) Cross-week replay: in 2026-W49, fill w49-1..w49-5 (5/5), then replay 's-1' from 2026-W48 -> REJECTED! (kills M7)
        for (let i = 1; i <= 5; i++) {
          recordResearchSessionActivity(ctx.stateDir, {
            sessionId: `w49-${i}`,
            source: 'mcp',
            nowMs: w49Ms + i * 1000,
            maxWeeklyResearchSessions: 5,
            submittedPayload: '{}',
            returnedPayload: '{}',
            findingsDelta: 1,
          });
        }

        const costPath = path.join(ctx.stateDir, 'cost-ledger.json');
        const costShaW49Before = sha256File(costPath);
        const sessionsCountBefore = readCostLedgerReadOnly(ctx.stateDir).researchSessions.length;

        expect(() =>
          assertWeeklyResearchSessionAllowed(ctx.stateDir, {
            sessionId: 's-1',
            nowMs: w49Ms + 30_000,
            maxWeeklyResearchSessions: 5,
          })
        ).toThrowError(expect.objectContaining({ code: 'WEEKLY_RESEARCH_CAP_EXCEEDED' }));

        expect(sha256File(costPath)).toBe(costShaW49Before);
        expect(readCostLedgerReadOnly(ctx.stateDir).researchSessions).toHaveLength(
          sessionsCountBefore
        );
      } finally {
        ctx.cleanup();
      }
    },
    60_000
  );
});
