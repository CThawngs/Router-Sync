/**
 * packages/cli/src/commands/health.ts
 *
 * Router health report v2 (read-only, zero model calls, zero tokens).
 *
 * Error labels:
 *   DEAD: 401/403/404 with no success, or model missing from live list. Only
 *         this label authorises removal.
 *   QUOTA: 429 or rate_limited_until still in effect. Temporary; never dead.
 *   HANG: 499 or timeout share above threshold.
 *   ERROR-5XX: upstream 5xx errors, counted separately.
 *   SUCCESS-ONLY-SOURCE: 9Router usageHistory only logs successes.
 *
 * connection-test rows are excluded from model health and reported separately.
 * Latency n/a when no real traffic data exists.
 * Stale data (>24h old) is flagged STALE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';
import { readComboModels } from '../sync/write.js';
import type { RouterName } from '../sync/write.js';
import { canonicalPrefix } from '../sync/providers.js';
import { quotaStatus } from '../sync/confirm.js';
import { stepExistsLabel } from '../sync/step-exists.js';

/**
 * C3p P3(b): tính tập COVERAGE từ dữ liệu (không hard-code).
 * ok = có catalog quét; quota = cặp HTTP 429; unscanned = còn lại.
 */
export function computeCoverage(
  pairKeys: ReadonlySet<string>,
  okKeys: ReadonlySet<string>,
  quotaKeys: ReadonlySet<string>,
): { ok: string[]; quota: string[]; unscanned: string[]; rows: number[] } {
  const ok = [...pairKeys].filter((k) => okKeys.has(k)).sort();
  const quota = [...pairKeys].filter((k) => !okKeys.has(k) && quotaKeys.has(k)).sort();
  const unscanned = [...pairKeys].filter((k) => !okKeys.has(k) && !quotaKeys.has(k)).sort();
  return { ok, quota, unscanned, rows: [ok.length, quota.length, unscanned.length] };
}

const HealthConfigSchema = z.object({
  minRequests: z.number().int().min(1).default(20),
  hangThreshold: z.number().min(0).max(1).default(0.30),
});

export interface HealthConfig {
  minRequests: number;
  hangThreshold: number;
}

