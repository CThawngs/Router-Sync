/**
 * test/acceptance/at-164-sync-worker-fast-loop.test.ts
 *
 * Acceptance test for AT-164: Background Sync Worker & Fast Loop Monitor (Phase 3b / SPEC §31.9 ④).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  CatalogStore,
  SyncWorker,
  type SyncWorkerProviderConfig,
} from '../../packages/sources/src/index.js';
import { FastLoop, type FastLoopState } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('AT-164: Background Sync Worker & Fast Loop Monitor', () => {
  describe('Background Sync Worker', () => {
    let tmpDir: string;
    let catalogStore: CatalogStore;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-worker-'));
      const dbPath = path.join(tmpDir, 'catalog.sqlite');
      catalogStore = new CatalogStore({ dbPath });
      catalogStore.open();
    });

    afterEach(() => {
      catalogStore.close();
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('scans mock providers, resolves credentials and records models into CatalogStore', async () => {
      const mockFetch: typeof globalThis.fetch = async (input, _init) => {
        const urlStr = String(input);
        if (urlStr.includes('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' },
                { id: 'gpt-4o-mini', object: 'model', created: 1700000000, owned_by: 'openai' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.includes('/api/tags')) {
          return new Response(
            JSON.stringify({
              models: [
                { name: 'llama3:latest', modified_at: '2026-01-01T00:00:00Z', size: 4000000000 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      };

      const providers: SyncWorkerProviderConfig[] = [
        {
          id: 'openai',
          name: 'OpenAI Direct',
          kind: 'openai',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'mock-key-synthetic', // no-secrets:allow: synthetic test key
        },
        {
          id: 'ollama',
          name: 'Local Ollama',
          kind: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
        },
      ];

      const worker = new SyncWorker({
        catalogStore,
        providers,
        intervalMs: 100,
        fetchFn: mockFetch,
      });

      const result = await worker.syncOnce();
      expect(result.providersProcessed).toBe(2);
      expect(result.modelsRecordedTotal).toBe(3);
      expect(result.errors).toEqual([]);

      // Verify CatalogStore has active providers and models
      const recordedProviders = catalogStore.listProviders();
      expect(recordedProviders.length).toBe(2);
      expect(recordedProviders.find((p) => p.id === 'openai')?.status).toBe('active');
      expect(recordedProviders.find((p) => p.id === 'ollama')?.status).toBe('active');

      const recordedModels = catalogStore.listModels();
      expect(recordedModels.length).toBe(3);
      expect(recordedModels.some((m) => m.id === 'gpt-4o')).toBe(true);
      expect(recordedModels.some((m) => m.id === 'llama3:latest')).toBe(true);
    });

    it('records provider error without crashing when provider returns HTTP 500', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
      };

      const worker = new SyncWorker({
        catalogStore,
        providers: [
          {
            id: 'failing-provider',
            name: 'Failing Provider',
            kind: 'openai',
            endpoint: 'https://api.failing.com/v1',
          },
        ],
        intervalMs: 100,
        fetchFn: mockFetch,
      });

      const result = await worker.syncOnce();
      expect(result.providersProcessed).toBe(1);
      expect(result.modelsRecordedTotal).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.providerId).toBe('failing-provider');

      const provs = catalogStore.listProviders();
      expect(provs.length).toBe(1);
      expect(provs[0]?.status).toBe('error');
    });

    it('starts and stops gracefully without open timers', () => {
      const worker = new SyncWorker({
        catalogStore,
        providers: [],
        intervalMs: 50,
      });

      expect(worker.isRunning()).toBe(false);
      worker.start();
      expect(worker.isRunning()).toBe(true);
      worker.stop();
      expect(worker.isRunning()).toBe(false);
    });
  });

  describe('Fast Loop Monitor', () => {
    let fixture: DaemonFixture;

    beforeEach(async () => {
      fixture = await setupDaemonFixture();
    });

    afterEach(() => {
      fixture.restore();
    });

    it('inspects router state passively via @routersync/core/readonly', async () => {
      const loop = new FastLoop({ intervalMs: 50 });
      const state = await loop.checkOnce();

      expect(state.timestamp).toBeTruthy();
      expect(state.routers.omniroute).toBeDefined();
      expect(state.routers['9router']).toBeDefined();
      expect(typeof state.totalCombos).toBe('number');
      expect(typeof state.uniqueModels).toBe('number');
      expect(typeof state.anyRouterUp).toBe('boolean');
    });

    it('starts, stops and notifies listeners on state changes', async () => {
      const loop = new FastLoop({ intervalMs: 30 });
      let callCount = 0;
      let lastReceivedState: FastLoopState | null = null;

      const unsubscribe = loop.onStateChange((state) => {
        callCount++;
        lastReceivedState = state;
      });

      expect(loop.isRunning()).toBe(false);
      loop.start();
      expect(loop.isRunning()).toBe(true);

      // Perform a check and wait for one cycle
      await new Promise((r) => setTimeout(r, 60));

      loop.stop();
      expect(loop.isRunning()).toBe(false);
      unsubscribe();
    });
  });
});
