/**
 * packages/cli/src/commands/track.ts
 *
 * Implements `routersync track once|watch|status|autostart` commands.
 * Zero-token model tracker using only GET /v1/models (Condition TRACK-01).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openBetterSqlite3, CredentialBroker } from '@routersync/core';
import { classifyFree, type OwnerConfig } from '../track/free-classify.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export interface ProviderConfig {
  id: string;
  kind?: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyDirect?: string;
  auth?: 'none' | string;
  via?: string | undefined;
}

export interface ProviderScanResult {
  id: string;
  via?: string | undefined;
  status: 'ok' | 'auth_error' | 'unreachable' | 'frozen' | 'skipped';
  reason: string | null;
  baseline: boolean;
  count: number;
  added: string[];
  removed: string[];
  pendingRemoval: string[];
}

export interface TrackOnceResult {
  run: number;
  providers: ProviderScanResult[];
}

export interface ProviderState {
  id: string;
  lastScanAt: string;
  status: 'ok' | 'auth_error' | 'unreachable' | 'frozen' | 'skipped';
  count: number;
  models: string[];
  pendingRemoval: Record<string, number>;
}

export interface TrackerState {
  run: number;
  providers: Record<string, ProviderState>;
}

function getStateDir(): string {
  const dir = process.env.ROUTERSYNC_STATE_DIR || path.join(os.homedir(), '.routersync');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getStateFilePath(): string {
  return path.join(getStateDir(), 'tracker-state.json');
}

function loadTrackerState(): TrackerState {
  const filePath = getStateFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content) as TrackerState;
    } catch {
      // Fallback on empty state if file corrupt
    }
  }
  return { run: 0, providers: {} };
}

function saveTrackerState(state: TrackerState): void {
  const filePath = getStateFilePath();
  const stateDir = getStateDir();
  const tmpPath = path.join(stateDir, `.tracker-state-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function appendTrackEvents(events: Array<Record<string, unknown>>): void {
  if (events.length === 0) return;
  const stateDir = getStateDir();
  const filePath = path.join(stateDir, 'track-events.jsonl');

  let existingLines: string[] = [];
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      existingLines = content.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      existingLines = [];
    }
  }

  const newLines = events.map((e) => JSON.stringify(e));
  let allLines = existingLines.concat(newLines);

  // Retention: max 2000 lines
  if (allLines.length > 2000) {
    allLines = allLines.slice(allLines.length - 2000);
  }

  // Retention: max 5 MB (5 * 1024 * 1024 bytes)
  const MAX_BYTES = 5 * 1024 * 1024;
  let joined = allLines.join('\n') + '\n';
  if (Buffer.byteLength(joined, 'utf8') > MAX_BYTES) {
    while (allLines.length > 0 && Buffer.byteLength(allLines.join('\n') + '\n', 'utf8') > MAX_BYTES) {
      allLines.shift();
    }
    joined = allLines.join('\n') + '\n';
  }

  const tmpPath = path.join(stateDir, `.track-events-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmpPath, joined, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export interface SkipReasons {
  'no-endpoint': number;
  'no-key': number;
  'inactive': number;
  'key-encrypted': number;
}

export interface DiscoveredProvidersResult {
  router: string;
  providers: ProviderConfig[];
  discoveredCount: number;
  trackedCount: number;
  skippedCount: number;
  skipReasons: SkipReasons;
  dbMissing: boolean;
}

export function withTempDbCopy<T>(srcPath: string, fn: (tempPath: string) => T): T {
  const tmpDir = path.join(os.tmpdir(), 'routersync-track-temp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const tempPath = path.join(tmpDir, `track-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  fs.copyFileSync(srcPath, tempPath);
  try {
    return fn(tempPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore unlink error
    }
  }
}

export function loadProviderEndpointsMap(): Record<string, { baseUrl: string; source?: string }> {
  const customPath = process.env['ROUTERSYNC_PROVIDER_ENDPOINTS_PATH'];
  const candidates = [
    ...(customPath ? [customPath] : []),
    path.join(process.cwd(), 'docs', 'track', 'provider-endpoints.json'),
    path.join(currentDir, '..', '..', '..', 'docs', 'track', 'provider-endpoints.json'),
    path.join(currentDir, '..', '..', 'docs', 'track', 'provider-endpoints.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const obj = raw.providers || raw;
        if (obj && typeof obj === 'object') {
          return obj;
        }
      } catch {
        // ignore
      }
    }
  }
  return {};
}

export function resolveFallbackEndpoint(provId: string, endpointsMap: Record<string, { baseUrl: string; source?: string }>): string | undefined {
  const key = provId.toLowerCase().trim();
  if (endpointsMap[key]?.baseUrl) {
    return endpointsMap[key].baseUrl;
  }
  for (const [k, v] of Object.entries(endpointsMap)) {
    const lk = k.toLowerCase().trim();
    if (key === lk) {
      return v.baseUrl;
    }
  }
  for (const [k, v] of Object.entries(endpointsMap)) {
    const lk = k.toLowerCase().trim();
    if (key.includes(lk) && !key.startsWith('openai-compatible')) {
      return v.baseUrl;
    }
  }
  return undefined;
}

function redactSecrets(text: string): string {
  return text.replace(/(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/gi, '[REDACTED]');
}

export function discoverSingleRouter(
  router: string,
  endpointsMap: Record<string, { baseUrl: string; source?: string }>
): DiscoveredProvidersResult {
  const providers: ProviderConfig[] = [];
  let discoveredCount = 0;
  let trackedCount = 0;
  let skippedCount = 0;
  const skipReasons: SkipReasons = {
    'no-endpoint': 0,
    'no-key': 0,
    'inactive': 0,
    'key-encrypted': 0,
  };
  let dbMissing = false;

  if (router === 'catalog') {
    const dbPath = process.env['ROUTERSYNC_CATALOG_DB_PATH'] || path.join(getStateDir(), 'catalog.sqlite');
    if (!fs.existsSync(dbPath)) {
      dbMissing = true;
    } else {
      try {
        withTempDbCopy(dbPath, (tempPath) => {
          const db = openBetterSqlite3(tempPath, { readOnly: true });
          try {
            const broker = new CredentialBroker(process.env as Record<string, string>);
            const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_providers'").get();
            if (hasTable) {
              const hasCref = db.prepare("SELECT COUNT(*) as n FROM pragma_table_info('catalog_providers') WHERE name='credentialRef'").get() as { n: number };
              const cols = hasCref && hasCref.n > 0
                ? 'id, name, kind, endpoint, status, credentialRef'
                : 'id, name, kind, endpoint, status';
              const rows = db.prepare(`SELECT ${cols} FROM catalog_providers`).all() as any[];
              for (const row of rows) {
                discoveredCount++;
                const isInactive = row.status === 'inactive' || row.status === 'disabled';
                if (isInactive) {
                  skippedCount++;
                  skipReasons['inactive']++;
                  continue;
                }
                const id = String(row.id);
                let endpoint = typeof row.endpoint === 'string' && row.endpoint.trim() ? row.endpoint.trim() : undefined;
                if (!endpoint || !endpoint.startsWith('http')) {
                  endpoint = resolveFallbackEndpoint(id, endpointsMap);
                }
                if (!endpoint || (!endpoint.startsWith('http://') && !endpoint.startsWith('https://'))) {
                  skippedCount++;
                  skipReasons['no-endpoint']++;
                  providers.push({
                    id,
                    kind: row.kind || 'openai-compatible',
                    baseUrl: '',
                    via: 'catalog',
                  });
                  continue;
                }

                const isOllama = row.kind === 'ollama' || endpoint.includes('11434');
                const isNoneAuth = isOllama || row.auth === 'none';

                if (isNoneAuth) {
                  trackedCount++;
                  providers.push({
                    id,
                    kind: row.kind || 'openai-compatible',
                    baseUrl: endpoint,
                    auth: 'none',
                    via: 'catalog',
                  });
                } else if (row.credentialRef) {
                  const cred = broker.resolve(row.credentialRef as string);
                  if (cred?.raw) {
                    trackedCount++;
                    providers.push({
                      id,
                      kind: row.kind || 'openai-compatible',
                      baseUrl: endpoint,
                      apiKeyEnv: cred.sourceEnv,
                      via: 'catalog',
                    });
                  } else {
                    skippedCount++;
                    skipReasons['no-key']++;
                    providers.push({
                      id,
                      kind: row.kind || 'openai-compatible',
                      baseUrl: endpoint,
                      via: 'catalog',
                    });
                  }
                } else {
                  skippedCount++;
                  skipReasons['no-key']++;
                  providers.push({
                    id,
                    kind: row.kind || 'openai-compatible',
                    baseUrl: endpoint,
                    via: 'catalog',
                  });
                }
              }
            }
          } finally {
            db.close();
          }
        });
      } catch {
        // Fallback
      }
    }
  } else if (router === '9router') {
    const appData = process.env['APPDATA'] ?? (os.platform() === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.config'));
    const dbPath = process.env['NINEROUTER_DB_PATH'] || path.join(appData, '9router', 'db', 'data.sqlite');
    if (!fs.existsSync(dbPath)) {
      dbMissing = true;
    } else {
      try {
        withTempDbCopy(dbPath, (tempPath) => {
          const db = openBetterSqlite3(tempPath, { readOnly: true });
          try {
            const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
            if (hasTable) {
              const cols9r = db.prepare("PRAGMA table_info(providerConnections)").all() as any[];
              const hasIsActive = cols9r.some((c: any) => c.name === 'isActive');
              const hasAuthType = cols9r.some((c: any) => c.name === 'authType');
              const selectCols = ['id', 'provider', hasAuthType ? 'authType' : 'NULL as authType', hasIsActive ? 'isActive' : 'NULL as isActive', 'data'].join(', ');
              const rows = db.prepare(`SELECT ${selectCols} FROM providerConnections`).all() as any[];
              for (const row of rows) {
                discoveredCount++;
                const provId = String(row.provider || row.id);
                const rowStatus = (row as any).status;
                const active = hasIsActive ? !!row.isActive : (rowStatus !== 'inactive' && rowStatus !== 'disabled');
                if (!active) {
                  skippedCount++;
                  skipReasons['inactive']++;
                  continue;
                }
                let endpoint: string | undefined;
                let apiKeyRaw: string | undefined;
                if (row.data) {
                  try {
                    const parsed = JSON.parse(row.data);
                    endpoint = parsed.endpoint || parsed.baseUrl || parsed.url;
                    apiKeyRaw = typeof parsed.apiKey === 'string' && parsed.apiKey.trim() ? parsed.apiKey.trim() : undefined;
                  } catch { /* ignore */ }
                }
                if (!endpoint || !endpoint.startsWith('http')) {
                  endpoint = resolveFallbackEndpoint(provId, endpointsMap);
                }
                if (!endpoint || (!endpoint.startsWith('http://') && !endpoint.startsWith('https://'))) {
                  skippedCount++;
                  skipReasons['no-endpoint']++;
                  continue;
                }
                if (apiKeyRaw) {
                  trackedCount++;
                  providers.push({
                    id: provId,
                    kind: 'openai-compatible',
                    baseUrl: endpoint,
                    apiKeyDirect: apiKeyRaw,
                    via: '9router',
                  });
                } else {
                  trackedCount++;
                  providers.push({
                    id: provId,
                    kind: 'openai-compatible',
                    baseUrl: endpoint,
                    auth: 'none',
                    via: '9router',
                  });
                }
              }
            }
          } finally {
            db.close();
          }
        });
      } catch {
        // Fallback
      }
    }
  } else if (router === 'omniroute') {
    const dbPath = process.env['OMNIROUTE_DB_PATH'] || path.join(os.homedir(), '.omniroute', 'storage.sqlite');
    if (!fs.existsSync(dbPath)) {
      dbMissing = true;
    } else {
      try {
        withTempDbCopy(dbPath, (tempPath) => {
          const db = openBetterSqlite3(tempPath, { readOnly: true });
          try {
            const hasConns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_connections'").get();
            const hasCaps = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_capabilities'").get();
            if (hasConns) {
              const rows = db.prepare('SELECT id, provider, auth_type, is_active, api_key FROM provider_connections').all() as any[];
              for (const row of rows) {
                discoveredCount++;
                if (!row.is_active) {
                  skippedCount++;
                  skipReasons['inactive']++;
                  continue;
                }
                const provId = String(row.provider || row.id);
                const apiKeyRaw = typeof row.api_key === 'string' && row.api_key.trim() ? row.api_key.trim() : undefined;
                if (!apiKeyRaw) {
                  skippedCount++;
                  skipReasons['no-key']++;
                  continue;
                }
                if (apiKeyRaw.startsWith('enc:')) {
                  skippedCount++;
                  skipReasons['key-encrypted']++;
                  continue;
                }
                const endpoint = resolveFallbackEndpoint(provId, endpointsMap);
                if (!endpoint || (!endpoint.startsWith('http://') && !endpoint.startsWith('https://'))) {
                  skippedCount++;
                  skipReasons['no-endpoint']++;
                  continue;
                }
                trackedCount++;
                providers.push({
                  id: provId,
                  kind: 'openai-compatible',
                  baseUrl: endpoint,
                  apiKeyDirect: apiKeyRaw,
                  via: 'omniroute',
                });
              }
            } else if (hasCaps) {
              const rows = db.prepare('SELECT DISTINCT provider FROM model_capabilities').all() as any[];
              for (const row of rows) {
                discoveredCount++;
                const provId = String(row.provider);
                skippedCount++;
                skipReasons['no-endpoint']++;
                providers.push({
                  id: provId,
                  kind: 'openai-compatible',
                  baseUrl: '',
                  via: 'omniroute',
                });
              }
            }
          } finally {
            db.close();
          }
        });
      } catch {
        // Fallback
      }
    }
  }

  return {
    router,
    providers,
    discoveredCount,
    trackedCount,
    skippedCount,
    skipReasons,
    dbMissing,
  };
}

