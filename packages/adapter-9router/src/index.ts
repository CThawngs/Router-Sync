/**
 * packages/adapter-9router/src/index.ts
 *
 * 9Router Tier 3 SQLite Adapter — Phase 2a rewrite.
 *
 * Changes from P1:
 *  - Uses SqliteDriver interface (better-sqlite3) instead of node:sqlite.
 *    BEGIN IMMEDIATE + busy_timeout 5000 ms (T2-11).
 *  - Schema fingerprint check before any write (AT-97, T2-09).
 *  - Zod parse every combo row and settings row (T2-10).
 *  - Read-back: 9Router is always 'db-only' (degraded).
 *    Both /api/combos and /v1/models require auth (verified L2 Phase 0, §3):
 *      GET /api/combos → HTTP 401
 *      GET /v1/models  → timed out unauthenticated
 *    TTL: code inspection (L1) says direct SQLite read per request → immediate.
 *    Empirical TTL to be confirmed at CHECKPOINT-LIVE; flag set UNVERIFIED.
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
import { normalizeReadBackLevel } from '@routersync/adapter-sdk';
import {
  createSnapshotEntity,
  openBetterSqlite3,
  assertFingerprint,
  recordManagedId,
  getManagedIds,
  resolveRouterKey,
  type OpenSqliteDriver,
  type SqliteDriver,
  type TableSpec,
} from '@routersync/core';

// --------------------------------------------------------------------------
// Known-safe version range for 9Router
// --------------------------------------------------------------------------

const KNOWN_VERSIONS = ['0.5.99'];

// --------------------------------------------------------------------------
// Allowlist schema spec (AT-97, decision 2026-10-14-03)
// --------------------------------------------------------------------------

export const NINEROUTER_SCHEMA: TableSpec[] = [
  {
    tableName: 'combos',
    requiredColumns: [
      { name: 'id',        type: 'TEXT',    required: true },
      { name: 'name',      type: 'TEXT',    required: true },
      { name: 'models',    type: 'TEXT',    required: true },
      { name: 'createdAt', type: 'TEXT',    required: true },
      { name: 'updatedAt', type: 'TEXT',    required: true },
      { name: 'kind',      type: 'TEXT',    required: false },  // nullable, optional
    ],
  },
  {
    tableName: 'settings',
    requiredColumns: [
      { name: 'id',   type: 'INTEGER', required: true },
      { name: 'data', type: 'TEXT',    required: true },
    ],
  },
];

// --------------------------------------------------------------------------
// Zod schemas for raw DB rows (T2-10)
// --------------------------------------------------------------------------

const NineRouterComboRowSchema = z.object({
  id:        z.string(),
  name:      z.string(),
  kind:      z.string().nullable(),
  models:    z.string(),   // JSON array string
  createdAt: z.string(),
  updatedAt: z.string(),
});
type NineRouterComboRow = z.infer<typeof NineRouterComboRowSchema>;

const NineRouterSettingsRowSchema = z.object({
  id:   z.number(),
  data: z.string(),
});

// R16-1 (AT-143): a 9Router `comboStrategies` map can hold any of these
// shapes per key — a plain string, the object `{ fallbackStrategy: string }`
// (observed on a real router in R15), or a malformed leftover. The entry
// schema therefore accepts ANY value and the per-key ladder in
// `loadStrategies` decides the string. Parsing the whole map with a strict
// union used to throw on a single malformed key and silently drop EVERY
// other combo's strategy, so the daemon and the adapter could disagree.
const NineRouterStrategyEntrySchema = z.unknown();

const NineRouterComboStrategiesSchema = z.record(z.string(), NineRouterStrategyEntrySchema).default({});

// --------------------------------------------------------------------------
// Read-back level type
// --------------------------------------------------------------------------

export type { ReadBackLevel };

export interface NineRouterApplyResult extends ApplyResult {
  readBackLevel: ReadBackLevel;
  degradedReason?: string | undefined;
  /**
   * TTL verification status.
   * 'unverified' until CHECKPOINT-LIVE measures actual reload latency.
   * Expected 'immediate' based on code inspection (L1) in Phase 0 §7.
   */
  ttlStatus: 'immediate-assumed' | 'verified-immediate' | 'verified-delayed';
}

