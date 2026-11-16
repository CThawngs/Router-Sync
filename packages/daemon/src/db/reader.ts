/**
 * packages/daemon/src/db/reader.ts
 *
 * Strictly read-only SQLite reader for router state (S1 Read-Only Slice).
 * Enforces zero-write capability via @routersync/core/readonly (R9-8),
 * handles transient locks as soft degradations (B-2),
 * and prevents wal/shm creation on read-only databases (B-3 / AT-122).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openReadOnlyDb, type ReadOnlySqliteDb, locateRouterDb } from '@routersync/core/readonly';
import type { ResponseMeta } from '../types.js';

export { locateRouterDb } from '@routersync/core/readonly';

export interface RouterDbReadResult<T = unknown> {
  ok: boolean;
  meta: ResponseMeta;
  data?: T;
  dbPath: string;
  exists: boolean;
}

export interface ParsedComboRecord {
  id: string;
  name: string;
  /**
   * R17-0.2: the strategy the router really stores, or ABSENT when it stores
   * none (no entry, or an entry that is not a usable string). It is never
   * replaced by a guessed default: `round-robin` / `priority` were constants
   * in this file, not values read from 9Router / OmniRoute.
   */
  strategy?: string;
  models: string[];
  managed: boolean;
}

/**
 * R16-1 (AT-143): normalize ONE raw 9Router `comboStrategies` value into the
 * string shape the daemon contract promises.
 *
 * 9Router stores the map inconsistently (observed on a real router in R15):
 * an old combo stores a plain string, a new combo stores the object
 * `{ fallbackStrategy: string }`. Reading that object straight into the
 * `strategy: string` field shipped a payload that broke its own contract and
 * crashed the React screen with "Objects are not valid as a React child".
 *
 * The ladder below reads a value, it does not invent one: string -> keep;
 * object carrying a string `fallbackStrategy` -> that value; anything else
 * (number, null, array, object with unknown keys) -> undefined, because the
 * router stored nothing usable.
 *
 * R17-0.2: this used to fall back to 'round-robin'. The repository has no
 * evidence that `round-robin` is 9Router's default for a combo with no entry
 * (`docs/adapters/9router.md` records explicit values only), so the daemon
 * says "not measured" instead of guessing.
 */
export function normalizeComboStrategyValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object' && 'fallbackStrategy' in value) {
    const inner = (value as { fallbackStrategy?: unknown }).fallbackStrategy;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return undefined;
}

export interface CombosBreakdown {
  combosManaged: number;
  combosAdopted: number;
}

export function readRouterCombosBreakdown(
  router: 'omniroute' | '9router'
): RouterDbReadResult<CombosBreakdown> {
  const result = readRouterCombos(router);
  if (!result.ok || !result.data) {
    return {
      ok: false,
      exists: result.exists,
      dbPath: result.dbPath,
      meta: result.meta,
    };
  }

  let combosManaged = 0;
  let combosAdopted = 0;
  for (const c of result.data) {
    if (c.managed) {
      combosManaged++;
    } else {
      combosAdopted++;
    }
  }

  return {
    ok: true,
    exists: true,
    dbPath: result.dbPath,
    meta: result.meta,
    data: {
      combosManaged,
      combosAdopted,
    },
  };
}

export function readRouterCombosCount(
  router: 'omniroute' | '9router'
): RouterDbReadResult<{ count: number }> {
  const result = readRouterCombos(router);
  if (!result.ok || !result.data) {
    return {
      ok: false,
      exists: result.exists,
      dbPath: result.dbPath,
      meta: result.meta,
    };
  }
  return {
    ok: true,
    exists: result.exists,
    dbPath: result.dbPath,
    meta: result.meta,
    data: { count: result.data.length },
  };
}

