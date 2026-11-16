/**
 * packages/cli/src/commands/sync/sync-plan.ts
 *
 * Building router views (adopt/exclude guard, provider targets), printing the
 * target list and the sync plan, and loading the read-only catalog counts.
 * Pure printing + data assembly; no network, no writes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hostOf,
  keySourceLabel,
  resolveProviderTargets,
  skipReasonLabel,
  type ProviderTarget,
} from '../../sync/providers.js';
import {
  computeSyncPlan,
  type ComboInput,
  type ProviderLive,
  type SyncPlan,
} from '../../sync/plan.js';
import { parseComboStep } from '../../sync/normalize.js';
import { loadConfigFile, resolveRouterDbPath } from '../../config/loader.js';
import { RouterSyncConfigSchema, type RouterSyncConfig } from '../../config/schema.js';
import { createAdapterForRouter } from '../../adapters.js';
import { canonicalPrefix } from '../../sync/providers.js';
import type { RouterName } from '../../sync/write.js';

export interface RouterView {
  name: RouterName;
  /**
   * The database this view was read from (C4n/N5).
   *
   * The apply path compares this with the path the writer would touch, so a
   * plan shown for one database can never be applied to another.
   */
  dbPath: string;
  targets: ProviderTarget[];
  combos: ComboInput[];
}

/** Model count per provider from 9Router's read-only model-catalog.json. */
export function loadCatalogCounts(): Map<string, number> {
  const file = path.join(
    process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    '9router',
    'model-catalog.json'
  );
  const counts = new Map<string, number>();
  if (!fs.existsSync(file)) return counts;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      models?: Record<string, unknown>;
    };
    for (const key of Object.keys(parsed.models ?? {})) {
      const idx = key.indexOf(':');
      if (idx <= 0) continue;
      const provider = key.slice(0, idx).toLowerCase();
      counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
  } catch {
    return counts;
  }
  return counts;
}

export function adoptGuardSet(
  config: RouterSyncConfig
): { adopted: Set<string>; declared: Set<string>; excluded: Set<string> } {
  const adopted = new Set<string>(
    config.adopt
      .filter((a) => a.mode === 'guard' || a.mode === 'full')
      .map((a) => `${a.router}:${a.name}`)
  );
  const declared = new Set<string>(config.combos.map((c) => c.name));
  const excluded = new Set<string>(
    [
      ...(config.exclude ?? []),
      ...config.combos.flatMap((c) => (c.exclude ?? []).map((e: string) => e)),
    ]
  );
  return { adopted, declared, excluded };
}

export function inScope(
  view: { name: string },
  comboName: string,
  sets: { adopted: Set<string>; declared: Set<string>; excluded: Set<string> }
): boolean {
  if (sets.excluded.has(comboName)) return false;
  return sets.adopted.has(`${view.name}:${comboName}`) || sets.declared.has(comboName);
}

export async function buildViews(
  config: RouterSyncConfig,
  only: string
): Promise<RouterView[]> {
  const sets = adoptGuardSet(config);
  const wanted = config.routers.filter(
    (r: { id: string; adapter: string }) => only === 'all' || r.id === only || r.adapter === only
  );
  if (wanted.length === 0) throw new Error(`no configured router matches '${only}'`);

  const views: RouterView[] = [];
  // 9Router first: its plaintext keys are the source for OmniRoute's
  // encrypted-but-same-provider connections (ROUND 56 §2c).
  const ordered = [...wanted].sort((a, b) =>
    a.adapter === '9router' ? -1 : b.adapter === '9router' ? 1 : 0
  );
  const shared = new Map<string, { apiKey: string; baseUrl?: string | undefined }>();

  for (const router of ordered) {
    const name = router.adapter as RouterName;
    const adapter = createAdapterForRouter(router);
    const combos = await adapter.readCombos();
    const inputs: ComboInput[] = combos.map((combo) => ({
      router: name,
      id: combo.id,
      name: combo.name,
      steps: combo.models,
      excluded: !inScope({ name }, combo.name, sets),
      guardBlocked: sets.excluded.has(combo.name) ? 'excluded' : undefined,
    }));
    const prefixes = new Set<string>();
    for (const combo of inputs) {
      if (combo.excluded) continue;
      for (const step of combo.steps) {
        const parsed = parseComboStep(step);
        if (parsed.prefix !== '') prefixes.add(parsed.prefix);
      }
    }
    const targets = resolveProviderTargets(name, [...prefixes], shared);
    if (name === '9router') {
      for (const target of targets) {
        if (target.apiKey) {
          shared.set(canonicalPrefix(target.prefix), {
            apiKey: target.apiKey,
            baseUrl: target.baseUrl,
          });
        }
      }
    }
    views.push({ name, dbPath: resolveRouterDbPath(router), targets, combos: inputs });
  }
  return views;
}

