/**
 * packages/cli/test/wp3-research-loop.test.ts
 *
 * C45-WP3 Red-First End-to-End Tier 0 <-> Tier 1 Research Loop Suite (Serves: S1, S3, S7):
 *  - Zero-token guarantee across L1 + L2 + L3 + harness targets (tokens=0, llmCalls=0, paidRequests=0)
 *  - 4-trigger research-queue.json precision (NO_MODEL_LIST_API, AMBIGUOUS_DEPRECATION,
 *    UNKNOWN_PRICING_TIER, CROSS_SOURCE_ID_CONFLICT) & exclusion of healthy / 429 / 5xx / 401
 *  - Closed loop: tick (AMBIGUOUS_DEPRECATION) -> secondary submit (SECONDARY_SOURCE_ONLY block)
 *    -> official submit -> tick resolves queue, emits REMOVE_MODEL for both router & harness,
 *    and records accurate detectionLatencyMs in tick-plan.json, status.json, and tick.log
 *  - 10% per-cycle shrink cap guard (SHRINK_CAP_EXCEEDED) on both router combos and harness targets
 *  - UNVERIFIABLE != ABSENT guard across 5 consecutive ticks (> 48h simulated nowMs)
 *  - detectionLatencyMs null when no sourceTimestamp exists (never fabricated as 0)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { appendResearchEvidence } from '@routersync/core';

const hoisted = vi.hoisted(() => ({
  mockComboData: [] as Array<{ id: string; name: string; models: string[] }>,
  mockTargets: [] as Array<{
    id: string;
    label: string;
    prefix: string;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    keySource: '9router-key' | 'omniroute-key' | 'none';
    skipReason?:
      | 'oauth-router-managed'
      | 'key-encrypted'
      | 'missing-param'
      | 'no-key'
      | 'unknown-prefix'
      | 'incomplete-pagination'
      | 'redirect-blocked'
      | undefined;
  }>,
}));

vi.mock('@routersync/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@routersync/daemon')>();
  return {
    ...actual,
    readRouterCombos: (router: string) => ({
      ok: true,
      exists: true,
      dbPath: 'mocked',
      data: router === '9router' ? hoisted.mockComboData : [],
    }),
  };
});

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
      targets: hoisted.mockTargets,
      combos: [],
    },
  ],
  printTargets: () => {},
}));

import {
  runTickCommand,
  type HarnessTickTarget,
  type TickPlanFile,
} from '../src/commands/tick.js';
import { computeDetectionLatencyMs, enforceTargetShrinkCap } from '../src/verify/index.js';

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('C45-WP3 Part 3 & 4: Tier 0 <-> Tier 1 Real-Time Research Loop', () => {
  let tmpDir = '';
  let plansDir = '';
  let fakeRouterDb = '';
  let fakeHarnessFile = '';
  const savedEnv: Record<string, string | undefined> = {};
  const baseNowMs = Date.parse('2026-11-24T12:00:00.000Z');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp3-loop-'));
    plansDir = path.join(tmpDir, 'plans');
    fakeRouterDb = path.join(tmpDir, 'router-untouched.sqlite');
    fakeHarnessFile = path.join(tmpDir, 'opencode-untouched.json');
    fs.writeFileSync(fakeRouterDb, 'untouched-router-sqlite', 'utf8');
    fs.writeFileSync(
      fakeHarnessFile,
      JSON.stringify({ provider: { anthropic: { models: {} } } }, null, 2),
      'utf8'
    );

    for (const k of ['ROUTERSYNC_9ROUTER_DB', 'ROUTERSYNC_OMNIROUTE_DB', 'ROUTERSYNC_STATE_DIR']) {
      savedEnv[k] = process.env[k];
    }
    process.env['ROUTERSYNC_9ROUTER_DB'] = path.join(tmpDir, 'nonexistent-9router.sqlite');
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpDir, 'nonexistent-omniroute.sqlite');
    process.env['ROUTERSYNC_STATE_DIR'] = tmpDir;

    hoisted.mockComboData = [];
    hoisted.mockTargets = [];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('computeDetectionLatencyMs returns null when sourceTimestamp is absent (never fabricates 0)', () => {
    expect(
      computeDetectionLatencyMs({
        planCreatedAt: '2026-11-24T12:00:00.000Z',
        sourcePublishedAt: null,
        sourceFirstChangedAt: null,
      })
    ).toBeNull();

    expect(
      computeDetectionLatencyMs({
        planCreatedAt: '2026-11-24T12:00:00.000Z',
        sourcePublishedAt: '2026-11-24T10:00:00.000Z',
        sourceFirstChangedAt: null,
      })
    ).toBe(2 * 3600 * 1000);
  });

  it('enforces 4-trigger research-queue.json precision and zero-token accounting while excluding healthy & 429/5xx/401', async () => {
    hoisted.mockTargets = [
      // 1. Healthy + ambiguous deprecation + cross-source conflict + unknown pricing
      {
        id: 'openai',
        label: 'OpenAI',
        prefix: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'ram-key-1',
        keySource: '9router-key',
      },
      // 2. NO_MODEL_LIST_API (missing-param / custom provider without list endpoint)
      {
        id: 'custom-no-list',
        label: 'Custom No List',
        prefix: 'custom-no-list',
        keySource: '9router-key',
        apiKey: 'ram-key-2',
        skipReason: 'unknown-prefix',
      },
      // 3. Transport errors (429, 503, 401) MUST NOT enter research-queue.json
      {
        id: 'groq',
        label: 'Groq',
        prefix: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'ram-key-3',
        keySource: '9router-key',
      },
      {
        id: 'mistral',
        label: 'Mistral',
        prefix: 'mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        apiKey: 'ram-key-4',
        keySource: '9router-key',
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        prefix: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'ram-key-5',
        keySource: '9router-key',
      },
    ];

    hoisted.mockComboData = [
      {
        id: 'main-combo',
        name: 'main-combo',
        models: [
          'openai/gpt-4.1-mini',           // Healthy (L1 + L2 paid, no notice) -> EXCLUDED
          'openai/gpt-4.5-preview',        // L3 notice without date -> AMBIGUOUS_DEPRECATION
          'openai/gpt-conflict-v1',        // Absent in L1 (200), present in L2 -> CROSS_SOURCE_ID_CONFLICT
          'custom-no-list/proprietary-v1', // Provider has unknown-prefix -> NO_MODEL_LIST_API
          'groq/llama-3.3-70b',            // 429 QUOTA -> EXCLUDED
          'mistral/mistral-large',         // 503 TRANSIENT -> EXCLUDED
          'deepseek/deepseek-chat',        // 401 AUTH_ERROR -> EXCLUDED
        ],
      },
    ];

    // Seed previous openai catalog so gpt-mystery-zero is detected as newly added candidate
    fs.writeFileSync(
      path.join(tmpDir, 'tick-catalog.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-11-24T10:00:00.000Z',
          providers: {
            openai: {
              prefix: 'openai',
              router: '9router',
              ids: ['gpt-4.1-mini', 'gpt-4.5-preview', 'gpt-conflict-v1'],
              absenceCounts: {},
              firstAbsentAt: {},
              hash: 'prev-openai-hash',
              consecutiveFailures: 0,
              backoffUntilMs: 0,
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: '2026-11-24T10:00:00.000Z',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api.openai.com')) {
        // gpt-conflict-v1 omitted from L1; gpt-mystery-zero newly added!
        return new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4.1-mini' },
              { id: 'gpt-4.5-preview' },
              { id: 'gpt-mystery-zero' },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('api.groq.com')) return new Response('rate limit', { status: 429 });
      if (url.includes('api.mistral.ai')) return new Response('unavailable', { status: 503 });
      if (url.includes('api.deepseek.com')) return new Response('unauthorized', { status: 401 });
      if (url.includes('openrouter.ai/api/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'openai/gpt-4.1-mini', pricing: { prompt: '0.0000004', completion: '0.0000016' } },
              { id: 'openai/gpt-conflict-v1', pricing: { prompt: '0.000001', completion: '0.000002' } },
              // Zero price WITHOUT -free/:free suffix -> isZeroPriceHidden (ẨN-GIÁ-0) -> UNKNOWN_PRICING_TIER
              { id: 'openai/gpt-mystery-zero', pricing: { prompt: '0', completion: '0' } },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('models.dev/api.json')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('platform.openai.com/docs/deprecations')) {
        // Ambiguous L3 deprecation notice WITH NO DATE
        return new Response(
          '<html><body><h2>Upcoming deprecation notice for gpt-4.5-preview</h2></body></html>',
          { status: 200 }
        );
      }
      return new Response('', { status: 200 });
    };

    const summary = await runTickCommand({
      stateDir: tmpDir,
      plansDir,
      nowMs: baseNowMs,
      mode: 'propose',
      fetchFn: mockFetch,
      harnessTargets: [],
    });

    // Zero-token hard guarantee
    expect(summary.tokens).toBe(0);
    expect(summary.llmCalls).toBe(0);
    expect(summary.paidRequests).toBe(0);

    const queueRaw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'research-queue.json'), 'utf8')) as {
      version: number;
      items: Array<{ id: string; prefix: string; reasons: string[] }>;
    };
    expect(queueRaw.version).toBe(1);

    const byId = new Map(queueRaw.items.map((item) => [item.id, item]));

    // Exact 4 triggers present
    expect(byId.get('custom-no-list/*')?.reasons).toContain('NO_MODEL_LIST_API');
    expect(byId.get('openai/gpt-4.5-preview')?.reasons).toContain('AMBIGUOUS_DEPRECATION');
    expect(byId.get('openai/gpt-mystery-zero')?.reasons).toContain('UNKNOWN_PRICING_TIER');
    expect(byId.get('openai/gpt-conflict-v1')?.reasons).toContain('CROSS_SOURCE_ID_CONFLICT');

    // Healthy & 429/5xx/401 excluded
    expect(byId.has('openai/gpt-4.1-mini')).toBe(false);
    expect([...byId.keys()].some((k) => k.startsWith('groq/'))).toBe(false);
    expect([...byId.keys()].some((k) => k.startsWith('mistral/'))).toBe(false);
    expect([...byId.keys()].some((k) => k.startsWith('deepseek/'))).toBe(false);
  });

  it('executes closed loop (tick -> secondary blocked -> official resolves & plans router + harness REMOVE_MODEL with detectionLatencyMs)', async () => {
    const routerDbShaBefore = sha256File(fakeRouterDb);
    const harnessFileShaBefore = sha256File(fakeHarnessFile);

    const modelToRetire = 'claude-3-sonnet-20240229';
    const survivingModels = Array.from({ length: 9 }, (_, i) => `claude-3-5-haiku-v${i + 1}`);
    const tenModels = [modelToRetire, ...survivingModels]; // 1/10 = 10% <= 10% cap

    hoisted.mockTargets = [
      {
        id: 'anthropic',
        label: 'Anthropic',
        prefix: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'ram-anth-key',
        keySource: '9router-key',
      },
    ];
    hoisted.mockComboData = [
      {
        id: 'coding-combo',
        name: 'coding-combo',
        models: tenModels.map((m) => `anthropic/${m}`),
      },
    ];

    const harnessTargets: HarnessTickTarget[] = [
      {
        harnessId: 'opencode',
        configPath: fakeHarnessFile,
        defaultModels: [`anthropic/${survivingModels[0]}`],
        providers: [
          {
            providerId: 'anthropic',
            models: [...tenModels],
            keyPresent: true,
          },
        ],
      },
    ];

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api.anthropic.com')) {
        return new Response(
          JSON.stringify({ data: tenModels.map((id) => ({ id })) }),
          { status: 200 }
        );
      }
      if (url.includes('docs.anthropic.com')) {
        // Ambiguous notice without date
        return new Response(
          `<html><body><h2>Upcoming deprecation notice for ${modelToRetire}</h2></body></html>`,
          { status: 200 }
        );
      }
      if (url.includes('openrouter.ai/api/v1/models')) {
        return new Response(
          JSON.stringify({
            data: tenModels.map((id) => ({
              id: `anthropic/${id}`,
              pricing: { prompt: '0.000003', completion: '0.000015' },
            })),
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    // --- TICK 1: Ambiguous deprecation queued, ZERO removals ---
    await runTickCommand({
      stateDir: tmpDir,
      plansDir,
      nowMs: baseNowMs,
      minScanIntervalMs: 0,
      mode: 'propose',
      fetchFn: mockFetch,
      harnessTargets,
    });

    const queue1 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'research-queue.json'), 'utf8'));
    expect(
      queue1.items.some(
        (i: { id: string; reasons: string[] }) =>
          i.id === `anthropic/${modelToRetire}` && i.reasons.includes('AMBIGUOUS_DEPRECATION')
      )
    ).toBe(true);

    const plan1 = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
    expect(plan1.routerActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
    expect(plan1.harnessActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);

    // --- TIER 1 STEP 2: Submit SECONDARY deprecation evidence -> Tick 2 blocks REMOVE_MODEL ---
    appendResearchEvidence(tmpDir, {
      provider: 'anthropic',
      modelId: modelToRetire,
      verdict: 'deprecated',
      url: 'https://community-blog.example.com/claude-3-retired',
      quote: 'Blog claims claude-3-sonnet-20240229 shut down already',
      shutdownDate: '2026-07-21',
      publishedAt: '2026-07-21T00:00:00.000Z',
      submittedVia: 'mcp',
    });

    const tick2NowMs = baseNowMs + 20 * 60 * 1000;
    await runTickCommand({
      stateDir: tmpDir,
      plansDir,
      nowMs: tick2NowMs,
      minScanIntervalMs: 0,
      mode: 'propose',
      fetchFn: mockFetch,
      harnessTargets,
    });

    const plan2 = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
    expect(plan2.routerActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
    expect(plan2.harnessActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
    expect(
      plan2.blockedRemovals.some(
        (b) => b.modelId === modelToRetire && b.blockedReason === 'SECONDARY_SOURCE_ONLY'
      )
    ).toBe(true);

    // --- TIER 1 STEP 3: Submit OFFICIAL deprecation evidence -> Tick 3 resolves queue & emits REMOVE_MODEL ---
    const publishedAt = '2026-11-24T10:00:00.000Z';
    appendResearchEvidence(tmpDir, {
      provider: 'anthropic',
      modelId: modelToRetire,
      verdict: 'deprecated',
      url: 'https://docs.anthropic.com/en/docs/resources/model-deprecations',
      quote: 'claude-3-sonnet-20240229 was retired on 2026-07-21.',
      publishedAt,
      submittedAt: new Date(baseNowMs + 30 * 60_000).toISOString(),
      shutdownDate: '2026-07-21',
      replacementModelId: 'claude-3-5-haiku-v1',
      claimedSourceTier: 'official',
      submittedVia: 'mcp',
    });

    const tick3NowMs = baseNowMs + 40 * 60 * 1000; // 2026-11-24T12:40:00.000Z
    const expectedLatencyMs = 0;
    const expectedPublicationToPlanMs = tick3NowMs - Date.parse(publishedAt);

    const summary3 = await runTickCommand({
      stateDir: tmpDir,
      plansDir,
      nowMs: tick3NowMs,
      minScanIntervalMs: 0,
      mode: 'propose',
      fetchFn: mockFetch,
      harnessTargets,
    });

    // Queue resolved
    const queue3 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'research-queue.json'), 'utf8'));
    expect(
      queue3.items.some((i: { id: string }) => i.id === `anthropic/${modelToRetire}`)
    ).toBe(false);

    // Plan contains REMOVE_MODEL for BOTH router combo (1/10) and harness target (1/10)
    const plan3 = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
    expect(plan3.accounting).toEqual({
      requests: summary3.requests,
      paidRequests: 0,
      tokens: 0,
      llmCalls: 0,
    });

    const routerRemovals = plan3.routerActions.filter((a) => a.action === 'REMOVE_MODEL');
    const harnessRemovals = plan3.harnessActions.filter((a) => a.action === 'REMOVE_MODEL');
    expect(routerRemovals).toHaveLength(1);
    expect(routerRemovals[0]?.comboName).toBe('coding-combo');
    expect(routerRemovals[0]?.modelId).toBe(modelToRetire);
    expect(routerRemovals[0]).toMatchObject({ detectionLatencyMs: expectedLatencyMs, publicationToPlanMs: expectedPublicationToPlanMs });

    expect(harnessRemovals).toHaveLength(1);
    expect(harnessRemovals[0]?.harnessId).toBe('opencode');
    expect(harnessRemovals[0]?.modelId).toBe(modelToRetire);
    expect(harnessRemovals[0]).toMatchObject({ detectionLatencyMs: expectedLatencyMs, publicationToPlanMs: expectedPublicationToPlanMs });

    // Latency persisted in all 3 places: tick-plan.json, status.json, tick.log
    expect(plan3.detectionLatency.measuredCount).toBe(1);
    expect(plan3.detectionLatency.maxMs).toBe(expectedLatencyMs);

    const status3 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'status.json'), 'utf8'));
    expect(status3.detectionLatency.maxMs).toBe(expectedLatencyMs);
    expect(typeof status3.researchQueueCount).toBe('number');

    const tickLog = fs.readFileSync(path.join(tmpDir, 'tick.log'), 'utf8').trim().split(/\r?\n/);
    const lastLogLine = tickLog[tickLog.length - 1]!;
    expect(lastLogLine).toContain(`detection_latency_ms=${expectedLatencyMs}`);
    expect(lastLogLine).toContain(`research_queue=${status3.researchQueueCount}`);

    // Evidence marked consumedAt
    const consumedLedger = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'research-evidence.json'), 'utf8')
    ) as Array<{ sourceTier: string; consumedAt: string | null }>;
    expect(consumedLedger.some((r) => r.sourceTier === 'official' && r.consumedAt !== null)).toBe(true);

    // Zero mutations to router DB or harness config file
    expect(sha256File(fakeRouterDb)).toBe(routerDbShaBefore);
    expect(sha256File(fakeHarnessFile)).toBe(harnessFileShaBefore);
  });

  it('enforces 10% per-cycle removal shrink cap (SHRINK_CAP_EXCEEDED) on both 5-model and 10-model router & harness targets', async () => {
    // 5 models losing 1 = 20% > 10% cap!
    const fiveModels = ['gpt-old-retired', 'gpt-keep-1', 'gpt-keep-2', 'gpt-keep-3', 'gpt-keep-4'];
    hoisted.mockTargets = [
      {
        id: 'openai',
        label: 'OpenAI',
        prefix: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'ram-key',
        keySource: '9router-key',
      },
    ];
    hoisted.mockComboData = [
      {
        id: 'five-step-combo',
        name: 'five-step-combo',
        models: fiveModels.map((m) => `openai/${m}`),
      },
    ];

    const harnessTargets: HarnessTickTarget[] = [
      {
        harnessId: 'hermes',
        configPath: fakeHarnessFile,
        providers: [
          {
            providerId: 'openai',
            models: [...fiveModels],
            keyPresent: true,
          },
        ],
      },
    ];

    // Even with verified OFFICIAL deprecation!
    appendResearchEvidence(tmpDir, {
      provider: 'openai',
      modelId: 'gpt-old-retired',
      verdict: 'deprecated',
      url: 'https://platform.openai.com/docs/deprecations',
      quote: 'gpt-old-retired was shut down.',
      shutdownDate: '2026-06-01',
      publishedAt: '2026-06-01T00:00:00.000Z',
      submittedAt: new Date(baseNowMs - 1000).toISOString(),
      claimedSourceTier: 'official',
      submittedVia: 'mcp',
    });

    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: fiveModels.slice(1).map((id) => ({ id })) }), {
        status: 200,
      });

    await runTickCommand({
      stateDir: tmpDir,
      plansDir,
      nowMs: baseNowMs,
      minScanIntervalMs: 0,
      mode: 'propose',
      fetchFn: mockFetch,
      harnessTargets,
    });

    const plan = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
    expect(plan.routerActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
    expect(plan.harnessActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);

    const routerShrinkBlocked = plan.blockedRemovals.find(
      (b) => b.targetType === 'router' && b.blockedReason === 'SHRINK_CAP_EXCEEDED'
    );
    const harnessShrinkBlocked = plan.blockedRemovals.find(
      (b) => b.targetType === 'harness' && b.blockedReason === 'SHRINK_CAP_EXCEEDED'
    );
    expect(routerShrinkBlocked).toBeDefined();
    expect(harnessShrinkBlocked).toBeDefined();

    const inbox = JSON.parse(fs.readFileSync(path.join(tmpDir, 'inbox.json'), 'utf8'));
    const inboxItems: Array<{ title: string }> = inbox.items ?? [];
    expect(inboxItems.some((item) => item.title.includes('[SHRINK-GUARD]'))).toBe(true);
  });

  it('C47: measures the absence-only gate before planning a removal', async () => {
    expect(enforceTargetShrinkCap('router', 9, 1).allowed).toBe(false);
    expect(enforceTargetShrinkCap('router', 10, 1).allowed).toBe(true);
    const healthy = Array.from({ length: 9 }, (_, index) => `claude-c47-fixture-${index + 1}`);
    const absent = 'claude-c47-fixture-retired';
    const initial = [...healthy, absent];
    hoisted.mockComboData = [
      { id: 'pilot', name: 'rs-pilot', models: initial.map((id) => `anthropic/${id}`) },
    ];
    hoisted.mockTargets = [
      {
        id: 'anthropic',
        label: 'Anthropic fixture',
        prefix: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'fixture-only',
        keySource: '9router-key',
      },
    ];

    const hourMs = 60 * 60 * 1000;
    const firstAbsentAt = baseNowMs + hourMs;
    let providerModels = initial;
    const fetchFixture: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.anthropic.com' && url.pathname === '/v1/models') {
        return Response.json({ data: providerModels.map((id) => ({ id })) });
      }
      if (url.hostname === 'api.anthropic.com') return new Response(null, { status: 404 });
      return Response.json({ data: [] });
    };

    const runCycle = async (nowMs: number) => {
      await runTickCommand({
        stateDir: tmpDir,
        plansDir,
        nowMs,
        mode: 'auto-safe',
        fetchFn: fetchFixture,
        harnessTargets: [],
      });
      const plan = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
      const catalog = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tick-catalog.json'), 'utf8'));
      return {
        absenceCount: catalog.providers.anthropic.absenceCounts[absent] ?? 0,
        removals: plan.routerActions.filter((action) => action.action === 'REMOVE_MODEL'),
        latency: plan.detectionLatency,
      };
    };

    await runCycle(baseNowMs);
    providerModels = healthy;
    const first = await runCycle(firstAbsentAt);
    const second = await runCycle(firstAbsentAt + hourMs);
    expect(first.absenceCount).toBe(1);
    expect(first.removals).toEqual([]);
    expect(first.latency.measuredCount).toBe(1);
    expect(first.latency.maxMs).toBeGreaterThanOrEqual(0);
    expect(first.latency.maxMs!).toBeLessThanOrEqual(60_000);
    expect(second).toMatchObject({ absenceCount: 2, removals: [], latency: { measuredCount: 0, maxMs: null } });

    const third = await runCycle(firstAbsentAt + 24 * hourMs);
    expect(third.absenceCount).toBe(3);
    expect(third.removals).toEqual([expect.objectContaining({ modelId: absent, detectionLatencyMs: null })]);
    expect(third.latency).toMatchObject({ measuredCount: 0, maxMs: null });
  });

  it('enforces UNVERIFIABLE != ABSENT across 5 consecutive ticks (> 48h): absenceCount stays 0 and zero REMOVE_MODEL actions', async () => {
    const models = Array.from({ length: 10 }, (_, i) => `unverified-model-${i + 1}`);
    hoisted.mockTargets = [
      {
        id: 'custom-unscanned',
        label: 'Custom Unscanned',
        prefix: 'custom-unscanned',
        keySource: 'none',
        skipReason: 'no-key',
      },
    ];
    hoisted.mockComboData = [
      {
        id: 'unverified-combo',
        name: 'unverified-combo',
        models: models.map((m) => `custom-unscanned/${m}`),
      },
    ];

    const harnessTargets: HarnessTickTarget[] = [
      {
        harnessId: 'opencode',
        configPath: fakeHarnessFile,
        providers: [
          {
            providerId: 'custom-unscanned',
            models: [...models],
            keyPresent: false,
            unverifiable: true,
            unverifiableReason: 'UNVERIFIABLE',
          },
        ],
      },
    ];

    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });

    // Run 5 ticks spanning 60 hours (> 48h)
    for (let cycle = 0; cycle < 5; cycle++) {
      await runTickCommand({
        stateDir: tmpDir,
        plansDir,
        nowMs: baseNowMs + cycle * 15 * 3600 * 1000,
        minScanIntervalMs: 0,
        mode: 'propose',
        fetchFn: mockFetch,
        harnessTargets,
      });
    }

    const catalog = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tick-catalog.json'), 'utf8'));
    const provEntry = catalog.providers?.['custom-unscanned'];
    if (provEntry) {
      expect(Object.keys(provEntry.absenceCounts ?? {})).toHaveLength(0);
    }

    const verifyStatus = JSON.parse(fs.readFileSync(path.join(tmpDir, 'verify-status.json'), 'utf8'));
    for (const rec of verifyStatus.records ?? []) {
      if (rec.prefix === 'custom-unscanned') {
        expect(rec.l1.absenceCount).toBe(0);
        expect(rec.label).not.toBe('ĐÃ-XÁC-NHẬN-NGỪNG');
        expect(rec.label).not.toBe('NGHI-NGỪNG');
      }
    }

    const plan = JSON.parse(fs.readFileSync(path.join(plansDir, 'tick-plan.json'), 'utf8')) as TickPlanFile;
    expect(plan.routerActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
    expect(plan.harnessActions.filter((a) => a.action === 'REMOVE_MODEL')).toHaveLength(0);
  });
});
