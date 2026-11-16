/**
 * packages/cli/src/commands/autopilot.ts
 *
 * Unified auto-maintenance plan per router (propose-only, NO writes at R62).
 * Combines: (i) drop dead models per R1-R6 (two scans 60s apart);
 * (ii) add FREE-BY-SUFFIX / FREE-BY-PRICE candidates from discover;
 * (iii) reorder per ranking.yaml, plus health-demote if enabled.
 *
 * Protection layers:
 *   - R2: provider with <50% step-match vs live is skipped (provider-skipped reason=low-match).
 *   - If a plan would remove >10% of a combo's steps, it is BLOCKED-SUSPICIOUS
 *     and no removals are proposed for the involved providers.
 *
 * Writes autopilot-plan.json (with planHash + blocked field) + human-readable
 * text to %LOCALAPPDATA%\routersync\state\plans\ and prints the path.
 *
 * Config: autonomy: observe | propose (default propose). 'auto-safe' rejected.
 * Pins:   pins: { "<router>/<combo>": [id, …] } — pinned steps stay at head.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { locateRouterDb, openBetterSqlite3 } from '@routersync/core';
import { buildViews } from './sync/sync-plan.js';
import { scanAll } from './sync/sync-scan.js';
import { loadConfigFile } from '../config/loader.js';
import { loadRankingConfig } from '../rank/config.js';
import { rankComboModels, isComboExcluded } from '../rank/ranker.js';
import type { RankingConfig } from '../rank/types.js';
import { assignTier } from '../rank/comparator.js';
import { fetchModelEntries } from '../sync/providers.js';
import { confirmAbsent, dropDecision } from '../sync/confirm.js';
import { STR } from './display-strings.js';
import { classifyPrice, isFreeSuffix, load9RouterCatalogMetadata, loadOmniRouteTierAssignments } from './discover.js';
import { parseComboStep, type ComboStep } from '../sync/normalize.js';
import { readComboModels } from '../sync/write.js';
import type { RouterName } from '../sync/write.js';

const REMOVAL_BLOCK_RATIO = 0.10; // >10% of combo steps removed => blocked
export const R2_MIN_MATCH = 0.5;
export function computeProviderMatch(stepKeys: string[], liveKeysR2: Set<string>): { matched: number; steps: number; ratio: number } {
  let matched = 0;
  for (const k of stepKeys) if (liveKeysR2.has(k)) matched++;
  const steps = stepKeys.length;
  return { matched, steps, ratio: steps > 0 ? matched / steps : 0 };
}
export function reorderNeedsOwner(changePct: number, tierUnknownPct: number): boolean {
  return changePct > 0.25 || tierUnknownPct > 0.2;
}
export function isRemovalBlocked(removals: number, comboSteps: number): boolean {
  return comboSteps > 0 && removals / comboSteps > REMOVAL_BLOCK_RATIO;
}

/** keepHead: N bước đầu giữ nguyên thứ tự; phần còn lại xếp theo ranking. keepHead=0 = hành vi cũ. */
export function applyKeepHead(models: string[], keepHead: number): { head: string[]; orderable: string[] } {
  const n = Math.max(0, Math.min(keepHead, models.length));
  return { head: models.slice(0, n), orderable: models.slice(n) };
}

interface PlanChange {
  type: 'DROP-DEAD' | 'ADD-FREE' | 'REORDER';
  router: string;
  combo: string;
  position?: number;
  modelId?: string;
  reason: string;
  evidence: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  blocked: boolean;
}

