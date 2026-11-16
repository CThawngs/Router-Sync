/**
 * packages/daemon/src/jobs.ts
 *
 * Real job implementations for the daemon scheduler (A3):
 *  - scan:    provider model lists via injected fetch (CLI injects the real
 *             reuse of cli/src/sync/providers.ts fetchModelList; daemon never
 *             re-implements provider fetching).
 *  - health:  read-only router DB combos (better-sqlite3 via @routersync/core
 *             reader), label the first combo incl. warnings.
 *  - plan:    propose add/remove/keep/HOLD/BLOCKED from scan + combos.
 *  - digest:  text summary from job results.
 *  - cleanup: delete only old RouterSync snapshot JSON in state dir.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeComboPlan, type ComboDefinition, type ComboRule, type ModelInfo } from '@routersync/core/readonly';
import { readRouterCombos, type ParsedComboRecord } from './db/reader.js';

export interface Clock {
  now(): number;
}
export const realClock: Clock = { now: () => Date.now() };

export function stateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] ?? path.join(os.homedir(), '.routersync');
}

// ------------------------------------------------------------------ scan

export interface ScanTarget {
  id: string;
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  skipReason?: string | undefined;
}
export interface ScanOutcomeLike {
  ok: boolean;
  status: number;
  models: string[];
  error?: string | undefined;
  latencyMs: number;
}
export type FetchModelListFn = (target: ScanTarget) => Promise<ScanOutcomeLike>;

export interface ScanProviderResult {
  id: string;
  label: string;
  host: string;
  status: number;
  models: number;
  bytes: number;
  durationMs: number;
  skipped?: boolean | undefined;
  flags: string[];
}
export interface ScanResult {
  providers: ScanProviderResult[];
  /** Live model ids keyed by provider id (only for successfully scanned providers). */
  modelLists: Map<string, string[]>;
  totalModels?: number | undefined;
  parity?: number | undefined;
}

export function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '(none)';
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(invalid)';
  }
}

export async function runScanJob(options: {
  targets: ScanTarget[];
  fetchModelList: FetchModelListFn;
  clock?: Clock | undefined;
}): Promise<ScanResult> {
  const clock = options.clock ?? realClock;
  const providers: ScanProviderResult[] = [];
  const modelLists = new Map<string, string[]>();
  for (const target of options.targets) {
    const start = clock.now();
    if (target.skipReason) {
      providers.push({
        id: target.id,
        label: target.label ?? target.id,
        host: hostOf(target.baseUrl),
        status: 0,
        models: 0,
        bytes: 0,
        durationMs: 0,
        skipped: true,
        flags: [`skip:${target.skipReason}`],
      });
      continue;
    }
    const out = await options.fetchModelList(target);
    if (out.ok) modelLists.set(target.id, out.models);
    const bytes = out.models.reduce((n, id) => n + Buffer.byteLength(id, 'utf8') + 1, 0);
    providers.push({
      id: target.id,
      label: target.label ?? target.id,
      host: hostOf(target.baseUrl),
      status: out.status,
      models: out.models.length,
      bytes,
      durationMs: out.latencyMs ?? Math.max(0, clock.now() - start),
      flags: out.ok ? [] : [out.error ?? 'scan-failed'],
    });
  }
  // C3m M1: daemon scan job dùng chung fetchModelList như CLI; 6 là provider-count,
  // 217 là tổng models (sum over providers), không phải cùng đơn vị nên không mâu thuẫn.
  const totalModels = providers.reduce((n, p) => n + p.models, 0);
  const parity = providers.filter((p) => !p.skipped && p.flags.length === 0).length;
  return { providers, modelLists, totalModels, parity } as ScanResult & { totalModels: number; parity: number };
}

// ---------------------------------------------------------------- health

export interface HealthRouterResult {
  router: string;
  ok: boolean;
  firstComboLabel?: string | undefined;
  warnings: string[];
}
export interface HealthResult {
  routers: HealthRouterResult[];
}

export type ComboReader = (router: '9router' | 'omniroute') => ParsedComboRecord[];

/** Label the first combo incl. warnings (empty / <2 steps / no strategy). */
export function comboLabel(combos: ParsedComboRecord[]): { label: string; warnings: string[] } {
  const warnings: string[] = [];
  if (combos.length === 0) return { label: '(no combos)', warnings: ['no-combos'] };
  const first = combos[0]!;
  if (first.models.length === 0) warnings.push(`${first.name}:empty-steps`);
  if (first.models.length > 0 && first.models.length < 2) warnings.push(`${first.name}:below-min-steps`);
  if (first.strategy === undefined) warnings.push(`${first.name}:strategy-not-measured`);
  return { label: `${first.name} (${first.models.length} steps)`, warnings };
}

export function runHealthJob(options: { readCombos?: ComboReader | undefined } = {}): HealthResult {
  const read = options.readCombos ?? ((r) => {
    const res = readRouterCombos(r);
    return res.ok && Array.isArray(res.data) ? res.data : [];
  });
  const routers: HealthRouterResult[] = [];
  for (const router of ['9router', 'omniroute'] as const) {
    try {
      const combos = read(router);
      const { label, warnings } = comboLabel(combos);
      routers.push({ router, ok: true, firstComboLabel: label, warnings });
    } catch (err) {
      routers.push({ router, ok: false, warnings: [err instanceof Error ? err.message : 'health-failed'] });
    }
  }
  return { routers };
}

// ------------------------------------------------------------------ plan

export interface PlanCounts {
  add: number;
  remove: number;
  keep: number;
  hold: number;
  blocked: number;
}
export interface PlanResult extends PlanCounts {
  items: string[];
  planHash?: string | undefined;
}

// ---------------------------------------------------------------- digest

export function buildDigest(parts: {
  scan?: ScanResult | undefined;
  health?: HealthResult | undefined;
  plan?: PlanResult | undefined;
}): string {
  const lines: string[] = [];
  if (parts.scan) {
    const ok = parts.scan.providers.filter((p) => !p.skipped && p.flags.length === 0).length;
    lines.push(`scan: ${ok}/${parts.scan.providers.length} providers ok`);
  }
  if (parts.health) {
    for (const r of parts.health.routers) {
      lines.push(`health ${r.router}: ${r.firstComboLabel ?? 'unreadable'}${r.warnings.length ? ` [${r.warnings.join(', ')}]` : ''}`);
    }
  }
  if (parts.plan) {
    lines.push(`plan: +${parts.plan.add} -${parts.plan.remove} keep=${parts.plan.keep} HOLD=${parts.plan.hold} BLOCKED=${parts.plan.blocked}`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------- cleanup

export interface CleanupResult {
  removed: string[];
  kept: number;
}

/** Delete only *.json snapshots older than maxAgeDays under stateDir/snapshots. Never touches router DBs. */
export function runCleanupJob(options: {
  stateDir?: string | undefined;
  maxAgeDays?: number | undefined;
  clock?: Clock | undefined;
}): CleanupResult {
  const root = path.resolve(options.stateDir ?? stateDir(), 'snapshots');
  const cutoff = (options.clock ?? realClock).now() - (options.maxAgeDays ?? 30) * 86_400_000;
  const removed: string[] = [];
  let kept = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { removed, kept: 0 };
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed.push(name);
    } else {
      kept++;
    }
  }
  return { removed, kept };
}
