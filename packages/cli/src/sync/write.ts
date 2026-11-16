/**
 * packages/cli/src/sync/write.ts
 *
 * Narrow writer for `routersync sync` (ROUND 56 §3 rule R4).
 *
 * The generic `applyPlan` path rewrites 9Router's `settings.comboStrategies`
 * and normalises `kind`, which is outside the allowed blast radius. This
 * writer touches exactly one column of exactly one row per changed combo:
 *
 *   - 9Router   `UPDATE combos SET models=?, updatedAt=? WHERE id=? AND name=?`
 *   - OmniRoute `UPDATE combos SET data=?, updated_at=? WHERE id=? AND name=?`
 *
 * Every write is preceded by a schema fingerprint check and by an online
 * SQLite backup of the whole file. Nothing else is touched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  assertFingerprint,
  locateRouterDb,
  openBetterSqlite3,
  type SqliteDriver,
} from '@routersync/core';
import { NINEROUTER_SCHEMA } from '@routersync/adapter-9router';
import { OMNIROUTE_SCHEMA } from '@routersync/adapter-omniroute';
import { fingerprintDb, type Opener as FenceOpener } from '@routersync/daemon';

export type RouterName = '9router' | 'omniroute';

// ---------------------------------------------------------------------------
// D1 write-guard: assertWritePathAllowed — chặn ghi nhầm vào DB router thật.
// Thư mục thật tính MỘT LẦN lúc module load (frozen), nên việc test giả
// APPDATA/USERPROFILE sau đó không làm guard mất dấu thư mục thật. Ghi thật
// chỉ khi có token do luồng "chay" của chủ cấp (grantLiveWriteToken, gọi từ
// sync-cli sau khi chủ gõ "chay"); chế độ test từ chối cứng không ngoại lệ.
// ---------------------------------------------------------------------------

/** ponytail: token ghi-live chỉ đổi lúc "chay"; không lưu token ra đĩa. */
let liveWriteToken: string | undefined;

export function grantLiveWriteToken(token = 'routersync-live-write'): string {
  liveWriteToken = token;
  return token;
}
export function revokeLiveWriteToken(): void {
  liveWriteToken = undefined;
}
/** E7: consume token single-use — validates then revokes; second use throws. */
export function consumeLiveWriteToken(token?: string): string {
  const t = token ?? process.env['ROUTERSYNC_LIVE_WRITE_TOKEN'] ?? liveWriteToken;
  if (!t || t !== liveWriteToken) throw new Error('WRITE-GUARD: live-write token missing, invalid, or already consumed (single-use).');
  liveWriteToken = undefined;
  return t;
}

function isTestMode(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['VITEST'] === '1' ||
    process.env['ROUTERSYNC_TEST_MODE'] === '1'
  );
}

function realDir(p: string): string {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    try {
      const parent = fs.realpathSync.native(path.dirname(p));
      return path.join(parent, path.basename(p)).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  }
}

function liveRouterDirsAtLoad(): string[] {
  const home = os.homedir();
  const appDataAtLoad =
    process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
  const dirs = [
    path.join(home, '.omniroute'),
    path.join(appDataAtLoad, '9router'),
    path.join(home, 'AppData', 'Roaming', '9router'),
    path.join(home, '.config', '9router'),
  ];
  return [...new Set(dirs.map((d) => realDir(d)))];
}

const LIVE_ROUTER_DIRS: string[] = liveRouterDirsAtLoad();

export function liveRouterDirs(): string[] {
  return [...LIVE_ROUTER_DIRS];
}

function isInsideLiveDir(realPath: string): string | undefined {
  const normalized = realPath.toLowerCase();
  return LIVE_ROUTER_DIRS.find(
    (d) => normalized === d || normalized.startsWith(d + path.sep)
  );
}

/**
 * Guard duy nhất cho mọi hàm ghi. Ném lỗi khi path nằm trong thư mục router
 * thật, trừ khi có token ghi-live do luồng "chay" của chủ cấp. Chế độ test
 * từ chối cứng không có ngoại lệ (kể cả có token).
 */
