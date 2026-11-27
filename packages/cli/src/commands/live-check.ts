/**
 * packages/cli/src/commands/live-check.ts
 *
 * C45-WP9 & C46-F2 (`Phục vụ: S9, I4, I5`): Strictly Read-Only Live Pilot Readiness CLI (`routersync live-check`).
 *
 * Hard Zero-Mutation Guarantee (`100%` Read-Only):
 *  - NEVER creates, modifies, renames, or updates `mtime` on any router DB, harness config, or `<stateDir>` file.
 *  - NEVER mutates `process.env`.
 *  - Performs backup/parse/write/restore rehearsal exclusively inside an ephemeral `os.tmpdir()/rs-livecheck-*`
 *    directory and deletes that temporary directory unconditionally in `finally`.
 *  - Bot team hard-stops at status `'READY_FOR_OWNER_LIVE_PILOT'` (`'sẵn sàng chạy thật'`);
 *    live pilot writes and release cutover are strictly owner-only (`docs/runbook/LIVE-E2E-v2.md`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  canonicalJsonStringify,
  computeWeeklyResearchBudget,
  expandHarnessPathPattern,
  findVerifiedProposeReceipt,
  getHarnessCapability,
  isPathInsideDir,
  loadHarnessMatrix,
  openBetterSqlite3,
  parseTargetScope,
  readApplyHistory,
  readConsentSigningKeyIfPresent,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  resolveDeepCanonicalPath,
  verifyHmacSha256Hex,
  type HarnessCapability,
  type StandingConsentEntryView,
} from '@routersync/core';
import {
  assertOpenMausBotSafeFile,
  getHarnessWriteAdapter,
  isInsideRealHomeOutsideSandbox,
  resolveDeepRealPath,
} from '../apps/write-adapter.js';
import { expandTilde, getDefaultConfigPath, resolveRouterDbPath } from '../config/loader.js';
import { RouterSyncConfigSchema, type RouterConfig, type RouterSyncConfig } from '../config/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type PilotPhase =
  | 'NEEDS_INITIAL_PROPOSE_CONSENT'
  | 'READY_FOR_PROPOSE_STEP'
  | 'READY_FOR_AUTO_SAFE_PROMOTION'
  | 'AUTO_SAFE_ACTIVE';

export interface LiveCheckItem {
  id: string;
  passed: boolean;
  detail: string;
  remediationCommand?: string;
}

export interface LiveCheckReport {
  schemaVersion: 1;
  checkedAt: string;
  status: 'READY_FOR_OWNER_LIVE_PILOT' | 'BLOCKED';
  vietnameseGateStatus: 'sẵn sàng chạy thật' | 'chưa đủ điều kiện chạy thật';
  pilotTargets: {
    routerTarget: string | null;
    harnessTarget: string | null;
  };
  pilotPhase: PilotPhase;
  checks: LiveCheckItem[];
  blockingReasons: string[];
  ownerNextCommands: string[];
}

export interface LiveCheckCommandOptions {
  routerTarget?: string | undefined;
  harnessTarget?: string | undefined;
  harnessConfigPath?: string | undefined;
  config?: string | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
  requireConsent?: boolean | undefined;
  json?: boolean | undefined;
  /** Programmatic test seams (never mutate live files) */
  homeDir?: string | undefined;
  repoRoot?: string | undefined;
  nowMs?: number | undefined;
  silent?: boolean | undefined;
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Buffer(fs.readFileSync(filePath));
}

function resolveReadOnlyConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(expandTilde(explicitPath.trim()));
  }
  if (process.env['ROUTERSYNC_CONFIG']) {
    return path.resolve(expandTilde(process.env['ROUTERSYNC_CONFIG']));
  }
  const localYaml = path.resolve('routersync.yaml');
  if (fs.existsSync(localYaml)) {
    return localYaml;
  }
  const localConfigYaml = path.resolve('config.yaml');
  if (fs.existsSync(localConfigYaml)) {
    return localConfigYaml;
  }
  return getDefaultConfigPath();
}

function parseIntervalMinutes(config: RouterSyncConfig, rawText: string): number {
  if (config.schedule?.intervalMinutes) {
    return config.schedule.intervalMinutes;
  }
  const syncStr = config.policy?.schedule?.sync ?? '';
  const m =
    syncStr.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i) ??
    rawText.match(/\bsync\s*:\s*['"]?every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (m?.[1] && m[2]) {
    const num = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (Number.isFinite(num) && num >= 1) {
      if (unit.startsWith('d')) return num * 1440;
      if (unit.startsWith('h')) return num * 60;
      return num;
    }
  }
  return 15;
}

function resolveReadOnlyHomeDir(
  options: LiveCheckCommandOptions,
  resolvedConfigPath: string
): string | undefined {
  if (options.homeDir && options.homeDir.trim().length > 0) {
    return path.resolve(expandTilde(options.homeDir.trim()));
  }
  const explicitConfigArg = options.configPath ?? options.config;
  const explicitSandboxCandidates = [
    explicitConfigArg ? resolvedConfigPath : undefined,
    options.harnessConfigPath ? path.resolve(expandTilde(options.harnessConfigPath.trim())) : undefined,
    options.stateDir ? path.resolve(expandTilde(options.stateDir.trim())) : undefined,
  ].filter((p): p is string => Boolean(p));

  if (
    explicitSandboxCandidates.length > 0 &&
    explicitSandboxCandidates.every((p) => !isInsideRealHomeOutsideSandbox(p))
  ) {
    return undefined;
  }
  return os.homedir();
}

