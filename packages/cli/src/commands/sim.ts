/**
 * packages/cli/src/commands/sim.ts
 *
 * A6: 7-day simulation on REDACTED COPIES of both router DBs (never live).
 * Deterministic scenario, fake clock/scan sources injected via opts (DI —
 * no NODE_ENV/VITEST branching). Per day: mode decision -> snapshot
 * (file copy + integrity_check) -> apply via writer -> EXACT read-back ->
 * rescan; mismatch trips breaker and restores the day snapshot.
 * Final undo restores raw combo strings; hash before == hash after.
 *
 * 9Router ADD path also writes `kv` customModels:
 *   key   = provider|modelId|type
 *   value = JSON {providerAlias, id, type, name}
 * and, when present, providerConnections.data.providerSpecificData.enabledModels.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';
import type { RouterName } from '../sync/write.js';

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

export function hashComboSteps(steps: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...steps])).digest('hex').slice(0, 16);
}

export function customModelKey(providerAlias: string, modelId: string, type = 'chat'): string {
  return `${providerAlias}|${modelId}|${type}`;
}

export function customModelValue(
  providerAlias: string,
  modelId: string,
  name: string,
  type = 'chat'
): string {
  return JSON.stringify({ providerAlias, id: modelId, type, name });
}

export interface SimModeCtx {
  removals: number;
  steps: number;
  breakerTripped: boolean;
}

/** R6-class guard: >10% removals (or tripped breaker) => propose only. */
export function decideSimMode(ctx: SimModeCtx): 'auto-safe' | 'propose' {
  if (ctx.breakerTripped) return 'propose';
  if (ctx.steps > 0 && ctx.removals / ctx.steps > 0.10) return 'propose';
  return 'auto-safe';
}

export interface SimDayOp {
  day: number;
  kind: 'ADD' | 'REORDER' | 'REMOVE';
  model: string;
  modelB?: string;
  /** F3 (C3b): `stale` REMOVE NEVER writes (PROPOSE-STALE-DENIED); `cap`
   * REMOVE beyond per-router day cap (propose); `proposeOnly` preview only;
   * `breaker` propose then pause. minSteps+10% protect `test-*` combos. */
  stale?: boolean; cap?: boolean; proposeOnly?: boolean; breaker?: boolean;
}

/**
 * G6: hard limits for one simulated day, per combo. A removal may never take a
 * combo below `SIM_MIN_STEPS` (invariant I3), and at most `SIM_DAY_CAP`
 * add/remove entries are applied per day so a simulated day cannot rewrite a
 * whole combo. Blocked removals are counted, never silently dropped.
 */
export const SIM_MIN_STEPS = 2;
export const SIM_DAY_CAP = 8;
/** D6 (C3d): cap spec 2.5 — một ngày ≤20 adds, ≤5/combo (phần dư DEFERRED-BY-CAP). */
export const SIM_ADD_DAY_CAP = 20;
export const SIM_ADD_PER_COMBO_CAP = 5;

/** E6: chan cap adds: <=20/ngay, <=5/combo; phan du DEFERRED-BY-CAP. */
export function applyAddCaps(ops: readonly SimDayOp[]): { kept: SimDayOp[]; deferred: SimDayOp[] } {
  const perCombo = new Map<string, number>();
  const kept: SimDayOp[] = [];
  const deferred: SimDayOp[] = [];
  let dayAdds = 0;
  for (const op of ops) {
    if (op.kind !== 'ADD') { kept.push(op); continue; }
    const combo = op.model.split('/')[0] ?? op.model;
    const n = perCombo.get(combo) ?? 0;
    if (dayAdds >= SIM_ADD_DAY_CAP || n >= SIM_ADD_PER_COMBO_CAP) { deferred.push(op); continue; }
    dayAdds++;
    perCombo.set(combo, n + 1);
    kept.push(op);
  }
  return { kept, deferred };
}

export interface DropPlan {
  next: string[];
  removed: string[];
  protectedCount: number;
}

/**
 * G6: pure drop planner. Applies at most `cap` removals and refuses any drop
 * that would take the combo below `minSteps`; a refused drop is counted in
 * `protectedCount` so the day line shows it instead of silently skipping.
 */