export function discoverProviders(targetRouter?: string): DiscoveredProvidersResult {
  let router = targetRouter;
  if (!router) {
    if (process.env['ROUTERSYNC_ROUTER']) {
      router = process.env['ROUTERSYNC_ROUTER'];
    } else if (process.env['ROUTERSYNC_CATALOG_DB_PATH'] || fs.existsSync(path.join(getStateDir(), 'catalog.sqlite'))) {
      router = 'catalog';
    } else if (process.env['NINEROUTER_DB_PATH']) {
      router = '9router';
    } else if (process.env['OMNIROUTE_DB_PATH']) {
      router = 'omniroute';
    } else {
      router = 'catalog';
    }
  }

  const endpointsMap = loadProviderEndpointsMap();

  if (router === 'all') {
    const catalogRes = discoverSingleRouter('catalog', endpointsMap);
    const nineRes = discoverSingleRouter('9router', endpointsMap);
    const omniRes = discoverSingleRouter('omniroute', endpointsMap);

    const providerMap = new Map<string, ProviderConfig>();
    for (const p of [...catalogRes.providers, ...nineRes.providers, ...omniRes.providers]) {
      const existing = providerMap.get(p.id);
      if (!existing) {
        providerMap.set(p.id, p);
      } else {
        const existingHasKey = Boolean(existing.apiKeyDirect || (existing.apiKeyEnv && process.env[existing.apiKeyEnv]));
        const currentHasKey = Boolean(p.apiKeyDirect || (p.apiKeyEnv && process.env[p.apiKeyEnv]));
        if (!existingHasKey && currentHasKey) {
          providerMap.set(p.id, p);
        }
      }
    }
    const combinedProviders = Array.from(providerMap.values());
    const totalDiscovered = catalogRes.discoveredCount + nineRes.discoveredCount + omniRes.discoveredCount;
    const totalTracked = combinedProviders.length;
    const totalSkipped = totalDiscovered - totalTracked;
    const combinedSkipReasons: SkipReasons = {
      'no-endpoint': catalogRes.skipReasons['no-endpoint'] + nineRes.skipReasons['no-endpoint'] + omniRes.skipReasons['no-endpoint'],
      'no-key': catalogRes.skipReasons['no-key'] + nineRes.skipReasons['no-key'] + omniRes.skipReasons['no-key'],
      'inactive': catalogRes.skipReasons['inactive'] + nineRes.skipReasons['inactive'] + omniRes.skipReasons['inactive'],
      'key-encrypted': catalogRes.skipReasons['key-encrypted'] + nineRes.skipReasons['key-encrypted'] + omniRes.skipReasons['key-encrypted'],
    };
    const dbMissing = catalogRes.dbMissing && nineRes.dbMissing && omniRes.dbMissing;

    return {
      router: 'all',
      providers: combinedProviders,
      discoveredCount: totalDiscovered,
      trackedCount: totalTracked,
      skippedCount: totalSkipped,
      skipReasons: combinedSkipReasons,
      dbMissing,
    };
  }

  return discoverSingleRouter(router, endpointsMap);
}

