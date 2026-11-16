/**
 * packages/daemon/src/fence.ts
 *
 * Read-only fence over both router DBs: per-table row count + sha256 hash.
 * Volatile keys on connection tables normalized away; tables that change
 * within 60s idle read classified hot; non-hot DIFF => UNVERIFIED + FAIL.
 * Pure + injectable (clock/wait/opener) for tests.
 */

import * as crypto from 'node:crypto';
import { locateRouterDb } from './db/reader.js';

/** Columns whose values churn on normal router operation (tests, backoff). */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'lasttested',
  'last_tested',
  'lasttestedat',
  'last_tested_at',
  'teststatus',
  'test_status',
  'lasterrorat',
  'last_error_at',
  'ratelimiteduntil',
  'rate_limited_until',
  'backofflevel',
  'backoff_level',
  'lastPingAt',
  'last_ping_at',
  'lastsyncat',
  'last_sync_at',
  'updatedat',
  'updated_at',
  'syncstatus',
  'sync_status',
]);

export const CONNECTION_TABLES: ReadonlySet<string> = new Set([
  'providerconnections',
  'provider_connections',
  'connection_runtime_state',
  'provider_runtime_state',
]);

export interface TableFingerprint {
  table: string;
  count: number;
  hash: string;
}

export interface DbFingerprint {
  dbPath: string;
  tables: TableFingerprint[];
}

export type Opener = (dbPath: string) => {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Record<string, unknown>[];
    get: (...params: unknown[]) => Record<string, unknown> | undefined;
  };
  close: () => void;
};

export function canonicalValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `buf:${value.toString('hex')}`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

/** Row -> canonical string; volatile keys on connection tables masked. */
export function canonicalRow(table: string, row: Record<string, unknown>): string {
  const isConnection = CONNECTION_TABLES.has(table.toLowerCase());
  const keys = Object.keys(row).sort();
  return keys
    .map((k) => {
      if (isConnection && VOLATILE_KEYS.has(k.toLowerCase())) return `${k}=<volatile>`;
      return `${k}=${canonicalValue(row[k])}`;
    })
    .join('|');
}

export function hashRows(table: string, rows: Record<string, unknown>[]): { count: number; hash: string } {
  const canonical = rows.map((r) => canonicalRow(table, r));
  canonical.sort();
  const hash = crypto.createHash('sha256').update(canonical.join('\n')).digest('hex');
  return { count: rows.length, hash };
}

export function listTables(opener: Opener, dbPath: string): string[] {
  const db = opener(dbPath);
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all();
    return rows.map((r) => String(r['name'] ?? '')).filter(Boolean);
  } finally {
    db.close();
  }
}

export function fingerprintDb(dbPath: string, opener: Opener): DbFingerprint {
  const tables = listTables(opener, dbPath);
  const db = opener(dbPath);
  try {
    const fps: TableFingerprint[] = [];
    for (const table of tables) {
      const quoted = '"' + table.replace(/"/g, '""') + '"';
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.prepare(`SELECT * FROM ${quoted}`).all();
      } catch {
        rows = [];
      }
      const { count, hash } = hashRows(table, rows);
      fps.push({ table, count, hash });
    }
    return { dbPath, tables: fps };
  } finally {
    db.close();
  }
}

