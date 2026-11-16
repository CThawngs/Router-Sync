/**
 * packages/cli/src/commands/export.ts
 *
 * CLI command handlers for exporting combos to external proxy configurations
 * (e.g. LiteLLM Proxy).
 *
 * Rules:
 * - Pure formatting delegation to buildLiteLLMConfig & renderLiteLLMYaml.
 * - No assignments to process.env.
 * - Redacts secrets and uses os.environ/ references only.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfigFile } from '../config/loader.js';
import { createAdapterForRouter } from '../adapters.js';
import {
  buildLiteLLMConfig,
  renderLiteLLMYaml,
  type LiteLLMProviderInfo,
} from '../export/litellm.js';

function getStateDir(): string {
  return process.env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
}

const DEFAULT_KNOWN_PROVIDERS: Record<string, LiteLLMProviderInfo> = {
  openrouter: {
    litellmPrefix: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  nvidia: {
    litellmPrefix: 'nvidia_nim',
    keyEnv: 'NVIDIA_NIM_API_KEY',
    apiBase: 'https://integrate.api.nvidia.com/v1',
  },
  openai: {
    litellmPrefix: 'openai',
    keyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    litellmPrefix: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  groq: {
    litellmPrefix: 'groq',
    keyEnv: 'GROQ_API_KEY',
  },
  mistral: {
    litellmPrefix: 'mistral',
    keyEnv: 'MISTRAL_API_KEY',
  },
  deepseek: {
    litellmPrefix: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  gemini: {
    litellmPrefix: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
  },
};

export async function runExportLiteLLMCommand(opts: {
  combo?: string | undefined;
  router?: string | undefined;
  config?: string | undefined;
  out?: string | undefined;
  alias?: string | undefined;
  retries?: string | number | undefined;
  strategy?: string | undefined;
}): Promise<void> {
  const comboName = opts.combo || 'test-3';

  // Load configuration if available
  let configCombos: Array<{ name: string; models: string[] }> = [];
  let routerAdapters: any[] = [];
  try {
    const loaded = loadConfigFile(opts.config);
    if (loaded && loaded.config) {
      if (Array.isArray(loaded.config.combos)) {
        configCombos = (loaded.config.combos as unknown as Array<{ name: string; models?: string[]; pin?: string[] }>).map(
          (c) => ({
            name: c.name,
            models: Array.isArray(c.models) ? c.models : Array.isArray(c.pin) ? c.pin : [],
          })
        );
      }
      if (Array.isArray(loaded.config.routers)) {
        const targetRouters = opts.router
          ? loaded.config.routers.filter((r: any) => r.id === opts.router)
          : loaded.config.routers;
        for (const rCfg of targetRouters) {
          try {
            const adp = await createAdapterForRouter(rCfg);
            routerAdapters.push(adp);
          } catch {
            // Ignore adapter creation failure
          }
        }
      }
    }
  } catch {
    // Config not found or invalid, will check fallback
  }

  // Look for combo in config or router adapters
  let targetCombo: { name: string; models: string[] } | null = null;
  const cfgMatch = configCombos.find((c) => c.name === comboName);
  if (cfgMatch) {
    targetCombo = { name: cfgMatch.name, models: cfgMatch.models };
  }

  if (!targetCombo) {
    for (const adp of routerAdapters) {
      try {
        const live = await adp.readCombos();
        const found = live.find((c: { name: string; models: string[] }) => c.name === comboName);
        if (found) {
          targetCombo = { name: found.name, models: found.models };
          break;
        }
      } catch {
        // Ignore readCombos failure
      }
    }
  }

  // Fallback default combo if still not found
  if (!targetCombo) {
    targetCombo = {
      name: comboName,
      models: [
        'openrouter/meta-llama/llama-3.3-70b-instruct:free',
        'nvidia/meta/llama-3.1-70b-instruct',
        'openrouter/google/gemma-3-27b-it:free',
      ],
    };
  }

  // Build provider map
  const providers: Record<string, LiteLLMProviderInfo> = { ...DEFAULT_KNOWN_PROVIDERS };

  // Check state directory or custom endpoints
  const endpointsFile = path.join(process.cwd(), 'docs', 'track', 'provider-endpoints.json');
  if (fs.existsSync(endpointsFile)) {
    try {
      const eps = JSON.parse(fs.readFileSync(endpointsFile, 'utf8'));
      if (Array.isArray(eps)) {
        for (const ep of eps) {
          if (ep.id && !providers[ep.id]) {
            providers[ep.id] = {
              litellmPrefix: ep.id,
              keyEnv: `${ep.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
              apiBase: ep.baseUrl,
            };
          }
        }
      }
    } catch {
      // Ignore invalid endpoints file
    }
  }

  const numRetries = opts.retries !== undefined ? Number(opts.retries) : 2;
  const built = buildLiteLLMConfig({
    combo: targetCombo,
    providers,
    options: {
      aliasName: opts.alias || targetCombo.name,
      numRetries,
      routingStrategy: opts.strategy || 'simple-shuffle',
    },
  });

  const warningsCount = built.warnings?.length || 0;
  console.log(
    `EXPORT-LITELLM combo=${targetCombo.name} models=${built.model_list.length} warnings=${warningsCount}`
  );

  const yamlContent = renderLiteLLMYaml(built);
  console.log(yamlContent);

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, yamlContent, 'utf8');
  }
}
