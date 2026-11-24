/**
 * packages/cli/src/commands/combos-reliability.ts
 *
 * C37 V3 / C43 R2 / C44 W2: độ ổn định từng bước, dựa trên `combos probe --mode step`.
 * Mỗi bước: `rounds` vòng, mỗi vòng `repeat` request, cách `gapSec` giây,
 * hạn 30 s, max_tokens 8, stream bật, tuần tự.
 */
import { readFileSync } from 'node:fs';
import { openBetterSqlite3, locateRouterDb } from '@routersync/core';
import { perStepConclusion, redact, type ComboProbeRow, type VerdictInput } from './combos-probe.js';
import {
  classifyStep,
  interleaveProviders,
  providerDelayMs,
  providerOf,
  recentQuotaSteps,
  RequestBudget,
  DEFAULT_REQUEST_BUDGET,
} from './combos-budget.js';

function resolveApiKey(dbPath?: string, explicitKey?: string): string {
  if (explicitKey !== undefined) return explicitKey;
  try {
    const explicit = dbPath?.trim() || process.env['ROUTERSYNC_9ROUTER_DB']?.trim();
    const file = explicit || locateRouterDb('9router');
    const db = openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
    try {
      const row = db
        .prepare('SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1')
        .get() as { key?: string } | undefined;
      return typeof row?.key === 'string' ? row.key : '';
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

async function probeStep(
  step: string,
  opts: {
    maxTokens: number;
    timeoutMs: number;
    key: string;
    now: () => number;
    fetchImpl?: typeof fetch | undefined;
    baseUrl?: string | undefined;
  }
): Promise<ComboProbeRow> {
  const base = opts.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? 'http://127.0.0.1:20128';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const key = opts.key;
  const startedAt = new Date(opts.now()).toISOString();
  const t0 = Date.now();
  let headerMs: number | null = null;
  let firstByteMs: number | null = null;
  let status: number | null = null;
  let text = '';
  let timedOut = false;
  try {
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: step,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: opts.maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    headerMs = Date.now() - t0;
    status = res.status;
    if (res.status >= 400) {
      text = (await res.text()).slice(0, 300);
      firstByteMs = Date.now() - t0;
    } else {
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        const first = await reader.read();
        firstByteMs = Date.now() - t0;
        text = decoder.decode(first.value ?? new Uint8Array()).slice(0, 300);
        await reader.cancel().catch(() => undefined);
      } else {
        text = (await res.text()).slice(0, 300);
        firstByteMs = Date.now() - t0;
      }
    }
  } catch (err) {
    timedOut = true;
    text = err instanceof Error ? err.message : String(err);
  }
  const body = redact(text, key ? [key] : []);
  const input: VerdictInput = {
    status,
    body,
    headerReceived: headerMs !== null,
    usageRowAdded: false,
    timedOut,
  };
  const classified = classifyStep({
    verdict: perStepConclusion(input),
    body,
  });
  return {
    combo: '(step)',
    model: step,
    startedAt,
    httpStatus: status,
    headerMs,
    firstByteMs: firstByteMs ?? headerMs,
    totalMs: Date.now() - t0,
    verdict: classified.verdict as ComboProbeRow['verdict'],
    quota: classified.quota,
    detail: body,
    usageServedBy: null,
  };
}

export type ReliabilityLabel = 'RELIABLE' | 'SLOW' | 'RATE-LIMITED' | 'LOW-SAMPLE' | 'HANG' | 'DEAD';

export const RELIABLE_OK_MIN = 5;
export const SLOW_P90_MS = 5_000;
export const STEP_TIMEOUT_MS = 30_000;

export interface StepReliability {
  step: string;
  attempts: number;
  ok: number;
  rateLimited: number;
  failures: number;
  headerMs: number[];
  p50: number | null;
  p90: number | null;
  label: ReliabilityLabel;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null;
}

/** Phân loại thuần — mọi nhánh có test. Một lần treo => HANG, dù các lần khác OK. */
export function labelStep(input: {
  attempts: number;
  ok: number;
  rateLimited: number;
  timeoutOrNoHeader: number;
  p90Ms: number | null;
}): ReliabilityLabel {
  if (input.timeoutOrNoHeader > 0) return 'HANG';
  // 429 nhanh không làm combo treo, nhưng vẫn được ghi riêng để xếp sau bước RELIABLE.
  if (input.rateLimited > 0) return 'RATE-LIMITED';
  if (input.ok >= RELIABLE_OK_MIN && input.p90Ms !== null && input.p90Ms < SLOW_P90_MS) return 'RELIABLE';
  if (input.ok >= RELIABLE_OK_MIN) return 'SLOW';
  if (input.ok > 0 && input.attempts < RELIABLE_OK_MIN && input.ok === input.attempts) return 'LOW-SAMPLE';
  return 'DEAD';
}

export function summarizeAttempts(step: string, rows: ComboProbeRow[]): StepReliability {
  const ok = rows.filter((r) => r.verdict === 'OK').length;
  const rateLimited = rows.filter((r) => r.verdict === 'RATE-LIMITED').length;
  const timeoutOrNoHeader = rows.filter(
    (r) => r.verdict === 'TIMEOUT-NO-HEADER' || r.verdict === 'HANG-AFTER-USAGE' || r.verdict === 'HANG-NO-USAGE'
  ).length;
  const headerMs = rows.filter((r) => typeof r.headerMs === 'number').map((r) => r.headerMs as number);
  const p90 = percentile(headerMs, 90);
  return {
    step,
    attempts: rows.length,
    ok,
    rateLimited,
    failures: rows.length - ok,
    headerMs,
    p50: percentile(headerMs, 50),
    p90,
    label: labelStep({ attempts: rows.length, ok, rateLimited, timeoutOrNoHeader, p90Ms: p90 }),
  };
}

export interface ReliabilityOptions {
  from: string;
  repeat?: number;
  rounds?: number;
  gapSec?: number;
  maxMinutes?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** C40 X0 / C44 W2 */
  budget?: number | undefined;
  skipQuotaFrom?: string[] | undefined;
  sleepImpl?: (ms: number) => Promise<void> | undefined;
  dbPath?: string | undefined;
  apiKey?: string | undefined;
  now?: (() => number) | undefined;
  maxConsecutive429?: number | undefined;
}

export interface ReliabilityResult {
  steps: StepReliability[];
  skipped: string[];
  skippedQuota: string[];
  requests: string;
}

export async function runReliability(options: ReliabilityOptions): Promise<ReliabilityResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  if (!options.from) throw new Error('--from là bắt buộc (tệp kết quả combos probe --mode step)');
  const raw = readFileSync(options.from, 'utf8');
  const targetSteps = raw
    .split(/\r?\n/)
    .map((l) => (l.trim().split('\t')[0] ?? '').replace(/#\d+$/, '').trim())
    .filter((s) => s.includes('/'))
    .filter((s, i, all) => all.indexOf(s) === i)
    .slice(0, 70);
  if (targetSteps.length === 0) throw new Error('không tìm thấy bước nào trong --from');

  const clock = options.now ?? Date.now;
  const repeat = Math.max(1, Math.floor(options.repeat ?? 3));
  const rounds = Math.max(1, Math.floor(options.rounds ?? 2));
  const gapSec = Math.max(0, Math.floor(options.gapSec ?? 5));
  const maxConsecutive429 = Math.max(1, Math.floor(options.maxConsecutive429 ?? 5));
  const budgetMs = Math.max(1, options.maxMinutes ?? 40) * 60_000;
  const t0 = clock();
  const key = resolveApiKey(options.dbPath, options.apiKey);

  const skippedQuota = new Set<string>();
  for (const file of options.skipQuotaFrom ?? []) {
    try {
      for (const step of recentQuotaSteps(readFileSync(file, 'utf8'), clock())) skippedQuota.add(step);
    } catch {
      // Không đọc được thì không bỏ qua bước nào.
    }
  }
  const steps = interleaveProviders(targetSteps);
  const budget = new RequestBudget(options.budget ?? DEFAULT_REQUEST_BUDGET);
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastProvider: string | null = null;
  let lastAtMs: number | null = null;
  let consecutive429 = 0;
  let stoppedOn429 = false;

  log(`bước cần đo: ${steps.length} (giới hạn 70)`);
  if (skippedQuota.size > 0) log(`SKIPPED-QUOTA=${skippedQuota.size}`);
  const out: StepReliability[] = [];
  const skipped: string[] = [];
  for (const step of steps) {
    if (skippedQuota.has(step)) {
      log(`${step}\tSKIPPED-QUOTA\thttp=-\ttotal=0ms\tusage=-\tquota=1`);
      continue;
    }
    if (stoppedOn429 || clock() - t0 > budgetMs) {
      skipped.push(step);
      continue;
    }
    const provider = providerOf(step);
    const rows: ComboProbeRow[] = [];
    let exhausted = false;
    for (let round = 1; round <= rounds && !exhausted && !stoppedOn429; round += 1) {
      for (let i = 1; i <= repeat; i += 1) {
        if (consecutive429 >= maxConsecutive429) {
          stoppedOn429 = true;
          break;
        }
        const waitMs = providerDelayMs(lastProvider, provider, lastAtMs, clock());
        if (waitMs > 0) await sleep(waitMs);
        if (!budget.reserve(provider)) {
          if (rows.length === 0) skipped.push(step);
          exhausted = true;
          break;
        }
        lastProvider = provider;
        lastAtMs = clock();
        const r = await probeStep(step, {
          maxTokens: 8,
          timeoutMs: STEP_TIMEOUT_MS,
          key,
          now: clock,
          fetchImpl: options.fetchImpl,
          baseUrl: options.baseUrl,
        });
        rows.push(r);
        if (r.httpStatus === 429 || r.verdict === 'RATE-LIMITED') {
          consecutive429 += 1;
        } else {
          consecutive429 = 0;
        }
        if (consecutive429 >= maxConsecutive429) {
          stoppedOn429 = true;
          break;
        }
        if (i < repeat || round < rounds) await sleep(gapSec * 1000);
      }
    }
    if (rows.length === 0) continue;
    const summary = summarizeAttempts(step, rows);
    out.push(summary);
    const quotaRow = [...rows].reverse().find((r) => r.quota === true);
    const quotaTail = quotaRow ? `\tquota=1\tat=${quotaRow.startedAt ?? new Date(clock()).toISOString()}` : '';
    log(`${step}\t${summary.label}\tok=${summary.ok}/${summary.attempts}\tp90=${summary.p90 ?? '-'}ms${quotaTail}`);
  }
  if (stoppedOn429) log(`dừng sớm: ${maxConsecutive429} lần 429 liên tiếp`);
  if (skipped.length) log(`chưa đo: ${skipped.length} bước (hết ngân sách)`);
  log(budget.tally());
  return { steps: out, skipped, skippedQuota: [...skippedQuota], requests: budget.tally() };
}
