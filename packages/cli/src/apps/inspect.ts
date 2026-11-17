/**
 * packages/cli/src/apps/inspect.ts
 *
 * Read-only inspection adapters for agent apps that keep their own provider and
 * model lists: Hermes Agent, DSH Desktop, OpenCode.
 *
 * Guarantees:
 *   - Never writes a file. There is no `write`/`apply` code path in this module.
 *   - Never returns key or base-URL values, only `keyPresent` / `baseUrlPresent`.
 *   - Rejects a config larger than `maxBytes` instead of parsing it (TOO_LARGE).
 *   - Reports `UNKNOWN` (certainty C) when a state cannot be verified.
 *
 * Contract: packages/adapter-sdk/src/agent-app.ts, docs/adapters/agent-apps.md
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDocument } from 'yaml';
import type {
  AgentAppAdapter,
  AgentAppCertainty,
  AgentAppInspectErrorCode,
  AgentAppInspectOptions,
  AgentAppInspection,
  AgentAppModel,
  AgentAppProvider,
  AgentAppProviderKind,
  AgentAppRouterRef,
} from '@routersync/adapter-sdk';

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export const AGENT_APP_IDS = ['hermes', 'dsh', 'opencode'] as const;
export type AgentAppId = (typeof AGENT_APP_IDS)[number];

export class AgentAppInspectError extends Error {
  constructor(
    readonly code: AgentAppInspectErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AgentAppInspectError';
  }
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Rec;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Reads a config file with a hard size cap. Only the size crosses the boundary. */
function readText(file: string, maxBytes: number): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new AgentAppInspectError('ENOENT', 'không tìm thấy tệp cấu hình');
  }
  if (!stat.isFile()) {
    throw new AgentAppInspectError('ENOENT', 'đường dẫn cấu hình không phải tệp');
  }
  if (stat.size > maxBytes) {
    throw new AgentAppInspectError('TOO_LARGE', `tệp ${stat.size} B vượt giới hạn ${maxBytes} B`);
  }
  return fs.readFileSync(file, 'utf8');
}

function parseJsonObject(text: string): Rec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentAppInspectError('PARSE', 'JSON không hợp lệ');
  }
  const rec = asRecord(parsed);
  if (!rec) throw new AgentAppInspectError('PARSE', 'JSON gốc không phải object');
  return rec;
}

function parseYamlDoc(text: string): unknown {
  // logLevel silent: DSH uses custom tags (!!js) that only emit warnings.
  // Real syntax problems are collected in doc.errors (parse() alone is lenient).
  const doc = parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length > 0) {
    throw new AgentAppInspectError('PARSE', 'YAML không hợp lệ');
  }
  try {
    return doc.toJS();
  } catch {
    throw new AgentAppInspectError('PARSE', 'YAML không hợp lệ');
  }
}

function detectRouter(value: string | undefined): AgentAppRouterRef {
  if (!value) return 'UNKNOWN';
  const lower = value.toLowerCase();
  if (lower.includes('9router') || lower.includes('9-router')) return '9router';
  if (lower.includes('omniroute')) return 'omniroute';
  return 'UNKNOWN';
}

function providerKind(id: string, baseUrl: string | undefined): AgentAppProviderKind {
  if (detectRouter(id) !== 'UNKNOWN' || detectRouter(baseUrl) !== 'UNKNOWN') return 'router';
  if (baseUrl) return 'direct';
  return 'unknown';
}

function firstRouterRef(providers: AgentAppProvider[], extra: Array<string | undefined>): AgentAppRouterRef {
  for (const value of [...providers.map((p) => p.id), ...extra]) {
    const ref = detectRouter(value);
    if (ref !== 'UNKNOWN') return ref;
  }
  return 'UNKNOWN';
}

function certaintyOf(models: AgentAppModel[], activeModel: string): AgentAppCertainty {
  if (models.length === 0) return 'C';
  return activeModel === 'UNKNOWN' ? 'B' : 'A';
}

function baseInspection(app: string, configPath: string): Pick<AgentAppInspection, 'app' | 'configPath' | 'readOnly'> {
  return { app, configPath, readOnly: true };
}

// ---------------------------------------------------------------------------
// Hermes Agent — ~/.hermes/config.yaml
//   model.{provider,default,base_url,models[]}
//   custom_providers[]{name,base_url,api_key,models[]}
// ---------------------------------------------------------------------------

