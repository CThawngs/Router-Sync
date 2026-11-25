/**
 * packages/cli/src/commands/rollback.ts
 *
 * Implements `routersync rollback [snapshotId]` command.
 *
 * Gate R / AT-112 (T2-28 reopened as PARTIAL 2026-10-15):
 * the previous implementation only created a snapshot and verified adapter
 * responsiveness — it never restored anything. This version:
 *  - `rollback` (no id): lists persisted snapshots from the state directory.
 *  - `rollback <id>`: DRY-RUN BY DEFAULT (owner brief 2026-10-15 §4c) — prints
 *    exactly what a logical restore would do, performs NO writes.
 *  - `rollback <id> --write`: performs the REAL logical (row-level) rollback.
 *    Requires an interactive TTY AND explicit confirmation, exactly like
 *    `apply --write` (a rollback writes to the live router DB).
 *  - A missing snapshot is a hard error — never a silent success.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadConfigFile, resolveRouterDbPath } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import {
  assertControlledWriteSandbox,
  listSnapshots,
  loadSnapshot,
  markApplyReceiptRolledBack,
  resolveControlStateDir,
} from '@routersync/core';

export interface RollbackCommandOptions {
  configPath?: string | undefined;
  stateDir?: string | undefined;
  /** Snapshot id to restore. When omitted, stored snapshots are listed. */
  snapshotId?: string | undefined;
  /**
   * Owner brief 2026-10-15 §4c: rollback writes to the live router DB, so it
   * is DRY-RUN BY DEFAULT. Pass --write to perform the real restore.
   */
  write?: boolean | undefined;
  json?: boolean | undefined;
  /** Programmatic test seams (mirrors apply.ts / consent.ts / freeze.ts) */
  isTTY?: boolean | undefined;
  promptFn?: ((question: string) => Promise<string>) | undefined;
}

