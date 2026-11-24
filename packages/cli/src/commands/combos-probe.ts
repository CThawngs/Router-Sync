/**
 * packages/cli/src/commands/combos-probe.ts
 *
 * C32 M1 / C33 N1-N2 / C43 R1.1 / C44 W2: try a combo the way a real client does.
 *
 * The default run is a dry run: it prints what would be called and stops. A
 * real request needs `--yes-spend-tokens`, because every call costs the owner
 * tokens.
 *
 * Two modes:
 *   --mode combo  send requests per combo, model = combo name (like a client)
 *   --mode step   send requests per unique step
 *
 * Nothing is written to the router: the 9Router database is opened read-only,
 * and the API key is read from it and never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { openBetterSqlite3, locateRouterDb } from '@routersync/core';
import {
  classifyStep,
  interleaveProviders,
  isQuotaBody,
  providerDelayMs,
  providerOf,
  recentQuotaSteps,
  reconcileSentVsUsage,
  RequestBudget,
  DEFAULT_REQUEST_BUDGET,
  type UsageReconciliation,
} from './combos-budget.js';

export type ProbeMode = 'combo' | 'step';

export type StepVerdict =
  | 'OK'
  | 'EOL-GONE'
  | 'NO-PROVIDER'
  | 'RATE-LIMITED'
  | 'AUTH'
  | 'TIMEOUT-NO-HEADER'
  | 'HANG-AFTER-USAGE'
  | 'ERROR-5XX'
  | 'ERROR';

/** C33 N1: verdict of a whole-combo attempt. */
export type ComboVerdict = 'OK' | 'SLOW-OK' | 'HANG-AFTER-USAGE' | 'HANG-NO-USAGE';

export interface VerdictInput {
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  /** First 200 characters of the response body, already redacted. */
  body?: string;
  /** True when response headers arrived before the deadline. */
  headerReceived: boolean;
  /** True when a new usageHistory row appeared during the call. */
  usageRowAdded: boolean;
  /** True when the client-side deadline expired. */
  timedOut: boolean;
}

const EOL_RE = /end of life|no longer available|reached its end|deprecated|not available anymore/i;
const NO_PROVIDER_RE = /no provider|no providers|no upstream|not served|nothing serves/i;

/** Ngưỡng "chậm": trên mức này, một combo có header vẫn được coi là chậm. */
export const SLOW_THRESHOLD_MS = 120_000;

/**
 * Pure classification of one probe attempt. Every branch is pinned by a test.
 *
 * C33 N2.1: a bare 503 without a matching message is `ERROR-5XX`, not
 * `NO-PROVIDER`: only a message that says "no provider serves this model"
 * proves absence. A 5xx that says nothing must not enter a removal list.
 */
export function perStepConclusion(input: VerdictInput): StepVerdict {
  if (input.timedOut && !input.headerReceived) {
    return input.usageRowAdded ? 'HANG-AFTER-USAGE' : 'TIMEOUT-NO-HEADER';
  }
  if (!input.headerReceived) {
    return input.status === null ? 'TIMEOUT-NO-HEADER' : 'ERROR-5XX';
  }
  if (input.status === 200) return 'OK';
  if (input.status === 429) return 'RATE-LIMITED';
  if (input.status === 401 || input.status === 403) return 'AUTH';

  const body = input.body ?? '';
  if (EOL_RE.test(body)) return 'EOL-GONE';
  if (input.status === 410) return 'EOL-GONE';
  if (NO_PROVIDER_RE.test(body)) return 'NO-PROVIDER';
  if (input.status !== null && input.status >= 500) return 'ERROR-5XX';
  return 'ERROR';
}

export interface ComboConclusionInput {
  /** Time from request start to response headers, or null when none arrived. */
  headerMs: number | null;
  /** When the deadline hit (client-side), in ms from request start. */
  deadlineMs: number;
  /** When the first usageHistory row appeared, or null. */
  firstUsageMs: number | null;
  timedOut: boolean;
}

/**
 * C33 N1.3: split "slow" from "hanging".
 */
export function perComboConclusion(input: ComboConclusionInput): ComboVerdict {
  if (input.headerMs !== null) {
    return input.headerMs > SLOW_THRESHOLD_MS ? 'SLOW-OK' : 'OK';
  }
  if (input.timedOut || input.headerMs === null) {
    return input.firstUsageMs === null ? 'HANG-NO-USAGE' : 'HANG-AFTER-USAGE';
  }
  return 'HANG-NO-USAGE';
}

export interface ComboInfo {
  name: string;
  steps: string[];
}

export interface RouterDb {
  combos: ComboInfo[];
  apiKey: string;
  apiKeyName: string;
}

