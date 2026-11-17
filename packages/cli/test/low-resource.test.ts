import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '@routersync/core';
import { runRankCommand } from '../src/commands/rank.js';

describe('C12 M4: ROUTERSYNC_LOW_RESOURCE', () => {
  let tmpDir: string;
  let db9: string;
  let dbOmni: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-low-res-test-'));
    db9 = path.join(tmpDir, '9router.sqlite');
    dbOmni = path.join(tmpDir, 'omniroute.sqlite');

    const d1 = openBetterSqlite3(db9);
    d1.exec("CREATE TABLE combos (id TEXT, name TEXT, models TEXT); INSERT INTO combos VALUES ('c1', 'test-combo', '[\"provider-a/model-1\", \"provider-a/model-2\"]');");
    d1.close();

    const d2 = openBetterSqlite3(dbOmni);
    d2.exec("CREATE TABLE combos (id TEXT, name TEXT, data TEXT); INSERT INTO combos VALUES ('c2', 'omni-test-combo', '{\"models\":[\"provider-b/model-1\", \"provider-b/model-2\"]}');");
    d2.close();

    process.env['ROUTERSYNC_9ROUTER_DB'] = db9;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = dbOmni;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('produces compact summary <= 100 KB under ROUTERSYNC_LOW_RESOURCE=1', async () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '1';

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    try {
      await runRankCommand({ router: 'all', json: true });
      expect(logs.length).toBeGreaterThan(0);
      const jsonOutput = logs.join('\n');

      // Must be valid JSON
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      // Verify compact summary schema
      const first = parsed[0];
      expect(first).toHaveProperty('routerId');
      expect(first).toHaveProperty('comboName');
      expect(first).toHaveProperty('originalCount');
      expect(first).toHaveProperty('retainedCount');
      expect(first).toHaveProperty('top5After');
      expect(first).not.toHaveProperty('top15After'); // truncated from 15 to 5 in summary

      // Must be <= 100 KB
      const bytes = Buffer.byteLength(jsonOutput, 'utf8');
      expect(bytes).toBeLessThanOrEqual(100 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it('outputs full result when ROUTERSYNC_LOW_RESOURCE is not set', async () => {
    delete process.env['ROUTERSYNC_LOW_RESOURCE'];

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    try {
      await runRankCommand({ router: 'all', json: true });
      expect(logs.length).toBeGreaterThan(0);
      const jsonOutput = logs.join('\n');
      const parsed = JSON.parse(jsonOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty('top15After');
    } finally {
      spy.mockRestore();
    }
  });
});