export function assertWritePathAllowed(
  targetPath: string,
  opts: { token?: string | undefined } = {}
): void {
  const resolved = path.resolve(targetPath);
  const real = realDir(resolved);
  const liveDir = isInsideLiveDir(real);
  if (!liveDir) return;
  if (isTestMode()) {
    throw new Error(
      `WRITE-GUARD: test mode từ chối ghi vào thư mục router thật (${liveDir}): ${targetPath}`
    );
  }
  const token = opts.token ?? process.env['ROUTERSYNC_LIVE_WRITE_TOKEN'] ?? liveWriteToken;
  if (!token) {
    throw new Error(
      `WRITE-GUARD: từ chối ghi DB router thật (${liveDir}): ${targetPath}. Cần token ghi-live do chủ gõ "chay" cấp (grantLiveWriteToken).`
    );
  }
}

/**
 * C4n/N5: refuse to write when the write target is not the database the plan
 * was shown for.
 *
 * The plan the owner approved was computed from a specific database file. If
 * the write layer resolves a DIFFERENT file (a config change between the plan
 * and the apply, a stale path, a mis-set env override), the write would land
 * in a database nobody reviewed. In that case the write is refused and the
 * reason is printed instead.
 *
 * `plannedDbPath` is the path the plan was computed from (RouterView.dbPath).
 */
export function assertWriteTargetMatchesPlan(
  router: RouterName,
  plannedDbPath: string | undefined
): void {
  if (!plannedDbPath) return; // Nothing to compare against: the caller did not plan against a DB.
  const writeTarget = path.resolve(locateRouterDb(router));
  const planned = path.resolve(plannedDbPath);
  if (writeTarget === planned) return;
  throw new Error(
    `WRITE-GUARD: router '${router}' would be written at "${writeTarget}" but the shown plan was computed from "${planned}". ` +
    `Refusing to write: the plan and the write must target the same database. ` +
    `Re-run the plan after the database path change, or point routers[].db.path at the database the plan was computed from.`
  );
}

export interface ComboChange {
  id: string;
  name: string;
  /** Exact step strings to drop. Position is never used as an identifier. */
  remove: string[];
}

export interface ComboReorderChange {
  id: string;
  name: string;
  /** Exact proposed sequence of model IDs. */
  orderedModelIds: string[];
}

export interface RouterBackup {
  path: string;
  integrity: string;
  bytes: number;
}

export interface ApplyOutcome {
  written: ComboChange[];
  before: Record<string, number>;
  after: Record<string, number>;
  errors: string[];
}

export interface ReorderOutcome {
  written: ComboReorderChange[];
  before: Record<string, number>;
  after: Record<string, number>;
  errors: string[];
}

function backupsDir(): string {
  const base =
    process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'routersync', 'backups');
}

function stamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Online SQLite backup + integrity check, outside the router directory. */
export function backupRouterDb(router: RouterName): RouterBackup {
  const source = locateRouterDb(router);
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${router}-${stamp()}.sqlite`);

  const db = openBetterSqlite3(source, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    db.backup(dest);
  } finally {
    db.close();
  }

  const check = openBetterSqlite3(dest, { readOnly: true });
  let integrity = 'unknown';
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    integrity = row && typeof row === 'object' ? String(Object.values(row)[0]) : String(row);
  } finally {
    check.close();
  }

  return { path: dest, integrity, bytes: fs.statSync(dest).size };
}

/**
 * Content fence: digest over every table EXCEPT combos + hot write-heavy
 * tables (excluded so live traffic doesn't mask real changes).
 */
const HOT_TABLES = new Set(['usageHistory','requestDetails','call_logs','usage_history','usageDaily','request_details','provider_quota_state','quota_snapshots','combo_adaptation_state']);
export function tableFence(router: RouterName): { digest: string; tables: number } {
  const db = openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<Record<string, unknown>>;

    const parts: string[] = [];
    for (const row of rows) {
      const name = String(row['name'] ?? '');
      if (name === 'combos' || HOT_TABLES.has(name)) continue;
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as
        | Record<string, unknown>
        | undefined;
      parts.push(`${name}:${String(count?.['n'] ?? '?')}`);
    }
    return {
      digest: createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16),
      tables: parts.length,
    };
  } finally {
    db.close();
  }
}

/**
 * G4: per-table fingerprint (row count + sha256 of canonical rows) for one
 * router DB. Volatile connection keys are normalised by the shared daemon
 * fence, so a live testStatus ping does not look like a content change.
 * `combos` is included on purpose: it is the table a sync write touches, and
 * its change must be visible as an expected per-table DIFF.
 */
export function tableFenceDetail(router: RouterName): Array<{ table: string; count: number; hash: string }> {
  const opener = ((p: string) =>
    openBetterSqlite3(p, { readOnly: true, busyTimeoutMs: 5000 })) as unknown as FenceOpener;
  const fp = fingerprintDb(locateRouterDb(router), opener);
  return fp.tables.map((t) => ({ table: t.table, count: t.count, hash: t.hash }));
}

/** G4: one row of the per-table fence diff, ready to print or assert. */
export interface FenceTableDiff {
  table: string;
  status: 'SAME' | 'DIFF';
  expected: boolean;
  countBefore: number | null;
  countAfter: number | null;
  hashBefore: string | null;
  hashAfter: string | null;
}

/**
 * G4: compare two per-table fingerprints. `combos` is the only table a sync
 * apply is allowed to change, so any other DIFF is "unexpected" and makes the
 * verdict REVIEW instead of PASS. Tables missing on one side count as DIFF
 * (a table appearing or disappearing is never expected).
 */
export function diffFenceTables(
  before: readonly { table: string; count: number; hash: string }[],
  after: readonly { table: string; count: number; hash: string }[],
  expectedTables: ReadonlySet<string> = new Set(['combos'])
): { rows: FenceTableDiff[]; unexpectedDiff: number; verdict: 'PASS' | 'REVIEW' } {
  const beforeMap = new Map(before.map((t) => [t.table, t]));
  const afterMap = new Map(after.map((t) => [t.table, t]));
  const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const rows: FenceTableDiff[] = [];
  let unexpectedDiff = 0;
  for (const table of names) {
    const b = beforeMap.get(table);
    const a = afterMap.get(table);
    const status = b && a && b.hash === a.hash && b.count === a.count ? 'SAME' : 'DIFF';
    const expected = expectedTables.has(table);
    if (status === 'DIFF' && !expected) unexpectedDiff += 1;
    rows.push({
      table,
      status,
      expected,
      countBefore: b?.count ?? null,
      countAfter: a?.count ?? null,
      hashBefore: b?.hash ?? null,
      hashAfter: a?.hash ?? null,
    });
  }
  return { rows, unexpectedDiff, verdict: unexpectedDiff === 0 ? 'PASS' : 'REVIEW' };
}

function readModels(db: SqliteDriver, router: RouterName): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (router === '9router') {
    const rows = db.prepare('SELECT name, models FROM combos').all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const name = String(row['name'] ?? '');
      try {
        const parsed: unknown = JSON.parse(String(row['models'] ?? '[]'));
        out.set(
          name,
          Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : []
        );
      } catch {
        out.set(name, []);
      }
    }
  } else {
    const rows = db.prepare('SELECT name, data FROM combos').all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const name = String(row['name'] ?? '');
      try {
        const parsed = JSON.parse(String(row['data'] ?? '{}')) as { models?: unknown };
        const raw = Array.isArray(parsed.models) ? parsed.models : [];
        out.set(
          name,
          raw
            .map((m) => (typeof m === 'string' ? m : (m as { model?: unknown })?.model))
            .filter((m): m is string => typeof m === 'string')
        );
      } catch {
        out.set(name, []);
      }
    }
  }
  return out;
}

/** Current combo step lists, keyed by combo name. Read-only. */
export function readComboModels(router: RouterName): Map<string, string[]> {
  const db = openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
  try {
    return readModels(db, router);
  } finally {
    db.close();
  }
}

export interface ComboDetail {
  id: string;
  name: string;
  models: string[];
}

/**
 * Read combos with their IDs and model lists. Read-only.
 * ponytail: simple combo detail projection; upgrade when combo metadata needed.
 */
export function readCombosWithDetails(router: RouterName): Map<string, ComboDetail> {
  const db = openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const out = new Map<string, ComboDetail>();
    if (router === '9router') {
      const rows = db.prepare('SELECT id, name, models FROM combos').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = String(row['id'] ?? '');
        const name = String(row['name'] ?? '');
        try {
          const parsed: unknown = JSON.parse(String(row['models'] ?? '[]'));
          out.set(name, {
            id,
            name,
            models: Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [],
          });
        } catch {
          out.set(name, { id, name, models: [] });
        }
      }
    } else {
      const rows = db.prepare('SELECT id, name, data FROM combos').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = String(row['id'] ?? '');
        const name = String(row['name'] ?? '');
        try {
          const parsed = JSON.parse(String(row['data'] ?? '{}')) as { models?: unknown };
          const raw = Array.isArray(parsed.models) ? parsed.models : [];
          out.set(name, {
            id,
            name,
            models: raw
              .map((m) => (typeof m === 'string' ? m : (m as { model?: unknown })?.model))
              .filter((m): m is string => typeof m === 'string'),
          });
        } catch {
          out.set(name, { id, name, models: [] });
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Applies the removals. Each change is matched by id AND name; a mismatch
 * aborts that change with a recorded error instead of falling back to a
 * positional guess.
 */
export function applyStepRemovals(router: RouterName, changes: ComboChange[]): ApplyOutcome {
  const outcome: ApplyOutcome = { written: [], before: {}, after: {}, errors: [] };
  if (changes.length === 0) return outcome;
  assertWritePathAllowed(locateRouterDb(router));

  const db = openBetterSqlite3(locateRouterDb(router), {
    busyTimeoutMs: 5000,
    allowLiveDbWrite: true,
  });
  const now = new Date().toISOString();

  try {
    assertFingerprint(db, router === '9router' ? NINEROUTER_SCHEMA : OMNIROUTE_SCHEMA);

    db.transaction(() => {
      for (const change of changes) {
        const removeSet = new Set(change.remove);

        if (router === '9router') {
          const row = db
            .prepare('SELECT id, name, models FROM combos WHERE id = ? AND name = ?')
            .get(change.id, change.name) as Record<string, unknown> | undefined;
          if (!row) {
            outcome.errors.push(`no-match id=${change.id} name=${change.name}`);
            continue;
          }
          const models = JSON.parse(String(row['models'] ?? '[]')) as string[];
          const kept = models.filter((m) => !removeSet.has(m));
          outcome.before[change.name] = models.length;
          outcome.after[change.name] = kept.length;
          db.prepare('UPDATE combos SET models = ?, updatedAt = ? WHERE id = ? AND name = ?').run(
            JSON.stringify(kept),
            now,
            change.id,
            change.name
          );
        } else {
          const row = db
            .prepare('SELECT id, name, data FROM combos WHERE id = ? AND name = ?')
            .get(change.id, change.name) as Record<string, unknown> | undefined;
          if (!row) {
            outcome.errors.push(`no-match id=${change.id} name=${change.name}`);
            continue;
          }
          const data = JSON.parse(String(row['data'] ?? '{}')) as Record<string, unknown>;
          const raw = Array.isArray(data['models']) ? data['models'] : [];
          const stepOf = (m: unknown): string | undefined =>
            typeof m === 'string' ? m : (m as { model?: string })?.model;
          const kept = raw.filter((m) => {
            const step = stepOf(m);
            return step === undefined || !removeSet.has(step);
          });
          outcome.before[change.name] = raw.length;
          outcome.after[change.name] = kept.length;
          data['models'] = kept;
          db.prepare('UPDATE combos SET data = ?, updated_at = ? WHERE id = ? AND name = ?').run(
            JSON.stringify(data),
            now,
            change.id,
            change.name
          );
        }
        outcome.written.push(change);
      }
    });
  } finally {
    db.close();
  }

  return outcome;
}

/**
 * Applies step reordering. Each change is matched by id AND name.
 * ponytail: narrow writer swapping step order in-place without touching combo settings.
 */
export function applyStepReordering(
  router: RouterName,
  changes: ComboReorderChange[]
): ReorderOutcome {
  const outcome: ReorderOutcome = { written: [], before: {}, after: {}, errors: [] };
  if (changes.length === 0) return outcome;
  assertWritePathAllowed(locateRouterDb(router));

  const db = openBetterSqlite3(locateRouterDb(router), {
    busyTimeoutMs: 5000,
    allowLiveDbWrite: true,
  });
  const now = new Date().toISOString();

  try {
    assertFingerprint(db, router === '9router' ? NINEROUTER_SCHEMA : OMNIROUTE_SCHEMA);

    db.transaction(() => {
      for (const change of changes) {
        if (router === '9router') {
          const row = db
            .prepare('SELECT id, name, models FROM combos WHERE id = ? AND name = ?')
            .get(change.id, change.name) as Record<string, unknown> | undefined;
          if (!row) {
            outcome.errors.push(`no-match id=${change.id} name=${change.name}`);
            continue;
          }
          const current = JSON.parse(String(row['models'] ?? '[]')) as string[];
          outcome.before[change.name] = current.length;
          outcome.after[change.name] = change.orderedModelIds.length;

          db.prepare('UPDATE combos SET models = ?, updatedAt = ? WHERE id = ? AND name = ?').run(
            JSON.stringify(change.orderedModelIds),
            now,
            change.id,
            change.name
          );
        } else {
          const row = db
            .prepare('SELECT id, name, data FROM combos WHERE id = ? AND name = ?')
            .get(change.id, change.name) as Record<string, unknown> | undefined;
          if (!row) {
            outcome.errors.push(`no-match id=${change.id} name=${change.name}`);
            continue;
          }
          const data = JSON.parse(String(row['data'] ?? '{}')) as Record<string, unknown>;
          const raw = Array.isArray(data['models']) ? data['models'] : [];
          const stepOf = (m: unknown): string | undefined =>
            typeof m === 'string' ? m : (m as { model?: string })?.model;

          const objMap = new Map<string, unknown>();
          for (const m of raw) {
            const step = stepOf(m);
            if (step) objMap.set(step, m);
          }

          const reordered = change.orderedModelIds
            .map((id) => objMap.get(id))
            .filter((m) => m !== undefined);

          outcome.before[change.name] = raw.length;
          outcome.after[change.name] = reordered.length;
          data['models'] = reordered;

          db.prepare('UPDATE combos SET data = ?, updated_at = ? WHERE id = ? AND name = ?').run(
            JSON.stringify(data),
            now,
            change.id,
            change.name
          );
        }
        outcome.written.push(change);
      }
    });
  } finally {
    db.close();
  }

  return outcome;
}

/**
 * Row-level restore of the `combos` table from a backup file. Only combo step
 * lists are copied back; nothing else is read from the backup into the router.
 */
export function restoreCombosFromBackup(router: RouterName, backupPath: string): ApplyOutcome {
  const outcome: ApplyOutcome = { written: [], before: {}, after: {}, errors: [] };
  assertWritePathAllowed(locateRouterDb(router));
  const backup = openBetterSqlite3(backupPath, { readOnly: true, busyTimeoutMs: 5000 });
  let saved: Map<string, { id: string; models: string[]; data?: string }>;
  try {
    saved = new Map();
    if (router === '9router') {
      const rows = backup.prepare('SELECT id, name, models FROM combos').all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const parsed: unknown = JSON.parse(String(row['models'] ?? '[]'));
        saved.set(String(row['name'] ?? ''), {
          id: String(row['id'] ?? ''),
          models: Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [],
        });
      }
    } else {
      const rows = backup.prepare('SELECT id, name, data FROM combos').all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const dataStr = String(row['data'] ?? '{}');
        const parsed = JSON.parse(dataStr) as { models?: unknown };
        const raw = Array.isArray(parsed.models) ? parsed.models : [];
        saved.set(String(row['name'] ?? ''), {
          id: String(row['id'] ?? ''),
          models: raw
            .map((m) => (typeof m === 'string' ? m : (m as { model?: unknown })?.model))
            .filter((m): m is string => typeof m === 'string'),
          data: dataStr,
        });
      }
    }
  } finally {
    backup.close();
  }

  const db = openBetterSqlite3(locateRouterDb(router), {
    busyTimeoutMs: 5000,
    allowLiveDbWrite: true,
  });
  const now = new Date().toISOString();
  try {
    assertFingerprint(db, router === '9router' ? NINEROUTER_SCHEMA : OMNIROUTE_SCHEMA);
    db.transaction(() => {
      for (const [name, entry] of saved) {
        const row = db
          .prepare('SELECT id, name, models FROM combos WHERE id = ? AND name = ?')
          .get(entry.id, name) as Record<string, unknown> | undefined;
        if (!row) {
          outcome.errors.push(`no-match name=${name}`);
          continue;
        }
        const current = JSON.parse(String(row['models'] ?? '[]')) as string[];
        outcome.before[name] = current.length;
        outcome.after[name] = entry.models.length;

        if (router === '9router') {
          db.prepare('UPDATE combos SET models = ?, updatedAt = ? WHERE id = ? AND name = ?').run(
            JSON.stringify(entry.models),
            now,
            entry.id,
            name
          );
        } else {
          db.prepare('UPDATE combos SET data = ?, updated_at = ? WHERE id = ? AND name = ?').run(
            entry.data ?? JSON.stringify({ models: entry.models }),
            now,
            entry.id,
            name
          );
        }
        outcome.written.push({ id: entry.id, name, remove: [] });
      }
    });
  } finally {
    db.close();
  }

  return outcome;
}

export interface UndoStepPreview {
  name: string;
  current: number;
  backup: number;
}

export function previewUndoStepCounts(router: RouterName, backupPath: string): UndoStepPreview[] {
  const result: UndoStepPreview[] = [];
  const backup = openBetterSqlite3(backupPath, { readOnly: true, busyTimeoutMs: 5000 });
  const live = openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
  try {
    if (router === '9router') {
      const bRows = backup.prepare('SELECT name, models FROM combos').all() as Array<Record<string, unknown>>;
      const lRows = live.prepare('SELECT name, models FROM combos').all() as Array<Record<string, unknown>>;
      const lMap = new Map<string, number>();
      for (const r of lRows) {
        const parsed = JSON.parse(String(r['models'] ?? '[]'));
        lMap.set(String(r['name'] ?? ''), Array.isArray(parsed) ? parsed.length : 0);
      }
      for (const r of bRows) {
        const name = String(r['name'] ?? '');
        const parsed = JSON.parse(String(r['models'] ?? '[]'));
        const bCount = Array.isArray(parsed) ? parsed.length : 0;
        const lCount = lMap.get(name) ?? 0;
        result.push({ name, current: lCount, backup: bCount });
      }
    } else {
      const bRows = backup.prepare('SELECT name, data FROM combos').all() as Array<Record<string, unknown>>;
      const lRows = live.prepare('SELECT name, data FROM combos').all() as Array<Record<string, unknown>>;
      const lMap = new Map<string, number>();
      for (const r of lRows) {
        const parsed = JSON.parse(String(r['data'] ?? '{}')) as { models?: unknown[] };
        lMap.set(String(r['name'] ?? ''), Array.isArray(parsed.models) ? parsed.models.length : 0);
      }
      for (const r of bRows) {
        const name = String(r['name'] ?? '');
        const parsed = JSON.parse(String(r['data'] ?? '{}')) as { models?: unknown[] };
        const bCount = Array.isArray(parsed.models) ? parsed.models.length : 0;
        const lCount = lMap.get(name) ?? 0;
        result.push({ name, current: lCount, backup: bCount });
      }
    }
  } finally {
    backup.close();
    live.close();
  }
  return result;
}

export interface BackupFile {
  path: string;
  router: string;
  mtime: number;
}

/** Backup files for one router, newest first. */
export function listBackups(router: RouterName): BackupFile[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${router}-`) && f.endsWith('.sqlite'))
    .map((f) => {
      const full = path.join(dir, f);
      return { path: full, router, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function backupsDirectory(): string {
  return backupsDir();
}
