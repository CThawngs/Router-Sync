/**
 * packages/cli/src/commands/apply.ts
 *
 * Implements `routersync apply` command.
 * Enforces Condition A1 & B1:
 *  - Default dry-run mode
 *  - Ghi thật requires `--write` AND interactive TTY AND confirmation after diff review
 *  - `--yes` flag or non-TTY with `--write` is strictly rejected
 *  - Independent parallel apply across multiple routers (Condition B1, AT-4)
 */

import * as readline from 'node:readline';
import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import { generatePlansForConfig } from './plan.js';
import { applyPlanSafe, applyMultiRouterSafe, saveSnapshot } from '@routersync/core';
import type { ApplyResult } from '@routersync/adapter-sdk';

export interface ApplyCommandOptions {
  configPath?: string;
  write?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface MultiRouterApplyReport {
  mode: 'dry-run' | 'live-write';
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  results: ApplyResult[];
  /** Gate R / AT-112: pre-write snapshots persisted to the state dir. */
  snapshots?: Array<{ routerId: string; snapshotId: string; file: string }> | undefined;
  timestamp: string;
}

function askConfirmation(promptText: string, expectedWord = 'chay'): Promise<boolean> {
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

  // 2. Load config & generate plans
  const { config } = loadConfigFile(options.configPath);
  const { results: planResults } = await generatePlansForConfig(options.configPath);

  // 3. Dry-run by default
  const isWrite = Boolean(options.write);

  if (!isWrite) {
    // DRY-RUN execution
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

  // 4. Write path: Enforce interactive TTY (Condition A1)
  if (!process.stdin.isTTY) {
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

  // 5. Display diff for human review
  console.log(`\n======================================================`);
  console.log(`[routersync] REVIEWING PENDING CHANGES BEFORE WRITING`);
  console.log(`======================================================`);
  for (const item of planResults) {
    const p = item.plan;
    console.log(`Router [${item.routerId}] (${item.adapter}):`);
    console.log(`  Additions: ${p.additions.length}, Modifications: ${p.modifications.length}, Deletions: ${p.deletions.length}`);
  }
  console.log(`======================================================\n`);

  // 6. Interactive confirmation prompt (must type 'chay' to match maintain)
  const confirmed = await askConfirmation(`Are you sure you want to write these changes? Type 'chay' to confirm: `, 'chay');
  if (!confirmed) {
    console.log(`[routersync] Write operation cancelled by user. Zero changes applied.`);
    const report: MultiRouterApplyReport = {
      mode: 'live-write',
      status: 'SUCCESS',
      results: [],
      timestamp,
    };
    return report;
  }

  // 7. Parallel apply across independent routers (Condition B1, AT-4)
  const writeTargets = planResults.map((item) => {
    const routerConfig = config.routers.find((r) => r.id === item.routerId);
    if (!routerConfig) {
      throw new Error(`Router config not found for ${item.routerId}`);
    }
    return { adapter: createAdapterForRouter(routerConfig), plan: item.plan };
  });

  // Gate R / AT-112: persist pre-write snapshots so 'routersync rollback <id>'
  // can perform a real logical restore later (T2-28 reopened PARTIAL).
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

  const baseReport = await applyMultiRouterSafe(writeTargets, { dryRun: false });
  const report: MultiRouterApplyReport = { ...baseReport, snapshots: savedSnapshots };

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
