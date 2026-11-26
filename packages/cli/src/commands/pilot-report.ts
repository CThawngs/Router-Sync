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
    count: number;
    manualReportedCount: number;
    source: 'derived' | 'owner-attested';
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
    thresholdMs: number;
    source: 'tick-plan.json' | 'status.json' | 'tick-plan.json+status.json' | 'missing';
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
    count: number;
    manualReportedCount: number;
    source: 'derived' | 'owner-attested';
    stateCorruptionCount: number;
    emergencyFreezeActive: boolean;
    detail: string;
  };
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
  return typeof val === 'string' && val.trim().length > 0 && Number.isFinite(Date.parse(val));
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
    if (
      !isValidIsoTimestamp(rec['planCreatedAt']) ||
      !Array.isArray(routerActions) ||
      routerActions.length !== 0 ||
      !Array.isArray(harnessActions) ||
      harnessActions.length !== 0
    ) {
      throw new Error(
        'plans/tick-plan.json with detectionLatency.measuredCount=0 requires a valid ISO planCreatedAt and empty routerActions/harnessActions.'
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

  if (report.servingReflectionMs !== null) {
    lines.push(
      `- **Độ trễ phản ánh đường phục vụ HTTP \`/v1/models\` (D26, ghi riêng ngoài \`detectionLatencyMs\`):** \`${report.servingReflectionMs} ms\``
    );
  }

  lines.push(
    '',
    '| # | Tiêu chí S9 | Giá trị Đo được | Ngưỡng Đạt Cứng | Kết quả |',
    '|---:|---|---|---|---|',
    `| 1 | \`falseRemovals\` | \`${c.falseRemovals.count}\` (${c.falseRemovals.source}) | \`=== 0\` | **${badge(c.falseRemovals.passed)}** |`,
    `| 2 | \`rollbackByteExactMatch\` | \`${c.rollbackByteExactMatch.matched}\` (\`${c.rollbackByteExactMatch.verifiedReceiptsCount}\` biên nhận xác minh) | Đối chiếu SHA-256 của harness và hàng combo của router | **${badge(c.rollbackByteExactMatch.passed, c.rollbackByteExactMatch.failedReceiptsCount === 0)}** |`,
    `| 3 | \`detectionLatencyMs\` | \`${latencyText}\` | \`<= 60000 ms\` | **${badge(c.detectionLatencyMs.passed, c.detectionLatencyMs.maxMs === null)}** |`,
    `| 4 | \`tier0Tokens\` & Ngân sách tuần | \`${costText}\` | \`0\` token/LLM/paid & \`<= ${c.cost.maxWeeklyResearchSessions}\` phiên/tuần | **${badge(c.cost.passed)}** |`,
    `| 5 | \`unplannedManualInterventions\` | \`${c.unplannedManualInterventions.count}\` (${c.unplannedManualInterventions.source}) | \`=== 0\` | **${badge(c.unplannedManualInterventions.passed)}** |`
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
    parseOptionalNonNegativeSafeInt(options.falseRemovals, '--false-removals') ?? 0;
  const manualInterventions =
    parseOptionalNonNegativeSafeInt(options.unplannedInterventions, '--unplanned-interventions') ??
    0;

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
  // Parse status.json & plans/tick-plan.json for detectionLatencyMs + accounting
  // -------------------------------------------------------------------------
  let statusLatencyMs: number | null = null;
  let tickPlanLatencyMs: number | null = null;
  let measuredCount = 0;
  const countMeasurements = (rec: Record<string, unknown>, latency: number | null): number =>
    latency === null ? 0 : ((rec['detectionLatency'] as { measuredCount?: number } | undefined)?.measuredCount ?? 1);
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
        statusLatencyMs = extractFiniteLatencyFromRecord(rec, 'status.json');
        measuredCount = Math.max(measuredCount, countMeasurements(rec, statusLatencyMs));
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
        tickPlanLatencyMs = extractFiniteLatencyFromRecord(rec, 'plans/tick-plan.json');
        measuredCount = Math.max(measuredCount, countMeasurements(rec, tickPlanLatencyMs));
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
      } catch (err) {
        stateCorruptionCount += 1;
        blockingReasons.push(
          `TICK_PLAN_CORRUPT: <stateDir>/plans/tick-plan.json is malformed (${err instanceof Error ? err.message : String(err)}).`
        );
      }
    }
  }

  let measuredLatencyMs: number | null = null;
  let latencySource: PilotReportS9Criteria['detectionLatencyMs']['source'] = 'missing';
  if (tickPlanLatencyMs !== null && statusLatencyMs !== null) {
    measuredLatencyMs = Math.max(tickPlanLatencyMs, statusLatencyMs);
    latencySource = 'tick-plan.json+status.json';
  } else if (tickPlanLatencyMs !== null) {
    measuredLatencyMs = tickPlanLatencyMs;
    latencySource = 'tick-plan.json';
  } else if (statusLatencyMs !== null) {
    measuredLatencyMs = statusLatencyMs;
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
    if (!routerTargetProvided && !harnessTargetProvided) return true;
    const matchesRouter = normalizedRouterTarget ? routerAliases.has(r.target) : false;
    const matchesHarness = normalizedHarnessTarget ? r.target === normalizedHarnessTarget : false;
    return matchesRouter || matchesHarness;
  });

  const failedAutoSafeReceiptCount = receipts.filter(
    (r) => r.appliedAtLevel === 'auto-safe' && (!r.success || !r.readBackVerified)
  ).length;
  const removals = relevantReceipts.flatMap((receipt) => receipt.removedModels ?? []);
  const catalogFalseRemovals = removals.filter((model) => model.inProviderCatalog === true).length;
  const removalSource = removals.length > 0 && manualFalseRemovals <= catalogFalseRemovals &&
    removals.every((model) => model.inProviderCatalog !== null)
    ? 'derived' : 'owner-attested';
  const totalFalseRemovals =
    Math.max(manualFalseRemovals, catalogFalseRemovals) + autoRollbackIncidentCount + failedAutoSafeReceiptCount;
  const c1Passed = stateDirExists && totalFalseRemovals === 0;
  if (!c1Passed) {
    blockingReasons.push(
      `S9_CRITERION_1_FAILED: falseRemovals=${totalFalseRemovals} (expected 0; manual=${manualFalseRemovals}, autoRollbackIncidents=${autoRollbackIncidentCount}, failedAutoSafeReceipts=${failedAutoSafeReceiptCount}).`
    );
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

  const acceptedVacuous = stateDirExists && measuredCount === 0 &&
    options.acceptVacuousDetection === true && stateCorruptionCount === 0;
  const warnings = acceptedVacuous
    ? ['VACUOUS: --accept-vacuous-detection was supplied. No detection latency was measured.']
    : [];
  const c3Passed = acceptedVacuous || (stateDirExists &&
    measuredLatencyMs !== null &&
    measuredLatencyMs >= 0 &&
    measuredLatencyMs <= HARD_PASS_MAX_DETECTION_LATENCY_MS);
  if (!c3Passed) {
    const reasons = measuredLatencyMs === null ? incompleteReasons : blockingReasons;
    reasons.push(
      measuredLatencyMs === null
        ? 'S9_CRITERION_3_INCOMPLETE: VACUOUS (0 measured detections).'
        : `S9_CRITERION_3_FAILED: detectionLatencyMs=${measuredLatencyMs} (expected finite measurement in 0..${HARD_PASS_MAX_DETECTION_LATENCY_MS} ms).`
    );
  }

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
    manualInterventions + stateCorruptionCount + (emergencyFreezeActive ? 1 : 0);
  const c5Passed = stateDirExists && totalUnplannedInterventions === 0;
  if (!c5Passed) {
    blockingReasons.push(
      `S9_CRITERION_5_FAILED: unplannedManualInterventions=${totalUnplannedInterventions} (expected 0; manual=${manualInterventions}, stateCorruption=${stateCorruptionCount}, emergencyFreezeActive=${emergencyFreezeActive}).`
    );
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
    tickCount,
    warnings,
    criteria: {
      falseRemovals: {
        passed: c1Passed,
        count: totalFalseRemovals,
        source: removalSource,
        removedModelCount: removals.length,
        manualReportedCount: manualFalseRemovals,
        autoRollbackIncidentCount,
        failedAutoSafeReceiptCount,
        detail: c1Passed
          ? '0 false removals or incidents in the available evidence.'
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
        count: totalUnplannedInterventions,
        source: manualInterventions === 0 && (stateCorruptionCount > 0 || emergencyFreezeActive)
          ? 'derived' : 'owner-attested',
        manualReportedCount: manualInterventions,
        stateCorruptionCount,
        emergencyFreezeActive,
        detail: c5Passed
          ? '0 unplanned manual interventions, 0 corrupt state files, freeze clear.'
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