function loadProvidersConfig(filePath?: string): ProviderConfig[] {
  let targetPath = filePath;
  if (!targetPath) {
    const candidateDefault = path.join(process.cwd(), 'docs', 'track', 'providers.public.example.json');
    if (fs.existsSync(candidateDefault)) {
      targetPath = candidateDefault;
    } else {
      targetPath = path.join(getStateDir(), 'providers.json');
    }
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Tệp cấu hình nhà cung cấp không tồn tại: ${targetPath}`);
  }

  const raw = fs.readFileSync(targetPath, 'utf8');
  return JSON.parse(raw) as ProviderConfig[];
}

export async function runTrackOnceCore(
  providers: ProviderConfig[],
  options?: { enrich?: boolean | undefined }
): Promise<TrackOnceResult> {
  const seenIds = new Set<string>();
  const dedupedProviders: ProviderConfig[] = [];
  for (const p of providers) {
    if (!seenIds.has(p.id)) {
      seenIds.add(p.id);
      dedupedProviders.push(p);
    }
  }

  const state = loadTrackerState();
  state.run += 1;
  const currentRun = state.run;

  const results: ProviderScanResult[] = [];
  const events: Array<Record<string, unknown>> = [];
  let httpGetCount = 0;

  for (const provider of dedupedProviders) {
    const prevState = state.providers[provider.id];
    const isFirstScan = !prevState;

    // Skip providers without a valid baseUrl (e.g. omniroute fixture without endpoint)
    if (!provider.baseUrl || !provider.baseUrl.startsWith('http')) {
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'skipped',
        reason: 'Không có endpoint hợp lệ',
        baseline: false,
        count: prevState ? prevState.models.length : 0,
        added: [],
        removed: [],
        pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
      });
      continue;
    }

    // 1. Kiểm tra khóa API nếu không phải auth=none
    let apiKey: string | undefined = provider.apiKeyDirect;
    if (!apiKey && provider.apiKeyEnv) {
      apiKey = process.env[provider.apiKeyEnv];
    }

    if (provider.auth !== 'none' && !apiKey) {
      if (provider.apiKeyEnv) {
        results.push({
          id: provider.id,
          via: provider.via,
          status: 'skipped',
          reason: `Thiếu biến môi trường khóa API: ${provider.apiKeyEnv}`,
          baseline: false,
          count: prevState ? prevState.models.length : 0,
          added: [],
          removed: [],
          pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
        });
      } else {
        results.push({
          id: provider.id,
          via: provider.via,
          status: 'skipped',
          reason: 'Không có thông tin xác thực và endpoint không phải công khai',
          baseline: false,
          count: prevState ? prevState.models.length : 0,
          added: [],
          removed: [],
          pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
        });
      }
      continue;
    }

    const url = provider.baseUrl.replace(/\/+$/, '') + '/models';

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'RouterSync-ZeroTokenTracker/0.1.0',
    };

    if (provider.auth !== 'none' && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    let fetchRes: Response;
    try {
      fetchRes = await fetch(url, {
        method: 'GET',
        headers,
      });
      httpGetCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'unreachable',
        reason: redactSecrets(msg),
        baseline: false,
        count: prevState ? prevState.models.length : 0,
        added: [],
        removed: [],
        pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
      });
      if (prevState) {
        prevState.lastScanAt = new Date().toISOString();
        prevState.status = 'unreachable';
      }
      events.push({
        timestamp: new Date().toISOString(),
        type: 'provider_unreachable',
        provider: provider.id,
        detail: redactSecrets(msg),
        run: currentRun,
      });
      continue;
    }

    if (fetchRes.status === 401) {
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'auth_error',
        reason: '401 Unauthorized',
        baseline: false,
        count: prevState ? prevState.models.length : 0,
        added: [],
        removed: [],
        pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
      });
      if (prevState) {
        prevState.lastScanAt = new Date().toISOString();
        prevState.status = 'auth_error';
      }
      events.push({
        timestamp: new Date().toISOString(),
        type: 'provider_auth_error',
        provider: provider.id,
        detail: '401 Unauthorized',
        run: currentRun,
      });
      continue;
    }

    if (fetchRes.status !== 200) {
      const statusText = `HTTP ${fetchRes.status}`;
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'unreachable',
        reason: statusText,
        baseline: false,
        count: prevState ? prevState.models.length : 0,
        added: [],
        removed: [],
        pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
      });
      if (prevState) {
        prevState.lastScanAt = new Date().toISOString();
        prevState.status = 'unreachable';
      }
      events.push({
        timestamp: new Date().toISOString(),
        type: 'provider_unreachable',
        provider: provider.id,
        detail: statusText,
        run: currentRun,
      });
      continue;
    }

    let bodyJson: any;
    try {
      bodyJson = await fetchRes.json();
    } catch (err: unknown) {
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'unreachable',
        reason: 'Lỗi giải mã JSON từ phản hồi',
        baseline: false,
        count: prevState ? prevState.models.length : 0,
        added: [],
        removed: [],
        pendingRemoval: prevState ? Object.keys(prevState.pendingRemoval) : [],
      });
      events.push({
        timestamp: new Date().toISOString(),
        type: 'provider_unreachable',
        provider: provider.id,
        detail: 'Lỗi giải mã JSON từ phản hồi',
        run: currentRun,
      });
      continue;
    }

    const rawList: any[] = Array.isArray(bodyJson?.data)
      ? bodyJson.data
      : Array.isArray(bodyJson)
      ? bodyJson
      : [];

    const incomingIds: string[] = rawList
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    const nowIso = new Date().toISOString();

    if (isFirstScan) {
      state.providers[provider.id] = {
        id: provider.id,
        lastScanAt: nowIso,
        status: 'ok',
        count: incomingIds.length,
        models: incomingIds,
        pendingRemoval: {},
      };

      results.push({
        id: provider.id,
        via: provider.via,
        status: 'ok',
        reason: null,
        baseline: true,
        count: incomingIds.length,
        added: [],
        removed: [],
        pendingRemoval: [],
      });
      events.push({
        timestamp: nowIso,
        type: 'baseline',
        provider: provider.id,
        count: incomingIds.length,
        run: currentRun,
      });
      continue;
    }

    const prevModelsSet = new Set(prevState.models);
    const incomingSet = new Set(incomingIds);
    const prevCount = prevState.models.length;
    const currentCount = incomingIds.length;

    if (prevCount > 0 && (prevCount - currentCount) / prevCount > 0.3) {
      prevState.lastScanAt = nowIso;
      prevState.status = 'frozen';
      results.push({
        id: provider.id,
        via: provider.via,
        status: 'frozen',
        reason: `Danh sách model tụt >30% (shrink) từ ${prevCount} xuống ${currentCount}, đóng băng danh mục chống xóa nhầm`,
        baseline: false,
        count: currentCount,
        added: [],
        removed: [],
        pendingRemoval: Object.keys(prevState.pendingRemoval),
      });
      events.push({
        timestamp: nowIso,
        type: 'provider_frozen',
        provider: provider.id,
        detail: `Danh sách model tụt >30% (shrink) từ ${prevCount} xuống ${currentCount}`,
        run: currentRun,
      });
      continue;
    }

    prevState.status = 'ok';
    prevState.lastScanAt = nowIso;

    const addedModels = incomingIds.filter((id) => !prevModelsSet.has(id));
    const missingModels = prevState.models.filter((id) => !incomingSet.has(id));

    const pendingRemovalMap = prevState.pendingRemoval || {};
    const newlyPending: string[] = [];
    const removedModels: string[] = [];

    for (const id of missingModels) {
      const missedCount = (pendingRemovalMap[id] || 0) + 1;
      pendingRemovalMap[id] = missedCount;
      if (missedCount >= 2) {
        removedModels.push(id);
        delete pendingRemovalMap[id];
      } else {
        newlyPending.push(id);
      }
    }

    const recoveredModels: string[] = [];
    for (const id of incomingIds) {
      if (pendingRemovalMap[id] !== undefined) {
        recoveredModels.push(id);
        delete pendingRemovalMap[id];
      }
    }

    const nextModels = prevState.models
      .filter((id) => !removedModels.includes(id))
      .concat(addedModels);

    prevState.models = nextModels;
    prevState.count = nextModels.length;
    prevState.pendingRemoval = pendingRemovalMap;

    results.push({
      id: provider.id,
      via: provider.via,
      status: 'ok',
      reason: null,
      baseline: false,
      count: incomingIds.length,
      added: addedModels,
      removed: removedModels,
      pendingRemoval: newlyPending,
    });

    if (addedModels.length > 0) {
      events.push({
        timestamp: nowIso,
        type: 'model_added',
        provider: provider.id,
        models: addedModels,
        run: currentRun,
      });
    }

    if (newlyPending.length > 0) {
      events.push({
        timestamp: nowIso,
        type: 'model_pending',
        provider: provider.id,
        models: newlyPending,
        run: currentRun,
      });
    }

    if (removedModels.length > 0) {
      events.push({
        timestamp: nowIso,
        type: 'model_removed',
        provider: provider.id,
        models: removedModels,
        run: currentRun,
      });
    }

    if (recoveredModels.length > 0) {
      events.push({
        timestamp: nowIso,
        type: 'model_recovered',
        provider: provider.id,
        models: recoveredModels,
        run: currentRun,
      });
    }
  }

  if (options?.enrich) {
    const openrouterUrl = process.env['ROUTERSYNC_OPENROUTER_MODELS_URL'] || 'https://openrouter.ai/api/v1/models';
    let openrouterModels: Array<{ id: string; pricing?: { prompt?: unknown; completion?: unknown }; context_length?: number }> = [];
    try {
      httpGetCount++;
      const res = await fetch(openrouterUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: Array<{ id: string; pricing?: { prompt?: unknown; completion?: unknown }; context_length?: number }>;
        };
        if (Array.isArray(body?.data)) {
          openrouterModels = body.data;
        }
      }
    } catch {
      // openrouterModels remains empty on fetch failure
    }

    let ownerConfig: OwnerConfig | null = null;
    const ownerConfigFile = path.join(getStateDir(), 'owner-config.json');
    if (fs.existsSync(ownerConfigFile)) {
      try {
        ownerConfig = JSON.parse(fs.readFileSync(ownerConfigFile, 'utf8'));
      } catch {
        // ignore invalid owner-config.json
      }
    }

    const classification = classifyFree({
      provider: 'openrouter',
      models: openrouterModels,
      ownerConfig,
    });

    const freeCount = classification.items.filter((m) => m.free).length;
    console.log(
      `ENRICH provider=openrouter source=${openrouterUrl} models=${classification.items.length} free=${freeCount}`
    );

    for (const p of dedupedProviders) {
      if (!p.id.toLowerCase().includes('openrouter')) {
        console.log(`ENRICH-SKIPPED ${p.id} reason=no-public-metadata-endpoint`);
      }
    }
    if (dedupedProviders.length === 0 || !dedupedProviders.some((p) => !p.id.toLowerCase().includes('openrouter'))) {
      console.log('ENRICH-SKIPPED catalog reason=no-public-metadata-endpoint');
    }

    const stateDir = getStateDir();
    const metaPath = path.join(stateDir, 'model-meta.json');
    const metaData = {
      updatedAt: new Date().toISOString(),
      provider: 'openrouter',
      source: openrouterUrl,
      modelsCount: classification.items.length,
      freeCount,
      items: classification.items,
    };
    const tmpPath = path.join(stateDir, `.model-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(metaData, null, 2), 'utf8');
    fs.renameSync(tmpPath, metaPath);
  }

  saveTrackerState(state);
  appendTrackEvents(events);
  console.log(`HTTP-METHODS GET=${httpGetCount} OTHER=0`);

  return {
    run: currentRun,
    providers: results,
  };
}