export function planDrops(
  current: readonly string[],
  drops: readonly string[],
  minSteps = SIM_MIN_STEPS,
  cap = SIM_DAY_CAP
): DropPlan {
  let next = [...current];
  const removed: string[] = [];
  let protectedCount = 0;
  for (const d of drops) {
    if (!next.includes(d) || removed.length >= cap) continue;
    if (next.length - 1 < minSteps) {
      protectedCount += 1;
      continue;
    }
    next = next.filter((s) => s !== d);
    removed.push(d);
  }
  return { next, removed, protectedCount };
}

/** 7-day scenario, exact order (DI clock: day = 1..days). F3 (C3b): cap/day
 * enforced per-router (SIM_DAY_CAP=2 here: day5 is the 3rd write op and is
 * capped); day4 = 429/timeout stale REMOVE, day5 = POSSIBLE-CAP, day6 =
 * propose-only, day7 = breaker propose then pause; test-* protected. */
export function buildSimScenario(days = 7): SimDayOp[] {
  const all: SimDayOp[] = [
    { day: 1, kind: 'ADD', model: 'sim/free-alpha' },
    { day: 2, kind: 'REMOVE', model: 'sim/dead-beta' },
    { day: 3, kind: 'REMOVE', model: 'sim/dead-gamma' },
    { day: 4, kind: 'REMOVE', model: 'sim/remove-429-timeout', stale: true },
    { day: 5, kind: 'REMOVE', model: 'sim/remove-possible-cap', cap: true },
    { day: 6, kind: 'REMOVE', model: 'sim/remove-over-10pct', proposeOnly: true },
    { day: 7, kind: 'REMOVE', model: 'sim/remove-readback-mismatch', modelB: 'sim/pause-check', breaker: true },
  ];
  return all.filter((d) => d.day <= days);
}

// ---------------------------------------------------------------------------
// Copy-based engine (works on copies; fixture-friendly via explicit paths)
// ---------------------------------------------------------------------------

export interface SimDbFiles { nine: string; omni: string; }
export interface SimDayResult {
  day: number;
  mode: 'auto-safe' | 'propose';
  added: string[];
  removed: string[];
  readBack: 'EXACT' | 'MISMATCH' | 'SKIPPED-PROPOSE' | 'SKIPPED-CAP' | 'SKIPPED-STALE';
  quota25: number;
  breaker: boolean;
  proposedCount: number;
  /** G6: removals blocked by the minSteps guard on this day. */
  protectedCount: number;
  hashNineBefore: string;
  hashNineAfter: string;
  hashOmniBefore: string;
  hashOmniAfter: string;
}
export interface SimRunResult {
  days: SimDayResult[];
  hashStart: Record<string, string>;
  hashUndone: Record<string, string>;
  undone: boolean;
}

function integrityOk(dbPath: string): string {
  const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    return String(Object.values(row ?? {})[0] ?? 'unknown');
  } finally { db.close(); }
}

function tableExists(dbPath: string, name: string): boolean {
  const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as unknown;
    return r != null;
  } finally { db.close(); }
}

/** Raw combo rows (exact strings) for one router copy. */
function readRawCombos(dbPath: string, router: RouterName): Array<{ id: string; name: string; raw: string; steps: string[] }> {
  const db = openBetterSqlite3(dbPath, { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const out: Array<{ id: string; name: string; raw: string; steps: string[] }> = [];
    if (router === '9router') {
      const rows = db.prepare('SELECT id, name, models FROM combos ORDER BY name').all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const raw = String(r['models'] ?? '[]');
        let steps: string[] = [];
        try { const p = JSON.parse(raw); if (Array.isArray(p)) steps = p.filter((m): m is string => typeof m === 'string'); } catch { /* keep [] */ }
        out.push({ id: String(r['id'] ?? ''), name: String(r['name'] ?? ''), raw, steps });
      }
    } else {
      const rows = db.prepare('SELECT id, name, data FROM combos ORDER BY name').all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const raw = String(r['data'] ?? '{}');
        let steps: string[] = [];
        try {
          const p = JSON.parse(raw) as { models?: unknown };
          const arr = Array.isArray(p.models) ? p.models : [];
          steps = arr.map((m) => (typeof m === 'string' ? m : (m as { model?: unknown })?.model)).filter((m): m is string => typeof m === 'string');
        } catch { /* keep [] */ }
        out.push({ id: String(r['id'] ?? ''), name: String(r['name'] ?? ''), raw, steps });
      }
    }
    return out;
  } finally { db.close(); }
}

