/**
 * packages/core/src/applier/snapshot.ts
 * 
 * Snapshot utilities for capturing and restoring router combo state.
 */

import type { ComboDefinition, Snapshot, RouterAdapter } from '@routersync/adapter-sdk';

/**
 * Creates an in-memory Snapshot entity with timestamp and combo definitions.
 */
export function createSnapshotEntity(
  target: string,
  combos: ComboDefinition[],
  options: { metadata?: Record<string, unknown> | undefined; backupFilePath?: string | undefined } = {}
): Snapshot {
  const id = `snap_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timestamp = new Date().toISOString();

  const snapshot: Snapshot = {
    id,
    target,
    timestamp,
    combos: JSON.parse(JSON.stringify(combos)), // deep clone
  };

  if (options.metadata) {
    snapshot.metadata = options.metadata;
  }
  if (options.backupFilePath) {
    snapshot.backupFilePath = options.backupFilePath;
  }

  return snapshot;
}

/**
 * Restores a router state using a snapshot via its adapter.
 */
export async function restoreSnapshot(adapter: RouterAdapter, snapshot: Snapshot): Promise<boolean> {
  return adapter.rollback(snapshot);
}
