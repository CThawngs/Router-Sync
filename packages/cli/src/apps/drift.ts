/**
 * packages/cli/src/apps/drift.ts
 *
 * `routersync apps drift` ΓÇö ─æß╗æi chiß║┐u model trong app agent vß╗¢i trß║íng th├íi router
 * (chß╗ë ─æß╗ìc, kh├┤ng ghi).
 *
 * Ph├ón loß║íi mß╗ùi model cß╗ºa app m├á provider trß╗Å tß╗¢i 9Router/OmniRoute:
 *   OK      : c├│ trong catalog cß╗ºa router (tß║ºng A)
 *   DISABLED: c├│ nh╞░ng bß╗ï tß║»t (tß║ºng B) ΓÇö hiß╗çn read-only catalog ch╞░a ph├ón biß╗çt
 *             ─æ╞░ß╗úc, n├¬n count n├áy th╞░ß╗¥ng l├á 0 v├á ─æ╞░ß╗úc ghi ch├║ trong REPORT.
 *   MISSING : router kh├┤ng c├│ model n├áy
 *   UNKNOWN : kh├┤ng ─æß╗ìc ─æ╞░ß╗úc router (lß╗ùi DB, config, ...)
 *   NOT-ROUTED: provider trß╗▒c tiß║┐p (HuggingFace, ...), kh├┤ng qua router
 *
 * UNUSED: model/combo bß║¡t trong router m├á kh├┤ng app n├áo d├╣ng (liß╗çt k├¬ 20 ─æß║ºu).
 */

import * as os from 'node:os';
import type {
  AgentAppInspection,
  AgentAppProvider,
  ComboDefinition,
  ModelInfo,
} from '@routersync/adapter-sdk';
import { AGENT_APP_ADAPTERS, getAgentAppAdapter, type AgentAppId } from './inspect.js';

export type DriftStatus = 'OK' | 'DISABLED' | 'MISSING' | 'UNKNOWN' | 'NOT-ROUTED';

export const DRIFT_STATUSES: DriftStatus[] = ['OK', 'DISABLED', 'MISSING', 'UNKNOWN', 'NOT-ROUTED'];

export interface DriftEntry {
  app: string;
  router: string;
  /** 'provider/id' hiß╗ân thß╗ï. */
  name: string;
  /** Id thuß║ºn cß╗ºa model (d├╣ng ─æß╗â t├¡nh UNUSED). */
  modelId: string;
  kind: 'combo' | 'alias' | 'model' | 'NOT-ROUTED';
  status: DriftStatus;
  reason: string;
}

export interface RouterDriftView {
  router: string;
  /** ID model c├│ trong catalog (readCatalog). */
  catalogIds: Set<string>;
  /** T├¬n combo (readCombos[].id / [].name). */
  comboNames: Set<string>;
  /** T├¬n alias (d├ánh cho t╞░╞íng lai; hiß╗çn ─æß╗ìc tß╗½ combo.name khi khß╗¢p pattern). */
  aliasNames: Set<string>;
}

export interface DriftResult {
  app: string;
  router: string;
  entries: DriftEntry[];
  totals: Record<DriftStatus, number>;
}

export interface DriftReport {
  results: DriftResult[];
  unused: Array<{ router: string; name: string; kind: 'combo' | 'alias' | 'model' }>;
  totals: Record<DriftStatus, number>;
}

export function zeroTotals(): Record<DriftStatus, number> {
  return { OK: 0, DISABLED: 0, MISSING: 0, UNKNOWN: 0, 'NOT-ROUTED': 0 };
}

function providerKindOf(providerId: string, providers: AgentAppProvider[]): string | undefined {
  return providers.find((p) => p.id === providerId)?.kind;
}

export function driftKindOf(modelId: string, comboNames: Set<string>, aliasNames: Set<string>): 'combo' | 'alias' | 'model' {
  if (comboNames.has(modelId)) return 'combo';
  if (aliasNames.has(modelId)) return 'alias';
  return 'model';
}

/** X├óy dß╗▒ng view chß╗ë ─æß╗ìc cß╗ºa mß╗Öt router tß╗½ catalog + combos. */
export function buildRouterView(router: string, catalog: ModelInfo[], combos: ComboDefinition[]): RouterDriftView {
  const catalogIds = new Set(catalog.map((m) => m.id));
  const comboNames = new Set(combos.map((c) => c.id).filter(Boolean));
  for (const c of combos) if (c.name) comboNames.add(c.name);
  const aliasNames = new Set<string>(); // ch╞░a c├│ nguß╗ôn alias ri├¬ng trong read-only catalog
  return { router, catalogIds, comboNames, aliasNames };
}