function askConfirmation(
  promptText: string,
  expectedWord = 'chay',
  customPrompt?: (question: string) => Promise<string>
): Promise<boolean> {
  if (customPrompt) {
    return customPrompt(promptText).then(
      (answer) => answer.trim().toLowerCase() === expectedWord
    );
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

export async function runRollbackCommand(options: RollbackCommandOptions): Promise<void> {
  const { config, filePath: resolvedConfigFile } = loadConfigFile(options.configPath);
  const configDir = path.dirname(path.resolve(resolvedConfigFile));

  // ---- No id: list persisted snapshots -----------------------------------
  if (!options.snapshotId) {
    const snaps = listSnapshots(options.stateDir);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, snapshots: snaps }, null, 2));
      return;
    }
    if (snaps.length === 0) {
      console.log('[routersync] No persisted snapshots found.');
      console.log("  Snapshots are created by 'routersync apply --write' and stored in the state directory.");
      console.log("  Run 'routersync rollback <id>' to restore one.");
      return;
    }
    console.log('[routersync] Persisted snapshots:');
    for (const s of snaps) {
      console.log(`  - ${s.id} (target: ${s.target}, ${s.timestamp})`);
    }
    console.log("  Run 'routersync rollback <id>' to restore one.");
    return;
  }

  // ---- With id: load snapshot, restore via adapter logical rollback -------
  let snapshot;
  try {
    snapshot = loadSnapshot(options.snapshotId, options.stateDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`[routersync] Error: ${msg}`);
    }
    process.exitCode = 1;
    throw new Error(msg);
  }

  // Resolve the router: by config id === snapshot.target, else by adapter name.
  const router =
    config.routers.find((r) => r.id === snapshot.target) ??
    config.routers.find((r) => r.adapter === snapshot.target);
  if (!router) {
    const msg = `No configured router matches snapshot target "${snapshot.target}".`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`[routersync] Error: ${msg}`);
    }
    process.exitCode = 1;
    throw new Error(msg);
  }

  const isWrite = Boolean(options.write);

  // ---- DRY-RUN (default): print the plan, perform NO writes --------------
  if (!isWrite) {
    const managedCombos = snapshot.combos.filter((c) => c.managed);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: 'dry-run',
            snapshotId: snapshot.id,
            target: snapshot.target,
            routerId: router.id,
            timestamp: snapshot.timestamp,
            combos: snapshot.combos.length,
            managedCombos: managedCombos.map((c) => ({ id: c.id, name: c.name })),
            actions: [
              'restore managed/touched combo rows to snapshot state (row-level, same transaction)',
              'delete RouterSync-managed rows not present in the snapshot',
              'patch only the comboStrategies keys RouterSync touched (no full-map rewrite)',
            ],
            note: 'No writes performed. Run `routersync rollback <id> --write` in an interactive terminal to execute.',
          },
          null,
          2
        )
      );
    } else {
      console.log(`[routersync] Rollback DRY-RUN of snapshot ${snapshot.id} (no writes performed):`);
      console.log(`  Router:      ${router.id} (adapter: ${router.adapter})`);
      console.log(`  Snapshot:    ${snapshot.id} @ ${snapshot.timestamp}`);
      console.log(`  Combos in snapshot: ${snapshot.combos.length} (${managedCombos.length} managed by RouterSync)`);
      for (const c of managedCombos) {
        console.log(`    - ${c.id} (${c.name})`);
      }
      console.log('  Would perform (logical row-level restore):');
      console.log('    - restore managed/touched combo rows to snapshot state (row-level, same transaction)');
      console.log('    - delete RouterSync-managed rows not present in the snapshot');
      console.log('    - patch only the comboStrategies keys RouterSync touched (no full-map rewrite)');
      console.log(`  To execute: run \`routersync rollback ${snapshot.id} --write\` in an interactive terminal.`);
    }
    return;
  }

  // ---- WRITE: TTY gate + interactive confirmation (mirrors apply --write) -
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    const msg =
      'Write Execution Blocked: Running `rollback --write` requires an interactive TTY terminal.\n' +
      'A rollback writes to the live router database. Non-interactive scripts or automated\n' +
      'callers cannot bypass human confirmation. Re-run interactively, or use the default\n' +
      'dry-run to inspect the plan first.';
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`[routersync] Error: ${msg}`);
    }
    process.exitCode = 1;
    throw new Error(msg);
  }

  const confirmed = await askConfirmation(
    `Rollback router ${router.id} to snapshot ${snapshot.id} (${snapshot.combos.length} combos)? This writes to the live DB. Type 'chay' to confirm: `,
    'chay',
    options.promptFn
  );
  if (!confirmed) {
    console.log('[routersync] Rollback cancelled by user. No writes performed.');
    return;
  }

  const dbPath = resolveRouterDbPath(router, configDir);
  assertControlledWriteSandbox(dbPath, 'router-db');

  const adapter = createAdapterForRouter(router, options.stateDir);
  const ok = await adapter.rollback(snapshot);

  if (ok) {
    const sDir = resolveControlStateDir(options.stateDir);
    markApplyReceiptRolledBack(sDir, {
      targetPrefix: `router:${router.id}/`,
      snapshotOrBackupRef: snapshot.id,
      appliedAtOrAfter: snapshot.timestamp,
    });
    if (router.adapter && router.adapter !== router.id) {
      markApplyReceiptRolledBack(sDir, {
        targetPrefix: `router:${router.adapter}/`,
        snapshotOrBackupRef: snapshot.id,
        appliedAtOrAfter: snapshot.timestamp,
      });
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok, snapshotId: snapshot.id, target: snapshot.target, combos: snapshot.combos.length },
        null,
        2
      )
    );
  } else if (ok) {
    console.log(
      `[routersync] Rollback of snapshot ${snapshot.id} completed ` +
      `(${snapshot.combos.length} combos, logical row-level restore on ${router.id}).`
    );
  } else {
    console.error(`[routersync] Rollback FAILED for snapshot ${snapshot.id} on router ${router.id}.`);
  }
  if (!ok) process.exitCode = 1;
}
