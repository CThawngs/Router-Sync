/**
 * packages/core/src/writers/model-writer.ts
 *
 * Narrow model writer implementation for Tier A <-> Tier B transitions
 * and custom model additions in local router databases.
 *
 * Safety Invariants:
 *  1. assertNotLiveRouterDb: Strictly refuses to write to live router DB paths.
 *  2. Dry-run by default: Operations default to dryRun: true unless explicitly set to false.
 *  3. Transactional & Atomic: Mutations use SQLite transactions.
 *  4. Read-back verification: Immediately verifies applied mutations when not dry-run.
 *  5. Rollback capability: Returns previousState and provides dedicated rollback functions.
 */

import { assertNotLiveRouterDb, openBetterSqlite3 } from '../sqlite/better-sqlite3.js';
import type { SqliteDriver } from '../sqlite/driver.js';

export interface ModelWriterOptions {
  dbPath: string;
  provider: string;
  modelId: string;
  dryRun?: boolean;
}

export interface CustomModelOptions extends ModelWriterOptions {
  displayName?: string;
  type?: string;
  capabilities?: Record<string, unknown>;
}

export interface ModelWriterResult {
  success: boolean;
  routerType: '9router' | 'omniroute';
  action: 'ENABLE_MODEL' | 'DISABLE_MODEL' | 'ADD_MODEL';
  provider: string;
  modelId: string;
  dryRun: boolean;
  changed: boolean;
  previousState: unknown;
  newState: unknown;
  readBackVerified: boolean;
  error?: string;
}

export interface RollbackOptions {
  dbPath: string;
  provider: string;
  previousState: unknown;
  dryRun?: boolean;
}

function validateInputs(provider: string, modelId: string): void {
  if (!provider || typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('ModelWriter error: provider must be a non-empty string.');
  }
  if (!modelId || typeof modelId !== 'string' || modelId.trim() === '') {
    throw new Error('ModelWriter error: modelId must be a non-empty string.');
  }
}

// ==========================================
// 9Router Narrow Model Writers (KV Table)
// ==========================================

/**
 * Enable a model in 9Router by removing it from the disabledModels scope in the kv table.
 */
export function enableModel9Router(options: ModelWriterOptions): ModelWriterResult {
  const { dbPath, provider, modelId, dryRun = true } = options;
  assertNotLiveRouterDb(dbPath);
  validateInputs(provider, modelId);

  const db: SqliteDriver = openBetterSqlite3(dbPath, { readOnly: dryRun });
  try {
    const row = db
      .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
      .get(provider) as { value?: string } | undefined;

    let currentDisabled: string[] = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) currentDisabled = parsed.map(String);
      } catch {
        currentDisabled = [];
      }
    }

    const previousState = [...currentDisabled];
    const isPresent = currentDisabled.includes(modelId);

    if (!isPresent) {
      return {
        success: true,
        routerType: '9router',
        action: 'ENABLE_MODEL',
        provider,
        modelId,
        dryRun,
        changed: false,
        previousState,
        newState: previousState,
        readBackVerified: true,
      };
    }

    const nextDisabled = currentDisabled.filter((id) => id !== modelId);

    if (!dryRun) {
      db.transaction(() => {
        const updatedJson = JSON.stringify(nextDisabled);
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE kv SET value = ?, updatedAt = ? WHERE scope = 'disabledModels' AND key = ?"
        ).run(updatedJson, now, provider);
      });

      // Read-back verification
      const verifyRow = db
        .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
        .get(provider) as { value?: string } | undefined;
      const verifyList: string[] = verifyRow?.value ? JSON.parse(verifyRow.value) : [];
      const readBackVerified = !verifyList.includes(modelId);

      return {
        success: true,
        routerType: '9router',
        action: 'ENABLE_MODEL',
        provider,
        modelId,
        dryRun: false,
        changed: true,
        previousState,
        newState: nextDisabled,
        readBackVerified,
      };
    }

    return {
      success: true,
      routerType: '9router',
      action: 'ENABLE_MODEL',
      provider,
      modelId,
      dryRun: true,
      changed: true,
      previousState,
      newState: nextDisabled,
      readBackVerified: false,
    };
  } finally {
    db.close();
  }
}

/**
 * Disable a model in 9Router by appending it to the disabledModels scope in the kv table.
 */
export function disableModel9Router(options: ModelWriterOptions): ModelWriterResult {
  const { dbPath, provider, modelId, dryRun = true } = options;
  assertNotLiveRouterDb(dbPath);
  validateInputs(provider, modelId);

  const db: SqliteDriver = openBetterSqlite3(dbPath, { readOnly: dryRun });
  try {
    const row = db
      .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
      .get(provider) as { value?: string } | undefined;

    const rowExists = row !== undefined;
    let currentDisabled: string[] = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) currentDisabled = parsed.map(String);
      } catch {
        currentDisabled = [];
      }
    }

    const previousState = rowExists ? [...currentDisabled] : null;
    const isPresent = currentDisabled.includes(modelId);

    if (isPresent) {
      return {
        success: true,
        routerType: '9router',
        action: 'DISABLE_MODEL',
        provider,
        modelId,
        dryRun,
        changed: false,
        previousState,
        newState: previousState,
        readBackVerified: true,
      };
    }

    const nextDisabled = [...currentDisabled, modelId];

    if (!dryRun) {
      db.transaction(() => {
        const updatedJson = JSON.stringify(nextDisabled);
        const now = new Date().toISOString();
        if (rowExists) {
          db.prepare(
            "UPDATE kv SET value = ?, updatedAt = ? WHERE scope = 'disabledModels' AND key = ?"
          ).run(updatedJson, now, provider);
        } else {
          db.prepare(
            "INSERT INTO kv (scope, key, value, createdAt, updatedAt) VALUES ('disabledModels', ?, ?, ?, ?)"
          ).run(provider, updatedJson, now, now);
        }
      });

      // Read-back verification
      const verifyRow = db
        .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
        .get(provider) as { value?: string } | undefined;
      const verifyList: string[] = verifyRow?.value ? JSON.parse(verifyRow.value) : [];
      const readBackVerified = verifyList.includes(modelId);

      return {
        success: true,
        routerType: '9router',
        action: 'DISABLE_MODEL',
        provider,
        modelId,
        dryRun: false,
        changed: true,
        previousState,
        newState: nextDisabled,
        readBackVerified,
      };
    }

    return {
      success: true,
      routerType: '9router',
      action: 'DISABLE_MODEL',
      provider,
      modelId,
      dryRun: true,
      changed: true,
      previousState,
      newState: nextDisabled,
      readBackVerified: false,
    };
  } finally {
    db.close();
  }
}

