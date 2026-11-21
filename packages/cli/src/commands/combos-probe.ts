/**
 * packages/cli/src/commands/combos-probe.ts
 *
 * C32 M1: try a combo the way a real client does.
 *
 * The default run is a dry run: it prints what would be called and stops. A
 * real request needs `--yes-spend-tokens`, because every call costs the owner
 * tokens.
 *
 * Two modes:
 *   --mode combo  send one request per combo, model = combo name (like a client)
 *   --mode step   send one request per unique step, max_tokens = 1
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
  | 'ERROR';

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

/**
 * Pure classification of one probe attempt. Every branch is pinned by a test.
 */
export function perStepConclusion(input: VerdictInput): StepVerdict {
  if (input.timedOut && !input.headerReceived) {
    // The router answered nothing, but may still have done the upstream work.
    return input.usageRowAdded ? 'HANG-AFTER-USAGE' : 'TIMEOUT-NO-HEADER';
  }
  if (!input.headerReceived) {
    return input.status === null ? 'TIMEOUT-NO-HEADER' : 'ERROR';
  }
  if (input.status === 200) return 'OK';
  if (input.status === 429) return 'RATE-LIMITED';
  if (input.status === 401 || input.status === 403) return 'AUTH';

  const body = input.body ?? '';
  if (EOL_RE.test(body)) return 'EOL-GONE';
  if (input.status === 410) return 'EOL-GONE';
  if (NO_PROVIDER_RE.test(body)) return 'NO-PROVIDER';
  if (input.status === 503) return 'NO-PROVIDER';
  return 'ERROR';
}

