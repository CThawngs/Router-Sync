/**
 * packages/cli/src/commands/sync/sync-cli.ts
 *
 * The three `routersync sync | undo | sync-status` commands plus the
 * apply/write path (backup -> fence -> narrow writer -> read-back -> undo hint).
 * Import surface for `packages/cli/src/index.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadConfigFile,
  resolveRouterDbPath,
} from '../../config/loader.js';
import { createAdapterForRouter } from '../../adapters.js';
import { buildViews, printTargets, printPlan, loadCatalogCounts, type RouterView } from './sync-plan.js';
import { scanAll, buildProviderLive, type ScanMeta } from './sync-scan.js';
import { buildScanCompleteness, type ScanCompletenessRow } from '../../sync/confirm.js';
import {
  computeSyncPlan,
  type ComboInput,
  type SyncPlan,
} from '../../sync/plan.js';
import {
  applyStepRemovals,
  assertWriteTargetMatchesPlan,
  backupRouterDb,
  backupsDirectory,
  grantLiveWriteToken,
  listBackups,
  readComboModels,
  restoreCombosFromBackup,
  previewUndoStepCounts,
  tableFence,
  tableFenceDetail,
  diffFenceTables,
  type ComboChange,
  type RouterName,
} from '../../sync/write.js';
import {
  readLastSync,
  writeLastSync,
  readPendingPlan,
  writePendingPlan,
  deletePendingPlan,
  confirm as confirmWord,
} from './sync-state.js';

export interface SyncCommandOptions {
  configPath?: string | undefined;
  router?: string | undefined;
  apply?: boolean | undefined;
  json?: boolean | undefined;
  scanGapMs?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface UndoCommandOptions {
  router?: string | undefined;
  backup?: string | undefined;
  apply?: boolean | undefined;
  configPath?: string | undefined;
}

const SCAN_GAP_DEFAULT_MS = 60_000;

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<void> {
  // TTY gate for the write path runs BEFORE any config or DB read, so a
  // machine without a router still prints the refusal message.
  if (options.apply && !process.stdin.isTTY) {
    const msg =
      'Write Execution Blocked: `sync --apply` requires an interactive TTY terminal.\n' +
      'stdin is not a TTY, so the human confirmation word cannot be collected.\n' +
      'Non-interactive scripts or automated callers cannot bypass human confirmation.';
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    }
    // The CLI entry point prints the error once; do not print it here too.
    process.exitCode = 1;
    throw new Error(msg);
  }

  const { config } = loadConfigFile(options.configPath);
  const only = options.router ?? 'all';
  const gapMs = options.scanGapMs ?? SCAN_GAP_DEFAULT_MS;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const views = await buildViews(config, only);

  console.log('SYNC-PROVIDERS danh sách nhà cung cấp và host sẽ gọi bằng khóa (không in khóa):');
  printTargets(views);

  const keyed = views.reduce(
    (n, v) => n + v.targets.filter((t) => !t.skipReason).length,
    0
  );
  if (keyed === 0) {
    console.log('SYNC-NOOP no provider is reachable; nothing to scan.');
    return;
  }

  if (!(await confirmWord('chay', 'Gõ "chay" để bắt đầu quét model của các nhà cung cấp trên: '))) {
    console.log('SYNC-REFUSED step=pre-scan (không nhận được "chay").');
    process.exitCode = 2;
    return;
  }

  console.log(`SYNC-SCAN-START gap_ms=${gapMs} timeout_ms=${timeoutMs}`);
  const meta1 = new Map();
  const incomplete1 = new Set<string>();
  const round1 = await scanAll(views, 1, timeoutMs, false, incomplete1, meta1);

  console.log(`SYNC-SCAN-WAIT ${gapMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, gapMs));

  const meta2 = new Map();
  const incomplete2 = new Set<string>();
  const round2 = await scanAll(views, 2, timeoutMs, false, incomplete2, meta2);

  const incompleteAll = new Set<string>([...incomplete1, ...incomplete2]);
  const catalog = loadCatalogCounts();
  const providers = buildProviderLive(views, round1, round2, catalog, incompleteAll);
  const combos = views.flatMap((v) => v.combos);
  const trustLowMatch = new Set(config['trust-low-match'] ?? []);
  const plan = computeSyncPlan({ providers, combos, trustLowMatch });

  {
    const rows: ScanCompletenessRow[] = [];
    for (const v of views) {
      for (const t of v.targets) {
        let host = '';
        try { host = t.baseUrl ? new URL(t.baseUrl).host : ''; } catch { host = t.baseUrl ?? ''; }
        const m1 = meta1.get(`${v.name}:${t.prefix}`);
        const m2 = meta2.get(`${v.name}:${t.prefix}`);
        const status = m2?.status ?? m1?.status ?? 0;
        rows.push({
          router: v.name,
          prefix: t.prefix,
          host,
          path: '/v1/models',
          key: t.keySource,
          status,
          countR1: round1.get(`${v.name}:${t.prefix}`)?.length ?? 0,
          countR2: round2.get(`${v.name}:${t.prefix}`)?.length ?? 0,
          pagination: 'unknown',
          conclusion: status > 0 ? 'COMPLETE' : 'UNKNOWN-NO-SIGNAL',
          first3: (round2.get(`${v.name}:${t.prefix}`) ?? round1.get(`${v.name}:${t.prefix}`) ?? []).slice(0, 3).join(','),
          r1Time: '',
          r2Time: '',
          rawCount: round2.get(`${v.name}:${t.prefix}`)?.length ?? 0,
        });
      }
    }
    console.log(buildScanCompleteness(rows, ['Bảng completeness nhúng từ đường sync 2 vòng (C3 G1)']));
  }

  printPlan(plan, views);

  const dbPathsByRouter: Record<string, string> = {};
  for (const v of views) dbPathsByRouter[v.name] = v.dbPath;

  if (!options.apply) {
    writePendingPlan(plan, dbPathsByRouter);
    console.log(
      'SYNC-PLAN-ONLY (không ghi gì). Thêm --apply để áp dụng sau khi xem kế hoạch.'
    );
    return;
  }

  if (plan.totalRemovals === 0) {
    console.log('SYNC-NOOP remove=0, không cần ghi.');
    return;
  }

  // The apply run rescans; the owner approved a specific plan, not "whatever
  // the next scan says". A changed plan aborts before any write.
  const pending = readPendingPlan();
  if (!pending) {
    console.log('SYNC-REFUSED step=no-shown-plan (chưa có kế hoạch nào được duyệt).');
    process.exitCode = 2;
    return;
  }
  if (pending.planHash !== plan.planHash) {
    console.log(
      `SYNC-PLAN-CHANGED shown=${pending.planHash} remove_shown=${pending.totalRemovals} now=${plan.planHash} remove_now=${plan.totalRemovals}`
    );
    console.log('SYNC-REFUSED step=plan-changed (chay lại không --apply rồi duyệt lại).');
    process.exitCode = 2;
    return;
  }
  // C4n/N5: the plan was shown for a specific database. Refuse to write when
  // the current database is a different file: the plan describes one database
  // and the write must land in that same one.
  if (pending.dbPaths) {
    for (const [router, shownPath] of Object.entries(pending.dbPaths)) {
      const nowPath = dbPathsByRouter[router];
      if (!nowPath) continue;
      if (path.resolve(nowPath) !== path.resolve(shownPath)) {
        console.log(
          `SYNC-DB-CHANGED router=${router} shown="${shownPath}" now="${nowPath}"`
        );
        console.log(
          'SYNC-REFUSED step=db-path-changed (kế hoạch được tính trên một DB khác; chạy lại không --apply để duyệt lại).'
        );
        process.exitCode = 2;
        return;
      }
    }
  }
  console.log(
    `SYNC-PLAN-CONFIRMED planHash=${plan.planHash} remove=${plan.totalRemovals} combos=${plan.changedCombos}`
  );

  // R5: a big removal needs the exact number retyped.
  if (plan.warnings.length > 0) {
    console.log(`SYNC-BIG-REMOVAL cần gõ lại đúng số bước sẽ gỡ: ${plan.totalRemovals}`);
    if (
      !(await confirmWord(
        String(plan.totalRemovals),
        `Gõ lại đúng số bước sẽ gỡ (${plan.totalRemovals}): `
      ))
    ) {
      console.log('SYNC-REFUSED step=big-removal-count');
      process.exitCode = 2;
      return;
    }
  }

  if (!(await confirmWord('chay', 'Gõ "chay" để sao lưu và áp dụng kế hoạch trên: '))) {
    console.log('SYNC-REFUSED step=pre-apply (không nhận được "chay").');
    process.exitCode = 2;
    return;
  }
  // Token ghi-live chỉ cấp tại điểm này (chủ đã gõ "chay").
  grantLiveWriteToken();

  await applyPlan(views, plan);
}

async function applyPlan(views: RouterView[], plan: SyncPlan): Promise<void> {
  const record = {
    at: new Date().toISOString(),
    planHash: plan.planHash,
    routers: {} as Record<string, { backup: string; changed: string[] }>,
  };

  for (const view of views) {
    const changes: ComboChange[] = plan.combos
      .filter((c) => c.router === view.name && c.removals.length > 0)
      .map((c) => ({ id: c.id, name: c.name, remove: c.removals }));
    if (changes.length === 0) continue;

    // C4n/N5: the plan was computed from view.dbPath; refuse to write a
    // different file.
    try {
      assertWriteTargetMatchesPlan(view.name, view.dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      continue;
    }

    let backup;
    try {
      backup = backupRouterDb(view.name);
    } catch (err) {
      console.log(
        `SYNC-BACKUP-FAIL router=${view.name} error=${
          err instanceof Error ? err.message : String(err)
        }`
      );
      console.log('SYNC-ABORT không ghi gì cho router này.');
      continue;
    }
    console.log(
      `SYNC-BACKUP router=${view.name} path=${backup.path} bytes=${backup.bytes} integrity=${backup.integrity}`
    );
    if (backup.integrity !== 'ok') {
      console.log(`SYNC-ABORT router=${view.name} backup integrity != ok`);
      continue;
    }

    const fenceBefore = tableFence(view.name);
    const fenceDetailBefore = tableFenceDetail(view.name);
    const outcome = applyStepRemovals(view.name, changes);
    const fenceAfter = tableFence(view.name);
    const fenceDetailAfter = tableFenceDetail(view.name);

    console.log(
      `SYNC-FENCE router=${view.name} before=${fenceBefore.digest} after=${fenceAfter.digest} tables=${fenceBefore.tables} same=${
        fenceBefore.digest === fenceAfter.digest
      }`
    );
    // G4: mỗi bảng một dòng SAME/DIFF; `combos` DIFF là thay đổi mong đợi.
    {
      const diff = diffFenceTables(fenceDetailBefore, fenceDetailAfter);
      for (const row of diff.rows) {
        console.log(
          `SYNC-FENCE-TABLE router=${view.name} table=${row.table} status=${row.status} expected=${row.expected} countBefore=${row.countBefore ?? '?'} countAfter=${row.countAfter ?? '?'} hashBefore=${row.hashBefore?.slice(0, 12) ?? '-'} hashAfter=${row.hashAfter?.slice(0, 12) ?? '-'}`
        );
      }
      console.log(
        `SYNC-FENCE-VERDICT router=${view.name} tables=${diff.rows.length} unexpectedDiff=${diff.unexpectedDiff} verdict=${diff.verdict}`
      );
    }

    const readBack = readComboModels(view.name);
    for (const change of outcome.written) {
      const current = readBack.get(change.name) ?? [];
      const expected = outcome.after[change.name] ?? 0;
      console.log(
        `SYNC-APPLY router=${view.name} combo=${change.name} ${
          outcome.before[change.name] ?? '?'
        } -> ${current.length} expected=${expected} ok=${
          current.length === expected
        }`
      );
    }
    for (const error of outcome.errors)
      console.log(`SYNC-APPLY-ERROR router=${view.name} ${error}`);

    if (!record.routers[view.name]) {
      record.routers[view.name] = { backup: backup.path, changed: [] };
    }
    record.routers[view.name]!.changed.push(...outcome.written.map((w) => w.name));
  }

  writeLastSync(record);
  // The plan has been consumed; a second --apply must not reuse it.
  deletePendingPlan();

  console.log('');
  console.log('SYNC-UNDO chay lệnh sau để hoàn tác:');
  for (const [router, entry] of Object.entries(record.routers)) {
    console.log(`  routersync undo --router ${router} --backup "${entry.backup}"`);
  }
  if (Object.keys(record.routers).length === 0) console.log('  (không có thay đổi nào được ghi)');
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

export async function runUndoCommand(options: UndoCommandOptions = {}): Promise<void> {
  // TTY gate for the write path runs BEFORE any state or DB read, so a
  // machine without a router still prints the refusal message.
  if (options.apply && !process.stdin.isTTY) {
    const msg =
      'Write Execution Blocked: `undo --apply` requires an interactive TTY terminal.\n' +
      'stdin is not a TTY, so the human confirmation word cannot be collected.\n' +
      'Non-interactive scripts or automated callers cannot bypass human confirmation.';
    // The CLI entry point prints the error once; do not print it here too.
    process.exitCode = 1;
    throw new Error(msg);
  }

  const record = readLastSync();
  const routerName = (options.router ?? '9router') as RouterName;

  const backupPath =
    options.backup ??
    record?.routers[routerName]?.backup ??
    listBackups(routerName)[0]?.path;

  if (!backupPath || !fs.existsSync(backupPath)) {
    console.log(
      `UNDO-NOOP router=${routerName} reason=no-backup dir=${backupsDirectory()}`
    );
    return;
  }

  const changed = record?.routers[routerName]?.changed ?? [];
  console.log(
    `UNDO-PLAN router=${routerName} backup=${backupPath} combos=${
      changed.length > 0 ? changed.join(',') : '(toàn bộ)'
    }`
  );

  if (!options.apply) {
    try {
      const previews = previewUndoStepCounts(routerName, backupPath);
      for (const p of previews) {
        console.log(
          `UNDO-COUNT router=${routerName} combo=${p.name} hiện-tại=${p.current} bản-sao-lưu=${p.backup} (phục-hồi ${p.current}→${p.backup})`
        );
      }
    } catch {
      // preview error ignored
    }
    console.log('UNDO-PLAN-ONLY (không ghi gì). Thêm --apply để hoàn tác thật.');
    return;
  }

  if (!(await confirmWord('chay', `Gõ "chay" để khôi phục combo từ ${backupPath}: `))) {
    console.log('UNDO-REFUSED (không nhận được "chay").');
    process.exitCode = 2;
    return;
  }
  grantLiveWriteToken();

  const fenceBefore = tableFence(routerName);
  const outcome = restoreCombosFromBackup(routerName, backupPath);
  const fenceAfter = tableFence(routerName);

  for (const entry of outcome.written) {
    console.log(
      `UNDO-APPLY router=${routerName} combo=${entry.name} ${
        outcome.before[entry.name] ?? '?'
      } -> ${outcome.after[entry.name] ?? '?'}`
    );
  }
  for (const error of outcome.errors)
    console.log(`UNDO-APPLY-ERROR router=${routerName} ${error}`);
  console.log(
    `UNDO-FENCE before=${fenceBefore.digest} after=${fenceAfter.digest} same=${
      fenceBefore.digest === fenceAfter.digest
    }`
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runSyncStatusCommand(options: SyncCommandOptions = {}): Promise<void> {
  const { config } = loadConfigFile(options.configPath);
  const record = readLastSync();

  for (const router of config.routers) {
    const name = router.adapter as RouterName;
    const adapter = createAdapterForRouter(router);
    const combos = await adapter.readCombos();
    const steps = combos.reduce((n, c) => n + c.models.length, 0);
    const backups = listBackups(name);
    console.log(
      `SYNC-STATUS router=${name} db=${resolveRouterDbPath(router)} combos=${combos.length} steps=${steps} backups=${backups.length}`
    );
    for (const combo of combos.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  combo=${combo.name} steps=${combo.models.length}`);
    }
    const last = record?.routers[name];
    if (last) {
      console.log(
        `  last-sync at=${record?.at ?? '?'} plan=${record?.planHash ?? '?'} changed=${
          last.changed.join(',')
        }`
      );
    }
    if (backups[0]) console.log(`  newest-backup ${backups[0].path}`);
  }

  if (options.json) {
    console.log(JSON.stringify({ lastSync: record, backupsDir: backupsDirectory() }, null, 2));
  }
}
