/**
 * packages/cli/src/commands/pilot-report.ts
 *
 * Ticket C46-F6 (`Phục vụ: S9`): Strictly Read-Only Post-Pilot Sign-Off Aggregator
 * (`routersync pilot-report`).
 *
 * Hard Zero-Mutation Guarantee (`100%` Read-Only on `<stateDir>` & `routersync.yaml`):
 *  - NEVER creates, modifies, renames, or updates `mtime` on any file or folder inside `<stateDir>`.
 *  - NEVER mutates `process.env`, router DBs, or harness config files.
 *  - Refuses `--out <file>` whenever it resolves lexically or via symlinks/junctions to `<stateDir>`,
 *    any path inside `<stateDir>`, or OpenMausBot runtime files (`bots.json`, `routines.json`).
 *  - Fails closed (`status: 'FAIL'`, `process.exitCode = 1`) on invalid CLI arguments, missing/corrupt
 *    state files, HMAC tamper (`CONSENT_HMAC_INVALID`), or any violation of the 5 quantitative `S9` criteria.
 *  - Keeps D26 9Router serving-path reflection (`--serving-reflection-ms`) strictly separate
 *    from `detectionLatencyMs`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  canonicalJsonStringify,
  computeWeeklyResearchBudget,
  deriveRemovalSettlementMs,
  COMPLETED_DETECTION_RETENTION_MS,
  MAX_DETECTION_RECORDS,
  parseRemovalEvidenceTimestamp,
  isPathInsideDir,
  parseTargetScope,
  readApplyHistory,
  readConsentSigningKeyIfPresent,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  resolveDeepCanonicalPath,
  resolveMaxWeeklyResearchSessions,
  verifyHmacSha256Hex,
  type ApplyHistoryReceipt,
} from '@routersync/core';
import { expandTilde } from '../config/loader.js';
import { RouterSyncConfigSchema, type RouterSyncConfig } from '../config/schema.js';

export const HARD_PASS_MAX_DETECTION_LATENCY_MS = 60_000;
export const REMOVAL_SETTLE_ABSENCE_MIN_MS = 24 * 60 * 60 * 1000;
export const REMOVAL_SETTLE_ABSENCE_MIN_SCANS = 3;

const FORBIDDEN_RUNTIME_FILENAMES = new Set(['bots.json', 'routines.json']);
const FOLD_PATH_CASE = process.platform === 'win32' || process.platform === 'darwin';

export interface PilotReportCommandOptions {
  stateDir?: string | undefined;
  config?: string | undefined;
  configPath?: string | undefined;
  routerTarget?: string | undefined;
  harnessTarget?: string | undefined;
  servingReflectionMs?: number | string | undefined;
  falseRemovals?: number | string | undefined;
  unplannedInterventions?: number | string | undefined;
  acceptVacuousDetection?: boolean | undefined;
  pilotStartedAt?: string | undefined;
  out?: string | undefined;
  json?: boolean | undefined;
  /** Programmatic seams for hermetic unit/rehearsal tests */
  nowMs?: number | undefined;
  silent?: boolean | undefined;
  writeStdout?: ((text: string) => void) | undefined;
}

export interface PilotReportS9Criteria {
  falseRemovals: {
    passed: boolean;
    count: number | null;
    manualReportedCount: number | null;
    source: 'derived' | 'owner-attested' | 'missing';
    removedModelCount: number;
    autoRollbackIncidentCount: number;
    failedAutoSafeReceiptCount: number;
    detail: string;
  };
  rollbackByteExactMatch: {
    passed: boolean;
    matched: boolean;
    verifiedReceiptsCount: number;
    rolledBackReceiptsCount: number;
    failedReceiptsCount: number;
    detail: string;
  };
  detectionLatencyMs: {
    passed: boolean;
    maxMs: number | null;
    measuredCount: number;
    acceptedVacuous: boolean;
    publicationToPlanMs: number | null;
    thresholdMs: number;
    source:
      | 'tick-catalog.json'
      | 'tick-plan.json'
      | 'status.json'
      | 'tick-plan.json+status.json'
      | 'tick-catalog.json+tick-plan.json+status.json'
      | 'missing';
    detail: string;
  };
  cost: {
    passed: boolean;
    tier0Tokens: number;
    tier0LlmCalls: number;
    tier0PaidRequests: number;
    weeklySessionsUsed: number;
    maxWeeklyResearchSessions: number;
    budgetExceeded: boolean;
    detail: string;
  };
  unplannedManualInterventions: {
    passed: boolean;
    count: number | null;
    manualReportedCount: number | null;
    source: 'derived' | 'owner-attested' | 'missing';
    stateCorruptionCount: number;
    emergencyFreezeActive: boolean;
    detail: string;
  };
}

export interface PilotReportObservedScanInterval {
  sampleCount: number;
  minMs: number | null;
  maxMs: number | null;
  lastMs: number | null;
}

export interface PilotReportRemovalSettle {
  status: 'PASS' | 'INCOMPLETE' | 'FAIL';
  passed: boolean;
  removedModelCount: number;
  falseRemovalCount: number;
  policySatisfiedAtRemoval: boolean | null;
  minMs: number | null;
  maxMs: number | null;
  removalSettleMs: number | null;
  removalPaths: Array<'absence-only' | 'official-notice'>;
  noticeOrigin: 'genuine' | 'synthetic' | 'none';
  observedScanIntervalMs: PilotReportObservedScanInterval;
  providerToFirstScanMs: null;
  unobservableWindow: 'provider-to-first-scan';
  detail: string;
}

export interface PilotReportResult {
  schemaVersion: 1;
  generatedAt: string;
  status: 'PASS' | 'INCOMPLETE' | 'FAIL';
  passed: boolean;
  stateDir: string;
  pilotTargets: {
    routerTarget: string | null;
    harnessTarget: string | null;
  };
  /**
   * Optional owner-observed HTTP `/v1/models` serving reflection latency (D26: 20-31s on 9Router).
   * Reported strictly separately and NEVER added into `criteria.detectionLatencyMs.maxMs`.
   */
  servingReflectionMs: number | null;
  removalSettle: PilotReportRemovalSettle;
  tickCount: number;
  warnings: string[];
  criteria: PilotReportS9Criteria;
  blockingReasons: string[];
}

function failPilotReportOption(message: string): never {
  process.exitCode = 1;
  throw new Error(message);
}

function parseOptionalNonNegativeSafeInt(rawValue: unknown, flagLabel: string): number | null {
  if (rawValue === undefined) return null;
  if (typeof rawValue === 'number') {
    if (!Number.isSafeInteger(rawValue) || rawValue < 0 || Object.is(rawValue, -0)) {
      failPilotReportOption(
        `INVALID_ARGUMENT: ${flagLabel} must be a non-negative integer (got ${String(rawValue)}).`
      );
    }
    return rawValue;
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
      failPilotReportOption(
        `INVALID_ARGUMENT: ${flagLabel} must be a non-negative integer (got ${JSON.stringify(rawValue)}).`
      );
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      failPilotReportOption(
        `INVALID_ARGUMENT: ${flagLabel} exceeds safe integer bounds (got ${JSON.stringify(rawValue)}).`
      );
    }
    return parsed;
  }
  failPilotReportOption(`INVALID_ARGUMENT: ${flagLabel} must be a non-negative integer.`);
}

function isSameOrInsideDir(candidatePath: string, dirPath: string): boolean {
  const same = FOLD_PATH_CASE
    ? candidatePath.toLowerCase() === dirPath.toLowerCase()
    : candidatePath === dirPath;
  return same || isPathInsideDir(candidatePath, dirPath);
}

export function assertOutPathOutsideStateDir(
  rawOutPath: string,
  stateDir: string,
  resolveCanonicalFn: (p: string) => string = resolveDeepCanonicalPath
): string {
  const trimmedOut = rawOutPath.trim();
  if (trimmedOut.length === 0) {
    failPilotReportOption('INVALID_ARGUMENT: --out must be a non-empty file path.');
  }

  const expandedOut = path.resolve(expandTilde(trimmedOut));
  const absStateDir = path.resolve(stateDir);
  if (isSameOrInsideDir(expandedOut, absStateDir)) {
    failPilotReportOption(
      `PILOT_REPORT_OUT_INSIDE_STATE_DIR: --out (${expandedOut}) must not point to or inside read-only <stateDir> (${absStateDir}).`
    );
  }

  let canonicalOut: string;
  let canonicalState: string;
  try {
    canonicalOut = resolveCanonicalFn(expandedOut);
    canonicalState = resolveCanonicalFn(absStateDir);
  } catch (err) {
    failPilotReportOption(err instanceof Error ? err.message : String(err));
  }

  if (isSameOrInsideDir(canonicalOut, canonicalState)) {
    failPilotReportOption(
      `PILOT_REPORT_OUT_INSIDE_STATE_DIR: --out (${canonicalOut}) resolves inside read-only <stateDir> (${canonicalState}).`
    );
  }

  const lexicalBase = path.basename(expandedOut).toLowerCase();
  const realBase = path.basename(canonicalOut).toLowerCase();
  if (FORBIDDEN_RUNTIME_FILENAMES.has(lexicalBase) || FORBIDDEN_RUNTIME_FILENAMES.has(realBase)) {
    failPilotReportOption(
      `FORBIDDEN_RUNTIME_FILE: Refusing to write report over OpenMausBot runtime file (${realBase}).`
    );
  }

  if (fs.existsSync(canonicalOut) && fs.statSync(canonicalOut).isDirectory()) {
    failPilotReportOption(
      `INVALID_ARGUMENT: --out (${expandedOut}) points to an existing directory instead of a file.`
    );
  }

  return expandedOut;
}

