import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openBetterSqlite3 } from '@routersync/core';
import { runRankCommand } from '../src/commands/rank.js';
import { isLowResource, _resetLowResourceCache } from '../src/low-resource.js';

describe('C13: isLowResource() module', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    _resetLowResourceCache();
  });

  it('returns true when ROUTERSYNC_LOW_RESOURCE=1', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '1';
    expect(isLowResource()).toBe(true);
  });

  it('returns false when ROUTERSYNC_LOW_RESOURCE=0', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '0';
    expect(isLowResource()).toBe(false);
  });

  it('caches result — second call returns same value without re-evaluating', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '1';
    const r1 = isLowResource();
    // Change env after first call — cached value wins
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '0';
    const r2 = isLowResource();
    expect(r1).toBe(r2);
  });

  it('_resetLowResourceCache clears cache', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '1';
    expect(isLowResource()).toBe(true);
    _resetLowResourceCache();
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '0';
    expect(isLowResource()).toBe(false);
  });
});

describe('C13: rank --json compact/full output', () => {
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
    _resetLowResourceCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('json: true produces compact summary <= 100 KB (default, regardless of LOW_RESOURCE)', async () => {
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
      expect(parsed.length).toBeGreaterThan(0);

      // Compact summary schema
      const first = parsed[0];
      expect(first).toHaveProperty('routerId');
      expect(first).toHaveProperty('comboName');
      expect(first).toHaveProperty('originalCount');
      expect(first).toHaveProperty('retainedCount');
      expect(first).toHaveProperty('top5After');
      expect(first).not.toHaveProperty('top15After'); // compact: truncated to 5

      const bytes = Buffer.byteLength(jsonOutput, 'utf8');
      expect(bytes).toBeLessThanOrEqual(100 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it('json: true, full: true produces full result with top15After', async () => {
    delete process.env['ROUTERSYNC_LOW_RESOURCE'];

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    try {
      await runRankCommand({ router: 'all', json: true, full: true });
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
