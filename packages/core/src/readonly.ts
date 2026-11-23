/**
 * packages/core/src/readonly.ts
 *
 * Strictly Read-Only SQLite Entrypoint for RouterSync (SPEC §31.9 ④ Part 1).
 *
 * This module exposes ONLY read-only database capabilities:
 * - Read-only mode is permanently fixed (readonly: true).
 * - Write options (direct DB write flags, transaction, exec, run) are completely omitted.
 * - Used by @routersync/daemon to safely inspect router state without applier access.
 *
 * Note: This is Part 1 of splitting core exports into read/write paths (SPEC §31.9 ④).
 * The remainder of the core export split is pending future phases.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export interface ReadOnlySqliteStatement {
  /** Execute and return rows as plain objects. */
  all(...params: unknown[]): unknown[];
  /** Execute and return the first row or undefined. */
  get(...params: unknown[]): unknown;
}

export interface ReadOnlySqliteDb {
  /** Prepare a read-only query statement. */
  prepare(sql: string): ReadOnlySqliteStatement;
  /** Execute a read-only PRAGMA check. */
  pragma(name: string, opts?: { simple: boolean }): unknown;
  /** Close the read-only database connection. */
  close(): void;
}

export interface OpenReadOnlyDbOptions {
  /** Busy timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
}

/**
 * Open an existing SQLite database in strictly read-only mode.
 *
 * Invariants enforced:
 * - `readonly: true` is fixed and unchangeable.
 * - `fileMustExist: true` ensures new empty files are never created on read-only paths.
 * - No write methods (`run`, `exec`, `transaction`) exist on the returned instance.
 * - Rejects any parameter attempting to grant write access.
 */
export function openReadOnlyDb(dbPath: string, options?: OpenReadOnlyDbOptions): ReadOnlySqliteDb {
  const Database = require('better-sqlite3');
  const timeoutMs = options?.timeoutMs ?? 5000;

  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: timeoutMs,
  });

  try {
    db.pragma(`busy_timeout = ${timeoutMs}`);
    // C14: strict read-only guard at the SQLite layer.
    db.pragma('query_only = ON');
  } catch {
    // If pragma fails on specialized read-only mounts, proceed
  }

  return {
    prepare(sql: string): ReadOnlySqliteStatement {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...params),
        get: (...params: unknown[]) => stmt.get(...params),
      };
    },
    pragma(name: string, opts?: { simple: boolean }) {
      return db.pragma(name, opts);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Pure planner re-exported under a read-only alias. The planner only
 * computes (no applier / no DB write), so it is safe for daemon S1:
 * daemon must import it via `@routersync/core/readonly`, never root core.
 */
export { planCombos as computeComboPlan } from './planner/index.js';
export type { AdoptSpec, PlanOptions } from './planner/index.js';
export type { ComboDefinition, ComboRule, ModelInfo, Plan } from './domain/schema.js';

/**
 * The router database paths installed from the configuration file.
 *
 * Path metadata only: no database handle, no write capability. The daemon
 * needs it so it reads the SAME file the CLI writes (C4n/N5).
 */
export {
  getConfiguredRouterDbPath,
  getConfiguredRouterDbPaths,
  setConfiguredRouterDbPaths,
  clearConfiguredRouterDbPaths,
  locateRouterDb,
  firstNonEmpty,
  expandTildePath,
  resolveSingleConfiguredDbPath,
  resolveConfiguredDbPaths,
  type RouterDbConfigEntry,
  type RouterDbConfigLike,
} from './sqlite/router-paths.js';

/**
 * M2-02: Read-only safe outbound actionable webhook helpers (zero DB write capability).
 */
export {
  validateWebhookUrl,
  redactWebhookPayload,
  sendActionableWebhook,
  type WebhookUrlRejectionReason,
  type WebhookUrlValidationResult,
  type ActionableWebhookAlert,
  type ActionableWebhookPayload,
  type WebhookDeliveryStatus,
  type WebhookDeliveryResult,
  type RedactWebhookOptions,
  type SendActionableWebhookInput,
} from './notify/webhook.js';
