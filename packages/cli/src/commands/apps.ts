/**
 * packages/cli/src/commands/apps.ts
 *
 * `routersync apps inspect` — read-only view of an agent app's provider and
 * model configuration.
 *
 * C45-WP2 (`Phục vụ: S3`): adds `apps plan`, `apps apply`, and `apps rollback`
 * backed by `HarnessWriteAdapter` with strict sandbox-copy enforcement.
 *
 * C46-F3 (`Phục vụ: S9, I4, I5`): adds controlled `--write` mode on `apps apply`
 * (enforcing `--yes` rejection, `freeze` gate, `assertControlledWriteSandbox`,
 * `readStandingConsent`, `propose` interactive TTY `'chay'` confirmation,
 * `auto-safe` runtime receipt verification, and `appendApplyReceipt`),
 * optional `--catalog` fallback to `<stateDir>/tick-catalog.json`, and
 * receipt rollback marking in `apps rollback`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { maskHomePath } from '@routersync/adapter-sdk';
import type { AgentAppInspection, HarnessCatalogInput } from '@routersync/adapter-sdk';
import {
  ConsentValidationError,
  appendApplyReceipt,
  assertControlledWriteSandbox,
  canonicalizeResearchProvider,
  findVerifiedProposeReceipt,
  loadResearchEvidence,
  markApplyReceiptRolledBack,
  readApplyHistory,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
} from '@routersync/core';
import {
  AGENT_APP_ADAPTERS,
  AgentAppInspectError,
  getAgentAppAdapter,
} from '../apps/inspect.js';
import {
  assertOpenMausBotSafeFile,
  getHarnessWriteAdapter,
  listHarnessWriteAdapters,
  resolveEffectiveHarnessHomeDir,
} from '../apps/write-adapter.js';

export interface AppsInspectOptions {
  app?: string | undefined;
  home?: string | undefined;
  config?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsPlanCommandOptions {
  app: string;
  config?: string | undefined;
  catalog?: string | undefined;
  stateDir?: string | undefined;
  home?: string | undefined;
  json?: boolean | undefined;
}

export interface AppsApplyCommandOptions {
  app: string;
  config: string;
  catalog?: string | undefined;
  stateDir?: string | undefined;
  home?: string | undefined;
  sandboxCopy?: boolean | undefined;
  write?: boolean | undefined;
  yes?: boolean | undefined;
  planHash?: string | undefined;
  backup?: string | undefined;
  json?: boolean | undefined;
  /** Programmatic test seams (mirrors apply.ts / consent.ts / freeze.ts) */
  isTTY?: boolean | undefined;
  promptFn?: ((question: string) => Promise<string>) | undefined;
}

export interface AppsRollbackCommandOptions {
  app: string;
  config: string;
  backup?: string | undefined;
  expectedPreSha256?: string | undefined;
  stateDir?: string | undefined;
  write?: boolean | undefined;
  json?: boolean | undefined;
}

function statusLabel(enabled: AgentAppInspection['models'][number]['enabled']): string {
  if (enabled === true) return 'bật';
  if (enabled === false) return 'tắt';
  return 'UNKNOWN';
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(rows: string[][]): string {
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
  }
  return rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

function askAppsConfirmation(
  promptText: string,
  expectedWord = 'chay',
  customPrompt?: (question: string) => Promise<string>,
  useStderr = false
): Promise<boolean> {
  if (customPrompt) {
    return customPrompt(promptText).then(
      (ans) => ans.trim().toLowerCase() === expectedWord
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: useStderr ? process.stderr : process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === expectedWord);
    });
  });
}

