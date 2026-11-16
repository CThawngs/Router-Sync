/**
 * packages/cli/src/commands/plan.ts
 *
 * Implements `routersync plan` command.
 * Calculates deterministic diff (Plan) for each configured router.
 */

import { createHash } from 'node:crypto';
import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import { planCombos, type ComboRule, type ModelInfo, type Plan } from '@routersync/core';

export interface PlanCommandOptions {
  configPath?: string;
  json?: boolean;
}

export interface RouterPlanResult {
  routerId: string;
  adapter: string;
  plan: Plan;
  totalSteps: number;
  keepSteps: number;
}

export async function generatePlansForConfig(configPath?: string): Promise<{
  configFile: string;
  results: RouterPlanResult[];
}> {
  const { config, filePath } = loadConfigFile(configPath);
  const results: RouterPlanResult[] = [];

  for (const router of config.routers) {
    const adapter = createAdapterForRouter(router);

    // Read current combos and catalog
    let currentCombos = await adapter.readCombos().catch(() => []);
    let catalog = await adapter.readCatalog().catch(() => []);

    // If catalog is empty from router, provide fallbacks from existing combos
    if (catalog.length === 0) {
      const modelSet = new Set<string>();
      for (const c of currentCombos) {
        for (const m of c.models) modelSet.add(m);
      }
      for (const c of config.combos) {
        for (const p of c.pin) modelSet.add(p);
      }
      catalog = Array.from(modelSet).map((id) => ({
        id,
        provider: id.includes('/') ? id.split('/')[0]! : 'generic',
        status: 'active' as const,
      }));
    }

    // Convert config.combos applicable to this router into ComboRules
    const applicableCombos = config.combos.filter((c) => c.routers.includes(router.id));
    const rules: ComboRule[] = applicableCombos.map((spec) => ({
      comboId: spec.name,
      name: spec.name,
      strategy: 'priority',
      minSteps: 1,
      maxSteps: spec.size,
      freeOnly: spec.constraints.freeOnly,
      requiredCapabilities: spec.constraints.toolUse === 'required' ? ['functionCalling'] : [],
      excludedModels: spec.exclude,
      pinnedModels: spec.pin,
    }));

    const routerAdopts = (config.adopt ?? [])
      .filter((a) => a.router === router.id)
      .map((a) => ({ name: a.name, mode: a.mode }));

    const plan = planCombos(currentCombos, catalog, rules, {
      target: router.id,
      adopt: routerAdopts,
    });
    results.push({
      routerId: router.id,
      adapter: router.adapter,
      plan,
      totalSteps: currentCombos.reduce((n: number, c) => n + c.models.length, 0),
      keepSteps: currentCombos.reduce((n: number, c) => n + c.models.length, 0) + plan.additions.reduce((n: number, a) => n + a.models.length, 0) - plan.deletions.length,
    });
  }

  return { configFile: filePath, results };
}

/** C3o O1(d): kế hoạch gỡ >25% bước hiện có, hoặc giữ=0 khi còn bước, là đáng ngờ. */
export function isPlanSuspect(totalSteps: number, remove: number, keep: number): boolean {
  if (totalSteps <= 0) return totalSteps === 0 ? keep === 0 && remove > 0 : false;
  return remove / totalSteps > 0.25 || keep === 0;
}

export async function runPlanCommand(options: PlanCommandOptions): Promise<void> {
  const { configFile, results } = await generatePlansForConfig(options.configPath);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, configFile, plans: results }, null, 2));
    return;
  }

  console.log(`[routersync] Generated plans for ${results.length} router(s) from ${configFile}:`);

  for (const r of results) {
    const plan = r.plan;
    const totalChanges = plan.additions.length + plan.modifications.length + plan.deletions.length;
    const planHash = createHash('sha256')
      .update(JSON.stringify({ a: plan.additions, m: plan.modifications, d: plan.deletions, r: plan.reasons ?? {} }))
      .digest('hex').slice(0, 16);
    const suspect = isPlanSuspect(r.totalSteps, plan.deletions.length, r.keepSteps);

    console.log(`\n--- Router: [${r.routerId}] (${r.adapter}) | Plan ID: ${plan.id} ---`);
    const reasonCounts = new Map<string, number>();
    for (const reason of Object.values(plan.reasons ?? {})) reasonCounts.set(String(reason), (reasonCounts.get(String(reason)) ?? 0) + 1);
    console.log(`  COUNTS: thêm=${plan.additions.length} gỡ=${plan.deletions.length} giữ=${r.keepSteps} (khớp số bước hiện có=${r.totalSteps}) HOLD=${reasonCounts.get('HOLD') ?? 0} BLOCKED=${reasonCounts.get('BLOCKED') ?? 0} planHash=${planHash}${suspect ? ' PLAN-SUSPECT' : ''}`);
    if (reasonCounts.size) console.log(`  ĐẾM-THEO-LÝ-DO: ${[...reasonCounts.entries()].map(([k, v]) => `${k}=${v}`).join(' | ')}`);
    if (totalChanges === 0) {
      console.log(`  (không cần thay đổi - combo đã đồng bộ)`);
      continue;
    }

    for (const add of plan.additions) {
      console.log(`  + [ADD] ${add.name} (${add.strategy}) -> models: [${add.models.join(', ')}]`);
      if (plan.reasons[add.id]) {
        console.log(`    reason: ${plan.reasons[add.id]}`);
      }
    }

    for (const mod of plan.modifications) {
      console.log(`  ~ [MOD] ${mod.name} (${mod.strategy}) -> models: [${mod.models.join(', ')}]`);
      if (plan.reasons[mod.id]) {
        console.log(`    reason: ${plan.reasons[mod.id]}`);
      }
    }

    for (const delId of plan.deletions) {
      console.log(`  - [DEL] ${delId}`);
      if (plan.reasons[delId]) {
        console.log(`    reason: ${plan.reasons[delId]}`);
      }
    }
  }
}
