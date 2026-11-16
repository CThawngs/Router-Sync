/**
 * packages/cli/src/profile/manager.ts
 *
 * Profile loader, persistence, and router strategy resolution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { UserProfile, ComboProfileRule } from './types.js';
import { userProfileSchema, createDefaultProfile } from './schema.js';

export function getDefaultProfilePath(): string {
  const appData =
    process.env['APPDATA'] ||
    path.join(process.env['USERPROFILE'] || '', 'AppData', 'Roaming');
  return path.join(appData, 'routersync', 'profile.yaml');
}

export function loadProfile(customPath?: string): {
  profile: UserProfile;
  sourcePath: string;
  isNew: boolean;
} {
  const targetPath = customPath ? path.resolve(customPath) : getDefaultProfilePath();

  if (!fs.existsSync(targetPath)) {
    const defaultProf = createDefaultProfile();
    return { profile: defaultProf, sourcePath: targetPath, isNew: true };
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const parsed = parseYaml(raw);
    const validated = userProfileSchema.parse(parsed ?? {});
    return { profile: validated, sourcePath: targetPath, isNew: false };
  } catch {
    const fallback = createDefaultProfile();
    return { profile: fallback, sourcePath: targetPath, isNew: true };
  }
}

export function writeProfile(profile: UserProfile, customPath?: string): string {
  const targetPath = customPath ? path.resolve(customPath) : getDefaultProfilePath();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  profile.updatedAt = new Date().toISOString();
  const yamlContent = stringifyYaml(profile);
  fs.writeFileSync(targetPath, yamlContent, 'utf8');
  return targetPath;
}

export function resolveComboRule(profile: UserProfile, comboName: string): ComboProfileRule {
  const lowerName = comboName.toLowerCase();
  for (const rule of profile.combos) {
    if (rule.targetCombo.toLowerCase() === lowerName) {
      return rule;
    }
  }
  // Try pattern or "all"
  for (const rule of profile.combos) {
    if (rule.targetCombo.toLowerCase() === 'all' || lowerName.includes(rule.targetCombo.toLowerCase())) {
      return rule;
    }
  }
  return {
    targetCombo: comboName,
    strategy: 'fallback',
    minSteps: 2,
    enableInterleaving: true,
    freeOnly: true,
  };
}

export function resolveRouterNativeStrategy(
  profile: UserProfile,
  comboName: string,
  router: '9router' | 'omniroute'
): string {
  const rule = resolveComboRule(profile, comboName);
  const mapping = profile.strategyMapping[rule.strategy];

  if (router === '9router') {
    return mapping?.nineRouter ?? 'fallback';
  }
  // OmniRoute Policy §12 matrix routing
  return mapping?.omniRoute ?? 'priority';
}

export function formatProfileSummary(profile: UserProfile, sourcePath: string): string {
  const lines: string[] = [];
  lines.push('='.repeat(78));
  lines.push(`ROUTERSYNC USER PROFILE: ${profile.name}`);
  lines.push('='.repeat(78));
  lines.push(`File: ${sourcePath}`);
  lines.push(`Updated: ${profile.updatedAt}`);
  lines.push('-'.repeat(78));

  lines.push('[P1-P3] GENERAL PREFERENCES:');
  lines.push(`  P1 Workload:           ${profile.general.workload}`);
  lines.push(`  P2 Cost Preference:    ${profile.general.costPreference}`);
  lines.push(`  P3 Preferred Providers: ${profile.general.preferredProviders.join(', ') || '(none)'}`);
  lines.push(`  P3 Excluded Providers:  ${profile.general.excludedProviders.join(', ') || '(none)'}`);
  lines.push('');

  lines.push('[C1-C5] COMBO RULES:');
  for (const c of profile.combos) {
    lines.push(`  - Target: ${c.targetCombo}`);
    lines.push(`    Strategy:     ${c.strategy}`);
    lines.push(`    Min Steps:    ${c.minSteps} (Invariant I3 >= 2)`);
    lines.push(`    Interleave:   ${c.enableInterleaving ? 'Yes' : 'No'}`);
    lines.push(`    Free-Only:    ${c.freeOnly ? 'Yes' : 'No'}`);
  }
  lines.push('');

  lines.push('[ROUTER STRATEGY MAPPINGS (Policy §12 Matrix / 9Router Sequential)]:');
  for (const [strategyKey, mapping] of Object.entries(profile.strategyMapping)) {
    lines.push(`  - ${strategyKey}:`);
    lines.push(`      9Router:   ${mapping.nineRouter} (Sequential)`);
    lines.push(`      OmniRoute: ${mapping.omniRoute} (Policy §12 Matrix Routing)`);
  }
  lines.push('='.repeat(78));

  return lines.join('\n');
}