export function readRouterCombos(
  router: 'omniroute' | '9router'
): RouterDbReadResult<ParsedComboRecord[]> {
  const dbPath = locateRouterDb(router);
  const nowIso = new Date().toISOString();

  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      exists: false,
      dbPath,
      meta: { source: 'unavailable', reason: 'db_not_found', generatedAt: nowIso },
    };
  }

  let db: ReadOnlySqliteDb | null = null;
  try {
    db = openReadOnlyDb(dbPath);

    // Check if combos table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='combos'"
    ).get() as { name?: string } | undefined;

    if (!tableCheck || !tableCheck.name) {
      return {
        ok: false,
        exists: true,
        dbPath,
        meta: { source: 'unavailable', reason: 'schema_mismatch', generatedAt: nowIso },
      };
    }

    const combos: ParsedComboRecord[] = [];

    if (router === 'omniroute') {
      const rows = db.prepare('SELECT id, name, data FROM combos ORDER BY id ASC').all() as Array<{
        id: string;
        name: string;
        data?: string;
      }>;

      for (const row of rows) {
        // R17-0.2: no guessed default. Absent `strategy` in the row data means
        // the router did not measure one.
        let strategy: string | undefined;
        let models: string[] = [];
        let managed = row.id.startsWith('routersync-');

        if (row.data) {
          try {
            const parsed = JSON.parse(row.data) as Record<string, unknown>;
            // R18-2: the OmniRoute payload declares `strategy` as a string, so
            // only a NON-EMPTY string is a measured value. The old
            // `typeof === 'string'` test let `"strategy": ""` through and the
            // daemon then published an empty string as if it had been read.
            // The 9Router `{ fallbackStrategy }` shape is deliberately NOT
            // accepted here: it belongs to the other router's storage, and
            // reading it here would report a value this router never stored.
            const rawStrategy = parsed['strategy'];
            strategy =
              typeof rawStrategy === 'string' && rawStrategy.length > 0
                ? rawStrategy
                : undefined;
            if (Array.isArray(parsed['models'])) {
              models = parsed['models'].map((m: unknown) =>
                typeof m === 'string' ? m : String((m as Record<string, unknown>)['model'] ?? m)
              );
            }
            if (parsed['managed'] !== undefined) {
              managed = Boolean(parsed['managed']) || managed;
            }
          } catch {
            // Malformed data column, keep defaults
          }
        }

        combos.push({
          id: row.id,
          name: row.name,
          ...(strategy === undefined ? {} : { strategy }),
          models,
          managed,
        });
      }
    } else {
      // 9router: combos table (id, name, kind, models) + settings table for strategies
      let strategies: Record<string, string> = {};
      try {
        const settingsRow = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data?: string } | undefined;
        if (settingsRow?.data) {
          const parsed = JSON.parse(settingsRow.data) as Record<string, unknown>;
          const rawStrategies = parsed['comboStrategies'];
          if (typeof rawStrategies === 'object' && rawStrategies !== null && !Array.isArray(rawStrategies)) {
            // R15 (chạy RUN-S1 trên router thật): 9Router lưu `comboStrategies`
            // KHÔNG đồng nhất — combo cũ lưu chuỗi, combo mới lưu object
            // `{ fallbackStrategy: string }`. Trước đây daemon gán thẳng giá
            // trị đó vào `strategy` (khai báo là `string`) → payload vi phạm
            // contract của chính daemon và làm UI React crash với
            // "Objects are not valid as a React child". Chuẩn hoá tại đây,
            // same ladder as adapter-9router (see normalizeComboStrategyValue).
            const raw = rawStrategies as Record<string, unknown>;
            for (const [name, value] of Object.entries(raw)) {
              const normalized = normalizeComboStrategyValue(value);
              if (normalized !== undefined) strategies[name] = normalized;
            }
          }
        }
      } catch {
        // If settings table not available or malformed
      }

      const rows = db.prepare('SELECT id, name, kind, models FROM combos ORDER BY id ASC').all() as Array<{
        id: string;
        name: string;
        kind?: string;
        models?: string;
      }>;

      for (const row of rows) {
        let models: string[] = [];
        if (row.models) {
          try {
            const parsed = JSON.parse(row.models) as unknown;
            if (Array.isArray(parsed)) {
              models = parsed.map(String);
            }
          } catch {
            // models is not JSON array
          }
        }

        // R17-0.2 (AT-143): a combo with NO entry in `comboStrategies` carries
        // NO strategy. Inventing 'round-robin' here made the payload state a
        // routing mode the router never stored.
        const strategy = strategies[row.name];
        // R14-5 (SPEC Cổng L mục 4): the managed marker for 9Router is the
        // `routersync-` id prefix plus the RouterSync managed-id ledger. `kind`
        // is NOT an ownership marker: a legacy row with kind='custom' is only
        // recognised so it can be cleaned up / rolled back later. Claiming
        // ownership of a user's own combo would be an unsafe over-reach.
        const managed = row.id.startsWith('routersync-');

        combos.push({
          id: row.id,
          name: row.name,
          ...(strategy === undefined ? {} : { strategy }),
          models,
          managed,
        });
      }
    }

    return {
      ok: true,
      exists: true,
      dbPath,
      meta: { source: 'live', generatedAt: nowIso },
      data: combos,
    };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string })?.code ?? '';
    const isBusy =
      errCode.includes('BUSY') ||
      errCode.includes('LOCKED') ||
      errMessage.toLowerCase().includes('busy') ||
      errMessage.toLowerCase().includes('locked');

    return {
      ok: false,
      exists: true,
      dbPath,
      meta: {
        source: 'unavailable',
        reason: isBusy ? 'db_busy' : 'db_unreadable',
        generatedAt: nowIso,
      },
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

export function locateCatalogDb(): string {
  if (process.env['ROUTERSYNC_CATALOG_DB_PATH']) {
    return path.resolve(process.env['ROUTERSYNC_CATALOG_DB_PATH']);
  }
  const stateDir = process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
  return path.resolve(path.join(stateDir, 'catalog.sqlite'));
}

export interface CatalogProviderRow {
  id: string;
  name: string;
  kind: string;
  endpoint?: string;
  status: string;
  lastSyncAt?: string;
  error?: string;
}

export interface CatalogModelRow {
  id: string;
  providerId: string;
  name: string;
  rawId: string;
  contextWindow?: number;
  pricing?: string;
  status: string;
  consecutiveMissing: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function readCatalogProviders(): RouterDbReadResult<CatalogProviderRow[]> {
  const dbPath = locateCatalogDb();
  const nowIso = new Date().toISOString();

  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      exists: false,
      dbPath,
      meta: { source: 'unavailable', reason: 'db_not_found', generatedAt: nowIso },
    };
  }

  let db: ReadOnlySqliteDb | null = null;
  try {
    db = openReadOnlyDb(dbPath);

    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_providers'").get();
    if (!tableCheck) {
      return {
        ok: true,
        exists: true,
        dbPath,
        meta: { source: 'live', generatedAt: nowIso },
        data: [],
      };
    }

    const rows = db.prepare('SELECT id, name, kind, endpoint, status, lastSyncAt, error FROM catalog_providers ORDER BY name ASC').all() as CatalogProviderRow[];
    return {
      ok: true,
      exists: true,
      dbPath,
      meta: { source: 'live', generatedAt: nowIso },
      data: rows,
    };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string })?.code ?? '';
    const isBusy =
      errCode.includes('BUSY') ||
      errCode.includes('LOCKED') ||
      errMessage.toLowerCase().includes('busy') ||
      errMessage.toLowerCase().includes('locked');

    return {
      ok: false,
      exists: true,
      dbPath,
      meta: {
        source: 'unavailable',
        reason: isBusy ? 'db_busy' : 'db_unreadable',
        generatedAt: nowIso,
      },
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

export function readCatalogModels(providerId?: string): RouterDbReadResult<CatalogModelRow[]> {
  const dbPath = locateCatalogDb();
  const nowIso = new Date().toISOString();

  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      exists: false,
      dbPath,
      meta: { source: 'unavailable', reason: 'db_not_found', generatedAt: nowIso },
    };
  }

  let db: ReadOnlySqliteDb | null = null;
  try {
    db = openReadOnlyDb(dbPath);

    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_models'").get();
    if (!tableCheck) {
      return {
        ok: true,
        exists: true,
        dbPath,
        meta: { source: 'live', generatedAt: nowIso },
        data: [],
      };
    }

    const query = providerId
      ? 'SELECT id, providerId, name, rawId, contextWindow, pricing, status, consecutiveMissing, firstSeenAt, lastSeenAt FROM catalog_models WHERE providerId = ? ORDER BY id ASC'
      : 'SELECT id, providerId, name, rawId, contextWindow, pricing, status, consecutiveMissing, firstSeenAt, lastSeenAt FROM catalog_models ORDER BY providerId ASC, id ASC';

    const rows = (providerId ? db.prepare(query).all(providerId) : db.prepare(query).all()) as CatalogModelRow[];
    return {
      ok: true,
      exists: true,
      dbPath,
      meta: { source: 'live', generatedAt: nowIso },
      data: rows,
    };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string })?.code ?? '';
    const isBusy =
      errCode.includes('BUSY') ||
      errCode.includes('LOCKED') ||
      errMessage.toLowerCase().includes('busy') ||
      errMessage.toLowerCase().includes('locked');

    return {
      ok: false,
      exists: true,
      dbPath,
      meta: {
        source: 'unavailable',
        reason: isBusy ? 'db_busy' : 'db_unreadable',
        generatedAt: nowIso,
      },
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}
