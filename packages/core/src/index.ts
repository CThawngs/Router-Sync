/**
 * packages/core/src/index.ts
 *
 * Main entry point for @routersync/core.
 */

export * from './domain/schema.js';
export * from './domain/sanitize.js';
export * from './domain/invariants.js';
export * from './planner/index.js';
export * from './applier/index.js';
export * from './applier/snapshot.js';
export * from './normalizer/index.js';
// Gate R: durable snapshot store (AT-112)
export {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  getManagedIds,
  recordManagedId,
  LEDGER_OWNER_TARGET,
  hasWrittenEvidence,
} from './snapshots/store.js';
export type { StoredSnapshotInfo } from './snapshots/store.js';
// P2a: SQLite driver interface + better-sqlite3 implementation
export type { SqliteDriver, SqliteStatement, OpenSqliteDriver } from './sqlite/driver.js';
export {
  openBetterSqlite3,
  backupAsync,
  locateRouterDb,
  locateAllRouterDbs,
  getLiveRouterDbs,
  isLiveRouterDb,
  isSameDbFile,
  canonicalizePath,
  isPathInsideDir,
  assertNotLiveRouterDb,
  setDefaultRestrictDir,
  getDefaultRestrictDir,
  setConfiguredRouterDbPaths,
  getConfiguredRouterDbPaths,
  getConfiguredRouterDbPath,
  clearConfiguredRouterDbPaths,
  firstNonEmpty,
  expandTildePath,
  resolveSingleConfiguredDbPath,
  resolveConfiguredDbPaths,
  type RouterDbConfigEntry,
  type RouterDbConfigLike,
} from './sqlite/better-sqlite3.js';
// P2a: Schema fingerprinter (AT-97)
export {
  fingerprint,
  assertFingerprint,
  SchemaError,
  ReadOnlyVersionError,
} from './fingerprint/index.js';
export type {
  ColumnSpec,
  TableSpec,
  FingerprintResult,
  SchemaIssue,
} from './fingerprint/index.js';
// Centralized router key resolution (least privilege, SPEC §31 / G0-5)
export {
  resolveRouterKey,
  ROUTER_KEY_CANDIDATES,
} from './router-key.js';
export type {
  RouterKeyScope,
  ResolvedRouterKey,
  ResolveRouterKeyOptions,
} from './router-key.js';
// Phase 3a: Secure Credential Broker
export * from './credentials/index.js';
// Phase 3d: Cross-platform paths and atomic writes (SPEC §32 / D25)
export * from './paths/index.js';
export * from './paths/atomic.js';
// Profile interview questions shared by the CLI and the read-only MCP server.
export * from './profile/questions.js';
// Model Writers (Narrow write operations for Tier transitions & custom models)
export * from './writers/model-writer.js';
// Centralized Router Model State reader
export * from './domain/model-state.js';
// M2-02: Shared outbound actionable webhook notifier
export * from './notify/webhook.js';
