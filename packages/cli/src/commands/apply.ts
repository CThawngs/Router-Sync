/**
 * packages/cli/src/commands/apply.ts
 *
 * Implements `routersync apply` command (Condition A1, B1, & C45-WP4 §3.2.3):
 *  - Default dry-run mode
 *  - `--yes` flag strictly rejected
 *  - Enforces emergency `freeze.json` (`WRITE_FROZEN`) and `assertControlledWriteSandbox`
 *  - When active `standing-consent.json` covers all planned combos, `apply --write`
 *    executes without re-typing `'chay'` every run; otherwise requires interactive TTY + `'chay'`
 *  - Records HMAC-signed `ApplyHistoryReceipt` (`appliedAtLevel: 'propose'`) and notifies `inbox.json` + webhook
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadConfigFile, resolveRouterDbPath } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import { generatePlansForConfig } from './plan.js';
import {
  appendApplyReceipt,
  applyMultiRouterSafe,
  assertControlledWriteSandbox,
  atomicWriteFileSync,
  readFreezeState,
  readStandingConsent,
  resolveControlStateDir,
  saveSnapshot,
  sendActionableWebhook,
} from '@routersync/core';
import type { ApplyResult, Plan } from '@routersync/adapter-sdk';

export interface ApplyCommandOptions {
  configPath?: string | undefined;
  stateDir?: string | undefined;
  write?: boolean | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
}

export interface MultiRouterApplyReport {
  mode: 'dry-run' | 'live-write';
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  results: ApplyResult[];
  /** Gate R / AT-112: pre-write snapshots persisted to the state dir. */
  snapshots?: Array<{ routerId: string; snapshotId: string; file: string }> | undefined;
  timestamp: string;
}

function askConfirmation(
  promptText: string,
  expectedWord = 'chay',
  promptFn?: (text: string) => Promise<string>
): Promise<boolean> {
  if (promptFn) {
    return promptFn(promptText).then((ans) => ans.trim().toLowerCase() === expectedWord);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === expectedWord);
    });
  });
}

