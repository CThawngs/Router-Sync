/**
 * packages/adapter-omniroute/src/index.ts
 *
 * OmniRoute Tier 3 SQLite Adapter — Phase 2a rewrite.
 *
 * Changes from P1:
 *  - Uses SqliteDriver interface (better-sqlite3 under the hood) instead of
 *    node:sqlite. BEGIN IMMEDIATE + busy_timeout 5000 ms (T2-11).
 *  - Schema fingerprint check before any write (AT-97, T2-08).
 *  - Zod parse every combo row read or written (T2-10).
 *  - Read-back via three levels: full (API, with OMNIROUTE_API_KEY) /
 *    db-only (degraded, no key) — existence-only not possible on OmniRoute
 *    because /v1/models requires auth too (T2-14, decision 2026-10-14-04).
 *  - Read-back: with API key wait up to 12 s for cache TTL then poll once.
 *  - No hardcoded user paths (decision 2026-10-13-07, 2026-10-13-16).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type {
  ApplyResult,
  ComboDefinition,
  HealthStatus,
  ModelInfo,
  Plan,
  ReadBackLevel,
  RouterAdapter,
  Snapshot,
} from '@routersync/adapter-sdk';
import {
  createSnapshotEntity,
  openBetterSqlite3,
  assertFingerprint,
  resolveRouterKey,
  type OpenSqliteDriver,
  type TableSpec,
} from '@routersync/core';

// --------------------------------------------------------------------------
// Known-safe version range for OmniRoute
// --------------------------------------------------------------------------

const KNOWN_VERSIONS = ['3.8.50'];

// --------------------------------------------------------------------------
// Allowlist schema spec (AT-97, decision 2026-10-14-03)
// --------------------------------------------------------------------------

export const OMNIROUTE_SCHEMA: TableSpec[] = [
  {
    tableName: 'combos',
    requiredColumns: [
      { name: 'id',             type: 'TEXT',    required: true },
      { name: 'name',           type: 'TEXT',    required: true },
      { name: 'data',           type: 'TEXT',    required: true },
      { name: 'created_at',     type: 'TEXT',    required: true },
      { name: 'updated_at',     type: 'TEXT',    required: true },
      { name: 'sort_order',     type: 'INTEGER', required: true },
      { name: 'system_message', type: 'TEXT',    required: true },
    ],
    optionalColumns: [
      { name: 'tool_filter_regex',        type: 'TEXT',    required: false },
      { name: 'context_cache_protection', type: 'INTEGER', required: false },
    ],
  },
];

// --------------------------------------------------------------------------
// Zod schema for a raw DB row (T2-10)
// --------------------------------------------------------------------------

const OmniRouteComboRowSchema = z.object({
  id:             z.string(),
  name:           z.string(),
  data:           z.string(),
  sort_order:     z.number(),
  system_message: z.string().nullable(),
  updated_at:     z.string(),
});
type OmniRouteComboRow = z.infer<typeof OmniRouteComboRowSchema>;

// JSON payload inside data column
const OmniRouteDataPayloadSchema = z.object({
  strategy:  z.string().min(1).optional(),
  models:    z.array(z.union([z.string(), z.object({ model: z.string() }).passthrough()])).default([]),
  managed:   z.boolean().default(false),
  minSteps:  z.number().optional(),
  freeOnly:  z.boolean().optional(),
}).passthrough();

// --------------------------------------------------------------------------
// Read-back level type
// --------------------------------------------------------------------------

export type { ReadBackLevel };

export interface OmniRouteApplyResult extends ApplyResult {
  readBackLevel: ReadBackLevel;
  degradedReason?: string;
}

// --------------------------------------------------------------------------
// Adapter options
// --------------------------------------------------------------------------

export interface OmniRouteAdapterOptions {
  dbPath?: string | undefined;
  healthUrl?: string | undefined;
  /** API base URL for read-back (used when OMNIROUTE_API_KEY is set). */
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  adminApiKey?: string | undefined;
  clientApiKey?: string | undefined;
  readBackTtlWaitMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Inject a SqliteDriver factory for testing (default: openBetterSqlite3). */
  openDb?: OpenSqliteDriver | undefined;
}

// --------------------------------------------------------------------------
// Adapter
// --------------------------------------------------------------------------

export class OmniRouteAdapter implements RouterAdapter {
  readonly name = 'omniroute';
  readonly tier = 'T3' as const;