export async function runAppsInspectCommand(options: AppsInspectOptions = {}): Promise<void> {
  const homeDir = options.home ?? os.homedir();
  const wanted = options.app?.trim();

  let adapters = AGENT_APP_ADAPTERS;
  if (wanted) {
    const adapter = getAgentAppAdapter(wanted);
    if (!adapter) {
      process.stderr.write(
        `app không hỗ trợ: ${wanted} (hỗ trợ: ${AGENT_APP_ADAPTERS.map((a) => a.app).join(', ')})\n`
      );
      process.exitCode = 1;
      return;
    }
    adapters = [adapter];
  }

  const results: AgentAppInspection[] = [];
  const failures: Array<{ app: string; code: string; message: string }> = [];

  for (const adapter of adapters) {
    try {
      const inspection = await adapter.inspect({
        ...(options.config && adapters.length === 1 ? { configPath: options.config } : {}),
        homeDir,
      });
      results.push(inspection);
    } catch (error) {
      const code = error instanceof AgentAppInspectError ? error.code : 'UNSUPPORTED';
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ app: adapter.app, code, message });
    }
  }

  const masked = results.map((inspection) => ({
    ...inspection,
    configPath: maskHomePath(inspection.configPath, homeDir),
  }));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ apps: masked, failures }, null, 2)}\n`);
    return;
  }

  const rows: string[][] = [['app', 'provider', 'model', 'trạng thái']];
  for (const inspection of masked) {
    if (inspection.models.length === 0) {
      rows.push([inspection.app, '—', '—', 'UNKNOWN']);
      continue;
    }
    for (const model of inspection.models) {
      rows.push([inspection.app, model.provider, model.id, statusLabel(model.enabled)]);
    }
  }

  const lines: string[] = [];
  lines.push(renderTable(rows));

  for (const inspection of masked) {
    lines.push('');
    lines.push(`[${inspection.app}]`);
    lines.push(`  cấu hình      : ${inspection.configPath} (${inspection.format}, chỉ đọc)`);
    lines.push(`  model đang dùng: ${inspection.activeModel}`);
    lines.push(`  router        : ${inspection.routerRef}`);
    lines.push(`  độ chắc chắn  : ${inspection.certainty}`);
    for (const warning of inspection.warnings) lines.push(`  cảnh báo      : ${warning}`);
  }

  for (const failure of failures) {
    lines.push('');
    lines.push(`[${failure.app}] không đọc được (${failure.code}): ${failure.message}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function normalizeCatalogObject(
  parsed: Record<string, unknown>,
  stateDir?: string
): HarnessCatalogInput {
  const out: HarnessCatalogInput = {};

  // Format B / C: `{ providers: { ... } }` (including `<stateDir>/tick-catalog.json`)
  if (
    parsed['providers'] &&
    typeof parsed['providers'] === 'object' &&
    !Array.isArray(parsed['providers'])
  ) {
    const providersObj = parsed['providers'] as Record<string, unknown>;
    const nowMs = Date.now();
    const officialDeprecatedByCanon = new Map<string, Set<string>>();

    if (stateDir) {
      try {
        const evidence = loadResearchEvidence(stateDir);
        for (const rec of evidence) {
          if (rec.sourceTier !== 'official' || !rec.domainVerified || rec.verdict !== 'deprecated') {
            continue;
          }
          const shutdownMs = rec.shutdownDate ? Date.parse(rec.shutdownDate) : null;
          if (shutdownMs === null || (Number.isFinite(shutdownMs) && shutdownMs <= nowMs)) {
            const set = officialDeprecatedByCanon.get(rec.provider) ?? new Set<string>();
            set.add(rec.modelId);
            officialDeprecatedByCanon.set(rec.provider, set);
          }
        }
      } catch {
        // Ignore absent/unreadable research-evidence.json
      }
    }

    for (const [provId, rawEntry] of Object.entries(providersObj)) {
      if (Array.isArray(rawEntry)) {
        const liveModels = rawEntry.filter((m): m is string => typeof m === 'string');
        out[provId] = { liveModels, deprecatedModels: [] };
        continue;
      }
      if (!rawEntry || typeof rawEntry !== 'object') {
        continue;
      }
      const entryObj = rawEntry as Record<string, unknown>;
      if (Array.isArray(entryObj['liveModels'])) {
        out[provId] = {
          liveModels: (entryObj['liveModels'] as unknown[]).filter(
            (m): m is string => typeof m === 'string'
          ),
          deprecatedModels: Array.isArray(entryObj['deprecatedModels'])
            ? (entryObj['deprecatedModels'] as unknown[]).filter(
                (m): m is string => typeof m === 'string'
              )
            : [],
        };
        continue;
      }
      if (Array.isArray(entryObj['ids'])) {
        const liveModels = (entryObj['ids'] as unknown[]).filter(
          (m): m is string => typeof m === 'string'
        );
        const liveSet = new Set(liveModels);
        const deprecatedSet = new Set<string>();
        const absenceCounts =
          entryObj['absenceCounts'] &&
          typeof entryObj['absenceCounts'] === 'object' &&
          !Array.isArray(entryObj['absenceCounts'])
            ? (entryObj['absenceCounts'] as Record<string, unknown>)
            : {};

        for (const [modelId, rawCount] of Object.entries(absenceCounts)) {
          if (typeof rawCount === 'number' && rawCount >= 2 && !liveSet.has(modelId)) {
            deprecatedSet.add(modelId);
          }
        }
        const canonProv = canonicalizeResearchProvider(provId);
        for (const depModel of officialDeprecatedByCanon.get(canonProv) ?? []) {
          deprecatedSet.add(depModel);
        }

        out[provId] = {
          liveModels: liveModels.filter((m) => !deprecatedSet.has(m)),
          deprecatedModels: [...deprecatedSet],
        };
      }
    }
    return out;
  }

  // Format A: Direct `HarnessCatalogInput` (`{ openai: { liveModels, deprecatedModels } }`)
  for (const [provId, rawEntry] of Object.entries(parsed)) {
    if (Array.isArray(rawEntry)) {
      out[provId] = {
        liveModels: rawEntry.filter((m): m is string => typeof m === 'string'),
        deprecatedModels: [],
      };
      continue;
    }
    if (rawEntry && typeof rawEntry === 'object') {
      const rec = rawEntry as Record<string, unknown>;
      if (Array.isArray(rec['liveModels']) || Array.isArray(rec['deprecatedModels'])) {
        out[provId] = {
          liveModels: Array.isArray(rec['liveModels'])
            ? (rec['liveModels'] as unknown[]).filter((m): m is string => typeof m === 'string')
            : [],
          deprecatedModels: Array.isArray(rec['deprecatedModels'])
            ? (rec['deprecatedModels'] as unknown[]).filter(
                (m): m is string => typeof m === 'string'
              )
            : [],
        };
      }
    }
  }

  return out;
}

