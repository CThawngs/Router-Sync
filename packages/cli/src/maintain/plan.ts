/**
 * packages/cli/src/maintain/plan.ts
 *
 * Pure function model maintenance planner for RouterSync (M1–M12).
 * STRICTLY PURE: No I/O, no network calls, no mutating inputs, deterministic planHash.
 */

import { createHash } from 'node:crypto';

export interface MaintainComboRule {
  providers?: string[];
  match?: string;
  maxAdds?: number;
}

export interface MaintainCombo {
  id: string;
  name?: string;
  managed: boolean;
  adopted?: boolean;
  adoptMode?: 'guard' | string;
  models: string[];
  rule?: MaintainComboRule;
  autoMaintain?: boolean;
  freeOnly?: boolean;
}

export interface MaintainProviderItem {
  status?: string;
  removed?: string[];
  added?: Array<{ id: string; free?: boolean }>;
}

export interface MaintainAgentTarget {
  id: string;
  status?: string;
}

export interface MaintainPlanInput {
  router: string;
  policyMode?: string;
  combos: MaintainCombo[];
  providers: Record<string, MaintainProviderItem>;
  agents?: MaintainAgentTarget[];
}

export interface PlanRemove {
  combo: string;
  model: string;
  reason?: string;
}

export interface PlanAdd {
  combo: string;
  model: string;
  position: 'end';
}

export interface PlanBlocked {
  combo: string;
  model?: string;
  reason: string;
}

export interface PlanAgentTarget {
  id: string;
  status: 'unverified';
}

export interface PlanSummary {
  unmanagedTouched: number;
  autoEligible: string[];
}

export interface MaintainPlanResult {
  removes: PlanRemove[];
  adds: PlanAdd[];
  blocked: PlanBlocked[];
  agentTargets: PlanAgentTarget[];
  summary: PlanSummary;
  planHash: string;
}

function getModelProvider(modelId: string): string | null {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0) return null;
  return modelId.slice(0, slashIdx);
}

/**
 * Pure function computePlan: evaluates model additions and removals deterministically.
 */