  private dbPath: string;
  private healthUrl: string;
  private apiBaseUrl: string;
  private apiKey?: string | undefined;
  private adminApiKey?: string | undefined;
  private clientApiKey?: string | undefined;
  private readBackTtlWaitMs?: number | undefined;
  private isCustomDbPath: boolean;
  private fetchFn: typeof fetch;
  private openDb: OpenSqliteDriver;

  constructor(options: OmniRouteAdapterOptions = {}) {
    this.healthUrl  = options.healthUrl  ?? 'http://localhost:30128/api/health';
    this.apiBaseUrl = options.apiBaseUrl ?? 'http://localhost:30128';
    this.apiKey     = options.apiKey;
    this.adminApiKey = options.adminApiKey ?? options.apiKey;
    this.clientApiKey = options.clientApiKey ?? options.apiKey;
    this.readBackTtlWaitMs = options.readBackTtlWaitMs;
    this.isCustomDbPath = Boolean(options.dbPath);
    this.fetchFn    = options.fetchFn    ?? globalThis.fetch;
    this.openDb     = options.openDb     ?? openBetterSqlite3;

    if (options.dbPath) {
      this.dbPath = options.dbPath;
    } else {
      // Dynamic home-dir resolution — zero personal hardcoding.
      this.dbPath = path.join(os.homedir(), '.omniroute', 'storage.sqlite');
    }
  }

  // ------------------------------------------------------------------------
  // Health (0-token liveness probe)
  // ------------------------------------------------------------------------

