/**
 * packages/cli/src/commands/combos-probe.ts
 *
 * C32 M1 / C33 N1-N2: try a combo the way a real client does.
 *
 * The default run is a dry run: it prints what would be called and stops. A
 * real request needs `--yes-spend-tokens`, because every call costs the owner
 * tokens.
 *
 * Two modes:
 *   --mode combo  send one request per combo, model = combo name (like a client)
 *   --mode step   send one request per unique step, max_tokens = 1
 *
 * C33 N1: combo mode polls `usageHistory` while it waits, so "slow" (header
 * after 120 s) is separated from "hanging" (no header, with or without an
 * upstream usage row).
 *
 * Nothing is written to the router: the 9Router database is opened read-only,
 * and the API key is read from it and never printed.
 */
import { openBetterSqlite3, locateRouterDb } from '@routersync/core';

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
    // The router answered nothing, but may still have done the upstream work.
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
 *
 * - header before the deadline: OK, or SLOW-OK when it took longer than the
 *   C32 threshold (120 s).
 * - no header by the deadline: HANG-AFTER-USAGE when upstream did the work
 *   (usage row seen) and HANG-NO-USAGE when it did not.
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

function openRouterDb() {
  const file = locateRouterDb('9router');
  return openBetterSqlite3(file, { readOnly: true, busyTimeoutMs: 5000 });
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
export function readRouterState(): RouterDb {
  let db;
  try {
    db = openRouterDb();
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
  /** C33 N2: chỉ thử các bước khớp regex. */
  only?: string | undefined;
  baseUrl?: string | undefined;
  state?: RouterDb | undefined;
  comboTimeoutMs?: number | undefined;
  stepTimeoutMs?: number | undefined;
  /** C34 Q2: ghi MỌI dòng usage mới (mặc định chỉ dòng đầu). */
  timeline?: boolean | undefined;
  /** C34 Q2: max_tokens cho mỗi request (mặc định 8, tối đa 64). */
  maxTokens?: number | undefined;
  /** C34 Q2: tắt stream (mặc định bật). */
  stream?: boolean | undefined;
  /** C34 Q3: mode step, lặp lại mỗi bước n lần. */
  repeat?: number | undefined;
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

/** C34 Q2: một dòng usageHistory rút gọn (không có khoá). */
export interface UsageRow {
  atMs: number;
  provider: string;
  model: string;
  status: string | null;
  completionTokens: number | null;
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
  /** C33 N1: when the first usageHistory row appeared during this attempt. */
  firstUsageMs?: number | null;
  /** C34 Q2: mọi dòng usage mới trong lần gọi (chỉ khi bật timeline). */
  usageRows?: UsageRow[] | undefined;
  startedAt?: string;
}

export interface ProbeReport {
  generatedAt: string;
  mode: ProbeMode;
  baseUrl: string;
  apiKeyName: string;
  comboTimeoutSec: number;
  stoppedEarly: string | null;
  combos: string[];
  uniqueSteps: number;
  rows: ComboProbeRow[];
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<KEY>');
  // Không in chuỗi dài (có thể là khoá/đường dẫn cá nhân).
  out = out.replace(/[A-Za-z0-9_\-]{28,}/g, (m) => `<${m.length}>redacted`);
  return out.slice(0, 200);
}

function usageDelta(before: number, after: number): string | null {
  if (after <= before) return null;
  try {
    const db = openRouterDb();
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
  usageCount: () => number
): Promise<{ row: Omit<ComboProbeRow, 'combo'> }> {
  const startedAt = new Date().toISOString();
  const before = usageCount();
  const res = await sendAndRead(url, apiKey, body, timeoutMs, fetchImpl);
  const after = usageCount();
  const usageRowAdded = after > before;
  return {
    row: {
      model: '',
      startedAt,
      httpStatus: res.status,
      headerMs: res.headerMs,
      firstByteMs: res.firstByteMs,
      totalMs: res.totalMs,
      verdict: perStepConclusion({
        status: res.status,
        body: redact(res.text, [apiKey]),
        headerReceived: res.headerMs !== null,
        usageRowAdded,
        timedOut: res.timedOut,
      }),
      detail: redact(res.text, [apiKey]),
      usageServedBy: usageRowAdded ? usageDelta(before, after) : null,
      firstUsageMs: null,
    },
  };
}

/**
 * C33 N1.2: combo mode call that polls `usageHistory` every `pollMs` while it
 * waits, so the verdict can separate "slow" from "hanging".
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
  timeline = false
): Promise<{ row: Omit<ComboProbeRow, 'combo'>; firstUsageMs: number | null; usage: UsageRow[] }> {
  const startedAt = new Date().toISOString();
  const t0 = clock();
  const before = usageCount();
  let firstUsageMs: number | null = null;
  let stopped = false;
  const usage: UsageRow[] = [];
  const seen = new Set<number>();

  const collect = (t0: number) => {
    const rows = usageRows(t0);
    for (const r of rows) {
      if (seen.has(r.atMs)) continue;
      seen.add(r.atMs);
      usage.push(r);
    }
    if (usage.length > 0 && firstUsageMs === null) {
      firstUsageMs = usage[0]?.atMs ?? clock() - t0;
    }
  };

  const poll = (async () => {
    while (!stopped) {
      await sleepImpl(pollMs);
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
  await poll.catch(() => undefined);
  if (timeline) collect(t0);
  if (firstUsageMs === null && usageCount() > before) firstUsageMs = clock() - t0;

  const after = usageCount();
  const usageRowAdded = after > before;
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
      detail: redact(res.text, [apiKey]),
      usageServedBy: usageRowAdded ? usageDelta(before, after) : null,
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
  if (typeof options.comboTimeoutMs === 'number') return options.comboTimeoutMs;
  const sec = options.comboTimeoutSec ?? COMBO_TIMEOUT_MS / 1000;
  const bounded = Math.min(MAX_COMBO_TIMEOUT_MS / 1000, Math.max(1, Math.floor(sec)));
  return bounded * 1000;
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
  const log = options.log ?? ((line: string) => console.log(line));
  const baseUrl = options.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
  const mode: ProbeMode = options.mode ?? 'combo';
  const comboTimeoutMs = comboTimeoutFor(options);
  const maxTokens = Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS)));
  const startedAt = new Date().toISOString();

  const state = options.state ?? readRouterState();
  const combos = selectCombos(state, options);
  if (combos.length === 0) throw new Error('no combo selected');

  if (!options.yesSpendTokens) {
    printDryRun(state, combos, baseUrl, comboTimeoutMs, log);
    return {
      generatedAt: new Date().toISOString(),
      mode,
      baseUrl,
      apiKeyName: state.apiKeyName,
      comboTimeoutSec: comboTimeoutMs / 1000,
      stoppedEarly: 'dry-run',
      combos: combos.map((c) => c.name),
      uniqueSteps: uniqueSteps(combos).length,
      rows: [],
    };
  }

  const clock = options.now ?? Date.now;
  const deadline = clock() + (options.maxMinutes ?? 40) * 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // Mặc định: đọc usageHistory của 9Router. Khi máy không có DB router (CI, hoặc
  // người dùng ở máy khác), trả 0 thay vì ném lỗi: phần đối chiếu "ai phục vụ"
  // chỉ là phụ, không được làm chết cả lần đo.
  const usageCount =
    options.usageCount ??
    (() => {
      try {
        const db = openRouterDb();
        try {
          return (db.prepare('SELECT COUNT(*) n FROM usageHistory').get() as { n: number }).n;
        } finally {
          db.close();
        }
      } catch {
        return 0;
      }
    });

  // C34 Q2: đọc mọi dòng usage mới (provider, model, status, token ra).
  const usageRows =
    options.timeline === true
      ? (t0: number): UsageRow[] => {
          try {
            const db = openRouterDb();
            try {
              const rows = db
                .prepare(
                  'SELECT timestamp, provider, model, status, completionTokens FROM usageHistory ORDER BY id DESC LIMIT 200'
                )
                .all() as Array<{ timestamp: string; provider: string; model: string; status: string | null; completionTokens: number | null }>;
              return rows
                .map((r) => ({
                  atMs: Date.parse(r.timestamp) - t0,
                  provider: r.provider,
                  model: r.model,
                  status: r.status ?? null,
                  completionTokens: typeof r.completionTokens === 'number' ? r.completionTokens : null,
                }))
                .filter((r) => Number.isFinite(r.atMs) && r.atMs >= 0)
                .sort((a, b) => a.atMs - b.atMs);
            } finally {
              db.close();
            }
          } catch {
            return [];
          }
        }
      : (_t0: number): UsageRow[] => [];

  const rows: ComboProbeRow[] = [];
  let consecutive429 = 0;
  let stoppedEarly: string | null = null;
  const secrets = [state.apiKey];

  if (mode === 'combo') {
    for (const combo of combos) {
      if (clock() > deadline) {
        stoppedEarly = 'max-minutes';
        break;
      }
      if (consecutive429 >= MAX_CONSECUTIVE_429) {
        stoppedEarly = `${MAX_CONSECUTIVE_429} lần 429 liên tiếp`;
        break;
      }
      const result = await callComboWithUsage(
        `${baseUrl}/v1/chat/completions`,
        state.apiKey,
        {
          model: combo.name,
          messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }],
          max_tokens: maxTokens,
          stream: options.stream !== false,
        },
        comboTimeoutMs,
        fetchImpl,
        usageCount,
        options.timeline === true ? TIMELINE_POLL_MS : USAGE_POLL_MS,
        options.sleepImpl,
        clock,
        usageRows,
        options.timeline === true
      );
      if (result.row.httpStatus === 429) consecutive429 += 1;
      else consecutive429 = 0;
      rows.push({ combo: combo.name, ...result.row, model: combo.name });
      if (options.timeline === true) {
        for (const u of result.usage) {
          log(`  usage@${u.atMs}ms ${u.provider}/${u.model} status=${u.status ?? '-'} tokens_out=${u.completionTokens ?? '-'}`);
        }
      }
      log(
        `${combo.name}\t${result.row.verdict}\thttp=${result.row.httpStatus ?? '-'}\theader=${result.row.headerMs ?? '-'}ms\tfirstByte=${result.row.firstByteMs ?? '-'}ms\ttotal=${result.row.totalMs}ms\tusageAt=${result.firstUsageMs ?? '-'}ms\tusage=${result.row.usageServedBy ?? 'không có dòng usage'}`
      );
    }
  } else {
    const steps = uniqueSteps(combos).filter((s) => (options.only ? new RegExp(options.only).test(s) : true));
    const repeat = Math.min(10, Math.max(1, Math.floor(options.repeat ?? 1)));
    for (const step of steps) {
      for (let attempt = 1; attempt <= repeat; attempt += 1) {
      if (clock() > deadline) {
        stoppedEarly = 'max-minutes';
        break;
      }
      if (consecutive429 >= MAX_CONSECUTIVE_429) {
        stoppedEarly = `${MAX_CONSECUTIVE_429} lần 429 liên tiếp`;
        break;
      }
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
        usageCount
      );
      if (result.row.verdict === 'RATE-LIMITED') consecutive429 += 1;
      else consecutive429 = 0;
      rows.push({ combo: '(step)', ...result.row, model: repeat > 1 ? `${step}#${attempt}` : step });
      log(
        `${repeat > 1 ? `${step}#${attempt}` : step}\t${result.row.verdict}\thttp=${result.row.httpStatus ?? '-'}\ttotal=${result.row.totalMs}ms\tusage=${result.row.usageServedBy ?? 'không có dòng usage'}`
      );
      }
    }
  }

  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    mode,
    baseUrl,
    apiKeyName: state.apiKeyName,
    comboTimeoutSec: comboTimeoutMs / 1000,
    stoppedEarly,
    combos: combos.map((c) => c.name),
    uniqueSteps: uniqueSteps(combos).length,
    rows,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const tally = new Map<string, number>();
    for (const r of rows) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
    log('');
    log(`bắt đầu=${startedAt} tổng=${rows.length} ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (stoppedEarly) log(`dừng sớm: ${stoppedEarly}`);
  }
  void secrets;
  return report;
}

export { redact };