function openRouterDb(dbPath?: string) {
  const explicit = dbPath?.trim() || process.env['ROUTERSYNC_9ROUTER_DB']?.trim();
  const file = explicit || locateRouterDb('9router');
  return openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
}

function resolveExistingDbPath(dbPath?: string, allowDefaultLocator = true): string | null {
  const explicit = dbPath?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const fromEnv = process.env['ROUTERSYNC_9ROUTER_DB']?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  if (!allowDefaultLocator) return null;
  try {
    const located = locateRouterDb('9router');
    return located && existsSync(located) ? located : null;
  } catch {
    return null;
  }
}

function parseSteps(raw: unknown): string[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.includes('/')) {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const provider = (rec['providerId'] ?? rec['provider'] ?? rec['prefix']) as string | undefined;
      const model = (rec['model'] ?? rec['modelId'] ?? rec['id']) as string | undefined;
      if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
        out.push(`${provider}/${model}`);
      }
    }
  }
  return out;
}

/** Read combo steps and one usable API key. Read-only; the key is never printed. */
export function readRouterState(dbPath?: string): RouterDb {
  let db;
  try {
    db = openRouterDb(dbPath);
  } catch (err) {
    throw new Error(
      `không mở được DB 9Router (${err instanceof Error ? err.message : String(err)}). Đặt ROUTERSYNC_9ROUTER_DB hoặc chạy trên máy có 9Router.`
    );
  }
  try {
    const rows = db.prepare('SELECT name, models FROM combos ORDER BY name').all() as Array<{
      name: string;
      models: string;
    }>;
    const combos = rows.map((r) => ({ name: r.name, steps: parseSteps(r.models) }));
    const keyRow = db
      .prepare('SELECT name, key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt LIMIT 1')
      .get() as { name: string; key: string } | undefined;
    if (!keyRow) throw new Error('no active api key in the 9Router database');
    return { combos, apiKey: keyRow.key, apiKeyName: keyRow.name };
  } finally {
    db.close();
  }
}

