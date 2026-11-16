/**
 * test/acceptance/at-130-combos-merge.test.ts
 *
 * Acceptance Test AT-130: Combos smart merge and strictly managed/adopted classification (R12-3b).
 *
 * Validates:
 * 1. Combos with same id, same strategy, and same models merge into 1 element with 2 targets.
 * 2. Combos with same id but different strategy/models emit 2 separate elements each with 1 target.
 * 3. Combo names containing 'free' are NOT classified as free_only in S1 (strictly managed or adopted).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../harness/daemon-fixture.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

describe('Acceptance Test AT-130: Combos smart merge and classification (R12-3b)', () => {
  let fixture: DaemonFixture | undefined;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();

    // 1. Both DBs initially have 'routersync-fast' with strategy 'priority' and models ['m1']
    // -> identical, should merge into 1 item with targets: ['omniroute', '9router']

    // 2. Add 'combo-split' to omniroute with models ['m1', 'm2']
    const omniDb = new DatabaseSync(fixture.omniDbPath);
    try {
      omniDb.exec(
        `INSERT INTO combos (id, name, data) VALUES ('combo-split', 'Diverging Combo', '{"strategy":"priority","models":["m1","m2"],"managed":true}');`
      );
      // Also add a combo with 'free' in id
      omniDb.exec(
        `INSERT INTO combos (id, name, data) VALUES ('free-tier-backup', 'Free Tier Backup', '{"strategy":"priority","models":["m1"],"managed":false}');`
      );
    } finally {
      omniDb.close();
    }

    // 3. Add 'combo-split' to 9router with different models ['m3'] or different strategy
    const nineDb = new DatabaseSync(fixture.nineDbPath);
    try {
      nineDb.exec(
        `INSERT INTO combos (id, name, kind, models) VALUES ('combo-split', 'Diverging Combo', 'managed', '["m3"]');`
      );
    } finally {
      nineDb.close();
    }

    clearProbeCache();
    server = createDaemonServer({ host: '127.0.0.1' });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fixture?.restore();
  });

  it('merges identical combos and splits diverging combos with same id; rejects free_only speculative label', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/combos`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);

    // R18-1: `/api/v1/combos` answers `{ meta, combos }`.
    const body = (await res.json()) as {
      combos: Array<{
        id: string;
        name: string;
        type: string;
        badgeKey: string;
        targets: string[];
        strategy: string;
        steps: Array<{ modelId: string }>;
      }>;
    };
    const combos = body.combos;

    // 1. Identical case: routersync-fast
    const fastCombos = combos.filter((c) => c.id === 'routersync-fast');
    expect(fastCombos).toHaveLength(1);
    expect(fastCombos[0]?.targets.sort()).toEqual(['9router', 'omniroute']);
    expect(fastCombos[0]?.type).toBe('managed');

    // 2. Diverging case: combo-split
    const splitCombos = combos.filter((c) => c.id === 'combo-split');
    expect(splitCombos).toHaveLength(2);
    const omniSplit = splitCombos.find((c) => c.targets.includes('omniroute'));
    const nineSplit = splitCombos.find((c) => c.targets.includes('9router'));
    expect(omniSplit).toBeDefined();
    expect(nineSplit).toBeDefined();
    expect(omniSplit?.targets).toEqual(['omniroute']);
    expect(nineSplit?.targets).toEqual(['9router']);
    expect(omniSplit?.steps.map((s) => s.modelId)).toEqual(['m1', 'm2']);
    expect(nineSplit?.steps.map((s) => s.modelId)).toEqual(['m3']);

    // 3. Reject speculative 'free_only' label on 'free-tier-backup'
    const freeCombo = combos.find((c) => c.id === 'free-tier-backup');
    expect(freeCombo).toBeDefined();
    expect(freeCombo?.type).not.toBe('free_only');
    expect(freeCombo?.type).toBe('adopted');
    expect(freeCombo?.badgeKey).toBe('badge_adopted');
  });
});