export async function runTrackOnceCommand(opts: {
  providersFile?: string;
  discover?: boolean;
  router?: string;
  plan?: boolean;
  enrich?: boolean;
  json?: boolean;
}): Promise<void> {
  let providers: ProviderConfig[];
  if (opts.discover) {
    const discovery = discoverProviders(opts.router);
    console.log(
      `TRACK-DISCOVER router=${discovery.router} providers=${discovery.discoveredCount} tracked=${discovery.trackedCount} skipped=${discovery.skippedCount}`
    );
    if (discovery.dbMissing && discovery.discoveredCount === 0) {
      console.log(
        `REASON-SUMMARY router=${discovery.router} tracked=${discovery.trackedCount} skipped=${discovery.skippedCount}: db-missing`
      );
    } else if (discovery.skippedCount > 0 || discovery.trackedCount === 0) {
      console.log(
        `REASON-SUMMARY router=${discovery.router} tracked=${discovery.trackedCount} skipped=${discovery.skippedCount}: no-endpoint=${discovery.skipReasons['no-endpoint']} no-key=${discovery.skipReasons['no-key']} inactive=${discovery.skipReasons['inactive']} key-encrypted=${discovery.skipReasons['key-encrypted']}`
      );
    }
    providers = discovery.providers;
  } else {
    providers = loadProvidersConfig(opts.providersFile);
  }
  const result = await runTrackOnceCore(
    providers,
    opts.enrich !== undefined ? { enrich: opts.enrich } : undefined
  );

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`Lượt quét #${result.run} hoàn tất: ${result.providers.length} nhà cung cấp.`);
    for (const p of result.providers) {
      const viaPart = p.via ? ` via=${p.via}` : '';
      const padId = p.id.padEnd(24);
      const padStatus = p.status.padEnd(16);
      console.log(`${padId}  ${padStatus}count=${p.count} baseline=${p.baseline} added=${p.added.length} removed=${p.removed.length} pending=${p.pendingRemoval.length}${viaPart}`);
    }
  }

  if (opts.plan) {
    const { runMaintainPlanCommand } = await import('./maintain.js');
    await runMaintainPlanCommand({
      router: opts.router,
      json: opts.json,
    });
  }
}