export const hermesAdapter: AgentAppAdapter = {
  app: 'hermes',
  format: 'yaml',
  defaultConfigPath(homeDir: string): string {
    return path.join(homeDir, '.hermes', 'config.yaml');
  },
  async inspect(options: AgentAppInspectOptions = {}): Promise<AgentAppInspection> {
    const homeDir = options.homeDir ?? os.homedir();
    const configPath = options.configPath ?? this.defaultConfigPath(homeDir);
    const text = readText(configPath, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const doc = asRecord(parseYamlDoc(text));
    if (!doc) throw new AgentAppInspectError('PARSE', 'YAML gốc không phải object');

    const warnings: string[] = [];
    const providers: AgentAppProvider[] = [];
    const models: AgentAppModel[] = [];

    const model = asRecord(doc['model']);
    const providerId = str(model?.['provider']);
    const baseUrl = str(model?.['base_url']);

    if (providerId) {
      providers.push({
        id: providerId,
        kind: providerKind(providerId, baseUrl),
        baseUrlPresent: Boolean(baseUrl),
        keyPresent: false,
      });
    } else {
      warnings.push('thiếu model.provider');
    }

    const addModels = (list: unknown[], provider: string): void => {
      for (const entry of list) {
        const rec = asRecord(entry);
        const id = str(rec?.['id']) ?? str(entry);
        if (!id) continue;
        models.push({ provider, id, enabled: 'UNKNOWN' });
      }
    };

    addModels(asArray(model?.['models']), providerId ?? 'UNKNOWN');

    for (const entry of asArray(doc['custom_providers'])) {
      const rec = asRecord(entry);
      const name = str(rec?.['name']);
      if (!rec || !name) continue;
      const customBaseUrl = str(rec['base_url']);
      providers.push({
        id: name,
        kind: providerKind(name, customBaseUrl),
        baseUrlPresent: Boolean(customBaseUrl),
        keyPresent: Boolean(str(rec['api_key'])),
      });
      addModels(asArray(rec['models']), name);
    }

    const activeRaw = str(model?.['default']);
    const activeModel = activeRaw ? (providerId ? `${providerId}/${activeRaw}` : activeRaw) : 'UNKNOWN';
    if (!activeRaw) warnings.push('thiếu model.default — model đang dùng = UNKNOWN');

    const routerRef = firstRouterRef(providers, [baseUrl]);
    if (routerRef !== 'UNKNOWN') warnings.push(`app trỏ tới router ${routerRef}`);

    return {
      ...baseInspection('hermes', configPath),
      format: 'yaml',
      providers,
      models,
      activeModel,
      routerRef,
      certainty: certaintyOf(models, activeModel),
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// DSH Desktop — ~/.dsh/profiles/desktop/cordis.patch.yml
//   array of {id,name,config} | array of {insert:[{id,name,config}]}
//   agent-default-model.config.{provider,model}
//   llm-pi-ai.config.providers map {baseURL, apiKeyEnv, models[]}
// ---------------------------------------------------------------------------

function dshEntries(doc: unknown): Rec[] {
  const out: Rec[] = [];
  for (const item of asArray(doc)) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (Array.isArray(rec['insert'])) {
      for (const nested of asArray(rec['insert'])) {
        const nestedRec = asRecord(nested);
        if (nestedRec) out.push(nestedRec);
      }
      continue;
    }
    out.push(rec);
  }
  return out;
}

function byEntryId(entries: Rec[]): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const entry of entries) {
    const id = str(entry['id']);
    if (id) map.set(id, entry);
  }
  return map;
}

export const dshAdapter: AgentAppAdapter = {
  app: 'dsh',
  format: 'yaml',
  defaultConfigPath(homeDir: string): string {
    return path.join(homeDir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  },
  async inspect(options: AgentAppInspectOptions = {}): Promise<AgentAppInspection> {
    const homeDir = options.homeDir ?? os.homedir();
    let configPath = options.configPath ?? this.defaultConfigPath(homeDir);
    if (!options.configPath && !fs.existsSync(configPath)) {
      // Older DSH layouts keep the patch at the profile root.
      const fallback = path.join(homeDir, '.dsh', 'cordis.patch.yml');
      if (fs.existsSync(fallback)) configPath = fallback;
    }
    const text = readText(configPath, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const entries = dshEntries(parseYamlDoc(text));
    const idMap = byEntryId(entries);

    const warnings: string[] = [];
    const providers: AgentAppProvider[] = [];
    const models: AgentAppModel[] = [];
    const seen = new Set<string>();

    const pushProvider = (provider: AgentAppProvider): void => {
      if (!providers.some((p) => p.id === provider.id)) providers.push(provider);
    };
    const pushModel = (model: AgentAppModel): void => {
      const key = `${model.provider}\u0000${model.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      models.push(model);
    };

    const defaultEntry = asRecord(idMap.get('agent-default-model')?.['config']);
    const activeProvider = str(defaultEntry?.['provider']);
    const activeId = str(defaultEntry?.['model']);
    const activeModel = activeId ? (activeProvider ? `${activeProvider}/${activeId}` : activeId) : 'UNKNOWN';
    if (activeModel === 'UNKNOWN') warnings.push('thiếu entry agent-default-model — model đang dùng = UNKNOWN');

    const piProviders = asRecord(asRecord(idMap.get('llm-pi-ai')?.['config'])?.['providers']) ?? {};
    for (const [id, raw] of Object.entries(piProviders)) {
      const rec = asRecord(raw) ?? {};
      const baseUrl = str(rec['baseURL']);
      // apiKeyEnv holds a variable NAME, apiKey would hold the value: both are boolean only.
      pushProvider({
        id,
        kind: providerKind(id, baseUrl),
        baseUrlPresent: Boolean(baseUrl),
        keyPresent: Boolean(str(rec['apiKeyEnv']) ?? str(rec['apiKey'])),
      });
      for (const entry of asArray(rec['models'])) {
        const modelRec = asRecord(entry);
        const id2 = str(modelRec?.['id']) ?? str(entry);
        if (id2) pushModel({ provider: id, id: id2, enabled: 'UNKNOWN' });
      }
    }

    const deepseekModels = asArray(asRecord(idMap.get('llm-deepseek')?.['config'])?.['models']);
    if (deepseekModels.length > 0) {
      pushProvider({ id: 'deepseek', kind: 'direct', baseUrlPresent: false, keyPresent: true });
      for (const entry of deepseekModels) {
        const modelRec = asRecord(entry);
        const id = str(modelRec?.['id']) ?? str(entry);
        if (id) pushModel({ provider: 'deepseek', id, enabled: 'UNKNOWN' });
      }
    }

    if (activeProvider) {
      pushProvider({
        id: activeProvider,
        kind: providerKind(activeProvider, undefined),
        baseUrlPresent: false,
        keyPresent: false,
      });
    }

    const routerRef = firstRouterRef(providers, [activeProvider]);
    if (routerRef !== 'UNKNOWN') warnings.push(`app trỏ tới router ${routerRef}`);

    return {
      ...baseInspection('dsh', configPath),
      format: 'yaml',
      providers,
      models,
      activeModel,
      routerRef,
      certainty: certaintyOf(models, activeModel),
      warnings,
    };
  },
};

// ---------------------------------------------------------------------------
// OpenCode — ~/.config/opencode/opencode.json
//   provider map {options:{baseURL,apiKey}, models map}
//   optional top-level model "provider/model" (absent in many configs)
// ---------------------------------------------------------------------------

export const opencodeAdapter: AgentAppAdapter = {
  app: 'opencode',
  format: 'json',
  defaultConfigPath(homeDir: string): string {
    return path.join(homeDir, '.config', 'opencode', 'opencode.json');
  },
  async inspect(options: AgentAppInspectOptions = {}): Promise<AgentAppInspection> {
    const homeDir = options.homeDir ?? os.homedir();
    const configPath = options.configPath ?? this.defaultConfigPath(homeDir);
    const text = readText(configPath, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const doc = parseJsonObject(text);

    const warnings: string[] = [];
    const providers: AgentAppProvider[] = [];
    const models: AgentAppModel[] = [];

    for (const [id, raw] of Object.entries(asRecord(doc['provider']) ?? {})) {
      const rec = asRecord(raw) ?? {};
      const entryOptions = asRecord(rec['options']) ?? {};
      const baseUrl = str(entryOptions['baseURL']);
      providers.push({
        id,
        kind: providerKind(id, baseUrl),
        baseUrlPresent: Boolean(baseUrl),
        keyPresent: Boolean(str(entryOptions['apiKey'])),
      });
      for (const modelId of Object.keys(asRecord(rec['models']) ?? {})) {
        models.push({ provider: id, id: modelId, enabled: 'UNKNOWN' });
      }
    }

    const activeRaw = str(doc['model']);
    const activeModel = activeRaw ?? 'UNKNOWN';
    if (!activeRaw) warnings.push('không có trường model cấp 1 — model đang dùng = UNKNOWN');

    const routerRef = firstRouterRef(providers, [activeRaw]);
    if (routerRef !== 'UNKNOWN') warnings.push(`app trỏ tới router ${routerRef}`);

    return {
      ...baseInspection('opencode', configPath),
      format: 'json',
      providers,
      models,
      activeModel,
      routerRef,
      certainty: certaintyOf(models, activeModel),
      warnings,
    };
  },
};

export const AGENT_APP_ADAPTERS: AgentAppAdapter[] = [hermesAdapter, dshAdapter, opencodeAdapter];

export function getAgentAppAdapter(app: string): AgentAppAdapter | undefined {
  return AGENT_APP_ADAPTERS.find((adapter) => adapter.app === app);
}