function applyOp(dbPath: string, router: RouterName, comboName: string, op: SimDayOp): { added: string[]; removed: string[]; proposed: string[]; protectedCount: number } {
  // F3 Defect-F3 gates (no write on skip): stale -> deny; cap -> propose list;
  // breaker/proposeOnly -> preview. 0 writes on all three paths.
  if (op.stale || op.cap || op.proposeOnly || op.breaker) {
    const combos = readRawCombos(dbPath, router);
    const combo = combos.find((c) => c.name === comboName) ?? combos[0];
    if (!combo) return { added: [], removed: [], proposed: [], protectedCount: 0 };
    const proposed = op.kind === 'ADD' ? [op.model] : [op.model, ...(op.modelB ? [op.modelB] : [])];
    return { added: [], removed: [], proposed, protectedCount: combo.steps.filter((s) => s.startsWith('test-')).length };
  }
  const combos = readRawCombos(dbPath, router);
  const target = combos[0]; // first combo (alpha order) — deterministic
  if (!target || target.name !== comboName && combos.length > 0) { /* fall through: use first */ }
  const combo = combos.find((c) => c.name === comboName) ?? target;
  if (!combo) return { added: [], removed: [], proposed: [], protectedCount: 0 };
  let next = [...combo.steps];
  const added: string[] = [];
  const removed: string[] = [];
  let protectedCount = 0;
  if (op.kind === 'ADD') {
    if (!next.includes(op.model) && added.length < SIM_DAY_CAP) { next.push(op.model); added.push(`${router}/${combo.name}:${op.model}`); }
  } else if (op.kind === 'REMOVE') {
    const drops = [op.model, ...(op.modelB ? [op.modelB] : [])];
    // Fixture seeds always contain sim/dead-*; when none is present, fall back
    // to the tail step so a removal still exercises the write path.
    const anyPresent = drops.some((d) => next.includes(d));
    const candidates = anyPresent || next.length === 0 ? drops : [...drops, next[next.length - 1]!];
    // F3 Defect-F3: test-* steps never dropped; count them as protected.
    const dropTest = candidates.filter((d) => d.startsWith('test-'));
    protectedCount += dropTest.length;
    const plan = planDrops(next, candidates.filter((d) => !d.startsWith('test-')));
    next = plan.next;
    removed.push(...plan.removed.map((d) => `${router}/${combo.name}:${d}`));
    protectedCount += plan.protectedCount;
    if (op.day === 7 && plan.removed.length === 1 && next.length >= 5) {
      const second = planDrops(next, [next[next.length - 1]!]);
      next = second.next;
      removed.push(...second.removed.map((d) => `${router}/${combo.name}:${d}`));
      protectedCount += second.protectedCount;
    }
  } else if (op.day === 2) {
    if (next.length >= 3) { const t = next[1]!; next[1] = next[2]!; next[2] = t; }
  } else { // day 6 reorder
    if (next.length >= 4) { const [x] = next.splice(3, 1); next.splice(1, 0, x!); }
  }
  // Writer: single column update, matched by id AND name.
  const db = openBetterSqlite3(dbPath, { busyTimeoutMs: 5000 });
  try {
    db.transaction(() => {
      if (router === '9router') {
        db.prepare('UPDATE combos SET models = ?, updatedAt = ? WHERE id = ? AND name = ?')
          .run(JSON.stringify(next), new Date().toISOString(), combo.id, combo.name);
        // ADD path: kv customModels + enabledModels (only when tables/cols exist).
        if (op.kind === 'ADD' && added.length > 0) {
          if (tableExistsIn(db, 'kv')) {
            const [prov, mid] = op.model.split('/');
            db.prepare("INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('customModels', ?, ?)")
              .run(customModelKey(prov ?? '', mid ?? op.model), customModelValue(prov ?? '', mid ?? op.model, `${prov}/${mid}`));
          }
          if (tableExistsIn(db, 'providerConnections')) {
            const rows = db.prepare('SELECT id, provider, data FROM providerConnections').all() as Array<Record<string, unknown>>;
            for (const r of rows) {
              try {
                const data = JSON.parse(String(r['data'] ?? '{}')) as Record<string, unknown>;
                const psd = data['providerSpecificData'];
                if (psd && typeof psd === 'object' && Array.isArray((psd as Record<string, unknown>)['enabledModels'])) {
                  const arr = (psd as Record<string, unknown>)['enabledModels'] as string[];
                  if (!arr.includes(op.model)) arr.push(op.model);
                  db.prepare('UPDATE providerConnections SET data = ? WHERE id = ?').run(JSON.stringify(data), String(r['id'] ?? ''));
                }
              } catch { /* skip row */ }
            }
          }
        }
      } else {
        const row = db.prepare('SELECT data FROM combos WHERE id = ? AND name = ?').get(combo.id, combo.name) as Record<string, unknown> | undefined;
        const data = JSON.parse(String(row?.['data'] ?? '{}')) as Record<string, unknown>;
        const raw = Array.isArray(data['models']) ? data['models'] : [];
        const objMap = new Map<string, unknown>();
        for (const m of raw) {
          const s = typeof m === 'string' ? m : (m as { model?: string })?.model;
          if (s) objMap.set(s, m);
        }
        const nextRaw = next.map((s) => objMap.get(s) ?? s);
        data['models'] = nextRaw;
        db.prepare('UPDATE combos SET data = ?, updated_at = ? WHERE id = ? AND name = ?')
          .run(JSON.stringify(data), new Date().toISOString(), combo.id, combo.name);
        if (op.kind === 'ADD' && added.length > 0 && tableExistsIn(db, 'kv')) {
          const [prov, mid] = op.model.split('/');
          db.prepare("INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('customModels', ?, ?)")
            .run(customModelKey(prov ?? '', mid ?? op.model), customModelValue(prov ?? '', mid ?? op.model, `${prov}/${mid}`));
        }
      }
    });
  } finally { db.close(); }
  return { added, removed, proposed: next, protectedCount };
}

