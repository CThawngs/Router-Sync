/**
 * packages/cli/test/verify.test.ts
 *
 * Unit and integration tests for Round C4c1:
 *  - A1/I6: loadRankingConfig throws on invalid YAML / root
 *  - A2: Live price separation (payload keys from cache, live-price makes single GET)
 *  - A4: Word-boundary matching for L3 notices (prevents cross-model deprecation leaks)
 *  - A5: absenceCount >= 2 required for ĐÃ-XÁC-NHẬN-NGỪNG (single absence returns NGHI-NGỪNG)
 *  - A6: NEW-CANDIDATE blacklist filtering, SẮP-NGỪNG/QUOTA exclusion, real evidenceUrl
 *  - A7: Retains absenceCounts past grace cycles for ABSENT-STABLE F4, combo shrink check
 *  - A8: Research submit schema validation, untrusted evidence, zero router writes, inbox ack/snooze
 *  - A9: 15-minute gate yields 0 requests on second tick, 401 AUTH_ERROR alert
 *  - A3: CLI verify command with 3 layers and accounting
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';

const hoisted = vi.hoisted(() => ({
  mockComboData: [] as Array<{ id: string; name: string; models: string[] }>,
}));

// Mock router DB reads so tick can compute comboStepCount/dropCount without a
// real sqlite database (node:sqlite is not resolvable in vitest here).
vi.mock('@routersync/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@routersync/daemon')>();
  return {
    ...actual,
    readRouterCombos: () => ({
      ok: true,
      exists: true,
      dbPath: 'mocked',
      data: hoisted.mockComboData,
    }),
  };
});

// G1: Mock config loader and sync-plan so tick runs on empty-env CI with
// node-b and groq targets (apiKey: 'test-key') instead of real router config.
vi.mock('../src/config/loader.js', () => ({
  loadConfigFile: () => ({
    config: { version: 1, routers: [], combos: [], adopt: [] },
    filePath: 'mocked-config.yaml',
  }),
}));
vi.mock('../src/commands/sync/sync-plan.js', () => ({
  buildViews: async () => [
    {
      name: '9router',
      targets: [
        { id: 'node-b', label: 'node-b', prefix: 'node-b', baseUrl: 'https://node-b.example.com/v1', apiKey: 'test-key', keySource: 'none' },
        { id: 'groq', label: 'groq', prefix: 'groq', baseUrl: 'https://groq.example.com/v1', apiKey: 'test-key', keySource: 'none' },
      ],
      combos: [],
    },
  ],
  printTargets: () => {},
}));
import * as path from 'node:path';
import * as os from 'node:os';
import {
  classifyVerificationLabel,
  evaluateAbsentStable,
  evaluateNewCandidateProposals,
  isZeroPriceHidden,
  runL2Scan,
  runL3Scan,
  runVerifyPhase,
} from '../src/verify/index.js';
import { runVerifyCommand } from '../src/commands/verify.js';
import { runTickCommand } from '../src/commands/tick.js';
import { runRankCommand } from '../src/commands/rank.js';
import { runInboxCommand, loadInboxState } from '../src/commands/inbox.js';
import { runResearchCommand } from '../src/commands/research.js';
import { loadRankingConfig, getDefaultRankingConfigPath, getRankingExamplePath } from '../src/rank/config.js';
import { queryLivePrice, resolveBasePrice } from '../src/commands/dead-models.js';
import { openBetterSqlite3 } from '@routersync/core';

describe('Round C4c1 Verification Engine & Wire-Up', () => {
  describe('A1/I6: Ranking Config Error Handling', () => {
    it('throws descriptive error on invalid YAML syntax in ranking.yaml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-err-'));
      const badYamlPath = path.join(tmpDir, 'ranking.yaml');
      try {
        fs.writeFileSync(badYamlPath, 'version: 1\nblacklist: [unclosed array\n', 'utf8');
        expect(() => loadRankingConfig(badYamlPath)).toThrow(/Failed to parse ranking\.yaml/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws error when ranking.yaml root is a list rather than an object', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-err-'));
      const badYamlPath = path.join(tmpDir, 'ranking.yaml');
      try {
        fs.writeFileSync(badYamlPath, '- item1\n- item2\n', 'utf8');
        expect(() => loadRankingConfig(badYamlPath)).toThrow(/expected YAML mapping object/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('ships ranking.example.yaml as a valid neutral policy (E3)', () => {
      const examplePath = getRankingExamplePath();
      expect(fs.existsSync(examplePath)).toBe(true);
      const { config, isDefault } = loadRankingConfig(examplePath);
      expect(isDefault).toBe(false);
      expect(config.blacklist.length).toBeGreaterThan(0);
      expect(config.blacklist.length).toBeLessThanOrEqual(5);
      expect(config.blacklist.every((entry) => typeof entry === 'string')).toBe(true);
      expect(Object.keys(config.tierRules)).toHaveLength(8);
      expect(config.modelScores).toStrictEqual([]);
      expect(config.excludeCombos).toStrictEqual([]);
    });

    it('prints copy guidance and flags isDefault when the policy file is missing (E3)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-missing-'));
      const missingPath = path.join(tmpDir, 'nested', 'ranking.yaml');
      const writes: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const res = loadRankingConfig(missingPath);
        expect(res.isDefault).toBe(true);
        expect(res.sourcePath).toBe(path.resolve(missingPath));
        const guidance = writes.join('');
        expect(guidance).toContain('No ranking policy file at');
        expect(guidance).toContain('ranking.example.yaml');
        expect(guidance).toContain('routersync\\ranking.yaml');
        expect(guidance).toContain('every write path refuses');
      } finally {
        process.stderr.write = origWrite;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('resolves the default policy path per platform (E3)', () => {
      const resolved = getDefaultRankingConfigPath();
      expect(path.basename(resolved)).toBe('ranking.yaml');
      expect(path.basename(path.dirname(resolved))).toBe('routersync');
      if (process.platform === 'win32') {
        expect(resolved.toLowerCase()).toContain('appdata');
      } else {
        expect(resolved).toContain(path.join(os.homedir(), '.config'));
      }
    });
  });

  describe('A2: Live Price vs Cache Payload Keys', () => {
    it('queryLivePrice performs single live GET without using token completions', async () => {
      let fetchCount = 0;
      let requestedUrl = '';
      const mockFetch: typeof fetch = async (input) => {
        fetchCount++;
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          data: [
            { id: 'deepseek-v4-flash', pricing: { prompt: 0.0001, completion: 0.0002 } }
          ]
        }), { status: 200 });
      };

      // "groq" is a public provider and is one of the mocked scan targets, so
      // this test needs no router database and runs on a clean CI machine.
      const res = await queryLivePrice('groq', 'deepseek-v4-flash', mockFetch);
      expect(fetchCount).toBe(1);
      expect(requestedUrl).toContain('/models');
      expect(res.found).toBe(true);
      expect(res.isFree).toBe(false);
      expect(res.promptPrice).toBe(0.0001);
    });

    it('active_time_window with value does not overwrite stored base', () => {
      const storedBase = { input: 7800, output: 31200, fetchedAt: '2026-11-10T12:00:00.000Z' };
      const currentObs = {
        inputPrice: 0,
        outputPrice: 0,
        activeTimeWindow: { start_time: '00:00', end_time: '08:00' },
        fetchedAt: '2026-11-11T02:00:00.000Z',
      };
      const res = resolveBasePrice(currentObs, storedBase);
      expect(res.input).toBe(7800);
      expect(res.output).toBe(31200);
      expect(res.fetchedAt).toBe('2026-11-10T12:00:00.000Z');
    });

    it('active_time_window=null is recorded as base', () => {
      const storedBase = { input: 5000, output: 20000, fetchedAt: '2026-11-09T10:00:00.000Z' };
      const currentObs = {
        inputPrice: 7800,
        outputPrice: 31200,
        activeTimeWindow: null,
        fetchedAt: '2026-11-11T14:00:00.000Z',
      };
      const res = resolveBasePrice(currentObs, storedBase);
      expect(res.input).toBe(7800);
      expect(res.output).toBe(31200);
      expect(res.fetchedAt).toBe('2026-11-11T14:00:00.000Z');
    });
  });

  describe('A4 & A5: Canonical Verification Labels & Word-Boundary Matching', () => {
    it('A5: assigns NGHI-NGỪNG on single absence even if deprecation notice exists', () => {
      const label = classifyVerificationLabel(
        { exists: false, status: 404, absenceCount: 1 },
        { exists: false },
        { hasNotice: true, noticeType: 'deprecated' },
        true
      );
      expect(label).toBe('NGHI-NGỪNG');
    });

    it('A5: assigns ĐÃ-XÁC-NHẬN-NGỪNG when absenceCount >= 2 with deprecation notice', () => {
      const label = classifyVerificationLabel(
        { exists: false, status: 404, absenceCount: 2 },
        { exists: false },
        { hasNotice: true, noticeType: 'deprecated' },
        true
      );
      expect(label).toBe('ĐÃ-XÁC-NHẬN-NGỪNG');
    });

    it('B4: assigns CHƯA-QUÉT when provider is unscanned or skipped', () => {
      const label = classifyVerificationLabel(
        { exists: false, status: 0, absenceCount: 0, isUnscanned: true, unscannedReason: 'chưa-quét' },
        { exists: false },
        { hasNotice: false },
        false
      );
      expect(label).toBe('CHƯA-QUÉT');
    });

    it('B4: assigns QUOTA-NO-LIST when list endpoint returns 429 and model absent', () => {
      const label = classifyVerificationLabel(
        { exists: false, status: 429, absenceCount: 1 },
        { exists: false },
        { hasNotice: false },
        true
      );
      expect(label).toBe('QUOTA-NO-LIST');
    });

    it('B4: PROVIDER_ALIASES maps hf to huggingface and gemini to google', async () => {
      const { PROVIDER_ALIASES } = await import('../src/verify/l2-scanner.js');
      expect(PROVIDER_ALIASES['hf']).toBe('huggingface');
      expect(PROVIDER_ALIASES['gemini']).toBe('google');
      expect(PROVIDER_ALIASES['huggingface']).toBe('hf');
      expect(PROVIDER_ALIASES['google']).toBe('gemini');
    });

    it('B6: registry/gateways.yaml contains gateways without single GET', () => {
      const gPath = path.resolve(__dirname, '../../../registry/gateways.yaml');
      expect(fs.existsSync(gPath)).toBe(true);
      const content = fs.readFileSync(gPath, 'utf8');
      expect(content).toContain('openrouter');
      expect(content).toContain('models-dev');
      expect(content).toContain('hasSingleModelGet: false');
    });

    it('A4: word-boundary matching prevents cross-model deprecation notice leaks', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-l3-leak-'));
      try {
        // Notice applies to "claude-2.0", not "claude-2.0-custom-v2" or "claude-2.0.1"
        const mockFetch: typeof fetch = async () => {
          return new Response(`
            <h1>Deprecation Notice: claude-2.0 is retired</h1>
          `, { status: 200 });
        };

        const res = await runVerifyPhase({
          stateDir: tmpDir,
          nowMs: 1731300000000,
          fetchFn: mockFetch,
          models: [
            { id: 'claude-2.0', prefix: 'anthropic', l1Exists: true, l1Status: 200, absenceCount: 0 },
            { id: 'claude-2.0-custom-v2', prefix: 'anthropic', l1Exists: true, l1Status: 200, absenceCount: 0 },
          ],
        });

        const c2 = res.records.find((r) => r.id === 'claude-2.0');
        const c2Custom = res.records.find((r) => r.id === 'claude-2.0-custom-v2');

        // claude-2.0 has notice -> SẮP-NGỪNG or ĐÃ-XÁC-NHẬN-NGỪNG
        expect(c2?.l3.hasNotice).toBe(true);
        // claude-2.0-custom-v2 MUST NOT match the claude-2.0 notice
        expect(c2Custom?.l3.hasNotice).toBe(false);
        expect(c2Custom?.label).toBe('ĐÃ-XÁC-NHẬN-CÒN');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('A6: NEW-CANDIDATE Proposals Blacklist & Label Exclusions', () => {
    it('excludes models matching blacklist patterns in ranking.yaml', () => {
      const candidates = [
        { id: 'deepseek-v4-pro', prefix: 'deepseek' }, // blacklisted
        { id: 'space-bunny-7b', prefix: 'test' },       // blacklisted
        { id: 'gemini-2.0-flash', prefix: 'google' },    // valid
      ];
      const combos = [
        { name: 'omni-combo', router: 'omniroute', models: ['google/gemini-1.5-flash'] },
      ];

      const proposals = evaluateNewCandidateProposals(
        candidates,
        combos,
        [],
        ['deepseek-v4-pro', 'space-bunny']
      );

      expect(proposals.length).toBe(1);
      expect(proposals[0]?.fullStep).toBe('google/gemini-2.0-flash');
      expect(proposals[0]?.evidenceUrl).toBeNull();
    });

    it('excludes models with label SẮP-NGỪNG or QUOTA from candidate proposals', () => {
      const candidates = [
        { id: 'model-quota', prefix: 'test', label: 'QUOTA' },
        { id: 'model-retiring', prefix: 'test', label: 'SẮP-NGỪNG' },
        { id: 'model-clean', prefix: 'test', label: 'ĐÃ-XÁC-NHẬN-CÒN' },
      ];
      const combos = [
        { name: 'test-combo', router: '9router', models: ['test/model-orig'] },
      ];

      const proposals = evaluateNewCandidateProposals(candidates, combos, []);
      expect(proposals.length).toBe(1);
      expect(proposals[0]?.fullStep).toBe('test/model-clean');
    });

    it('does not classify models with ẨN-GIÁ-0 as free in proposals', () => {
      const candidates = [
        {
          id: 'pulse-alpha',
          prefix: 'ocz',
          pricing: { prompt: 0, completion: 0 },
          isZeroPriceHidden: true,
        },
      ];
      const combos = [{ name: 'combo-1', router: '9router', models: ['ocz/pulse-old'] }];
      const proposals = evaluateNewCandidateProposals(candidates, combos, []);

      expect(proposals[0]?.pricing?.free).toBe(false);
      expect(proposals[0]?.pricing?.isZeroPriceHidden).toBe(true);
    });
  });

  describe('A7: ABSENT-STABLE Evaluation & Absence Retention', () => {
    const nowMs = 1731300000000;

    it('approves ABSENT-STABLE when absent >= 3 cycles, >= 24h, and shrink ratio within limits', () => {
      const res = evaluateAbsentStable({
        id: 'node-b-ghost-v1',
        prefix: 'node-b',
        absenceCount: 3,
        firstAbsentAtMs: nowMs - 25 * 3600 * 1000,
        nowMs,
        lastLabel: 'ABSENT',
        l2ExternalExists: false,
        providerCoveredByExternal: true,
        comboStepCount: 15,
        dropCount: 1, // 1/15 = 6.7% <= 10%
      });

      expect(res.isAbsentStable).toBe(true);
      expect(res.canAutoRemove).toBe(true);
    });

    it('rejects ABSENT-STABLE if shrink ratio exceeds 10%', () => {
      const res = evaluateAbsentStable({
        id: 'node-b-ghost-v1',
        prefix: 'node-b',
        absenceCount: 3,
        firstAbsentAtMs: nowMs - 25 * 3600 * 1000,
        nowMs,
        lastLabel: 'ABSENT',
        l2ExternalExists: false,
        providerCoveredByExternal: true,
        comboStepCount: 5,
        dropCount: 1, // 1/5 = 20% > 10%
      });

      expect(res.isAbsentStable).toBe(false);
      expect(res.reasons.some((r) => r.includes('Hạn mức co rút'))).toBe(true);
    });
  });

  describe('A8: Research Submission & Inbox Management', () => {
    it('research submit validates schema, truncates snippet to <= 300, and does zero router writes', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-research-submit-'));
      const testJson = path.join(tmpDir, 'research-evidence.json');
      const longSnippet = 'A'.repeat(500);

      fs.writeFileSync(
        testJson,
        JSON.stringify({
          id: 'test-provider/test-model',
          conclusion: 'ĐÃ-NGỪNG-HOÀN-TOÀN',
          url: 'https://official-docs.example.com/deprecations',
          snippet: longSnippet,
          accessedAt: '2026-11-11',
        }),
        'utf8'
      );

      try {
        await runResearchCommand({
          subcommand: 'submit',
          file: testJson,
          stateDir: tmpDir,
        });

        const storedEvidence = JSON.parse(
          fs.readFileSync(path.join(tmpDir, 'research-evidence.json'), 'utf8')
        );
        expect(storedEvidence.length).toBe(1);
        expect(storedEvidence[0].id).toBe('test-provider/test-model');
        expect(storedEvidence[0].snippet.length).toBe(300);
        expect(storedEvidence[0].untrusted).toBe(true);

        const inbox = loadInboxState(path.join(tmpDir, 'inbox.json'));
        expect(inbox.items.length).toBe(1);
        expect(inbox.items[0]?.title).toContain('[RESEARCH-SUBMIT]');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('research submit rejects invalid schema with missing URL or ID', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-research-bad-'));
      const testJson = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(testJson, JSON.stringify({ id: '', conclusion: 'test' }), 'utf8');

      try {
        await expect(
          runResearchCommand({ subcommand: 'submit', file: testJson, stateDir: tmpDir })
        ).rejects.toThrow(/Schema validation error/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('inbox list, ack, and snooze manage items without router writes', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-inbox-ops-'));
      const inboxPath = path.join(tmpDir, 'inbox.json');
      fs.writeFileSync(
        inboxPath,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          items: [
            { id: 'item-1', title: 'Proposal 1', type: 'proposal', timestamp: new Date().toISOString(), body: 'Test' },
            { id: 'item-2', title: 'Warning 2', type: 'warning', timestamp: new Date().toISOString(), body: 'Warn' },
          ],
        }),
        'utf8'
      );

      try {
        await runInboxCommand({ action: 'ack', id: 'item-1', stateDir: tmpDir });
        let st = loadInboxState(inboxPath);
        const item1 = st.items.find((i) => i.id === 'item-1');
        expect(item1?.status).toBe('acknowledged');

        await runInboxCommand({ action: 'snooze', id: 'item-2', days: 3, stateDir: tmpDir });
        st = loadInboxState(inboxPath);
        const item2 = st.items.find((i) => i.id === 'item-2');
        expect(item2?.status).toBe('snoozed');
        expect(item2?.snoozeUntil).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('A9 & A3: Tick Idempotency, 15m Gate, and Unified Accounting', () => {
    // C4h H3: the blacklist comes from a real ranking.yaml in a temp config
    // dir, so the real loader is exercised (no module mock) and the policy is
    // identical on every machine.
    let policyTmpDir = '';
    let savedAppData: string | undefined;
    let savedXdgConfigHome: string | undefined;

    beforeAll(() => {
      policyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-policy-'));
      const policyDir = path.join(policyTmpDir, 'routersync');
      fs.mkdirSync(policyDir, { recursive: true });
      fs.writeFileSync(
        path.join(policyDir, 'ranking.yaml'),
        ['version: 1', 'blacklist:', '  - deepseek-v4-pro', ''].join('\n'),
        'utf8'
      );
      savedAppData = process.env['APPDATA'];
      savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
      process.env['APPDATA'] = policyTmpDir;
      process.env['XDG_CONFIG_HOME'] = policyTmpDir;
    });

    afterAll(() => {
      if (savedAppData === undefined) delete process.env['APPDATA'];
      else process.env['APPDATA'] = savedAppData;
      if (savedXdgConfigHome === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = savedXdgConfigHome;
      fs.rmSync(policyTmpDir, { recursive: true, force: true });
    });

    it('second tick run within 15 minutes yields 0 requests and UNCHANGED', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-gate-'));
      try {
        let fetchCalls = 0;
        const mockFetch: typeof fetch = async (input) => {
          const u = String(input);
          if (u.includes('models.dev') || u.includes('openrouter')) {
            return new Response(JSON.stringify({}), { status: 200 });
          }
          fetchCalls++;
          return new Response(
            JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
            { status: 200, headers: { etag: '"real-server-etag-1"' } }
          );
        };

        // Tick 1: performs scan
        const tick1 = await runTickCommand({
          stateDir: tmpDir,
          fetchFn: mockFetch,
          nowMs: 1731300000000,
        });

        expect(tick1.requests).toBeGreaterThanOrEqual(0);
        expect(fs.existsSync(path.join(tmpDir, 'verify-status.json'))).toBe(true);
        const callsAfterTick1 = fetchCalls;

        // Tick 2 (10 seconds later): 15-minute gate MUST skip all provider GET calls
        const tick2 = await runTickCommand({
          stateDir: tmpDir,
          fetchFn: mockFetch,
          nowMs: 1731300000000 + 10_000,
        });

        // Provider requests MUST be 0
        expect(fetchCalls).toBe(callsAfterTick1);
        expect(tick2.requests).toBe(0);
        expect(tick2.unchangedProviders).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('records AUTH_ERROR and alerts inbox when provider returns HTTP 401', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-401-'));
      try {
        const mockFetch: typeof fetch = async (input) => {
          const u = String(input);
          if (u.includes('models.dev') || u.includes('openrouter')) {
            return new Response(JSON.stringify({}), { status: 200 });
          }
          return new Response('Unauthorized: bad key', { status: 401 });
        };

        const res = await runTickCommand({
          stateDir: tmpDir,
          fetchFn: mockFetch,
          nowMs: 1731300000000,
          mode: 'propose',
        });

        const authErrors = res.providers.filter((p) => p.label === 'AUTH_ERROR');
        expect(authErrors.length).toBeGreaterThan(0);

        const inbox = loadInboxState(path.join(tmpDir, 'inbox.json'));
        const authAlert = inbox.items.find((i) => i.label === 'AUTH_ERROR');
        expect(authAlert).toBeDefined();
        expect(authAlert?.title).toContain('AUTH_ERROR');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    const dayMs = 24 * 3600 * 1000;
    // nowMs computed from year 2026, not 2024
    const nowMs2026 = new Date('2026-01-01T00:00:00Z').getTime();

    // E8: tick runs verify phase across 3 cycles (>=24h apart), generates one
    // hash-free <provider>/<model>/ABSENT-STABLE inbox item, does not re-add on 4th cycle.
    it('E8: tick generates ABSENT-STABLE across 3 cycles (>=24h) and does not re-add after 4th cycle', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-e8-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        const missingId = 'node-b-missing-model';
        const fullStep = `node-b/${missingId}`;
        const baseIso = new Date(nowMs2026).toISOString();

        // catalog does NOT contain missingId (it is absent). Combo lists 10 models
        // INCLUDING missingId so comboStepCount=10, shrink = 1 missingId / 10 =
        // 10% (<= 10%) → shrink guard allows ABSENT-STABLE. Since missingId is a
        // used step, the `continue` in the ABSENT-STABLE branch skips the
        // ABSENT-UNCONFIRMED fallback.
        const otherIds = Array.from({ length: 9 }, (_, i) => `node-b-other-${i}`);
        const comboModels = [fullStep, ...otherIds.map((id) => `node-b/${id}`)];
        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: comboModels }];

        // Pre-warm: missingId absent for 1 cycle already (count=2, firstAbsentAt 25h ago)
        const oneDayAgoIso = new Date(nowMs2026 - 25 * 3600 * 1000).toISOString();
        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1,
          updatedAt: baseIso,
          providers: {
            'node-b': {
              prefix: 'node-b',
              router: '9router',
              ids: otherIds, // missingId deliberately absent
              absenceCounts: { [missingId]: 2 },
              firstAbsentAt: { [missingId]: oneDayAgoIso },
              hash: 'h-prev',
              updatedAt: baseIso,
            },
          },
        }, null, 2), 'utf8');

        // fetchFn deliberately omits missingId in every cycle (keeps the other 9)
        const mockFetch: typeof fetch = async () =>
          new Response(JSON.stringify({ data: otherIds.map((id) => ({ id })) }), { status: 200 });

        // Cycle 1: count reaches 3 -> inbox gains an item with hash-free id
        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });

        const inboxPath = path.join(tmpDir, 'inbox.json');
        const inboxState = loadInboxState(inboxPath);
        // Exactly 1 ABSENT-STABLE item with hash-free id
        const absentStableItems = inboxState.items.filter((i) => i.label === 'ABSENT-STABLE');
        expect(absentStableItems.length).toBe(1);
        expect(absentStableItems[0]?.id).toBe('absent-stable-node-b-node-b-missing-model');
        for (const item of inboxState.items) {
          expect(item.id).not.toMatch(/[0-9a-f]{32,}/); // no long hex hash in id
        }
        const beforeCount = inboxState.items.length;

        // Cycle 2: run again, idempotent (not re-creating the same item)
        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026 + dayMs, mode: 'propose' });
        const inboxAfter2 = loadInboxState(inboxPath);
        expect(inboxAfter2.items.length).toBe(beforeCount);
        expect(inboxAfter2.items.filter((i) => i.label === 'ABSENT-STABLE').length).toBe(1);

        // verify-status.json written
        expect(fs.existsSync(path.join(tmpDir, 'verify-status.json'))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // E9: F4 bulk-drop cap on node-b (94 -> 69) via tick, no ABSENT-STABLE created when >10% shrink.
    it('E9: node-b 94->69 bulk drop capped; no ABSENT-STABLE created when shrink > 10%', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-e9-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        const ids94 = Array.from({ length: 94 }, (_, i) => `node-b-model-${i}`);
        const ids69 = ids94.slice(0, 69); // drop 25 = 26.6% > 10% cap
        const baseIso = new Date(nowMs2026).toISOString();

        const absentIds = ids94.slice(69); // 25 dropped models (indices 69-93)
        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: ids94.map((id) => `node-b/${id}`) }];

        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1,
          updatedAt: baseIso,
          providers: {
            'node-b': {
              prefix: 'node-b',
              router: '9router',
              ids: ids94,
              absenceCounts: {},
              firstAbsentAt: {},
              hash: 'h-prev',
              updatedAt: baseIso,
            },
          },
        }, null, 2), 'utf8');

        const mockFetch: typeof fetch = async () =>
          new Response(JSON.stringify({ data: ids69.map((id) => ({ id })) }), { status: 200 });

        // Pre-warm absence counts to >= 3 and firstAbsentAt >= 25h for absent models
        const warmCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        const twentyFiveHoursAgo = new Date(nowMs2026 - 25 * 3600 * 1000).toISOString();
        for (const id of absentIds) {
          warmCatalog.providers['node-b'].absenceCounts[id] = 3;
          warmCatalog.providers['node-b'].firstAbsentAt[id] = twentyFiveHoursAgo;
        }
        fs.writeFileSync(catalogPath, JSON.stringify(warmCatalog, null, 2), 'utf8');

        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });

        const inboxPath = path.join(tmpDir, 'inbox.json');
        const inboxState = loadInboxState(inboxPath);
        // No ABSENT-STABLE items created because shrink > 10% blocks removal
        const absentStableItems = inboxState.items.filter((i) => i.label === 'ABSENT-STABLE');
        expect(absentStableItems.length).toBe(0);

        // Tick status.json must record the >10% shrink block reason (from evaluateAbsentStable)
        const status = JSON.parse(fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf8'));
        const shrinkReasons = status.shrinkBlockReasons ?? {};
        const nodeBReasons = shrinkReasons['node-b'] ?? [];
        expect(nodeBReasons.length).toBeGreaterThan(0);
        expect(nodeBReasons.some((r: string) => r.includes('Hạn mức co rút') || r.includes('shrinkRatio'))).toBe(true);

        // Cycle 2: no new ABSENT-STABLE either (idempotent, not re-creating)
        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026 + dayMs, mode: 'propose' });
        const inboxAfter2 = loadInboxState(inboxPath);
        expect(inboxAfter2.items.filter((i) => i.label === 'ABSENT-STABLE').length).toBe(0);

        // sanity: node-b catalog entry retained (69 fetched, 25 dropped from catalog)
        const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        expect(cat.providers['node-b'].ids.length).toBe(69);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // E10: 7-day absence pruning via tick: groq provider, stale id pruned after >7d.
    it('E10: tick prunes absenceCounts older than 7 days for groq', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-e10-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        const staleId = 'stale-untracked-model-7d';
        const baseIso = new Date(nowMs2026).toISOString();

        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1,
          updatedAt: baseIso,
          providers: {
            groq: {
              prefix: 'groq',
              router: '9router',
              ids: ['llama-3.3-70b-versatile'],
              absenceCounts: { [staleId]: 5 },
              firstAbsentAt: { [staleId]: new Date(nowMs2026 - 8 * dayMs).toISOString() },
              hash: 'h-prev',
              updatedAt: baseIso,
            },
          },
        }, null, 2), 'utf8');

        // groq is still present in catalog response (not missing)
        await runTickCommand({
          stateDir: tmpDir,
          fetchFn: async () => new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200 }),
          nowMs: nowMs2026,
          mode: 'propose',
        });

        const state = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        // groq provider exists in catalog
        expect(state.providers.groq).toBeDefined();
        // stale id (>7d) pruned from absenceCounts and firstAbsentAt
        expect(state.providers.groq.absenceCounts[staleId]).toBeUndefined();
        expect(state.providers.groq.firstAbsentAt[staleId]).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // G3a: NEW-CANDIDATE blacklist filters a blacklisted id out of the inbox
    it('G3a: NEW-CANDIDATE skips blacklisted model id', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-g3a-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: ['node-b/old-1'] }];
        // Old list is NOT empty: 'old-1' is already known, so 'allowed-model'
        // and 'deepseek-v4-pro' are genuinely new and go through the filter.
        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1, updatedAt: new Date(nowMs2026).toISOString(),
          providers: { 'node-b': { prefix: 'node-b', router: '9router', ids: ['old-1'], absenceCounts: {}, firstAbsentAt: {}, hash: 'h-prev', updatedAt: new Date(nowMs2026).toISOString() } },
        }, null, 2), 'utf8');

        const mockFetch: typeof fetch = async (input) => {
          const data = String(input).includes('node-b')
            ? [{ id: 'old-1' }, { id: 'allowed-model' }, { id: 'deepseek-v4-pro' }]
            : [{ id: 'old-1' }];
          return new Response(JSON.stringify({ data }), { status: 200 });
        };

        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });

        const inbox = loadInboxState(path.join(tmpDir, 'inbox.json'));
        // No inbox item may mention the blacklisted id, not even the summary
        // item whose title/body lists the newly discovered models.
        const mentioning = inbox.items.filter((i) =>
          [i.id, i.title, i.body].some((v) => v.includes('deepseek-v4-pro'))
        );
        expect(mentioning).toEqual([]);
        // Exactly one combo proposal, for the non-blacklisted id.
        const comboProposals = inbox.items.filter((i) => i.id.startsWith('new-candidate-combo-'));
        expect(comboProposals.length).toBe(1);
        expect(comboProposals[0]?.id).toBe('new-candidate-combo-node-b-default-node-b-allowed-model');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // G3b: isAdded is scoped to the provider's real added IDs, so an id that
    // was already known is never proposed as a new candidate.
    it('G3b: isAdded only true for provider that actually added the model', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-g3b-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: ['node-b/old-1', 'node-b/new-model'] }];
        // Old list holds 'old-1' only, so 'new-model' is the single added id.
        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1, updatedAt: new Date(nowMs2026).toISOString(),
          providers: { 'node-b': { prefix: 'node-b', router: '9router', ids: ['old-1'], absenceCounts: {}, firstAbsentAt: {}, hash: 'h-prev', updatedAt: new Date(nowMs2026).toISOString() } },
        }, null, 2), 'utf8');

        const mockFetch: typeof fetch = async (input) => {
          const data = String(input).includes('node-b')
            ? [{ id: 'old-1' }, { id: 'new-model' }]
            : [{ id: 'old-1' }];
          return new Response(JSON.stringify({ data }), { status: 200 });
        };

        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });

        const verifyStatus = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verify-status.json'), 'utf8'));
        const proposals = verifyStatus.proposals as Array<{ id: string; fullStep: string }>;
        const steps = proposals.map((p) => p.fullStep);
        expect(steps).toContain('node-b/new-model');
        expect(steps).not.toContain('node-b/old-1');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // G3c: AUTH_ERROR id stable across two ticks (auth-error-<prefix>-<status>)
    it('G3c: AUTH_ERROR inbox id stable across two ticks', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-g3c-'));
      try {
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: [] }];
        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1, updatedAt: new Date(nowMs2026).toISOString(),
          providers: { 'node-b': { prefix: 'node-b', router: '9router', ids: [], absenceCounts: {}, firstAbsentAt: {}, hash: 'h-prev', updatedAt: new Date(nowMs2026).toISOString() } },
        }, null, 2), 'utf8');

        const mockFetch: typeof fetch = async () =>
          new Response('Unauthorized', { status: 401 });

        const tick1 = await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });
        const inbox1 = loadInboxState(path.join(tmpDir, 'inbox.json'));
        const authItem1 = inbox1.items.find((i) => i.label === 'AUTH_ERROR');
        expect(authItem1).toBeDefined();
        // id pattern: auth-error-<prefix>-401 (status-based, not timestamp-based)
        expect(authItem1?.id).toMatch(/^auth-error-.+-401$/);

        // Cycle 2: same id (status-based, not timestamp-based)
        const tick2 = await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026 + dayMs, mode: 'propose' });
        const inbox2 = loadInboxState(path.join(tmpDir, 'inbox.json'));
        const authItem2 = inbox2.items.find((i) => i.label === 'AUTH_ERROR');
        expect(authItem2).toBeDefined();
        expect(authItem1?.id).toBe(authItem2?.id);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // G3d: Inbox trimming past 200 retains unacknowledged and active-snoozed items
    it('G3d: inbox trim keeps unacknowledged and active snoozed items past 200', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tick-g3d-'));
      try {
        const inboxPath = path.join(tmpDir, 'inbox.json');
        const nowIso = new Date(nowMs2026).toISOString();
        const snoozeFuture = new Date(nowMs2026 + 10 * 24 * 3600 * 1000).toISOString();
        const items: Array<{ id: string; status?: string; snoozeUntil?: string }> = [];
        // 150 acknowledged (handled, should be trimmed first)
        for (let i = 0; i < 150; i++) items.push({ id: `ack-${i}`, status: 'acknowledged' });
        // 30 pending (unacknowledged, must be kept)
        for (let i = 0; i < 30; i++) items.push({ id: `pending-${i}` });
        // 30 active-snoozed (must be kept)
        for (let i = 0; i < 30; i++) items.push({ id: `snooze-${i}`, status: 'snoozed', snoozeUntil: snoozeFuture });
        fs.writeFileSync(inboxPath, JSON.stringify({ updatedAt: nowIso, items }, null, 2), 'utf8');

        hoisted.mockComboData = [{ id: 'routersync-node-b-default', name: 'node-b-default', models: [] }];
        const catalogPath = path.join(tmpDir, 'tick-catalog.json');
        fs.writeFileSync(catalogPath, JSON.stringify({
          version: 1, updatedAt: nowIso,
          providers: { 'node-b': { prefix: 'node-b', router: '9router', ids: [], absenceCounts: {}, firstAbsentAt: {}, hash: 'h-prev', updatedAt: nowIso } },
        }, null, 2), 'utf8');

        const mockFetch: typeof fetch = async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 });

        await runTickCommand({ stateDir: tmpDir, fetchFn: mockFetch, nowMs: nowMs2026, mode: 'propose' });

        const inbox = loadInboxState(inboxPath);
        // All pending and active-snoozed must be retained
        for (let i = 0; i < 30; i++) {
          expect(inbox.items.some((it) => it.id === `pending-${i}`)).toBe(true);
          expect(inbox.items.some((it) => it.id === `snooze-${i}`)).toBe(true);
        }
        // Total should not exceed 200
        expect(inbox.items.length).toBeLessThanOrEqual(200);
        // Acknowledged items should be trimmed (oldest first)
        const ackRemaining = inbox.items.filter((it) => it.id.startsWith('ack-'));
        expect(ackRemaining.length).toBeLessThan(150);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // G4: rank preview does not write PLAN-SHOWN.txt without --write-outputs/--apply
    it('G4: rank preview writes zero new files in temp dir without write flags', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-rank-g4-'));
      const orig9 = process.env['ROUTERSYNC_9ROUTER_DB'];
      const origOmni = process.env['ROUTERSYNC_OMNIROUTE_DB'];
      const db9 = path.join(tmpDir, 'mock-9router.sqlite');
      const dbOmni = path.join(tmpDir, 'mock-omniroute.sqlite');
      const d1 = openBetterSqlite3(db9);
      d1.exec("CREATE TABLE combos (id TEXT, name TEXT, models TEXT); INSERT INTO combos VALUES ('c1', 'test-combo', '[\"provider-a/model-1\", \"provider-a/model-2\"]');");
      d1.close();
      const d2 = openBetterSqlite3(dbOmni);
      d2.exec("CREATE TABLE combos (id TEXT, name TEXT, data TEXT); INSERT INTO combos VALUES ('c2', 'omni-test-combo', '{\"models\":[\"provider-b/model-1\", \"provider-b/model-2\"]}');");
      d2.close();
      process.env['ROUTERSYNC_9ROUTER_DB'] = db9;
      process.env['ROUTERSYNC_OMNIROUTE_DB'] = dbOmni;
      try {
        const outDir = path.join(tmpDir, 'out');
        fs.mkdirSync(outDir);
        // Preview without any write flag: the temp dir must stay empty.
        await runRankCommand({ router: 'all', outputDir: outDir });
        expect(fs.readdirSync(outDir)).toEqual([]);

        // Contrast: with writeOutputs the plan file appears.
        await runRankCommand({ router: 'all', outputDir: outDir, writeOutputs: true });
        const files = fs.readdirSync(outDir);
        expect(files).toContain('PLAN-SHOWN.txt');
        expect(files).toContain('CLASSIFY.txt');
        expect(files).toContain('UNRATED.txt');
        expect(files).toContain('RANK-PREVIEW.txt');
      } finally {
        if (orig9 !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = orig9;
        else delete process.env['ROUTERSYNC_9ROUTER_DB'];
        if (origOmni !== undefined) process.env['ROUTERSYNC_OMNIROUTE_DB'] = origOmni;
        else delete process.env['ROUTERSYNC_OMNIROUTE_DB'];
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