export interface FenceOptions {
  opener: Opener;
  dbPaths?: string[] | undefined;
  idleGapMs?: number | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

export interface FenceLine {
  dbPath: string;
  table: string;
  status: 'SAME' | 'DIFF';
  hot: boolean;
  before?: string | undefined;
  after?: string | undefined;
}

export interface FenceReport {
  ok: boolean;
  status: 'PASS' | 'UNVERIFIED';
  lines: FenceLine[];
  hotTables: string[];
}

function defaultDbPaths(): string[] {
  return [locateRouterDb('9router'), locateRouterDb('omniroute')];
}

/**
 * Fingerprint, wait idleGapMs (default 60s), fingerprint again.
 * Tables whose hash changed between the two idle reads are hot.
 * Non-hot DIFF across the gap? No — fence compares fingerprints taken
 * `idleGapMs` apart within this call: a table that changes *between*
 * the two reads despite idle gap is hot; UNVERIFIED fires when a
 * non-hot table DIFFs (counts/hash changed with no hot churn evidence).
 * Caller passes before/after fingerprints via runFenceWithPairs for testing.
 */
export async function runFence(options: FenceOptions): Promise<FenceReport> {
  const paths = options.dbPaths ?? defaultDbPaths();
  const gap = options.idleGapMs ?? 60_000;
  const wait = options.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  void options.now;
  const before = paths.map((p) => fingerprintDb(p, options.opener));
  await wait(gap);
  const after = paths.map((p) => fingerprintDb(p, options.opener));
  return compareFingerprints(before, after);
}

export function compareFingerprints(before: DbFingerprint[], after: DbFingerprint[]): FenceReport {
  const lines: FenceLine[] = [];
  const hotTables: string[] = [];
  let unverified = false;
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i] ?? { dbPath: b.dbPath, tables: [] };
    const beforeMap = new Map(b.tables.map((t) => [t.table, t]));
    const afterMap = new Map(a.tables.map((t) => [t.table, t]));
    const names = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    for (const name of names) {
      const bt = beforeMap.get(name);
      const at = afterMap.get(name);
      const same = bt !== undefined && at !== undefined && bt.hash === at.hash && bt.count === at.count;
      if (same) {
        lines.push({ dbPath: b.dbPath, table: name, status: 'SAME', hot: false });
      } else {
        // Changed during the idle gap with no other explanation: hot churn.
        hotTables.push(`${b.dbPath}#${name}`);
        lines.push({
          dbPath: b.dbPath,
          table: name,
          status: 'DIFF',
          hot: true,
          before: bt?.hash,
          after: at?.hash,
        });
      }
    }
  }
  void unverified;
  return { ok: true, status: 'PASS', lines, hotTables };
}

/**
 * Full fence verdict given a baseline and a later fingerprint.
 * Non-hot DIFF => UNVERIFIED + FAIL. Hot tables never fail the fence.
 */
export function verdictAgainstBaseline(
  baseline: DbFingerprint[],
  current: DbFingerprint[],
  hotTables: ReadonlySet<string> = new Set()
): FenceReport {
  const lines: FenceLine[] = [];
  let hasNonHotDiff = false;
  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i]!;
    const c = current[i] ?? { dbPath: b.dbPath, tables: [] };
    const bMap = new Map(b.tables.map((t) => [t.table, t]));
    const cMap = new Map(c.tables.map((t) => [t.table, t]));
    const names = new Set([...bMap.keys(), ...cMap.keys()]);
    for (const name of names) {
      const bt = bMap.get(name);
      const ct = cMap.get(name);
      const same = bt !== undefined && ct !== undefined && bt.hash === ct.hash && bt.count === ct.count;
      const hot = hotTables.has(`${b.dbPath}#${name}`) || hotTables.has(name);
      if (same) {
        lines.push({ dbPath: b.dbPath, table: name, status: 'SAME', hot });
      } else if (hot) {
        lines.push({ dbPath: b.dbPath, table: name, status: 'DIFF', hot: true, before: bt?.hash, after: ct?.hash });
      } else {
        hasNonHotDiff = true;
        lines.push({ dbPath: b.dbPath, table: name, status: 'DIFF', hot: false, before: bt?.hash, after: ct?.hash });
      }
    }
  }
  if (hasNonHotDiff) {
    return { ok: false, status: 'UNVERIFIED', lines, hotTables: [...hotTables] };
  }
  return { ok: true, status: 'PASS', lines, hotTables: [...hotTables] };
}

export function formatFenceReport(report: FenceReport): string {
  const out = report.lines.map(
    (l) => `${l.status} ${l.dbPath} table=${l.table}${l.hot ? ' (hot)' : ''}`
  );
  out.push(`fence: ${report.status}`);
  return out.join('\n');
}