function appendApplyInboxNotification(
  sDir: string,
  nowIso: string,
  title: string,
  body: string
): void {
  const inboxPath = path.join(sDir, 'inbox.json');
  let items: Array<Record<string, unknown>> = [];
  if (fs.existsSync(inboxPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        items = parsed as Array<Record<string, unknown>>;
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { items?: unknown[] }).items)
      ) {
        items = (parsed as { items: Array<Record<string, unknown>> }).items;
      }
    } catch {
      items = [];
    }
  }
  items.unshift({
    id: `cli-apply-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    title,
    type: 'info',
    timestamp: nowIso,
    body,
    label: 'PLAN-APPLIED',
    proposed_by: { kind: 'system', source: 'cli.apply' },
  });
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });
  atomicWriteFileSync(
    inboxPath,
    JSON.stringify({ updatedAt: nowIso, items: items.slice(0, 200) }, null, 2)
  );
}

export async function runApplyCommand(options: ApplyCommandOptions): Promise<MultiRouterApplyReport> {
  const timestamp = new Date().toISOString();

  // 1. Prohibit --yes flag per Rule R11 / Condition A1
  if (options.yes) {
    const errorMsg =
      `Security Violation: The --yes flag is prohibited by security policy (Rule §28.1 / R11).\n` +
      `RouterSync requires human-in-the-loop interactive review for all state modifications.`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: errorMsg, status: 'FAILED' }));
    } else {
      console.error(`[routersync] Error: ${errorMsg}`);
    }
    process.exitCode = 1;
    throw new Error(errorMsg);
  }

  const sDir = resolveControlStateDir(options.stateDir);
  const isWrite = Boolean(options.write);

  // 2. Emergency Freeze Gate (C45-WP4 §1.3 & §3.2.3)
  if (isWrite) {
    const freeze = readFreezeState(sDir);
    if (freeze.frozen) {
      const errorMsg = `WRITE_FROZEN: Write execution blocked because emergency freeze is active (${freeze.reason ?? 'frozen'}).`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, errorCode: 'WRITE_FROZEN', error: errorMsg, status: 'FAILED' }));
      } else {
        console.error(`[routersync] Error: ${errorMsg}`);
      }
      process.exitCode = 1;
      throw new Error(errorMsg);
    }
  }

  // 3. Load config & generate plans
  const { config, filePath: resolvedConfigFile } = loadConfigFile(options.configPath);
  const configDir = path.dirname(path.resolve(resolvedConfigFile));
  const { results: planResults } = await generatePlansForConfig(options.configPath);

  // 4. Dry-run by default
  if (!isWrite) {
    const dryTargets = planResults.map((item) => {
      const routerConfig = config.routers.find((r) => r.id === item.routerId);
      if (!routerConfig) throw new Error(`Router config not found for ${item.routerId}`);
      return { adapter: createAdapterForRouter(routerConfig), plan: item.plan };
    });

    const report = await applyMultiRouterSafe(dryTargets, { dryRun: true });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[routersync] [DRY-RUN] Evaluated ${report.results.length} router(s).`);
      console.log(`  No changes were written to any router.`);
      console.log(`  To execute changes, run \`routersync apply --write\` in an interactive terminal.`);
    }

    return report;
  }

  // 5. Evaluate Standing Consent policy & sandbox path guard
  const consent = readStandingConsent(sDir);
  if (consent.present && !consent.valid) {
    const errorMsg = `Standing consent file is invalid (${consent.errorCode ?? 'CONSENT_HMAC_INVALID'}). Refusing write.`;
    console.error(`[routersync] Error: ${errorMsg}`);
    process.exitCode = 1;
    throw new Error(errorMsg);
  }

  const activeConsentSet = new Set(
    consent.activeTargets
      .filter((t) => t.targetKind === 'router' && (t.level === 'propose' || t.level === 'auto-safe'))
      .map((t) => t.target)
  );
  const offConsentSet = new Set(
    consent.targets.filter((t) => t.level === 'off').map((t) => t.target)
  );

  let totalPlannedMutations = 0;
  let allCoveredByStandingConsent = consent.present && activeConsentSet.size > 0;

  const filteredPlanResults: Array<{
    routerId: string;
    adapter: string;
    plan: Plan;
    touchedCombos: string[];
  }> = [];

  for (const item of planResults) {
    const routerConfig = config.routers.find((r) => r.id === item.routerId);
    if (!routerConfig) {
      throw new Error(`Router config not found for ${item.routerId}`);
    }
    const isComboAllowed = (comboName: string): boolean => {
      const t1 = `router:${item.routerId}/${comboName}`;
      const t2 = `router:${routerConfig.adapter}/${comboName}`;
      if (offConsentSet.has(t1) || offConsentSet.has(t2)) return false;
      if (!consent.present) return true;
      return activeConsentSet.has(t1) || activeConsentSet.has(t2);
    };

    const rawCombos = [
      ...item.plan.additions.map((c) => c.name),
      ...item.plan.modifications.map((c) => c.name),
      ...item.plan.deletions,
    ];
    for (const cName of rawCombos) {
      const t1 = `router:${item.routerId}/${cName}`;
      const t2 = `router:${routerConfig.adapter}/${cName}`;
      if (!activeConsentSet.has(t1) && !activeConsentSet.has(t2)) {
        allCoveredByStandingConsent = false;
      }
    }

    const additions = item.plan.additions.filter((c) => isComboAllowed(c.name));
    const modifications = item.plan.modifications.filter((c) => isComboAllowed(c.name));
    const deletions = item.plan.deletions.filter((name) => isComboAllowed(name));
    const touchedCombos = [
      ...new Set([
        ...additions.map((c) => c.name),
        ...modifications.map((c) => c.name),
        ...deletions,
      ]),
    ];
    totalPlannedMutations += touchedCombos.length;

    filteredPlanResults.push({
      routerId: item.routerId,
      adapter: item.adapter,
      plan: {
        ...item.plan,
        additions,
        modifications,
        deletions,
      },
      touchedCombos,
    });
  }

  if (consent.present && totalPlannedMutations === 0 && planResults.some(
    (p) => p.plan.additions.length + p.plan.modifications.length + p.plan.deletions.length > 0
  )) {
    const errorMsg = `UNAUTHORIZED_TARGET: Zero planned combos are authorized by standing-consent.json.`;
    console.error(`[routersync] Error: ${errorMsg}`);
    process.exitCode = 1;
    throw new Error(errorMsg);
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const authorizedVia: 'standing-consent' | 'interactive-tty' = allCoveredByStandingConsent
    ? 'standing-consent'
    : 'interactive-tty';

  if (authorizedVia === 'interactive-tty') {
    if (!isTTY) {
      const errorMsg =
        `Write Execution Blocked: Running with --write requires an interactive TTY terminal (Condition A1).\n` +
        `Non-interactive scripts or automated callers cannot bypass human confirmation.`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: errorMsg, status: 'FAILED' }));
      } else {
        console.error(`[routersync] Error: ${errorMsg}`);
      }
      process.exitCode = 1;
      throw new Error(errorMsg);
    }

    console.log(`\n======================================================`);
    console.log(`[routersync] REVIEWING PENDING CHANGES BEFORE WRITING`);
    console.log(`======================================================`);
    for (const item of filteredPlanResults) {
      const p = item.plan;
      console.log(`Router [${item.routerId}] (${item.adapter}):`);
      console.log(`  Additions: ${p.additions.length}, Modifications: ${p.modifications.length}, Deletions: ${p.deletions.length}`);
    }
    console.log(`======================================================\n`);

    const confirmed = await askConfirmation(
      `Are you sure you want to write these changes? Type 'chay' to confirm: `,
      'chay',
      options.promptFn
    );
    if (!confirmed) {
      console.log(`[routersync] Write operation cancelled by user. Zero changes applied.`);
      return {
        mode: 'live-write',
        status: 'SUCCESS',
        results: [],
        timestamp,
      };
    }
  }

  // 7. Parallel apply across independent routers (Condition B1, AT-4)
  const writeTargets = filteredPlanResults.map((item) => {
    const routerConfig = config.routers.find((r) => r.id === item.routerId);
    if (!routerConfig) {
      throw new Error(`Router config not found for ${item.routerId}`);
    }
    const dbPath = resolveRouterDbPath(routerConfig, configDir);
    assertControlledWriteSandbox(dbPath, 'router-db');
    return {
      adapter: createAdapterForRouter(routerConfig),
      plan: item.plan,
      routerId: item.routerId,
      touchedCombos: item.touchedCombos,
    };
  });

  const savedSnapshots: Array<{ routerId: string; snapshotId: string; file: string }> = [];
  for (const t of writeTargets) {
    try {
      const snap = await t.adapter.createSnapshot();
      const file = saveSnapshot(snap);
      savedSnapshots.push({ routerId: t.plan.target, snapshotId: snap.id, file });
    } catch (err) {
      console.error(
        `[routersync] WARNING: could not persist pre-write snapshot for ${t.plan.target}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const baseReport = await applyMultiRouterSafe(
    writeTargets.map((t) => ({ adapter: t.adapter, plan: t.plan })),
    { dryRun: false }
  );
  const report: MultiRouterApplyReport = { ...baseReport, snapshots: savedSnapshots };

  // 8. Record ApplyHistoryReceipt & Dual Notification (C45-WP4 §3.2.3)
  const planDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(filteredPlanResults.map((f) => f.plan)))
    .digest('hex')
    .slice(0, 16);

  const appliedTargetsSummary: string[] = [];
  for (let idx = 0; idx < writeTargets.length; idx++) {
    const wt = writeTargets[idx]!;
    const res = report.results[idx];
    if (!res) continue;
    const snapRef =
      savedSnapshots.find((s) => s.routerId === wt.routerId)?.snapshotId ?? 'snapshot';
    const combosToRecord = wt.touchedCombos.length > 0 ? wt.touchedCombos : [];
    for (const comboName of combosToRecord) {
      const targetScope = `router:${wt.routerId}/${comboName}`;
      appendApplyReceipt(sDir, {
        target: targetScope,
        planHash: planDigest,
        appliedAt: timestamp,
        appliedAtLevel: 'propose',
        authorizedVia,
        success: res.success,
        readBackVerified: Boolean(res.readBackVerified),
        readBackLevel: res.readBackLevel ?? 'db-only',
        rolledBack: Boolean(res.rollbackExecuted),
        snapshotOrBackupRef: snapRef,
      });
      if (res.success) appliedTargetsSummary.push(targetScope);
    }
  }

  if (appliedTargetsSummary.length > 0) {
    appendApplyInboxNotification(
      sDir,
      timestamp,
      `[PLAN-APPLIED] Applied ${appliedTargetsSummary.length} combo target(s)`,
      `Targets applied (planHash=${planDigest}): ${appliedTargetsSummary.join(', ')}`
    );
    const webhookUrl =
      process.env['ROUTERSYNC_WEBHOOK_URL'] ||
      (config.webhook && config.webhook.enabled !== false ? config.webhook.url : undefined);
    await sendActionableWebhook({
      url: webhookUrl,
      source: 'cli.apply',
      timestamp,
      inboxAdded: 1,
      changedProviders: [],
      alerts: appliedTargetsSummary.map((t) => ({
        kind: 'plan_applied' as const,
        providerOrRouter: t,
        code: 'PLAN_APPLIED',
        message: `Applied controlled plan ${planDigest} to ${t}`,
      })),
      timeoutMs: config.webhook?.timeoutMs,
    });
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[routersync] Live write completed. Status: ${report.status}`);
    for (const r of report.results) {
      const tag = r.success ? '✓ SUCCESS' : '✗ FAILED';
      console.log(
        `  ${tag} Router [${r.target}] (readBackLevel: ${r.readBackLevel ?? 'db-only (degraded)'}, verified: ${r.readBackVerified})`
      );
      if (r.degradedReason) {
        console.log(`    Read-Back Info: ${r.degradedReason}`);
      }
      if (r.error) {
        console.log(`    Error: ${r.error}`);
      }
    }
    if (report.snapshots && report.snapshots.length > 0) {
      console.log(`  Persisted pre-write snapshots (restore with 'routersync rollback <id>'):`);
      for (const s of report.snapshots) {
        console.log(`    - ${s.snapshotId} (router ${s.routerId})`);
      }
    }
  }

  return report;
}
