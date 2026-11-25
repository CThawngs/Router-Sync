/**
 * packages/core/src/snapshots/store.ts
 *
 * Durable snapshot store for Gate R / AT-112 (T2-28 reopened PARTIAL):
 * `routersync rollback <id>` must load a persisted snapshot and invoke the
 * adapter's logical rollback — not merely create a snapshot and verify
 * adapter responsiveness.
 *
 * Guarantees:
 *  - Snapshots live in the OS state directory (%LOCALAPPDATA%\routersync on
 *    Windows; $XDG_STATE_HOME or ~/.local/state/routerspace on POSIX),
 *    overridable via ROUTERSYNC_STATE_DIR (tests). Outside any sync folder.
 *  - Snapshot ids are sanitized (path-traversal safe).
 *  - A snapshot containing secret-looking strings is REFUSED (never persisted).
 *  - Missing snapshot → structured error, never silent success.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Snapshot } from '@routersync/adapter-sdk';
import { getStateDir, getSnapshotsDir } from '../paths/index.js';
import { atomicWriteFileSync } from '../paths/atomic.js';

export { getStateDir, getSnapshotsDir };

const SECRET_SCAN: RegExp[] = [
  /sk-[a-zA-Z0-9_\-]{20,}/,
  /Bearer\s+[a-zA-Z0-9_.\-~+/=]{25,}/i,
  /eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{12,}\./,
];

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (cleaned.length === 0 || cleaned !== id.replace(/[^a-zA-Z0-9_-]/g, '_')) {
    // allow the cleaned form but never path separators
  }
  return cleaned.length > 0 ? cleaned : 'snapshot';
}

export interface StoredSnapshotInfo {
  id: string;
  target: string;
  timestamp: string;
  file: string;
}

/** Persist a snapshot durably. Returns the absolute file path. */
export function saveSnapshot(snapshot: Snapshot, stateDir?: string): string {
  const json = JSON.stringify(snapshot, null, 2);
  for (const re of SECRET_SCAN) {
    if (re.test(json)) {
      throw new Error(
        'Safety violation: refusing to persist a snapshot whose content matches secret patterns.'
      );
    }
  }
  const dir = getSnapshotsDir(stateDir);
  const file = path.join(dir, `${sanitizeId(snapshot.id)}.json`);
  atomicWriteFileSync(file, json, { maxRetries: 5 });
  return file;
}

/** Load a persisted snapshot. Throws a structured error when missing. */
export function loadSnapshot(id: string, stateDir?: string): Snapshot {
  const snapshotsDir = getSnapshotsDir(stateDir);
  const file = path.join(snapshotsDir, `${sanitizeId(id)}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Snapshot not found: "${id}" (expected at ${file}). ` +
      `Snapshots are created by 'routersync apply --write' and stored in ${snapshotsDir}.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
  if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.combos)) {
    throw new Error(`Corrupt snapshot file: ${file}`);
  }
  return parsed;
}

/** List all persisted snapshots (id, target, timestamp, file). */
export function listSnapshots(stateDir?: string): StoredSnapshotInfo[] {
  const dir = getSnapshotsDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(dir, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
        return {
          id: parsed.id,
          target: parsed.target,
          timestamp: parsed.timestamp,
          file,
        };
      } catch {
        return { id: f.replace(/\.json$/, ''), target: 'unknown', timestamp: 'unknown', file };
      }
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Managed-id ledger (Gate R / T3-15): ids RouterSync has written, persisted in
// the state directory so managed-row recognition survives across processes.
// ---------------------------------------------------------------------------

function managedIdsFile(stateDir?: string): string {
  return path.join(stateDir ?? getStateDir(), 'managed-ids.json');
}

/**
 * @param stateDir Optional override (tests inject a tmp dir here so the real
 * ledger is never polluted). Defaults to the OS state directory.
 */
export function getManagedIds(stateDir?: string): string[] {
  const file = managedIdsFile(stateDir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function recordManagedId(id: string, stateDir?: string): void {
  const file = managedIdsFile(stateDir);
  const ids = getManagedIds(stateDir);
  if (!ids.includes(id)) {
    ids.push(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ids, null, 2), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Evidence that a target was ever written (R19-2, DECISIONS 2026-10-18-01)
// ---------------------------------------------------------------------------

/**
 * The only adapter that writes the managed-id ledger.
 *
 * Read from the code, not guessed: `recordManagedId` is called from
 * `packages/adapter-9router/src/index.ts` (apply path) and from nowhere else.
 */
export const LEDGER_OWNER_TARGET = '9router';

/**
 * R19-2: is there EVIDENCE that `target` was ever written?
 *
 * READ-ONLY. This function never creates a file and never creates a directory:
 * a missing ledger or a missing snapshot directory means "no evidence", not
 * "an empty ledger".
 *
 * Evidence is:
 *  - a snapshot of THIS target in the snapshot directory (the snapshot file
 *    carries a `target` field, so this half is exact), OR
 *  - an entry of the managed-id ledger that belongs to THIS target.
 *
 * The second half needs a word of care, because the ledger on disk is a FLAT
 * array of ids with no target column: `managed-ids.json` is
 * `["routersync-fast", ...]`. An entry therefore cannot be attributed to a
 * router by reading the file. The only router whose writes reach that ledger
 * is the 9Router adapter (`LEDGER_OWNER_TARGET`), so a ledger entry counts as
 * evidence for the 9Router target and for nothing else. Counting it for every
 * target would report a write of one router as a write of another, which is
 * exactly the untruthful claim the new 'unwritten' value exists to prevent.
 */
export function hasWrittenEvidence(target: string, stateDir?: string): boolean {
  const snapshotHit = listSnapshots(stateDir).some((snapshot) => snapshot.target === target);
  if (snapshotHit) return true;

  if (target !== LEDGER_OWNER_TARGET) return false;
  return getManagedIds(stateDir).length > 0;
}