function detectCircularConfigIssues(
  config: RouterSyncConfig,
  homeDir: string | undefined,
  explicitHarnessConfigPath?: string
): string[] {
  const issues: string[] = [];

  // 1. Check self-referencing combos in routersync.yaml
  const comboNames = new Set(config.combos.map((c) => c.name));
  for (const combo of config.combos) {
    for (const pinned of combo.pin ?? []) {
      if (pinned === combo.name || pinned === `combo:${combo.name}`) {
        issues.push(`Combo '${combo.name}' contains a circular self-reference in pin ('${pinned}').`);
      } else if (comboNames.has(pinned)) {
        const other = config.combos.find((c) => c.name === pinned);
        if (other?.pin?.includes(combo.name)) {
          issues.push(`Circular combo dependency detected between '${combo.name}' and '${pinned}'.`);
        }
      }
    }
  }

  // 2. Check harness circular dependency against managed routers (excluding test discard port :9)
  const harnessFiles: Array<{ label: string; filePath: string }> = [];
  if (homeDir) {
    harnessFiles.push(
      { label: 'hermes', filePath: path.join(homeDir, '.hermes', 'config.json') },
      { label: 'dsh', filePath: path.join(homeDir, '.dsh', 'config.yml') }
    );
  }
  if (explicitHarnessConfigPath && explicitHarnessConfigPath.trim().length > 0) {
    const resolvedExplicit = path.resolve(expandTilde(explicitHarnessConfigPath.trim()));
    if (!harnessFiles.some((h) => h.filePath === resolvedExplicit)) {
      harnessFiles.push({ label: 'pilot-harness', filePath: resolvedExplicit });
    }
  }

  for (const r of config.routers) {
    const rawUrl =
      r.baseUrl ?? (r.adapter === 'omniroute' ? 'http://localhost:30128' : 'http://localhost:20128');
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      parsedUrl = null;
    }
    if (!parsedUrl || parsedUrl.port === '9') {
      continue;
    }

    for (const h of harnessFiles) {
      if (!fs.existsSync(h.filePath)) continue;
      try {
        const content = fs.readFileSync(h.filePath, 'utf8');
        if (content.includes(rawUrl) || (parsedUrl.port && content.includes(`:${parsedUrl.port}`))) {
          issues.push(
            `Circular dependency: harness '${h.label}' (${h.filePath}) points to managed router '${r.id}' (${rawUrl}).`
          );
        }
      } catch {
        // Ignore unreadable probe file
      }
    }
  }

  return issues;
}

function assertNotForbiddenAppManagedFile(filePath: string): void {
  assertOpenMausBotSafeFile(filePath);
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  const realBase = path.basename(resolveDeepRealPath(filePath)).toLowerCase();
  if (
    base === 'routines.json' ||
    base === 'bots.json' ||
    realBase === 'routines.json' ||
    realBase === 'bots.json' ||
    normalized.endsWith('/openmausbot/routines.json') ||
    normalized.endsWith('/openmausbot/bots.json')
  ) {
    throw new Error(
      `Forbidden harness target file '${path.basename(filePath)}': OpenMausBot routines.json and bots.json belong to the running app and must never be targeted; use config.json instead.`
    );
  }
}

function resolveDefaultHarnessModelsPath(
  cap: HarnessCapability,
  homeDir: string | undefined
): string {
  if (!homeDir) {
    return '';
  }
  const platformKey: 'win32' | 'darwin' | 'linux' =
    process.platform === 'win32'
      ? 'win32'
      : process.platform === 'darwin'
        ? 'darwin'
        : 'linux';
  const patterns =
    cap.modelsConfig.paths[platformKey]?.length > 0
      ? cap.modelsConfig.paths[platformKey]
      : cap.mcp.paths[platformKey] ?? [];
  if (patterns.length === 0) {
    return '';
  }
  const expanded = patterns.map((p) =>
    expandHarnessPathPattern(p, { homeDir, platform: process.platform })
  );
  for (const candidate of expanded) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return expanded[0] ?? '';
}