function validateLegacyAliasConsentIfPresent(stateDir: string): {
  valid: boolean;
  reason?: string;
} {
  const legacyConsentPath = path.join(stateDir, 'consent.json');
  if (!fs.existsSync(legacyConsentPath)) {
    return { valid: true };
  }
  const signingKey = readConsentSigningKeyIfPresent(stateDir);
  if (!signingKey) {
    return {
      valid: false,
      reason: 'CONSENT_HMAC_INVALID: <stateDir>/consent.json is present without consent-signing.key.',
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyConsentPath, 'utf8')) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed['version'] !== 1 ||
      typeof parsed['policyId'] !== 'string' ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Array.isArray(parsed['targets']) ||
      typeof parsed['hmacSha256'] !== 'string'
    ) {
      return {
        valid: false,
        reason: 'CONSENT_SCHEMA_INVALID: <stateDir>/consent.json failed schema integrity verification.',
      };
    }
    const canonical = canonicalJsonStringify({
      version: 1,
      policyId: parsed['policyId'],
      updatedAt: parsed['updatedAt'],
      targets: parsed['targets'],
    });
    if (!verifyHmacSha256Hex(signingKey, canonical, parsed['hmacSha256'])) {
      return {
        valid: false,
        reason: 'CONSENT_HMAC_INVALID: <stateDir>/consent.json failed HMAC-SHA256 verification.',
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      reason: 'CONSENT_SCHEMA_INVALID: <stateDir>/consent.json contains malformed JSON.',
    };
  }
}

function readOptionalNonNegativeAccountingNumber(
  rec: Record<string, unknown>,
  fieldName: string,
  fileLabel: string
): number {
  const val = rec[fieldName];
  if (val === undefined) return 0;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    throw new Error(`${fileLabel}.${fieldName} must be a finite number >= 0.`);
  }
  return val;
}

function isValidIsoTimestamp(val: unknown): boolean {
  return parseRemovalEvidenceTimestamp(val) !== null;
}

function assertCompletedSteadyStateTickRecord(
  rec: Record<string, unknown>,
  fileLabel: string
): void {
  if (fileLabel === 'status.json') {
    if (!isValidIsoTimestamp(rec['timestamp']) || !Array.isArray(rec['providers'])) {
      throw new Error(
        'status.json with detectionLatency.measuredCount=0 requires a valid ISO timestamp and providers array.'
      );
    }
    return;
  }
  if (fileLabel === 'plans/tick-plan.json') {
    const routerActions = rec['routerActions'];
    const harnessActions = rec['harnessActions'];
    const hasNoNewDetection = (act: unknown): boolean => {
      if (!act || typeof act !== 'object' || Array.isArray(act)) return false;
      const a = act as Record<string, unknown>;
      if (a['action'] !== 'REMOVE_MODEL') return false;
      if (a['detectionKind'] === 'official-notice') return true;
      return a['detectionKind'] === 'absence-settled' &&
        typeof a['episodeId'] === 'string' &&
        a['episodeId'].trim().length > 0 &&
        a['detectionLatencyMs'] === null;
    };
    if (
      !isValidIsoTimestamp(rec['planCreatedAt']) ||
      !Array.isArray(routerActions) ||
      !Array.isArray(harnessActions) ||
      !routerActions.every(hasNoNewDetection) ||
      !harnessActions.every(hasNoNewDetection)
    ) {
      throw new Error(
        'plans/tick-plan.json with detectionLatency.measuredCount=0 requires a valid ISO planCreatedAt and empty (or previously measured or pending REMOVE_MODEL) routerActions/harnessActions.'
      );
    }
    return;
  }
  throw new Error(`${fileLabel} cannot satisfy measuredCount=0 steady-state tick contract.`);
}

function extractFiniteLatencyFromRecord(
  rec: Record<string, unknown>,
  fileLabel: string
): number | null {
  const candidates: number[] = [];

  const det = rec['detectionLatency'];
  if (det !== undefined) {
    if (!det || typeof det !== 'object' || Array.isArray(det)) {
      throw new Error(`${fileLabel}.detectionLatency must be an object.`);
    }
    const detObj = det as Record<string, unknown>;
    const measuredCount = detObj['measuredCount'];
    const minMs = detObj['minMs'];
    const maxMs = detObj['maxMs'];
    const p50Ms = detObj['p50Ms'];

    if (measuredCount !== undefined) {
      if (
        typeof measuredCount !== 'number' ||
        !Number.isSafeInteger(measuredCount) ||
        measuredCount < 0
      ) {
        throw new Error(
          `${fileLabel}.detectionLatency.measuredCount must be a non-negative integer.`
        );
      }
    }

    if (measuredCount === 0) {
      if (
        minMs !== null ||
        maxMs !== null ||
        (p50Ms !== undefined && p50Ms !== null)
      ) {
        throw new Error(
          `${fileLabel}.detectionLatency with measuredCount=0 must have null minMs/maxMs/p50Ms.`
        );
      }
      assertCompletedSteadyStateTickRecord(rec, fileLabel);
      return null;
    } else if (maxMs !== undefined && maxMs !== null) {
      if (typeof maxMs !== 'number' || !Number.isFinite(maxMs)) {
        throw new Error(`${fileLabel}.detectionLatency.maxMs must be a finite number.`);
      }
      candidates.push(maxMs);
    } else if (measuredCount !== undefined && measuredCount > 0) {
      throw new Error(
        `${fileLabel}.detectionLatency.maxMs must be a finite number when measuredCount > 0.`
      );
    } else {
      throw new Error(
        `${fileLabel}.detectionLatency must specify non-negative integer measuredCount or finite maxMs.`
      );
    }
  }

  const direct = rec['detectionLatencyMs'];
  if (direct !== undefined && direct !== null) {
    if (typeof direct !== 'number' || !Number.isFinite(direct)) {
      throw new Error(`${fileLabel}.detectionLatencyMs must be a finite number.`);
    }
    candidates.push(direct);
  }

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.some((v) => v < 0)) {
    return Math.min(...candidates);
  }
  return Math.max(...candidates);
}