function tableExistsIn(db: ReturnType<typeof openBetterSqlite3>, name: string): boolean {
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as unknown;
    return r != null;
  } catch { return false; }
}

/**
 * Run the simulation against explicit DB copies. The main agent invokes the
 * CLI command (which copies live DBs first); tests call this directly with
 * fixture copies. No live DB is ever opened for read except inside
 * runSimCommand's copy step.
 */
export function runSimSimulation(files: SimDbFiles, days = 7): SimRunResult {
  const scenario = buildSimScenario(days);
  const dayResults: SimDayResult[] = [];
  let quota25 = 0;
  let breaker = false;
  const hashStart: Record<string, string> = {};
  const rawStart: Record<string, string> = {};

  const snapshotOf = (dbPath: string, router: RouterName, tag: string): string => {
    const dest = `${dbPath}.sim-${tag}`;
    fs.copyFileSync(dbPath, dest);
    return dest;
  };
  const hashes = (): { nineB: string; omniB: string; nineA: string; omniA: string; nH: string; oH: string } => {
    const nine = readRawCombos(files.nine, '9router');
    const omni = readRawCombos(files.omni, 'omniroute');
    const nH = hashComboSteps(nine.flatMap((c) => c.steps));
    const oH = hashComboSteps(omni.flatMap((c) => c.steps));
    return { nineB: '', omniB: '', nineA: '', omniA: '', nH, oH };
  };

  for (const c of readRawCombos(files.nine, '9router')) { hashStart[`9router/${c.name}`] = hashComboSteps(c.steps); rawStart[`9router/${c.id}`] = c.raw; }
  for (const c of readRawCombos(files.omni, 'omniroute')) { hashStart[`omniroute/${c.name}`] = hashComboSteps(c.steps); rawStart[`omniroute/${c.id}`] = c.raw; }

  for (const op of scenario) {
    const before = hashes();
    // removal count estimate for mode decision: removals this op would do
    const removals = op.kind === 'REMOVE' ? (op.day === 7 ? 2 : 1) : 0;
    const steps = readRawCombos(files.nine, '9router')[0]?.steps.length ?? 0;
    const dayBreaker = breaker;
    // F3 (C3b): op-level flags force propose/skip with 0 writes (applyOp guard
    // mirrors this); breaker day proposes then pauses the loop (BUG-2 note:
    // quota25 is not incremented on a propose-only day by design).
    const forced: SimDayResult['readBack'] | null = op.stale
      ? 'SKIPPED-STALE'
      : op.cap
        ? 'SKIPPED-CAP'
        : op.proposeOnly || op.breaker
          ? 'SKIPPED-PROPOSE'
          : null;
    const mode = forced ? 'propose' : decideSimMode({ removals, steps, breakerTripped: dayBreaker });
    const snapNine = snapshotOf(files.nine, '9router', `day${op.day}`);
    const snapOmni = snapshotOf(files.omni, 'omniroute', `day${op.day}`);
    let added: string[] = [];
    let removed: string[] = [];
    let protectedToday = 0;
    let readBack: SimDayResult['readBack'] = 'EXACT';
    if (mode === 'propose') {
      // Propose only: preview removals without writing.
      readBack = forced ?? 'SKIPPED-PROPOSE';
      const firstNine = readRawCombos(files.nine, '9router')[0];
      if (firstNine) removed = [op.model, ...(op.modelB ? [op.modelB] : [])].map((m) => `9router/${firstNine.name}:${m}`);
    } else {
      // auto-safe path: snapshot -> integrity -> writer -> EXACT read-back -> rescan.
      const inNine = integrityOk(snapNine);
      const inOmni = integrityOk(snapOmni);
      if (inNine !== 'ok' || inOmni !== 'ok') { breaker = true; }
      for (const c of readRawCombos(files.nine, '9router')) { const r = applyOp(files.nine, '9router', c.name, op); added.push(...r.added); removed.push(...r.removed); protectedToday += r.protectedCount; }
      for (const c of readRawCombos(files.omni, 'omniroute')) { const r = applyOp(files.omni, 'omniroute', c.name, op); added.push(...r.added); removed.push(...r.removed); protectedToday += r.protectedCount; }
      // Read-back: re-read combos; rescan == no missing combos.
      const afterNine = readRawCombos(files.nine, '9router');
      const afterOmni = readRawCombos(files.omni, 'omniroute');
      if (afterNine.length === 0 || afterOmni.length === 0) readBack = 'MISMATCH';
      if (readBack === 'MISMATCH') {
        breaker = true;
        fs.copyFileSync(snapNine, files.nine);
        fs.copyFileSync(snapOmni, files.omni);
      }
      if (added.length > 0 || removed.length > 0) quota25 += 1;
    }
    // Collect removed IDs for log from the day op (already applied above for auto-safe).
    if (mode === 'auto-safe' && removed.length === 0 && op.kind === 'REMOVE') {
      const firstNine = readRawCombos(files.nine, '9router')[0];
      if (firstNine) removed = [`9router/${firstNine.name}:${op.model}`];
    }
    const after = hashes();
    if (op.breaker) breaker = true;
    dayResults.push({
      day: op.day, mode, added, removed, readBack, quota25, proposedCount: mode === 'propose' ? removed.length : 0, protectedCount: protectedToday,
      breaker, hashNineBefore: before.nH, hashNineAfter: after.nH,
      hashOmniBefore: before.oH, hashOmniAfter: after.oH,
    });
    if (op.breaker) break;
  }

  // Final undo: restore raw strings exactly.
  const db9 = openBetterSqlite3(files.nine, { busyTimeoutMs: 5000 });
  try {
    db9.transaction(() => {
      for (const [k, raw] of Object.entries(rawStart)) {
        if (!k.startsWith('9router/')) continue;
        const id = k.slice('9router/'.length);
        db9.prepare('UPDATE combos SET models = ? WHERE id = ?').run(raw, id);
      }
    });
  } finally { db9.close(); }
  const dbO = openBetterSqlite3(files.omni, { busyTimeoutMs: 5000 });
  try {
    dbO.transaction(() => {
      for (const [k, raw] of Object.entries(rawStart)) {
        if (!k.startsWith('omniroute/')) continue;
        const id = k.slice('omniroute/'.length);
        dbO.prepare('UPDATE combos SET data = ? WHERE id = ?').run(raw, id);
      }
    });
  } finally { dbO.close(); }

  const hashUndone: Record<string, string> = {};
  for (const c of readRawCombos(files.nine, '9router')) hashUndone[`9router/${c.name}`] = hashComboSteps(c.steps);
  for (const c of readRawCombos(files.omni, 'omniroute')) hashUndone[`omniroute/${c.name}`] = hashComboSteps(c.steps);
  return { days: dayResults, hashStart, hashUndone, undone: true };
}