function discoverMonorepoRoot(explicitRepoRoot?: string): string | null {
  const startDirs = [
    ...(explicitRepoRoot ? [path.resolve(explicitRepoRoot)] : []),
    process.cwd(),
    __dirname,
  ];
  for (const start of startDirs) {
    let cur = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      const wsYaml = path.join(cur, 'pnpm-workspace.yaml');
      const relScript = path.join(cur, 'tools', 'release', 'prepare-v1-release.mjs');
      if (fs.existsSync(wsYaml) && fs.existsSync(relScript)) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

interface PrepareV1ReleaseResultShape {
  mode: string;
  target: string;
  distTag: string;
  totalManifests: number;
  publishableCount: number;
  privateCount: number;
  entries: Array<{
    relPath: string;
    name: string;
    publishable: boolean;
    private: boolean;
    previousVersion: string;
    targetVersion: string;
    written: boolean;
  }>;
}

async function verifyReleaseManifestHygieneReadOnly(explicitRepoRoot?: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const repoRoot = discoverMonorepoRoot(explicitRepoRoot);
  if (repoRoot) {
    const helperPath = path.join(repoRoot, 'tools', 'release', 'prepare-v1-release.mjs');
    const mod = (await import(pathToFileURL(helperPath).href)) as {
      prepareV1Release: (opts: {
        target: string;
        write: boolean;
        root: string;
      }) => PrepareV1ReleaseResultShape;
    };
    const res = mod.prepareV1Release({
      target: '1.0.0',
      write: false,
      root: repoRoot,
    });

    if (res.mode !== 'dry-run' || res.entries.some((e) => e.written)) {
      return {
        ok: false,
        detail: 'prepareV1Release violated read-only dry-run invariant.',
      };
    }
    if (res.publishableCount !== 8 || res.privateCount !== 2 || res.totalManifests !== 10) {
      return {
        ok: false,
        detail: `Workspace manifest count mismatch: expected 8 publishable + 2 private (10 total), got ${res.publishableCount} publishable + ${res.privateCount} private (${res.totalManifests} total).`,
      };
    }
    const versions = new Set(res.entries.map((e) => e.previousVersion).filter(Boolean));
    if (versions.size !== 1) {
      return {
        ok: false,
        detail: `Inconsistent workspace manifest versions detected across 10 packages: [${[...versions].join(', ')}].`,
      };
    }
    const currentVer = [...versions][0]!;
    return {
      ok: true,
      detail: `8 publishable + 2 private manifests consistent at version ${currentVer} (prepareV1Release dry-run verified).`,
    };
  }

  // Standalone packaged CLI fallback (outside monorepo checkout)
  try {
    const cliPkgUrl = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(cliPkgUrl, 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (parsed.name === '@routersync/cli' && typeof parsed.version === 'string' && parsed.version) {
      return {
        ok: true,
        detail: `Packaged @routersync/cli manifest verified at version ${parsed.version}.`,
      };
    }
  } catch {
    // fall through
  }
  return {
    ok: false,
    detail: 'Unable to verify @routersync/cli release manifest metadata.',
  };
}

function validateLegacyAliasConsentIfPresent(stateDir: string): { valid: boolean; reason?: string } {
  const legacyConsentPath = path.join(stateDir, 'consent.json');
  if (!fs.existsSync(legacyConsentPath)) {
    return { valid: true };
  }
  const signingKey = readConsentSigningKeyIfPresent(stateDir);
  if (!signingKey) {
    return {
      valid: false,
      reason: 'consent.json is present without a valid consent-signing.key (CONSENT_HMAC_INVALID).',
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyConsentPath, 'utf8')) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed['version'] !== 1 ||
      typeof parsed['policyId'] !== 'string' ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Array.isArray(parsed['targets']) ||
      typeof parsed['hmacSha256'] !== 'string'
    ) {
      return {
        valid: false,
        reason: 'consent.json failed schema integrity verification (CONSENT_SCHEMA_INVALID).',
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
        reason: 'consent.json failed HMAC-SHA256 verification (CONSENT_HMAC_INVALID).',
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      reason: 'consent.json contains malformed JSON (CONSENT_SCHEMA_INVALID).',
    };
  }
}

export async function runLiveCheckCommand(
  options: LiveCheckCommandOptions = {}
): Promise<LiveCheckReport> {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const resolvedConfigPath = resolveReadOnlyConfigPath(options.configPath ?? options.config);
  const homeDir = resolveReadOnlyHomeDir(options, resolvedConfigPath);
  const stateDir = resolveControlStateDir(options.stateDir);
  const checks: LiveCheckItem[] = [];
  const blockingReasons: string[] = [];

  // -------------------------------------------------------------------------
  // Check 1: freeze_clear
  // -------------------------------------------------------------------------
  const freezeState = readFreezeState(stateDir);
  if (freezeState.frozen) {
    const isCorrupt = freezeState.reason === 'corrupt-freeze-file-fail-closed';
    const detail = isCorrupt
      ? 'Emergency freeze file (<stateDir>/freeze.json) is corrupted; failing closed.'
      : `Emergency freeze circuit breaker is active (reason: ${freezeState.reason ?? 'frozen'}).`;
    checks.push({
      id: 'freeze_clear',
      passed: false,
      detail,
      remediationCommand: 'routersync unfreeze',
    });
    blockingReasons.push(detail);
  } else {
    checks.push({
      id: 'freeze_clear',
      passed: true,
      detail: 'Emergency freeze circuit breaker is clear (frozen=false).',
    });
  }

  // -------------------------------------------------------------------------
  // Check 2: config_and_doctor_health
  // -------------------------------------------------------------------------
  let validConfig: RouterSyncConfig | null = null;
  let configDir: string | undefined;

  if (!fs.existsSync(resolvedConfigPath)) {
    const detail = `Configuration file not found at ${resolvedConfigPath}.`;
    checks.push({
      id: 'config_and_doctor_health',
      passed: false,
      detail,
      remediationCommand: 'routersync init',
    });
    blockingReasons.push(detail);
  } else {
    try {
      const rawYaml = fs.readFileSync(resolvedConfigPath, 'utf8');
      const parsedYaml = parseYaml(rawYaml);
      const schemaRes = RouterSyncConfigSchema.safeParse(parsedYaml);
      if (!schemaRes.success) {
        const firstIssue = schemaRes.error.issues[0];
        const detail = `Invalid routersync.yaml (${firstIssue?.path.join('.') || 'root'}: ${firstIssue?.message ?? 'schema error'}).`;
        checks.push({
          id: 'config_and_doctor_health',
          passed: false,
          detail,
          remediationCommand: 'routersync doctor --json',
        });
        blockingReasons.push(detail);
      } else {
        validConfig = schemaRes.data;
        configDir = path.dirname(resolvedConfigPath);
        const circularIssues = detectCircularConfigIssues(validConfig, homeDir, options.harnessConfigPath);
        if (circularIssues.length > 0) {
          const detail = circularIssues.join(' ');
          checks.push({
            id: 'config_and_doctor_health',
            passed: false,
            detail,
            remediationCommand: 'routersync doctor --json',
          });
          blockingReasons.push(detail);
        } else {
          const intervalMinutes = parseIntervalMinutes(validConfig, rawYaml);
          const maxFreshAgeMs = 2 * intervalMinutes * 60_000;
          const statusPath = path.join(stateDir, 'status.json');
          if (!fs.existsSync(statusPath)) {
            const detail = `Missing <stateDir>/status.json in ${stateDir}; recurring tick freshness cannot be verified.`;
            checks.push({
              id: 'config_and_doctor_health',
              passed: false,
              detail,
              remediationCommand: 'routersync tick --mode observe',
            });
            blockingReasons.push(detail);
          } else {
            let statusTsMs = Number.NaN;
            try {
              const rawStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<
                string,
                unknown
              >;
              const ts = rawStatus['timestamp'] ?? rawStatus['generatedAt'];
              if (typeof ts === 'string' && ts.trim().length > 0) {
                statusTsMs = Date.parse(ts.trim());
              }
            } catch {
              statusTsMs = Number.NaN;
            }

            if (!Number.isFinite(statusTsMs)) {
              const detail = '<stateDir>/status.json is unreadable or missing a valid timestamp.';
              checks.push({
                id: 'config_and_doctor_health',
                passed: false,
                detail,
                remediationCommand: 'routersync tick --mode observe',
              });
              blockingReasons.push(detail);
            } else {
              const ageMs = Math.max(0, nowMs - statusTsMs);
              if (ageMs > maxFreshAgeMs) {
                const ageMin = Math.floor(ageMs / 60_000);
                const thresholdMin = 2 * intervalMinutes;
                const detail = `Stale tick warning (staleTickWarning=true): last tick is ${ageMin}m old (> 2x interval threshold of ${thresholdMin}m).`;
                checks.push({
                  id: 'config_and_doctor_health',
                  passed: false,
                  detail,
                  remediationCommand: 'routersync tick --mode propose',
                });
                blockingReasons.push(detail);
              } else {
                const ageMin = Math.floor(ageMs / 60_000);
                checks.push({
                  id: 'config_and_doctor_health',
                  passed: true,
                  detail: `Config schema valid, 0 circular dependencies, status.json fresh (${ageMin}m <= ${2 * intervalMinutes}m threshold).`,
                });
              }
            }
          }
        }
      }
    } catch (err) {
      const detail = `Failed to parse configuration at ${resolvedConfigPath}: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({
        id: 'config_and_doctor_health',
        passed: false,
        detail,
        remediationCommand: 'routersync doctor --json',
      });
      blockingReasons.push(detail);
    }
  }

  // -------------------------------------------------------------------------
  // Check 3: pilot_targets_readable
  // -------------------------------------------------------------------------
  let resolvedRouterTarget: string | null = null;
  let resolvedHarnessTarget: string | null = null;
  let matchedRouterConfig: RouterConfig | null = null;
  let pilotComboName: string | null = null;
  let resolvedRouterDbPath: string | null = null;
  let matchedHarnessCap: HarnessCapability | null = null;
  let resolvedHarnessConfigFile: string | null = null;

  const targetErrors: string[] = [];

  // 3a. Router pilot target (`Hướng B`)
  const rawRouterTargetInput = options.routerTarget?.trim();
  if (rawRouterTargetInput) {
    try {
      const parsed = parseTargetScope(rawRouterTargetInput);
      if (parsed.targetKind !== 'router' || !parsed.routerId || !parsed.comboName) {
        targetErrors.push(
          `Expected --router-target in 'router:<routerId>/<comboName>' format (got '${rawRouterTargetInput}').`
        );
      } else {
        resolvedRouterTarget = parsed.target;
        pilotComboName = parsed.comboName;
        if (validConfig) {
          matchedRouterConfig =
            validConfig.routers.find(
              (r) => r.id === parsed.routerId || r.adapter === parsed.routerId
            ) ?? null;
          if (!matchedRouterConfig) {
            targetErrors.push(
              `Router '${parsed.routerId}' from '${parsed.target}' is not declared in routersync.yaml.`
            );
          }
        }
      }
    } catch (err) {
      targetErrors.push(err instanceof Error ? err.message : String(err));
    }
  } else if (validConfig) {
    if (validConfig.combos.length === 1 && validConfig.combos[0]!.routers.length === 1) {
      const singleCombo = validConfig.combos[0]!;
      const rId = singleCombo.routers[0]!;
      resolvedRouterTarget = `router:${rId}/${singleCombo.name}`;
      pilotComboName = singleCombo.name;
      matchedRouterConfig =
        validConfig.routers.find((r) => r.id === rId || r.adapter === rId) ?? null;
      if (!matchedRouterConfig) {
        targetErrors.push(`Router '${rId}' referenced by combo '${singleCombo.name}' is missing in routersync.yaml.`);
      }
    } else if (validConfig.adopt.length === 1) {
      const singleAdopt = validConfig.adopt[0]!;
      resolvedRouterTarget = `router:${singleAdopt.router}/${singleAdopt.name}`;
      pilotComboName = singleAdopt.name;
      matchedRouterConfig =
        validConfig.routers.find(
          (r) => r.id === singleAdopt.router || r.adapter === singleAdopt.router
        ) ?? null;
      if (!matchedRouterConfig) {
        targetErrors.push(`Router '${singleAdopt.router}' referenced by adopt '${singleAdopt.name}' is missing in routersync.yaml.`);
      }
    } else {
      targetErrors.push(
        'Pass explicit --router-target router:<routerId>/<comboName> to select 1 pilot router combo.'
      );
    }
  } else {
    targetErrors.push('Cannot resolve --router-target without a valid routersync.yaml.');
  }

  if (matchedRouterConfig) {
    try {
      const candidateDb = resolveRouterDbPath(matchedRouterConfig, configDir);
      if (!fs.existsSync(candidateDb) || !fs.statSync(candidateDb).isFile()) {
        targetErrors.push(`Pilot router DB file does not exist: ${candidateDb}`);
      } else {
        fs.accessSync(candidateDb, fs.constants.R_OK);
        resolvedRouterDbPath = candidateDb;
      }
    } catch (err) {
      targetErrors.push(
        `Pilot router DB is not readable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 3b. Harness pilot target (`Hướng A`)
  const matrix = loadHarnessMatrix();
  const rawHarnessTargetInput = options.harnessTarget?.trim();
  if (!rawHarnessTargetInput) {
    targetErrors.push(
      'Pass explicit --harness-target harness:<id> to select 1 Tier-A writable harness target.'
    );
  } else {
    try {
      const parsed = parseTargetScope(rawHarnessTargetInput);
      if (parsed.targetKind !== 'harness' || !parsed.harnessId) {
        targetErrors.push(
          `Expected --harness-target in 'harness:<id>' format (got '${rawHarnessTargetInput}').`
        );
      } else {
        const cap =
          matrix.harnesses.find((h) => h.id === parsed.harnessId) ??
          getHarnessCapability(parsed.harnessId);
        if (!cap || cap.directionAMode !== 'write-adapter') {
          targetErrors.push(
            `Harness '${parsed.harnessId}' does not support Tier-A lossless write-adapter mode.`
          );
        } else {
          resolvedHarnessTarget = parsed.target;
          matchedHarnessCap = cap;
        }
      }
    } catch (err) {
      targetErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (options.harnessConfigPath && options.harnessConfigPath.trim().length > 0) {
    const candidateCfg = path.resolve(expandTilde(options.harnessConfigPath.trim()));
    try {
      assertNotForbiddenAppManagedFile(candidateCfg);
      if (!fs.existsSync(candidateCfg) || !fs.statSync(candidateCfg).isFile()) {
        targetErrors.push(`Pilot harness config file does not exist: ${candidateCfg}`);
      } else {
        fs.accessSync(candidateCfg, fs.constants.R_OK);
        resolvedHarnessConfigFile = candidateCfg;
      }
    } catch (err) {
      targetErrors.push(err instanceof Error ? err.message : String(err));
    }
  } else if (matchedHarnessCap) {
    const candidateCfg = resolveDefaultHarnessModelsPath(matchedHarnessCap, homeDir);
    try {
      if (!candidateCfg) {
        targetErrors.push(
          `Could not resolve default config path for '${matchedHarnessCap.id}'; pass --harness-config-path <path>.`
        );
      } else {
        assertNotForbiddenAppManagedFile(candidateCfg);
        if (!fs.existsSync(candidateCfg) || !fs.statSync(candidateCfg).isFile()) {
          targetErrors.push(`Pilot harness config file does not exist: ${candidateCfg}`);
        } else {
          fs.accessSync(candidateCfg, fs.constants.R_OK);
          resolvedHarnessConfigFile = candidateCfg;
        }
      }
    } catch (err) {
      targetErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (
    targetErrors.length > 0 ||
    !resolvedRouterTarget ||
    !resolvedHarnessTarget ||
    !resolvedRouterDbPath ||
    !resolvedHarnessConfigFile ||
    !matchedHarnessCap
  ) {
    const detail = targetErrors.join(' ');
    checks.push({
      id: 'pilot_targets_readable',
      passed: false,
      detail,
      remediationCommand:
        'routersync live-check --router-target router:<id>/<combo> --harness-target harness:<id> --harness-config-path <path>',
    });
    blockingReasons.push(detail);
  } else {
    checks.push({
      id: 'pilot_targets_readable',
      passed: true,
      detail: `Pilot targets readable: ${resolvedRouterTarget} (${path.basename(resolvedRouterDbPath)}) + ${resolvedHarnessTarget} (${path.basename(resolvedHarnessConfigFile)}).`,
    });
  }

  // -------------------------------------------------------------------------
  // Check 4: tmpdir_backup_rollback_rehearsal
  // -------------------------------------------------------------------------
  if (!resolvedRouterDbPath || !resolvedHarnessConfigFile || !matchedHarnessCap) {
    const detail = 'Skipped ephemeral os.tmpdir() backup/rollback rehearsal because pilot target files are not readable.';
    checks.push({
      id: 'tmpdir_backup_rollback_rehearsal',
      passed: false,
      detail,
      remediationCommand: 'routersync doctor --json',
    });
    blockingReasons.push(detail);
  } else {
    const realRouterShaBefore = sha256File(resolvedRouterDbPath);
    const realHarnessShaBefore = sha256File(resolvedHarnessConfigFile);
    const tmpRehearsalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-livecheck-'));
    const tmpDirLabel = path.basename(tmpRehearsalDir);

    try {
      // 4a. Ephemeral Router DB copy backup + parse/mutation + byte-exact restore
      const routerExt = path.extname(resolvedRouterDbPath) || '.sqlite';
      const tmpRouterCopy = path.join(tmpRehearsalDir, `router-rehearsal${routerExt}`);
      const tmpRouterBackup = `${tmpRouterCopy}.bak`;
      fs.copyFileSync(resolvedRouterDbPath, tmpRouterCopy);
      const origRouterTempSha = sha256File(tmpRouterCopy);
      fs.copyFileSync(tmpRouterCopy, tmpRouterBackup);

      const headerBuf = fs.readFileSync(tmpRouterCopy);
      const isSqlite =
        headerBuf.length >= 16 &&
        headerBuf.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000';

      const comboDeclaredInYaml = Boolean(
        pilotComboName &&
          validConfig &&
          (validConfig.combos.some((c) => c.name === pilotComboName) ||
            validConfig.adopt.some((a) => a.name === pilotComboName))
      );

      if (isSqlite) {
        const db = openBetterSqlite3(tmpRouterCopy, { restrictToDir: tmpRehearsalDir });
        try {
          const tbl = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'combos'")
            .get() as { name?: string } | undefined;
          if (!tbl?.name) {
            throw new Error("Router SQLite database is missing required 'combos' table.");
          }
          const rows = db.prepare('SELECT * FROM combos').all() as Array<Record<string, unknown>>;
          const dbHasCombo = pilotComboName
            ? rows.some((r) => r['name'] === pilotComboName)
            : rows.length > 0;
          if (pilotComboName && !dbHasCombo && !comboDeclaredInYaml) {
            throw new Error(
              `Pilot combo '${pilotComboName}' was not found in router DB combos table or routersync.yaml.`
            );
          }
          db.exec('CREATE TABLE IF NOT EXISTS __rs_livecheck_probe (id INTEGER PRIMARY KEY)');
          db.prepare('INSERT INTO __rs_livecheck_probe (id) VALUES (1)').run();
        } finally {
          db.close();
        }

        // Remove any SQLite journal sidecars inside tmpdir and restore exact pre-rehearsal backup bytes
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const sidecar = `${tmpRouterCopy}${suffix}`;
          if (fs.existsSync(sidecar)) {
            fs.rmSync(sidecar, { force: true });
          }
        }
        fs.copyFileSync(tmpRouterBackup, tmpRouterCopy);
      } else {
        const rawJsonText = headerBuf.toString('utf8');
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawJsonText);
        } catch {
          throw new Error(
            'Unsupported or corrupted router DB file (expected SQLite format 3 or valid JSON object).'
          );
        }
        if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
          throw new Error('Router JSON DB root must be a JSON object.');
        }
        const rec = parsedJson as Record<string, unknown>;
        const combosList = Array.isArray(rec['combos'])
          ? (rec['combos'] as Array<Record<string, unknown>>)
          : [];
        const jsonHasCombo = pilotComboName
          ? combosList.some((c) => c && c['name'] === pilotComboName)
          : true;
        if (pilotComboName && !jsonHasCombo && !comboDeclaredInYaml) {
          throw new Error(
            `Pilot combo '${pilotComboName}' was not found in router JSON DB or routersync.yaml.`
          );
        }
        fs.writeFileSync(
          tmpRouterCopy,
          `${JSON.stringify({ ...rec, __rsLiveCheckRehearsal: true }, null, 2)}\n`,
          'utf8'
        );
        fs.copyFileSync(tmpRouterBackup, tmpRouterCopy);
      }

      const restoredRouterTempSha = sha256File(tmpRouterCopy);
      if (restoredRouterTempSha !== origRouterTempSha) {
        throw new Error(
          `Router temp rollback SHA-256 mismatch (${restoredRouterTempSha} !== ${origRouterTempSha}).`
        );
      }

      // 4b. Ephemeral Harness Config copy backup + lossless parser/apply + byte-exact rollback
      const tmpHarnessSubdir = path.join(tmpRehearsalDir, 'harness');
      const tmpFakeHome = path.join(tmpRehearsalDir, 'fake-home');
      fs.mkdirSync(tmpHarnessSubdir, { recursive: true });
      fs.mkdirSync(tmpFakeHome, { recursive: true });

      const tmpHarnessCopy = path.join(
        tmpHarnessSubdir,
        path.basename(resolvedHarnessConfigFile)
      );
      const tmpHarnessBackup = `${tmpHarnessCopy}.routersync.bak`;
      fs.copyFileSync(resolvedHarnessConfigFile, tmpHarnessCopy);
      const origHarnessTempSha = sha256File(tmpHarnessCopy);

      const writeAdapter = getHarnessWriteAdapter(matchedHarnessCap.id);
      if (!writeAdapter || writeAdapter.directionAMode !== 'write-adapter') {
        throw new Error(
          `Missing lossless write adapter for harness '${matchedHarnessCap.id}'.`
        );
      }

      await writeAdapter.apply({
        configPath: tmpHarnessCopy,
        backupPath: tmpHarnessBackup,
        homeDir: tmpFakeHome,
        catalog: {},
        processRunner: () => [],
      });

      const rollbackRes = await writeAdapter.rollback({
        configPath: tmpHarnessCopy,
        backupPath: tmpHarnessBackup,
        expectedPreSha256: origHarnessTempSha,
      });

      const restoredHarnessTempSha = sha256File(tmpHarnessCopy);
      if (
        !rollbackRes.restored ||
        !rollbackRes.byteIdenticalToPreApply ||
        restoredHarnessTempSha !== origHarnessTempSha
      ) {
        throw new Error(
          `Harness temp rollback SHA-256 mismatch (${restoredHarnessTempSha} !== ${origHarnessTempSha}).`
        );
      }

      // Verify real live files stayed 100% untouched byte-for-byte
      const realRouterShaAfter = sha256File(resolvedRouterDbPath);
      const realHarnessShaAfter = sha256File(resolvedHarnessConfigFile);
      if (
        realRouterShaAfter !== realRouterShaBefore ||
        realHarnessShaAfter !== realHarnessShaBefore
      ) {
        throw new Error('Source pilot target SHA-256 unexpectedly changed during rehearsal.');
      }

      checks.push({
        id: 'tmpdir_backup_rollback_rehearsal',
        passed: true,
        detail: `Isolated backup + parser + byte-exact SHA-256 rollback rehearsal passed in os.tmpdir()/${tmpDirLabel} (0 live mutations).`,
      });
    } catch (err) {
      const detail = `Ephemeral tmpdir rehearsal failed in os.tmpdir()/${tmpDirLabel}: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({
        id: 'tmpdir_backup_rollback_rehearsal',
        passed: false,
        detail,
        remediationCommand: 'routersync apps inspect --json',
      });
      blockingReasons.push(detail);
    } finally {
      fs.rmSync(tmpRehearsalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  // -------------------------------------------------------------------------
  // Check 5: consent_and_promotion_state
  // -------------------------------------------------------------------------
  let pilotPhase: PilotPhase = 'NEEDS_INITIAL_PROPOSE_CONSENT';
  const standingConsent = readStandingConsent(stateDir, nowMs);
  const applyHistory = readApplyHistory(stateDir);
  const legacyAliasCheck = validateLegacyAliasConsentIfPresent(stateDir);

  if (!standingConsent.valid) {
    const code = standingConsent.errorCode ?? 'CONSENT_HMAC_INVALID';
    const detail = `Standing consent policy (<stateDir>/standing-consent.json) failed integrity verification (${code}).`;
    checks.push({
      id: 'consent_and_promotion_state',
      passed: false,
      detail,
      remediationCommand: 'routersync consent revoke --all',
    });
    blockingReasons.push(detail);
  } else if (!legacyAliasCheck.valid) {
    const detail = legacyAliasCheck.reason ?? 'Consent file failed HMAC integrity verification.';
    checks.push({
      id: 'consent_and_promotion_state',
      passed: false,
      detail,
      remediationCommand: 'routersync consent revoke --all',
    });
    blockingReasons.push(detail);
  } else if (!applyHistory.valid) {
    const code = applyHistory.errorCode ?? 'CONSENT_HMAC_INVALID';
    const detail = `Apply history ledger (<stateDir>/apply-history.json) failed integrity verification (${code}).`;
    checks.push({
      id: 'consent_and_promotion_state',
      passed: false,
      detail,
      remediationCommand: 'routersync consent status --json',
    });
    blockingReasons.push(detail);
  } else {
    const routerAliases = new Set<string>();
    if (resolvedRouterTarget) {
      routerAliases.add(resolvedRouterTarget);
    }
    if (matchedRouterConfig && pilotComboName) {
      routerAliases.add(`router:${matchedRouterConfig.id}/${pilotComboName}`);
      routerAliases.add(`router:${matchedRouterConfig.adapter}/${pilotComboName}`);
    }

    const activeRouterEntry: StandingConsentEntryView | undefined = standingConsent.targets.find(
      (t) =>
        routerAliases.has(t.target) &&
        !t.expired &&
        (t.level === 'propose' || t.level === 'auto-safe')
    );
    const activeHarnessEntry: StandingConsentEntryView | undefined = resolvedHarnessTarget
      ? standingConsent.targets.find(
          (t) =>
            t.target === resolvedHarnessTarget &&
            !t.expired &&
            (t.level === 'propose' || t.level === 'auto-safe')
        )
      : undefined;

    const routerReceipt = [...routerAliases]
      .map((alias) => findVerifiedProposeReceipt(stateDir, alias))
      .find((r) => r !== null) ?? null;
    const harnessReceipt = resolvedHarnessTarget
      ? findVerifiedProposeReceipt(stateDir, resolvedHarnessTarget)
      : null;

    const illegalAutoSafeWithoutReceipt =
      (activeRouterEntry?.level === 'auto-safe' && !routerReceipt) ||
      (activeHarnessEntry?.level === 'auto-safe' && !harnessReceipt);

    if (illegalAutoSafeWithoutReceipt) {
      const detail =
        'AUTO_SAFE_RECEIPT_MISSING: active auto-safe consent exists without a verified zero-rollback propose receipt in apply-history.json.';
      checks.push({
        id: 'consent_and_promotion_state',
        passed: false,
        detail,
        remediationCommand: `routersync consent grant --target ${resolvedRouterTarget ?? 'router:<id>/<combo>'} --level propose`,
      });
      blockingReasons.push(detail);
    } else {
      if (
        activeRouterEntry?.level === 'auto-safe' &&
        activeHarnessEntry?.level === 'auto-safe' &&
        routerReceipt &&
        harnessReceipt
      ) {
        pilotPhase = 'AUTO_SAFE_ACTIVE';
      } else if (activeRouterEntry && activeHarnessEntry && routerReceipt && harnessReceipt) {
        pilotPhase = 'READY_FOR_AUTO_SAFE_PROMOTION';
      } else if (activeRouterEntry && activeHarnessEntry) {
        pilotPhase = 'READY_FOR_PROPOSE_STEP';
      } else {
        pilotPhase = 'NEEDS_INITIAL_PROPOSE_CONSENT';
      }

      if (options.requireConsent && pilotPhase === 'NEEDS_INITIAL_PROPOSE_CONSENT') {
        const detail =
          'Active standing consent is required (--require-consent), but one or both pilot targets lack active propose/auto-safe consent.';
        checks.push({
          id: 'consent_and_promotion_state',
          passed: false,
          detail,
          remediationCommand: `routersync consent grant --target ${resolvedRouterTarget ?? 'router:<id>/<combo>'} --level propose`,
        });
        blockingReasons.push(detail);
      } else {
        checks.push({
          id: 'consent_and_promotion_state',
          passed: true,
          detail: `Consent & apply-history HMAC integrity verified (pilotPhase=${pilotPhase}).`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Check 6: cost_and_release_hygiene
  // -------------------------------------------------------------------------
  const costErrors: string[] = [];
  const ledgerPath = path.join(stateDir, 'cost-ledger.json');
  let tier0Tokens = 0;
  let tier0LlmCalls = 0;
  let tier0PaidRequests = 0;
  let explicitBudgetExceeded = false;

  if (fs.existsSync(ledgerPath)) {
    try {
      const rawLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>;
      if (!rawLedger || typeof rawLedger !== 'object' || Array.isArray(rawLedger)) {
        costErrors.push('<stateDir>/cost-ledger.json root must be a JSON object.');
      } else {
        if (typeof rawLedger['tier0Tokens'] === 'number') {
          tier0Tokens += rawLedger['tier0Tokens'];
        }
        if (typeof rawLedger['tier0LlmCalls'] === 'number') {
          tier0LlmCalls += rawLedger['tier0LlmCalls'];
        }
        if (typeof rawLedger['tier0PaidRequests'] === 'number') {
          tier0PaidRequests += rawLedger['tier0PaidRequests'];
        }
        if (rawLedger['budgetExceeded'] === true) {
          explicitBudgetExceeded = true;
        }
        if (Array.isArray(rawLedger['ticks'])) {
          for (const entry of rawLedger['ticks'] as Array<Record<string, unknown>>) {
            if (!entry || typeof entry !== 'object') continue;
            const tok = Number(entry['tokens'] ?? 0);
            const llm = Number(entry['llmCalls'] ?? 0);
            const paid = Number(entry['paidRequests'] ?? 0);
            tier0Tokens += Number.isFinite(tok) ? tok : 1;
            tier0LlmCalls += Number.isFinite(llm) ? llm : 1;
            tier0PaidRequests += Number.isFinite(paid) ? paid : 1;
          }
        }
      }
    } catch {
      costErrors.push('<stateDir>/cost-ledger.json contains malformed JSON.');
    }
  }

  const weeklyBudget = computeWeeklyResearchBudget(stateDir, {
    nowMs,
    maxWeeklyResearchSessions: validConfig?.research?.maxWeeklyResearchSessions,
  });
  const budgetExceeded = explicitBudgetExceeded || weeklyBudget.budgetExceeded;

  if (tier0Tokens !== 0 || tier0LlmCalls !== 0 || tier0PaidRequests !== 0) {
    costErrors.push(
      `Zero-token Tier-0 invariant violated in cost-ledger.json (tier0Tokens=${tier0Tokens}, tier0LlmCalls=${tier0LlmCalls}, tier0PaidRequests=${tier0PaidRequests}).`
    );
  }
  if (budgetExceeded) {
    costErrors.push(
      `Weekly Tier-1 research session budget exceeded (${weeklyBudget.usedSessions}/${weeklyBudget.maxWeeklyResearchSessions} sessions used in ${weeklyBudget.isoWeek}).`
    );
  }

  const releaseHygiene = await verifyReleaseManifestHygieneReadOnly(options.repoRoot);
  if (!releaseHygiene.ok) {
    costErrors.push(releaseHygiene.detail);
  }

  if (costErrors.length > 0) {
    const detail = costErrors.join(' ');
    checks.push({
      id: 'cost_and_release_hygiene',
      passed: false,
      detail,
      remediationCommand: 'node tools/release/prepare-v1-release.mjs --target 1.0.0 --dry-run',
    });
    blockingReasons.push(detail);
  } else {
    checks.push({
      id: 'cost_and_release_hygiene',
      passed: true,
      detail: `tier0Tokens=0, tier0LlmCalls=0, tier0PaidRequests=0, weeklySessions=${weeklyBudget.usedSessions}/${weeklyBudget.maxWeeklyResearchSessions} (budgetExceeded=false). ${releaseHygiene.detail}`,
    });
  }

  // -------------------------------------------------------------------------
  // Check 7: live_gate_hint (C46-F2 — read-only live write flag readiness hint)
  // -------------------------------------------------------------------------
  const deepTmpDir = resolveDeepCanonicalPath(os.tmpdir());
  const routerLiveFlagSet = process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] === '1';
  const homeLiveFlagSet = process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'] === '1';

  const missingLiveFlagCommands: string[] = [];
  const gateSegments: string[] = [];

  if (resolvedRouterDbPath) {
    const deepRouter = resolveDeepCanonicalPath(resolvedRouterDbPath);
    const routerInsideTmp = isPathInsideDir(deepRouter, deepTmpDir);
    if (routerInsideTmp) {
      gateSegments.push(
        `routerDb (${path.basename(resolvedRouterDbPath)}): trong os.tmpdir() — không cần cờ`
      );
    } else {
      const flagLabel = routerLiveFlagSet ? 'đã đặt' : 'chưa đặt';
      gateSegments.push(
        `routerDb (${path.basename(resolvedRouterDbPath)}): ngoài os.tmpdir() — cần ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1 (${flagLabel})`
      );
      if (!routerLiveFlagSet) {
        missingLiveFlagCommands.push('export ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1');
      }
    }
  } else {
    gateSegments.push(
      `routerDb: chưa xác định tệp mục tiêu (ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1: ${routerLiveFlagSet ? 'đã đặt' : 'chưa đặt'})`
    );
  }

  if (resolvedHarnessConfigFile) {
    const deepHarness = resolveDeepCanonicalPath(resolvedHarnessConfigFile);
    const harnessInsideTmp = isPathInsideDir(deepHarness, deepTmpDir);
    if (harnessInsideTmp) {
      gateSegments.push(
        `harnessConfig (${path.basename(resolvedHarnessConfigFile)}): trong os.tmpdir() — không cần cờ`
      );
    } else {
      const flagLabel = homeLiveFlagSet ? 'đã đặt' : 'chưa đặt';
      gateSegments.push(
        `harnessConfig (${path.basename(resolvedHarnessConfigFile)}): ngoài os.tmpdir() — cần ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1 (${flagLabel})`
      );
      if (!homeLiveFlagSet) {
        missingLiveFlagCommands.push('export ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1');
      }
    }
  } else {
    gateSegments.push(
      `harnessConfig: chưa xác định tệp mục tiêu (ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1: ${homeLiveFlagSet ? 'đã đặt' : 'chưa đặt'})`
    );
  }

  const gateHintTail =
    missingLiveFlagCommands.length > 0
      ? ` Trước Mục 3 (bước ghi thật), chủ dự án đặt trong phiên shell hiện tại: ${missingLiveFlagCommands.join(' && ')} (PowerShell: ${missingLiveFlagCommands
          .map((c) => c.replace(/^export\s+([A-Z0-9_]+)=1$/, '$$env:$1="1"'))
          .join('; ')}).`
      : '';

  checks.push({
    id: 'live_gate_hint',
    passed: true,
    detail: `${gateSegments.join('; ')}.${gateHintTail}`,
  });

  // -------------------------------------------------------------------------
  // Assemble deterministic LiveCheckReport
  // -------------------------------------------------------------------------
  const allPassed = checks.every((c) => c.passed) && blockingReasons.length === 0;
  const status: LiveCheckReport['status'] = allPassed
    ? 'READY_FOR_OWNER_LIVE_PILOT'
    : 'BLOCKED';
  const vietnameseGateStatus: LiveCheckReport['vietnameseGateStatus'] = allPassed
    ? 'sẵn sàng chạy thật'
    : 'chưa đủ điều kiện chạy thật';

  const rTarget = resolvedRouterTarget ?? 'router:<routerId>/<comboName>';
  const hTarget = resolvedHarnessTarget ?? 'harness:<id>';

  let ownerNextCommands: string[];
  if (!allPassed) {
    const seen = new Set<string>();
    ownerNextCommands = [];
    for (const c of checks) {
      if (!c.passed && c.remediationCommand && !seen.has(c.remediationCommand)) {
        seen.add(c.remediationCommand);
        ownerNextCommands.push(c.remediationCommand);
      }
    }
  } else if (pilotPhase === 'NEEDS_INITIAL_PROPOSE_CONSENT') {
    ownerNextCommands = [
      ...missingLiveFlagCommands,
      `routersync consent grant --target ${rTarget} --level propose`,
      `routersync consent grant --target ${hTarget} --level propose`,
      'routersync plan',
    ];
  } else if (pilotPhase === 'READY_FOR_PROPOSE_STEP') {
    ownerNextCommands = [
      ...missingLiveFlagCommands,
      'routersync plan',
      'routersync apply --write',
      `routersync apps apply --app ${matchedHarnessCap?.id ?? 'hermes'} -c "${resolvedHarnessConfigFile ?? '<path>'}" --write`,
    ];
  } else if (pilotPhase === 'READY_FOR_AUTO_SAFE_PROMOTION') {
    ownerNextCommands = [
      ...missingLiveFlagCommands,
      `routersync consent grant --target ${rTarget} --level auto-safe`,
      `routersync consent grant --target ${hTarget} --level auto-safe`,
      'routersync tick --mode auto-safe',
    ];
  } else {
    ownerNextCommands = [
      ...missingLiveFlagCommands,
      'routersync tick --mode auto-safe',
      'routersync freeze --reason "live-pilot-drill"',
      'routersync rollback',
    ];
  }

  const report: LiveCheckReport = {
    schemaVersion: 1,
    checkedAt,
    status,
    vietnameseGateStatus,
    pilotTargets: {
      routerTarget: resolvedRouterTarget,
      harnessTarget: resolvedHarnessTarget,
    },
    pilotPhase,
    checks,
    blockingReasons,
    ownerNextCommands,
  };

  if (!options.silent) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const lines: string[] = [
        `RouterSync Live Readiness Pre-Flight (${report.status} — ${report.vietnameseGateStatus})`,
        `  Router pilot target : ${report.pilotTargets.routerTarget ?? '—'}`,
        `  Harness pilot target: ${report.pilotTargets.harnessTarget ?? '—'}`,
        `  Pilot phase         : ${report.pilotPhase}`,
        '',
      ];
      for (const c of report.checks) {
        lines.push(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`);
        if (!c.passed && c.remediationCommand) {
          lines.push(`         Fix: ${c.remediationCommand}`);
        }
      }
      lines.push('');
      if (report.status === 'READY_FOR_OWNER_LIVE_PILOT') {
        lines.push(
          'HARD STOP FOR BOT TEAM: Trạng thái "sẵn sàng chạy thật" (READY_FOR_OWNER_LIVE_PILOT). Chỉ chủ dự án trực tiếp chạy docs/runbook/LIVE-E2E-v2.md.'
        );
      }
      if (report.ownerNextCommands.length > 0) {
        lines.push('Owner next commands:');
        for (const cmd of report.ownerNextCommands) {
          lines.push(`  ${cmd}`);
        }
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  }

  if (report.status !== 'READY_FOR_OWNER_LIVE_PILOT') {
    process.exitCode = 1;
  }

  return report;
}
