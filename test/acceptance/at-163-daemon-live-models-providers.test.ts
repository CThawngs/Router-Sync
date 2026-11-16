/**
 * test/acceptance/at-163-daemon-live-models-providers.test.ts
 *
 * Acceptance test for AT-163: Daemon Live Providers & Models Endpoints (Phase 3a / P1-DEBT-01 / SPEC §23.2).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createDaemonServer } from '@routersync/daemon';
import { CatalogStore } from '../../packages/sources/src/index.js';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('AT-163: Daemon Live Providers & Models Endpoints', () => {
  let fixture: DaemonFixture;
  let server: http.Server;
  let baseUrl: string;
  let tmpCatalogDir: string;
  let catalogStore: CatalogStore;
  const originalCatalogDb = process.env['ROUTERSYNC_CATALOG_DB_PATH'];

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
    tmpCatalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-daemon-catalog-'));
    const dbPath = path.join(tmpCatalogDir, 'catalog.sqlite');
    process.env['ROUTERSYNC_CATALOG_DB_PATH'] = dbPath;
    catalogStore = new CatalogStore({ dbPath });
    catalogStore.open();

    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (originalCatalogDb !== undefined) {
      process.env['ROUTERSYNC_CATALOG_DB_PATH'] = originalCatalogDb;
    } else {
      delete process.env['ROUTERSYNC_CATALOG_DB_PATH'];
    }
    catalogStore.close();
    if (fs.existsSync(tmpCatalogDir)) {
      fs.rmSync(tmpCatalogDir, { recursive: true, force: true });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture.restore();
  });

  it('returns unavailable when catalog has no providers configured', async () => {
    const res = await fetch(`${baseUrl}/api/v1/providers`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.meta?.source).toBe('unavailable');
    expect(body.meta?.reason).toBe('no_providers_configured');
    expect(body.data).toEqual([]);
  });

  it('returns unavailable when catalog has no models', async () => {
    const res = await fetch(`${baseUrl}/api/v1/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.meta?.source).toBe('unavailable');
    expect(body.meta?.reason).toBe('catalog_empty');
    expect(body.data).toEqual([]);
  });

  it('returns live providers and models when populated in the catalog', async () => {
    catalogStore.upsertProvider({
      id: 'openai',
      name: 'OpenAI Direct',
      kind: 'openai',
      status: 'active',
    });

    catalogStore.recordModelBatch('openai', [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128 },
    ]);

    // Test GET /api/v1/providers
    const provRes = await fetch(`${baseUrl}/api/v1/providers`);
    expect(provRes.status).toBe(200);

    const provBody = (await provRes.json()) as any;
    expect(provBody.meta?.source).toBe('live');
    expect(provBody.data.length).toBe(1);
    expect(provBody.data[0].id).toBe('openai');
    expect(provBody.data[0].modelsCount).toBe(2);

    // Test GET /api/v1/models
    const modRes = await fetch(`${baseUrl}/api/v1/models`);
    expect(modRes.status).toBe(200);

    const modBody = (await modRes.json()) as any;
    expect(modBody.meta?.source).toBe('live');
    expect(modBody.data.length).toBe(2);
    expect(modBody.data.some((m: any) => m.canonicalId === 'gpt-4o')).toBe(true);
    expect(modBody.data.some((m: any) => m.canonicalId === 'gpt-4o-mini')).toBe(true);
  });
});