/**
 * Ph├ón loß║íi drift cß╗ºa mß╗Öt app ─æß╗æi vß╗¢i mß╗Öt router view.
 * Kh├┤ng ghi file; chß╗ë ─æß╗ìc inspection + view.
 */
export function classifyAppDrift(
  app: string,
  inspection: AgentAppInspection,
  view: RouterDriftView
): DriftResult {
  const entries: DriftEntry[] = [];
  const totals = zeroTotals();

  for (const model of inspection.models) {
    const kind = providerKindOf(model.provider, inspection.providers);
    const name = `${model.provider}/${model.id}`;
    if (kind !== 'router') {
      entries.push({
        app,
        router: view.router,
        name,
        modelId: model.id,
        kind: 'NOT-ROUTED',
        status: 'NOT-ROUTED',
        reason: 'provider trß╗▒c tiß║┐p, kh├┤ng qua router',
      });
      totals['NOT-ROUTED']++;
      continue;
    }

    const driftKind = driftKindOf(model.id, view.comboNames, view.aliasNames);
    if (view.catalogIds.has(model.id)) {
      entries.push({
        app,
        router: view.router,
        name,
        modelId: model.id,
        kind: driftKind,
        status: 'OK',
        reason: 'c├│ trong router',
      });
      totals.OK++;
    } else {
      entries.push({
        app,
        router: view.router,
        name,
        modelId: model.id,
        kind: driftKind,
        status: 'MISSING',
        reason: 'kh├┤ng c├│ trong router',
      });
      totals.MISSING++;
    }
  }

  return { app, router: view.router, entries, totals };
}

/** Gß╗Öp nhiß╗üu kß║┐t quß║ú th├ánh b├ío c├ío, t├¡nh UNUSED v├á tß╗òng hß╗úp. */
export function buildDriftReport(
  results: DriftResult[],
  views: RouterDriftView[]
): DriftReport {
  const used = new Set<string>();
  for (const r of results) {
    for (const e of r.entries) {
      if (e.kind !== 'NOT-ROUTED') used.add(`${r.router}|${e.modelId}`);
    }
  }

  const unused: Array<{ router: string; name: string; kind: 'combo' | 'alias' | 'model' }> = [];
  for (const v of views) {
    for (const id of v.catalogIds) {
      if (used.has(`${v.router}|${id}`)) continue;
      unused.push({ router: v.router, name: id, kind: driftKindOf(id, v.comboNames, v.aliasNames) });
    }
  }
  unused.sort((a, b) => a.router.localeCompare(b.router) || a.name.localeCompare(b.name));

  const totals = zeroTotals();
  for (const r of results) {
    for (const s of DRIFT_STATUSES) totals[s] += r.totals[s];
  }

  return { results, unused, totals };
}

export function getDriftAdapter(app: string): AgentAppId | undefined {
  return AGENT_APP_ADAPTERS.find((a) => a.app === app)?.app as AgentAppId | undefined;
}

export async function inspectAppDrift(
  app: AgentAppId,
  homeDir: string,
  config?: string
): Promise<AgentAppInspection> {
  const adapter = getAgentAppAdapter(app);
  if (!adapter) throw new Error(`kh├┤ng hß╗ù trß╗ú app: ${app}`);
  return adapter.inspect({ ...(config ? { configPath: config } : {}), homeDir });
}

export function renderDriftTable(report: DriftReport): string {
  const pad = (value: string, width: number): string =>
    value.length >= width ? value : value + ' '.repeat(width - value.length);

  const rows: string[][] = [['app', 'router', 't├¬n', 'kind', 'trß║íng th├íi', 'l├╜ do']];
  for (const r of report.results) {
    for (const e of r.entries) {
      rows.push([r.app, r.router, e.name, e.kind, e.status, e.reason]);
    }
  }

  const widths = [0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
  }
  const body = rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');

  const lines: string[] = [body, ''];
  const t = report.totals;
  lines.push(
    `Tß╗öNG: OK=${t.OK} DISABLED=${t.DISABLED} MISSING=${t.MISSING} UNKNOWN=${t.UNKNOWN} NOT-ROUTED=${t['NOT-ROUTED']} UNUSED=${report.unused.length}`
  );
  if (report.unused.length > 0) {
    lines.push('');
    lines.push('UNUSED (20 ─æß║ºu):');
    for (const u of report.unused.slice(0, 20)) {
      lines.push(`  ${u.router}  ${u.kind}  ${u.name}`);
    }
  }
  return lines.join('\n');
}
