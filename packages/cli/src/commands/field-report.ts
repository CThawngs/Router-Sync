/**
 * packages/cli/src/commands/field-report.ts
 *
 * Tickets C49-T1 & C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 * Strictly Read-Only Field Testing Bundle Exporter (`routersync field-report`).
 *
 * Non-Negotiable Guarantees:
 *  - 100% Read-Only on `<stateDir>` and `routersync.yaml` (zero file/dir creation,
 *    zero writes, zero `mtime` updates, zero SQLite opens, zero network calls).
 *  - Output directory `--out <dir>` MUST resolve outside `<stateDir>` both lexically
 *    and via `resolveDeepCanonicalPath` (symlink/junction traversal), and MUST NOT
 *    target `bots.json`, `routines.json`, or an existing regular file.
 *  - Emits strictly `<= 8` files (`FIELD_REPORT_BUNDLE_FILES`).
 *  - Two-stage independent sanitization: Stage-1 Scrubber (`field-report-scrubber.ts`)
 *    followed by Stage-2 Independent Pre-Write Output Scanner (`field-report-scanner.ts`)
 *    inspecting all serialized file buffers in RAM BEFORE `fs.mkdirSync` or any
 *    disk write. Any scanner match aborts with `process.exitCode = 1` and `0` files written.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  isPathInsideDir,
  readApplyHistory,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  resolveDeepCanonicalPath,
} from '@routersync/core';
import { expandTilde } from '../config/loader.js';
import {
  detectFieldAnomalies,
  type FieldAnomalyEntry,
  type FieldCatalogSnapshot,
  type FieldComboSnapshot,
  type FieldModelObservation,
  type FieldModelSummary,
  type FieldProviderSummary,
  type FieldShrinkBlockObservation,
  type FieldTimelineRecord,
  type LatencyDistribution,
} from './field-report-anomalies.js';
import {
  type FieldReportScanViolation,
  scanSerializedFieldReportOutputs,
} from './field-report-scanner.js';
import {
  scrubFieldReportString,
  scrubFieldReportValue,
} from './field-report-scrubber.js';
import {
  collectFieldReportSecretContextReadOnly,
  extractTickFreeTextNote,
  parseJsonTickLogLineSummary,
} from './field-report-secrets-context.js';

export const FIELD_REPORT_BUNDLE_FILES = [
  'summary.json',
  'timeline.jsonl',
  'providers.json',
  'models.json',
  'anomalies.json',
  'resources.json',
  'config-shape.json',
  'README.md',
] as const;

const FORBIDDEN_RUNTIME_FILENAMES = new Set(['bots.json', 'routines.json']);
const FOLD_PATH_CASE = process.platform === 'win32' || process.platform === 'darwin';

export const DEFAULT_ERROR_RATE_THRESHOLD = 0.2;
export const DEFAULT_INTERVAL_DRIFT_TOLERANCE_RATIO = 0.5;
export const DEFAULT_SLOW_TICK_MS = 30_000;
export const DEFAULT_SHRINK_CAP_RATIO = 0.1;

export interface FieldReportCommandOptions {
  out?: string | undefined;
  stateDir?: string | undefined;
  config?: string | undefined;
  configPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  errorRateThreshold?: number | string | undefined;
  expectedIntervalMs?: number | string | undefined;
  slowTickMs?: number | string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  json?: boolean | undefined;
  nowMs?: number | undefined;
  silent?: boolean | undefined;
  writeStdout?: ((text: string) => void) | undefined;
  /** Internal adversarial test hook to verify Stage-2 scanner independence & refusal */
  _unsafeSkipStage1ScrubberForScannerTest?: boolean | undefined;
}

export interface FieldReportSummaryPayload {
  schemaVersion: 1;
  generatedAt: string;
  window: {
    since: string | null;
    until: string | null;
    firstEventAt: string | null;
    lastEventAt: string | null;
  };
  counts: {
    ticks: number;
    applies: number;
    rollbacks: number;
    freezes: number;
    unfreezes: number;
    providers: number;
    models: number;
  };
  anomalyCount: number;
  anomaliesBySeverity: {
    critical: number;
    high: number;
    warn: number;
    info: number;
  };
  scrubSummary: {
    stage1Applied: boolean;
    stage2VerifiedClean: boolean;
    redactedCount: number;
  };
  healthSnapshot: {
    freezeActive: boolean;
    freezeReason: string | null;
    consentValid: boolean;
    activeConsentTargets: number;
    latestTickMode: string | null;
  };
  inboxSummary: {
    totalItems: number;
    recentItems: Array<{
      id: string;
      type: string;
      label: string | null;
      timestamp: string | null;
      title: string;
      body: string;
    }>;
  };
}

export interface FieldReportRunResult {
  outDir: string;
  writtenFiles: string[];
  summary: FieldReportSummaryPayload;
  anomalies: FieldAnomalyEntry[];
}

function normPathCompare(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return FOLD_PATH_CASE ? resolved.toLowerCase() : resolved;
}

function isSameNormalizedPath(a: string, b: string): boolean {
  return normPathCompare(a) === normPathCompare(b);
}

/**
 * Validates `--out <dir>` ensuring it is non-empty, not a forbidden runtime file,
 * not an existing regular file, and strictly outside `<stateDir>` both lexically
 * and after canonical symlink/junction resolution.
 */
export function assertFieldReportOutDir(
  rawOutPath: string | undefined,
  stateDir: string,
  resolveCanonicalFn: (p: string) => string = resolveDeepCanonicalPath
): string {
  if (typeof rawOutPath !== 'string' || rawOutPath.trim().length === 0) {
    throw new Error('INVALID_ARGUMENT: --out <dir> is required for routersync field-report.');
  }

  const expandedOut = expandTilde(rawOutPath.trim());
  const lexicalOut = path.resolve(expandedOut);
  const lexicalState = path.resolve(stateDir);

  const outBase = path.basename(lexicalOut).toLowerCase();
  if (FORBIDDEN_RUNTIME_FILENAMES.has(outBase)) {
    throw new Error(
      `FORBIDDEN_RUNTIME_FILE: Refusing to write field-report into protected runtime file "${outBase}".`
    );
  }

  if (
    isSameNormalizedPath(lexicalOut, lexicalState) ||
    isPathInsideDir(lexicalOut, lexicalState) ||
    isPathInsideDir(lexicalState, lexicalOut)
  ) {
    throw new Error(
      'FIELD_REPORT_OUT_INSIDE_STATE_DIR: --out <dir> must resolve outside <stateDir>.'
    );
  }

  const canonicalOut = resolveCanonicalFn(lexicalOut);
  const canonicalState = resolveCanonicalFn(lexicalState);
  const canonBase = path.basename(canonicalOut).toLowerCase();
  if (FORBIDDEN_RUNTIME_FILENAMES.has(canonBase)) {
    throw new Error(
      `FORBIDDEN_RUNTIME_FILE: Canonical --out target "${canonBase}" is a protected runtime file.`
    );
  }

  if (
    isSameNormalizedPath(canonicalOut, canonicalState) ||
    isPathInsideDir(canonicalOut, canonicalState) ||
    isPathInsideDir(canonicalState, canonicalOut)
  ) {
    throw new Error(
      'FIELD_REPORT_OUT_INSIDE_STATE_DIR: --out <dir> resolves inside <stateDir> via symlink or junction.'
    );
  }

  if (fs.existsSync(lexicalOut)) {
    const st = fs.statSync(lexicalOut);
    if (!st.isDirectory()) {
      throw new Error('INVALID_ARGUMENT: --out path already exists and is not a directory.');
    }
  }

  return lexicalOut;
}

