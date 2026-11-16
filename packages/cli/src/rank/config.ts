/**
 * packages/cli/src/rank/config.ts
 *
 * Loader and schema validator for ranking configuration (ranking.yaml).
 * Adheres to Round 59 specifications:
 * - No weights in criteria
 * - Grounded scores requiring sources & checked_at
 * - Zero-payment-providers list instead of freeOnlyDefault
 * - Excluded test combos
 * - Neutral default schema (no ungrounded scores or personal policy tiers)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { RankingConfig } from './types.js';
import { DEFAULT_NON_CHAT_PATTERNS, DEFAULT_ZERO_PAYMENT_PROVIDERS } from './filters.js';

export const rankingCriterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int().min(1),
});

export const modelScoreEntrySchema = z.object({
  idPattern: z.string(),
  scores: z.record(z.string(), z.number()),
  sources: z.array(z.string().url()).min(1),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  stability: z.union([z.number(), z.literal('UNKNOWN')]).optional(),
  contextWindow: z.union([z.number(), z.literal('UNKNOWN')]).optional(),
  reason: z.string().optional(),
});

export const rankingConfigSchema = z.preprocess(
  (val: unknown) => {
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if ('demote-providers' in obj && !('demoteProviders' in obj)) {
        return { ...obj, demoteProviders: obj['demote-providers'] };
      }
    }
    return val;
  },
  z.object({
    version: z.literal(1).default(1),
    blacklist: z.array(z.string()).default([
      'space-bunny',
      'union-alpha',
      'minimax-m3.1',
      'deepseek-v4-pro',
    ]),
    operatorDisabled: z.array(z.string()).default([]),
    providerInactive: z.array(z.string()).default([]),
    nonChatPatterns: z.array(z.string()).default([...DEFAULT_NON_CHAT_PATTERNS]),
    zeroPaymentProviders: z.array(z.string()).default([...DEFAULT_ZERO_PAYMENT_PROVIDERS]),
    demoteProviders: z.array(z.string()).default([]),
    excludeCombos: z.array(z.string()).default(['test-1', 'test-2', 'test-3']),
    criteria: z.array(rankingCriterionSchema).default([
      { id: 'tierHierarchy', name: 'Phân cấp thứ bậc mô hình', priority: 1 },
      { id: 'contextWindow', name: 'Độ lớn ngữ cảnh (Context Window)', priority: 2 },
    ]),
    tierRules: z.record(z.string(), z.array(z.string())).default({}),
    modelScores: z.array(modelScoreEntrySchema).default([]),
    interleaving: z.object({
      enabled: z.boolean().default(true),
      applyToTiers: z.array(z.number().int()).default([99]),
      preserveUnratedOrder: z.boolean().default(true),
    }).default({
      enabled: true,
      applyToTiers: [99],
      preserveUnratedOrder: true,
    }),
  })
);

/** True when the default policy path is Windows-style (Roaming AppData). */
export function isWindowsPolicyPlatform(): boolean {
  return process.platform === 'win32';
}

/**
 * Resolve the user policy file path.
 *
 * Windows: %APPDATA%\routersync\ranking.yaml
 * POSIX  : $XDG_CONFIG_HOME/routersync/ranking.yaml, else ~/.config/routersync/ranking.yaml
 */
export function getDefaultRankingConfigPath(): string {
  const home = os.homedir();
  if (isWindowsPolicyPlatform()) {
    const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'routersync', 'ranking.yaml');
  }
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'] || path.join(home, '.config');
  return path.join(xdgConfigHome, 'routersync', 'ranking.yaml');
}

/** Path of the shipped template users copy from. */
export function getRankingExamplePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '..', 'ranking.example.yaml');
}

/** Human-readable guidance printed when the policy file is missing. */
export function buildMissingPolicyGuidance(targetPath: string): string {
  const posixPath = path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'routersync', 'ranking.yaml');
  const example = getRankingExamplePath();
  return (
    `[routersync] No ranking policy file at ${targetPath}\n` +
    `  Template: ${example}\n` +
    `  Copy it to the location for your platform:\n` +
    `    Windows: copy "${example}" "%APPDATA%\\routersync\\ranking.yaml"\n` +
    `    POSIX  : mkdir -p "$(dirname "${posixPath}")" && cp "${example}" "${posixPath}"\n` +
    `  Built-in defaults are used for read-only runs; every write path refuses while this file is missing.\n`
  );
}

export function loadRankingConfig(
  customPath?: string,
  options: { quiet?: boolean } = {}
): { config: RankingConfig; sourcePath: string; isDefault: boolean } {
  const targetPath = customPath ? path.resolve(customPath) : getDefaultRankingConfigPath();

  if (!fs.existsSync(targetPath)) {
    // Never fall through to defaults silently: the guidance is always printed and
    // every caller that writes (rank --apply, apply, autopilot) refuses on isDefault.
    // A read-only caller can pass { quiet: true } to suppress the banner.
    if (!options.quiet) {
      process.stderr.write(buildMissingPolicyGuidance(targetPath));
    }
    const defaultConfig = rankingConfigSchema.parse({});
    return { config: defaultConfig, sourcePath: targetPath, isDefault: true };
  }

  const rawContent = fs.readFileSync(targetPath, 'utf8');
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawContent);
  } catch (err) {
    throw new Error(
      `Failed to parse ranking.yaml at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsedYaml !== null && parsedYaml !== undefined && (typeof parsedYaml !== 'object' || Array.isArray(parsedYaml))) {
    throw new Error(`Invalid ranking.yaml root at ${targetPath}: expected YAML mapping object.`);
  }
  const validated = rankingConfigSchema.parse(parsedYaml ?? {});
  return { config: validated, sourcePath: targetPath, isDefault: false };
}

export function writeRankingConfigFile(targetPath: string, config: RankingConfig): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const yamlStr = stringifyYaml(config);
  fs.writeFileSync(targetPath, yamlStr, 'utf8');
}
