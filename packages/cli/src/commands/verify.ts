/**
 * packages/cli/src/commands/verify.ts
 *
 * Implements `routersync verify` command (Round C4b F3b):
 *  - Verifies models across 3 layers (L1 provider catalog, L2 public catalog, L3 changelogs)
 *  - Assigns 6 canonical labels
 *  - Enforces ABSENT-STABLE (F4) and NEW-CANDIDATE proposals (F5)
 *  - Outputs deterministic accounting line: `VERIFY requests=<n> paid=0 tokens=0 llm-calls=0`
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runVerifyPhase, type VerifyPhaseOptions } from '../verify/verifier.js';
import type { VerifyPhaseSummary } from '../verify/types.js';
import {
  resolveTickStateDir,
  loadCatalogState,
  loadAllRouterCombos,
  collectUsedComboSteps,
} from './tick.js';

export interface VerifyCommandOptions {
  configPath?: string | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
  full?: boolean | undefined;
  out?: string | undefined;
  deadlineMs?: number | undefined;
  mock3Layer?: boolean | undefined;
  mock3layer?: boolean | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

export function build3LayerMockDataset() {
  const nowMs = Date.now();
  return {
    models: [
      // 1. ĐÃ-XÁC-NHẬN-CÒN: present on L1 with HTTP 200
      {
        id: 'gemini-1.5-pro',
        prefix: 'google',
        l1Status: 200,
        l1Exists: true,
        absenceCount: 0,
        lastSeenAt: new Date(nowMs).toISOString(),
      },
      // 2. ĐÃ-XÁC-NHẬN-NGỪNG: absent on L1 >= 2 cycles, L3 has confirmed deprecation notice
      {
        id: 'text-davinci-003',
        prefix: 'openai',
        l1Status: 404,
        l1Exists: false,
        absenceCount: 3,
        firstAbsentAtMs: nowMs - 30 * 3600 * 1000,
      },
      // 3. SẮP-NGỪNG: present on L1, L3 has upcoming deprecation notice
      {
        id: 'claude-2.0',
        prefix: 'anthropic',
        l1Status: 200,
        l1Exists: true,
        absenceCount: 0,
      },
      // 4. NGHI-NGỪNG: absent on L1 stably >= 2 cycles, no L2/L3 notice
      {
        id: 'ancient-custom-model',
        prefix: 'openai',
        l1Status: 404,
        l1Exists: false,
        absenceCount: 2,
        firstAbsentAtMs: nowMs - 20 * 3600 * 1000,
      },
      // 5. CHƯA-XÁC-MINH: provider not covered by public sources
      {
        id: 'internal-finance-llm',
        prefix: 'private-gateway',
        l1Status: 404,
        l1Exists: false,
        absenceCount: 1,
      },
      // 6. QUOTA: HTTP 429 received, exists on L1, not dead
      {
        id: 'pulse-alpha-free',
        prefix: 'ocz',
        l1Status: 429,
        l1Exists: true,
        absenceCount: 0,
      },
    ],
    coveredProviders: {
      google: true,
      openai: true,
      anthropic: true,
      ocz: true,
      'private-gateway': false,
    },
    mockL2Entries: {
      'pulse-alpha-free': {
        id: 'pulse-alpha-free',
        price: 0,
        isZeroPriceHidden: false,
        source: 'openrouter' as const,
      },
      'pulse-alpha': {
        id: 'pulse-alpha',
        price: 0,
        isZeroPriceHidden: true, // flag `ẨN-GIÁ-0`
        source: 'openrouter' as const,
      },
      'gemini-1.5-pro': {
        id: 'gemini-1.5-pro',
        price: 0.002,
        isZeroPriceHidden: false,
        source: 'models.dev' as const,
      },
    },
    mockL3Notices: [
      {
        sourceId: 'openai-changelog',
        url: 'https://openai.com/changelog',
        title: 'Deprecation Notice: text-davinci-003 is shut down and retired',
        date: '2026-11-01',
        modelMatches: ['text-davinci-003'],
        noticeType: 'deprecated' as const,
      },
      {
        sourceId: 'anthropic-release-notes',
        url: 'https://anthropic.com/news',
        title: 'Upcoming deprecation: claude-2.0 will be deprecated on 2026-12-31',
        date: '2026-11-05',
        modelMatches: ['claude-2.0'],
        noticeType: 'upcoming_deprecation' as const,
      },
    ],
  };
}

export async function runVerifyCommand(options: VerifyCommandOptions = {}): Promise<VerifyPhaseSummary> {
  const sDir = resolveTickStateDir(options.stateDir);
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  let verifyOptions: VerifyPhaseOptions = {
    stateDir: sDir,
  };

  if (options.mock3Layer || options.mock3layer) {
    const mock = build3LayerMockDataset();
    verifyOptions = {
      stateDir: sDir,
      models: mock.models,
      coveredProviders: mock.coveredProviders,
      l2Options: { minIntervalMs: 0 },
      l3Options: { minIntervalMs: 0 },
      fetchFn: async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('blog') || urlStr.includes('changelog') || urlStr.includes('status') || urlStr.includes('github') || urlStr.includes('huggingface')) {
          return new Response(`
            <h1>Deprecation Notice: text-davinci-003 is shut down and retired</h1>
            <h2>Upcoming deprecation: claude-2.0 will be deprecated on 2026-12-31</h2>
          `, { status: 200 });
        }
        if (urlStr.includes('openrouter.ai')) {
          return new Response(JSON.stringify({
            data: [
              { id: 'pulse-alpha-free', pricing: { prompt: 0, completion: 0 } },
              { id: 'pulse-alpha', pricing: { prompt: 0, completion: 0 } }, // ẨN-GIÁ-0
            ]
          }), { status: 200, headers: { etag: 'W/"mock-or-1"' } });
        }
        if (urlStr.includes('models.dev')) {
          return new Response(JSON.stringify({
            google: {
              models: {
                'gemini-1.5-pro': { cost_per_token: 0.002 }
              }
            }
          }), { status: 200, headers: { etag: 'W/"mock-md-1"' } });
        }
        return new Response('Not found', { status: 404 });
      },
      combos: [
        { name: 'omni-gemini', router: 'omniroute', models: ['google/gemini-1.5-flash'] },
      ],
      agents: [
        { name: 'coder', client: 'hermes', model: 'google/gemini-1.5-flash' },
      ],
    };
  } else {
    // A3: Read tick-catalog.json and combo steps; verify used models + newly added models
    const catalogPath = path.join(sDir, 'tick-catalog.json');
    const catalogState = loadCatalogState(catalogPath);
    const allCombos = loadAllRouterCombos();
    const usedSteps = collectUsedComboSteps();

    const targetSteps = new Set<string>(usedSteps);
    const addedModelIds = new Set<string>();

    const statusPath = path.join(sDir, 'status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const statusRaw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
          providers?: Array<{ prefix: string; added?: string[] }>;
        };
        for (const p of statusRaw.providers ?? []) {
          for (const a of p.added ?? []) {
            const fullStep = `${p.prefix}/${a}`;
            targetSteps.add(fullStep);
            addedModelIds.add(a);
            addedModelIds.add(fullStep);
          }
        }
      } catch {
        // ignore
      }
    }

    const realModels: Array<{
      id: string;
      prefix: string;
      l1Exists?: boolean | undefined;
      l1Status?: number | undefined;
      absenceCount?: number | undefined;
      firstAbsentAtMs?: number | undefined;
      lastSeenAt?: string | undefined;
      isAdded?: boolean | undefined;
      isUnscanned?: boolean | undefined;
      unscannedReason?: string | undefined;
    }> = [];

    for (const step of targetSteps) {
      const slashIdx = step.indexOf('/');
      const prefix = slashIdx !== -1 ? step.slice(0, slashIdx) : 'unknown';
      const id = slashIdx !== -1 ? step.slice(slashIdx + 1) : step;
      const provEntry = catalogState.providers[prefix];
      const isUnscanned = !provEntry || Boolean(provEntry.skipReason);
      const unscannedReason = provEntry?.skipReason ?? (!provEntry ? 'nhà-cung-cấp-chưa-được-quét' : undefined);
      const l1Exists = provEntry ? provEntry.ids.includes(id) : false;
      const l1Status = provEntry ? provEntry.lastStatus : (isUnscanned ? 0 : (l1Exists ? 200 : 404));
      const absenceCount = provEntry?.absenceCounts?.[id] ?? (l1Exists ? 0 : 1);
      const firstAbsentAt = provEntry?.firstAbsentAt?.[id];
      const firstAbsentAtMs = firstAbsentAt ? Date.parse(firstAbsentAt) : undefined;
      const isAdded = addedModelIds.has(id) || addedModelIds.has(step);

      realModels.push({
        id,
        prefix,
        l1Exists,
        l1Status,
        absenceCount,
        firstAbsentAtMs,
        lastSeenAt: provEntry?.updatedAt,
        isAdded,
        isUnscanned,
        unscannedReason,
      });
    }

    verifyOptions = {
      stateDir: sDir,
      models: realModels,
      combos: allCombos,
      addedModelIds,
      fetchFn: options.fetchFn,
    };
  }

  const deadlineMs = options.deadlineMs ?? 60_000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, deadlineMs);
  });
  const phase = runVerifyPhase(verifyOptions);
  // Prevent an unhandled rejection if the deadline wins the race.
  phase.catch(() => {});

  const raced = await Promise.race([phase, deadline]);
  if (timer) clearTimeout(timer);

  let summary: VerifyPhaseSummary;
  if (raced === null) {
    summary = {
      timestamp: new Date().toISOString(),
      modelsVerified: 0,
      labels: {} as VerifyPhaseSummary['labels'],
      records: [],
      proposals: [],
      absentStableCandidates: [],
      accounting: { requests: 0, paidRequests: 0, tokens: 0, llmCalls: 0 },
      incomplete: true,
    };
  } else {
    summary = raced;
    if (timedOut) summary.incomplete = true;
  }

  if (options.json) {
    const payload = options.full === true
      ? summary
      : {
          timestamp: summary.timestamp,
          modelsVerified: summary.modelsVerified,
          labels: summary.labels,
          accounting: summary.accounting,
          recordsCount: summary.records.length,
          proposalsCount: summary.proposals.length,
          absentStableCount: summary.absentStableCandidates.length,
          incomplete: summary.incomplete === true,
        };
    const text = JSON.stringify(payload, null, 2);
    if (options.out) fs.writeFileSync(options.out, text + '\n', 'utf8');
    else console.log(text);
  }

  return summary;
}
