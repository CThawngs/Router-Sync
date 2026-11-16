/**
 * test/acceptance/at-129-targets-combos.test.ts
 *
 * Acceptance Test AT-129: Targets combosManaged and combosAdopted separation & truthfulness (R12-2).
 *
 * Validates:
 * 1. combosManaged and combosAdopted are measured truthfully from DB:
 *    managed === true counted in combosManaged, managed === false in combosAdopted.
 * 2. Top-level target object does NOT duplicate combosManaged/combosAdopted.
 * 3. When DB path points to a non-existent file in tmp:
 *    db.meta.source is 'unavailable' and combosManaged/combosAdopted are omitted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
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

describe('Acceptance Test AT-129: Targets combosManaged and combosAdopted separation (R12-2)', () => {
  let fixture: DaemonFixture | undefined;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    fixture = await setupDaemonFixture();

    // Add a user adopted combo (no routersync- prefix, kind = NULL) to 9router DB
    const db = new DatabaseSync(fixture.nineDbPath);
    try {
      db.exec(
        `INSERT INTO combos (id, name, kind, models) VALUES ('user-combo-x', 'User Custom Combo', NULL, '["m2"]');`
      );
    } finally {
      db.close();
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

  it('separates combosManaged and combosAdopted truthfully based on DB managed field', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);

    const targets = (await res.json()) as Array<{
      id: string;
      combosManaged?: number;
      combosAdopted?: number;
      db?: {
        meta: { source: string; reason?: string };
        combosManaged?: number;
        combosAdopted?: number;
      };
    }>;

    // Check top-level does NOT have duplicate combosManaged or combosAdopted
    for (const t of targets) {
      expect(t.combosManaged).toBeUndefined();
      expect(t.combosAdopted).toBeUndefined();
    }

    const nine = targets.find((t) => t.id === '9router');
    expect(nine).toBeDefined();
    expect(nine?.db?.meta.source).toBe('live');
    // 9router has 1 managed (routersync-fast) and 1 adopted (user-combo-x)
    expect(nine?.db?.combosManaged).toBe(1);
    expect(nine?.db?.combosAdopted).toBe(1);

    const omni = targets.find((t) => t.id === 'omniroute');
    expect(omni).toBeDefined();
    expect(omni?.db?.meta.source).toBe('live');
    // omniroute has 1 managed (routersync-fast) and 0 adopted
    expect(omni?.db?.combosManaged).toBe(1);
    expect(omni?.db?.combosAdopted).toBe(0);
  });

  it('omits combosManaged and combosAdopted when DB path does not exist', async () => {
    const nonExistentDb = path.join(fixture!.tmpDir, 'missing.sqlite');
    const originalNineDb = process.env['NINEROUTER_DB_PATH'];
    process.env['NINEROUTER_DB_PATH'] = nonExistentDb;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/targets`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      expect(res.status).toBe(200);

      const targets = (await res.json()) as Array<{
        id: string;
        db?: {
          meta: { source: string; reason?: string };
          combosManaged?: number;
          combosAdopted?: number;
        };
      }>;

      const nine = targets.find((t) => t.id === '9router');
      expect(nine).toBeDefined();
      expect(nine?.db?.meta.source).toBe('unavailable');
      expect(nine?.db?.meta.reason).toBe('db_not_found');
      // When unreadable, combosManaged and combosAdopted must be omitted (not ?? 0)
      expect(nine?.db?.combosManaged).toBeUndefined();
      expect(nine?.db?.combosAdopted).toBeUndefined();
    } finally {
      process.env['NINEROUTER_DB_PATH'] = originalNineDb;
    }
  });
});