// --------------------------------------------------------------------------
// Adapter options
// --------------------------------------------------------------------------

export interface NineRouterAdapterOptions {
  dbPath?: string | undefined;
  /**
   * AT-113: explicit isolation flag. When true, the adapter NEVER probes the
   * router's HTTP serving path (/v1/models) — used for fully isolated copies
   * (tests, lab sandboxes). dbPath alone must NOT disable probing: Linux/Docker
   * users who set db_path still get existence-only read-back against their
   * real router. Default false (probing enabled).
   */
  isolated?: boolean | undefined;
  healthUrl?: string | undefined;
  modelsUrl?: string | undefined;
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  clientApiKey?: string | undefined;
  readBackTtlWaitMs?: number | undefined;
  /**
   * Owner brief 2026-10-15 §4a: the serving-path wait ceiling MUST be >= 60 s
   * (Gate L / AT-111 measured reflection up to 31.2 s, n=3). A shorter ceiling
   * marks a correct live write STALE and triggers a wrongful rollback.
   * Configurable here and via router config `servingWaitMs`.
   */
  servingWaitMs?: number | undefined;
  /**
   * Optional state-directory override for the managed-id ledger (tests inject
   * a tmp dir; production uses the OS state dir via ROUTERSYNC_STATE_DIR or
   * the platform default). The VITEST branch was removed — the ledger write
   * path is real product code and must be covered by tests.
   */
  stateDir?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Inject SqliteDriver factory for testing. */
  openDb?: OpenSqliteDriver | undefined;
}

// --------------------------------------------------------------------------
// Adapter
// --------------------------------------------------------------------------

export class NineRouterAdapter implements RouterAdapter {
  readonly name = '9router';
  readonly tier = 'T3' as const;

  /** UNVERIFIED: assumed immediate until CHECKPOINT-LIVE measures TTL. */
  static readonly TTL_STATUS = 'immediate-assumed' as const;

  private dbPath: string;
  private isCustomDbPath: boolean;
  private isolated: boolean;
  /** Gate R / T3-15: ids written by THIS adapter instance (managed-row recognition). */
  private sessionWrittenIds: Set<string> = new Set<string>();
  private healthUrl: string;
  private modelsUrl: string;
  private apiKey?: string | undefined;
  private readBackTtlWaitMs?: number | undefined;
  /**
   * Owner brief 2026-10-15 §4a: serving-path wait ceiling. Default 60000 ms
   * (>= 60 s) because Gate L / AT-111 measured serving-path reflection at
   * 19,653–31,229 ms (n=3). Never lower this default without owner approval —
   * a shorter ceiling marks a correct live write STALE and rolls back wrongly.
   */
  private servingWaitMs: number = 60_000;
  /** State-directory override for the managed-id ledger (tests; see options). */
  private stateDir?: string | undefined;
  private fetchFn: typeof fetch;
  private openDb: OpenSqliteDriver;

