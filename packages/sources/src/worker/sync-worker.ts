/**
 * packages/sources/src/worker/sync-worker.ts
 *
 * Background Sync Worker for RouterSync (Phase 3b / SPEC §31.9 ④).
 * Periodically scans configured model providers, validates lists using
 * zero-token scanners with shrink and grace cycle guards, and persists
 * them into the Catalog SQLite database.
 */

import { CredentialBroker, type CredentialReference } from '@routersync/core';
import type { CatalogStore, ModelBatchInput } from '../catalog/store.js';
import { scanOpenAiCompatibleModels, type ScanResult } from '../discovery/provider-scanner.js';
import { scanGoogleGeminiModels } from '../discovery/google-scanner.js';
import { scanOllamaModels } from '../discovery/ollama-scanner.js';

export interface SyncWorkerProviderConfig {
  id: string;
  name: string;
  kind: 'openai' | 'google' | 'ollama' | 'openrouter' | string;
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  credentialRef?: CredentialReference | string | undefined;
  maxShrinkRatio?: number | undefined;
  graceCycles?: number | undefined;
}

export interface SyncWorkerOptions {
  catalogStore: CatalogStore;
  credentialBroker?: CredentialBroker | undefined;
  providers?: SyncWorkerProviderConfig[] | undefined;
  intervalMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

export interface SyncCycleResult {
  timestamp: string;
  providersProcessed: number;
  modelsRecordedTotal: number;
  errors: Array<{ providerId: string; error: string }>;
}

export class SyncWorker {
  private readonly catalogStore: CatalogStore;
  private readonly credentialBroker: CredentialBroker;
  private providers: SyncWorkerProviderConfig[];
  private readonly intervalMs: number;
  private readonly fetchFn?: typeof globalThis.fetch | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private syncing = false;

  constructor(options: SyncWorkerOptions) {
    this.catalogStore = options.catalogStore;
    this.credentialBroker = options.credentialBroker ?? new CredentialBroker();
    this.providers = options.providers ? [...options.providers] : [];
    this.intervalMs = options.intervalMs ?? 3600000; // default 1 hour
    this.fetchFn = options.fetchFn;
  }

  setProviders(providers: SyncWorkerProviderConfig[]): void {
    this.providers = [...providers];
  }

  isRunning(): boolean {
    return this.running;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  async syncOnce(): Promise<SyncCycleResult> {
    this.syncing = true;
    const nowIso = new Date().toISOString();
    let modelsRecordedTotal = 0;
    const errors: Array<{ providerId: string; error: string }> = [];

    try {
      for (const prov of this.providers) {
        try {
          // Resolve credential if reference or env string is given
          let resolvedKey = prov.apiKey;
          if (!resolvedKey && prov.credentialRef) {
            const cred = this.credentialBroker.resolve(prov.credentialRef);
            resolvedKey = cred?.raw;
          }

          // Ensure provider record exists in catalog
          this.catalogStore.upsertProvider({
            id: prov.id,
            name: prov.name,
            kind: prov.kind,
            endpoint: prov.endpoint,
            status: 'active',
            lastSyncAt: nowIso,
          });

          // Dispatch to appropriate zero-token scanner based on kind
          let scanResult: ScanResult;

          if (prov.kind === 'google') {
            if (!resolvedKey) {
              const errMsg = 'API key required for Google Gemini scanner';
              errors.push({ providerId: prov.id, error: errMsg });
              this.catalogStore.upsertProvider({
                id: prov.id,
                name: prov.name,
                kind: prov.kind,
                endpoint: prov.endpoint,
                status: 'error',
                lastSyncAt: nowIso,
                error: errMsg,
              });
              continue;
            }
            scanResult = await scanGoogleGeminiModels(resolvedKey, {
              fetchFn: this.fetchFn,
            });
          } else if (prov.kind === 'ollama') {
            const base = prov.endpoint ?? 'http://127.0.0.1:11434';
            scanResult = await scanOllamaModels(base, {
              fetchFn: this.fetchFn,
            });
          } else {
            // OpenAI-compatible / default
            const base = prov.endpoint ?? 'https://api.openai.com/v1';
            scanResult = await scanOpenAiCompatibleModels(base, {
              apiKey: resolvedKey,
              fetchFn: this.fetchFn,
            });
          }

          if (!scanResult.ok) {
            const errMsg = scanResult.error ?? 'Unknown scan failure';
            errors.push({ providerId: prov.id, error: errMsg });
            this.catalogStore.upsertProvider({
              id: prov.id,
              name: prov.name,
              kind: prov.kind,
              endpoint: prov.endpoint,
              status: 'error',
              lastSyncAt: nowIso,
              error: errMsg,
            });
            continue;
          }

          // Map scanned models to ModelBatchInput
          const batch: ModelBatchInput[] = scanResult.models.map((m) => ({
            id: m.id,
            name: m.id,
            rawId: m.id,
          }));

          const recordRes = this.catalogStore.recordModelBatch(prov.id, batch, {
            maxShrinkRatio: prov.maxShrinkRatio,
            graceCycles: prov.graceCycles,
          });

          if (recordRes.frozen) {
            errors.push({ providerId: prov.id, error: recordRes.reason ?? 'Shrink ratio exceeded' });
          } else {
            modelsRecordedTotal += recordRes.recorded;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push({ providerId: prov.id, error: errMsg });
        }
      }
    } finally {
      this.syncing = false;
    }

    return {
      timestamp: nowIso,
      providersProcessed: this.providers.length,
      modelsRecordedTotal,
      errors,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Run first sync immediately (async background)
    void this.syncOnce();

    this.timer = setInterval(() => {
      void this.syncOnce();
    }, this.intervalMs);

    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