export interface ProbeOptions {
  mode?: ProbeMode | undefined;
  /** C33 N1: chọn nhiều combo bằng cách truyền cờ này nhiều lần. */
  combos?: string[] | undefined;
  combo?: string | undefined;
  all?: boolean | undefined;
  yesSpendTokens?: boolean | undefined;
  maxMinutes?: number | undefined;
  /** C33 N1: hạn cho mỗi combo, 1..600 giây. */
  comboTimeoutSec?: number | undefined;
  /** W1: hạn cắt mỗi combo (giây), mặc định 120 theo luật vòng. */
  stopAfterSec?: number | undefined;
  /** W1: đính kèm chiến lược combo vào báo cáo. */
  strategyReport?: boolean | undefined;
  /** C33 N2: chỉ thử các bước khớp regex. */
  only?: string | undefined;
  baseUrl?: string | undefined;
  state?: RouterDb | undefined;
  /** R1.1: đường dẫn DB SQLite của 9Router (hỗ trợ kiểm thử cô lập trong os.tmpdir()). */
  dbPath?: string | undefined;
  /** R1.1: số request đồng thời mỗi lượt ở mode combo (chỉ cho phép 1 hoặc 2, mặc định 1). */
  concurrency?: number | undefined;
  comboTimeoutMs?: number | undefined;
  stepTimeoutMs?: number | undefined;
  /** C34 Q2: ghi MỌI dòng usage mới (mặc định chỉ dòng đầu). */
  timeline?: boolean | undefined;
  /** C34 Q2: max_tokens cho mỗi request (mặc định 8, tối đa 64). */
  maxTokens?: number | undefined;
  /** C34 Q2: tắt stream (mặc định bật). */
  stream?: boolean | undefined;
  /** C34 Q3 / R1.1: lặp lại mỗi bước hoặc mỗi combo n lần. */
  repeat?: number | undefined;
  /** C40 X0: trần số request cho một lần chạy (mặc định 40). */
  budget?: number | undefined;
  /** C40 X0: tệp kết quả trước đó; bước 429/quota trong 30 phút qua bị bỏ qua. */
  skipQuotaFrom?: string[] | undefined;
  json?: boolean | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test hook: vòng lặp chờ (mặc định setTimeout). */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  usageCount?: (() => number) | undefined;
  log?: (line: string) => void | undefined;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:20128';
export const COMBO_TIMEOUT_MS = 120_000;
export const MAX_COMBO_TIMEOUT_MS = 600_000;
export const STEP_TIMEOUT_MS = 20_000;
export const MAX_CONSECUTIVE_429 = 5;
/** C33 N1: hỏi usageHistory mỗi 5 giây khi đang chờ combo. */
export const USAGE_POLL_MS = 5_000;
/** C34 Q2: hỏi dày hơn khi bật timeline. */
export const TIMELINE_POLL_MS = 1_000;
/** C34 Q2: trần max_tokens theo yêu cầu vòng này. */
export const MAX_TOKENS_LIMIT = 64;
export const DEFAULT_MAX_TOKENS = 8;

/** C34 Q2 / R1.1: một dòng usageHistory rút gọn (không có khoá). */
export interface UsageRow {
  atMs: number;
  provider: string;
  model: string;
  status: string | null;
  promptTokens?: number | null | undefined;
  completionTokens: number | null;
}

interface SqliteUsageDeltaRow extends UsageRow {
  id: number;
  promptTokens: number | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ComboProbeRow {
  combo: string;
  model: string;
  httpStatus: number | null;
  headerMs: number | null;
  firstByteMs: number | null;
  totalMs: number;
  /** Step verdict in step mode, combo verdict in combo mode. */
  verdict: StepVerdict | ComboVerdict;
  detail: string;
  usageServedBy: string | null;
  /** R1.1: tổng promptTokens số học của các dòng usageHistory mới trong lượt gọi (hoặc null). */
  promptTokens?: number | null | undefined;
  /** R1.1: tổng completionTokens số học của các dòng usageHistory mới trong lượt gọi (hoặc null). */
  completionTokens?: number | null | undefined;
  /** C33 N1: when the first usageHistory row appeared during this attempt. */
  firstUsageMs?: number | null;
  /** C34 Q2: mọi dòng usage mới trong lần gọi (chỉ khi bật timeline). */
  usageRows?: UsageRow[] | undefined;
  /** C40 X0: 429 do quota gói miễn phí, không phải 429 thường. */
  quota?: boolean | undefined;
  startedAt?: string;
}

export interface ProbeReport {
  generatedAt: string;
  mode: ProbeMode;
  baseUrl: string;
  apiKeyName: string;
  comboTimeoutSec: number;
  /** W1: chiến lược của từng combo (tên -> fallback|round-robin|mặc định). */
  strategies?: Record<string, string> | undefined;
  stoppedEarly: string | null;
  combos: string[];
  uniqueSteps: number;
  rows: ComboProbeRow[];
  /** C40 X0: bộ đếm request cuối lần chạy, chia theo provider. */
  requests?: { total: number; limit: number; byProvider: Record<string, number> } | undefined;
  /** C40 X0: bước bỏ qua vì đã 429/quota trong 30 phút qua. */
  skippedQuota?: string[] | undefined;
  /** C44 W2: đối chiếu số request đã gửi phía client và số dòng usageHistory mới. */
  reconciliation?: UsageReconciliation | undefined;
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<KEY>');
  // Không in chuỗi dài (có thể là khoá/đường dẫn cá nhân).
  out = out.replace(/[A-Za-z0-9_\-]{28,}/g, (m) => `<${m.length}>redacted`);
  return out.slice(0, 200);
}

function readMaxUsageId(dbPath?: string): number | null {
  try {
    const db = openRouterDb(dbPath);
    try {
      const row = db
        .prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM usageHistory')
        .get() as { maxId?: number | null } | undefined;
      return typeof row?.maxId === 'number' && Number.isFinite(row.maxId) ? row.maxId : 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readUsageSinceId(maxIdBefore: number, t0: number, dbPath?: string): SqliteUsageDeltaRow[] {
  try {
    const db = openRouterDb(dbPath);
    try {
      const rows = db
        .prepare(
          'SELECT id, timestamp, provider, model, status, promptTokens, completionTokens FROM usageHistory WHERE id > ? ORDER BY id ASC'
        )
        .all(maxIdBefore) as Array<{
        id: number;
        timestamp: string;
        provider: string;
        model: string;
        status: string | null;
        promptTokens: number | null;
        completionTokens: number | null;
      }>;
      return rows.map((r) => {
        const parsedTs = Date.parse(r.timestamp);
        return {
          id: r.id,
          atMs: Number.isFinite(parsedTs) ? Math.max(0, parsedTs - t0) : 0,
          provider: r.provider,
          model: r.model,
          status: r.status ?? null,
          promptTokens: typeof r.promptTokens === 'number' && Number.isFinite(r.promptTokens) ? r.promptTokens : null,
          completionTokens:
            typeof r.completionTokens === 'number' && Number.isFinite(r.completionTokens) ? r.completionTokens : null,
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function sumNullableNumbers(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((acc, v) => acc + v, 0);
}

function usageDelta(before: number, after: number, dbPath?: string): string | null {
  if (after <= before) return null;
  try {
    const db = openRouterDb(dbPath);
    try {
      const row = db
        .prepare('SELECT provider, model FROM usageHistory ORDER BY id DESC LIMIT 1')
        .get() as { provider: string; model: string } | undefined;
      return row ? `${row.provider}/${row.model}` : 'unknown';
    } finally {
      db.close();
    }
  } catch {
    return 'unknown';
  }
}

async function sendAndRead(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<{ headerMs: number | null; firstByteMs: number | null; status: number | null; text: string; timedOut: boolean; totalMs: number }> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headerMs = Date.now() - t0;
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      const first = await reader.read();
      const firstByteMs = Date.now() - t0;
      const text = decoder.decode(first.value ?? new Uint8Array());
      await reader.cancel().catch(() => undefined);
      return { headerMs, firstByteMs, status: res.status, text, timedOut: false, totalMs: Date.now() - t0 };
    }
    const text = (await res.text()).slice(0, 400);
    return { headerMs, firstByteMs: Date.now() - t0, status: res.status, text, timedOut: false, totalMs: Date.now() - t0 };
  } catch (err) {
    return { headerMs: null, firstByteMs: null, status: null, text: err instanceof Error ? err.message : String(err), timedOut: true, totalMs: Date.now() - t0 };
  }
}

/** C33 N1: step mode call (unchanged shape, plus startedAt). */
async function callOnce(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  usageCount: () => number,
  dbPath?: string
): Promise<{ row: Omit<ComboProbeRow, 'combo'> }> {
  const startedAt = new Date().toISOString();
  const before = usageCount();
  const res = await sendAndRead(url, apiKey, body, timeoutMs, fetchImpl);
  const after = usageCount();
  const usageRowAdded = after > before;
  const detail = redact(res.text, [apiKey]);
  const rawVerdict = perStepConclusion({
    status: res.status,
    body: detail,
    headerReceived: res.headerMs !== null,
    usageRowAdded,
    timedOut: res.timedOut,
  });
  const classified = classifyStep({ verdict: rawVerdict, body: detail });
  return {
    row: {
      model: '',
      startedAt,
      httpStatus: res.status,
      headerMs: res.headerMs,
      firstByteMs: res.firstByteMs,
      totalMs: res.totalMs,
      verdict: classified.verdict as ComboProbeRow['verdict'],
      quota: classified.quota,
      detail,
      usageServedBy: usageRowAdded ? usageDelta(before, after, dbPath) : null,
      firstUsageMs: null,
    },
  };
}

/**
 * C33 N1.2 / C44 W2: combo mode call that polls `usageHistory` every `pollMs` while it
 * waits, so the verdict can separate "slow" from "hanging", and preserves `quota` on HTTP 429.
 */
export async function callComboWithUsage(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  usageCount: () => number,
  pollMs = USAGE_POLL_MS,
  sleepImpl: (ms: number) => Promise<void> = defaultSleep,
  clock: () => number = Date.now,
  usageRows: (t0: number) => UsageRow[] = () => [],
  timeline = false,
  dbPath?: string | undefined
): Promise<{ row: Omit<ComboProbeRow, 'combo'>; firstUsageMs: number | null; usage: UsageRow[] }> {
  const startedAt = new Date().toISOString();
  const t0 = clock();
  const before = usageCount();
  let firstUsageMs: number | null = null;
  let stopped = false;
  const usage: UsageRow[] = [];
  const seen = new Set<string>();

  const collect = (startMs: number) => {
    const rows = usageRows(startMs);
    for (const r of rows) {
      const maybeId = (r as Partial<SqliteUsageDeltaRow>).id;
      const dedupeKey = typeof maybeId === 'number' ? `id:${maybeId}` : `at:${r.atMs}:${r.provider}/${r.model}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const cleanRow: UsageRow = {
        atMs: r.atMs,
        provider: r.provider,
        model: r.model,
        status: r.status,
        completionTokens: r.completionTokens,
        ...(r.promptTokens !== undefined ? { promptTokens: r.promptTokens } : {}),
      };
      usage.push(cleanRow);
    }
    if (usage.length > 0 && firstUsageMs === null) {
      firstUsageMs = usage[0]?.atMs ?? clock() - t0;
    }
  };

  let wakePoll: (() => void) | null = null;
  const waitPoll = (ms: number): Promise<void> => {
    if (sleepImpl !== defaultSleep) return sleepImpl(ms);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakePoll = null;
        resolve();
      }, ms);
      wakePoll = () => {
        clearTimeout(timer);
        wakePoll = null;
        resolve();
      };
    });
  };

  const poll = (async () => {
    while (!stopped) {
      await waitPoll(pollMs);
      if (stopped) return;
      if (timeline) collect(t0);
      else if (usageCount() > before && firstUsageMs === null) {
        firstUsageMs = clock() - t0;
        return;
      }
      if (clock() - t0 > timeoutMs) return;
    }
  })();

  const res = await sendAndRead(url, apiKey, body, timeoutMs, fetchImpl);
  stopped = true;
  if (wakePoll !== null) (wakePoll as () => void)();
  await poll.catch(() => undefined);
  if (timeline) collect(t0);
  if (firstUsageMs === null && usageCount() > before) firstUsageMs = clock() - t0;

  const after = usageCount();
  const usageRowAdded = after > before;
  const detail = redact(res.text, [apiKey]);
  const quota = res.status === 429 && isQuotaBody(detail);
  const verdict = perComboConclusion({
    headerMs: res.headerMs,
    deadlineMs: timeoutMs,
    firstUsageMs,
    timedOut: res.timedOut,
  });

  return {
    row: {
      model: '',
      startedAt,
      httpStatus: res.status,
      headerMs: res.headerMs,
      firstByteMs: res.firstByteMs,
      totalMs: res.totalMs,
      verdict,
      quota,
      detail,
      usageServedBy: usageRowAdded ? usageDelta(before, after, dbPath) : null,
      promptTokens: sumNullableNumbers(usage.map((u) => u.promptTokens)),
      completionTokens: sumNullableNumbers(usage.map((u) => u.completionTokens)),
      firstUsageMs,
      usageRows: timeline ? usage : undefined,
    },
    firstUsageMs,
    usage,
  };
}

function selectCombos(state: RouterDb, options: ProbeOptions): ComboInfo[] {
  const wanted = options.combos && options.combos.length > 0 ? options.combos : options.combo ? [options.combo] : [];
  if (wanted.length === 0) return options.all === false ? [] : state.combos;
  const picked: ComboInfo[] = [];
  for (const name of wanted) {
    const hit = state.combos.filter((c) => c.name === name);
    if (hit.length === 0) {
      throw new Error(`unknown combo "${name}"; known: ${state.combos.map((c) => c.name).join(', ')}`);
    }
    picked.push(...hit);
  }
  return picked;
}

function uniqueSteps(combos: ComboInfo[]): string[] {
  const seen = new Set<string>();
  for (const c of combos) for (const s of c.steps) seen.add(s);
  return [...seen].sort();
}

function comboTimeoutFor(options: ProbeOptions): number {
  if (typeof options.stopAfterSec === 'number' && options.stopAfterSec > 0) return Math.floor(options.stopAfterSec) * 1000;
  if (typeof options.comboTimeoutMs === 'number') return options.comboTimeoutMs;
  const sec = options.comboTimeoutSec ?? COMBO_TIMEOUT_MS / 1000;
  const bounded = Math.min(MAX_COMBO_TIMEOUT_MS / 1000, Math.max(1, Math.floor(sec)));
  return bounded * 1000;
}

function readComboStrategies(dbPath?: string): Record<string, string> {
  try {
    const db = openRouterDb(dbPath);
    try {
      const combos = db.prepare('SELECT name FROM combos ORDER BY name').all() as Array<{ name: string }>;
      const raw = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data?: string } | undefined;
      const settings = raw?.data ? JSON.parse(raw.data) : {};
      const map = settings.comboStrategies ?? {};
      const out: Record<string, string> = {};
      for (const c of combos) {
        const v = map[c.name];
        out[c.name] = v && typeof v === 'object' && v.fallbackStrategy ? String(v.fallbackStrategy) : 'mặc định';
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

function printDryRun(
  state: RouterDb,
  combos: ComboInfo[],
  baseUrl: string,
  comboTimeoutMs: number,
  log: (l: string) => void
): void {
  const steps = uniqueSteps(combos);
  const perCombo = combos.reduce((n, c) => n + c.steps.length, 0);
  const longestComboSteps = Math.max(0, ...combos.map((c) => c.steps.length));
  const comboBudget = (combos.length * comboTimeoutMs) / 1000;
  const stepBudget = (steps.length * STEP_TIMEOUT_MS) / 1000;
  log(`baseUrl=${baseUrl}`);
  log(`apiKey=${state.apiKeyName} (giá trị không in)`);
  log(`combos=${combos.length} steps_theo_combo=${perCombo} unique_steps=${steps.length}`);
  log(
    `ước tính tối đa: combo = ${combos.length} × ${comboTimeoutMs / 1000}s = ${comboBudget}s (mỗi combo tối đa ${comboTimeoutMs / 1000}s, combo dài nhất có ${longestComboSteps} bước); step = ${steps.length} × ${STEP_TIMEOUT_MS / 1000}s = ${stepBudget}s`
  );
  log('Đây là chạy thử: không có request nào được gửi.');
  log('Muốn chạy thật: thêm --yes-spend-tokens (tốn token của chủ dự án).');
}

export async function runCombosProbeCommand(options: ProbeOptions = {}): Promise<ProbeReport> {
  const concurrency = options.concurrency === undefined ? 1 : options.concurrency;
  if (concurrency !== 1 && concurrency !== 2) {
    throw new Error('--concurrency must be 1 or 2');
  }

  const log = options.log ?? ((line: string) => console.log(line));
  const baseUrl = options.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
  const mode: ProbeMode = options.mode ?? 'combo';
  const comboTimeoutMs = comboTimeoutFor(options);
  const maxTokens = Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS)));
  const startedAt = new Date().toISOString();

  const state = options.state ?? readRouterState(options.dbPath);
  const combos = selectCombos(state, options);
  if (combos.length === 0) throw new Error('no combo selected');

  // C40 X0: bước hoặc combo đã 429/quota trong tệp kết quả gần đây thì không gửi lại.
  const skipNow = (options.now ?? Date.now)();
  const skippedQuota = new Set<string>();
  for (const file of options.skipQuotaFrom ?? []) {
    try {
      for (const step of recentQuotaSteps(readFileSync(file, 'utf8'), skipNow)) skippedQuota.add(step);
    } catch {
      // Tệp không đọc được → không bỏ qua bước nào; vẫn ghi rõ trong báo cáo.
    }
  }

  if (!options.yesSpendTokens) {
    printDryRun(state, combos, baseUrl, comboTimeoutMs, log);
    return {
      generatedAt: new Date().toISOString(),
      mode,
      baseUrl,
      apiKeyName: state.apiKeyName,
      comboTimeoutSec: comboTimeoutMs / 1000,
      strategies: options.strategyReport === true ? readComboStrategies(options.dbPath) : undefined,
      stoppedEarly: 'dry-run',
      combos: combos.map((c) => c.name),
      uniqueSteps: uniqueSteps(combos).length,
      rows: [],
      skippedQuota: [...skippedQuota],
      requests: { total: 0, limit: options.budget ?? DEFAULT_REQUEST_BUDGET, byProvider: {} },
    };
  }

  const clock = options.now ?? Date.now;
  const deadline = clock() + (options.maxMinutes ?? 40) * 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolvedDbPath = resolveExistingDbPath(options.dbPath, !options.state);
  const hasDbSource = resolvedDbPath !== null;
  const canReconcileUsage = hasDbSource || typeof options.usageCount === 'function';

  const usageCount =
    options.usageCount ??
    (() => {
      if (!hasDbSource) return 0;
      try {
        const db = openRouterDb(resolvedDbPath ?? options.dbPath);
        try {
          return (db.prepare('SELECT COUNT(*) n FROM usageHistory').get() as { n: number }).n;
        } finally {
          db.close();
        }
      } catch {
        return 0;
      }
    });

  const usageTotalBefore = canReconcileUsage ? usageCount() : 0;
  const rows: ComboProbeRow[] = [];
  let consecutive429 = 0;
  let stoppedEarly: string | null = null;
  const secrets = [state.apiKey];
  const budget = new RequestBudget(options.budget ?? DEFAULT_REQUEST_BUDGET);
  let lastProvider: string | null = null;
  let lastRequestAtMs: number | null = null;

  const applyDeltaRows = (
    out: { row: ComboProbeRow; firstUsageMs: number | null; usage: UsageRow[] },
    deltaRows: SqliteUsageDeltaRow[]
  ) => {
    out.row.promptTokens = sumNullableNumbers(deltaRows.map((r) => r.promptTokens));
    out.row.completionTokens = sumNullableNumbers(deltaRows.map((r) => r.completionTokens));
    const lastRow = deltaRows.at(-1);
    out.row.usageServedBy = lastRow ? `${lastRow.provider}/${lastRow.model}` : null;
    if (options.timeline === true) {
      const clean = deltaRows.map(({ id: _id, ...rest }) => rest);
      out.usage = clean;
      out.row.usageRows = clean;
    }
  };

  const dbTarget = resolvedDbPath ?? options.dbPath;

  const invokeComboAttempt = async (comboName: string, skipDeltaQuery = false) => {
    const attemptStartMs = clock();
    const maxUsageIdBefore = hasDbSource ? readMaxUsageId(dbTarget) : null;
    const attemptUsageCount =
      options.usageCount ??
      (maxUsageIdBefore !== null ? () => readMaxUsageId(dbTarget) ?? maxUsageIdBefore : usageCount);
    const attemptUsageRows =
      options.timeline === true && maxUsageIdBefore !== null
        ? (t0: number): UsageRow[] => readUsageSinceId(maxUsageIdBefore, t0, dbTarget)
        : (_t0: number): UsageRow[] => [];

    const result = await callComboWithUsage(
      `${baseUrl}/v1/chat/completions`,
      state.apiKey,
      {
        model: comboName,
        messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }],
        max_tokens: maxTokens,
        stream: options.stream !== false,
      },
      comboTimeoutMs,
      fetchImpl,
      attemptUsageCount,
      options.timeline === true ? TIMELINE_POLL_MS : USAGE_POLL_MS,
      options.sleepImpl,
      clock,
      attemptUsageRows,
      options.timeline === true,
      hasDbSource ? dbTarget : undefined
    );

    let promptTokens = result.row.promptTokens ?? null;
    let completionTokens = result.row.completionTokens ?? null;
    let usageServedBy = result.row.usageServedBy;
    let timelineUsage = result.usage;

    if (maxUsageIdBefore !== null && !skipDeltaQuery) {
      const deltaRows = readUsageSinceId(maxUsageIdBefore, attemptStartMs, dbTarget);
      promptTokens = sumNullableNumbers(deltaRows.map((r) => r.promptTokens));
      completionTokens = sumNullableNumbers(deltaRows.map((r) => r.completionTokens));
      const lastRow = deltaRows.at(-1);
      if (lastRow) {
        usageServedBy = `${lastRow.provider}/${lastRow.model}`;
      }
      if (options.timeline === true) {
        timelineUsage = deltaRows.map(({ id: _id, ...rest }) => rest);
      }
    }

    const row: ComboProbeRow = {
      combo: comboName,
      ...result.row,
      model: comboName,
      usageServedBy,
      promptTokens,
      completionTokens,
      usageRows: options.timeline === true ? timelineUsage : undefined,
    };
    return { row, firstUsageMs: result.firstUsageMs, usage: timelineUsage };
  };

  const recordComboAttempt = (out: Awaited<ReturnType<typeof invokeComboAttempt>>) => {
    if (out.row.httpStatus === 429) consecutive429 += 1;
    else consecutive429 = 0;
    rows.push(out.row);
    if (options.timeline === true) {
      for (const u of out.usage) {
        log(
          `  usage@${u.atMs}ms ${u.provider}/${u.model} status=${u.status ?? '-'} tokens_in=${u.promptTokens ?? '-'} tokens_out=${u.completionTokens ?? '-'}`
        );
      }
    }
    const quotaTail = out.row.quota === true ? `\tquota=1\tat=${out.row.startedAt ?? ''}` : '';
    log(
      `${out.row.combo}\t${out.row.verdict}\thttp=${out.row.httpStatus ?? '-'}\theader=${out.row.headerMs ?? '-'}ms\tfirstByte=${out.row.firstByteMs ?? '-'}ms\ttotal=${out.row.totalMs}ms\ttokens_in=${out.row.promptTokens ?? '-'}\tusageAt=${out.firstUsageMs ?? '-'}ms\tusage=${out.row.usageServedBy ?? 'không có dòng usage'}${quotaTail}`
    );
  };

  if (mode === 'combo') {
    const comboRepeats = Math.min(20, Math.max(1, Math.floor(options.repeat ?? 1)));
    for (const combo of combos) {
      if (
        skippedQuota.has(combo.name) ||
        (combo.steps.length > 0 && combo.steps.every((s) => skippedQuota.has(s)))
      ) {
        skippedQuota.add(combo.name);
        log(`${combo.name}\tSKIPPED-QUOTA\thttp=-\ttotal=0ms\tusage=-\tquota=1`);
        continue;
      }
      for (let rep = 1; rep <= comboRepeats; rep += 1) {
        if (clock() > deadline) {
          stoppedEarly = 'max-minutes';
          break;
        }
        if (consecutive429 >= MAX_CONSECUTIVE_429) {
          stoppedEarly = `${MAX_CONSECUTIVE_429} lần 429 liên tiếp`;
          break;
        }
        if (concurrency === 2) {
          if (budget.limit - budget.count < 2) {
            stoppedEarly = `budget=${budget.limit}`;
            break;
          }
          budget.reserve(combo.name);
          budget.reserve(combo.name);
          lastProvider = combo.name;
          lastRequestAtMs = clock();
          const pairStartMs = clock();
          const pairMaxIdBefore = hasDbSource ? readMaxUsageId(dbTarget) : null;
          const [outA, outB] = await Promise.all([
            invokeComboAttempt(combo.name, pairMaxIdBefore !== null),
            invokeComboAttempt(combo.name, pairMaxIdBefore !== null),
          ]);
          if (pairMaxIdBefore !== null) {
            const pairDelta = readUsageSinceId(pairMaxIdBefore, pairStartMs, dbTarget);
            const mid = pairDelta.length <= 1 ? pairDelta.length : Math.ceil(pairDelta.length / 2);
            applyDeltaRows(outA, pairDelta.slice(0, mid));
            applyDeltaRows(outB, pairDelta.slice(mid));
          }
          recordComboAttempt(outA);
          recordComboAttempt(outB);
        } else {
          if (!budget.reserve(combo.name)) {
            stoppedEarly = `budget=${budget.limit}`;
            break;
          }
          lastProvider = combo.name;
          lastRequestAtMs = clock();
          const out = await invokeComboAttempt(combo.name);
          recordComboAttempt(out);
        }
      }
      if (stoppedEarly) break;
    }
  } else {
    const selected = uniqueSteps(combos).filter((s) => (options.only ? new RegExp(options.only).test(s) : true));
    const steps = interleaveProviders(selected);
    const repeat = Math.min(10, Math.max(1, Math.floor(options.repeat ?? 1)));
    for (const step of steps) {
      if (skippedQuota.has(step)) {
        log(`${step}\tSKIPPED-QUOTA\thttp=-\ttotal=0ms\tusage=-\tquota=1`);
        continue;
      }
      for (let attempt = 1; attempt <= repeat; attempt += 1) {
        if (clock() > deadline) {
          stoppedEarly = 'max-minutes';
          break;
        }
        if (consecutive429 >= MAX_CONSECUTIVE_429) {
          stoppedEarly = `${MAX_CONSECUTIVE_429} lần 429 liên tiếp`;
          break;
        }
        const provider = providerOf(step);
        const waitMs = providerDelayMs(lastProvider, provider, lastRequestAtMs, clock());
        if (waitMs > 0) await (options.sleepImpl ?? defaultSleep)(waitMs);
        if (!budget.reserve(provider)) {
          stoppedEarly = `budget=${budget.limit}`;
          break;
        }
        lastProvider = provider;
        lastRequestAtMs = clock();
        const result = await callOnce(
          `${baseUrl}/v1/chat/completions`,
          state.apiKey,
          {
            model: step,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: maxTokens,
            stream: options.stream !== false,
          },
          options.stepTimeoutMs ?? STEP_TIMEOUT_MS,
          fetchImpl,
          usageCount,
          hasDbSource ? dbTarget : undefined
        );
        if (result.row.verdict === 'RATE-LIMITED') consecutive429 += 1;
        else consecutive429 = 0;
        rows.push({ combo: '(step)', ...result.row, model: repeat > 1 ? `${step}#${attempt}` : step });
        const label = repeat > 1 ? `${step}#${attempt}` : step;
        const quotaTail = result.row.quota === true ? `\tquota=1\tat=${result.row.startedAt ?? ''}` : '';
        log(
          `${label}\t${result.row.verdict}\thttp=${result.row.httpStatus ?? '-'}\ttotal=${result.row.totalMs}ms\tusage=${result.row.usageServedBy ?? 'không có dòng usage'}${quotaTail}`
        );
      }
      if (stoppedEarly) break;
    }
  }

  const usageTotalAfter = canReconcileUsage ? usageCount() : 0;
  const reconciliation = canReconcileUsage
    ? reconcileSentVsUsage(budget.count, Math.max(0, usageTotalAfter - usageTotalBefore))
    : undefined;

  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    mode,
    baseUrl,
    apiKeyName: state.apiKeyName,
    comboTimeoutSec: comboTimeoutMs / 1000,
    strategies: options.strategyReport === true ? readComboStrategies(options.dbPath) : undefined,
    stoppedEarly,
    combos: combos.map((c) => c.name),
    uniqueSteps: uniqueSteps(combos).length,
    rows,
    skippedQuota: [...skippedQuota],
    requests: {
      total: budget.count,
      limit: budget.limit,
      byProvider: budget.byProviderObject(),
    },
    ...(reconciliation !== undefined ? { reconciliation } : {}),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const tally = new Map<string, number>();
    for (const r of rows) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
    log('');
    log(`bắt đầu=${startedAt} tổng=${rows.length} ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (skippedQuota.size > 0) log(`SKIPPED-QUOTA=${skippedQuota.size}`);
    log(budget.tally());
    if (report.reconciliation) {
      log(
        `đối chiếu usage: sent=${report.reconciliation.sentRequests} usageHistory=${report.reconciliation.usageHistoryRows} lệch=${report.reconciliation.delta}`
      );
    }
    if (stoppedEarly) log(`dừng sớm: ${stoppedEarly}`);
  }
  void secrets;
  return report;
}

export { redact };