export function computePlan(input: MaintainPlanInput): MaintainPlanResult {
  const removes: PlanRemove[] = [];
  const adds: PlanAdd[] = [];
  const blocked: PlanBlocked[] = [];

  const addBlocked = (combo: string, reason: string, model?: string) => {
    const exists = blocked.some(
      (b) => b.combo === combo && b.reason === reason && (model ? b.model === model : b.model === undefined)
    );
    if (!exists) {
      if (model) {
        blocked.push({ combo, model, reason });
      } else {
        blocked.push({ combo, reason });
      }
    }
  };

  // Agent targets: sorted by ID, always unverified
  const agentTargets: PlanAgentTarget[] = (input.agents || [])
    .map((a) => ({ id: a.id, status: 'unverified' as const }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const providers = input.providers || {};

  // M8: Condition D26 for 9Router (only manual or shadow allowed)
  const is9Router = input.router === '9router';
  const d26Blocked = is9Router && input.policyMode !== 'manual' && input.policyMode !== 'shadow';

  const autoEligibleCombos = new Set<string>();

  for (const combo of input.combos) {
    if (d26Blocked) {
      addBlocked(combo.id, 'd26-manual');
      continue;
    }

    // M3: Combo unmanaged check
    if (!combo.managed && !combo.adopted) {
      addBlocked(combo.id, 'unmanaged');
      continue;
    }

    const isAdoptGuard = !combo.managed && combo.adopted && combo.adoptMode === 'guard';

    // Check for provider-not-ok on combo rule providers or models
    let providerNotOkForCombo = false;
    if (combo.rule?.providers) {
      for (const pName of combo.rule.providers) {
        const prov = providers[pName];
        if (prov?.status && prov.status !== 'ok') {
          addBlocked(combo.id, 'provider-not-ok');
          providerNotOkForCombo = true;
          break;
        }
      }
    }

    // Evaluate Removals (M2)
    // Both managed and adopt-guard combos can have models removed
    const comboModels = combo.models || [];
    const candidateRemoves: string[] = [];

    for (const model of comboModels) {
      const pName = getModelProvider(model);
      if (!pName) continue;
      const prov = providers[pName];
      if (!prov) continue;

      if (prov.status && prov.status !== 'ok') {
        if (!providerNotOkForCombo) {
          addBlocked(combo.id, 'provider-not-ok');
          providerNotOkForCombo = true;
        }
        continue;
      }

      if (prov.removed && prov.removed.includes(model)) {
        candidateRemoves.push(model);
      }
    }

    let removesApplied = 0;
    if (candidateRemoves.length > 0) {
      const remainingCount = comboModels.length - candidateRemoves.length;
      if (remainingCount < 2) {
        // M2: min-steps rule: must maintain at least 2 fallback steps
        addBlocked(combo.id, 'min-steps');
      } else {
        for (const model of candidateRemoves) {
          removes.push({ combo: combo.id, model, reason: 'model-removed' });
          removesApplied++;
        }
      }
    }

    // Evaluate Additions (M1, M3, M9, M10, M11)
    let addsApplied = 0;
    if (isAdoptGuard) {
      // Adopt-guard combos can NEVER add models
      if (combo.rule?.providers) {
        for (const pName of combo.rule.providers) {
          const prov = providers[pName];
          if (prov?.added && prov.added.length > 0) {
            addBlocked(combo.id, 'adopt-guard');
            break;
          }
        }
      }
    } else if (combo.managed && combo.rule?.providers && !providerNotOkForCombo) {
      const candidateAdds: string[] = [];
      const matchRegex = combo.rule.match ? new RegExp(combo.rule.match) : null;

      for (const pName of combo.rule.providers) {
        const prov = providers[pName];
        if (!prov || (prov.status && prov.status !== 'ok')) continue;

        for (const item of prov.added || []) {
          // Model already in combo -> skip (M11)
          if (comboModels.includes(item.id)) continue;

          // Match regex filter (M1)
          if (matchRegex && !matchRegex.test(item.id)) continue;

          // Free-only check (M10)
          if (combo.freeOnly) {
            if (item.free !== true) {
              addBlocked(combo.id, 'not-free', item.id);
              continue;
            }
          }

          if (!candidateAdds.includes(item.id)) {
            candidateAdds.push(item.id);
          }
        }
      }

      // Sort candidate adds alphabetically (M9)
      candidateAdds.sort((a, b) => a.localeCompare(b));

      // Max adds cap (M9)
      const maxAdds = combo.rule.maxAdds ?? 3;
      if (candidateAdds.length > maxAdds) {
        addBlocked(combo.id, 'add-cap');
      }

      const acceptedAdds = candidateAdds.slice(0, maxAdds);
      for (const model of acceptedAdds) {
        adds.push({ combo: combo.id, model, position: 'end' });
        addsApplied++;
      }
    }

    // Auto-eligible check (M9)
    if (combo.autoMaintain === true && (removesApplied > 0 || addsApplied > 0)) {
      autoEligibleCombos.add(combo.id);
    }
  }

  // Canonical representation for deterministic planHash
  const canonicalPayload = JSON.stringify({
    router: input.router ?? '',
    removes: removes
      .map((r) => ({ c: r.combo, m: r.model }))
      .sort((a, b) => a.c.localeCompare(b.c) || a.m.localeCompare(b.m)),
    adds: adds
      .map((a) => ({ c: a.combo, m: a.model, p: a.position }))
      .sort((a, b) => a.c.localeCompare(b.c) || a.m.localeCompare(b.m)),
    blocked: blocked
      .map((b) => ({ c: b.combo, m: b.model ?? '', r: b.reason }))
      .sort((a, b) => a.c.localeCompare(b.c) || a.m.localeCompare(b.m) || a.r.localeCompare(b.r)),
    agentTargets: agentTargets
      .map((a) => ({ id: a.id, s: a.status }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });

  const planHash = createHash('sha256').update(canonicalPayload).digest('hex').slice(0, 16);

  const summary: PlanSummary = {
    unmanagedTouched: 0,
    autoEligible: Array.from(autoEligibleCombos).sort((a, b) => a.localeCompare(b)),
  };

  return {
    removes,
    adds,
    blocked,
    agentTargets,
    summary,
    planHash,
  };
}