function parseOptionalIsoBound(raw: string | undefined, flagName: string): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`INVALID_ARGUMENT: ${flagName} cannot be empty.`);
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`INVALID_ARGUMENT: ${flagName} must be a valid ISO-8601 timestamp.`);
  }
  return ms;
}

function parseThresholdRatio(
  raw: number | string | undefined,
  defaultVal: number,
  flagName: string
): number {
  if (raw === undefined) return defaultVal;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new Error(`INVALID_ARGUMENT: ${flagName} must be a number in [0, 1].`);
  }
  return num;
}

function parsePositiveMs(
  raw: number | string | undefined,
  defaultVal: number | null,
  flagName: string
): number | null {
  if (raw === undefined) return defaultVal;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`INVALID_ARGUMENT: ${flagName} must be a positive number in milliseconds.`);
  }
  return num;
}

function computeDistribution(values: readonly number[]): LatencyDistribution {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { min: null, p50: null, p95: null, max: null };
  }
  const percentile = (p: number): number => {
    const idx = Math.min(
      finite.length - 1,
      Math.max(0, Math.ceil((p / 100) * finite.length) - 1)
    );
    return finite[idx]!;
  };
  return {
    min: finite[0]!,
    p50: percentile(50),
    p95: percentile(95),
    max: finite[finite.length - 1]!,
  };
}

function parseScheduleExpressionToMs(expr: unknown): number | null {
  if (typeof expr !== 'string') return null;
  const m = /^\s*every\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)\s*$/i.exec(expr);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's' || unit === 'sec') return Math.round(amount * 1000);
  if (unit === 'm' || unit === 'min') return Math.round(amount * 60_000);
  if (unit === 'h' || unit === 'hr') return Math.round(amount * 3_600_000);
  if (unit === 'd') return Math.round(amount * 86_400_000);
  return null;
}

interface ConfigShapeSkeleton {
  present: boolean;
  version: number | null;
  routers: Array<{
    id: string;
    adapter: string;
    isolated: boolean;
    hasBaseUrl: boolean;
    hasDbPath: boolean;
  }>;
  policy: {
    mode: string | null;
    syncSchedule: string | null;
    healthSchedule: string | null;
  };
  schedule: {
    intervalMinutes: number | null;
    expectedIntervalMs: number | null;
  };
  combos: Array<{
    name: string;
    role: string | null;
    routers: string[];
    size: number | null;
    pinCount: number;
  }>;
  webhook: {
    enabled: boolean;
    hasUrl: boolean;
  };
}

function readConfigShapeReadOnly(
  explicitConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env
): ConfigShapeSkeleton {
  const empty: ConfigShapeSkeleton = {
    present: false,
    version: null,
    routers: [],
    policy: { mode: null, syncSchedule: null, healthSchedule: null },
    schedule: { intervalMinutes: null, expectedIntervalMs: null },
    combos: [],
    webhook: { enabled: false, hasUrl: false },
  };

  let candidatePath: string | null = null;
  if (typeof explicitConfigPath === 'string' && explicitConfigPath.trim().length > 0) {
    candidatePath = path.resolve(expandTilde(explicitConfigPath.trim()));
  } else if (env['ROUTERSYNC_CONFIG']?.trim()) {
    candidatePath = path.resolve(expandTilde(env['ROUTERSYNC_CONFIG'].trim()));
  }

  if (!candidatePath || !fs.existsSync(candidatePath)) {
    return empty;
  }

  try {
    const raw = fs.readFileSync(candidatePath, 'utf8');
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return empty;

    const rawRouters = Array.isArray(parsed['routers']) ? parsed['routers'] : [];
    const routers = rawRouters
      .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
      .map((r) => {
        const dbObj =
          r['db'] && typeof r['db'] === 'object' ? (r['db'] as Record<string, unknown>) : null;
        return {
          id: typeof r['id'] === 'string' ? r['id'] : 'unknown',
          adapter: typeof r['adapter'] === 'string' ? r['adapter'] : 'unknown',
          isolated: Boolean(r['isolated']),
          hasBaseUrl: typeof r['baseUrl'] === 'string' && r['baseUrl'].trim().length > 0,
          hasDbPath: Boolean(
            (dbObj && typeof dbObj['path'] === 'string' && dbObj['path'].trim().length > 0) ||
              (typeof r['dbPath'] === 'string' && r['dbPath'].trim().length > 0)
          ),
        };
      });

    const policyObj =
      parsed['policy'] && typeof parsed['policy'] === 'object'
        ? (parsed['policy'] as Record<string, unknown>)
        : null;
    const policySchedObj =
      policyObj && policyObj['schedule'] && typeof policyObj['schedule'] === 'object'
        ? (policyObj['schedule'] as Record<string, unknown>)
        : null;
    const schedObj =
      parsed['schedule'] && typeof parsed['schedule'] === 'object'
        ? (parsed['schedule'] as Record<string, unknown>)
        : null;

    const intervalMinutes =
      schedObj && typeof schedObj['intervalMinutes'] === 'number' && schedObj['intervalMinutes'] > 0
        ? schedObj['intervalMinutes']
        : null;
    const syncSchedule =
      policySchedObj && typeof policySchedObj['sync'] === 'string'
        ? policySchedObj['sync']
        : null;
    const healthSchedule =
      policySchedObj && typeof policySchedObj['health'] === 'string'
        ? policySchedObj['health']
        : null;
    const expectedIntervalMs =
      intervalMinutes !== null
        ? Math.round(intervalMinutes * 60_000)
        : parseScheduleExpressionToMs(syncSchedule);

    const rawCombos = Array.isArray(parsed['combos']) ? parsed['combos'] : [];
    const combos = rawCombos
      .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
      .map((c) => ({
        name: typeof c['name'] === 'string' ? c['name'] : 'unnamed',
        role: typeof c['role'] === 'string' ? c['role'] : null,
        routers: Array.isArray(c['routers'])
          ? c['routers'].filter((x): x is string => typeof x === 'string')
          : [],
        size: typeof c['size'] === 'number' ? c['size'] : null,
        pinCount: Array.isArray(c['pin']) ? c['pin'].length : 0,
      }));

    const webhookObj =
      parsed['webhook'] && typeof parsed['webhook'] === 'object'
        ? (parsed['webhook'] as Record<string, unknown>)
        : null;

    return {
      present: true,
      version: typeof parsed['version'] === 'number' ? parsed['version'] : null,
      routers,
      policy: {
        mode: policyObj && typeof policyObj['mode'] === 'string' ? policyObj['mode'] : null,
        syncSchedule,
        healthSchedule,
      },
      schedule: {
        intervalMinutes,
        expectedIntervalMs,
      },
      combos,
      webhook: {
        enabled: webhookObj ? webhookObj['enabled'] !== false : false,
        hasUrl: Boolean(
          webhookObj && typeof webhookObj['url'] === 'string' && webhookObj['url'].trim().length > 0
        ),
      },
    };
  } catch {
    return empty;
  }
}

