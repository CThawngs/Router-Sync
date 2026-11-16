/**
 * packages/cli/src/commands/sync/index.ts
 *
 * `routersync sync | undo | sync-status` — ROUND 56 provider scan + combo
 * step pruning. Re-exports the split modules (sync-state, sync-plan,
 * sync-scan, sync-cli) so `packages/cli/src/index.ts` keeps a single import.
 */

export {
  runSyncCommand,
  runUndoCommand,
  runSyncStatusCommand,
  type SyncCommandOptions,
  type UndoCommandOptions,
} from './sync-cli.js';
export {
  scanAll,
  buildProviderLive,
} from './sync-scan.js';
export type { RouterView } from './sync-plan.js';
export {
  loadCatalogCounts,
  adoptGuardSet,
  inScope,
  buildViews,
  printTargets,
  printPlan,
} from './sync-plan.js';
export {
  LastSyncRecord,
  PendingPlan,
  stateFile,
  readLastSync,
  writeLastSync,
  readPendingPlan,
  writePendingPlan,
  deletePendingPlan,
  confirm,
} from './sync-state.js';
