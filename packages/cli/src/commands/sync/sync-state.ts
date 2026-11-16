/**
 * packages/cli/src/commands/sync/sync-state.ts
 *
 * Persistent state for `routersync sync | undo`: last-sync record and the
 * pending plan shown to the owner before `--apply`. Lives in the platform
 * state directory:
 *   Windows  : %LOCALAPPDATA%\routersync\
 *   macOS    : $XDG_STATE_HOME/routersync  (or ~/.local/state/routersync)
 *   Linux    : $XDG_STATE_HOME/routersync  (or ~/.local/state/routersync)
 * Override   : ROUTERSYNC_SYNC_STATE_DIR
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { SyncPlan } from '../../sync/plan.js';

export interface LastSyncRecord {
  at: string;
  planHash: string;
  routers: Record<string, { backup: string; changed: string[]; dbPath?: string }>;
}

/**
 * The plan the owner was shown. `--apply` refuses to write a different plan:
 * the scan runs again before writing, so a live list may have moved between
 * the two runs. Same hash or no write.
 */
export interface PendingPlan {
  at: string;
  planHash: string;
  totalRemovals: number;
  combos: Array<{ router: string; name: string; removals: string[] }>;
  /**
   * C4n/N5: the database each router's plan was computed from.
   *
   * `--apply` refuses when the current database differs, so a plan shown for
   * one database is never applied to another.
   */
  dbPaths?: Record<string, string>;
}

function stateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const override = env['ROUTERSYNC_SYNC_STATE_DIR'];
  if (override && override.trim().length > 0) {
    const dir = path.resolve(override.trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  let base: string;
  if (platform === 'win32') {
    base = env['LOCALAPPDATA'] ?? path.join(env['USERPROFILE'] ?? os.homedir(), 'AppData', 'Local');
  } else {
    base = env['XDG_STATE_HOME'] ?? path.join(env['HOME'] ?? os.homedir(), '.local', 'state');
  }
  const dir = path.join(base, 'routersync');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateDirForTest(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string {
  return stateDir(env, platform);
}

export function stateFile(name: string): string {
  return path.join(stateDir(), name);
}

export function readLastSync(): LastSyncRecord | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile('sync-last.json'), 'utf-8')) as LastSyncRecord;
  } catch {
    return null;
  }
}

export function writeLastSync(record: LastSyncRecord): void {
  fs.writeFileSync(stateFile('sync-last.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

/**
 * Write a fingerprint hash of the current combo step lists after a successful
 * --apply. Used by autopilot plan to detect drift (manual edits since last apply).
 */
export function writeLastApplied(fingerprint: { router: string; combos: Record<string, string> }): void {
  fs.writeFileSync(stateFile('last-applied.json'), `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf-8');
}

export function readPendingPlan(): PendingPlan | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile('sync-plan.json'), 'utf-8')) as PendingPlan;
  } catch {
    return null;
  }
}

export function writePendingPlan(plan: SyncPlan, dbPaths?: Record<string, string>): PendingPlan {
  const pending: PendingPlan = {
    at: new Date().toISOString(),
    planHash: plan.planHash,
    totalRemovals: plan.totalRemovals,
    combos: plan.combos
      .filter((c) => c.removals.length > 0)
      .map((c) => ({ router: c.router, name: c.name, removals: c.removals })),
    ...(dbPaths ? { dbPaths } : {}),
  };
  fs.writeFileSync(stateFile('sync-plan.json'), `${JSON.stringify(pending, null, 2)}\n`, 'utf-8');
  return pending;
}

export function deletePendingPlan(): void {
  fs.rmSync(stateFile('sync-plan.json'), { force: true });
}

/**
 * Owner confirmation (C3i I1): chi xac nhan khi stdin la TTY that.
 * Bi tu choi: stdin khong phai TTY (pipe/redirect), va ROUTERSYNC_SYNC_CONFIRM
 * (env tu dien). Invariant I1: khong co duong nao xac nhan ma khong phai
 * nguoi go thang tren terminal. De thi don vi test: confirmWord
 * (packages/cli/src/sync/confirm.ts) chi duoc goi qua day sau khi qua
 * isTTY o sync-cli; bien moi truong khong bao gio duoc dung.
 */
export function confirmSyncWord(): string {
  return 'chay';
}

/**
 * Fold a typed confirmation word to a comparable form: lower-case, no
 * diacritics, no surrounding whitespace. Both the ASCII spelling and the
 * accented spelling of the same word therefore match.
 */
export function normalizeConfirmWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** True when the typed answer matches the expected confirmation word. */
export function confirmWordMatches(answer: string, expected: string): boolean {
  return normalizeConfirmWord(answer) === normalizeConfirmWord(expected);
}

export async function confirm(word: string, message: string): Promise<boolean> {
  // Print the message to stderr so the owner sees why confirmation is requested.
  if (message && message.trim().length > 0) {
    process.stderr.write(`${message}\n`);
  }
  // I1 FAIL khi pipe: stdin khong TTY => tu choi, kem ca env.
  if (!process.stdin.isTTY) {
    if (process.env['ROUTERSYNC_SYNC_CONFIRM'] !== undefined) {
      throw new Error('I1: ROUTERSYNC_SYNC_CONFIRM env auto-fill rejected (pipe/non-TTY)');
    }
    throw new Error(`confirmation required ("${word}") but stdin is not a TTY`);
  }
  const answer = await ask(`Gõ "${word}" để xác nhận: `);
  return confirmWordMatches(answer, word);
}

function ask(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