export async function runTrackWatchCommand(opts: {
  providersFile?: string;
  intervalSec?: string | number;
  maxRuns?: string | number;
  json?: boolean;
}): Promise<void> {
  const intervalSec = Number(opts.intervalSec ?? 300);

  // S15: Giới hạn tần suất tối thiểu 300 giây (5 phút) trừ khi ROUTERSYNC_TEST_FAST=1
  if (intervalSec < 300 && process.env.ROUTERSYNC_TEST_FAST !== '1') {
    console.error('Lỗi: Khoảng thời gian quét tối thiểu (floor interval) là 300 giây (5 phút) để tránh dồn dập endpoint. (Sử dụng ROUTERSYNC_TEST_FAST=1 cho môi trường thử nghiệm).');
    process.exit(1);
  }

  const providers = loadProvidersConfig(opts.providersFile);
  const maxRuns = opts.maxRuns ? Number(opts.maxRuns) : Infinity;
  let runs = 0;

  while (runs < maxRuns) {
    runs++;
    const result = await runTrackOnceCore(providers);
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`[${new Date().toISOString()}] Lượt quét #${result.run}:`);
      for (const p of result.providers) {
        console.log(`  ${p.id}: ${p.status} (${p.count} model, +${p.added.length}/-${p.removed.length})`);
      }
    }

    if (runs >= maxRuns) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