function stateDir(): string {
  const base = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(base, 'routersync', 'state', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function planFile(baseName: string): string {
  return path.join(stateDir(), baseName);
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function loadAutonomy(): { mode: 'observe' | 'propose' } {
  try {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const file = path.join(appData, 'routersync', 'autopilot.yaml');
    if (!fs.existsSync(file)) return { mode: 'propose' };
    const { parse } = require('yaml');
    const parsed = parse(fs.readFileSync(file, 'utf8'));
    const mode = parsed?.autonomy;
    if (mode === 'auto-safe') {
      throw new Error('chua ho tro, xem docs/DESIGN-AUTOPILOT.md');
    }
    return { mode: mode === 'observe' ? 'observe' : 'propose' };
  } catch {
    return { mode: 'propose' };
  }
}

function loadPins(): Map<string, string[]> {
  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const file = path.join(appData, 'routersync', 'autopilot.yaml');
  if (!fs.existsSync(file)) return new Map();
  try {
    const { parse } = require('yaml');
    const parsed = parse(fs.readFileSync(file, 'utf8')) as { pins?: Record<string, string[]> } | undefined;
    const map = new Map<string, string[]>();
    if (parsed?.pins) {
      for (const [k, v] of Object.entries(parsed.pins)) {
        map.set(k, Array.isArray(v) ? v : []);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function lastAppliedFingerprint(): { hash: string | null; source: string } {
  const appData = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  const file = path.join(appData, 'routersync', 'state', 'last-applied.json');
  if (!fs.existsSync(file)) return { hash: null, source: 'DRIFT-UNKNOWN' };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hash?: string };
    return { hash: parsed.hash ?? null, source: parsed.hash ? 'last-applied.json' : 'DRIFT-UNKNOWN' };
  } catch {
    return { hash: null, source: 'DRIFT-UNKNOWN' };
  }
}

function comboStepsHash(router: string, comboName: string, steps: string[]): string {
  return createHash('sha256').update(`${router}|${comboName}|${JSON.stringify(steps)}`).digest('hex').slice(0, 16);
}

/** Read current combo steps from DB (read-only). */
function currentComboSteps(router: RouterName): Map<string, string[]> {
  const db = openBetterSqlite3(locateRouterDb(router), { readOnly: true, busyTimeoutMs: 5000 });
  try {
    const out = new Map<string, string[]>();
    if (router === '9router') {
      const rows = db.prepare('SELECT name, models FROM combos').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const name = String(row['name'] ?? '');
        try {
          const parsed: unknown = JSON.parse(String(row['models'] ?? '[]'));
          out.set(name, Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : []);
        } catch {
          out.set(name, []);
        }
      }
    } else {
      const rows = db.prepare('SELECT name, data FROM combos').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const name = String(row['name'] ?? '');
        try {
          const parsed = JSON.parse(String(row['data'] ?? '{}')) as { models?: unknown };
          const raw = Array.isArray(parsed.models) ? parsed.models : [];
          out.set(name, raw.map((m) => (typeof m === 'string' ? m : (m as { model?: unknown })?.model)).filter((m): m is string => typeof m === 'string'));
        } catch {
          out.set(name, []);
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

export async function runAutopilotPlanCommand(options: { json?: boolean; out?: string; keepHead?: number }): Promise<void> {
  const keepHead = options.keepHead ?? 0;
  const autonomy = loadAutonomy();
  const pins = loadPins();
  const { config: rankConfig } = loadRankingConfig();
  const { config: syncConfig } = loadConfigFile();

  const changes: PlanChange[] = [];
  const blockedChanges: PlanChange[] = [];
  const targets: RouterName[] = ['9router', 'omniroute'];

  // ---- (i) Drop dead models: scan twice 60s apart (R1-R6) ----
  const views = await buildViews(syncConfig, 'all');
  const incomplete = new Set<string>();
  const round1 = await scanAll(views, 1, 15000, true, incomplete);
  await new Promise((r) => setTimeout(r, 60000));
  const round2 = await scanAll(views, 2, 15000, true, incomplete);

  // Build usable provider key sets: normalize live IDs to comparison keys.
  // Also compute step-match ratio for R2 protection.
  // R2 denominator: step instances of this prefix across combos (counted once).
  // R2 numerator: instances present in FINAL round (r2) live list only.
  // Union r1+r2 is used ONLY for removal decisions (usableKeys).
  const usableKeys = new Map<string, Set<string>>();
  const providerMatchRatio = new Map<string, { matched: number; steps: number }>();

  for (const view of views) {
    // Count steps per prefix for this router's combos.
    const stepsByPrefix = new Map<string, string[]>();
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      for (const raw of combo.steps) {
        const parsed = parseComboStep(raw);
        if (parsed.prefix === '') continue;
        const arr = stepsByPrefix.get(parsed.prefix) ?? [];
        arr.push(parsed.key);
        stepsByPrefix.set(parsed.prefix, arr);
      }
    }

    for (const target of view.targets) {
      if (target.skipReason) continue;
      const key = `${view.name}:${target.prefix}`;
      if (incomplete.has(key)) { console.log(`provider-skipped reason=incomplete key=${key}`); continue; }
      const r1 = round1.get(key) ?? [];
      const r2 = round2.get(key) ?? [];
      if (r1.length === 0 || r2.length === 0) continue;

      const keysUnion = new Set<string>();
      for (const m of [...r1, ...r2]) keysUnion.add(parseComboStep(`${target.prefix}/${m}`).key);
      usableKeys.set(key, keysUnion);
      const keysR2 = new Set<string>();
      for (const m of r2) keysR2.add(parseComboStep(`${target.prefix}/${m}`).key);

      const stepKeys = stepsByPrefix.get(target.prefix) ?? [];
      const { matched, steps } = computeProviderMatch(stepKeys, keysR2);
      providerMatchRatio.set(key, { matched, steps });
    }
  }

  // Apply R2: skip providers with <50% match.
  const skippedProviders = new Set<string>();
  for (const [key, ratio] of providerMatchRatio.entries()) {
    const pct = ratio.steps > 0 ? ratio.matched / ratio.steps : 0;
    if (pct < 0.5) {
      skippedProviders.add(key);
      console.log(`provider-skipped reason=low-match key=${key} matched=${ratio.matched}/${ratio.steps} (${(pct * 100).toFixed(1)}%)`);
    }
  }

  // (i-b) confirmAbsent per provider: chỉ DROP-DEAD khi CONFIRMED-ABSENT
  const confirmedAbsent = new Map<string, Map<string, import('../sync/confirm.js').ConfirmVerdict>>();
  for (const view of views) {
    // gom id nghi vang theo provider
    const suspectByProvider = new Map<string, Set<string>>();
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      for (const raw of combo.steps) {
        const parsed = parseComboStep(raw);
        if (!parsed.prefix) continue;
        const key = `${view.name}:${parsed.prefix}`;
        if (skippedProviders.has(key)) continue;
        const keys = usableKeys.get(key);
        if (!keys || keys.has(parsed.key)) continue;
        const s = suspectByProvider.get(key) ?? new Set<string>();
        s.add(raw.startsWith(`${parsed.prefix}/`) ? raw.slice(parsed.prefix.length + 1) : parsed.model || raw);
        suspectByProvider.set(key, s);
      }
    }
    for (const [key, idSet] of suspectByProvider) {
      const target = view.targets.find((t) => `${view.name}:${t.prefix}` === key);
      if (!target) continue;
      const live = (round2.get(key) ?? round1.get(key) ?? []).slice(0, 1);
      const control = live[0] ?? 'control';
      const verdicts = new Map<string, import('../sync/confirm.js').ConfirmVerdict>();
      try {
        const res = await confirmAbsent(target, [...idSet].slice(0, 30), control, { timeoutMs: 15000 });
        for (const r of res.results) verdicts.set(`${key}|${r.id}`, r.verdict);
        if (!res.supported) {
          for (const id of idSet) verdicts.set(`${key}|${id}`, 'UNSUPPORTED');
        }
      } catch {
        for (const id of idSet) verdicts.set(`${key}|${id}`, 'UNKNOWN');
      }
      confirmedAbsent.set(key, verdicts);
    }
  }

  // Đếm DROP-HOLD + tier=? để ghi vào plan
  let dropHoldTotal = 0;
  for (const view of views) {
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      for (const raw of combo.steps) {
        const parsed = parseComboStep(raw);
        if (parsed.prefix === '') continue;
        const key = `${view.name}:${parsed.prefix}`;
        if (skippedProviders.has(key)) continue;
        const keys = usableKeys.get(key);
        if (!keys || keys.has(parsed.key)) continue;
        dropHoldTotal++;
      }
    }
  }
  let tierUnknownTotal = 0;
  for (const view of views) {
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      for (const s of combo.steps) {
        const m = s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
        if (assignTier(m, rankConfig.tierRules ?? {}) === 99) tierUnknownTotal++;
      }
    }
  }

  for (const view of views) {
    for (const combo of view.combos) {
      if (combo.excluded) continue;
      // chỉ giữ removal đã xác nhận
      const allRemovals: string[] = [];
      const removalProviders = new Set<string>();
      for (const raw of combo.steps) {
        const parsed = parseComboStep(raw);
        if (parsed.prefix === '') continue;
        const key = `${view.name}:${parsed.prefix}`;
        if (skippedProviders.has(key)) continue;
        const keys = usableKeys.get(key);
        if (!keys) continue;
        if (keys.has(parsed.key)) continue;
        const modelOnly = raw.startsWith(`${parsed.prefix}/`) ? raw.slice(parsed.prefix.length + 1) : parsed.model || raw;
        const verdict = confirmedAbsent.get(key)?.get(`${key}|${modelOnly}`) ?? 'UNKNOWN';
        const decision = dropDecision(verdict as any, 'UNKNOWN');
        if (decision === 'DROP-DEAD') {
          allRemovals.push(raw);
          removalProviders.add(key);
        } else {
          console.log(`DROP-HOLD ${view.name}/${combo.name} ${raw} verdict=${verdict} (${STR.dropHold})`);
        }
      }
      const removals = allRemovals;
      void removalProviders;
      if (removals.length > 0) {
        const removalPct = removals.length / combo.steps.length;
        const isBlocked = isRemovalBlocked(removals.length, combo.steps.length);
        const after = combo.steps.length - removals.length;
        const risk = after < 2 ? 'HIGH' : removalPct > 0.25 ? 'HIGH' : 'LOW';
        const change: PlanChange = {
          type: 'DROP-DEAD',
          router: view.name,
          combo: combo.name,
          reason: `${STR.positionReasonDrop}: ${removals.length} bước (${(removalPct * 100).toFixed(1)}%)`,
          evidence: `scan1=${round1.size} scan2=${round2.size} scan1_provider=${round1.get([...removalProviders][0] ?? '')?.length ?? 0} removable=${removals.length} (đã ${STR.confirmAbsentDone} qua confirmAbsent)`,
          risk,
          blocked: isBlocked,
        };
        if (isBlocked) {
          blockedChanges.push(change);
          console.log(`BLOCKED-SUSPICIOUS ${view.name}/${combo.name} removals=${removals.length}/${combo.steps.length} (${(removalPct * 100).toFixed(1)}% > ${(REMOVAL_BLOCK_RATIO * 100).toFixed(0)}%)`);
        } else {
          changes.push(change);
          for (const rp of removalProviders) {
            console.log(`DROP-DEAD ${view.name}/${combo.name} provider=${rp} removals=${removals.length}`);
          }
        }
      }
    }
  }

  // ---- (ii) Add FREE-BY-SUFFIX / FREE-BY-PRICE candidates from discover ----
  const catalogMeta = load9RouterCatalogMetadata();
  const addLimitPerCombo = 5;

  // Second source for price confirmation: OmniRoute tier_assignments
  const omniDbPath = locateRouterDb('omniroute');
  const omniDb = openBetterSqlite3(omniDbPath, { readOnly: true, busyTimeoutMs: 5000 });
  const tierAssignments = loadOmniRouteTierAssignments(omniDb);
  omniDb.close();
  for (const view of views) {
    for (const target of view.targets) {
      if (target.skipReason) continue;
      const key = `${view.name}:${target.prefix}`;
      if (skippedProviders.has(key)) continue;
      try {
        const result = await fetchModelEntries(target, { timeoutMs: 15000 });
        if (!result.ok) continue;
        for (const combo of view.combos) {
          if (combo.excluded) continue;
          // Provider must already have a step in this combo.
          const hasProviderStep = combo.steps.some((s) => {
            const p = parseComboStep(s);
            return p.prefix === target.prefix;
          });
          if (!hasProviderStep) continue;

          let addedForThisCombo = 0;
          for (const entry of result.entries) {
            if (addedForThisCombo >= addLimitPerCombo) break;
            if (isFreeSuffix(entry.id)) continue;
            const tier = tierAssignments.get(entry.id);
            const secondSource = Boolean(tier && tier.hasFreeTier && tier.costIn === 0 && tier.costOut === 0);
            const classification = classifyPrice(entry.id, entry, catalogMeta[entry.id], secondSource);
            if (classification.label !== 'FREE-BY-PRICE') continue;
            // Full step id: provider/model
            const fullId = `${target.prefix}/${entry.id}`;
            if (combo.steps.includes(fullId)) continue;

            // Respect pins: don't add if a pin exists for this combo head.
            const pinKey = `${view.name}/${combo.name}`;
            const pinList = pins.get(pinKey);
            if (pinList && pinList.length > 0) continue;

            changes.push({
              type: 'ADD-FREE',
              router: view.name,
              combo: combo.name,
              position: combo.steps.length,
              modelId: fullId,
              reason: `them model miien phi an (${classification.label}) vao duoi cung theo tier`,
              evidence: `nguon_gia=${classification.sources.map((s: { field: string }) => s.field).join('; ')}`,
              risk: 'LOW',
              blocked: false,
            });
            addedForThisCombo++;
          }
        }
      } catch {
        // Provider not reachable for discovery - skip add for this provider
      }
    }
  }

  // ---- (iii) Reorder per ranking.yaml ----
  const currentSteps = new Map<RouterName, Map<string, string[]>>();
  for (const router of targets) {
    currentSteps.set(router, currentComboSteps(router));
  }

  const driftInfo = lastAppliedFingerprint();
  console.log(`Drift source: ${driftInfo.source} (hash=${driftInfo.hash ?? '-'})`);

  for (const router of targets) {
    const stepsMap = currentSteps.get(router)!;
    for (const [comboName, models] of stepsMap.entries()) {
      if (isComboExcluded(comboName, rankConfig.excludeCombos)) continue;

      // keepHead: N bước đầu do chủ ghim, không di chuyển.
      const { head: khHead, orderable: khOrderable } = applyKeepHead(models, keepHead);
      let orderable = khOrderable;
      // Pins: remove pinned steps from reordering candidates (keep at head).
      const pinKey = `${router}/${comboName}`;
      const pinList = pins.get(pinKey);
      if (pinList && pinList.length > 0) {
        const pinnedSet = new Set(pinList);
        orderable = khOrderable.filter((m) => !pinnedSet.has(m));
      }

      const result = rankComboModels(comboName, router, orderable, rankConfig);
      if (result.positionChangesCount > 0) {
        // Compute drift vs last applied.
        const curHash = comboStepsHash(router, comboName, models);
        const drift = driftInfo.hash ? (curHash !== driftInfo.hash ? 'DRIFTED' : 'SAME') : 'DRIFT-UNKNOWN';
        const changePct = result.originalCount > 0 ? result.positionChangesCount / result.originalCount : 0;
        const tierUnknownInCombo = models.filter((s) => assignTier(s.includes('/') ? s.slice(s.indexOf('/') + 1) : s, rankConfig.tierRules ?? {}) === 99).length;
        const tierUnknownPct = models.length > 0 ? tierUnknownInCombo / models.length : 0;
        const needsOwner = reorderNeedsOwner(changePct, tierUnknownPct);
        const reorderRisk: 'LOW' | 'HIGH' = needsOwner ? 'HIGH' : 'LOW';
        const ownerNote = needsOwner ? ' needs-owner' : '';
        changes.push({
          type: 'REORDER',
          router,
          combo: comboName,
          reason: `xếp lại theo ranking.yaml (${result.positionChangesCount} bước đổi vị trí; keepHead=${keepHead}; tỉ lệ đổi=${(changePct * 100).toFixed(1)}%; bước thô=${models.length} bước có thể xếp lại=${result.originalCount})`,
          evidence: `bước thô=${models.length} bước có thể xếp lại=${result.originalCount} (trừ keepHead/pin) đổi=${result.positionChangesCount} tierUnknown=${tierUnknownInCombo}/${models.length} (${(tierUnknownPct*100).toFixed(1)}%) drift=${drift}${ownerNote}`,
          risk: reorderRisk,
          blocked: false,
        });
      }

      // Show head steps vs ranking for pin decision. Với keepHead>0, vị trí 1..keepHead không được đổi nên HEAD-DIFF chỉ xét phần sau.
      const rankedTail = result.rankedModels.slice(0, 10).map((m) => m.id);
      const currentTail = orderable.slice(0, 10);
      const headDiffers = JSON.stringify(currentTail) !== JSON.stringify(rankedTail);
      if (headDiffers) {
        console.log(`HEAD-DIFF ${router}/${comboName} current=${currentTail.slice(0, 5).join(', ')}... ranked=${rankedTail.slice(0, 5).join(', ')}... keepHead=${khHead.length}`);
      }
    }
  }

  // ---- planHash ----
  const planHash = stableHash({ autonomy: autonomy.mode, changes, blockedChanges, rankConfigVersion: rankConfig.version });

  // ---- Output ----
  const now = new Date().toISOString();
  const txtLines: string[] = [];
  txtLines.push('ROUTERSYNC AUTOPILOT PLAN (propose-only, không ghi)');
  txtLines.push('Generated: ' + now);
  txtLines.push(`Autonomy: ${autonomy.mode} | planHash: ${planHash}`);
  txtLines.push(`Drift source: ${driftInfo.source}`);
  txtLines.push(`Removal block threshold: >${(REMOVAL_BLOCK_RATIO * 100).toFixed(0)}% of combo steps`);
  txtLines.push(`${STR.totalChanges}: ${changes.length} | bị chặn: ${blockedChanges.length} | DROP-HOLD: ${dropHoldTotal} | tier=?: ${tierUnknownTotal}`);
  txtLines.push('='.repeat(80));

  for (const c of changes) {
    txtLines.push(`\n[${c.type}] ${c.router}/${c.combo}${c.blocked ? ' (BLOCKED)' : ''}`);
    txtLines.push(`  ${STR.position}: ${c.position ?? '-'} | Model: ${c.modelId ?? '-'}`);
    txtLines.push(`  ${STR.reason}: ${c.reason}`);
    txtLines.push(`  ${STR.evidence}: ${c.evidence}`);
    txtLines.push(`  ${STR.risk}: ${c.risk}`);
  }

  for (const c of blockedChanges) {
    txtLines.push(`\n[${c.type}] ${c.router}/${c.combo} (BLOCKED-SUSPICIOUS)`);
    txtLines.push(`  ${STR.reason}: ${c.reason}`);
    txtLines.push(`  ${STR.evidence}: ${c.evidence}`);
    txtLines.push(`  ${STR.risk}: ${c.risk}`);
  }

  txtLines.push('\n');
  txtLines.push(`${STR.comboHead}:`);
  for (const router of targets) {
    const stepsMap = currentSteps.get(router)!;
    for (const [comboName, models] of [...stepsMap.entries()].sort()) {
      const pinKey = `${router}/${comboName}`;
      const pinList = pins.get(pinKey);
      txtLines.push(`  ${router}/${comboName}: ${models.slice(0, 8).join(', ')}${pins.has(pinKey) ? ' [co pin]' : ''}`);
    }
  }

  const txtPath = planFile('autopilot-plan.txt');
  const jsonPath = planFile('autopilot-plan.json');
  fs.writeFileSync(txtPath, txtLines.join('\n') + '\n', 'utf8');

  const jsonOut = {
    planHash,
    generatedAt: now,
    autonomy: autonomy.mode,
    driftSource: driftInfo.source,
    removalBlockThreshold: REMOVAL_BLOCK_RATIO,
    changes,
    blockedChanges,
    routerTargets: targets,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(jsonOut, null, 2)}\n`, 'utf8');

  console.log(txtLines.join('\n'));
  console.log(`\nDa ghi ke hoach: ${txtPath}`);

  if (options.json) {
    console.log(JSON.stringify(jsonOut, null, 2));
  }
  if (options.out) {
    fs.writeFileSync(options.out, `${JSON.stringify(jsonOut, null, 2)}\n`, 'utf8');
    console.log(`Da ghi them: ${options.out}`);
  }
}
