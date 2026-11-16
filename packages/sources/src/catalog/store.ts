/**
 * packages/sources/src/catalog/store.ts
 *
 * RouterSync Model Catalog SQLite Store (Phase 3a / P1-DEBT-03 / SPEC §23.2).
 *
 * Implements persistent local storage for discovered models and providers.
 * Integrates shrink guards and grace cycles to guarantee catalog resilience.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { openBetterSqlite3, type SqliteDriver } from '@routersync/core';
import {
  CATALOG_SCHEMA_DDL,
  type CatalogProviderRecord,
  type CatalogModelRecord,
} from './schema.js';
import {
  evaluateModelListShrink,
  applyGraceCycles,
  type TrackedCatalogItem,
} from '../discovery/shrink-guard.js';

export interface CatalogStoreOptions {
  dbPath?: string;
}

export interface ModelBatchInput {
  id: string;
  name?: string | undefined;
  rawId?: string | undefined;
  contextWindow?: number | undefined;
  pricing?: Record<string, unknown> | undefined;
}

export interface BatchRecordResult {
  recorded: number;
  frozen: boolean;
  reason?: string | undefined;
}

export class CatalogStore {
  private readonly dbPath: string;
  private db: SqliteDriver | null = null;

  constructor(options?: CatalogStoreOptions) {
    if (options?.dbPath) {
      this.dbPath = options.dbPath;
    } else {
      const stateDir =
        process.env['ROUTERSYNC_STATE_DIR'] ||
        path.join(
          process.env['APPDATA'] || path.join(os.homedir(), '.config'),
          'routersync',
          'state'
        );
      this.dbPath = path.join(stateDir, 'catalog.sqlite');
    }
  }

  getResolvedDbPath(): string {
    return this.dbPath;
  }

  open(): void {
    if (this.db) return;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = openBetterSqlite3(this.dbPath);
    this.db.exec(CATALOG_SCHEMA_DDL);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureOpen(): SqliteDriver {
    if (!this.db) {
      this.open();
    }
    return this.db!;
  }

  upsertProvider(provider: CatalogProviderRecord): void {
    const db = this.ensureOpen();
    const stmt = db.prepare(`
      INSERT INTO catalog_providers (id, name, kind, endpoint, status, lastSyncAt, error, credentialRef)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        endpoint = excluded.endpoint,
        status = excluded.status,
        lastSyncAt = excluded.lastSyncAt,
        error = excluded.error,
        credentialRef = excluded.credentialRef
    `);
    stmt.run(
      provider.id,
      provider.name,
      provider.kind,
      provider.endpoint ?? null,
      provider.status,
      provider.lastSyncAt ?? null,
      provider.error ?? null,
      provider.credentialRef ?? null
    );
  }

  listProviders(): CatalogProviderRecord[] {
    const db = this.ensureOpen();
    // credentialRef column added in R49; may be absent in older DBs — use COALESCE for safety
    const rows = db.prepare('SELECT id, name, kind, endpoint, status, lastSyncAt, error, credentialRef FROM catalog_providers ORDER BY id ASC').all();
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      endpoint: r.endpoint ?? undefined,
      status: r.status,
      lastSyncAt: r.lastSyncAt ?? undefined,
      error: r.error ?? undefined,
      credentialRef: r.credentialRef ?? undefined,
    }));
  }

  recordModelBatch(
    providerId: string,
    incomingModels: ModelBatchInput[],
    options?: { maxShrinkRatio?: number | undefined; graceCycles?: number | undefined }
  ): BatchRecordResult {
    const db = this.ensureOpen();
    const nowIso = new Date().toISOString();

    // 1. Fetch current active/grace models for this provider
    const existingRows = db.prepare(
      'SELECT id, status, consecutiveMissing, lastSeenAt FROM catalog_models WHERE providerId = ?'
    ).all(providerId) as Array<{
      id: string;
      status: 'active' | 'grace_period' | 'absent';
      consecutiveMissing: number;
      lastSeenAt: string;
    }>;

    const previousCount = existingRows.filter((r) => r.status === 'active').length;
    const incomingCount = incomingModels.length;

    // 2. Evaluate Shrink Guard (P1-DEBT-05)
    const shrinkCheck = evaluateModelListShrink(previousCount, incomingCount, {
      maxShrinkRatio: options?.maxShrinkRatio,
    });

    if (shrinkCheck.frozen) {
      // Record provider warning
      const provStmt = db.prepare('UPDATE catalog_providers SET status = ?, error = ? WHERE id = ?');
      provStmt.run('error', shrinkCheck.reason ?? 'Shrink ratio exceeded', providerId);

      return {
        recorded: 0,
        frozen: true,
        reason: shrinkCheck.reason,
      };
    }

    // 3. Apply Grace Cycles (P1-DEBT-04)
    const trackedItems: TrackedCatalogItem[] = existingRows.map((r) => ({
      id: r.id,
      status: r.status,
      consecutiveMissing: r.consecutiveMissing,
      lastSeenAt: r.lastSeenAt,
    }));

    const incomingIds = incomingModels.map((m) => m.id);
    const updatedTracked = applyGraceCycles(trackedItems, incomingIds, nowIso, {
      graceCycles: options?.graceCycles,
    });

    const incomingMap = new Map<string, ModelBatchInput>();
    for (const m of incomingModels) {
      incomingMap.set(m.id, m);
    }

    // 4. Batch UPSERT into catalog_models within transaction
    const upsertStmt = db.prepare(`
      INSERT INTO catalog_models (
        id, providerId, name, rawId, contextWindow, pricing, status,
        consecutiveMissing, firstSeenAt, lastSeenAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(providerId, id) DO UPDATE SET
        name = excluded.name,
        rawId = excluded.rawId,
        contextWindow = COALESCE(excluded.contextWindow, catalog_models.contextWindow),
        pricing = COALESCE(excluded.pricing, catalog_models.pricing),
        status = excluded.status,
        consecutiveMissing = excluded.consecutiveMissing,
        lastSeenAt = excluded.lastSeenAt
    `);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of updatedTracked) {
        const incoming = incomingMap.get(item.id);
        const name = incoming?.name ?? item.id;
        const rawId = incoming?.rawId ?? incoming?.id ?? item.id;
        const ctx = incoming?.contextWindow ?? null;
        const pricing = incoming?.pricing ? JSON.stringify(incoming.pricing) : null;
        const firstSeen = item.lastSeenAt || nowIso;

        upsertStmt.run(
          item.id,
          providerId,
          name,
          rawId,
          ctx,
          pricing,
          item.status,
          item.consecutiveMissing,
          firstSeen,
          item.lastSeenAt
        );
      }

      // Update provider sync time and clear errors
      db.prepare('UPDATE catalog_providers SET status = ?, lastSyncAt = ?, error = NULL WHERE id = ?')
        .run('active', nowIso, providerId);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return {
      recorded: incomingModels.length,
      frozen: false,
    };
  }

  listModels(filter?: { providerId?: string; status?: string }): CatalogModelRecord[] {
    const db = this.ensureOpen();
    let query = 'SELECT id, providerId, name, rawId, contextWindow, pricing, status, consecutiveMissing, firstSeenAt, lastSeenAt FROM catalog_models WHERE 1=1';
    const params: any[] = [];

    if (filter?.providerId) {
      query += ' AND providerId = ?';
      params.push(filter.providerId);
    }
    if (filter?.status) {
      query += ' AND status = ?';
      params.push(filter.status);
    }
    query += ' ORDER BY providerId ASC, id ASC';

    const rows = db.prepare(query).all(...params);
    return rows.map((r: any) => ({
      id: r.id,
      providerId: r.providerId,
      name: r.name,
      rawId: r.rawId,
      contextWindow: r.contextWindow ?? undefined,
      pricing: r.pricing ?? undefined,
      status: r.status,
      consecutiveMissing: r.consecutiveMissing,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    }));
  }
}