export async function runTrackStatusCommand(opts: {
  providersFile?: string;
  json?: boolean;
}): Promise<void> {
  let providers: ProviderConfig[] = [];
  try {
    providers = loadProvidersConfig(opts.providersFile);
  } catch {
    // Có thể không có providersFile, đọc từ state
  }

  const state = loadTrackerState();

  const providerStatuses: Array<{
    id: string;
    status: string;
    count: number;
    lastScanAt: string;
  }> = [];

  const processedIds = new Set<string>();

  for (const p of providers) {
    processedIds.add(p.id);
    const pState = state.providers[p.id];
    if (pState) {
      providerStatuses.push({
        id: p.id,
        status: pState.status,
        count: pState.models.length,
        lastScanAt: pState.lastScanAt,
      });
    } else {
      providerStatuses.push({
        id: p.id,
        status: 'unscanned',
        count: 0,
        lastScanAt: new Date(0).toISOString(),
      });
    }
  }

  // Thêm các provider có trong state nhưng không có trong providers.json
  for (const [id, pState] of Object.entries(state.providers)) {
    if (!processedIds.has(id)) {
      providerStatuses.push({
        id,
        status: pState.status,
        count: pState.models.length,
        lastScanAt: pState.lastScanAt,
      });
    }
  }

  const output = { providers: providerStatuses };

  if (opts.json) {
    console.log(JSON.stringify(output));
  } else {
    console.log('Trạng thái theo dõi model các nhà cung cấp:');
    for (const p of providerStatuses) {
      console.log(` - ${p.id}: ${p.status} (${p.count} models, quét lần cuối: ${p.lastScanAt})`);
    }
  }
}

export function runTrackAutostartCommand(opts: { print?: boolean }): void {
  console.log('Huong dan tu khoi dong bo theo doi track watch:');
  console.log('Windows (Task Scheduler / schtasks): schtasks /Create /SC ONLOGON /TN RouterSyncTracker /TR "routersync track watch"');
  console.log('Linux (systemd): systemd service chay routersync track watch');
  console.log('macOS (launchd): launchd plist chay routersync track watch');
  console.log('Unix (crontab): @reboot routersync track watch');
}