export interface ComboStep {
  step: string;
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
  const db = openRouterDb();
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
  combo?: string | undefined;
  all?: boolean | undefined;
  yesSpendTokens?: boolean | undefined;
  maxMinutes?: number | undefined;
  baseUrl?: string | undefined;
  /** Test hook: b? qua DB router. */
  state?: RouterDb | undefined;
  comboTimeoutMs?: number | undefined;
  stepTimeoutMs?: number | undefined;
  json?: boolean | undefined;
  /** Test hooks. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  usageCount?: (() => number) | undefined;
  log?: (line: string) => void | undefined;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128';
const COMBO_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_429 = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ComboProbeRow {
  combo: string;
  model: string;
  httpStatus: number | null;
  headerMs: number | null;
  firstByteMs: number | null;
  totalMs: number;
  verdict: StepVerdict;
  detail: string;
  usageServedBy: string | null;
}

export interface ProbeReport {
  generatedAt: string;
  mode: ProbeMode;
  baseUrl: string;
  apiKeyName: string;
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
  const db = openRouterDb();
  try {
    const row = db
      .prepare('SELECT provider, model FROM usageHistory ORDER BY id DESC LIMIT 1')
      .get() as { provider: string; model: string } | undefined;
    return row ? `${row.provider}/${row.model}` : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    db.close();
  }
}

async function callOnce(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  usageCount: () => number
): Promise<{ row: Omit<ComboProbeRow, 'combo'> }> {
  const t0 = Date.now();
  let headerMs: number | null = null;
  let firstByteMs: number | null = null;
  let httpStatus: number | null = null;
  let text = '';
  let timedOut = false;
  const before = usageCount();

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    headerMs = Date.now() - t0;
    httpStatus = res.status;
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      const first = await reader.read();
      firstByteMs = Date.now() - t0;
      text = decoder.decode(first.value ?? new Uint8Array());
      await reader.cancel().catch(() => undefined);
    } else {
      text = (await res.text()).slice(0, 400);
      firstByteMs = Date.now() - t0;
    }
  } catch (err) {
    timedOut = true;
    text = err instanceof Error ? err.message : String(err);
  }

  const totalMs = Date.now() - t0;
  const after = usageCount();
  const usageRowAdded = after > before;
  const servedBy = usageRowAdded ? usageDelta(before, after) : null;
  const verdict = perStepConclusion({
    status: httpStatus,
    body: redact(text, [apiKey]),
    headerReceived: headerMs !== null,
    usageRowAdded,
    timedOut,
  });
  return {
    row: {
      model: '',
      httpStatus,
      headerMs,
      firstByteMs,
      totalMs,
      verdict,
      detail: redact(text, [apiKey]),
      usageServedBy: servedBy,
    },
  };
}

function selectCombos(state: RouterDb, options: ProbeOptions): ComboInfo[] {
  if (options.all) return state.combos;
  if (options.combo) {
    const hit = state.combos.filter((c) => c.name === options.combo);
    if (hit.length === 0) {
      throw new Error(`unknown combo "${options.combo}"; known: ${state.combos.map((c) => c.name).join(', ')}`);
    }
    return hit;
  }
  return state.combos;
}

function uniqueSteps(combos: ComboInfo[]): string[] {
  const seen = new Set<string>();
  for (const c of combos) for (const s of c.steps) seen.add(s);
  return [...seen].sort();
}

function printDryRun(state: RouterDb, combos: ComboInfo[], baseUrl: string, log: (l: string) => void): void {
  const steps = uniqueSteps(combos);
  const perCombo = combos.reduce((n, c) => n + c.steps.length, 0);
  const longestComboSteps = Math.max(0, ...combos.map((c) => c.steps.length));
  const comboBudget = combos.length * (COMBO_TIMEOUT_MS / 1000);
  const stepBudget = steps.length * (STEP_TIMEOUT_MS / 1000);
  log(`baseUrl=${baseUrl}`);
  log(`apiKey=${state.apiKeyName} (giá trị không in)`);
  log(`combos=${combos.length} steps_theo_combo=${perCombo} unique_steps=${steps.length}`);
  log(
    `u?c t�nh t?i da: combo = ${combos.length} � ${COMBO_TIMEOUT_MS / 1000}s = ${comboBudget}s (m?i combo t?i da ${COMBO_TIMEOUT_MS / 1000}s, combo d�i nh?t c� ${longestComboSteps} bu?c); step = ${steps.length} � ${STEP_TIMEOUT_MS / 1000}s = ${stepBudget}s`
  );
  log('Đây là chạy thử: không có request nào được gửi.');
  log('Muốn chạy thật: thêm --yes-spend-tokens (tốn token của chủ dự án).');
}

export async function runCombosProbeCommand(options: ProbeOptions = {}): Promise<ProbeReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  const baseUrl = options.baseUrl ?? process.env['ROUTERSYNC_9ROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
  const mode: ProbeMode = options.mode ?? 'combo';

  const state = options.state ?? readRouterState();
  const combos = selectCombos(state, options);
  if (combos.length === 0) throw new Error('no combo selected');

  if (!options.yesSpendTokens) {
    printDryRun(state, combos, baseUrl, log);
    return {
      generatedAt: new Date().toISOString(),
      mode,
      baseUrl,
      apiKeyName: state.apiKeyName,
      stoppedEarly: 'dry-run',
      combos: combos.map((c) => c.name),
      uniqueSteps: uniqueSteps(combos).length,
      rows: [],
    };
  }

  const deadline = (options.now ?? Date.now)() + (options.maxMinutes ?? 40) * 60_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const usageCount = options.usageCount ?? (() => {
    const db = openRouterDb();
    try {
      return (db.prepare('SELECT COUNT(*) n FROM usageHistory').get() as { n: number }).n;
    } catch {
      return 0;
    } finally {
      db.close();
    }
  });

  const rows: ComboProbeRow[] = [];
  let consecutive429 = 0;
  let stoppedEarly: string | null = null;
  const secrets = [state.apiKey];

  if (mode === 'combo') {
    for (const combo of combos) {
      if ((options.now ?? Date.now)() > deadline) {
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
          model: combo.name,
          messages: [{ role: 'user', content: 'Trả lời đúng một từ: ok' }],
          max_tokens: 8,
          stream: true,
        },
        options.comboTimeoutMs ?? COMBO_TIMEOUT_MS,
        fetchImpl,
        usageCount
      );
      if (result.row.verdict === 'RATE-LIMITED') consecutive429 += 1;
      else consecutive429 = 0;
      rows.push({ combo: combo.name, ...result.row, model: combo.name });
      log(
        `${combo.name}\t${result.row.verdict}\thttp=${result.row.httpStatus ?? '-'}\theader=${result.row.headerMs ?? '-'}ms\tfirstByte=${result.row.firstByteMs ?? '-'}ms\ttotal=${result.row.totalMs}ms\tusage=${result.row.usageServedBy ?? 'không có dòng usage'}`
      );
    }
  } else {
    const steps = uniqueSteps(combos);
    for (const step of steps) {
      if ((options.now ?? Date.now)() > deadline) {
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
          max_tokens: 1,
          stream: true,
        },
        options.stepTimeoutMs ?? STEP_TIMEOUT_MS,
        fetchImpl,
        usageCount
      );
      if (result.row.verdict === 'RATE-LIMITED') consecutive429 += 1;
      else consecutive429 = 0;
      rows.push({ combo: '(step)', ...result.row, model: step });
      log(
        `${step}\t${result.row.verdict}\thttp=${result.row.httpStatus ?? '-'}\ttotal=${result.row.totalMs}ms\tusage=${result.row.usageServedBy ?? 'không có dòng usage'}`
      );
    }
  }

  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    mode,
    baseUrl,
    apiKeyName: state.apiKeyName,
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
    log(`tổng=${rows.length} ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (stoppedEarly) log(`dừng sớm: ${stoppedEarly}`);
  }
  void secrets;
  return report;
}

export { DEFAULT_BASE_URL, COMBO_TIMEOUT_MS, STEP_TIMEOUT_MS, MAX_CONSECUTIVE_429, redact };