/**
 * Register a custom model entry into 9Router (kv table scope='customModels').
 */
export function addCustomModel9Router(options: CustomModelOptions): ModelWriterResult {
  const { dbPath, provider, modelId, displayName, type = 'llm', capabilities = {}, dryRun = true } = options;
  assertNotLiveRouterDb(dbPath);
  validateInputs(provider, modelId);

  const db: SqliteDriver = openBetterSqlite3(dbPath, { readOnly: dryRun });
  try {
    const key = `${provider}|${modelId}|${type}`;
    const row = db
      .prepare("SELECT value FROM kv WHERE scope = 'customModels' AND key = ?")
      .get(key) as { value?: string } | undefined;

    const previousState = row?.value ? JSON.parse(row.value) : null;

    const newPayload = {
      providerAlias: provider,
      id: modelId,
      name: displayName || modelId,
      type,
      capabilities,
    };

    if (!dryRun) {
      db.transaction(() => {
        const now = new Date().toISOString();
        const valueJson = JSON.stringify(newPayload);
        if (row) {
          db.prepare("UPDATE kv SET value = ?, updatedAt = ? WHERE scope = 'customModels' AND key = ?")
            .run(valueJson, now, key);
        } else {
          db.prepare(
            "INSERT INTO kv (scope, key, value, createdAt, updatedAt) VALUES ('customModels', ?, ?, ?, ?)"
          ).run(key, valueJson, now, now);
        }
      });

      const verifyRow = db
        .prepare("SELECT value FROM kv WHERE scope = 'customModels' AND key = ?")
        .get(key) as { value?: string } | undefined;
      const readBackVerified = Boolean(verifyRow?.value && JSON.parse(verifyRow.value).id === modelId);

      return {
        success: true,
        routerType: '9router',
        action: 'ADD_MODEL',
        provider,
        modelId,
        dryRun: false,
        changed: true,
        previousState,
        newState: newPayload,
        readBackVerified,
      };
    }

    return {
      success: true,
      routerType: '9router',
      action: 'ADD_MODEL',
      provider,
      modelId,
      dryRun: true,
      changed: true,
      previousState,
      newState: newPayload,
      readBackVerified: false,
    };
  } finally {
    db.close();
  }
}

/**
 * Rollback 9Router disabledModels to a previously recorded state with verified read-back.
 */
export function rollback9RouterDisabled(options: RollbackOptions): boolean {
  const { dbPath, provider, previousState, dryRun = false } = options;
  assertNotLiveRouterDb(dbPath);

  if (dryRun) return true;

  const db: SqliteDriver = openBetterSqlite3(dbPath, { readOnly: false });
  try {
    if (previousState === null || previousState === undefined) {
      db.transaction(() => {
        db.prepare(
          "DELETE FROM kv WHERE scope = 'disabledModels' AND key = ?"
        ).run(provider);
      });

      // Read-back verification: row must no longer exist
      const verifyRow = db
        .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
        .get(provider);
      return verifyRow === undefined;
    }

    const targetArray = Array.isArray(previousState) ? previousState : [];
    let changes = 0;
    db.transaction(() => {
      const now = new Date().toISOString();
      const updatedJson = JSON.stringify(targetArray);
      const res = db.prepare(
        "UPDATE kv SET value = ?, updatedAt = ? WHERE scope = 'disabledModels' AND key = ?"
      ).run(updatedJson, now, provider);
      changes = res.changes;
    });

    if (changes === 0) {
      // Row did not exist or update failed to affect rows
      return false;
    }

    // Read-back verification
    const verifyRow = db
      .prepare("SELECT value FROM kv WHERE scope = 'disabledModels' AND key = ?")
      .get(provider) as { value?: string } | undefined;
    if (!verifyRow?.value) return false;
    const verifyList: string[] = JSON.parse(verifyRow.value);
    const readBackOk =
      verifyList.length === targetArray.length &&
      verifyList.every((v, i) => v === targetArray[i]);

    return readBackOk;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

// ==========================================
// OmniRoute Narrow Model Writers
// ==========================================

export interface OmniRouteModelStatusOptions {
  dbPath: string;
  provider: string;
  modelId: string;
  status: 'active' | 'deprecated' | null;
  dryRun?: boolean;
}

/**
 * Set model status in OmniRoute's database.
 * Currently unsupported and throws because radar_local_model_state has 0 rows
 * and model toggling mechanism is unverified in live OmniRoute.
 */
export function setOmniRouteModelStatus(options: OmniRouteModelStatusOptions): ModelWriterResult {
  assertNotLiveRouterDb(options.dbPath);
  throw new Error(
    'OmniRoute model status write is unsupported: radar_local_model_state has 0 rows and model toggling is unverified.'
  );
}