  async checkHealth(): Promise<HealthStatus> {
    const start = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const res = await this.fetchFn(this.healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Date.now() - start;
      return res.ok
        ? { ok: true,  status: 'ok',      latencyMs, timestamp }
        : { ok: false, status: 'degraded', latencyMs, timestamp,
            message: `HTTP ${res.status} ${res.statusText}` };
    } catch (err) {
      return { ok: false, status: 'down', latencyMs: Date.now() - start,
               timestamp, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------------------------
  // Read combos (read-only, with fingerprint + Zod parse)
  // ------------------------------------------------------------------------

  async readCombos(): Promise<ComboDefinition[]> {
    const db = this.openDb(this.dbPath, { readOnly: true });
    try {
      // Fingerprint check (warnings only in read path — do not block reads)
      const rows = db.prepare(
        'SELECT id, name, data, sort_order, system_message, updated_at FROM combos'
      ).all();

      return (rows as unknown[]).flatMap((raw: unknown) => {
        const parsed = OmniRouteComboRowSchema.safeParse(raw);
        if (!parsed.success) {
          process.stderr.write(
            `[routersync] OmniRoute: skipping malformed combo row: ${parsed.error.message}\n`
          );
          return [];
        }
        return [this.rowToCombo(parsed.data)];
      });
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------------------
  // readCatalog — extract unique model IDs from combos
  // ------------------------------------------------------------------------

  async readCatalog(): Promise<ModelInfo[]> {
    const combos = await this.readCombos();
    const modelSet = new Set<string>();
    for (const c of combos) for (const m of c.models) modelSet.add(m);
    return Array.from(modelSet).map((id) => ({
      id,
      provider: id.includes('/') ? id.split('/')[0]! : 'omniroute',
      status: 'active' as const,
    }));
  }

  // ------------------------------------------------------------------------
  // Snapshot
  // ------------------------------------------------------------------------

  async createSnapshot(): Promise<Snapshot> {
    const combos = await this.readCombos();
    return createSnapshotEntity(this.name, combos, { backupFilePath: this.dbPath });
  }

  // ------------------------------------------------------------------------
  // applyPlan — schema fingerprint → BEGIN IMMEDIATE → write → read-back
  // ------------------------------------------------------------------------

  async applyPlan(plan: Plan): Promise<OmniRouteApplyResult> {
    const appliedAt = new Date().toISOString();

    const db = this.openDb(this.dbPath, { busyTimeoutMs: 5000, allowLiveDbWrite: true });
    try {
      // AT-97: check schema BEFORE any write
      assertFingerprint(db, OMNIROUTE_SCHEMA);

      // T2-11: BEGIN IMMEDIATE is handled inside SqliteDriver.transaction()
      db.transaction(() => {
        const insertStmt = db.prepare(
          'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const updateStmt = db.prepare(
          'UPDATE combos SET name = ?, data = ?, updated_at = ?, sort_order = ?, system_message = ? ' +
          'WHERE id = ?'
        );
        const deleteStmt = db.prepare('DELETE FROM combos WHERE id = ?');

        for (const add of plan.additions) {
          const dataPayload = JSON.stringify(this.comboToPayload(add));
          insertStmt.run(add.id, add.name, dataPayload, appliedAt, appliedAt,
                         add.sortOrder ?? 0, add.systemMessage ?? null);
        }
        for (const mod of plan.modifications) {
          const dataPayload = JSON.stringify(this.comboToPayload(mod));
          updateStmt.run(mod.name, dataPayload, appliedAt,
                         mod.sortOrder ?? 0, mod.systemMessage ?? null, mod.id);
        }
        for (const delId of plan.deletions) {
          deleteStmt.run(delId);
        }
      });

    } catch (err) {
      db.close();
      return {
        success: false, target: this.name, appliedAt, planId: plan.id,
        readBackVerified: false, staleDetected: false,
        readBackLevel: 'db-only',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      db.close();
    }

    // AT-98: read-back via serving path
    return this.readBackAfterWrite(plan, appliedAt);
  }

  // ------------------------------------------------------------------------
  // rollback — restore snapshot into DB
  // ------------------------------------------------------------------------

  async rollback(snapshot: Snapshot): Promise<boolean> {
    const db = this.openDb(this.dbPath, { busyTimeoutMs: 5000, allowLiveDbWrite: true });
    try {
      db.transaction(() => {
        // Read current combos
        const rawRows = db.prepare(
          'SELECT id, name, data, created_at, updated_at, sort_order, system_message FROM combos'
        ).all() as unknown[];

        const currentCombos = rawRows.flatMap((raw) => {
          const parsed = OmniRouteComboRowSchema.safeParse(raw);
          return parsed.success ? [this.rowToCombo(parsed.data)] : [];
        });

        const currentMap = new Map(currentCombos.map((c) => [c.id, c]));
        const snapshotMap = new Map(snapshot.combos.map((c) => [c.id, c]));

        const insertStmt = db.prepare(
          'INSERT INTO combos (id, name, data, created_at, updated_at, sort_order, system_message) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const updateStmt = db.prepare(
          'UPDATE combos SET name = ?, data = ?, updated_at = ?, sort_order = ?, system_message = ? WHERE id = ?'
        );
        const deleteStmt = db.prepare('DELETE FROM combos WHERE id = ?');

        const isTouched = (id: string, isManaged: boolean): boolean => {
          if (isManaged) return true;
          const touched = snapshot.metadata?.['touchedComboIds'];
          return Array.isArray(touched) && touched.includes(id);
        };

        // 1. Delete rows in DB that are managed and were NOT in snapshot (added by RouterSync)
        for (const current of currentCombos) {
          if (!snapshotMap.has(current.id) && (current.managed || isTouched(current.id, current.managed))) {
            deleteStmt.run(current.id);
          }
        }

        // 2. Restore rows from snapshot that are managed or touched by RouterSync
        for (const snapCombo of snapshot.combos) {
          if (snapCombo.managed || isTouched(snapCombo.id, snapCombo.managed)) {
            const current = currentMap.get(snapCombo.id);
            if (!current) {
              const dataPayload = typeof snapCombo.rawData?.['__rawRowData'] === 'string'
                ? snapCombo.rawData['__rawRowData']
                : JSON.stringify(this.comboToPayload(snapCombo));
              insertStmt.run(
                snapCombo.id,
                snapCombo.name,
                dataPayload,
                snapCombo.updatedAt ?? snapshot.timestamp,
                snapCombo.updatedAt ?? snapshot.timestamp,
                snapCombo.sortOrder ?? 0,
                snapCombo.systemMessage ?? null
              );
            } else {
              // Only update if actually modified by RouterSync
              const isModified = current.name !== snapCombo.name ||
                current.sortOrder !== snapCombo.sortOrder ||
                current.systemMessage !== snapCombo.systemMessage ||
                current.rawData?.['__rawRowData'] !== snapCombo.rawData?.['__rawRowData'];

              if (isModified) {
                const dataPayload = typeof snapCombo.rawData?.['__rawRowData'] === 'string'
                  ? snapCombo.rawData['__rawRowData']
                  : JSON.stringify(this.comboToPayload(snapCombo));
                updateStmt.run(
                  snapCombo.name,
                  dataPayload,
                  snapCombo.updatedAt ?? snapshot.timestamp,
                  snapCombo.sortOrder ?? 0,
                  snapCombo.systemMessage ?? null,
                  snapCombo.id
                );
              }
            }
          }
        }
      });
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  private rowToCombo(row: OmniRouteComboRow): ComboDefinition {
    let parsedData: Record<string, unknown> = {};
    try {
      parsedData = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      // malformed JSON — use empty
    }

    const payload = OmniRouteDataPayloadSchema.safeParse(parsedData);
    const data = payload.success ? payload.data : { strategy: undefined, models: [], managed: false };

    const models: string[] = data.models.map((m: unknown) =>
      typeof m === 'string' ? m : String((m as Record<string, unknown>)['model'])
    );

    const combo: ComboDefinition = {
      id:            row.id,
      name:          row.name,
      models,
      managed:       data.managed,
      minSteps:      data.minSteps,
      freeOnly:      data.freeOnly,
      sortOrder:     row.sort_order,
      updatedAt:     row.updated_at,
      systemMessage: row.system_message ?? undefined,
      rawData:       { ...parsedData, __rawRowData: row.data },
    };
    if (data.strategy !== undefined) {
      combo.strategy = data.strategy;
    }
    return combo;
  }

  private comboToPayload(combo: ComboDefinition): Record<string, unknown> {
    const raw = { ...(combo.rawData ?? {}) };
    delete (raw as Record<string, unknown>).__rawRowData;
    delete (raw as Record<string, unknown>).models;
    delete (raw as Record<string, unknown>).managed;
    delete (raw as Record<string, unknown>).minSteps;
    delete (raw as Record<string, unknown>).freeOnly;
    const payload: Record<string, unknown> = {
      ...raw,
      models:    combo.models,
      managed:   combo.managed,
      minSteps:  combo.minSteps,
      freeOnly:  combo.freeOnly,
    };
    if (combo.strategy !== undefined) {
      payload.strategy = combo.strategy;
    }
    return payload;
  }

  /**
   * Read-back via serving path (AT-98, decision 2026-10-14-04).
   *
   * Level selection:
   *  - OMNIROUTE_API_KEY present → 'full': GET /api/combos after 12 s TTL wait.
   *  - No key → 'db-only' (degraded): read directly from DB, warn user.
   *
   * Note: /v1/models also requires auth on OmniRoute (verified L2 in Phase 0,
   * doc §3: "Unauthenticated GET /v1/models returns HTTP 401"), so
   * existence-only level is not available without credentials.
   */
  private async readBackAfterWrite(plan: Plan, appliedAt: string): Promise<OmniRouteApplyResult> {
    const adminResolved = resolveRouterKey('omniroute', process.env, { scope: 'elevated' });
    const clientResolved = resolveRouterKey('omniroute', process.env, { scope: 'client' });
    const adminKey = this.adminApiKey ?? (this.isCustomDbPath ? undefined : (adminResolved ? process.env[adminResolved.name] : undefined));
    const clientKey = this.clientApiKey ?? (this.isCustomDbPath ? undefined : (clientResolved ? process.env[clientResolved.name] : adminKey));

    if (adminKey) {
      // 'full' level: poll until cache refreshes up to TTL wait (OmniRoute combo expansion TTL ≤ 12 s)
      const maxWaitMs = this.readBackTtlWaitMs ?? 12_000;
      const startPoll = Date.now();
      let lastReason = '';
      let apiCombosEverOk = false;

      while (Date.now() - startPoll <= maxWaitMs) {
        try {
          const res = await this.fetchFn(`${this.apiBaseUrl}/api/combos`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${adminKey}` },
          });
          if (res.ok) {
            apiCombosEverOk = true;
            const body = await res.json() as unknown;
            const verified = this.verifyApiReadBack(body, plan);
            if (verified.ok) {
              return {
                success: true, target: this.name, appliedAt, planId: plan.id,
                readBackVerified: true, staleDetected: false,
                readBackLevel: 'full',
                applyState: 'verified',
              };
            }
            lastReason = verified.reason ?? 'unknown';
          } else {
            lastReason = `HTTP ${res.status}`;
          }
        } catch (err) {
          lastReason = err instanceof Error ? err.message : String(err);
        }
        if (maxWaitMs === 0) break;
        await sleep(Math.min(500, maxWaitMs));
      }

      // If /api/combos responded 200, cache didn't reflect changes in time -> STALE
      if (apiCombosEverOk) {
        return {
          success: false, target: this.name, appliedAt, planId: plan.id,
          readBackVerified: false, staleDetected: true,
          readBackLevel: 'full',
          error: `Read-back STALE via API: ${lastReason}`,
        };
      }
      // Otherwise (/api/combos was 404, network error, etc.), fall through to existence-only
    }

    if (clientKey) {
      // Try existence-only via /v1/models with client key
      try {
        const modelsRes = await this.fetchFn(`${this.apiBaseUrl}/v1/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${clientKey}` },
        });
        if (modelsRes.ok) {
          const body = (await modelsRes.json()) as { data?: Array<{ id?: string }> };
          if (Array.isArray(body?.data)) {
            const modelIds = new Set(body.data.map((m) => m.id).filter(Boolean));
            let allFound = true;
            let missingItem = '';

            for (const add of plan.additions) {
              if (!modelIds.has(add.id) && !modelIds.has(add.name)) {
                allFound = false;
                missingItem = `Added "${add.name || add.id}" not listed in /v1/models`;
                break;
              }
            }

            if (allFound) {
              for (const delId of plan.deletions) {
                if (modelIds.has(delId)) {
                  allFound = false;
                  missingItem = `Deleted "${delId}" still listed in /v1/models`;
                  break;
                }
              }
            }

            if (allFound) {
              return {
                success: true,
                target: this.name,
                appliedAt,
                planId: plan.id,
                readBackVerified: true,
                staleDetected: false,
                readBackLevel: 'existence-only',
                applyState: 'verified',
              };
            } else {
              return {
                success: false,
                target: this.name,
                appliedAt,
                planId: plan.id,
                readBackVerified: false,
                staleDetected: true,
                readBackLevel: 'existence-only',
                error: `Read-back STALE via /v1/models: ${missingItem}`,
              };
            }
          }
        }
      } catch {
        // /v1/models error — fall through to db-only
      }
    }

    // 'db-only (degraded)': read back directly from SQLite
    process.stderr.write(
      `[routersync] OmniRoute: WARNING — read-back is db-only (degraded). ` +
      `Set OMNIROUTE_API_KEY with manage scope for full, or OMNIROUTE_CLIENT_KEY for existence-only read-back.\n`
    );

    const readBackCombos = await this.readCombos();
    const verified = this.verifyDbReadBack(readBackCombos, plan);

    return {
      success: verified.ok,
      target: this.name, appliedAt, planId: plan.id,
      readBackVerified: verified.ok,
      staleDetected: !verified.ok,
      readBackLevel: 'db-only (degraded)',
      degradedReason: 'no-serving-path-credentials',
      // Spec §33.3 / AT-109: db-only + serving-path unconfirmed → written-pending-reload
      applyState: verified.ok ? 'written-pending-reload' : undefined,
      ...(verified.ok ? {} : { error: `DB read-back mismatch: ${verified.reason}` }),
    };
  }

  private verifyApiReadBack(body: unknown, plan: Plan): { ok: boolean; reason?: string } {
    let items: unknown[] = [];
    if (Array.isArray(body)) {
      items = body;
    } else if (typeof body === 'object' && body !== null && 'combos' in body && Array.isArray((body as Record<string, unknown>)['combos'])) {
      items = (body as Record<string, unknown>)['combos'] as unknown[];
    } else {
      return { ok: false, reason: 'API response is not an array or { combos: [...] }' };
    }

    // Primary reconciliation key is `id` (unique, generated by RouterSync).
    // Name is matched only when the API record does not provide an `id`,
    // preventing name collisions from falsely masking a stale record.
    for (const add of plan.additions) {
      const found = items.some((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const rec = item as Record<string, unknown>;
        if (typeof rec['id'] === 'string') {
          return rec['id'] === add.id;
        }
        if (typeof rec['name'] === 'string') {
          return rec['name'] === add.name;
        }
        return false;
      });
      if (!found) {
        return { ok: false, reason: `Added combo "${add.id}" not found via API` };
      }
    }

    for (const delId of plan.deletions) {
      const found = items.some((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const rec = item as Record<string, unknown>;
        if (typeof rec['id'] === 'string') {
          return rec['id'] === delId;
        }
        if (typeof rec['name'] === 'string') {
          return rec['name'] === delId;
        }
        return false;
      });
      if (found) {
        return { ok: false, reason: `Deleted combo "${delId}" still visible via API` };
      }
    }
    return { ok: true };
  }

  private verifyDbReadBack(
    combos: ComboDefinition[],
    plan: Plan
  ): { ok: boolean; reason?: string } {
    const byId = new Map(combos.map((c) => [c.id, c]));
    for (const add of plan.additions) {
      const found = byId.get(add.id);
      if (!found) return { ok: false, reason: `Added combo "${add.id}" not in DB` };
    }
    for (const delId of plan.deletions) {
      if (byId.has(delId)) return { ok: false, reason: `Deleted combo "${delId}" still in DB` };
    }
    return { ok: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