export function printTargets(views: RouterView[]): void {
  for (const view of views) {
    const reachable = view.targets.filter((t) => !t.skipReason);
    console.log(
      `SYNC-TARGETS router=${view.name} providers=${view.targets.length} keyed-get=${reachable.length}`
    );
    for (const target of view.targets) {
      if (target.skipReason) {
        console.log(
          `  SKIP provider=${target.label} prefix=${target.prefix} lý do=${skipReasonLabel(target.skipReason)}`
        );
      } else {
        console.log(
          `  GET  provider=${target.label} prefix=${target.prefix} host=${hostOf(target.baseUrl)} key=${keySourceLabel(target.keySource, view.name)}`
        );
      }
    }
  }
}

export function printPlan(plan: SyncPlan, views: RouterView[]): void {
  for (const view of views) {
    const combos = plan.combos.filter((c) => c.router === view.name);
    const providers = plan.providers.filter(
      (p) => p.router === view.name && (p.comboSteps > 0 || p.removals > 0)
    );

    console.log('');
    console.log(`== ${view.name} ==`);

    console.log('-- nhà cung cấp --');
    if (providers.length === 0) console.log('  (không có)');
    for (const p of providers) {
      if (p.outcome === 'SKIP') {
        console.log(
          `  ${p.prefix}: BỎ QUA (${p.reason ?? 'unknown'}), ${p.comboSteps} bước, giữ nguyên toàn bộ`
        );
        continue;
      }
      const kept = p.comboSteps - p.removals;
      const catalog = p.catalogCount === undefined ? 'n/a' : String(p.catalogCount);
      console.log(
        `  ${p.prefix}: quét OK (live ${p.liveCount1}/${p.liveCount2}, catalog ${catalog}), ${p.comboSteps} bước, khớp ${p.matchedSteps}, giữ ${kept}, gỡ ${p.removals}`
      );
      if (p.removals > 0) console.log(`    gỡ: ${p.sampleRemovals.join(', ')}`);
    }

    console.log('-- combo --');
    for (const c of combos) {
      if (c.blockedReason) {
        console.log(`  ${c.name}: BỎ QUA (${c.blockedReason}), ${c.before} bước`);
      } else if (c.removals.length > 0) {
        console.log(`  ${c.name}: ${c.before} -> ${c.after} (gỡ ${c.removals.length})`);
      } else {
        console.log(`  ${c.name}: ${c.before} bước, không đổi`);
      }
    }

    console.log('-- MỚI --');
    const fresh = plan.providers.filter((p) => p.router === view.name && p.newModels.count > 0);
    if (fresh.length === 0) console.log('  (không có)');
    for (const p of fresh) {
      console.log(`  ${p.prefix}: ${p.newModels.count} model chưa có trong combo nào`);
      if (p.newModels.sample.length > 0) console.log(`    ${p.newModels.sample.join(', ')}`);
    }
  }

  console.log('');
  console.log(
    `SYNC-PLAN planHash=${plan.planHash} remove=${plan.totalRemovals} combos=${plan.changedCombos} warns=${plan.warnings.length}`
  );
  for (const warning of plan.warnings) console.log(`  WARN ${warning}`);
}