interface ParsedTickProviderObs {
  providerId: string;
  router: string;
  scanned: boolean;
  ok: boolean;
  status: number;
  label: string;
  errorCode: string | null;
  latencyMs: number | null;
  unverifiable: boolean;
  scannedModels: string[] | null;
  routerModels: string[] | null;
}

interface ParsedTickLogEntry {
  timestamp: string;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  mode: string;
  requests: number;
  changed: number;
  unchanged: number;
  backoff: number;
  inboxAdded: number;
  note: string | null;
  shrinkBlocksMap: Record<string, string[]>;
  resources: {
    rssBytes: number | null;
    heapUsedBytes: number | null;
    cpuUserMs: number | null;
    cpuSystemMs: number | null;
  };
  providers: ParsedTickProviderObs[];
  combos: Array<{ router: string; name: string; models: string[] }>;
  blockedRemovals: Array<{
    targetType?: string;
    targetId: string;
    provider: string;
    modelId: string;
    blockedReason: string;
  }>;
  sourceFile: string;
  registryMissing?: boolean | undefined;
}

function parseTickLogLine(rawLine: string): ParsedTickLogEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    const jsonSummary = parseJsonTickLogLineSummary(trimmed);
    return jsonSummary
      ? {
          ...jsonSummary,
          shrinkBlocksMap: {},
          resources: { rssBytes: null, heapUsedBytes: null, cpuUserMs: null, cpuSystemMs: null },
          providers: [],
          combos: [],
          blockedRemovals: [],
          sourceFile: 'tick.log',
          registryMissing: false,
        }
      : null;
  }

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace <= 0) return null;
  const timestamp = trimmed.slice(0, firstSpace);
  if (!Number.isFinite(Date.parse(timestamp))) return null;

  let rest = trimmed.slice(firstSpace + 1);
  let telemetryObj: Record<string, unknown> | null = null;

  const teleMarker = ' field_telemetry=';
  const teleIdx = rest.indexOf(teleMarker);
  if (teleIdx !== -1) {
    const rawJson = rest.slice(teleIdx + teleMarker.length).trim();
    rest = rest.slice(0, teleIdx);
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        telemetryObj = parsed as Record<string, unknown>;
      }
    } catch {
      telemetryObj = null;
    }
  }

  let shrinkBlocksMap: Record<string, string[]> = {};
  const shrinkMarker = 'shrink_blocks=';
  const shrinkIdx = rest.indexOf(shrinkMarker);
  if (shrinkIdx !== -1) {
    const afterShrink = rest.slice(shrinkIdx + shrinkMarker.length);
    let endBrace = 0;
    if (afterShrink.startsWith('{')) {
      let depth = 0;
      for (let i = 0; i < afterShrink.length; i += 1) {
        if (afterShrink[i] === '{') depth += 1;
        else if (afterShrink[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            endBrace = i + 1;
            break;
          }
        }
      }
    }
    const shrinkJson = endBrace > 0 ? afterShrink.slice(0, endBrace) : afterShrink.split(/\s+/)[0] ?? '{}';
    try {
      const parsed = JSON.parse(shrinkJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        shrinkBlocksMap = parsed as Record<string, string[]>;
      }
    } catch {
      shrinkBlocksMap = {};
    }
  }

  const readScalarToken = (key: string): string | null => {
    const re = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`);
    const m = re.exec(rest);
    return m?.[1] ?? null;
  };

  const mode = readScalarToken('mode') ?? 'observe';
  const requests = Number(readScalarToken('requests') ?? '0') || 0;
  const changed = Number(readScalarToken('changed') ?? '0') || 0;
  const unchanged = Number(readScalarToken('unchanged') ?? '0') || 0;
  const backoff = Number(readScalarToken('backoff') ?? '0') || 0;
  const inboxAdded = Number(readScalarToken('inbox_added') ?? '0') || 0;
  const note = extractTickFreeTextNote(rest, telemetryObj);

  const startedAt =
    telemetryObj && typeof telemetryObj['startedAt'] === 'string'
      ? telemetryObj['startedAt']
      : timestamp;
  const durationMs =
    telemetryObj && typeof telemetryObj['durationMs'] === 'number'
      ? telemetryObj['durationMs']
      : null;
  const endedAt =
    telemetryObj && typeof telemetryObj['endedAt'] === 'string'
      ? telemetryObj['endedAt']
      : durationMs !== null
        ? new Date(Date.parse(startedAt) + durationMs).toISOString()
        : startedAt;

  const rawRes =
    telemetryObj && telemetryObj['resources'] && typeof telemetryObj['resources'] === 'object'
      ? (telemetryObj['resources'] as Record<string, unknown>)
      : null;

  const resources = {
    rssBytes: rawRes && typeof rawRes['rssBytes'] === 'number' ? rawRes['rssBytes'] : null,
    heapUsedBytes:
      rawRes && typeof rawRes['heapUsedBytes'] === 'number' ? rawRes['heapUsedBytes'] : null,
    cpuUserMs: rawRes && typeof rawRes['cpuUserMs'] === 'number' ? rawRes['cpuUserMs'] : null,
    cpuSystemMs: rawRes && typeof rawRes['cpuSystemMs'] === 'number' ? rawRes['cpuSystemMs'] : null,
  };

  const providers: ParsedTickProviderObs[] = Array.isArray(telemetryObj?.['providers'])
    ? (telemetryObj!['providers'] as Array<Record<string, unknown>>)
        .filter((p) => Boolean(p && typeof p === 'object' && typeof p['providerId'] === 'string'))
        .map((p) => ({
          providerId: p['providerId'] as string,
          router: typeof p['router'] === 'string' ? p['router'] : 'unknown',
          scanned: Boolean(p['scanned']),
          ok: Boolean(p['ok']),
          status: typeof p['status'] === 'number' ? p['status'] : 0,
          label: typeof p['label'] === 'string' ? p['label'] : 'UNKNOWN',
          errorCode: typeof p['errorCode'] === 'string' ? p['errorCode'] : null,
          latencyMs: typeof p['latencyMs'] === 'number' ? p['latencyMs'] : null,
          unverifiable: Boolean(p['unverifiable']),
          scannedModels: Array.isArray(p['scannedModels'])
            ? (p['scannedModels'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : null,
          routerModels: Array.isArray(p['routerModels'])
            ? (p['routerModels'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : null,
        }))
    : [];

  const combos = Array.isArray(telemetryObj?.['combos'])
    ? (telemetryObj!['combos'] as Array<Record<string, unknown>>)
        .filter((c) => Boolean(c && typeof c === 'object' && typeof c['name'] === 'string'))
        .map((c) => ({
          router: typeof c['router'] === 'string' ? c['router'] : 'unknown',
          name: c['name'] as string,
          models: Array.isArray(c['models'])
            ? (c['models'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
        }))
    : [];

  const blockedRemovals = Array.isArray(telemetryObj?.['blockedRemovals'])
    ? (telemetryObj!['blockedRemovals'] as Array<Record<string, unknown>>)
        .filter(
          (b) =>
            Boolean(
              b &&
                typeof b === 'object' &&
                typeof b['targetId'] === 'string' &&
                typeof b['blockedReason'] === 'string'
            )
        )
        .map((b) => ({
          targetType: typeof b['targetType'] === 'string' ? b['targetType'] : 'router',
          targetId: b['targetId'] as string,
          provider: typeof b['provider'] === 'string' ? b['provider'] : 'unknown',
          modelId: typeof b['modelId'] === 'string' ? b['modelId'] : 'unknown',
          blockedReason: b['blockedReason'] as string,
        }))
    : [];

  return {
    timestamp,
    startedAt,
    endedAt,
    durationMs,
    mode,
    requests,
    changed,
    unchanged,
    backoff,
    inboxAdded,
    note,
    shrinkBlocksMap,
    resources,
    providers,
    combos,
    blockedRemovals,
    sourceFile: 'tick.log',
    registryMissing: telemetryObj?.['registryMissing'] === true,
  };
}

function readJsonReadOnly(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isTimestampWithinBounds(
  iso: string,
  sinceMs: number | null,
  untilMs: number | null
): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  if (sinceMs !== null && ms < sinceMs) return false;
  if (untilMs !== null && ms > untilMs) return false;
  return true;
}

function buildFieldReportReadmeVi(): string {
  return [
    '# Gói Báo Cáo Thực Địa (`field-report`)',
    '',
    'Thư mục này được xuất chỉ-đọc bởi `routersync field-report` (`0` ghi vào `<stateDir>`, `0` gọi mạng).',
    '',
    '## Danh sách 8 tệp dữ liệu',
    '1. `summary.json` — Tổng quan chu kỳ quan sát, số lượt quét/áp dụng/hoàn tác/đóng băng và thống kê khử nhạy cảm.',
    '2. `timeline.jsonl` — Dòng thời gian sự kiện (`tick`, `apply`, `rollback`, `freeze`, `unfreeze`) kèm mã `evt-XXXX`.',
    '3. `providers.json` — Tỷ lệ lỗi, mã lỗi HTTP (`429`, `405`, ...) và phân phối độ trễ theo từng provider.',
    '4. `models.json` — Lịch sử hiện diện / vắng mặt / chưa xác minh của từng model qua các lượt quét.',
    '5. `anomalies.json` — Kết quả phát hiện bất thường dựa hoàn toàn trên số đo thực tế kèm bằng chứng `evt-XXXX`.',
    '6. `resources.json` — Mức tiêu thụ RAM (`rssBytes`, `heapUsedBytes`), CPU và thời lượng mỗi lượt `tick`.',
    '7. `config-shape.json` — Khung cấu trúc cấu hình đã khử nhạy cảm.',
    '8. `README.md` — Hướng dẫn đọc và chuyển giao gói báo cáo này.',
    '',
    '## Bộ lọc bảo vệ 2 tầng độc lập',
    '- **Tầng 1 (Bộ khử nhạy cảm):** Che theo tên trường (kể cả phần tử mảng), giá trị biến môi trường (thô và mã hóa URL), tiền tố nhà cung cấp/tùy chỉnh, chuỗi entropy cao và đường dẫn/danh tính máy cá nhân.',
    '- **Tầng 2 (Bộ quét từ chối độc lập trước khi ghi):** Kiểm tra độc lập toàn bộ bộ đệm theo giá trị bí mật, entropy thông tin và cấu trúc xác thực/PII; nếu phát hiện vi phạm sẽ hủy toàn cục (`0` tệp sinh ra).',
    '- **Lưu ý bắt buộc ở lần xuất đầu tiên:** Chủ dự án phải mở thư mục này và kiểm tra bằng mắt các tệp trước khi chia sẻ gói báo cáo ra bên ngoài.',
    '',
    '## Quy trình phân loại',
    'Gửi thư mục này cho nhóm phụ trách theo đúng sổ tay `docs/runbook/FIELD-FINDINGS.md` để `Data-AI` phân loại từng mục trong `anomalies.json`.',
    '',
  ].join('\n');
}

export async function runFieldReportCommand(
  options: FieldReportCommandOptions
): Promise<FieldReportRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const effectiveEnv = options.env ?? process.env;
  const stateDir = resolveControlStateDir(options.stateDir);
  const outDir = assertFieldReportOutDir(options.out, stateDir);

  const sinceMs = parseOptionalIsoBound(options.since, '--since');
  const untilMs = parseOptionalIsoBound(options.until, '--until');
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw new Error('INVALID_ARGUMENT: --since must be <= --until.');
  }

  const errorRateThreshold = parseThresholdRatio(
    options.errorRateThreshold,
    DEFAULT_ERROR_RATE_THRESHOLD,
    '--error-rate-threshold'
  );
  const explicitExpectedIntervalMs = parsePositiveMs(
    options.expectedIntervalMs,
    null,
    '--expected-interval-ms'
  );
  const slowTickMs =
    parsePositiveMs(options.slowTickMs, DEFAULT_SLOW_TICK_MS, '--slow-tick-ms') ??
    DEFAULT_SLOW_TICK_MS;

  const configPathInput = options.config ?? options.configPath;
  const configShape = readConfigShapeReadOnly(configPathInput, effectiveEnv);
  const secretCtx = collectFieldReportSecretContextReadOnly(configPathInput, effectiveEnv);
  const expectedIntervalMs =
    explicitExpectedIntervalMs ?? configShape.schedule.expectedIntervalMs;

  // Read <stateDir> strictly read-only
  const tickLogPath = path.join(stateDir, 'tick.log');
  const statusJson = readJsonReadOnly(path.join(stateDir, 'status.json'));
  const catalogJson = readJsonReadOnly(path.join(stateDir, 'tick-catalog.json'));
  const tickPlanJson = readJsonReadOnly(path.join(stateDir, 'plans', 'tick-plan.json'));
  const inboxJson = readJsonReadOnly(path.join(stateDir, 'inbox.json'));
  const freezePath = path.join(stateDir, 'freeze.json');
  const rawFreezeJson = readJsonReadOnly(freezePath);
  const freezeState = readFreezeState(stateDir);
  const applyHistory = readApplyHistory(stateDir);
  const consentState = readStandingConsent(stateDir, nowMs);

  // 1. Parse tick events from tick.log (falling back to status.json if tick.log absent)
  const parsedTicks: ParsedTickLogEntry[] = [];
  if (fs.existsSync(tickLogPath)) {
    const rawLog = fs.readFileSync(tickLogPath, 'utf8');
    for (const line of rawLog.split(/\r?\n/)) {
      const entry = parseTickLogLine(line);
      if (entry && isTimestampWithinBounds(entry.startedAt, sinceMs, untilMs)) {
        parsedTicks.push(entry);
      }
    }
  } else if (statusJson && typeof statusJson['timestamp'] === 'string') {
    const ts = statusJson['timestamp'];
    if (isTimestampWithinBounds(ts, sinceMs, untilMs)) {
      const statusProviders = Array.isArray(statusJson['providers'])
        ? (statusJson['providers'] as Array<Record<string, unknown>>).map((p) => {
            const label = typeof p['label'] === 'string' ? p['label'] : 'UNKNOWN';
            const status = typeof p['status'] === 'number' ? p['status'] : 0;
            const scanned = label !== 'SKIPPED' && label !== 'BACKOFF';
            const ok = scanned && (status === 200 || status === 304);
            return {
              providerId: typeof p['prefix'] === 'string' ? p['prefix'] : 'unknown',
              router: 'unknown',
              scanned,
              ok,
              status,
              label,
              errorCode: !ok && status > 0 ? String(status) : null,
              latencyMs: null,
              unverifiable: !ok,
              scannedModels: null,
              routerModels: null,
            };
          })
        : [];
      const dur = typeof statusJson['durationMs'] === 'number' ? statusJson['durationMs'] : null;
      parsedTicks.push({
        timestamp: ts,
        startedAt: typeof statusJson['startedAt'] === 'string' ? statusJson['startedAt'] : ts,
        endedAt: typeof statusJson['endedAt'] === 'string' ? statusJson['endedAt'] : ts,
        durationMs: dur,
        mode: typeof statusJson['effectiveMode'] === 'string' ? statusJson['effectiveMode'] : 'observe',
        requests: typeof statusJson['requests'] === 'number' ? statusJson['requests'] : 0,
        changed: 0,
        unchanged: 0,
        backoff: 0,
        inboxAdded: 0,
        note: null,
        shrinkBlocksMap: {},
        resources: { rssBytes: null, heapUsedBytes: null, cpuUserMs: null, cpuSystemMs: null },
        providers: statusProviders,
        combos: [],
        blockedRemovals: [],
        sourceFile: 'status.json',
        registryMissing: false,
      });
    }
  }

  if (
    parsedTicks.length === 1 &&
    parsedTicks[0]!.providers.length === 0 &&
    statusJson &&
    statusJson['timestamp'] === parsedTicks[0]!.timestamp &&
    Array.isArray(statusJson['providers'])
  ) {
    parsedTicks[0]!.providers = (statusJson['providers'] as Array<Record<string, unknown>>).map(
      (p) => {
        const label = typeof p['label'] === 'string' ? p['label'] : 'UNKNOWN';
        const status = typeof p['status'] === 'number' ? p['status'] : 0;
        const scanned = label !== 'SKIPPED' && label !== 'BACKOFF';
        const ok = scanned && (status === 200 || status === 304);
        return {
          providerId: typeof p['prefix'] === 'string' ? p['prefix'] : 'unknown',
          router: 'unknown',
          scanned,
          ok,
          status,
          label,
          errorCode: !ok && status > 0 ? String(status) : null,
          latencyMs: null,
          unverifiable: !ok,
          scannedModels: null,
          routerModels: null,
        };
      }
    );
  }

  // 2. Assemble chronological raw timeline events
  interface PendingTimelineItem {
    sortMs: number;
    sortOrder: number;
    tickIndex?: number | undefined;
    kind: FieldTimelineRecord['kind'];
    startedAt: string;
    endedAt: string;
    durationMs: number | null;
    mode: string;
    outcome: string;
    sourceFile: string;
    metadata: Record<string, unknown>;
  }

  const pendingTimeline: PendingTimelineItem[] = [];

  parsedTicks.forEach((t, idx) => {
    const hasProviderErrors = t.providers.some((p) => p.scanned && !p.ok);
    const tickMeta: Record<string, unknown> = {
      requests: t.requests,
      changed: t.changed,
      unchanged: t.unchanged,
      backoff: t.backoff,
      inboxAdded: t.inboxAdded,
    };
    if (t.note) {
      tickMeta['note'] = t.note;
    }
    if (t.registryMissing) {
      tickMeta['registryMissing'] = true;
    }
    pendingTimeline.push({
      sortMs: Date.parse(t.startedAt),
      sortOrder: 1,
      tickIndex: idx,
      kind: 'tick',
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.durationMs,
      mode: t.mode,
      outcome: hasProviderErrors ? 'degraded' : 'ok',
      sourceFile: t.sourceFile,
      metadata: tickMeta,
    });
  });

  if (applyHistory.present && applyHistory.valid) {
    for (const r of applyHistory.receipts) {
      if (!isTimestampWithinBounds(r.appliedAt, sinceMs, untilMs)) continue;
      const ms = Date.parse(r.appliedAt);
      pendingTimeline.push({
        sortMs: ms,
        sortOrder: 2,
        kind: 'apply',
        startedAt: r.appliedAt,
        endedAt: r.appliedAt,
        durationMs: 0,
        mode: r.appliedAtLevel,
        outcome: r.success ? 'applied' : 'failed',
        sourceFile: 'apply-history.json',
        metadata: {
          receiptId: r.receiptId,
          target: r.target,
          planHash: r.planHash,
          readBackVerified: r.readBackVerified,
          readBackLevel: r.readBackLevel,
        },
      });
      if (r.rolledBack) {
        pendingTimeline.push({
          sortMs: ms,
          sortOrder: 3,
          kind: 'rollback',
          startedAt: r.appliedAt,
          endedAt: r.appliedAt,
          durationMs: 0,
          mode: r.appliedAtLevel,
          outcome: 'rolled_back',
          sourceFile: 'apply-history.json',
          metadata: {
            receiptId: r.receiptId,
            target: r.target,
            snapshotOrBackupRef: r.snapshotOrBackupRef,
          },
        });
      }
    }
  }

  const rawFreezeHistory = Array.isArray(rawFreezeJson?.['history'])
    ? (rawFreezeJson!['history'] as Array<Record<string, unknown>>)
    : [];
  if (rawFreezeHistory.length > 0) {
    for (const h of rawFreezeHistory) {
      const action = h['action'];
      const ts = h['timestamp'];
      if ((action === 'freeze' || action === 'unfreeze') && typeof ts === 'string') {
        if (!isTimestampWithinBounds(ts, sinceMs, untilMs)) continue;
        pendingTimeline.push({
          sortMs: Date.parse(ts),
          sortOrder: action === 'freeze' ? 4 : 5,
          kind: action,
          startedAt: ts,
          endedAt: ts,
          durationMs: 0,
          mode: action === 'freeze' ? 'FROZEN' : 'unfreeze',
          outcome: action === 'freeze' ? 'frozen' : 'unfrozen',
          sourceFile: 'freeze.json',
          metadata: {
            reason: typeof h['reason'] === 'string' ? h['reason'] : null,
          },
        });
      }
    }
  } else if (rawFreezeJson) {
    const fAt = typeof rawFreezeJson['frozenAt'] === 'string' ? rawFreezeJson['frozenAt'] : null;
    const uAt =
      typeof rawFreezeJson['unfrozenAt'] === 'string' ? rawFreezeJson['unfrozenAt'] : null;
    if (fAt && isTimestampWithinBounds(fAt, sinceMs, untilMs)) {
      pendingTimeline.push({
        sortMs: Date.parse(fAt),
        sortOrder: 4,
        kind: 'freeze',
        startedAt: fAt,
        endedAt: fAt,
        durationMs: 0,
        mode: 'FROZEN',
        outcome: 'frozen',
        sourceFile: 'freeze.json',
        metadata: {
          reason: typeof rawFreezeJson['reason'] === 'string' ? rawFreezeJson['reason'] : null,
        },
      });
    }
    if (uAt && isTimestampWithinBounds(uAt, sinceMs, untilMs)) {
      pendingTimeline.push({
        sortMs: Date.parse(uAt),
        sortOrder: 5,
        kind: 'unfreeze',
        startedAt: uAt,
        endedAt: uAt,
        durationMs: 0,
        mode: 'unfreeze',
        outcome: 'unfrozen',
        sourceFile: 'freeze.json',
        metadata: { reason: null },
      });
    }
  }

  pendingTimeline.sort((a, b) =>
    a.sortMs !== b.sortMs ? a.sortMs - b.sortMs : a.sortOrder - b.sortOrder
  );

  const tickIdByIndex = new Map<number, string>();
  const timeline: FieldTimelineRecord[] = pendingTimeline.map((item, index) => {
    const id = `evt-${String(index + 1).padStart(4, '0')}`;
    if (item.tickIndex !== undefined) {
      tickIdByIndex.set(item.tickIndex, id);
    }
    return {
      id,
      line: index + 1,
      kind: item.kind,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      durationMs: item.durationMs,
      mode: item.mode,
      outcome: item.outcome,
      sourceFile: item.sourceFile,
      metadata: item.metadata,
    };
  });

  // 3. Aggregate providers.json, models.json, resources.json, combos, catalogs & shrinkBlocks
  interface ProviderAccumulator {
    providerId: string;
    scanCount: number;
    okCount: number;
    errorCount: number;
    unverifiableCount: number;
    totalObservations: number;
    errorCodes: Record<string, number>;
    latencies: number[];
    errorEvidenceIds: string[];
    sourceFile: string;
    latestOkScannedModels: string[] | null;
    latestRouterModels: string[] | null;
  }

  const providerMap = new Map<string, ProviderAccumulator>();
  const latestCombosMap = new Map<string, FieldComboSnapshot>();
  const shrinkBlocks: FieldShrinkBlockObservation[] = [];

  for (let idx = 0; idx < parsedTicks.length; idx += 1) {
    const tick = parsedTicks[idx]!;
    const evtId = tickIdByIndex.get(idx) ?? 'evt-0001';

    for (const c of tick.combos) {
      latestCombosMap.set(`${c.router}/${c.name}`, {
        router: c.router,
        name: c.name,
        models: [...c.models],
        sourceFile: tick.sourceFile,
      });
    }

    const shrinkBlockedByTarget = new Map<string, string[]>();
    for (const b of tick.blockedRemovals) {
      if (b.blockedReason === 'SHRINK_CAP_EXCEEDED') {
        const list = shrinkBlockedByTarget.get(b.targetId) ?? [];
        list.push(`${b.provider}/${b.modelId}`);
        shrinkBlockedByTarget.set(b.targetId, list);
      }
    }
    for (const [targetId, modelsList] of shrinkBlockedByTarget.entries()) {
      shrinkBlocks.push({
        targetId,
        blockedModels: modelsList,
        timelineId: evtId,
        sourceFile: tick.sourceFile,
      });
    }
    for (const [prefix, reasons] of Object.entries(tick.shrinkBlocksMap)) {
      if (Array.isArray(reasons) && reasons.length > 0 && shrinkBlockedByTarget.size === 0) {
        shrinkBlocks.push({
          targetId: prefix,
          blockedModels: reasons.map((r) => `${prefix}/${r.split(':')[0]?.trim() ?? 'unknown'}`),
          timelineId: evtId,
          sourceFile: tick.sourceFile,
        });
      }
    }

    for (const p of tick.providers) {
      const acc: ProviderAccumulator = providerMap.get(p.providerId) ?? {
        providerId: p.providerId,
        scanCount: 0,
        okCount: 0,
        errorCount: 0,
        unverifiableCount: 0,
        totalObservations: 0,
        errorCodes: {},
        latencies: [],
        errorEvidenceIds: [],
        sourceFile: tick.sourceFile,
        latestOkScannedModels: null,
        latestRouterModels: null,
      };
      acc.totalObservations += 1;
      if (p.scanned) {
        acc.scanCount += 1;
        if (p.ok) {
          acc.okCount += 1;
          if (p.scannedModels !== null) {
            acc.latestOkScannedModels = p.scannedModels;
          }
        } else {
          acc.errorCount += 1;
          acc.errorEvidenceIds.push(evtId);
        }
      }
      if (p.errorCode) {
        acc.errorCodes[p.errorCode] = (acc.errorCodes[p.errorCode] ?? 0) + 1;
      }
      if (p.latencyMs !== null && Number.isFinite(p.latencyMs)) {
        acc.latencies.push(p.latencyMs);
      }
      if (p.unverifiable) {
        acc.unverifiableCount += 1;
        if (!acc.errorEvidenceIds.includes(evtId)) {
          acc.errorEvidenceIds.push(evtId);
        }
      }
      if (p.routerModels !== null) {
        acc.latestRouterModels = p.routerModels;
      }
      providerMap.set(p.providerId, acc);
    }
  }

  if (
    shrinkBlocks.length === 0 &&
    tickPlanJson &&
    typeof tickPlanJson['planCreatedAt'] === 'string' &&
    isTimestampWithinBounds(tickPlanJson['planCreatedAt'], sinceMs, untilMs) &&
    Array.isArray(tickPlanJson['blockedRemovals'])
  ) {
    const latestTickId =
      parsedTicks.length > 0
        ? (tickIdByIndex.get(parsedTicks.length - 1) ?? 'evt-0001')
        : 'evt-0001';
    const byTarget = new Map<string, string[]>();
    for (const rawB of tickPlanJson['blockedRemovals'] as Array<Record<string, unknown>>) {
      if (rawB?.['blockedReason'] === 'SHRINK_CAP_EXCEEDED' && typeof rawB['targetId'] === 'string') {
        const list = byTarget.get(rawB['targetId']) ?? [];
        list.push(`${String(rawB['provider'] ?? 'unknown')}/${String(rawB['modelId'] ?? 'unknown')}`);
        byTarget.set(rawB['targetId'], list);
      }
    }
    for (const [targetId, blockedModels] of byTarget.entries()) {
      shrinkBlocks.push({
        targetId,
        blockedModels,
        timelineId: latestTickId,
        sourceFile: 'plans/tick-plan.json',
      });
    }
  }

  const rawCatalogProviders =
    catalogJson && catalogJson['providers'] && typeof catalogJson['providers'] === 'object'
      ? (catalogJson['providers'] as Record<string, Record<string, unknown>>)
      : {};
  if (providerMap.size === 0 && sinceMs === null && untilMs === null) {
    for (const [prefix, entry] of Object.entries(rawCatalogProviders)) {
      const updatedAt = typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : '';
      if (!updatedAt) continue;
      const status = typeof entry['lastStatus'] === 'number' ? entry['lastStatus'] : 0;
      const ok = status === 200 || status === 304;
      providerMap.set(prefix, {
        providerId: prefix,
        scanCount: status > 0 ? 1 : 0,
        okCount: ok ? 1 : 0,
        errorCount: status > 0 && !ok ? 1 : 0,
        unverifiableCount: ok ? 0 : 1,
        totalObservations: 1,
        errorCodes: !ok && status > 0 ? { [String(status)]: 1 } : {},
        latencies: [],
        errorEvidenceIds: [],
        sourceFile: 'tick-catalog.json',
        latestOkScannedModels: ok && Array.isArray(entry['ids'])
          ? (entry['ids'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : null,
        latestRouterModels: null,
      });
    }
  }

  const providersList: FieldProviderSummary[] = [...providerMap.values()]
    .sort((a, b) => a.providerId.localeCompare(b.providerId))
    .map((acc) => ({
      providerId: acc.providerId,
      scanCount: acc.scanCount,
      okCount: acc.okCount,
      errorCount: acc.errorCount,
      errorCodes: acc.errorCodes,
      latencyMs: computeDistribution(acc.latencies),
      unverifiableCount: acc.unverifiableCount,
      unverifiableRate:
        acc.totalObservations > 0 ? acc.unverifiableCount / acc.totalObservations : 0,
      errorRate: acc.scanCount > 0 ? acc.errorCount / acc.scanCount : 0,
      errorEvidenceIds: acc.errorEvidenceIds,
      sourceFile: acc.sourceFile,
    }));

  const activeCombos = [...latestCombosMap.values()];
  const combosByStep = new Map<string, Set<string>>();
  for (const c of activeCombos) {
    const comboKey = `${c.router}/${c.name}`;
    for (const step of c.models) {
      const set = combosByStep.get(step) ?? new Set<string>();
      set.add(comboKey);
      combosByStep.set(step, set);
    }
  }

  const knownModelsByProvider = new Map<string, Set<string>>();
  const registerModel = (providerId: string, modelId: string): void => {
    if (!providerId || !modelId) return;
    const set = knownModelsByProvider.get(providerId) ?? new Set<string>();
    set.add(modelId);
    knownModelsByProvider.set(providerId, set);
  };

  for (const t of parsedTicks) {
    for (const p of t.providers) {
      for (const m of p.scannedModels ?? []) registerModel(p.providerId, m);
      for (const m of p.routerModels ?? []) registerModel(p.providerId, m);
    }
  }
  for (const c of activeCombos) {
    for (const step of c.models) {
      const slash = step.indexOf('/');
      if (slash > 0 && slash < step.length - 1) {
        registerModel(step.slice(0, slash), step.slice(slash + 1));
      }
    }
  }
  if (sinceMs === null && untilMs === null) {
    for (const [prefix, entry] of Object.entries(rawCatalogProviders)) {
      if (Array.isArray(entry['ids'])) {
        for (const m of entry['ids']) {
          if (typeof m === 'string') registerModel(prefix, m);
        }
      }
    }
  }

  const modelsList: FieldModelSummary[] = [];
  for (const [providerId, modelSet] of [...knownModelsByProvider.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    for (const modelId of [...modelSet].sort()) {
      const fullStep = `${providerId}/${modelId}`;
      const observations: FieldModelObservation[] = [];

      for (let idx = 0; idx < parsedTicks.length; idx += 1) {
        const tick = parsedTicks[idx]!;
        const evtId = tickIdByIndex.get(idx) ?? 'evt-0001';
        const pObs = tick.providers.find((p) => p.providerId === providerId);
        if (!pObs) continue;

        if (pObs.unverifiable) {
          observations.push({
            timestamp: tick.startedAt,
            status: 'unverifiable',
            timelineId: evtId,
          });
        } else if (pObs.scanned && pObs.ok && pObs.scannedModels !== null) {
          observations.push({
            timestamp: tick.startedAt,
            status: pObs.scannedModels.includes(modelId) ? 'present' : 'absent',
            timelineId: evtId,
          });
        }
      }

      const presentCount = observations.filter((o) => o.status === 'present').length;
      const absentCount = observations.filter((o) => o.status === 'absent').length;
      const unverifiableCount = observations.filter((o) => o.status === 'unverifiable').length;

      const definite = observations.filter(
        (o) => o.status === 'present' || o.status === 'absent'
      );
      let transitions = 0;
      for (let i = 1; i < definite.length; i += 1) {
        if (definite[i - 1]!.status !== definite[i]!.status) {
          transitions += 1;
        }
      }

      modelsList.push({
        modelId,
        providerId,
        fullStep,
        observations,
        presentCount,
        absentCount,
        unverifiableCount,
        transitions,
        inCombos: [...(combosByStep.get(fullStep) ?? new Set<string>())].sort(),
      });
    }
  }

  const providerCatalogIds: Record<string, FieldCatalogSnapshot> = {};
  const routerModelIds: Record<string, FieldCatalogSnapshot> = {};
  for (const [providerId, acc] of providerMap.entries()) {
    if (acc.latestOkScannedModels !== null) {
      providerCatalogIds[providerId] = {
        ids: acc.latestOkScannedModels,
        verified: true,
        sourceFile: acc.sourceFile,
      };
    } else {
      providerCatalogIds[providerId] = {
        ids: [],
        verified: false,
        sourceFile: acc.sourceFile,
      };
    }
    if (acc.latestRouterModels !== null) {
      routerModelIds[providerId] = {
        ids: acc.latestRouterModels,
        sourceFile: acc.sourceFile,
      };
    }
  }

  const tickRecords = timeline.filter((t) => t.kind === 'tick');
  const observedStartMs =
    tickRecords.length > 0 ? Date.parse(tickRecords[0]!.startedAt) : null;
  const observedEndMs =
    tickRecords.length > 0 ? Date.parse(tickRecords[tickRecords.length - 1]!.startedAt) : null;
  const windowBounds = {
    startMs: sinceMs ?? observedStartMs,
    endMs: untilMs ?? observedEndMs,
  };

  const anomalies = detectFieldAnomalies({
    timeline,
    providers: providersList,
    models: modelsList,
    combos: activeCombos,
    providerCatalogIds,
    routerModelIds,
    shrinkBlocks,
    thresholds: {
      errorRateThreshold,
      expectedIntervalMs,
      intervalDriftToleranceRatio: DEFAULT_INTERVAL_DRIFT_TOLERANCE_RATIO,
      slowTickMs,
      shrinkCapRatio: DEFAULT_SHRINK_CAP_RATIO,
    },
    windowBounds,
  });

  // 4. Build resources.json
  const resourceSamples = parsedTicks.map((t, idx) => ({
    timelineId: tickIdByIndex.get(idx) ?? 'evt-0001',
    timestamp: t.startedAt,
    durationMs: t.durationMs,
    rssBytes: t.resources.rssBytes,
    heapUsedBytes: t.resources.heapUsedBytes,
    cpuUserMs: t.resources.cpuUserMs,
    cpuSystemMs: t.resources.cpuSystemMs,
  }));

  const resourcesPayload = {
    schemaVersion: 1 as const,
    generatedAt,
    samples: resourceSamples,
    aggregate: {
      durationMs: computeDistribution(
        resourceSamples.map((s) => s.durationMs).filter((v): v is number => v !== null)
      ),
      rssBytes: computeDistribution(
        resourceSamples.map((s) => s.rssBytes).filter((v): v is number => v !== null)
      ),
      heapUsedBytes: computeDistribution(
        resourceSamples.map((s) => s.heapUsedBytes).filter((v): v is number => v !== null)
      ),
      cpuUserMs: computeDistribution(
        resourceSamples.map((s) => s.cpuUserMs).filter((v): v is number => v !== null)
      ),
      cpuSystemMs: computeDistribution(
        resourceSamples.map((s) => s.cpuSystemMs).filter((v): v is number => v !== null)
      ),
    },
  };

  // 5. Build inbox summary & summary.json (cap raised to 100 per C50-K1)
  const rawInboxItems = Array.isArray(inboxJson?.['items'])
    ? (inboxJson!['items'] as Array<Record<string, unknown>>)
    : [];
  const filteredInboxItems = rawInboxItems.filter((item) => {
    const ts = typeof item['timestamp'] === 'string' ? item['timestamp'] : null;
    return ts ? isTimestampWithinBounds(ts, sinceMs, untilMs) : sinceMs === null && untilMs === null;
  });

  const severityCounts = { critical: 0, high: 0, warn: 0, info: 0 };
  for (const a of anomalies) {
    severityCounts[a.severity] += 1;
  }

  const rawSummary: FieldReportSummaryPayload = {
    schemaVersion: 1,
    generatedAt,
    window: {
      since: options.since ?? null,
      until: options.until ?? null,
      firstEventAt: timeline.length > 0 ? timeline[0]!.startedAt : null,
      lastEventAt: timeline.length > 0 ? timeline[timeline.length - 1]!.endedAt : null,
    },
    counts: {
      ticks: timeline.filter((e) => e.kind === 'tick').length,
      applies: timeline.filter((e) => e.kind === 'apply').length,
      rollbacks: timeline.filter((e) => e.kind === 'rollback').length,
      freezes: timeline.filter((e) => e.kind === 'freeze').length,
      unfreezes: timeline.filter((e) => e.kind === 'unfreeze').length,
      providers: providersList.length,
      models: modelsList.length,
    },
    anomalyCount: anomalies.length,
    anomaliesBySeverity: severityCounts,
    scrubSummary: {
      stage1Applied: !options._unsafeSkipStage1ScrubberForScannerTest,
      stage2VerifiedClean: false,
      redactedCount: 0,
    },
    healthSnapshot: {
      freezeActive: freezeState.frozen,
      freezeReason: freezeState.reason,
      consentValid: consentState.valid,
      activeConsentTargets: consentState.activeTargets.length,
      latestTickMode:
        parsedTicks.length > 0 ? parsedTicks[parsedTicks.length - 1]!.mode : null,
    },
    inboxSummary: {
      totalItems: filteredInboxItems.length,
      recentItems: filteredInboxItems.slice(0, 100).map((item) => ({
        id: typeof item['id'] === 'string' ? item['id'] : 'unknown',
        type: typeof item['type'] === 'string' ? item['type'] : 'info',
        label: typeof item['label'] === 'string' ? item['label'] : null,
        timestamp: typeof item['timestamp'] === 'string' ? item['timestamp'] : null,
        title: typeof item['title'] === 'string' ? item['title'] : '',
        body: typeof item['body'] === 'string' ? item['body'] : '',
      })),
    },
  };

  // 6. Stage-1 Scrubber across all 8 payloads in memory
  const applyStage1 = !options._unsafeSkipStage1ScrubberForScannerTest;
  const stage1Options = {
    extraPrefixes: secretCtx.extraSecretPrefixes,
    extraLiterals: secretCtx.secretLiterals,
  };
  let totalRedactedCount = 0;

  const scrubObj = <T>(val: T): T => {
    if (!applyStage1) return val;
    const res = scrubFieldReportValue(val, stage1Options);
    totalRedactedCount += res.redactedCount;
    return res.value;
  };

  const scrubbedTimeline = scrubObj(timeline);
  const scrubbedProviders = scrubObj({
    schemaVersion: 1 as const,
    generatedAt,
    providers: providersList,
  });
  const scrubbedModels = scrubObj({
    schemaVersion: 1 as const,
    generatedAt,
    models: modelsList,
  });
  const scrubbedAnomalies = scrubObj({
    schemaVersion: 1 as const,
    generatedAt,
    count: anomalies.length,
    anomalies,
  });
  const scrubbedResources = scrubObj(resourcesPayload);
  const scrubbedConfigShape = scrubObj({
    schemaVersion: 1 as const,
    generatedAt,
    ...configShape,
  });
  const rawReadme = buildFieldReportReadmeVi();
  const readmeScrubRes = applyStage1
    ? scrubFieldReportString(rawReadme, stage1Options)
    : { value: rawReadme, redactedCount: 0 };
  totalRedactedCount += readmeScrubRes.redactedCount;

  const scrubbedSummary = scrubObj(rawSummary);
  scrubbedSummary.scrubSummary = {
    stage1Applied: applyStage1,
    stage2VerifiedClean: true,
    redactedCount: totalRedactedCount,
  };

  // Serialize all <= 8 files completely in memory BEFORE any directory or file write
  const timelineText =
    scrubbedTimeline.length > 0
      ? `${scrubbedTimeline.map((row) => JSON.stringify(row)).join('\n')}\n`
      : '';

  const serializedBundle: Record<(typeof FIELD_REPORT_BUNDLE_FILES)[number], string> = {
    'summary.json': `${JSON.stringify(scrubbedSummary, null, 2)}\n`,
    'timeline.jsonl': timelineText,
    'providers.json': `${JSON.stringify(scrubbedProviders, null, 2)}\n`,
    'models.json': `${JSON.stringify(scrubbedModels, null, 2)}\n`,
    'anomalies.json': `${JSON.stringify(scrubbedAnomalies, null, 2)}\n`,
    'resources.json': `${JSON.stringify(scrubbedResources, null, 2)}\n`,
    'config-shape.json': `${JSON.stringify(scrubbedConfigShape, null, 2)}\n`,
    'README.md': readmeScrubRes.value,
  };

  // 7. Stage-2 Independent Pre-Write Output Scanner (All-or-Nothing Gate)
  const scanSummary = scanSerializedFieldReportOutputs(serializedBundle, {
    secretLiterals: secretCtx.secretLiterals,
  });
  if (!scanSummary.clean) {
    process.exitCode = 1;
    const summaryTokens = scanSummary.violations
      .slice(0, 8)
      .map((v) => `${v.file}:${v.line}:${v.ruleCode}`)
      .join(', ');
    const scanErr = new Error(
      `FIELD_REPORT_SECRET_SCAN_BLOCKED: Pre-write security scanner detected ${scanSummary.violations.length} violation(s) [${summaryTokens}]. Zero files were written.`
    ) as Error & { violations: FieldReportScanViolation[] };
    scanErr.violations = scanSummary.violations;
    throw scanErr;
  }

  // 8. Safe to create outDir and write <= 8 files
  fs.mkdirSync(outDir, { recursive: true });
  const writtenFiles: string[] = [];
  for (const fileName of FIELD_REPORT_BUNDLE_FILES) {
    const targetPath = path.join(outDir, fileName);
    fs.writeFileSync(targetPath, serializedBundle[fileName], 'utf8');
    writtenFiles.push(fileName);
  }

  if (!options.silent) {
    const emit = options.writeStdout ?? ((txt: string) => process.stdout.write(txt));
    if (options.json) {
      emit(
        `${JSON.stringify(
          {
            outDir: path.basename(outDir),
            writtenFiles,
            summary: scrubbedSummary,
            anomalyCount: scrubbedAnomalies.anomalies.length,
          },
          null,
          2
        )}\n`
      );
    } else {
      emit(
        `FIELD-REPORT written=${writtenFiles.length} ticks=${scrubbedSummary.counts.ticks} anomalies=${scrubbedAnomalies.anomalies.length} redacted=${scrubbedSummary.scrubSummary.redactedCount}\n`
      );
    }
  }

  return {
    outDir,
    writtenFiles,
    summary: scrubbedSummary,
    anomalies: scrubbedAnomalies.anomalies,
  };
}
