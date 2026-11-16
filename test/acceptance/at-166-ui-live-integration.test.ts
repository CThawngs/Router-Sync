/**
 * test/acceptance/at-166-ui-live-integration.test.ts
 *
 * Acceptance test for AT-166: UI Live Integration & Zero-Mock Mode E2E (Phase 3c / SPEC §31.9 ④).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  createDaemonServer,
  createApprovalToken,
} from '@routersync/daemon';
import { CatalogStore } from '../../packages/sources/src/index.js';
import { HttpApi } from '../../packages/ui/src/api/http.js';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

describe('AT-166: UI Live Integration & Zero-Mock Mode E2E', () => {
  let fixture: DaemonFixture;
  let server: http.Server;
  let baseUrl: string;
  let tmpStateDir: string;
  let catalogStore: CatalogStore;
  let httpApi: HttpApi;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-ui-live-'));
    process.env['ROUTERSYNC_STATE_DIR'] = tmpStateDir;

    // Initialize Catalog SQLite DB
    const catalogPath = path.join(tmpStateDir, 'catalog.sqlite');
    process.env['ROUTERSYNC_CATALOG_DB_PATH'] = catalogPath;
    catalogStore = new CatalogStore({ dbPath: catalogPath });
    catalogStore.open();

    // Populate catalog with test provider and models
    catalogStore.upsertProvider({
      id: 'openai',
      name: 'OpenAI Direct',
      kind: 'openai',
      status: 'active',
    });
    catalogStore.recordModelBatch('openai', [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128 },
    ]);

    // Populate snapshots directory with a valid snapshot
    const snapshotsDir = path.join(tmpStateDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });
    const sampleSnapshot = {
      id: '20261023T020000Z-abcd1234',
      target: 'omniroute',
      createdAt: '2026-10-23T02:00:00.000Z',
      combos: [{ id: 'combo-1', name: 'Combo 1', models: ['gpt-4o'] }],
      summary: 'Test snapshot for omniroute',
      approvedBy: 'human-reviewer',
    };
    fs.writeFileSync(
      path.join(snapshotsDir, `${sampleSnapshot.id}.json`),
      JSON.stringify(sampleSnapshot, null, 2),
      'utf8'
    );

    // Start Daemon Server
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    httpApi = new HttpApi(baseUrl);
  });

  afterAll(async () => {
    delete process.env['ROUTERSYNC_STATE_DIR'];
    delete process.env['ROUTERSYNC_CATALOG_DB_PATH'];
    catalogStore.close();
    if (fs.existsSync(tmpStateDir)) {
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture.restore();
  });

  it('reports isMock() as false in live HttpApi mode', () => {
    expect(httpApi.isMock()).toBe(false);
  });

  it('fetches live overview and daemon health without mock fallback', async () => {
    const health = await httpApi.getDaemonHealth();
    expect(health.reachable).toBe(true);
    expect(health.meta?.source).toBe('live');
    expect(health.readOnly).toBe(true);
    expect(health.routers?.length).toBe(2);

    const overview = await httpApi.getOverview();
    expect(overview.meta?.source).toBe('unavailable');
    expect(overview.meta?.reason).toBe('all_routers_down');
    expect(overview.routers?.probedCount).toBe(2);
  });

  it('fetches live catalog providers and models', async () => {
    const providers = await httpApi.getProviders();
    expect(providers.length).toBe(1);
    expect(providers[0]?.id).toBe('openai');
    expect(providers[0]?.modelsCount).toBe(1);

    const models = await httpApi.getModels();
    expect(models.length).toBe(1);
    expect(models[0]?.canonicalId).toBe('gpt-4o');
    expect(models[0]?.provider).toBe('openai');
  });

  it('fetches live snapshot history from persisted state directory', async () => {
    const snapshots = await httpApi.getSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]?.id).toBe('20261023T020000Z-abcd1234');
    expect(snapshots[0]?.target).toBe('omniroute');
    expect(snapshots[0]?.changedCount).toBe(1);
    expect(snapshots[0]?.approvedBy).toBe('human-reviewer');
  });

  it('executes human plan approval end-to-end with nonce single-use enforcement', async () => {
    const planHash = 'plan-hash-e2e-approved-100';
    const tokenRecord = createApprovalToken(planHash);

    // Initial approval with valid token: must succeed
    const firstResult = await httpApi.approvePlan(planHash, tokenRecord.token);
    expect(firstResult.success).toBe(true);
    expect(firstResult.messageKey).toBe('plan_approved');

    // Replay attempt with the consumed token: must fail
    const replayResult = await httpApi.approvePlan(planHash, tokenRecord.token);
    expect(replayResult.success).toBe(false);
    expect(replayResult.messageKey).toBe('token_already_consumed');
  });
});