  constructor(options: NineRouterAdapterOptions = {}) {
    this.healthUrl = options.healthUrl ?? (options.apiBaseUrl ? `${options.apiBaseUrl}/api/health` : 'http://localhost:20128/api/health');
    this.modelsUrl = options.modelsUrl ?? (options.apiBaseUrl ? `${options.apiBaseUrl}/v1/models` : 'http://localhost:20128/v1/models');
    this.readBackTtlWaitMs = options.readBackTtlWaitMs;
    this.servingWaitMs = options.servingWaitMs ?? 60_000;
    this.stateDir = options.stateDir;
    this.isCustomDbPath = Boolean(options.dbPath);
    this.isolated = Boolean(options.isolated);

    if (options.clientApiKey || options.apiKey) {
      this.apiKey = options.clientApiKey ?? options.apiKey;
    } else if (!this.isCustomDbPath) {
      // Priority: Least privilege client keys first, fallback to admin/general keys (SPEC §31 / G0-5)
      const resolved = resolveRouterKey('9router', process.env);
      this.apiKey = resolved ? process.env[resolved.name] : undefined;
    }

    this.fetchFn   = options.fetchFn   ?? globalThis.fetch;
    this.openDb    = options.openDb    ?? openBetterSqlite3;

    if (options.dbPath) {
      this.dbPath = options.dbPath;
    } else {
      // Dynamic AppData resolution — strictly neutral.
      const appData =
        process.env['APPDATA'] ??
        (os.platform() === 'win32'
          ? path.join(os.homedir(), 'AppData', 'Roaming')
          : path.join(os.homedir(), '.config'));
      this.dbPath = path.join(appData, '9router', 'db', 'data.sqlite');
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
  // Read combos (read-only, with Zod parse)
  // ------------------------------------------------------------------------

  async readCombos(): Promise<ComboDefinition[]> {
    const db = this.openDb(this.dbPath, { readOnly: true });
    try {
      // Load strategies from settings
      const strategies = this.loadStrategies(db);

      const rows = db.prepare(
        'SELECT id, name, kind, models, createdAt, updatedAt FROM combos'
      ).all();

      return (rows as unknown[]).flatMap((raw: unknown) => {
        const parsed = NineRouterComboRowSchema.safeParse(raw);
        if (!parsed.success) {
          process.stderr.write(
            `[routersync] 9Router: skipping malformed combo row: ${parsed.error.message}\n`
          );
          return [];
        }
        return [this.rowToCombo(parsed.data, strategies)];
      });
    } finally {
      db.close();
    }
  }

  // ------------------------------------------------------------------------
  // readCatalog
  // ------------------------------------------------------------------------

  async readCatalog(): Promise<ModelInfo[]> {
    const combos = await this.readCombos();
    const modelSet = new Set<string>();
    for (const c of combos) for (const m of c.models) modelSet.add(m);
    return Array.from(modelSet).map((id) => ({
      id,
      provider: id.includes('/') ? id.split('/')[0]! : '9router',
      status: 'active' as const,
    }));
  }

  // ------------------------------------------------------------------------
  // Snapshot (combos + settings)
  // ------------------------------------------------------------------------

  async createSnapshot(): Promise<Snapshot> {
    const combos = await this.readCombos();
    const db = this.openDb(this.dbPath, { readOnly: true });
    let settingsData: string | undefined;
    try {
      const raw = db.prepare('SELECT id, data FROM settings WHERE id = 1').get();
      const row = NineRouterSettingsRowSchema.safeParse(raw);
      if (row.success) settingsData = row.data.data;
    } finally {
      db.close();
    }
    return createSnapshotEntity(this.name, combos, {
      backupFilePath: this.dbPath,
      metadata: settingsData ? { settingsData } : undefined,
    });
  }

  // ------------------------------------------------------------------------
  // applyPlan — fingerprint → BEGIN IMMEDIATE → write → db-only read-back
  // ------------------------------------------------------------------------

  async applyPlan(plan: Plan): Promise<NineRouterApplyResult> {
    const appliedAt = new Date().toISOString();

    const db = this.openDb(this.dbPath, { busyTimeoutMs: 5000, allowLiveDbWrite: true });
    try {
      // AT-97: schema check BEFORE any write
      assertFingerprint(db, NINEROUTER_SCHEMA);

      // Load current settings
      const settingsObj = this.loadSettingsObj(db);
      const comboStrategies = NineRouterComboStrategiesSchema.parse(
        settingsObj['comboStrategies'] ?? {}
      );

      // Update strategy map (9Router stores object with fallbackStrategy)
      for (const add of plan.additions) {
        comboStrategies[add.name] = { fallbackStrategy: add.strategy };
      }
      for (const mod of plan.modifications) {
        comboStrategies[mod.name] = { fallbackStrategy: mod.strategy };
      }
      for (const delId of plan.deletions) {
        delete comboStrategies[delId];
      }

      settingsObj['comboStrategies'] = comboStrategies;

      // T2-11: BEGIN IMMEDIATE handled by transaction()
      db.transaction(() => {
        // Write settings
        db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)')
          .run(JSON.stringify(settingsObj));

        // Write combos
        const insertStmt = db.prepare(
          'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const updateStmt = db.prepare(
          'UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?'
        );
        const deleteStmt = db.prepare('DELETE FROM combos WHERE id = ?');

        for (const add of plan.additions) {
          // kind = NULL (Gate L finding, AT-111): 9Router serves only rows
          // whose `kind || "llm"` is in the allowed-kind list; 'custom' rows
          // never appear on /v1/models. Managed marker = `routersync-` id
          // prefix + state-dir ledger + session set (T3-15).
          insertStmt.run(add.id, add.name, null, JSON.stringify(add.models), appliedAt, appliedAt);
          this.sessionWrittenIds.add(add.id);
        }
        for (const mod of plan.modifications) {
          updateStmt.run(mod.name, null, JSON.stringify(mod.models), appliedAt, mod.id);
          this.sessionWrittenIds.add(mod.id);
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
        readBackLevel: 'db-only', degradedReason: 'no-api-path',
        canonicalReadBackLevel: normalizeReadBackLevel('db-only'),
        ttlStatus: NineRouterAdapter.TTL_STATUS,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      db.close();
    }

    // T3-15: persist written ids to the durable managed-id ledger so managed
    // recognition survives across processes. This is real product code (no
    // VITEST branch — owner brief 2026-10-15 §4b); tests inject a tmp state
    // dir via the `stateDir` option or ROUTERSYNC_STATE_DIR.
    for (const add of plan.additions) recordManagedId(add.id, this.stateDir);
    for (const mod of plan.modifications) recordManagedId(mod.id, this.stateDir);

    let lastHttpStatus: number | undefined;

    // AT-98: Try serving-path read-back via /v1/models (existence-only)
    // AT-113: probe the serving path unless EXPLICITLY isolated. `isolated: true`
    // means NEVER probe (any fetchFn); with the default fetch this is the real
    // HTTP probe against the user's router (dbPath alone must not disable it).
    if (!this.isolated) {
      // Owner brief 2026-10-15 §4a: POLL until the serving path reflects the
      // write or the wait ceiling is reached. Gate L / AT-111 measured
      // serving-path reflection at 19,653–31,229 ms (n=3) — a single immediate
      // probe would mark a CORRECT live write STALE and roll it back wrongly.
      // Poll interval shrinks with short configured wait ceilings (tests use a
      // short ceiling) but stays at 2 s for the production 60 s default.
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const defaultPollMs = 2_000;
      const waitMs = this.servingWaitMs;
      const pollIntervalMs = waitMs < defaultPollMs ? Math.max(25, Math.floor(waitMs / 4)) : defaultPollMs;
      const deadline = Date.now() + waitMs;
      let lastReason = '';
      let servingPathUnreadable = false;
      for (;;) {
        let listedIds: Set<string> | null = null;
        try {
          const res = await this.fetchFn(this.modelsUrl, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const body = (await res.json()) as { data?: Array<{ id?: string }> };
            if (Array.isArray(body?.data)) {
              listedIds = new Set(body.data.map((m) => m.id).filter(Boolean) as string[]);
            }
          } else {
            lastHttpStatus = res.status;
            // Non-OK: serving path cannot be read right now → db-only degraded
            // (spec 5.2), NOT STALE. Retry next cycle; never a false STALE.
            servingPathUnreadable = true;
            break;
          }
        } catch {
          // Endpoint unreachable right now → db-only degraded, NOT STALE.
          // No lastHttpStatus is recorded here: network errors stay 'no-api-path'.
          servingPathUnreadable = true;
          break;
        }

        if (listedIds) {
          let allFound = true;
          let missingItem = '';
          for (const add of plan.additions) {
            if (!listedIds.has(add.id) && !listedIds.has(add.name)) {
              allFound = false;
              missingItem = `Added "${add.name || add.id}" not listed in /v1/models`;
              break;
            }
          }
          if (allFound) {
            for (const mod of plan.modifications) {
              if (!listedIds.has(mod.id) && !listedIds.has(mod.name)) {
                allFound = false;
                missingItem = `Modified "${mod.name || mod.id}" not listed in /v1/models`;
                break;
              }
            }
          }
          if (allFound) {
            for (const delId of plan.deletions) {
              if (listedIds.has(delId)) {
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
              canonicalReadBackLevel: 'existence-only',
              applyState: 'verified',
              ttlStatus: 'verified-immediate',
            };
          }
          lastReason = missingItem;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
      }

      // Wait ceiling reached WITH readable 200-responses but no serving-path
      // confirmation → STALE. (Unreadable serving path already fell through
      // to db-only degraded above.)
      if (!servingPathUnreadable) {
        return {
          success: false,
          target: this.name,
          appliedAt,
          planId: plan.id,
          readBackVerified: false,
          staleDetected: true,
          readBackLevel: 'existence-only',
          canonicalReadBackLevel: 'existence-only',
          ttlStatus: 'verified-delayed',
          error:
            `Serving-path read-back STALE after ${this.servingWaitMs} ms wait ceiling ` +
            `(Gate L / AT-111 measured reflection at 19.7-31.2 s, n=3): ${lastReason || 'not listed in /v1/models'}`,
        };
      }
    }

    // Fall back to db-only read-back (degraded)
    process.stderr.write(
      `[routersync] 9Router: WARNING — read-back is db-only (degraded). ` +
      `Cache TTL: ${NineRouterAdapter.TTL_STATUS} (unverified empirically — use CHECKPOINT-LIVE to confirm).\n` +
      `[routersync] 9Router: applyState = written-pending-reload (Gate L / spec §33.3): ` +
      `serving-path reflection unconfirmed — combo visible on router only after reload/refresh. ` +
      `Gate L finding (COPY, Windows): combos with kind=null reflect on GET /v1/models at 19.7-31.2 s (n=3, AT-111); ` +
      `rows written with kind='custom' NEVER reflect.\n`
    );

    const readBackCombos = await this.readCombos();
    const byId = new Map(readBackCombos.map((c) => [c.id, c]));

    let verified = true;
    let mismatchReason = '';
    for (const add of plan.additions) {
      if (!byId.has(add.id)) { verified = false; mismatchReason = `Added "${add.id}" not in DB`; break; }
    }
    if (verified) {
      for (const mod of plan.modifications) {
        const found = byId.get(mod.id);
        if (!found || found.models.length !== mod.models.length || found.models.some((m, i) => m !== mod.models[i])) {
          verified = false;
          mismatchReason = `Modified "${mod.id}" models mismatch in DB`;
          break;
        }
      }
    }
    if (verified) {
      for (const delId of plan.deletions) {
        if (byId.has(delId)) { verified = false; mismatchReason = `Deleted "${delId}" still in DB`; break; }
      }
    }

    return {
      success: verified,
      target: this.name, appliedAt, planId: plan.id,
      readBackVerified: verified,
      staleDetected: !verified,
      readBackLevel: 'db-only (degraded)',
      canonicalReadBackLevel: 'db-only',
      degradedReason: lastHttpStatus !== undefined ? `serving-path-http-${lastHttpStatus}` : 'no-api-path',
      // Spec §33.3 / AT-109: db-only + serving-path unconfirmed → written-pending-reload
      applyState: verified ? 'written-pending-reload' : undefined,
      ttlStatus: NineRouterAdapter.TTL_STATUS,
      ...(verified ? {} : { error: `DB read-back mismatch: ${mismatchReason}` }),
    };
  }

  // ------------------------------------------------------------------------
  // rollback — restore snapshot
  // ------------------------------------------------------------------------

  async rollback(snapshot: Snapshot): Promise<boolean> {
    const db = this.openDb(this.dbPath, { busyTimeoutMs: 5000, allowLiveDbWrite: true });
    try {
      db.transaction(() => {
        // Read current combos
        const rawRows = db.prepare(
          'SELECT id, name, kind, models, createdAt, updatedAt FROM combos'
        ).all() as unknown[];

        const currentRows: NineRouterComboRow[] = [];
        for (const r of rawRows) {
          const parsed = NineRouterComboRowSchema.safeParse(r);
          if (parsed.success) currentRows.push(parsed.data);
        }

        const currentMap = new Map(currentRows.map((r) => [r.id, r]));
        const snapshotMap = new Map(snapshot.combos.map((c) => [c.id, c]));

        const insertStmt = db.prepare(
          'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const updateStmt = db.prepare(
          'UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?'
        );
        const deleteStmt = db.prepare('DELETE FROM combos WHERE id = ?');

        const isTouched = (id: string, isManaged: boolean): boolean => {
          if (isManaged) return true;
          const touched = snapshot.metadata?.['touchedComboIds'];
          return Array.isArray(touched) && touched.includes(id);
        };

        // 1. Delete rows in DB that are managed by RouterSync and were NOT in snapshot
        for (const current of currentRows) {
          // Managed recognition (T3-15): `routersync-` prefix, ids written by
          // this session, the state-dir ledger, and LEGACY kind='custom' rows
          // (recognized only for cleanup/rollback). The `rs-` prefix was
          // dropped — too easy to collide with user-chosen names.
          const isManaged =
            (current.id.startsWith('routersync-') ||
              current.kind === 'custom' ||
              this.sessionWrittenIds.has(current.id) ||
              getManagedIds(this.stateDir).includes(current.id)) &&
            !current.id.startsWith('manual-');
          if (!snapshotMap.has(current.id) && (isManaged || isTouched(current.id, isManaged))) {
            deleteStmt.run(current.id);
          }
        }

        // 2. Restore rows from snapshot that are managed or touched by RouterSync
        for (const snapCombo of snapshot.combos) {
          if (snapCombo.managed || isTouched(snapCombo.id, snapCombo.managed)) {
            const current = currentMap.get(snapCombo.id);
            const rawModels = typeof snapCombo.rawData?.['__rawRowModels'] === 'string'
              ? snapCombo.rawData['__rawRowModels']
              : JSON.stringify(snapCombo.models);
            const rawKind = (snapCombo.rawData && 'kind' in snapCombo.rawData)
              ? (snapCombo.rawData['kind'] as string | null)
              : null;
            const rawUpdatedAt = (snapCombo.rawData?.['__rawRowUpdatedAt'] as string) ?? snapCombo.updatedAt ?? snapshot.timestamp;
            const rawCreatedAt = (snapCombo.rawData?.['createdAt'] as string) ?? snapCombo.updatedAt ?? snapshot.timestamp;

            if (!current) {
              insertStmt.run(
                snapCombo.id,
                snapCombo.name,
                rawKind,
                rawModels,
                rawCreatedAt,
                rawUpdatedAt
              );
            } else {
              // Only update if actually modified!
              const isModified = current.name !== snapCombo.name ||
                current.kind !== rawKind ||
                current.models !== rawModels;

              if (isModified) {
                updateStmt.run(
                  snapCombo.name,
                  rawKind,
                  rawModels,
                  rawUpdatedAt,
                  snapCombo.id
                );
              }
            }
          }
        }

        // 3. Reconcile settings.comboStrategies inside the same BEGIN IMMEDIATE transaction
        // Strictly only patch keys touched by RouterSync without clobbering concurrent user changes
        if (snapshot.metadata && typeof snapshot.metadata['settingsData'] === 'string') {
          try {
            const snapSettings = JSON.parse(snapshot.metadata['settingsData']) as Record<string, unknown>;
            const snapStrategies = (snapSettings['comboStrategies'] ?? {}) as Record<string, unknown>;

            const currentSettings = this.loadSettingsObj(db);
            const currentStrategies = ((currentSettings['comboStrategies'] as Record<string, unknown>) ?? {});

            let strategyChanged = false;

            // Restore strategies ONLY for combos managed or touched by RouterSync in snapshot
            for (const snapCombo of snapshot.combos) {
              if (snapCombo.managed || isTouched(snapCombo.id, snapCombo.managed)) {
                if (snapStrategies[snapCombo.name] !== undefined) {
                  if (JSON.stringify(currentStrategies[snapCombo.name]) !== JSON.stringify(snapStrategies[snapCombo.name])) {
                    currentStrategies[snapCombo.name] = snapStrategies[snapCombo.name];
                    strategyChanged = true;
                  }
                } else if (currentStrategies[snapCombo.name] !== undefined) {
                  delete currentStrategies[snapCombo.name];
                  strategyChanged = true;
                }
              }
            }

            // Remove strategies ONLY for RouterSync-managed combos added during execution
            for (const current of currentRows) {
              // Managed recognition (T3-15): `routersync-` prefix, ids written by
          // this session, the state-dir ledger, and LEGACY kind='custom' rows
          // (recognized only for cleanup/rollback). The `rs-` prefix was
          // dropped — too easy to collide with user-chosen names.
          const isManaged =
            (current.id.startsWith('routersync-') ||
              current.kind === 'custom' ||
              this.sessionWrittenIds.has(current.id) ||
              getManagedIds(this.stateDir).includes(current.id)) &&
            !current.id.startsWith('manual-');
              if (!snapshotMap.has(current.id) && (isManaged || isTouched(current.id, isManaged))) {
                if (currentStrategies[current.name] !== undefined) {
                  delete currentStrategies[current.name];
                  strategyChanged = true;
                }
              }
            }

            if (strategyChanged) {
              currentSettings['comboStrategies'] = currentStrategies;
              db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)')
                .run(JSON.stringify(currentSettings));
            }
          } catch {
            // fallback if settings malformed
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

  private loadStrategies(db: SqliteDriver): Record<string, string> {
    try {
      const raw = db.prepare('SELECT id, data FROM settings WHERE id = 1').get();
      const row = NineRouterSettingsRowSchema.safeParse(raw);
      if (!row.success) return {};
      const obj = JSON.parse(row.data.data) as Record<string, unknown>;
      const parsed = NineRouterComboStrategiesSchema.parse(obj['comboStrategies'] ?? {});
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') {
          result[k] = v;
        } else if (v && typeof v === 'object' && 'fallbackStrategy' in v) {
          result[k] = String(v.fallbackStrategy ?? 'round-robin');
        } else {
          result[k] = 'round-robin';
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private loadSettingsObj(db: SqliteDriver): Record<string, unknown> {
    try {
      const raw = db.prepare('SELECT id, data FROM settings WHERE id = 1').get();
      const row = NineRouterSettingsRowSchema.safeParse(raw);
      if (!row.success) return {};
      return JSON.parse(row.data.data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private rowToCombo(row: NineRouterComboRow, strategies: Record<string, string>): ComboDefinition {
    let models: string[] = [];
    try {
      const parsed = JSON.parse(row.models) as unknown;
      if (Array.isArray(parsed)) models = parsed.map(String);
    } catch {
      models = [];
    }
    // Managed recognition (T3-15): `routersync-` prefix, ids written by this
    // session, the durable ledger, and LEGACY kind='custom' rows (cleanup/
    // rollback only). `rs-` dropped (collides with user names).
    const isRsManaged =
      (row.id.startsWith('routersync-') ||
        this.sessionWrittenIds.has(row.id) ||
        getManagedIds(this.stateDir).includes(row.id) ||
        row.kind === 'custom') &&
      !row.id.startsWith('manual-');

    return {
      id:        row.id,
      name:      row.name,
      strategy:  strategies[row.name] ?? 'round-robin',
      models,
      managed:   isRsManaged,
      updatedAt: row.updatedAt,
      rawData:   { kind: row.kind, __rawRowModels: row.models, __rawRowUpdatedAt: row.updatedAt, createdAt: row.createdAt },
    };
  }
}
