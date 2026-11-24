/**
 * packages/cli/src/commands/litellm.ts
 *
 * CLI handler for `routersync litellm <inspect|plan|apply|rollback>` (Phục vụ: S4).
 */

import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  applyLiteLLMConfigSync,
  inspectLiteLLMConfig,
  planLiteLLMConfigSync,
  rollbackLiteLLMConfig,
} from '../litellm/index.js';

export interface LiteLLMCommandOptions {
  subcommand: 'inspect' | 'plan' | 'apply' | 'rollback';
  config: string;
  profile?: string | undefined;
  combo?: string | undefined;
  models?: string | undefined;
  strategy?: 'fallbacks' | 'simple-shuffle' | 'least-busy' | undefined;
  expectedPlanHash?: string | undefined;
  backup?: string | undefined;
  json?: boolean | undefined;
}

function resolveRequestedModels(options: LiteLLMCommandOptions): string[] {
  if (options.models && options.models.trim() !== '') {
    return options.models
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (options.profile && fs.existsSync(options.profile)) {
    const parsed = parseYaml(fs.readFileSync(options.profile, 'utf8')) as Record<string, unknown> | null;
    if (parsed && Array.isArray(parsed['favorites']) && parsed['favorites'].length >= 2) {
      return parsed['favorites'].map(String);
    }
  }
  return [];
}

export function runLiteLLMCommand(options: LiteLLMCommandOptions): void {
  const sub = options.subcommand;

  if (sub === 'inspect') {
    const res = inspectLiteLLMConfig(options.config);
    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`[LiteLLM Inspect] ${res.configPath}`);
    console.log(`  Deployments:      ${res.deployments.length}`);
    console.log(`  Credential Pools: ${res.credentialPools.length}`);
    console.log(`  Routing Strategy: ${res.routerSettings.routingStrategy ?? '(unspecified)'}`);
    return;
  }

  if (sub === 'rollback') {
    const res = rollbackLiteLLMConfig(options.config, options.backup);
    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`[OK] Restored ${res.configPath} byte-for-byte from ${res.backupPath}`);
    return;
  }

  const comboAlias = options.combo?.trim() || 'routersync-default';
  const steps = resolveRequestedModels(options);

  if (sub === 'plan') {
    const plan = planLiteLLMConfigSync({
      configPath: options.config,
      comboAlias,
      steps,
      routingStrategy: options.strategy,
    });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            configPath: plan.configPath,
            comboAlias: plan.comboAlias,
            changed: plan.changed,
            diffHunks: plan.diffHunks,
            planHash: plan.planHash,
            managedDeployments: plan.managedDeployments,
            fallbackTargets: plan.fallbackTargets,
            effectiveRoutingStrategy: plan.effectiveRoutingStrategy,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(
      `[LiteLLM Plan] combo=${plan.comboAlias} changed=${plan.changed} hunks=${plan.diffHunks} planHash=${plan.planHash}`
    );
    return;
  }

  if (sub === 'apply') {
    const res = applyLiteLLMConfigSync({
      configPath: options.config,
      comboAlias,
      steps,
      routingStrategy: options.strategy,
      expectedPlanHash: options.expectedPlanHash,
      backupPath: options.backup,
    });
    if (options.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (res.applied) {
      console.log(`[OK] Synced LiteLLM combo "${comboAlias}" in ${res.configPath} (backup: ${res.backupPath})`);
    } else {
      console.error(`[ROLLBACK] Read-back failed (${res.error}); restored ${res.configPath}`);
      process.exitCode = 1;
    }
  }
}