function loadCatalogJson(
  explicitCatalogPath: string | undefined,
  explicitStateDir?: string | undefined
): HarnessCatalogInput {
  const sDir = resolveControlStateDir(explicitStateDir);
  const resolvedPath =
    explicitCatalogPath && explicitCatalogPath.trim().length > 0
      ? explicitCatalogPath.trim()
      : path.join(sDir, 'tick-catalog.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `CATALOG_NOT_FOUND: Không tìm thấy tệp catalog: ${resolvedPath} (truyền --catalog <path> hoặc chạy 'routersync tick --mode observe' trước).`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tệp catalog không hợp lệ: ${resolvedPath}`);
  }
  return normalizeCatalogObject(parsed as Record<string, unknown>, sDir);
}

function requireWriteAdapter(app: string) {
  const adapter = getHarnessWriteAdapter(app);
  if (!adapter) {
    const supported = listHarnessWriteAdapters().map((a) => a.app).join(', ');
    throw new Error(`Harness không hỗ trợ: ${app} (hỗ trợ: ${supported})`);
  }
  return adapter;
}

function failAppsWrite(error: Error, json?: boolean): never {
  process.exitCode = 1;
  if (json) {
    const errorCode = error instanceof ConsentValidationError ? error.code : undefined;
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          ...(errorCode ? { errorCode } : {}),
          error: error.message,
          status: 'FAILED',
        },
        null,
        2
      )}\n`
    );
  }
  throw error;
}

export async function runAppsPlanCommand(options: AppsPlanCommandOptions): Promise<void> {
  const adapter = requireWriteAdapter(options.app);
  const catalog = loadCatalogJson(options.catalog, options.stateDir);
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
  const maskBaseHome = options.home ?? os.homedir();
  const plan = await adapter.plan({
    configPath: options.config,
    homeDir: effectiveHomeDir,
    catalog,
  });
  const maskedPlan = {
    ...plan,
    configPath: maskHomePath(plan.configPath, maskBaseHome),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(maskedPlan, null, 2)}\n`);
    return;
  }

  const lines = [
    `[${maskedPlan.app}] chế độ=${maskedPlan.directionAMode} editable=${maskedPlan.editable} planHash=${maskedPlan.planHash}`,
    `  cấu hình        : ${maskedPlan.configPath}`,
    `  provider đích   : ${maskedPlan.targetProviders.join(', ') || '—'}`,
    `  thêm model      : ${maskedPlan.additions.map((a) => `${a.provider}/${a.model}`).join(', ') || '0'}`,
    `  gỡ model        : ${maskedPlan.removals.map((r) => `${r.provider}/${r.model}`).join(', ') || '0'}`,
  ];
  for (const w of maskedPlan.defaultSlotWarnings) {
    lines.push(`  cảnh báo default: ${w.slot}=${w.currentModel} -> gợi ý ${w.suggestion}`);
  }
  for (const g of maskedPlan.guidance) {
    lines.push(`  hướng dẫn       : ${g}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export async function runAppsApplyCommand(options: AppsApplyCommandOptions): Promise<void> {
  // 1. Prohibit --yes bypass unconditionally (Rule R11 / C46-F3)
  if (options.yes) {
    failAppsWrite(
      new ConsentValidationError(
        'CONSENT_BYPASS_FORBIDDEN',
        'CONSENT_BYPASS_FORBIDDEN: Security Violation: The --yes flag is prohibited by security policy.'
      ),
      options.json
    );
  }

  // 2. Legacy C45-WP2 isolated sandbox-copy mode (100% backward-compatible, strictly os.tmpdir() only)
  if (options.sandboxCopy && !options.write) {
    try {
      assertOpenMausBotSafeFile(options.config);
      assertControlledWriteSandbox(options.config, 'harness-config', {});
      assertControlledWriteSandbox(
        options.backup ?? `${options.config}.routersync.bak`,
        'harness-config',
        {}
      );
    } catch (err) {
      failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
    }
    const adapter = requireWriteAdapter(options.app);
    const catalog = loadCatalogJson(options.catalog, options.stateDir);
    const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);
    const res = await adapter.apply({
      configPath: options.config,
      homeDir: effectiveHomeDir,
      catalog,
      expectedPlanHash: options.planHash,
      backupPath: options.backup,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `[${res.app}] applied=${res.applied} readBackVerified=${res.readBackVerified} preSha256=${res.preSha256} postSha256=${res.postSha256}\n`
    );
    return;
  }

  if (!options.write) {
    failAppsWrite(
      new Error(
        'Yêu cầu cờ --write (có kiểm soát qua standing-consent) hoặc --sandbox-copy (chỉ áp dụng trên bản sao tạm trong os.tmpdir()) khi chạy `routersync apps apply`.'
      ),
      options.json
    );
  }

  // 3. Controlled `--write` mode (C46-F3)
  const sDir = resolveControlStateDir(options.stateDir);

  // 3a. Emergency Freeze Gate (fail-closed on active or corrupted freeze.json)
  const freeze = readFreezeState(sDir);
  if (freeze.frozen) {
    failAppsWrite(
      new ConsentValidationError(
        'FREEZE_ACTIVE',
        `FREEZE_ACTIVE (WRITE_FROZEN): Write execution blocked because emergency freeze is active (${freeze.reason ?? 'frozen'}).`
      ),
      options.json
    );
  }

  // 3b. Sandbox & forbidden runtime file guard (`bots.json` / `routines.json` + `os.tmpdir()` vs `ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`)
  try {
    assertOpenMausBotSafeFile(options.config);
    assertControlledWriteSandbox(options.config, 'harness-config');
    assertControlledWriteSandbox(
      options.backup ?? `${options.config}.routersync.bak`,
      'harness-config'
    );
  } catch (err) {
    failAppsWrite(err instanceof Error ? err : new Error(String(err)), options.json);
  }

  const adapter = requireWriteAdapter(options.app);
  if (adapter.directionAMode !== 'write-adapter') {
    failAppsWrite(
      new Error(
        `REPORT_ONLY_HARNESS: Harness '${adapter.app}' is report-only and cannot be modified via 'apps apply --write'.`
      ),
      options.json
    );
  }

  const targetScope = `harness:${adapter.app}`;

  // 3c. Standing Consent & Apply History HMAC/Schema Verification
  const consent = readStandingConsent(sDir);
  if (consent.present && !consent.valid) {
    const code = consent.errorCode ?? 'CONSENT_HMAC_INVALID';
    failAppsWrite(
      new ConsentValidationError(
        code,
        `${code}: Standing consent file (<stateDir>/standing-consent.json) failed integrity verification.`
      ),
      options.json
    );
  }

  const historyCheck = readApplyHistory(sDir);
  if (historyCheck.present && !historyCheck.valid) {
    const code = historyCheck.errorCode ?? 'CONSENT_HMAC_INVALID';
    failAppsWrite(
      new ConsentValidationError(
        code,
        `${code}: Apply history ledger (<stateDir>/apply-history.json) failed integrity verification.`
      ),
      options.json
    );
  }

  const activeEntry = consent.activeTargets.find(
    (entry) =>
      entry.target === targetScope &&
      (entry.level === 'propose' || entry.level === 'auto-safe')
  );
  if (!activeEntry) {
    failAppsWrite(
      new ConsentValidationError(
        'CONSENT_REQUIRED',
        `CONSENT_REQUIRED: Active standing consent ('propose' or 'auto-safe') is required for '${targetScope}'. Run 'routersync consent grant --target ${targetScope} --level propose'.`
      ),
      options.json
    );
  }

  let authorizedVia: 'standing-consent' | 'interactive-tty';
  let appliedAtLevel: 'auto-safe' | 'propose';

  if (activeEntry.level === 'auto-safe') {
    if (!findVerifiedProposeReceipt(sDir, targetScope)) {
      failAppsWrite(
        new ConsentValidationError(
          'AUTO_SAFE_RECEIPT_MISSING',
          `AUTO_SAFE_RECEIPT_MISSING: Runtime auto-safe check failed for '${targetScope}': apply-history.json is missing, tampered, or lacks a verified non-rolled-back propose receipt.`
        ),
        options.json
      );
    }
    authorizedVia = 'standing-consent';
    appliedAtLevel = 'auto-safe';
  } else {
    authorizedVia = 'interactive-tty';
    appliedAtLevel = 'propose';
  }

  const catalog = loadCatalogJson(options.catalog, sDir);
  const effectiveHomeDir = resolveEffectiveHarnessHomeDir(options.config, options.home);

  if (authorizedVia === 'interactive-tty') {
    const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      failAppsWrite(
        new Error(
          `TTY_REQUIRED: Write Execution Blocked: Running 'routersync apps apply --write' at consent level 'propose' requires an interactive TTY terminal.`
        ),
        options.json
      );
    }

    const preview = await adapter.plan({
      configPath: options.config,
      homeDir: effectiveHomeDir,
      catalog,
    });
    const summaryWriter = options.json ? process.stderr : process.stdout;
    summaryWriter.write(
      `\n======================================================\n` +
        `[routersync] REVIEWING HARNESS CHANGES BEFORE WRITING\n` +
        `  Target   : ${targetScope}\n` +
        `  Additions: ${preview.additions.length}, Removals: ${preview.removals.length}\n` +
        `======================================================\n`
    );

    const confirmed = await askAppsConfirmation(
      `Apply changes to ${targetScope}? Type 'chay' to confirm: `,
      'chay',
      options.promptFn,
      Boolean(options.json)
    );
    if (!confirmed) {
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, applied: false, cancelled: true, target: targetScope }, null, 2)}\n`
        );
      } else {
        process.stdout.write(
          `[routersync] Write operation cancelled by user. Zero changes applied.\n`
        );
      }
      return;
    }
  }

  // 3d. Lossless atomic apply + immediate post-write read-back + signed ApplyHistoryReceipt
  const appliedAt = new Date().toISOString();
  const res = await adapter.apply({
    configPath: options.config,
    homeDir: effectiveHomeDir,
    catalog,
    expectedPlanHash: options.planHash,
    backupPath: options.backup,
  });

  if (!res.readBackVerified || res.rolledBack) {
    failAppsWrite(
      new Error(`[${res.app}] Post-write read-back verification failed for ${targetScope}.`),
      options.json
    );
  }

  appendApplyReceipt(sDir, {
    target: targetScope,
    planHash: res.planHash,
    appliedAt,
    appliedAtLevel,
    authorizedVia,
    success: res.applied && !res.rolledBack,
    readBackVerified: res.readBackVerified,
    readBackLevel: 'file-byte-verified',
    rolledBack: res.rolledBack,
    snapshotOrBackupRef: res.backupPath,
    preDigest: res.preSha256,
    postDigest: res.postSha256,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[${res.app}] applied=${res.applied} readBackVerified=${res.readBackVerified} preSha256=${res.preSha256} postSha256=${res.postSha256}\n`
  );
}

export async function runAppsRollbackCommand(options: AppsRollbackCommandOptions): Promise<void> {
  assertOpenMausBotSafeFile(options.config);
  assertControlledWriteSandbox(options.config, 'harness-config');
  if (options.backup) {
    assertControlledWriteSandbox(options.backup, 'harness-config');
  }
  const adapter = requireWriteAdapter(options.app);
  const res = await adapter.rollback({
    configPath: options.config,
    backupPath: options.backup,
    expectedPreSha256: options.expectedPreSha256,
  });

  if (res.restored) {
    const sDir = resolveControlStateDir(options.stateDir);
    const target = `harness:${adapter.app}`;
    const history = readApplyHistory(sDir);
    const candidates = history.receipts.filter((receipt) =>
      receipt.target === target && !receipt.rolledBack &&
      receipt.success && receipt.readBackVerified &&
      /^[0-9a-f]{64}$/i.test(receipt.preDigest ?? '')
    ).reverse();
    const expected = options.expectedPreSha256 ?? res.postSha256;
    const receiptToVerify = candidates.find((receipt) =>
      receipt.preDigest?.toLowerCase() === expected.toLowerCase()
    ) ?? candidates.find((receipt) =>
      path.resolve(receipt.snapshotOrBackupRef) === path.resolve(res.backupPath)
    );
    markApplyReceiptRolledBack(sDir, {
      target,
      snapshotOrBackupRef: res.backupPath,
      verifyRollback: (receipt) => {
        const beforeDigest = receipt.preDigest;
        if (receipt.receiptId !== receiptToVerify?.receiptId || !beforeDigest) return undefined;
        return { beforeDigest: beforeDigest.toLowerCase(), afterDigest: res.postSha256.toLowerCase() };
      },
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `[${res.app}] restored=${res.restored} byteIdenticalToPreApply=${res.byteIdenticalToPreApply} postSha256=${res.postSha256}\n`
  );
}