function formatMarkdownSignOffReport(report: PilotReportResult): string {
  const c = report.criteria;
  const badge = (ok: boolean, incomplete = false) => ok ? 'PASS' : incomplete ? 'INCOMPLETE' : 'FAIL';
  const latencyText =
    c.detectionLatencyMs.maxMs === null
      ? 'VACUOUS'
      : `${c.detectionLatencyMs.maxMs} ms (<= ${c.detectionLatencyMs.thresholdMs} ms)`;
  const costText = `tier0Tokens=${c.cost.tier0Tokens}, tier0LlmCalls=${c.cost.tier0LlmCalls}, tier0PaidRequests=${c.cost.tier0PaidRequests}, weeklySessions=${c.cost.weeklySessionsUsed}/${c.cost.maxWeeklyResearchSessions}`;

  const lines: string[] = [
    `# Báo cáo Nghiệm thu Thí điểm RouterSync S9 — ${report.status}`,
    '',
    `- **Kết luận tổng thể:** \`${report.status}\``,
    `- **Thời điểm tổng hợp:** \`${report.generatedAt}\``,
    `- **Thư mục trạng thái (chỉ đọc):** \`${report.stateDir}\``,
    `- **Mục tiêu Router:** \`${report.pilotTargets.routerTarget ?? '(tất cả trong apply-history)'}\``,
    `- **Mục tiêu Harness:** \`${report.pilotTargets.harnessTarget ?? '(tất cả trong apply-history)'}\``,
    `- **Tick:** ${report.tickCount} | **Model đã loại:** ${c.falseRemovals.removedModelCount} | **Mẫu đo:** ${c.detectionLatencyMs.measuredCount} | **Hoàn tác xác minh:** ${c.rollbackByteExactMatch.verifiedReceiptsCount}`,
    ...report.warnings.map((warning) => `- **Cảnh báo:** ${warning}`),
  ];

  const rs = report.removalSettle;
  const settleText =
    rs.removalSettleMs === null
      ? 'chưa có model gỡ thực tế (null)'
      : `${rs.removalSettleMs} ms (không áp trần thời gian; trạng thái=${rs.status}${rs.noticeOrigin !== 'none' ? `; noticeOrigin=${rs.noticeOrigin}` : ''})`;
  const obsIntervalText =
    rs.observedScanIntervalMs.lastMs === null
      ? 'null (chưa đủ >= 2 lần quét hợp lệ)'
      : `last=${rs.observedScanIntervalMs.lastMs} ms, min=${rs.observedScanIntervalMs.minMs} ms, max=${rs.observedScanIntervalMs.maxMs} ms (n=${rs.observedScanIntervalMs.sampleCount})`;
  lines.push(
    `- **Từ công bố đến plan (\`publicationToPlanMs\`):** \`${c.detectionLatencyMs.publicationToPlanMs ?? 'null'}\``,
    `- **Thời gian hội tụ gỡ bỏ (\`removalSettleMs\`, tách biệt khỏi \`detectionLatencyMs\`):** \`${settleText}\``,
    `- **Chu kỳ quét quan sát (\`observedScanIntervalMs\`):** \`${obsIntervalText}\` | **\`providerToFirstScanMs\`:** \`null\` (\`unobservableWindow=${rs.unobservableWindow}\`)`
  );
  if (report.servingReflectionMs !== null) {
    lines.push(
      `- **Độ trễ phản ánh đường phục vụ HTTP \`/v1/models\` (D26, ghi riêng ngoài \`detectionLatencyMs\`):** \`${report.servingReflectionMs} ms\``
    );
  }

  lines.push(
    '',
    '| # | Tiêu chí S9 | Giá trị Đo được | Ngưỡng Đạt Cứng | Kết quả |',
    '|---:|---|---|---|---|',
    `| 1 | \`falseRemovals\` | \`${c.falseRemovals.count ?? '?'}\` (${c.falseRemovals.source}) | \`=== 0\` | **${badge(c.falseRemovals.passed, c.falseRemovals.source === 'missing')}** |`,
    `| 2 | \`rollbackByteExactMatch\` | \`${c.rollbackByteExactMatch.matched}\` (\`${c.rollbackByteExactMatch.verifiedReceiptsCount}\` biên nhận xác minh) | Đối chiếu SHA-256 của harness và hàng combo của router | **${badge(c.rollbackByteExactMatch.passed, c.rollbackByteExactMatch.failedReceiptsCount === 0)}** |`,
    `| 3 | \`detectionLatencyMs\` | \`${latencyText}\` | \`<= 60000 ms\` | **${badge(c.detectionLatencyMs.passed, c.detectionLatencyMs.maxMs === null)}** |`,
    `| 4 | \`tier0Tokens\` & Ngân sách tuần | \`${costText}\` | \`0\` token/LLM/paid & \`<= ${c.cost.maxWeeklyResearchSessions}\` phiên/tuần | **${badge(c.cost.passed)}** |`,
    `| 5 | \`unplannedManualInterventions\` | \`${c.unplannedManualInterventions.count ?? '?'}\` (${c.unplannedManualInterventions.source}) | \`=== 0\` | **${badge(c.unplannedManualInterventions.passed, c.unplannedManualInterventions.source === 'missing')}** |`
  );

  if (report.blockingReasons.length > 0) {
    lines.push('', '## Lý do Chặn Nghiệm thu (`Blocking Reasons`)', '');
    for (const reason of report.blockingReasons) {
      lines.push(`- ${reason}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export async function runPilotReportCommand(
  options: PilotReportCommandOptions = {}
): Promise<PilotReportResult> {
  const nowMs = options.nowMs ?? Date.now();
  const pilotStart = parseRemovalEvidenceTimestamp(options.pilotStartedAt);
  if (options.pilotStartedAt !== undefined &&
      (pilotStart === null || !options.pilotStartedAt.includes('T') || pilotStart > nowMs)) {
    failPilotReportOption('INVALID_ARGUMENT: --pilot-started-at must be an ISO-8601 timestamp at or before report generation.');
  }
  const oldestRetainedMs = nowMs - COMPLETED_DETECTION_RETENTION_MS;
  const effectiveWindowStartMs = Math.max(pilotStart ?? oldestRetainedMs, oldestRetainedMs);
  const isInEvidenceWindow = (timestamp: number): boolean =>
    timestamp >= effectiveWindowStartMs && timestamp <= nowMs;
  const generatedAt = new Date(nowMs).toISOString();
  const hasEmptyStateDirFlag =
    options.stateDir !== undefined && options.stateDir.trim().length === 0;
  const stateDir = hasEmptyStateDirFlag
    ? path.resolve('')
    : resolveControlStateDir(options.stateDir);

  const servingReflectionMs = parseOptionalNonNegativeSafeInt(
    options.servingReflectionMs,
    '--serving-reflection-ms'
  );
  const manualFalseRemovals =
    parseOptionalNonNegativeSafeInt(options.falseRemovals, '--false-removals');
  const manualInterventions =
    parseOptionalNonNegativeSafeInt(options.unplannedInterventions, '--unplanned-interventions');

  const resolvedOutPath =
    options.out !== undefined ? assertOutPathOutsideStateDir(options.out, stateDir) : null;

  const blockingReasons: string[] = [];
  const incompleteReasons: string[] = [];
  let stateCorruptionCount = 0;

  if (hasEmptyStateDirFlag) {
    blockingReasons.push('INVALID_ARGUMENT: --state-dir must be a non-empty directory path.');
  }

  // -------------------------------------------------------------------------
  // Optional read-only routersync.yaml load (for maxWeeklyResearchSessions & router aliases)
  // -------------------------------------------------------------------------
  let validConfig: RouterSyncConfig | null = null;
  const explicitConfigArg =
    options.configPath !== undefined ? options.configPath : options.config;
  if (explicitConfigArg !== undefined) {
    const trimmedCfg = explicitConfigArg.trim();
    if (trimmedCfg.length === 0) {
      stateCorruptionCount += 1;
      blockingReasons.push('INVALID_ARGUMENT: --config (-c) must be a non-empty file path.');
    } else {
      const cfgPath = path.resolve(expandTilde(trimmedCfg));
      if (!fs.existsSync(cfgPath) || !fs.statSync(cfgPath).isFile()) {
        stateCorruptionCount += 1;
        blockingReasons.push(`CONFIG_NOT_FOUND: Explicit config file does not exist: ${cfgPath}`);
      } else {
        try {
          const parsedYaml = parseYaml(fs.readFileSync(cfgPath, 'utf8'));
          const schemaRes = RouterSyncConfigSchema.safeParse(parsedYaml);
          if (!schemaRes.success) {
            stateCorruptionCount += 1;
            blockingReasons.push(
              `CONFIG_SCHEMA_INVALID: ${schemaRes.error.issues.map((i) => i.message).join('; ')}`
            );
          } else {
            validConfig = schemaRes.data;
          }
        } catch (err) {
          stateCorruptionCount += 1;
          blockingReasons.push(
            `CONFIG_PARSE_ERROR: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Parse optional --router-target & --harness-target filters
  // -------------------------------------------------------------------------
  const routerTargetProvided = options.routerTarget !== undefined;
  let normalizedRouterTarget: string | null = null;
  const routerAliases = new Set<string>();
  if (routerTargetProvided) {
    const trimmedRouterTarget = options.routerTarget!.trim();
    if (trimmedRouterTarget.length === 0) {
      blockingReasons.push(
        "INVALID_ARGUMENT: --router-target must be a non-empty 'router:<routerId>/<comboName>' scope."
      );
    } else {
      try {
        const parsed = parseTargetScope(trimmedRouterTarget);
        if (parsed.targetKind !== 'router' || !parsed.routerId || !parsed.comboName) {
          blockingReasons.push(
            `TARGET_SCOPE_INVALID: Expected --router-target in 'router:<routerId>/<comboName>' format (got '${options.routerTarget}').`
          );
        } else {
          normalizedRouterTarget = parsed.target;
          routerAliases.add(parsed.target);
          if (validConfig) {
            const matchedRouter = validConfig.routers.find(
              (r) => r.id === parsed.routerId || r.adapter === parsed.routerId
            );
            if (matchedRouter) {
              routerAliases.add(`router:${matchedRouter.id}/${parsed.comboName}`);
              routerAliases.add(`router:${matchedRouter.adapter}/${parsed.comboName}`);
            }
          }
        }
      } catch (err) {
        blockingReasons.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const harnessTargetProvided = options.harnessTarget !== undefined;
  let normalizedHarnessTarget: string | null = null;
  if (harnessTargetProvided) {
    const trimmedHarnessTarget = options.harnessTarget!.trim();
    if (trimmedHarnessTarget.length === 0) {
      blockingReasons.push(
        "INVALID_ARGUMENT: --harness-target must be a non-empty 'harness:<id>' scope."
      );
    } else {
      try {
        const parsed = parseTargetScope(trimmedHarnessTarget);
        if (parsed.targetKind !== 'harness' || !parsed.harnessId) {
          blockingReasons.push(
            `TARGET_SCOPE_INVALID: Expected --harness-target in 'harness:<id>' format (got '${options.harnessTarget}').`
          );
        } else {
          normalizedHarnessTarget = parsed.target;
        }
      } catch (err) {
        blockingReasons.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Verify <stateDir> exists (NEVER create <stateDir>!)
  // -------------------------------------------------------------------------
  const stateDirExists =
    !hasEmptyStateDirFlag && fs.existsSync(stateDir) && fs.statSync(stateDir).isDirectory();
  if (!hasEmptyStateDirFlag && !stateDirExists) {
    blockingReasons.push(`STATE_DIR_MISSING: Control-plane <stateDir> does not exist: ${stateDir}`);
  }

  // -------------------------------------------------------------------------
  // Read & verify HMAC / JSON integrity across <stateDir> artifacts
  // -------------------------------------------------------------------------
  const standingConsent = stateDirExists
    ? readStandingConsent(stateDir, nowMs)
    : { present: false, valid: false, errorCode: 'STATE_DIR_MISSING' as const, targets: [], activeTargets: [] };
  if (stateDirExists && !standingConsent.valid) {
    stateCorruptionCount += 1;
    blockingReasons.push(
      `${standingConsent.errorCode ?? 'CONSENT_HMAC_INVALID'}: <stateDir>/standing-consent.json failed integrity verification.`
    );
  } else if (stateDirExists && !standingConsent.present) {
    blockingReasons.push(
      'STANDING_CONSENT_MISSING: <stateDir>/standing-consent.json does not exist; pilot standing consent cannot be verified.'
    );
  }

  const legacyConsent = stateDirExists
    ? validateLegacyAliasConsentIfPresent(stateDir)
    : { valid: true };
  if (stateDirExists && !legacyConsent.valid) {
    stateCorruptionCount += 1;
    blockingReasons.push(
      legacyConsent.reason ?? 'CONSENT_HMAC_INVALID: <stateDir>/consent.json failed verification.'
    );
  }

  const applyHistory = stateDirExists
    ? readApplyHistory(stateDir)
    : { present: false, valid: false, errorCode: 'STATE_DIR_MISSING' as const, receipts: [] as ApplyHistoryReceipt[] };
  if (stateDirExists && !applyHistory.valid) {
    stateCorruptionCount += 1;
    blockingReasons.push(
      `${applyHistory.errorCode ?? 'CONSENT_HMAC_INVALID'}: <stateDir>/apply-history.json failed integrity verification.`
    );
  } else if (stateDirExists && !applyHistory.present) {
    incompleteReasons.push(
      'APPLY_HISTORY_MISSING: <stateDir>/apply-history.json does not exist; pilot apply/rollback receipts cannot be verified.'
    );
  }

  const freezeState: { frozen: boolean; reason?: string | null | undefined } = stateDirExists
    ? readFreezeState(stateDir)
    : { frozen: false };
  const isFreezeCorrupt =
    stateDirExists && freezeState.reason === 'corrupt-freeze-file-fail-closed';
  if (isFreezeCorrupt) {
    stateCorruptionCount += 1;
    blockingReasons.push('FREEZE_STATE_CORRUPT: <stateDir>/freeze.json is unreadable or corrupt.');
  } else if (stateDirExists && freezeState.frozen) {
    blockingReasons.push(
      `EMERGENCY_FREEZE_ACTIVE: <stateDir>/freeze.json is still active (reason=${freezeState.reason ?? 'unspecified'}).`
    );
  }

  // -------------------------------------------------------------------------
  // Parse inbox.json for [AUTO-ROLLBACK] / INVARIANT-BLOCKED incidents
  // -------------------------------------------------------------------------
  let autoRollbackIncidentCount = 0;
  if (stateDirExists) {
    const inboxPath = path.join(stateDir, 'inbox.json');
    if (fs.existsSync(inboxPath)) {
      try {
        const rawInbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as unknown;
        const items: unknown[] = Array.isArray(rawInbox)
          ? rawInbox
          : rawInbox &&
              typeof rawInbox === 'object' &&
              Array.isArray((rawInbox as Record<string, unknown>)['items'])
            ? ((rawInbox as Record<string, unknown>)['items'] as unknown[])
            : (() => {
                throw new Error('inbox.json root must be an object with items[] or an array.');
              })();

        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('inbox.json items[] must contain plain JSON objects.');
          }
          const rec = item as Record<string, unknown>;
          const label = typeof rec['label'] === 'string' ? rec['label'] : '';
          const title = typeof rec['title'] === 'string' ? rec['title'] : '';
          if (
            label === 'AUTO-ROLLBACK' ||
            label === 'INVARIANT-BLOCKED' ||
            title.startsWith('[AUTO-ROLLBACK]')
          ) {
            autoRollbackIncidentCount += 1;
          }
        }
      } catch (err) {
        stateCorruptionCount += 1;
        blockingReasons.push(
          `INBOX_CORRUPT: <stateDir>/inbox.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Parse status.json, plans/tick-plan.json & tick-catalog.json for detectionLatencyMs + accounting
  // -------------------------------------------------------------------------
  const matchesTargetScopes = (scopes: unknown): boolean => {
    if (!routerTargetProvided && !harnessTargetProvided) return true;
    if (!Array.isArray(scopes)) return false;
    return scopes.some(
      (rawScope) =>
        typeof rawScope === 'string' &&
        ((normalizedRouterTarget !== null && routerAliases.has(rawScope)) ||
          (normalizedHarnessTarget !== null && rawScope === normalizedHarnessTarget))
    );
  };

  let statusLatencyMs: number | null = null;
  let tickPlanLatencyMs: number | null = null;
  let fileMeasuredCount = 0;
  let hasLegacyAmbiguousAbsencePlan = false;
  const catalogDetectionSamples: number[] = [];
  const removalDetections: Array<Record<string, unknown>> = [];
  const catalogDetectionKeys = new Set<string>();
  let hasSyntheticNoticeDetection = false;
  let hasIncompleteOfficialDetection = false;
  let maxOverdueOfficialMs: number | null = null;
  let hasOfficialPlanAction = false;
  let hasMeasuredOfficialDetection = false;
  let publicationToPlanMs: number | null = null;
  let detectionHistoryCapExceeded = false;
  const isSummaryInWindow = (value: unknown, label: string): boolean => {
    if (value === undefined) return false;
    const timestamp = parseRemovalEvidenceTimestamp(value);
    if (timestamp === null || timestamp > nowMs) {
      throw new Error(`${label} must be a valid timestamp at or before report generation.`);
    }
    return isInEvidenceWindow(timestamp);
  };
  const finishedAt = (record: Record<string, unknown>): number | null =>
    parseRemovalEvidenceTimestamp(record['removedAt'] ?? record['recoveredAt'] ??
      record['withdrawnAt'] ?? record['supersededAt'] ?? record['abandonedAt']);
  const isEpisodeInWindow = (record: Record<string, unknown>): boolean => {
    const terminalAt = finishedAt(record);
    return terminalAt === null || isInEvidenceWindow(terminalAt);
  };
  const verifyCompletionChronology = (record: Record<string, unknown>, start: number | null): void => {
    for (const field of ['removedAt', 'recoveredAt', 'withdrawnAt', 'supersededAt', 'abandonedAt']) {
      if (record[field] === undefined) continue;
      const timestamp = parseRemovalEvidenceTimestamp(record[field]);
      if (timestamp === null || timestamp > nowMs || (start !== null && timestamp < start)) {
        throw new Error('Invalid detection episode completion timestamp.');
      }
    }
  };
  const registerDetectionKey = (key: string): void => {
    if (catalogDetectionKeys.has(key)) throw new Error('Duplicate catalog detection.');
    catalogDetectionKeys.add(key);
  };
  const readCatalogDetection = (
    record: Record<string, unknown>,
    kind: 'absence' | 'official'
  ): number | null => {
    const { provider, modelId, fullStep, targetsAffected } = record;
    if (
      typeof provider !== 'string' || provider.length === 0 ||
      typeof modelId !== 'string' || modelId.length === 0 ||
      fullStep !== `${provider}/${modelId}` ||
      !Array.isArray(targetsAffected) || targetsAffected.length === 0 ||
      targetsAffected.some((target) => typeof target !== 'string' || !/^(router|harness):.+/.test(target))
    ) throw new Error(`Invalid ${kind} detection provenance.`);

    if (kind === 'absence') {
      const start = parseRemovalEvidenceTimestamp(record['scanStartedAt']);
      const end = parseRemovalEvidenceTimestamp(record['modelPendingAt']);
      const key = `ep-${JSON.stringify([provider, modelId, start])}`;
      const legacyKey = `ep-${provider}-${modelId}-${start}`;
      verifyCompletionChronology(record, start);
      if (record['status'] !== 'model_pending' || start === null || end === null ||
          end < start || end > nowMs || record['detectionMs'] !== end - start ||
          (record['episodeId'] !== key && record['episodeId'] !== legacyKey)) {
        throw new Error('Invalid model_pending detection episode or chronology.');
      }
      registerDetectionKey(key);
      return end - start;
    }

    const startRaw = record['firstQualifyingScanStartedAt'];
    const endRaw = record['firstPlanCreatedAt'];
    const publishedRaw = record['sourcePublishedAt'];
    const start = parseRemovalEvidenceTimestamp(startRaw);
    const end = parseRemovalEvidenceTimestamp(endRaw ?? record['planCreatedAt']);
    const published = parseRemovalEvidenceTimestamp(publishedRaw);
    verifyCompletionChronology(record, start);
    if ((startRaw != null && start === null) || (endRaw != null && end === null) ||
        (publishedRaw != null && published === null) ||
        (start !== null && start > nowMs) || (end !== null && end > nowMs) ||
        (start !== null && end !== null && end < start) ||
        (published !== null && published > nowMs)) {
      throw new Error('Invalid official notice detection chronology.');
    }
    if (typeof record['synthetic'] !== 'boolean') {
      throw new Error('Invalid official notice detection provenance.');
    }

    if (startRaw == null) return null; // Legacy publication-to-plan records are not latency evidence.
    const evidenceId = record['evidenceId'];
    const legacyKey = JSON.stringify([fullStep, evidenceId]);
    const episodeStartedAt = record['episodeStartedAt'] ?? startRaw;
    const episodeStartMs = parseRemovalEvidenceTimestamp(episodeStartedAt);
    const key = JSON.stringify([fullStep, evidenceId, episodeStartedAt]);
    if (typeof evidenceId !== 'string' || evidenceId.length === 0 ||
        episodeStartMs === null || episodeStartMs < start! || episodeStartMs > nowMs ||
        (end !== null && episodeStartMs > end) ||
        (record['recordKey'] !== key && record['recordKey'] !== legacyKey)) {
      throw new Error('Invalid official notice detection provenance.');
    }
    const prevEvRaw = record['previousEvidenceIds'];
    const prevKeysRaw = record['previousRecordKeys'];
    const prevEvSet = new Set<string>();
    if (prevEvRaw !== undefined) {
      if (!Array.isArray(prevEvRaw)) {
        throw new Error('Invalid official notice detection provenance.');
      }
      for (const item of prevEvRaw) {
        if (typeof item !== 'string' || item.length === 0 || item === evidenceId || prevEvSet.has(item)) {
          throw new Error('Invalid official notice detection provenance.');
        }
        prevEvSet.add(item);
      }
    }
    if (prevKeysRaw !== undefined) {
      if (!Array.isArray(prevKeysRaw)) {
        throw new Error('Invalid official notice detection provenance.');
      }
      const seenPrevKeys = new Set<string>();
      for (const prevKey of prevKeysRaw) {
        if (typeof prevKey !== 'string' || prevKey.length === 0 || prevKey === record['recordKey'] || seenPrevKeys.has(prevKey)) {
          throw new Error('Invalid official notice detection provenance.');
        }
        let parsedPrev: unknown;
        try {
          parsedPrev = JSON.parse(prevKey);
        } catch {
          throw new Error('Invalid official notice detection provenance.');
        }
        if (
          !Array.isArray(parsedPrev) ||
          (parsedPrev.length !== 2 && parsedPrev.length !== 3) ||
          parsedPrev[0] !== fullStep ||
          typeof parsedPrev[1] !== 'string' ||
          parsedPrev[1].length === 0 ||
          (parsedPrev[1] !== evidenceId && !prevEvSet.has(parsedPrev[1]))
        ) {
          throw new Error('Invalid official notice detection provenance.');
        }
        if (parsedPrev.length === 3) {
          const prevAnchorMs = parseRemovalEvidenceTimestamp(parsedPrev[2]);
          if (
            prevAnchorMs === null ||
            prevAnchorMs < start! ||
            prevAnchorMs > nowMs ||
            (end !== null && prevAnchorMs > end) ||
            prevKey !== JSON.stringify([fullStep, parsedPrev[1], parsedPrev[2]])
          ) {
            throw new Error('Invalid official notice detection provenance.');
          }
        } else if (prevKey !== JSON.stringify([fullStep, parsedPrev[1]])) {
          throw new Error('Invalid official notice detection provenance.');
        }
        seenPrevKeys.add(prevKey);
        registerDetectionKey(prevKey);
      }
    }
    registerDetectionKey(record['recordKey'] as string);
    if (endRaw == null) {
      if (record['detectionMs'] != null || record['publicationToPlanMs'] != null) {
        throw new Error('Invalid official notice detection duration.');
      }
      return null;
    }
    const latency = end! - start!;
    const publicationDelay = published === null ? null : end! - published;
    if (record['detectionMs'] !== latency || record['publicationToPlanMs'] !== publicationDelay) {
      throw new Error('Invalid official notice detection duration.');
    }
    return latency;
  };
  const observedScanIntervals: number[] = [];

  const countMeasurements = (rec: Record<string, unknown>, latency: number | null): number =>
    latency === null
      ? 0
      : ((rec['detectionLatency'] as { measuredCount?: number } | undefined)?.measuredCount ?? 1);
  let statusTokens = 0;
  let statusLlmCalls = 0;
  let statusPaidRequests = 0;

  if (stateDirExists) {
    const statusPath = path.join(stateDir, 'status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const rawStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as unknown;
        if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
          throw new Error('status.json root must be an object.');
        }
        const rec = rawStatus as Record<string, unknown>;
        if (rec['detectionHistoryError'] === 'DETECTION_HISTORY_CAP_EXCEEDED') detectionHistoryCapExceeded = true;
        const summaryInWindow = isSummaryInWindow(rec['timestamp'], 'status.json.timestamp');
        const summaryLatency = extractFiniteLatencyFromRecord(rec, 'status.json');
        if (summaryInWindow) {
          statusLatencyMs = summaryLatency;
          fileMeasuredCount = Math.max(fileMeasuredCount, countMeasurements(rec, statusLatencyMs));
          statusTokens = Math.max(
            statusTokens,
            readOptionalNonNegativeAccountingNumber(rec, 'tokens', 'status.json')
          );
          statusLlmCalls = Math.max(
            statusLlmCalls,
            readOptionalNonNegativeAccountingNumber(rec, 'llmCalls', 'status.json')
          );
          statusPaidRequests = Math.max(
            statusPaidRequests,
            readOptionalNonNegativeAccountingNumber(rec, 'paidRequests', 'status.json')
          );
        }
      } catch (err) {
        stateCorruptionCount += 1;
        blockingReasons.push(
          `STATUS_JSON_CORRUPT: <stateDir>/status.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }

    const tickPlanPath = path.join(stateDir, 'plans', 'tick-plan.json');
    if (fs.existsSync(tickPlanPath)) {
      try {
        const rawPlan = JSON.parse(fs.readFileSync(tickPlanPath, 'utf8')) as unknown;
        if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
          throw new Error('plans/tick-plan.json root must be an object.');
        }
        const rec = rawPlan as Record<string, unknown>;
        const summaryInWindow = isSummaryInWindow(rec['planCreatedAt'], 'plans/tick-plan.json.planCreatedAt');
        const summaryLatency = extractFiniteLatencyFromRecord(rec, 'plans/tick-plan.json');
        if (summaryInWindow) {
          const planRouterActions = Array.isArray(rec['routerActions'])
            ? (rec['routerActions'] as unknown[])
            : [];
          const planHarnessActions = Array.isArray(rec['harnessActions'])
            ? (rec['harnessActions'] as unknown[])
            : [];
          for (const rawAct of [...planRouterActions, ...planHarnessActions]) {
            if (rawAct && typeof rawAct === 'object' && !Array.isArray(rawAct)) {
              const act = rawAct as Record<string, unknown>;
              const reason = typeof act['reason'] === 'string' ? act['reason'] : '';
              if (act['action'] === 'REMOVE_MODEL' && reason.startsWith('OFFICIAL_')) {
                hasOfficialPlanAction = true;
              }
              if (
                act['action'] === 'REMOVE_MODEL' &&
                reason.startsWith('ABSENT_STABLE') &&
                (act['detectionKind'] !== 'absence-settled' || act['detectionLatencyMs'] !== null)
              ) {
                hasLegacyAmbiguousAbsencePlan = true;
              }
            }
          }
          tickPlanLatencyMs = summaryLatency;
          fileMeasuredCount = Math.max(fileMeasuredCount, countMeasurements(rec, tickPlanLatencyMs));
          const acc = rec['accounting'];
          if (acc !== undefined) {
            if (!acc || typeof acc !== 'object' || Array.isArray(acc)) {
              throw new Error('plans/tick-plan.json accounting must be an object.');
            }
            const accRec = acc as Record<string, unknown>;
            statusTokens = Math.max(
              statusTokens,
              readOptionalNonNegativeAccountingNumber(
                accRec,
                'tokens',
                'plans/tick-plan.json.accounting'
              )
            );
            statusLlmCalls = Math.max(
              statusLlmCalls,
              readOptionalNonNegativeAccountingNumber(
                accRec,
                'llmCalls',
                'plans/tick-plan.json.accounting'
              )
            );
            statusPaidRequests = Math.max(
              statusPaidRequests,
              readOptionalNonNegativeAccountingNumber(
                accRec,
                'paidRequests',
                'plans/tick-plan.json.accounting'
              )
            );
          }
        }
      } catch (err) {
        stateCorruptionCount += 1;
        blockingReasons.push(
          `TICK_PLAN_CORRUPT: <stateDir>/plans/tick-plan.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }

    const tickCatalogPath = path.join(stateDir, 'tick-catalog.json');
    if (fs.existsSync(tickCatalogPath)) {
      try {
        const rawCatalog = JSON.parse(fs.readFileSync(tickCatalogPath, 'utf8')) as unknown;
        if (!rawCatalog || typeof rawCatalog !== 'object' || Array.isArray(rawCatalog)) {
          throw new Error('tick-catalog.json root must be an object.');
        }
        const cat = rawCatalog as Record<string, unknown>;
        const recordCount = ['absenceDetections', 'officialNoticeDetections'].reduce((count, field) => {
          const records = cat[field];
          return count + (Array.isArray(records) ? records.length : 0);
        }, 0);
        if (recordCount > MAX_DETECTION_RECORDS ||
            cat['detectionHistoryError'] === 'DETECTION_HISTORY_CAP_EXCEEDED') detectionHistoryCapExceeded = true;
        if (cat['absenceDetections'] !== undefined) {
          if (!Array.isArray(cat['absenceDetections'])) {
            throw new Error('tick-catalog.json.absenceDetections must be an array.');
          }
          for (const rawEp of cat['absenceDetections'] as unknown[]) {
            if (!rawEp || typeof rawEp !== 'object' || Array.isArray(rawEp)) {
              throw new Error('tick-catalog.json.absenceDetections entries must be objects.');
            }
            const ep = rawEp as Record<string, unknown>;
            const duration = readCatalogDetection(ep, 'absence');
            const start = parseRemovalEvidenceTimestamp(ep['scanStartedAt']);
            if (duration !== null && start !== null && isEpisodeInWindow(ep) &&
                matchesTargetScopes(ep['targetsAffected'])) {
              catalogDetectionSamples.push(duration);
              removalDetections.push(ep);
            }
          }
        }
        if (cat['officialNoticeDetections'] !== undefined) {
          if (!Array.isArray(cat['officialNoticeDetections'])) {
            throw new Error('tick-catalog.json.officialNoticeDetections must be an array.');
          }
          for (const rawNotice of cat['officialNoticeDetections'] as unknown[]) {
            if (!rawNotice || typeof rawNotice !== 'object' || Array.isArray(rawNotice)) {
              throw new Error(
                'tick-catalog.json.officialNoticeDetections entries must be objects.'
              );
            }
            const nd = rawNotice as Record<string, unknown>;
            const duration = readCatalogDetection(nd, 'official');
            if (nd['withdrawnAt'] !== undefined || nd['supersededAt'] !== undefined) {
              const withdrawn = parseRemovalEvidenceTimestamp(nd['withdrawnAt'] ?? nd['supersededAt']);
              const start = parseRemovalEvidenceTimestamp(nd['firstQualifyingScanStartedAt']);
              if (withdrawn === null || start === null || withdrawn <= start || withdrawn > nowMs) {
                throw new Error('Invalid official notice withdrawal chronology.');
              }
              if (duration === null) continue;
            }
            const anchor = parseRemovalEvidenceTimestamp(nd['firstQualifyingScanStartedAt'] ?? nd['planCreatedAt']);
            if (!isEpisodeInWindow(nd)) continue;
            if (nd['firstQualifyingScanStartedAt'] == null && anchor !== null && !isInEvidenceWindow(anchor)) continue;
            if (matchesTargetScopes(nd['targetsAffected'])) {
              if (nd['synthetic'] === true) {
                hasSyntheticNoticeDetection = true;
              } else if (duration === null) {
                if (anchor !== null && finishedAt(nd) === null && nowMs - anchor > HARD_PASS_MAX_DETECTION_LATENCY_MS) {
                  maxOverdueOfficialMs = Math.max(maxOverdueOfficialMs ?? 0, nowMs - anchor);
                } else {
                  hasIncompleteOfficialDetection = true;
                }
              } else {
                hasMeasuredOfficialDetection = true;
                catalogDetectionSamples.push(duration);
                removalDetections.push(nd);
                if (typeof nd['publicationToPlanMs'] === 'number') {
                  publicationToPlanMs =
                    publicationToPlanMs === null
                      ? nd['publicationToPlanMs']
                      : Math.max(publicationToPlanMs, nd['publicationToPlanMs']);
                }
              }
            }
          }
        }
        if (
          cat['providers'] !== undefined &&
          cat['providers'] !== null &&
          typeof cat['providers'] === 'object' &&
          !Array.isArray(cat['providers'])
        ) {
          for (const rawProv of Object.values(cat['providers'] as Record<string, unknown>)) {
            if (!rawProv || typeof rawProv !== 'object' || Array.isArray(rawProv)) continue;
            const pObj = rawProv as Record<string, unknown>;
            const activeTargets = pObj['activeTargets'];
            if (
              (routerTargetProvided || harnessTargetProvided) &&
              Array.isArray(activeTargets) &&
              activeTargets.length > 0 &&
              !matchesTargetScopes(activeTargets)
            ) {
              continue;
            }
            const scanStamps = pObj['qualifyingScanTimestamps'];
            if (Array.isArray(scanStamps)) {
              if (scanStamps.some((stamp) => (parseRemovalEvidenceTimestamp(stamp) ?? 0) > nowMs)) {
                throw new Error('Future qualifying scan timestamp.');
              }
              const msList = scanStamps
                .filter((s): s is string => isValidIsoTimestamp(s))
                .map((s) => Date.parse(s))
                .filter(isInEvidenceWindow);
              for (let idx = 1; idx < msList.length; idx++) {
                const delta = msList[idx]! - msList[idx - 1]!;
                if (delta >= 0) observedScanIntervals.push(delta);
              }
            }
          }
        }
      } catch (err) {
        stateCorruptionCount += 1;
        blockingReasons.push(
          `TICK_CATALOG_CORRUPT: <stateDir>/tick-catalog.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }
  }

  if (detectionHistoryCapExceeded) {
    blockingReasons.push('DETECTION_HISTORY_CAP_EXCEEDED: Detection history capacity exceeded.');
  }
  // Aggregates cannot distinguish ambiguous legacy or synthetic samples.
  const hasSyntheticRemovalReceipt = applyHistory.valid && applyHistory.receipts.some(
    (receipt) => matchesTargetScopes([receipt.target]) &&
      isInEvidenceWindow(parseRemovalEvidenceTimestamp(receipt.appliedAt) ?? Number.NEGATIVE_INFINITY) &&
      receipt.removedModels?.some((removal) =>
        removal.removalPath === 'official-notice' && removal.syntheticNotice === true)
  );
  const hasOfficialRemovalReceipt = applyHistory.valid && applyHistory.receipts.some(
    (receipt) => matchesTargetScopes([receipt.target]) &&
      isInEvidenceWindow(parseRemovalEvidenceTimestamp(receipt.appliedAt) ?? Number.NEGATIVE_INFINITY) &&
      receipt.removedModels?.some((removal) => removal.removalPath === 'official-notice')
  );
  const hasUnmeasuredOfficialDetection =
    (hasOfficialPlanAction || hasOfficialRemovalReceipt) && !hasMeasuredOfficialDetection;
  const discardAggregateDetection = hasLegacyAmbiguousAbsencePlan ||
    hasSyntheticNoticeDetection || hasSyntheticRemovalReceipt || hasIncompleteOfficialDetection ||
    hasUnmeasuredOfficialDetection;
  const effectiveStatusLatencyMs = discardAggregateDetection ? null : statusLatencyMs;
  const effectiveTickPlanLatencyMs = discardAggregateDetection ? null : tickPlanLatencyMs;
  const effectiveFileMeasuredCount = discardAggregateDetection ? 0 : fileMeasuredCount;

  const allLatencySamples: number[] = [...catalogDetectionSamples];
  if (effectiveTickPlanLatencyMs !== null) allLatencySamples.push(effectiveTickPlanLatencyMs);
  if (effectiveStatusLatencyMs !== null) allLatencySamples.push(effectiveStatusLatencyMs);

  let measuredLatencyMs: number | null = null;
  if (allLatencySamples.length > 0) {
    measuredLatencyMs = allLatencySamples.some((v) => v < 0)
      ? Math.min(...allLatencySamples)
      : Math.max(...allLatencySamples);
  }
  const measuredCount = Math.max(catalogDetectionSamples.length, effectiveFileMeasuredCount);

  let latencySource: PilotReportS9Criteria['detectionLatencyMs']['source'] = 'missing';
  if (
    catalogDetectionSamples.length > 0 &&
    (effectiveTickPlanLatencyMs !== null || effectiveStatusLatencyMs !== null)
  ) {
    latencySource = 'tick-catalog.json+tick-plan.json+status.json';
  } else if (catalogDetectionSamples.length > 0) {
    latencySource = 'tick-catalog.json';
  } else if (effectiveTickPlanLatencyMs !== null && effectiveStatusLatencyMs !== null) {
    latencySource = 'tick-plan.json+status.json';
  } else if (effectiveTickPlanLatencyMs !== null) {
    latencySource = 'tick-plan.json';
  } else if (effectiveStatusLatencyMs !== null) {
    latencySource = 'status.json';
  }

  // -------------------------------------------------------------------------
  // Parse cost-ledger.json fail-closed & compute weekly research session cap
  // -------------------------------------------------------------------------
  let costLedgerCorrupt = false;
  let ledgerTokens = 0;
  let tickCount = 0;
  let ledgerLlmCalls = 0;
  let ledgerPaidRequests = 0;
  let explicitBudgetExceeded = false;
  let maxSessionsInAnyLedgerWeek = 0;

  const maxWeeklyResearchSessions = resolveMaxWeeklyResearchSessions(
    validConfig?.research?.maxWeeklyResearchSessions
  );

  if (stateDirExists) {
    const ledgerPath = path.join(stateDir, 'cost-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      try {
        const rawLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as unknown;
        if (!rawLedger || typeof rawLedger !== 'object' || Array.isArray(rawLedger)) {
          throw new Error('cost-ledger.json root must be a JSON object.');
        }
        const rec = rawLedger as Record<string, unknown>;
        ledgerTokens += readOptionalNonNegativeAccountingNumber(
          rec,
          'tier0Tokens',
          'cost-ledger.json'
        );
        ledgerLlmCalls += readOptionalNonNegativeAccountingNumber(
          rec,
          'tier0LlmCalls',
          'cost-ledger.json'
        );
        ledgerPaidRequests += readOptionalNonNegativeAccountingNumber(
          rec,
          'tier0PaidRequests',
          'cost-ledger.json'
        );
        if (rec['budgetExceeded'] !== undefined && typeof rec['budgetExceeded'] !== 'boolean') {
          throw new Error('cost-ledger.json.budgetExceeded must be a boolean when present.');
        }
        if (rec['budgetExceeded'] === true) {
          explicitBudgetExceeded = true;
        }
        if (rec['ticks'] !== undefined) {
          if (!Array.isArray(rec['ticks'])) {
            throw new Error('cost-ledger.json.ticks must be an array.');
          }
          tickCount = rec['ticks'].length;
          for (const entry of rec['ticks'] as unknown[]) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              throw new Error('cost-ledger.json.ticks entries must be plain objects.');
            }
            const t = entry as Record<string, unknown>;
            ledgerTokens += readOptionalNonNegativeAccountingNumber(
              t,
              'tokens',
              'cost-ledger.json.ticks[]'
            );
            ledgerLlmCalls += readOptionalNonNegativeAccountingNumber(
              t,
              'llmCalls',
              'cost-ledger.json.ticks[]'
            );
            ledgerPaidRequests += readOptionalNonNegativeAccountingNumber(
              t,
              'paidRequests',
              'cost-ledger.json.ticks[]'
            );
          }
        }
        if (rec['researchSessions'] !== undefined) {
          if (!Array.isArray(rec['researchSessions'])) {
            throw new Error('cost-ledger.json.researchSessions must be an array.');
          }
          const byWeek = new Map<string, Set<string>>();
          for (const sess of rec['researchSessions'] as unknown[]) {
            if (!sess || typeof sess !== 'object' || Array.isArray(sess)) {
              throw new Error('cost-ledger.json.researchSessions entries must be plain objects.');
            }
            const s = sess as Record<string, unknown>;
            const wk = typeof s['isoWeek'] === 'string' ? s['isoWeek'].trim() : '';
            const id = typeof s['sessionId'] === 'string' ? s['sessionId'].trim() : '';
            if (!wk || !id) {
              throw new Error(
                'cost-ledger.json.researchSessions entries must have non-empty sessionId and isoWeek.'
              );
            }
            let set = byWeek.get(wk);
            if (!set) {
              set = new Set<string>();
              byWeek.set(wk, set);
            }
            set.add(id);
          }
          for (const set of byWeek.values()) {
            if (set.size > maxSessionsInAnyLedgerWeek) {
              maxSessionsInAnyLedgerWeek = set.size;
            }
          }
        }
      } catch (err) {
        costLedgerCorrupt = true;
        stateCorruptionCount += 1;
        blockingReasons.push(
          `COST_LEDGER_CORRUPT: <stateDir>/cost-ledger.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }
  }

  const weeklyBudget =
    stateDirExists && !costLedgerCorrupt
      ? computeWeeklyResearchBudget(stateDir, {
          nowMs,
          maxWeeklyResearchSessions,
        })
      : {
          isoWeek: 'unknown',
          usedSessions: 0,
          maxWeeklyResearchSessions,
          remainingSessions: maxWeeklyResearchSessions,
          budgetExceeded: false,
        };

  const weeklySessionsUsed = Math.max(weeklyBudget.usedSessions, maxSessionsInAnyLedgerWeek);
  const tier0Tokens = Math.max(ledgerTokens, statusTokens);
  const tier0LlmCalls = Math.max(ledgerLlmCalls, statusLlmCalls);
  const tier0PaidRequests = Math.max(ledgerPaidRequests, statusPaidRequests);
  const budgetExceeded =
    explicitBudgetExceeded || weeklySessionsUsed > maxWeeklyResearchSessions;

  // -------------------------------------------------------------------------
  // Evaluate Criterion 1..5 (`S9` Quantitative Sign-Off)
  // -------------------------------------------------------------------------
  const receipts = applyHistory.valid ? applyHistory.receipts : [];
  const relevantReceipts = receipts.filter((r) => {
    const appliedAt = parseRemovalEvidenceTimestamp(r.appliedAt);
    if (appliedAt !== null && appliedAt < effectiveWindowStartMs) return false;
    if (!routerTargetProvided && !harnessTargetProvided) return true;
    const matchesRouter = normalizedRouterTarget ? routerAliases.has(r.target) : false;
    const matchesHarness = normalizedHarnessTarget ? r.target === normalizedHarnessTarget : false;
    return matchesRouter || matchesHarness;
  });

  const failedAutoSafeReceiptCount = receipts.filter(
    (r) => r.appliedAtLevel === 'auto-safe' && (!r.success || !r.readBackVerified)
  ).length;
  const removalReceipts = relevantReceipts.flatMap((receipt) =>
    (receipt.removedModels ?? []).map((removal) => ({ removal, appliedAt: receipt.appliedAt, target: receipt.target }))
  );
  const removals = removalReceipts.map(({ removal }) => removal);
  const catalogFalseRemovals = removals.filter((model) => model.inProviderCatalog === true).length;
  const completeCatalogEvidence = removals.length > 0 &&
    removals.every((model) => model.inProviderCatalog !== null);
  const totalFalseRemovals =
    Math.max(manualFalseRemovals ?? 0, catalogFalseRemovals) +
    autoRollbackIncidentCount + failedAutoSafeReceiptCount;
  const removalSource = (completeCatalogEvidence || totalFalseRemovals > 0) &&
    (manualFalseRemovals ?? 0) <= catalogFalseRemovals
    ? 'derived' : manualFalseRemovals === null ? 'missing' : 'owner-attested';
  const c1Passed = stateDirExists && removalSource !== 'missing' && totalFalseRemovals === 0;
  const missingRemovalEvidence = 'S9_CRITERION_1_INCOMPLETE: provide --false-removals or complete provider catalog evidence.';
  if (!stateDirExists || totalFalseRemovals > 0) {
    blockingReasons.push(
      `S9_CRITERION_1_FAILED: falseRemovals=${totalFalseRemovals} (expected 0; manual=${manualFalseRemovals}, autoRollbackIncidents=${autoRollbackIncidentCount}, failedAutoSafeReceipts=${failedAutoSafeReceiptCount}).`
    );
  } else if (removalSource === 'missing') {
    incompleteReasons.push(missingRemovalEvidence);
  }

  const failedReceiptsCount = relevantReceipts.filter(
    (r) => !r.success || !r.readBackVerified || r.rollbackVerified === false
  ).length;
  const verifiedReceipts = relevantReceipts.filter((r) => r.rolledBack && r.rollbackVerified === true);
  const rolledBackReceiptsCount = relevantReceipts.filter((r) => r.rolledBack).length;

  const hasRouterVerified = routerTargetProvided
    ? normalizedRouterTarget !== null && verifiedReceipts.some((r) => routerAliases.has(r.target))
    : true;
  const hasHarnessVerified = harnessTargetProvided
    ? normalizedHarnessTarget !== null &&
      verifiedReceipts.some((r) => r.target === normalizedHarnessTarget)
    : true;
  const verifiedTargets = new Set(verifiedReceipts.map((r) => r.target));
  const coversAllTargets = routerTargetProvided || harnessTargetProvided ||
    relevantReceipts.every((receipt) => verifiedTargets.has(receipt.target));

  const c2Passed =
    stateDirExists &&
    applyHistory.present &&
    applyHistory.valid &&
    failedReceiptsCount === 0 &&
    verifiedReceipts.length > 0 &&
    coversAllTargets &&
    hasRouterVerified &&
    hasHarnessVerified;
  if (!c2Passed) {
    const reasons = failedReceiptsCount > 0 ? blockingReasons : incompleteReasons;
    reasons.push(
      `S9_CRITERION_2_${failedReceiptsCount > 0 ? 'FAILED' : 'INCOMPLETE'}: rollbackByteExactMatch=false (verifiedRollbacks=${verifiedReceipts.length}, failedReceipts=${failedReceiptsCount}, routerVerified=${hasRouterVerified}, harnessVerified=${hasHarnessVerified}).`
    );
  }

  if (maxOverdueOfficialMs !== null) {
    blockingReasons.push(`S9_OFFICIAL_DETECTION_OVERDUE: An actionable official notice has no plan after ${maxOverdueOfficialMs} ms.`);
  }
  if (hasIncompleteOfficialDetection || (hasUnmeasuredOfficialDetection && !hasSyntheticNoticeDetection)) {
    incompleteReasons.push('S9_OFFICIAL_DETECTION_INCOMPLETE: Missing official-notice scan or plan timestamp.');
  }
  if (hasSyntheticNoticeDetection) {
    blockingReasons.push('SYNTHETIC_OFFICIAL_NOTICE: Synthetic detection is excluded from live sign-off.');
  }
  const acceptedVacuous = stateDirExists && measuredCount === 0 &&
    options.acceptVacuousDetection === true && stateCorruptionCount === 0;
  const warnings = acceptedVacuous
    ? ['VACUOUS: --accept-vacuous-detection was supplied. No detection latency was measured.']
    : [];
  const c3Passed = maxOverdueOfficialMs === null && (acceptedVacuous || (stateDirExists &&
    measuredLatencyMs !== null &&
    measuredLatencyMs >= 0 &&
    measuredLatencyMs <= HARD_PASS_MAX_DETECTION_LATENCY_MS));
  if (!c3Passed) {
    const reasons = measuredLatencyMs === null ? incompleteReasons : blockingReasons;
    reasons.push(
      measuredLatencyMs === null
        ? 'S9_CRITERION_3_INCOMPLETE: VACUOUS (0 measured detections).'
        : `S9_CRITERION_3_FAILED: detectionLatencyMs=${measuredLatencyMs} (expected finite measurement in 0..${HARD_PASS_MAX_DETECTION_LATENCY_MS} ms).`
    );
  }

  const uncoveredRemovals = removalReceipts.filter(({ removal, appliedAt, target }) => {
    const removalAt = parseRemovalEvidenceTimestamp(appliedAt);
    if (removalAt === null) return true;
    return !removalDetections.some((sample) => {
      if (sample['provider'] !== removal.provider || sample['modelId'] !== removal.modelId ||
          !Array.isArray(sample['targetsAffected']) || !sample['targetsAffected'].includes(target)) return false;
      const detectedAt = parseRemovalEvidenceTimestamp(sample['firstPlanCreatedAt'] ?? sample['modelPendingAt']);
      if (detectedAt === null || detectedAt > removalAt) return false;
      if (removal.removalPath === 'official-notice') {
        if (typeof removal.detectionEvidenceId !== 'string') return false;
        if (
          sample['evidenceId'] === removal.detectionEvidenceId &&
          (removal.detectionEpisodeId === undefined || sample['recordKey'] === removal.detectionEpisodeId)
        ) {
          return true;
        }
        const prevEvIds = Array.isArray(sample['previousEvidenceIds']) ? sample['previousEvidenceIds'] : [];
        const prevRecKeys = Array.isArray(sample['previousRecordKeys']) ? sample['previousRecordKeys'] : [];
        if (!prevEvIds.includes(removal.detectionEvidenceId)) return false;
        if (removal.detectionEpisodeId === undefined) return true;
        if (!prevRecKeys.includes(removal.detectionEpisodeId)) return false;
        try {
          const parsedEp = JSON.parse(removal.detectionEpisodeId) as unknown;
          return Array.isArray(parsedEp) && parsedEp[1] === removal.detectionEvidenceId;
        } catch {
          return false;
        }
      }
      const absenceAt = parseRemovalEvidenceTimestamp(removal.firstObservedAbsentAt);
      return sample['status'] === 'model_pending' &&
        (removal.detectionEpisodeId === undefined
          ? absenceAt !== null && parseRemovalEvidenceTimestamp(sample['scanStartedAt']) === absenceAt
          : sample['episodeId'] === removal.detectionEpisodeId);
    });
  });
  if (uncoveredRemovals.length > 0) {
    incompleteReasons.push(
      'S9_REMOVAL_DETECTION_INCOMPLETE: Missing matching detection evidence for ' +
      uncoveredRemovals.map(({ removal, target }) => `${target}/${removal.provider}/${removal.modelId}`).join(', ')
    );
  }

  // C48-H1: Separate removalSettleMs reporting (no time ceiling) + independent policy validation
  const observedScanIntervalSummary: PilotReportObservedScanInterval =
    observedScanIntervals.length > 0
      ? {
          sampleCount: observedScanIntervals.length,
          minMs: Math.min(...observedScanIntervals),
          maxMs: Math.max(...observedScanIntervals),
          lastMs: observedScanIntervals[observedScanIntervals.length - 1]!,
        }
      : { sampleCount: 0, minMs: null, maxMs: null, lastMs: null };

  const settleDurations: number[] = [];
  const settlePathsSet = new Set<'absence-only' | 'official-notice'>();
  let missingSettleProof = false;
  const prematureRemovalViolations: string[] = [];
  let hasSyntheticNoticeRemoval = false;
  let hasGenuineNoticeRemoval = false;

  for (const { removal: rem, appliedAt } of removalReceipts) {
    if (rem.removalPath === undefined) {
      missingSettleProof = true;
      continue;
    }

    const model = `${rem.provider}/${rem.modelId}`;
    settlePathsSet.add(rem.removalPath);
    if (rem.removalPath === 'official-notice') {
      if (rem.syntheticNotice === true) {
        hasSyntheticNoticeRemoval = true;
        prematureRemovalViolations.push(`${model} used synthetic official notice evidence`);
      } else {
        hasGenuineNoticeRemoval = true;
      }
    }

    const duration = deriveRemovalSettlementMs(rem, appliedAt, { allowSyntheticFixture: rem.syntheticNotice === true });
    const removedMs = parseRemovalEvidenceTimestamp(rem.removedAt);
    if (duration === null || removedMs === null || removedMs > nowMs ||
        rem.qualifyingScanCount === undefined) {
      prematureRemovalViolations.push(`${model} has invalid removal timestamps, duration, or scan count`);
      continue;
    }
    settleDurations.push(duration);

    if (
      rem.removalPath === 'absence-only' &&
      (duration < REMOVAL_SETTLE_ABSENCE_MIN_MS ||
        rem.qualifyingScanCount < REMOVAL_SETTLE_ABSENCE_MIN_SCANS)
    ) {
      prematureRemovalViolations.push(
        `${model} removed prematurely (settleMs=${duration}, scans=${rem.qualifyingScanCount}; required >=${REMOVAL_SETTLE_ABSENCE_MIN_MS}ms and >=${REMOVAL_SETTLE_ABSENCE_MIN_SCANS} scans)`
      );
    } else if (rem.removalPath === 'official-notice' &&
        (rem.officialDomainVerified !== true || typeof rem.syntheticNotice !== 'boolean')) {
      prematureRemovalViolations.push(`${model} removed via unverified official domain`);
    }
  }

  let removalSettleStatus: PilotReportRemovalSettle['status'];
  let policySatisfiedAtRemoval: boolean | null;
  let removalSettleDetail: string;

  if (!stateDirExists || catalogFalseRemovals > 0 || prematureRemovalViolations.length > 0) {
    removalSettleStatus = 'FAIL';
    policySatisfiedAtRemoval = false;
    removalSettleDetail =
      catalogFalseRemovals > 0
        ? `Healthy model(s) still present in provider catalog were removed (count=${catalogFalseRemovals}).`
        : prematureRemovalViolations.join('; ') || 'State directory unavailable.';
    if (stateDirExists && (catalogFalseRemovals > 0 || prematureRemovalViolations.length > 0)) {
      blockingReasons.push(`S9_REMOVAL_SETTLE_FAILED: ${removalSettleDetail}`);
    }
  } else if (removals.length === 0) {
    removalSettleStatus = 'INCOMPLETE';
    policySatisfiedAtRemoval = null;
    removalSettleDetail = '0 actual removals settled during pilot.';
    incompleteReasons.push('S9_REMOVAL_SETTLE_INCOMPLETE: 0 actual removals settled during pilot.');
  } else if (missingSettleProof) {
    removalSettleStatus = 'INCOMPLETE';
    policySatisfiedAtRemoval = null;
    removalSettleDetail =
      'Removal receipt is missing C48 policy proof (removalPath / timestamps / qualifyingScanCount).';
    incompleteReasons.push(`S9_REMOVAL_SETTLE_INCOMPLETE: ${removalSettleDetail}`);
  } else {
    removalSettleStatus = 'PASS';
    policySatisfiedAtRemoval = true;
    removalSettleDetail = `${removals.length} removal(s) settled cleanly with verified policy proof.`;
  }

  const noticeOrigin: PilotReportRemovalSettle['noticeOrigin'] = hasSyntheticNoticeRemoval
    ? 'synthetic'
    : hasGenuineNoticeRemoval
      ? 'genuine'
      : 'none';
  if (noticeOrigin === 'synthetic') {
    warnings.push(
      'SYNTHETIC_OFFICIAL_NOTICE: Removal settled via synthetic official notice (isolated fixture rehearsal only).'
    );
  }

  const settleMinMs = settleDurations.length > 0 ? Math.min(...settleDurations) : null;
  const settleMaxMs = settleDurations.length > 0 ? Math.max(...settleDurations) : null;
  const removalSettle: PilotReportRemovalSettle = {
    status: removalSettleStatus,
    passed: removalSettleStatus === 'PASS',
    removedModelCount: removals.length,
    falseRemovalCount: catalogFalseRemovals,
    policySatisfiedAtRemoval,
    minMs: settleMinMs,
    maxMs: settleMaxMs,
    removalSettleMs: settleMaxMs,
    removalPaths: [...settlePathsSet],
    noticeOrigin,
    observedScanIntervalMs: observedScanIntervalSummary,
    providerToFirstScanMs: null,
    unobservableWindow: 'provider-to-first-scan',
    detail: removalSettleDetail,
  };

  const c4Passed =
    stateDirExists &&
    !costLedgerCorrupt &&
    tier0Tokens === 0 &&
    tier0LlmCalls === 0 &&
    tier0PaidRequests === 0 &&
    !budgetExceeded;
  if (!c4Passed) {
    blockingReasons.push(
      `S9_CRITERION_4_FAILED: cost violation (tier0Tokens=${tier0Tokens}, tier0LlmCalls=${tier0LlmCalls}, tier0PaidRequests=${tier0PaidRequests}, weeklySessionsUsed=${weeklySessionsUsed}/${maxWeeklyResearchSessions}, budgetExceeded=${budgetExceeded}, corrupt=${costLedgerCorrupt}).`
    );
  }

  const emergencyFreezeActive = Boolean(stateDirExists && freezeState.frozen && !isFreezeCorrupt);
  const totalUnplannedInterventions =
    (manualInterventions ?? 0) + stateCorruptionCount + (emergencyFreezeActive ? 1 : 0);
  const interventionSource = (manualInterventions ?? 0) === 0 && totalUnplannedInterventions > 0
    ? 'derived' : manualInterventions === null ? 'missing' : 'owner-attested';
  const c5Passed = stateDirExists && interventionSource !== 'missing' && totalUnplannedInterventions === 0;
  const missingInterventionEvidence = 'S9_CRITERION_5_INCOMPLETE: provide --unplanned-interventions.';
  if (!stateDirExists || totalUnplannedInterventions > 0) {
    blockingReasons.push(
      `S9_CRITERION_5_FAILED: unplannedManualInterventions=${totalUnplannedInterventions} (expected 0; manual=${manualInterventions}, stateCorruption=${stateCorruptionCount}, emergencyFreezeActive=${emergencyFreezeActive}).`
    );
  } else if (interventionSource === 'missing') {
    incompleteReasons.push(missingInterventionEvidence);
  }

  const status = blockingReasons.length > 0 ? 'FAIL'
    : incompleteReasons.length > 0 ? 'INCOMPLETE' : 'PASS';

  const report: PilotReportResult = {
    schemaVersion: 1,
    generatedAt,
    status,
    passed: status === 'PASS',
    stateDir,
    pilotTargets: {
      routerTarget: normalizedRouterTarget,
      harnessTarget: normalizedHarnessTarget,
    },
    servingReflectionMs,
    removalSettle,
    tickCount,
    warnings,
    criteria: {
      falseRemovals: {
        passed: c1Passed,
        count: removalSource === 'missing' ? null : totalFalseRemovals,
        source: removalSource,
        removedModelCount: removals.length,
        manualReportedCount: manualFalseRemovals,
        autoRollbackIncidentCount,
        failedAutoSafeReceiptCount,
        detail: c1Passed
          ? '0 false removals or incidents in the available evidence.'
          : !stateDirExists ? 'State directory unavailable.'
          : removalSource === 'missing' ? missingRemovalEvidence
          : `Detected ${totalFalseRemovals} false-removal / auto-rollback incident(s).`,
      },
      rollbackByteExactMatch: {
        passed: c2Passed,
        matched: c2Passed,
        verifiedReceiptsCount: verifiedReceipts.length,
        rolledBackReceiptsCount,
        failedReceiptsCount,
        detail: c2Passed
          ? `${verifiedReceipts.length} verified rollback receipt(s) cover the pilot targets.`
          : 'Rollback evidence is missing or a recorded verification failed.',
      },
      detectionLatencyMs: {
        passed: c3Passed,
        maxMs: measuredLatencyMs,
        measuredCount,
        acceptedVacuous,
        publicationToPlanMs,
        thresholdMs: HARD_PASS_MAX_DETECTION_LATENCY_MS,
        source: latencySource,
        detail: measuredLatencyMs === null
          ? 'VACUOUS: no detection sample.'
          : c3Passed
          ? `Deterministic tick detection latency ${measuredLatencyMs} ms <= ${HARD_PASS_MAX_DETECTION_LATENCY_MS} ms (${latencySource}).`
          : `Detection latency ${measuredLatencyMs ?? 'missing'} failed <= ${HARD_PASS_MAX_DETECTION_LATENCY_MS} ms threshold.`,
      },
      cost: {
        passed: c4Passed,
        tier0Tokens,
        tier0LlmCalls,
        tier0PaidRequests,
        weeklySessionsUsed,
        maxWeeklyResearchSessions,
        budgetExceeded,
        detail: c4Passed
          ? `tier0Tokens=0, tier0LlmCalls=0, tier0PaidRequests=0, weeklySessions=${weeklySessionsUsed}/${maxWeeklyResearchSessions}.`
          : `Cost invariant failed (tokens=${tier0Tokens}, llmCalls=${tier0LlmCalls}, paid=${tier0PaidRequests}, sessions=${weeklySessionsUsed}/${maxWeeklyResearchSessions}).`,
      },
      unplannedManualInterventions: {
        passed: c5Passed,
        count: interventionSource === 'missing' ? null : totalUnplannedInterventions,
        source: interventionSource,
        manualReportedCount: manualInterventions,
        stateCorruptionCount,
        emergencyFreezeActive,
        detail: c5Passed
          ? '0 unplanned manual interventions, 0 corrupt state files, freeze clear.'
          : !stateDirExists ? 'State directory unavailable.'
          : interventionSource === 'missing' ? missingInterventionEvidence
          : `Detected ${totalUnplannedInterventions} unplanned intervention / state corruption / active freeze issue(s).`,
      },
    },
    blockingReasons: [...blockingReasons, ...incompleteReasons],
  };

  if (!report.passed) {
    process.exitCode = 1;
  }

  const renderedOutput = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatMarkdownSignOffReport(report);

  if (resolvedOutPath) {
    fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
    fs.writeFileSync(resolvedOutPath, renderedOutput, 'utf8');
  }

  if (!options.silent) {
    const writeFn = options.writeStdout ?? ((text: string) => process.stdout.write(text));
    writeFn(renderedOutput);
  }

  return report;
}