// ---------------------------------------------------------------------------
// CLI command: copy live DBs (redacted) -> run -> print
// ---------------------------------------------------------------------------

function simDir(): string {
  const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(base, 'routersync', 'state', 'sim');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function runSimCommand(options: { days?: number; out?: string }): Promise<void> {
  const days = options.days ?? 7;
  const dir = simDir();
  const nineCopy = path.join(dir, '9router.sim.sqlite');
  const omniCopy = path.join(dir, 'omniroute.sim.sqlite');
  // VACUUM INTO refuses to overwrite — a stale copy from a previous sim fails the whole run.
  fs.rmSync(nineCopy, { force: true });
  fs.rmSync(omniCopy, { force: true });
  // Online backup API copy (read-only on live, redacted copy in state dir).
  const src9 = openBetterSqlite3(locateRouterDb('9router'), { readOnly: true, busyTimeoutMs: 5000 });
  try { src9.backup(nineCopy); } finally { src9.close(); }
  const srcO = openBetterSqlite3(locateRouterDb('omniroute'), { readOnly: true, busyTimeoutMs: 5000 });
  try { srcO.backup(omniCopy); } finally { srcO.close(); }

  const result = runSimSimulation({ nine: nineCopy, omni: omniCopy }, days);
  const lines: string[] = [];
  lines.push('ROUTERSYNC SIM (7-day, redacted copies, zero live writes)');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push(`days=${days} copies: ${nineCopy} | ${omniCopy}`);
  for (const d of result.days) {
    lines.push(
      `DAY ${d.day} | mode=${d.mode} | +${d.added.join(',') || '(none)'} | thêm hôm nay=${d.added.length}/cap=${SIM_DAY_CAP} | proposed-only=${d.proposedCount ?? 0} | -${d.removed.join(',') || '(none)'} | gỡ hôm nay=${d.removed.length} | read-back=${d.readBack} | quota2.5=${d.quota25} | protected=${d.protectedCount} | minSteps=${SIM_MIN_STEPS} | breaker=${d.breaker ? 'ON' : 'off'} | hash9=${d.hashNineBefore}->${d.hashNineAfter} | hashOmni=${d.hashOmniBefore}->${d.hashOmniAfter}`
    );
  }
  const eq = Object.keys(result.hashStart).every((k) => result.hashStart[k] === result.hashUndone[k]);
  lines.push(`UNDO | hash before==after: ${eq ? 'YES' : 'NO'} | undone=${result.undone}`);
  for (const [k, v] of Object.entries(result.hashStart)) lines.push(`  UNDO ${k}: start=${v} undone=${result.hashUndone[k]}`);
  const demo = applyAddCaps(Array.from({ length: 25 }, (_, i) => ({ day: 1, kind: 'ADD' as const, model: `demo-${i}/model-${i}` })));
  lines.push(`CAP-ADD-DEMO: kept=${demo.kept.length}/cap=${SIM_ADD_DAY_CAP} combo-cap=${SIM_ADD_PER_COMBO_CAP} deferred=${demo.deferred.length} DEFERRED-BY-CAP=${demo.deferred.length}`);
  lines.push('KICH-BAN: day4=429/timeout stale REMOVE, day5=POSSIBLE-CAP, day6=go-vuot-10pct propose-only, day7=read-back-lech + pause-check');
  lines.push('GO-MODEL-THAT: ngay go model that dung fixture that (calendar sqlite) cho den khi do la SCENARIO-INJECTED: ngay3=SCENARIO-INJECTED, khong phai ngay go that');
  const text = lines.join('\n') + '\n';
  if (options.out) fs.writeFileSync(options.out, text, 'utf8');
  console.log(text);
}