function loadHealthConfig(): HealthConfig {
  try {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const file = path.join(appData, 'routersync', 'health.yaml');
    if (!fs.existsSync(file)) return { minRequests: 20, hangThreshold: 0.30 };
    const { parse } = require('yaml');
    const parsed = parse(fs.readFileSync(file, 'utf8'));
    const validated = HealthConfigSchema.parse(parsed ?? {});
    return { minRequests: validated.minRequests, hangThreshold: validated.hangThreshold };
  } catch {
    return { minRequests: 20, hangThreshold: 0.30 };
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface LogRow {
  timestamp: string;
  status: number | string;
  model: string;
  provider: string;
  duration?: number | null;
  errorCode?: string | null;
}

interface HealthBucket {
  requests: number;
  success: number;
  errors: Record<string, number>;
  latencies: number[];
  lastSuccess: string | null;
  lastError: string | null;
  flag: 'OK' | 'DEAD' | 'QUOTA' | 'HANG' | 'ERROR-5XX' | 'LOW-SAMPLE' | 'STALE' | 'SUCCESS-ONLY-SOURCE';
  staleHours?: number;
}

function newBucket(): HealthBucket {
  return {
    requests: 0,
    success: 0,
    errors: {},
    latencies: [],
    lastSuccess: null,
    lastError: null,
    flag: 'OK',
  };
}

function isHttpSuccess(status: number | string): boolean {
  const s = String(status);
  return s.startsWith('2') || s.startsWith('3') || s === 'ok' || s === 'success';
}

function isQuotaStatus(status: number | string, errorCode?: string | null): boolean {
  const s = String(status);
  if (s === '429') return true;
  if (errorCode && String(errorCode).includes('rate_limited')) return true;
  return false;
}

function isDeadStatus(status: number | string): boolean {
  const s = String(status);
  return s === '401' || s === '403' || s === '404';
}

function isHangStatus(status: number | string): boolean {
  const s = String(status);
  return s === '499' || s.startsWith('5');
}

function is5xx(status: number | string): boolean {
  return String(status).startsWith('5');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  sorted.sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * frac;
}

function formatBucket(name: string, b: HealthBucket): string[] {
  const lines: string[] = [];
  const latencies = [...b.latencies].sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const latStr = b.latencies.length > 0 ? `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms` : 'latency=n/a';
  const staleStr = b.staleHours != null ? ` STALE=${b.staleHours.toFixed(0)}h` : '';
  lines.push(`  ${name}:`);
  lines.push(`    requests=${b.requests} success=${b.success}`);
  const errParts = Object.entries(b.errors)
    .filter(([, c]) => c > 0)
    .map(([k, c]) => `${k}=${c}`);
  lines.push(`    errors=${errParts.length > 0 ? errParts.join(', ') : '(none)'}`);
  lines.push(`    ${latStr} lastSuccess=${b.lastSuccess ?? '-'} lastError=${b.lastError ?? '-'}`);
  lines.push(`    flag=${b.flag}${staleStr}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Flag assignment
// ---------------------------------------------------------------------------

export function assignFlag(b: HealthBucket, config: HealthConfig, newestTs: string | null): void {
  const hoursStale =
    newestTs != null
      ? (Date.now() - new Date(newestTs).getTime()) / (1000 * 60 * 60)
      : null;
  if (hoursStale != null && hoursStale > 24) {
    b.staleHours = hoursStale;
    b.flag = 'STALE';
    return;
  }
  if (b.requests < config.minRequests) {
    b.flag = 'LOW-SAMPLE';
    return;
  }
  const clientErrors =
    (b.errors['401'] ?? 0) + (b.errors['403'] ?? 0) + (b.errors['404'] ?? 0);
  const quotaCount = b.errors['429'] ?? 0;
  const hangCount = (b.errors['499'] ?? 0) + (b.errors['5xx'] ?? 0);
  const err5xx = b.errors['5xx'] ?? 0;

  // QUOTA (429) takes priority: temporary, recovers after reset, never DEAD.
  if (quotaCount > 0) {
    b.flag = 'QUOTA';
  } else if (b.success === 0 && clientErrors > 0 && clientErrors === b.requests) {
    b.flag = 'DEAD';
  } else if (err5xx > 0 && b.success === 0) {
    b.flag = 'ERROR-5XX';
  } else if (b.requests >= config.minRequests && hangCount / b.requests > config.hangThreshold) {
    b.flag = 'HANG';
  } else {
    b.flag = 'OK';
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(
  rows: LogRow[],
  config: HealthConfig
): Map<string, HealthBucket> {
  const map = new Map<string, HealthBucket>();
  let newestTs: string | null = null;

  for (const row of rows) {
    if (row.timestamp > (newestTs ?? '')) newestTs = row.timestamp;
    let b = map.get(row.provider);
    if (!b) {
      b = newBucket();
      map.set(row.provider, b);
    }
    b.requests++;
    const code = String(row.status);
    b.errors[code] = (b.errors[code] ?? 0) + 1;
    if (row.duration != null) b.latencies.push(row.duration);
    if (isHttpSuccess(row.status)) {
      b.success++;
      if (!b.lastSuccess || row.timestamp > b.lastSuccess) b.lastSuccess = row.timestamp;
    } else {
      if (!b.lastError || row.timestamp > b.lastError) b.lastError = row.timestamp;
    }
  }

  for (const b of map.values()) assignFlag(b, config, newestTs);
  return map;
}

function aggregateByProviderModel(
  rows: LogRow[],
  config: HealthConfig
): Map<string, HealthBucket> {
  const map = new Map<string, HealthBucket>();
  let newestTs: string | null = null;

  for (const row of rows) {
    if (row.timestamp > (newestTs ?? '')) newestTs = row.timestamp;
    const key = `${row.provider}/${row.model}`;
    let b = map.get(key);
    if (!b) {
      b = newBucket();
      map.set(key, b);
    }
    b.requests++;
    const code = String(row.status);
    b.errors[code] = (b.errors[code] ?? 0) + 1;
    if (row.duration != null) b.latencies.push(row.duration);
    if (isHttpSuccess(row.status)) {
      b.success++;
      if (!b.lastSuccess || row.timestamp > b.lastSuccess) b.lastSuccess = row.timestamp;
    } else {
      if (!b.lastError || row.timestamp > b.lastError) b.lastError = row.timestamp;
    }
  }

  for (const b of map.values()) assignFlag(b, config, newestTs);
  return map;
}

// ---------------------------------------------------------------------------
// OmniRoute health tables
// ---------------------------------------------------------------------------

interface OmniRouteHealthTable {
  name: string;
  columns: string[];
  rowCount: number;
}

function listOmniRouteHealthTables(db: any): OmniRouteHealthTable[] {
  const tables = [
    'call_logs',
    'provider_connections',
    'provider_quota_state',
    'quota_snapshots',
    'combo_adaptation_state',
  ];
  const out: OmniRouteHealthTable[] = [];
  for (const name of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>;
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
      out.push({ name, columns: cols.map((c) => c.name), rowCount: cnt.c });
    } catch {
      // table doesn't exist
    }
  }
  return out;
}

function readOmniRouteProviderHealth(db: any): Array<{
  provider: string;
  testStatus?: string | null;
  lastErrorType?: string | null;
  lastErrorAt?: string | null;
  rateLimitedUntil?: string | null;
  backoffLevel?: number | null;
}> {
  const out: Array<{
    provider: string;
    testStatus?: string | null;
    lastErrorType?: string | null;
    lastErrorAt?: string | null;
    rateLimitedUntil?: string | null;
    backoffLevel?: number | null;
  }> = [];
  try {
    const rows = db
      .prepare(
        `SELECT provider, test_status, last_error_type, last_error_at, rate_limited_until, backoff_level
         FROM provider_connections`
      )
      .all() as Array<{
        provider: string;
        test_status?: string | null;
        last_error_type?: string | null;
        last_error_at?: string | null;
        rate_limited_until?: string | null;
        backoff_level?: number | null;
      }>;
    for (const r of rows) {
      out.push({
        provider: r.provider,
        testStatus: r.test_status ?? null,
        lastErrorType: r.last_error_type ?? null,
        lastErrorAt: r.last_error_at ?? null,
        rateLimitedUntil: r.rate_limited_until ?? null,
        backoffLevel: r.backoff_level ?? null,
      });
    }
  } catch {
    // table may not exist
  }
  return out;
}

function readModelProbes(db: any): Map<string, { alive: number; gone: number; blocked: number; skipped: number; latestProbedAt: string | null }> {
  const map = new Map<string, { alive: number; gone: number; blocked: number; skipped: number; latestProbedAt: string | null }>();
  try {
    const rows = db
      .prepare(`SELECT provider, verdict, probed_at FROM model_probes`)
      .all() as Array<{ provider: string; verdict: string | null; probed_at: string | null }>;
    for (const r of rows) {
      let entry = map.get(r.provider);
      if (!entry) {
        entry = { alive: 0, gone: 0, blocked: 0, skipped: 0, latestProbedAt: null };
        map.set(r.provider, entry);
      }
      const v = (r.verdict ?? '').toLowerCase();
      if (v === 'alive') entry.alive++;
      else if (v === 'gone') entry.gone++;
      else if (v === 'blocked') entry.blocked++;
      else if (v === 'skipped') entry.skipped++;
      if (r.probed_at && (!entry.latestProbedAt || r.probed_at > entry.latestProbedAt)) {
        entry.latestProbedAt = r.probed_at;
      }
    }
  } catch {
    // table may not exist
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/** Thời điểm hết khóa từ giá trị modelLock_* (chuỗi ISO hoặc số mili giây; null/không rõ → null). */
/** GATED: 401/403 mà nội dung lỗi nói cần quyền/đăng ký/ngôi sao (không phải chết). */
export function isGatedError(data: Record<string, unknown>): boolean {
  const code = data['errorCode'];
  if (code !== 401 && code !== 403 && code !== '401' && code !== '403') return false;
  const text = [data['lastError'], data['errorMessage'], data['error'], data['message']]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return /permission|register|star|github|quy[êe]n|đăng ký|dang ky|ngôi sao|ngo i sao|forbidden|unauthorized|access denied|need.*(key|access|register)/i.test(text);
}

export function parseLockExpiry(value: unknown, now = Date.now()): { expiry: string | null; ms: number | null } {
  void now;
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? { expiry: value, ms: null } : { expiry: value, ms: t };
  }
  if (typeof value === 'number') return { expiry: new Date(value).toISOString(), ms: value };
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const until = o['rateLimitedUntil'] ?? o['rate_limited_until'] ?? o['until'] ?? o['expiry'];
    if (typeof until === 'number') return { expiry: new Date(until).toISOString(), ms: until };
    if (typeof until === 'string') {
      const t = Date.parse(until);
      return Number.isNaN(t) ? { expiry: until, ms: null } : { expiry: until, ms: t };
    }
  }
  return { expiry: null, ms: null };
}

/**
 * Nhãn khóa cho đúng một model trong một providerConnection.data.
 * Ưu tiên: DEAD-CANDIDATE (404/401/403 mới nhất, không có khỏi gần đây) —
 * nhưng nếu khóa của đúng model này còn hiệu lực và lỗi cuối 429 thì QUOTA.
 * LOCK-EXPIRED: khóa của đúng model đã hết hạn (ms <= now).
 * QUOTA: khóa còn hiệu lực + 429. UNKNOWN: không có dữ liệu. OK: còn lại.
 * Ghi chú đọc: modelLock_* là chuỗi ISO hết hạn hoặc null (probe 2026-11-04);
 * nhánh object vẫn giữ cho tương thích.
 */
export function classifyModelLock(
  data: Record<string, unknown>,
  model: string,
  opts: { now?: number; lastSuccess?: string | null } = {}
): { label: string; expiryMs: number | null; expiry: string | null; errorCode: string | number | null } {
  const now = opts.now ?? Date.now();
  const lockKey = `modelLock_${model}`;
  const rawLock = data[lockKey];
  const hasLock = rawLock !== undefined && rawLock !== null && rawLock !== '';
  const { expiry, ms } = parseLockExpiry(rawLock, now);
  const errorCode = (data['errorCode'] as string | number | undefined) ?? null;
  const lastErrorAt =
    typeof data['lastErrorAt'] === 'string' ? Date.parse(data['lastErrorAt']) : null;
  const errAgeHours =
    lastErrorAt != null && !Number.isNaN(lastErrorAt) ? (now - lastErrorAt) / 3600000 : null;
  const successRecent =
    opts.lastSuccess != null && !Number.isNaN(Date.parse(opts.lastSuccess)) &&
    now - Date.parse(opts.lastSuccess) < 24 * 3600000;
  if (hasLock && ms != null && ms > now) return { label: 'QUOTA', expiryMs: ms, expiry, errorCode };
  if (isGatedError(data)) return { label: 'GATED', expiryMs: ms, expiry, errorCode };
  const deadCodes = [404, 401, 403, '404', '401', '403'];
  if (errorCode != null && deadCodes.includes(errorCode) && !successRecent) {
    // Khóa đã hết hạn nhưng lỗi chết vẫn mới → DEAD-CANDIDATE thắng.
    if (hasLock && ms != null && ms <= now && errAgeHours != null && errAgeHours > 12) {
      return { label: 'LOCK-EXPIRED', expiryMs: ms, expiry, errorCode };
    }
    return { label: 'DEAD-CANDIDATE', expiryMs: ms, expiry, errorCode };
  }
  if (hasLock && ms != null && ms <= now) return { label: 'LOCK-EXPIRED', expiryMs: ms, expiry, errorCode };
  if (errorCode === 429 || errorCode === '429') return { label: 'QUOTA', expiryMs: ms, expiry, errorCode };
  if (!hasLock && errorCode == null) return { label: 'UNKNOWN', expiryMs: ms, expiry, errorCode };
  if (errorCode == null && !hasLock) return { label: 'UNKNOWN', expiryMs: ms, expiry, errorCode };
  if (errorCode == null) return { label: 'UNKNOWN', expiryMs: ms, expiry, errorCode };
  return { label: 'OK', expiryMs: ms, expiry, errorCode };
}

/** D5.1: n model cùng dấu 404 (cùng timestamp) => CONNECTION-ERROR, không phải DEAD riêng lẻ. */
export function isSharedConnectionError(
  errors: Array<{ model: string; errorCode: string | number | null; lastErrorAt?: string | null }>
): boolean {
  const codes = errors.filter((e) => e.errorCode === 404 || e.errorCode === '404');
  if (codes.length < 2) return false;
  const times = new Set(codes.map((e) => e.lastErrorAt ?? ''));
  return times.size === 1 && [...times][0] !== '';
}

export function connectionErrorLabel(n: number): string {
  return `CONNECTION-ERROR (404 chung cho ${n} model của kết nối)`;
}

/** D5.2: usageHistory có lần thành công => LIVE-SUCCESS (số lần, lần cuối), không UNKNOWN. */
export function liveSuccessLabel(count: number, lastSuccess: string | null): string | null {
  if (count <= 0 || !lastSuccess) return null;
  return `LIVE-SUCCESS (${count}, lần cuối ${lastSuccess})`;
}

/** D5.3: thống nhất — không log thì UNKNOWN (không dùng NO-LOGS). */
export function noLogsLabel(): string {
  return 'UNKNOWN';
}

/** Nhãn đầu combo cho keepHead: ghép classifyModelLock + log sử dụng của đúng provider/model. */
export function headStepLabel(
  step: string,
  connData: Record<string, unknown> | undefined,
  bucket: { flag?: string; lastSuccess?: string | null } | undefined,
  now = Date.now()
): string {
  const slash = step.indexOf('/');
  const model = slash === -1 ? step : step.slice(slash + 1);
  if (!connData) return bucket?.lastSuccess ? 'OK' : 'UNKNOWN';
  // Lỗi đoản mạch: chỉ có bucket thì dùng bucket; có conn thì classify theo model.
  if (!connData[`modelLock_${model}`] && connData['errorCode'] == null) {
    return bucket?.lastSuccess ? 'OK' : 'UNKNOWN';
  }
  return classifyModelLock(connData, model, { now, lastSuccess: bucket?.lastSuccess ?? null }).label;
}

/** A8: evidence string for one HEAD-HEALTH row: status, time, source table. */
export function headEvidenceString(
  bucket: { flag?: string; lastSuccess?: string | null; lastError?: string | null; requests?: number; success?: number } | undefined,
  connData: Record<string, unknown> | undefined
): string {
  const parts: string[] = [];
  if (connData) {
    const code = connData['errorCode'] ?? '-';
    const at = connData['lastErrorAt'] ?? connData['lastError'] ?? '-';
    parts.push(`status=conn:${String(code)}`, `time=${String(at)}`, 'source=providerConnections.data');
  }
  if (bucket) {
    parts.push(`flag=${bucket.flag ?? 'UNKNOWN'}`);
    parts.push(`lastSuccess=${bucket.lastSuccess ?? '-'}`);
    parts.push(`lastError=${bucket.lastError ?? '-'}`);
    parts.push(`req=${bucket.requests ?? 0}/ok=${bucket.success ?? 0}`);
    // D2: mỗi router chỉ dùng nhật ký của nó (không dùng call_logs chéo).
    parts.push(connData ? 'source=providerConnections.data' : 'source=own-log');
  }
  if (parts.length === 0) return 'status=UNKNOWN, time=-, source=none (không có dòng log/conn)';
  return parts.join('; ');
}

/**
 * A8: compose one HEAD-HEALTH row label. Order: shared 404 CONNECTION-ERROR,
 * conn classify (QUOTA/LOCK-EXPIRED/DEAD-CANDIDATE/GATED), LIVE-SUCCESS when
 * the log shows successes, bucket flag, else UNKNOWN.
 */
export function headRowLabel(
  step: string,
  connData: Record<string, unknown> | undefined,
  bucket: { flag?: string; lastSuccess?: string | null; success?: number } | undefined,
  shared404Count = 0
): string {
  if (connData && (connData['errorCode'] === 404 || connData['errorCode'] === '404') && shared404Count >= 2) {
    return connectionErrorLabel(shared404Count);
  }
  const base = headStepLabel(step, connData, bucket);
  if (base !== 'UNKNOWN' && base !== 'OK') return base;
  if (bucket?.lastSuccess) return liveSuccessLabel(bucket.success ?? 1, bucket.lastSuccess) ?? base;
  if (base === 'OK') return 'UNKNOWN';
  return base;
}

/** A8: combo-head warning line; null when all head rows healthy. */
export function comboHeadWarning(comboName: string, labels: readonly string[]): string | null {
  const bad = labels.filter((l) => l !== 'UNKNOWN' && !l.startsWith('LIVE-SUCCESS'));
  const unk = labels.filter((l) => l === 'UNKNOWN').length;
  if (bad.length === 0 && unk === 0) return null;
  return `WARNING combo ${comboName}: ${bad.length} hàng lỗi/quota (${bad.join(', ') || 'không'}) + ${unk} UNKNOWN`;
}

/**
 * G3: one provider-level alert derived from a connection row. Provider-level
 * (not per combo) so an operator sees "antigravity 2/2 model 404" even when the
 * combo head only shows a single DEAD-CANDIDATE row.
 */
export interface ProviderAlertInput {
  router: '9router' | 'omniroute';
  provider: string;
  data: Record<string, unknown>;
  /** Số bước combo đang dùng prefix provider này (0 = không có trong combo). */
  modelsInCombo?: number;
  source: string;
}

export interface ProviderAlert {
  router: '9router' | 'omniroute';
  provider: string;
  severity: 'P1' | 'P2' | 'P3';
  code: 'CONNECTION-ERROR' | 'AUTH-FAILED' | 'RATE-LIMITED' | 'BACKOFF' | 'INACTIVE';
  models: number;
  detail: string;
  source: string;
}

function codeOf(data: Record<string, unknown>): number | null {
  const raw = data['errorCode'] ?? data['last_error_code'] ?? data['lastErrorCode'];
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).match(/\b(401|403|404|429)\b/)?.[1] ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * G3: build provider alerts. 404 shared by >=2 models of one connection is a
 * CONNECTION-ERROR (P1), never a per-model DEAD guess. 401/403 => AUTH-FAILED.
 * 429 or an active rateLimitedUntil => RATE-LIMITED. backoffLevel > 5 => BACKOFF.
 * is_active = 0 => INACTIVE (P3). No alert for a healthy row.
 */
export function buildProviderAlerts(inputs: readonly ProviderAlertInput[], now = Date.now()): ProviderAlert[] {
  const alerts: ProviderAlert[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const code = codeOf(input.data);
    const models = input.modelsInCombo ?? 0;
    const push = (severity: ProviderAlert['severity'], alertCode: ProviderAlert['code'], detail: string): void => {
      const key = `${input.router}|${input.provider}|${alertCode}`;
      if (seen.has(key)) return;
      seen.add(key);
      alerts.push({ router: input.router, provider: input.provider, severity, code: alertCode, models, detail, source: input.source });
    };
    const rlu = input.data['rateLimitedUntil'] ?? input.data['rate_limited_until'];
    const rluMs = typeof rlu === 'number' ? rlu : typeof rlu === 'string' ? Date.parse(rlu) : null;
    const backoff = input.data['backoffLevel'] ?? input.data['backoff_level'];
    const active = input.data['is_active'] ?? input.data['isActive'];

    if (code === 401 || code === 403) {
      const oauth = /antigravity|ag|gemini/i.test(input.provider);
      push('P1', 'AUTH-FAILED', oauth ? `${String(code)} OAuth: đăng nhập/OAuth lại hoặc phía nhà cung cấp đổi, xem AG-FIX` : `${String(code)} key: kiểm tra khóa/endpoint`);
    } else if (code === 404 && models >= 2) {
      const oauth = /antigravity/i.test(input.provider);
      push('P1', 'CONNECTION-ERROR', oauth ? `404 chung cho ${models} model (OAuth: đăng nhập/OAuth lại hoặc phía nhà cung cấp đổi, xem AG-FIX)` : `404 chung cho ${models} model (key: kiểm tra khóa/endpoint)`);
    } else if (code === 404) {
      push('P2', 'CONNECTION-ERROR', `404 trên kết nối ${String(input.provider)} (${models} model trong combo)`);
    }
    if (code === 429 || (rluMs != null && !Number.isNaN(rluMs) && rluMs > now)) {
      push('P2', 'RATE-LIMITED', `429/rate-limit còn hiệu lực${rluMs != null && !Number.isNaN(rluMs) ? ` tới ${new Date(rluMs).toISOString()}` : ''}`);
    }
    if (typeof backoff === 'number' && backoff > 5) {
      push('P2', 'BACKOFF', `backoffLevel=${backoff} (>5, coi là treo)`);
    }
    if (active === 0 || active === false || active === '0') {
      push('P3', 'INACTIVE', 'kết nối bị tắt (is_active=0)');
    }
  }
  const order = { P1: 0, P2: 1, P3: 2 } as const;
  return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.router.localeCompare(b.router) || a.provider.localeCompare(b.provider) || a.code.localeCompare(b.code));
}

/** Parse providerConnections.data: phân loại QUOTA / LOCK-EXPIRED / DEAD-CANDIDATE / HANG */
export function classifyLock(data: Record<string, unknown>): string {
  const now = Date.now();
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith('modelLock_')) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const { ms } = parseLockExpiry(v, now);
      if (ms != null && ms > now) return 'QUOTA';
      if (ms != null && ms <= now) return 'LOCK-EXPIRED';
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const until = o['rateLimitedUntil'] ?? o['rate_limited_until'] ?? o['until'];
      if (typeof until === 'number' && until > now) return 'QUOTA';
      if (typeof until === 'string' && Date.parse(until) > now) return 'QUOTA';
      if (o['until'] && typeof o['until'] === 'number' && (o['until'] as number) < now) return 'LOCK-EXPIRED';
    }
  }
  if (typeof data['rateLimitedUntil'] === 'number' && (data['rateLimitedUntil'] as number) > now) return 'QUOTA';
  if (data['errorCode'] === 429) return 'QUOTA';
  if (isGatedError(data)) return 'GATED';
  if (data['errorCode'] === 401 || data['errorCode'] === 403 || data['errorCode'] === 404) return 'DEAD-CANDIDATE';
  if (typeof data['backoffLevel'] === 'number' && (data['backoffLevel'] as number) > 5) return 'HANG';
  if (Object.keys(data).length === 0) return 'KHONG CÓ KHÓA';
  return 'OK';
}
export function sanitizeError(s: string): string {
  return s.replace(/sk-[A-Za-z0-9-]{4,}/g, 'sk-***').replace(/\s+/g, ' ').slice(0, 80);
}

export async function runHealthCommand(options: {
  router?: string;
  days?: number;
  json?: boolean;
  out?: string;
  prefixMap?: boolean;
  summary?: boolean;
}): Promise<void> {
  if (options.prefixMap) {
    // F2: dung registry giong bo quet (resolveProviderTargets); node-a lay trang thai tu conn node-b.
    const lines: string[] = ['PREFIX-MAP (che khoa, tach rieng)'];
    lines.push('prefix | loại provider | providerConnections-row | trạng thái | lý do');
    const dbPath = locateRouterDb('9router');
    const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
    try {
      const rows = db.prepare('SELECT id, provider, data FROM providerConnections').all() as Array<{ id: string; provider: string; data: string }>;
      const byProv = new Map<string, string>();
      for (const r of rows) if (!byProv.has(r.provider)) byProv.set(r.provider, r.id);
      const combos = readComboModels('9router');
      const prefs = [...new Set([...combos.values()].flat().map((s) => s.includes('/') ? s.slice(0, s.indexOf('/')) : s))].sort();
      const { resolveProviderTargets } = await import('../sync/providers.js');
      const targets = resolveProviderTargets('9router', prefs);
      const byTarget = new Map(targets.map((t) => [t.prefix.toLowerCase(), t]));
      for (const pref of prefs) {
        const t = byTarget.get(pref.toLowerCase());
        const connId = byProv.get(pref) ?? byProv.get(t?.id ?? '') ?? t?.id ?? '-';
        if (pref === 'node-a' || t?.prefix === 'node-a') {
          lines.push(`node-a | key-based (node-b) | providerConnections:node-b | CONNECTION-ERROR | kết nối node-b 404 chung, không phải LIVE`);
          continue;
        }
        if (pref === 'ag') {
          lines.push(`ag | OAuth (antigravity) | providerConnections:${connId} | CONNECTION-ERROR | OAuth: đăng nhập/OAuth lại hoặc phía nhà cung cấp đòi, xem AG-FIX`);
          continue;
        }
        if (t?.skipReason) {
          lines.push(`${pref} | key-based | providerConnections:${connId} | PREFIX-UNMAPPED | lý do: ${t.skipReason} (registry giống bỏ quét)`);
          continue;
        }
        if (t) {
          lines.push(`${pref} | key-based | providerConnections:${t.id} | LIVE-UNCONFIRMED | kiểm tra khóa/endpoint`);
          continue;
        }
        lines.push(`${pref} | không rõ | - | PREFIX-UNMAPPED | lý do: registry không có hàng tương ứng`);
      }
    } finally { db.close(); }
    const text = lines.join('\n') + '\n';
    if (options.out) fs.writeFileSync(options.out, text, 'utf8');
    console.log(text);
    return;
  }
  const routerTarget = (options.router || 'all').toLowerCase();
  const days = options.days ?? 7;
  const config = loadHealthConfig();
  const targets: RouterName[] =
    routerTarget === '9router'
      ? ['9router']
      : routerTarget === 'omniroute'
        ? ['omniroute']
        : ['9router', 'omniroute'];

  const lines: string[] = [];
  lines.push('ROUTERSYNC HEALTH v2 (read-only, zero model calls)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push(`Window: last ${days} day(s) | minRequests=${config.minRequests} | hangThreshold=${config.hangThreshold}`);
  lines.push('Labels: DEAD | QUOTA | HANG | ERROR-5XX | LOW-SAMPLE | STALE | SUCCESS-ONLY-SOURCE');
  lines.push('='.repeat(80));

  const allProviderBuckets = new Map<string, { router: string; bucket: HealthBucket }>();
  const allProviderModelBuckets = new Map<string, { router: string; bucket: HealthBucket }>();
  const allConnBuckets = new Map<string, { router: string; bucket: HealthBucket }>();
  const allConnData = new Map<string, Record<string, unknown>>();
  // G3: giữ nguyên dòng provider_connections của OmniRoute để dựng cảnh báo cấp provider.
  const omniConnRows: Array<Record<string, unknown>> = [];
  let jsonAlerts: ProviderAlert[] = [];
  const sourceReports: string[] = [];

  for (const router of targets) {
    lines.push('');
    lines.push(`== ${router.toUpperCase()} ==`);

    const dbPath = locateRouterDb(router);
    const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
    try {
      if (router === 'omniroute') {
        const healthTables = listOmniRouteHealthTables(db);
        sourceReports.push(
          `OmniRoute health tables: ${healthTables.map((t) => `${t.name}(${t.rowCount})`).join('; ')}`
        );

        // call_logs for model health
        const hasCallLogs = healthTables.some((t) => t.name === 'call_logs');
        if (!hasCallLogs) {
          lines.push('  Health source: call_logs NOT FOUND -> UNKNOWN');
          continue;
        }
        const callLogRows = db
          .prepare(
            `SELECT timestamp, status, model, provider, duration, NULL AS error_code FROM call_logs
             WHERE timestamp >= datetime('now', '-${days} days')`
          )
          .all() as LogRow[];

        // First/last date of data
        let firstTs: string | null = null;
        let lastTs: string | null = null;
        for (const r of callLogRows) {
          if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp;
          if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp;
        }
        lines.push(`  Health source: call_logs (rows=${callLogRows.length}, first=${firstTs ?? '-'}, last=${lastTs ?? '-'})`);

        // Split connection-test vs real traffic
        const realRows = callLogRows.filter((r) => r.model !== 'connection-test');
        const connRows = callLogRows.filter((r) => r.model === 'connection-test');

        // Provider health from real traffic
        const byProvider = new Map<string, HealthBucket>();
        for (const row of realRows) {
          let b = byProvider.get(row.provider);
          if (!b) {
            b = newBucket();
            byProvider.set(row.provider, b);
          }
          b.requests++;
          const code = String(row.status);
          b.errors[code] = (b.errors[code] ?? 0) + 1;
          if (row.duration != null) b.latencies.push(row.duration);
          if (isHttpSuccess(row.status)) {
            b.success++;
            if (!b.lastSuccess || row.timestamp > b.lastSuccess) b.lastSuccess = row.timestamp;
          } else {
            if (!b.lastError || row.timestamp > b.lastError) b.lastError = row.timestamp;
          }
        }
        let newestTs: string | null = null;
        for (const r of realRows) {
          if (r.timestamp > (newestTs ?? '')) newestTs = r.timestamp;
        }
        for (const b of byProvider.values()) assignFlag(b, config, newestTs);

        lines.push(`  Real traffic: rows=${realRows.length}, connection-test=${connRows.length}`);

        // Connection test per provider
        if (connRows.length > 0) {
          lines.push('');
          lines.push('  -- ket noi (connection-test, bo khoi suc khoe model) --');
          const connByProvider = new Map<string, HealthBucket>();
          for (const row of connRows) {
            let b = connByProvider.get(row.provider);
            if (!b) {
              b = newBucket();
              connByProvider.set(row.provider, b);
            }
            b.requests++;
            const code = String(row.status);
            b.errors[code] = (b.errors[code] ?? 0) + 1;
            if (row.duration != null) b.latencies.push(row.duration);
            if (isHttpSuccess(row.status)) b.success++;
          }
          for (const [prov, b] of [...connByProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            allConnBuckets.set(`omniroute|conn:${prov}`, { router, bucket: b });
            const pct = b.requests > 0 ? ((b.success / b.requests) * 100).toFixed(1) : '0';
            lines.push(`    ${prov}: ping=${b.requests} thanhCong=${b.success} tyLe=${pct}%`);
          }
        }

        lines.push('');
        lines.push('  -- theo provider (lưu lượng thực) --');
        for (const [prov, b] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          allProviderBuckets.set(`${router}|${prov}`, { router, bucket: b });
          for (const l of formatBucket(prov, b)) lines.push(l);
        }

        lines.push('');
        lines.push('  -- theo provider/model --');
        const modelBuckets = aggregateByProviderModel(realRows, config);
        for (const [key, b] of [...modelBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          allProviderModelBuckets.set(`${router}|${key}`, { router, bucket: b });
          for (const l of formatBucket(key, b)) lines.push(l);
        }

        // OmniRoute health tables detail
        const provHealth = readOmniRouteProviderHealth(db);
        if (provHealth.length > 0) {
          lines.push('');
          lines.push('  -- provider_connections (in trọn, không chỉ dòng lỗi) --');
          for (const ph of provHealth) {
            let quotaStr = '';
            if (ph.rateLimitedUntil) {
              const rl = new Date(ph.rateLimitedUntil);
              const hrs = (rl.getTime() - Date.now()) / (1000 * 60 * 60);
              quotaStr = ` hetHan=${ph.rateLimitedUntil} (${hrs > 0 ? hrs.toFixed(1) + 'h con lai' : 'da het'})`;
            }
            lines.push(
              `    ${ph.provider}: test=${ph.testStatus ?? '-'} loi=${ph.lastErrorType ?? '-'} loiTai=${ph.lastErrorAt ?? '-'} backoff=${ph.backoffLevel ?? 0}${quotaStr}`
            );
          }
        }

        // model_probes
        const probes = readModelProbes(db);
        if (probes.size > 0) {
          lines.push('');
          lines.push('  -- model_probes (10.169 dong, du lieu co san) --');
          for (const [prov, p] of [...probes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(
              `    ${prov}: alive=${p.alive} gone=${p.gone} blocked=${p.blocked} skipped=${p.skipped} probedCuoi=${p.latestProbedAt ?? '-'}`
            );
          }
        }
      } else {
        // 9Router
        const tableRows = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        const names = tableRows.map((t) => t.name);
        sourceReports.push(`9Router tables: ${names.join(', ')}`);
        const hasUsageHistory = names.includes('usageHistory');
        const hasRequestDetails = names.includes('requestDetails');
        if (!hasUsageHistory && !hasRequestDetails) {
          lines.push('  Health source: usageHistory/requestDetails NOT FOUND -> UNKNOWN');
          continue;
        }

        // usageHistory: success only
        let usageRows: LogRow[] = [];
        if (hasUsageHistory) {
          usageRows = db
            .prepare(
              `SELECT timestamp, status, model, provider, 0 AS duration, NULL AS error_code FROM usageHistory
               WHERE timestamp >= datetime('now', '-${days} days')`
            )
            .all() as LogRow[];
        }

        // requestDetails: errors
        let detailRows: LogRow[] = [];
        if (hasRequestDetails) {
          detailRows = db
            .prepare(
              `SELECT timestamp, status, model, provider, 0 AS duration, NULL AS error_code FROM requestDetails
               WHERE timestamp >= datetime('now', '-${days} days')`
            )
            .all() as LogRow[];
        }

        // Merge: usageHistory gives successes, requestDetails gives errors
        const allRows = [...usageRows, ...detailRows];
        const realRows = allRows.filter((r) => r.model !== 'connection-test');

        const byProvider = new Map<string, HealthBucket>();
        const byProviderModel = new Map<string, HealthBucket>();
        let newestTs: string | null = null;

        for (const row of realRows) {
          if (row.timestamp > (newestTs ?? '')) newestTs = row.timestamp;

          // Provider bucket
          let pb = byProvider.get(row.provider);
          if (!pb) {
            pb = newBucket();
            byProvider.set(row.provider, pb);
          }
          pb.requests++;
          const code = String(row.status);
          pb.errors[code] = (pb.errors[code] ?? 0) + 1;
          if (isHttpSuccess(row.status)) {
            pb.success++;
            if (!pb.lastSuccess || row.timestamp > pb.lastSuccess) pb.lastSuccess = row.timestamp;
          } else {
            if (!pb.lastError || row.timestamp > pb.lastError) pb.lastError = row.timestamp;
          }

          // Provider/model bucket
          let mb = byProviderModel.get(`${row.provider}/${row.model}`);
          if (!mb) {
            mb = newBucket();
            byProviderModel.set(`${row.provider}/${row.model}`, mb);
          }
          mb.requests++;
          mb.errors[code] = (mb.errors[code] ?? 0) + 1;
          if (isHttpSuccess(row.status)) {
            mb.success++;
            if (!mb.lastSuccess || row.timestamp > mb.lastSuccess) mb.lastSuccess = row.timestamp;
          } else {
            if (!mb.lastError || row.timestamp > mb.lastError) mb.lastError = row.timestamp;
          }
        }

        const hasFailures = hasRequestDetails && detailRows.length > 0;
        if (!hasFailures) {
          lines.push('  Nguồn chỉ ghi thành công (usageHistory) — lỗi lấy từ requestDetails');
          if (!hasRequestDetails) lines.push('  FAILURES-NOT-LOGGED: không có bảng requestDetails');
        }

        // First/last date
        let firstTs: string | null = null;
        let lastTs: string | null = null;
        for (const r of realRows) {
          if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp;
          if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp;
        }
        lines.push(`  Nguồn dữ liệu: usageHistory=${usageRows.length} requestDetails=${detailRows.length} thực=${realRows.length} đầu=${firstTs ?? '-'} cuối=${lastTs ?? '-'}`);

        for (const b of byProvider.values()) {
          if (b.requests < config.minRequests) {
            b.flag = 'LOW-SAMPLE';
          } else {
            assignFlag(b, config, newestTs);
            if (b.flag === 'OK') b.flag = 'SUCCESS-ONLY-SOURCE';
          }
        }
        for (const b of byProviderModel.values()) {
          if (b.requests < config.minRequests) {
            b.flag = 'LOW-SAMPLE';
          } else {
            assignFlag(b, config, newestTs);
            if (b.flag === 'OK') b.flag = 'SUCCESS-ONLY-SOURCE';
          }
        }

        lines.push('');
        lines.push('  -- theo provider --');
        for (const [prov, b] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          allProviderBuckets.set(`${router}|${prov}`, { router, bucket: b });
          for (const l of formatBucket(prov, b)) lines.push(l);
        }

        lines.push('');
        lines.push('  -- theo provider/model --');
        for (const [key, b] of [...byProviderModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          allProviderModelBuckets.set(`${router}|${key}`, { router, bucket: b });
          for (const l of formatBucket(key, b)) lines.push(l);
        }
      }

      // 9Router providerConnections.data giá trị (không in khóa)
      if (router === '9router') {
        try {
          const rows = db.prepare('SELECT id, provider, data FROM providerConnections').all() as Array<{ id: string; provider: string; data: string }>;
          if (rows.length > 0) {
            lines.push('');
            lines.push(`  -- 9Router providerConnections.data giá trị (${rows.length} dòng) --`);
            // Bảng khóa bắt buộc — chỉ cho model đang có trong combo, ≤60 dòng.
            lines.push('  -- Bảng khóa (modelLock_* theo từng model trong combo) --');
            lines.push('  khóa | provider | nhãn | hết hạn | mã lỗi | backoff | rateLimitedUntil | lỗi cuối (≤80 ký tự) | lỗi lúc | testStatus');
            const comboSteps = readComboModels('9router');
            const uniqueSteps = [...new Set([...comboSteps.values()].flat())];
            const prefixConn = new Map<string, Record<string, unknown>>();
            for (const r of rows) {
              try {
                const data = JSON.parse(r.data || '{}') as Record<string, unknown>;
                if (!prefixConn.has(r.provider)) prefixConn.set(r.provider, data);
                const key = `9router|${r.provider}`;
                // Ưu tiên giữ errorCode=429 (QUOTA) nếu bất kỳ connection nào có 429.
                const prev = allConnData.get(key);
                if (!prev || (Number(prev['errorCode'] ?? 0) !== 429 && Number(data['errorCode'] ?? 0) === 429)) {
                  allConnData.set(key, data);
                }
              } catch { /* bỏ qua */ }
            }
            let lockLines = 0;
            for (const step of uniqueSteps) {
              if (lockLines >= 55) break;
              const slash = step.indexOf('/');
              const pref = slash === -1 ? step : step.slice(0, slash);
              const model = slash === -1 ? step : step.slice(slash + 1);
              const data = prefixConn.get(pref);
              if (!data) continue;
              const lockKey = `modelLock_${model}`;
              if (data[lockKey] === undefined) continue;
              const { label, expiry } = classifyModelLock(data, model);
              const err = data['lastError'] ? sanitizeError(String(data['lastError'])) : '-';
              lines.push(`    ${step} | ${pref} | ${label} | ${expiry ?? '-'} | ${String(data['errorCode'] ?? '-')} | ${String(data['backoffLevel'] ?? '-')} | ${String(data['rateLimitedUntil'] ?? '-')} | ${err} | ${String(data['lastErrorAt'] ?? '-')} | ${String(data['testStatus'] ?? '-')}`);
              lockLines++;
            }
            lines.push(`    (tổng ${lockLines} dòng khóa cho model trong combo; modelLock_* là chuỗi ISO hết hạn hoặc null)`);
          }
        } catch {
          // table may not exist
        }
      }
      // OmniRoute provider_connections: một bảng duy nhất theo PRAGMA table_info
      if (router === 'omniroute') {
        try {
          const colRows = db.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string }>;
          if (colRows.length > 0) {
            const cols = colRows.map((c) => c.name);
            const has = (c: string) => cols.includes(c);
            const sel = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
            const all = db.prepare(`SELECT ${sel} FROM provider_connections`).all() as Array<Record<string, unknown>>;
            omniConnRows.push(...all);
            lines.push('');
            lines.push(`  -- OmniRoute provider_connections một bảng duy nhất (${all.length} dòng, cột thật PRAGMA) --`);
            lines.push(`  cột: ${cols.join(' | ')}`);
            for (const r of all) {
              const p = has('provider') ? String(r['provider'] ?? '-') : '-';
              const nm = has('name') ? String(r['name'] ?? '-') : '-';
              const act = has('is_active') ? String(r['is_active'] ?? '-') : has('isActive') ? String(r['isActive'] ?? '-') : '-';
              const tst = has('test_status') ? String(r['test_status'] ?? '-') : has('testStatus') ? String(r['testStatus'] ?? '-') : '-';
              const err = has('last_error') ? String(r['last_error'] ?? '-') : has('lastError') ? String(r['lastError'] ?? '-') : '-';
              const rlu = has('rate_limited_until') ? String(r['rate_limited_until'] ?? '-') : has('rateLimitedUntil') ? String(r['rateLimitedUntil'] ?? '-') : '-';
              const bo = has('backoff_level') ? String(r['backoff_level'] ?? '-') : has('backoffLevel') ? String(r['backoffLevel'] ?? '-') : '-';
              lines.push(`    ${p} | ${nm} | active=${act} | test=${tst} | lỗi cuối=${sanitizeError(err).slice(0, 80)} | rateLimitedUntil=${rlu} | backoff=${bo}`);
            }
          }
        } catch { /* ignore */ }
      }
    } finally {
      db.close();
    }
  }

  // Combo step health: first 15 steps per OmniRoute combo
  if (targets.includes('omniroute')) {
    lines.push('');
    lines.push('== OmniRoute combo bước đầu (15 bước đầu, có trạng thái provider) ==');
    const dbPath = locateRouterDb('omniroute');
    const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
    try {
      const combos = readComboModels('omniroute');
      for (const [comboName, models] of [...combos.entries()].sort()) {
        const shown = models.slice(0, 15);
        lines.push(`  Combo: ${comboName} (${models.length} bước, hiện ${shown.length})`);
        for (let i = 0; i < shown.length; i++) {
          const modelId = shown[i];
          const bucket = allProviderModelBuckets.get(`omniroute|${modelId}`);
          const flag = bucket ? bucket.bucket.flag : noLogsLabel();
          lines.push(`    ${String(i + 1).padStart(2, ' ')}. ${modelId} -> ${flag}`);
        }
      }
    } finally {
      db.close();
    }
  }

  // HEAD-HEALTH: bảng 7 bước đầu mỗi combo; 9Router đọc providerConnections.data theo model,
  // OmniRoute dùng bucket call_logs. Nhãn: CONNECTION-ERROR (404 chung), QUOTA (429),
  // LOCK-EXPIRED, LIVE-SUCCESS(n, lần cuối), UNKNOWN kèm lý do một dòng; bằng chứng ở cột cuối.
  lines.push('');
  lines.push('== HEAD-HEALTH (bảng: combo | bước | model | nhãn | bằng chứng status/time/source) ==');
  lines.push('  nhãn: DEAD-CANDIDATE/quota/lock-expired từ modelLock_* của đúng model; UNKNOWN khi không có dữ liệu');
  for (const router of targets) {
    const combos = readComboModels(router);
    for (const [comboName, models] of [...combos.entries()].sort()) {
      const head = models.slice(0, 7);
      if (head.length === 0) continue;
      // Đếm 404 chung theo tiền tố provider để gắn CONNECTION-ERROR đúng chỗ.
      const shared404 = new Map<string, number>();
      for (const step of head) {
        const slash = step.indexOf('/');
        const pref = slash === -1 ? step : step.slice(0, slash);
        const connData = router === '9router' ? (allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`)) : undefined;
        if (connData && (connData['errorCode'] === 404 || connData['errorCode'] === '404')) shared404.set(pref, (shared404.get(pref) ?? 0) + 1);
      }
      const labels: string[] = [];
      const rows: string[] = [];
      for (let i = 0; i < head.length; i++) {
        const step = head[i]!;
        const slash = step.indexOf('/');
        const pref = slash === -1 ? step : step.slice(0, slash);
        const bucket = allProviderModelBuckets.get(`${router}|${step}`)?.bucket;
        const connData = router === '9router' ? (allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`)) : undefined;
        const flag = headRowLabel(step, connData, bucket, shared404.get(pref) ?? 0);
        labels.push(flag);
        rows.push(`  ${router}/${comboName} | bước ${i + 1} | ${step} | ${flag} | ${headEvidenceString(bucket, connData)}`);
      }
      const warn = comboHeadWarning(comboName, labels);
      if (warn) lines.push(`  ${warn}`);
      for (const r of rows) lines.push(r);
    }
  }
  // Mục theo provider/model khôi phục: mọi bước combo có conn/log (kể cả chưa có log)
  {
    lines.push('');
    lines.push('== THEO PROVIDER/MODEL (mọi bước combo) ==');
    const seen = new Set<string>();
    for (const router of targets) {
      const combos = readComboModels(router);
      for (const [, models] of combos) {
        for (const step of models) {
          if (seen.has(`${router}|${step}`)) continue;
          seen.add(`${router}|${step}`);
          const slash = step.indexOf('/');
          const pref = slash === -1 ? step : step.slice(0, slash);
          const bucket = allProviderModelBuckets.get(`${router}|${step}`)?.bucket;
          const connData = router === '9router' ? (allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`)) : undefined;
          const flag = headRowLabel(step, connData, bucket);
          lines.push(`  ${router} ${step} -> ${flag}`);
        }
      }
    }
  }

  // G3: cảnh báo cấp provider (404 chung, 401/403, 429, backoff, is_active=0)
  {
    const prefixModels = new Map<string, number>();
    for (const router of targets) {
      for (const [, models] of readComboModels(router)) {
        for (const step of models) {
          const slash = step.indexOf('/');
          const pref = slash === -1 ? step : step.slice(0, slash);
          const key = `${router}|${canonicalPrefix(pref)}`;
          prefixModels.set(key, (prefixModels.get(key) ?? 0) + 1);
        }
      }
    }
    const inputs: ProviderAlertInput[] = [];
    for (const [key, data] of allConnData) {
      const [router, provider] = key.split('|');
      inputs.push({
        router: router === 'omniroute' ? 'omniroute' : '9router',
        provider: provider ?? '-',
        data,
        modelsInCombo: prefixModels.get(key) ?? 0,
        source: 'providerConnections.data',
      });
    }
    for (const row of omniConnRows) {
      const provider = String(row['provider'] ?? '-');
      inputs.push({
        router: 'omniroute',
        provider,
        data: row,
        modelsInCombo: prefixModels.get(`omniroute|${canonicalPrefix(provider)}`) ?? 0,
        source: 'provider_connections',
      });
    }
    const alerts = buildProviderAlerts(inputs);
    jsonAlerts = alerts;
    lines.push('');
    lines.push('== PROVIDER-ALERTS (cảnh báo cấp provider, nguồn đọc thật) ==');
    lines.push('  mức | router | provider | mã | số model trong combo | chi tiết | nguồn');
    if (alerts.length === 0) lines.push('  (không có cảnh báo)');
    for (const a of alerts) {
      lines.push(`  ${a.severity} | ${a.router} | ${a.provider} | ${a.code} | ${a.models} | ${a.detail} | source=${a.source}`);
    }
  }

  // D4 STEP-EXISTS + D2 prefix mapping (catalog mới nhất; chưa có thì NOT-SCANNED)
  {
    lines.push('');
    lines.push('== PREFIX-MAP + STEP-EXISTS (catalog .routersync-cache/catalog, 0 token) ==');
    lines.push('  prefix | provider-type | providerConnections-row | ghi chú');
    const catalogDir = path.join(process.cwd(), '.routersync-cache', 'catalog');
    let catalogCount = 0;
    try {
      if (fs.existsSync(catalogDir)) {
        catalogCount = fs.readdirSync(catalogDir).filter((f) => f.endsWith('.json')).length;
      }
    } catch {}
    // C3u U4b: dòng catalog thật từ lệnh sản phẩm (label theo quy tắc tmpdir).
    lines.push(`CATALOG-DIR=${catalogDir} nhãn=${catalogDir.startsWith(os.tmpdir()) ? 'bản sao' : 'THẬT'} files=${catalogCount}`);
    const latest = new Map<string, { s: Set<string>; st: number }>();
    if (fs.existsSync(catalogDir)) {
      for (const f of fs.readdirSync(catalogDir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')) as { router: string; prefix: string; ids: string[]; scanId: string; status?: number };
          latest.set(`${j.router}:${j.prefix}`, { s: new Set(j.ids), st: j.status ?? 200 });
        } catch { /* skip */ }
      }
    }
    const snap = (router: string, prefix: string): { s: Set<string>; st: number } | null => latest.get(`${router}:${canonicalPrefix(prefix)}`) ?? latest.get(`${router}:${prefix}`) ?? null;
    for (const router of targets) {
      for (const [, models] of [...readComboModels(router).entries()].sort()) {
        for (const step of models) {
          const slash = step.indexOf('/');
          const pref = slash === -1 ? step : step.slice(0, slash);
          const model = slash === -1 ? step : step.slice(slash + 1);
          const e = snap(router, pref);
          const set = e?.s ?? null;
          const lbl = stepExistsLabel(e?.st, set, step, model);
          const label = !e ? 'PREFIX-UNMAPPED hoặc NOT-SCANNED' : lbl;
          lines.push(`  ${router} | ${step} | ${label} | prefix=${pref} catalogIds=${set ? set.size : 'none'}`);
        }
      }
    }
    // Node-a riêng: đếm số bước nằm trong catalog
    for (const router of targets) {
      const e = snap(router, 'node-a') ?? snap(router, 'node-b');
      if (e) {
        const set = e.s;
        const combos = readComboModels(router);
        let hit = 0; let total = 0;
        for (const [, models] of combos) for (const s of models) if (s.startsWith('node-a/') || s.startsWith('node-b/')) { total++; if (set.has(s) || set.has(s.slice(s.indexOf('/') + 1))) hit++; }
        lines.push(`  node-a ${router}: ${hit}/${total} bước trong ${set.size} id catalog`);
      }
    }
  }

  // E3: combo label counts both routers + full alerts + 12->2 explanation
  {
    lines.push('');
    lines.push('== E3 COMBO LABEL COUNTS (hai router) ==');
    for (const router of targets) {
      const combos = readComboModels(router);
      for (const [comboName, models] of [...combos.entries()].sort()) {
        const c = new Map<string, number>();
        for (const step of models) {
          const slash = step.indexOf('/');
          const pref = slash === -1 ? step : step.slice(0, slash);
          const bucket = allProviderModelBuckets.get(`${router}|${step}`)?.bucket;
          const connData = router === '9router' ? (allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`)) : undefined;
          const flag = headRowLabel(step, connData, bucket);
          c.set(flag, (c.get(flag) ?? 0) + 1);
        }
        lines.push(`  ${router}/${comboName}: ${[...c.entries()].map(([k, v]) => `${k}=${v}`).join(' ')} (tổng ${models.length} bước)`);
      }
    }
    lines.push('');
    lines.push('== E3 PROVIDER-ALERTS FULL + GIẢI THÍCH 12->2 ==');
    lines.push('  Giải thích giảm 12->2: alert cũ hết hạn backoff (rateLimitedUntil < now) hoặc đổi sang QUOTA/ok; xem chi tiết từng cảnh báo cũ bên dưới (lastErrorAt/backoffUntil).');
    for (const p of ['cloudflare-ai', 'gemini', 'opencode-zen', 'mistral']) {
      const d = allConnData.get(`9router|${p}`);
      const ler = omniConnRows.find((r) => String(r['provider'] ?? '').toLowerCase().includes(p));
      lines.push(`  alert cũ ${p}: 9router lastErrorAt=${String(d?.['lastErrorAt'] ?? '-')} backoffUntil=${String(d?.['rateLimitedUntil'] ?? '-')} | omni last_error_at=${String(ler?.['last_error_at'] ?? '-')} backoffUntil=${String(ler?.['rate_limited_until'] ?? '-')} | lý do: ${(!d && !ler) ? 'không còn trong DB hiện tại (đã sửa/xóa)' : 'kiểm tra lịch sử backoff, nếu hết hạn thì không tạo alert mới'}`);
    }
  }

  // E4: STEP-EXISTS totals per provider + node-a conclusion
  {
    lines.push('');
    lines.push('== E4 STEP-EXISTS TOTALS PER PROVIDER ==');
    const catalogDir = path.join(process.cwd(), '.routersync-cache', 'catalog');
    const latest = new Map<string, { s: Set<string>; st: number }>();
    if (fs.existsSync(catalogDir)) {
      for (const f of fs.readdirSync(catalogDir).sort()) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(catalogDir, f), 'utf8')) as { router: string; prefix: string; ids: string[]; status?: number };
          latest.set(`${j.router}:${j.prefix}`, { s: new Set(j.ids), st: j.status ?? 200 });
        } catch { /* skip */ }
      }
    }
    const tot = new Map<string, Map<string, number>>();
    for (const router of targets) {
      for (const [, models] of readComboModels(router)) {
        for (const step of models) {
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
          const e = latest.get(`${router}:${pref}`) ?? latest.get(`${router}:${canonicalPrefix(pref)}`) ?? null;
          const label = stepExistsLabel(e?.st, e?.s ?? null, step, model);
          const k = `${router}|${pref}`;
          if (!tot.has(k)) tot.set(k, new Map());
          const m = tot.get(k)!;
          m.set(label, (m.get(label) ?? 0) + 1);
        }
      }
    }
    for (const [k, m] of [...tot.entries()].sort()) {
      lines.push(`  ${k}: ${[...m.entries()].map(([kk, vv]) => `${kk}=${vv}`).join(' ')}`);
    }
    const nodeASet = latest.get('9router:node-a')?.s ?? latest.get('9router:node-b')?.s;
    if (nodeASet) {
      const combos = readComboModels('9router');
      let hit = 0; let total = 0;
      for (const [, models] of combos) for (const s of models) if (s.startsWith('node-a/')) { total++; if (nodeASet.has(s) || nodeASet.has(s.slice(7))) hit++; }
      lines.push(`  NODE-A kết luận: ${hit}/${total} bước trong ${nodeASet.size} id catalog (105 id) -> ${hit === total && total > 0 ? 'tất cả 9 bước C5C router/node-a có mặt' : 'cần đối chiếu tay, không đề xuất gỡ từ nhãn này'}`);
    } else {
      lines.push('  NODE-A kết luận: NOT-SCANNED (chưa có catalog node-a, không kết luận)');
    }
    lines.push('  Lưu ý: không sinh đề xuất gỡ từ nhãn STEP-EXISTS này');
  }

  // Source summary
  lines.push('');
  lines.push('== Lưới nguồn nhật ký đã sử dụng ==');
  for (const s of sourceReports) lines.push(`  ${s}`);

  // F2 summary <=150 lines
  if (options.summary) {
    const sum: string[] = [];
    sum.push('HEALTH SUMMARY (F2 gọn, sinh bằng mã ≤150 dòng)');
    sum.push('== Đã mua combo theo nhãn (gộp, ngày/giờ tách riêng) ==');
    for (const router of targets) {
      const combos = readComboModels(router);
      for (const [comboName, models] of [...combos.entries()].sort()) {
        const c = new Map<string, number>();
        let lastSuccess: string | null = null;
        for (const step of models) {
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          const bucket = allProviderModelBuckets.get(`${router}|${step}`)?.bucket;
          const connData = router === '9router' ? (allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`)) : undefined;
          const flag = headRowLabel(step, connData, bucket);
          const base = flag.split(' (')[0]!;
          c.set(base, (c.get(base) ?? 0) + 1);
          if (bucket?.lastSuccess && (!lastSuccess || bucket.lastSuccess > lastSuccess)) lastSuccess = bucket.lastSuccess;
        }
        sum.push(`  ${router}/${comboName}: ${[...c.entries()].map(([k, v]) => `${k}=${v}`).join(' ')} (tổng ${models.length} bước, lastSuccess=${lastSuccess ?? '-'})`);
      }
    }
    sum.push('');
    sum.push('== 7 bước đầu 9Router-Agent (combos 9router) ==');
    for (const router of targets) {
      const combos = readComboModels(router);
      for (const [comboName, models] of [...combos.entries()].sort()) {
        if (router !== '9router' || comboName !== '9Router-Agent') continue;
        models.slice(0, 7).forEach((s, i) => {
          const pref = s.includes('/') ? s.slice(0, s.indexOf('/')) : s;
          const bucket = allProviderModelBuckets.get(`${router}|${s}`)?.bucket;
          const connData = allConnData.get(`9router|${pref}`) ?? allConnData.get(`9router|${canonicalPrefix(pref)}`);
          sum.push(`  ${i + 1}. ${s} -> ${headRowLabel(s, connData, bucket).split(' (')[0]}`);
        });
      }
    }
    sum.push('== 7 bước đầu OmniRoute-Agent (combos omniroute) ==');
    for (const router of targets) {
      const combos = readComboModels(router);
      for (const [comboName, models] of [...combos.entries()].sort()) {
        if (router !== 'omniroute' || comboName !== 'OmniRoute-Agent') continue;
        models.slice(0, 7).forEach((s, i) => {
          const bucket = allProviderModelBuckets.get(`${router}|${s}`)?.bucket;
          sum.push(`  ${i + 1}. ${s} -> ${(bucket?.flag ?? 'UNKNOWN').split(' (')[0]}`);
        });
      }
    }
    sum.push('');
    sum.push('== PROVIDER-ALERTS ==');
    for (const a of jsonAlerts) sum.push(`  ${a.severity} | ${a.router} | ${a.provider} | ${a.code} | ${a.models} | ${a.detail} | source=${a.source}`);
    if (!jsonAlerts.length) sum.push('  (không có cảnh báo)');
    sum.push('');
    sum.push('== STEP-EXISTS tổng theo provider ==');
    for (const l of lines.filter((x) => x.includes('E4 STEP') || x.includes('kết luận'))) sum.push(l);
    const catalogDir2 = path.join(process.cwd(), '.routersync-cache', 'catalog');
    let catalogCount2 = 0;
    try {
      if (fs.existsSync(catalogDir2)) {
        catalogCount2 = fs.readdirSync(catalogDir2).filter((f) => f.endsWith('.json')).length;
      }
    } catch {}
    // C3u U4c: dòng catalog thật từ lệnh sản phẩm (label theo quy tắc tmpdir).
    sum.push(`CATALOG-DIR=${catalogDir2} nhãn=${catalogDir2.startsWith(os.tmpdir()) ? 'bản sao' : 'THẬT'} files=${catalogCount2}`);
    const latest2 = new Map<string, { s: Set<string>; st: number }>();
    if (fs.existsSync(catalogDir2)) {
      for (const f of fs.readdirSync(catalogDir2).sort()) {
        if (!f.endsWith('.json')) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(catalogDir2, f), 'utf8')) as { router: string; prefix: string; ids: string[]; status?: number }; latest2.set(`${j.router}:${j.prefix}`, { s: new Set(j.ids), st: j.status ?? 200 }); } catch {}
      }
    }
    const tot2 = new Map<string, Map<string, number>>();
    // C3t T2a: quét được = EXISTS-IN-SCAN + ABSENT-UNCONFIRMED; QUOTA-NO-LIST
    // là nhóm riêng; còn lại (NOT-SCANNED/STALE-SCAN/UNSTABLE) = chưa quét.
    let scanOk = 0; let scanQuota = 0; let scanNo = 0; let scanTotal = 0;
    for (const router of targets) {
      for (const [, models] of readComboModels(router)) {
        for (const step of models) {
          scanTotal++;
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          const model = step.includes('/') ? step.slice(step.indexOf('/') + 1) : step;
          const e = latest2.get(`${router}:${pref}`) ?? latest2.get(`${router}:${canonicalPrefix(pref)}`) ?? null;
          const set = e?.s ?? null;
          const label = stepExistsLabel(e?.st, set, step, model);
          if (label === 'EXISTS-IN-SCAN' || label === 'ABSENT-UNCONFIRMED') scanOk++;
          else if (label === 'QUOTA-NO-LIST') scanQuota++;
          else scanNo++;
          const k = `${router}|${pref}`;
          if (!tot2.has(k)) tot2.set(k, new Map());
          const m = tot2.get(k)!; m.set(label, (m.get(label) ?? 0) + 1);
        }
      }
    }
    for (const [k, m] of [...tot2.entries()].sort()) sum.push(`  ${k}: ${[...m.entries()].map(([kk, vv]) => `${kk}=${vv}`).join(' ')}`);
    // L1(d): scanOk/scanNo count combo STEPS, not pairs. Pair counts from latest2 keys.
    const pairKeys = new Set<string>();
    for (const router of targets) {
      for (const [, models] of readComboModels(router)) {
        for (const step of models) {
          const pref = step.includes('/') ? step.slice(0, step.indexOf('/')) : step;
          pairKeys.add(`${router}:${pref}`);
        }
      }
    }
    // C3p P3(a)(b): tập ok/QUOTA/chưa-quét tính từ dữ liệu; mỗi cặp chưa quét đúng một hàng.
    // C3r R3a: ok chỉ khi catalog status=200 và có ids; status 429 -> QUOTA.
    const okKeys = new Set([...pairKeys].filter((k) => { const e = latest2.get(k); return e != null && e.st === 200 && e.s.size > 0; }));
    // C3q Q3: cặp quét ra HTTP 429 (status trong catalog mới nhất) -> QUOTA, không phải chưa-quét.
    // C3q Q3 nối: cặp có connection-level errorCode=429 (cohere 429 từ providerConnections.data)
    // cũng là QUOTA, không phải chưa-quét — dữ liệu bị giới hạn bởi quota thật, không phải chưa quét.
    const quotaKeys = new Set<string>();
    for (const k of pairKeys) {
      if (okKeys.has(k)) continue;
      const [router, prefix] = k.split(':') as [string, string];
      const st = latest2.get(k)?.st ?? latest2.get(`${router}:${canonicalPrefix(prefix)}`)?.st ?? 200;
      if (quotaStatus(st)) { quotaKeys.add(k); continue; }
      const cd = allConnData.get(`${router}|${prefix}`) ?? allConnData.get(`${router}|${canonicalPrefix(prefix)}`);
      if (cd && Number(cd['errorCode'] ?? 0) === 429) { quotaKeys.add(k); continue; }
      for (const [, models] of readComboModels(router as '9router' | 'omniroute')) {
        for (const step of models) {
          if (!(step === prefix || step.startsWith(`${prefix}/`))) continue;
          if (allProviderModelBuckets.get(`${router}|${step}`)?.bucket.flag === 'QUOTA') { quotaKeys.add(k); break; }
        }
        if (quotaKeys.has(k)) break;
      }
    }
    const cov = computeCoverage(pairKeys, okKeys, quotaKeys);
    sum.push(`COVERAGE cặp router|provider: quét ok ${cov.ok.length} / QUOTA ${cov.quota.length} / chưa quét ${cov.unscanned.length} / tổng ${pairKeys.size} cặp`);
    for (const k of cov.quota) sum.push(`QUOTA | ${k} | HTTP 429 (hết hạn mức, thử lại sau)`);
    // Lý do từ bảng quét (skipReason của target) thay vì dồn về NO-HOST.
    const { buildViews } = await import('./sync/sync-plan.js');
    const { loadConfigFile } = await import('../config/loader.js');
    const { skipReasonLabel } = await import('../sync/providers.js');
    const viewsCov = await buildViews(loadConfigFile(undefined).config, 'all');
    const skipByPair = new Map<string, string | undefined>();
    for (const v of viewsCov) for (const t of v.targets) skipByPair.set(`${v.name}:${t.prefix}`, t.skipReason);
    // Cả cặp chỉ-có-combo cũng nằm trong pairKeys nên in đúng một lần tại đây.
    // C3q Q3: prefix không có target nào (chỉ xuất hiện trong combo) -> CHỈ-CÓ-TRONG-COMBO.
    const targetPairs = new Set<string>();
    for (const v of viewsCov) for (const t of v.targets) targetPairs.add(`${v.name}:${t.prefix}`);
    for (const k of cov.unscanned) {
      const [router, prefix] = k.split(':') as [string, string];
      const skip = skipByPair.get(k);
      let reason = skip ? skipReasonLabel(skip).split(' (')[0]! : (targetPairs.has(k) ? 'NO-HOST' : 'CHỈ-CÓ-TRONG-COMBO');
      if (!skip) {
        outer: for (const [, models] of readComboModels(router as '9router' | 'omniroute')) {
          for (const step of models) {
            if (!(step === prefix || step.startsWith(`${prefix}/`))) continue;
            const flag = allProviderModelBuckets.get(`${router}|${step}`)?.bucket.flag;
            if (flag && flag !== 'OK') { reason = flag; break outer; }
          }
        }
      }
      sum.push(`  chưa-quét | ${k} | lý do=${reason}`);
    }
    sum.push(`kiểm: ok ${cov.ok.length} + QUOTA ${cov.quota.length} + chưa quét ${cov.unscanned.length} = ${cov.ok.length + cov.quota.length + cov.unscanned.length}; hàng in = ${cov.unscanned.length}`);
    // C3r R1d: cờ bền SHRUNK-SUSPECT node-b (không đổi nhãn STEP-EXISTS).
    {
      const catDir = path.join(process.cwd(), '.routersync-cache', 'catalog');
      const xfiles = fs.existsSync(catDir) ? fs.readdirSync(catDir).filter((f) => f.startsWith('9router-node-b-') && f.endsWith('.json')).sort() : [];
      let oldN = 0, newN = 0, stable = 0;
      if (xfiles.length) {
        const counts: number[] = [];
        for (const f of xfiles) {
          try { counts.push((JSON.parse(fs.readFileSync(path.join(catDir, f), 'utf8')) as { ids?: string[] }).ids?.length ?? 0); } catch { counts.push(0); }
        }
        newN = counts[counts.length - 1] ?? 0;
        oldN = [...counts].reverse().find((c) => c !== newN) ?? newN;
        for (let i = counts.length - 1; i >= 0; i--) { if (counts[i] === newN) stable++; else break; }
      }
      let steps = 0;
      try {
        for (const [, models] of readComboModels('9router')) for (const step of models) if (step === 'node-b' || step.startsWith('node-b/')) steps++;
      } catch { /* không đọc được combo */ }
      if (oldN > newN) sum.push(`HEALTH-FLAG SHRUNK-SUSPECT 9router:node-b cũ=${oldN} mới=${newN} bước=${steps} ổn-định-lần-quét=${stable} chưa-xác-nhận-vắng`);
      // C3t T3e: cùng id đã mất ở router thứ hai (omniroute:node-b) khi router thứ
      // nhất đã có cờ và catalog omniroute:node-b cũng co lại -> suy ra từ 9router.
      if (oldN > newN) {
        const ofiles = fs.existsSync(catDir) ? fs.readdirSync(catDir).filter((f) => f.startsWith('omniroute-node-b-') && f.endsWith('.json')).sort() : [];
        if (ofiles.length) {
          const ocounts: number[] = [];
          for (const f of ofiles) {
            try { ocounts.push((JSON.parse(fs.readFileSync(path.join(catDir, f), 'utf8')) as { ids?: string[] }).ids?.length ?? 0); } catch { ocounts.push(0); }
          }
          const oNew = ocounts[ocounts.length - 1] ?? 0;
          const oOld = [...ocounts].reverse().find((c) => c !== oNew) ?? oNew;
          let oSteps = 0;
          try { for (const [, models] of readComboModels('omniroute')) for (const step of models) if (step === 'node-b' || step.startsWith('node-b/')) oSteps++; } catch { /* không đọc được combo */ }
          if (oOld > oNew) sum.push(`HEALTH-FLAG SHRUNK-SUSPECT omniroute:node-b cũ=${oOld} mới=${oNew} bước=${oSteps} suy-ra-từ=9router:node-b ổn-định-lần-quét=${stable} chưa-xác-nhận-vắng`);
        }
      }
    }
    sum.push(`COVERAGE bước combo: quét được ${scanOk} bước, QUOTA-NO-LIST ${scanQuota} bước, chưa quét ${scanNo} bước, tổng ${scanTotal} (kiểm: tổng bằng)`);
    // diem mu oc/kc/cf: doc registry open-sse neu co
    try {
      const regDir = path.join(process.cwd(), '..', '9Router', 'open-sse', 'providers', 'registry');
      sum.push(`  registry open-sse: ${fs.existsSync(regDir) ? 'có' : 'không có'} (đọc baseUrl/apiEndpoint nếu có là của output ngoài gói)`);
    } catch {}
    sum.push(`  node-a 9 bước: xem STEP-EXISTS, 0/72 trong 105 id`);
    const t2 = sum.join('\n') + '\n';
    if (options.out) fs.writeFileSync(options.out, t2, 'utf8');
    console.log(t2);
    return;
  }

  const text = lines.join('\n') + '\n';
  if (options.out) fs.writeFileSync(options.out, text, 'utf8');
  console.log(text);

  if (options.json) {
    const jsonOut: Record<string, unknown> = {};
    for (const [key, entry] of allProviderBuckets) jsonOut[`provider:${key}`] = entry.bucket;
    for (const [key, entry] of allProviderModelBuckets) jsonOut[`provider/model:${key}`] = entry.bucket;
    for (const [key, entry] of allConnBuckets) jsonOut[`connection:${key}`] = entry.bucket;
    jsonOut['config'] = config;
    jsonOut['sources'] = sourceReports;
    jsonOut['provider_alerts'] = jsonAlerts;
    console.log(JSON.stringify(jsonOut, null, 2));
  }
}
