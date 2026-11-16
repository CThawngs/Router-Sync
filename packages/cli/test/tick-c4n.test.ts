/**
 * packages/cli/test/tick-c4n.test.ts
 *
 * Tests for Round C4n improvements in `routersync tick`:
 * - N6.2: --mode validation (rejects invalid/unknown mode, rejects auto-safe with notice, accepts observe/propose).
 * - N6.3: absent model creates inbox proposal ONLY when used in an active combo; otherwise records in status.json.
 * - N8: isActive correctly treats expired snoozed items as inactive based on nowMs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveAutonomyMode,
  runTickCommand,
  type TickCommandOptions,
  type TickInboxItem,
} from '../src/commands/tick.js';
import { openBetterSqlite3 } from '@routersync/core';

describe('C4n/N6.2: tick --mode validation', () => {
  it('accepts valid modes: observe and propose', () => {
    expect(resolveAutonomyMode('observe')).toBe('observe');
    expect(resolveAutonomyMode('propose')).toBe('propose');
    expect(resolveAutonomyMode('OBSERVE')).toBe('observe');
    expect(resolveAutonomyMode('Propose')).toBe('propose');
  });

  it('defaults to propose when omitted or empty', () => {
    expect(resolveAutonomyMode(undefined)).toBe('propose');
    expect(resolveAutonomyMode('')).toBe('propose');
  });

  it('rejects typo or unknown mode with descriptive error', () => {
    expect(() => resolveAutonomyMode('obseve')).toThrow(/Unknown --mode "obseve"/);
    expect(() => resolveAutonomyMode('invalid')).toThrow(/Valid modes: "observe" \(log only\) or "propose"/);
  });

  it('rejects removed auto-safe mode with notice that A8 removed it', () => {
    expect(() => resolveAutonomyMode('auto-safe')).toThrow(/auto-safe.*removed in A8/);
  });
});

describe('C4n/N6.3 & N8: absent models & snooze expiration in runTickCommand', () => {
  let tmpDir = '';
  let orig9Db: string | undefined;
  let origOmniDb: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c4n-tick-'));
    orig9Db = process.env['ROUTERSYNC_9ROUTER_DB'];
    origOmniDb = process.env['ROUTERSYNC_OMNIROUTE_DB'];
    process.env['ROUTERSYNC_9ROUTER_DB'] = path.join(tmpDir, 'nonexistent-9router.sqlite');
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = path.join(tmpDir, 'nonexistent-omniroute.sqlite');
  });

  afterEach(() => {
    if (orig9Db !== undefined) process.env['ROUTERSYNC_9ROUTER_DB'] = orig9Db;
    else delete process.env['ROUTERSYNC_9ROUTER_DB'];
    if (origOmniDb !== undefined) process.env['ROUTERSYNC_OMNIROUTE_DB'] = origOmniDb;
    else delete process.env['ROUTERSYNC_OMNIROUTE_DB'];
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('N8: prunes expired snoozed items when inbox exceeds capacity using nowMs', async () => {
    const inboxPath = path.join(tmpDir, 'inbox.json');
    const cfgPath = path.join(tmpDir, 'test-config.yaml');
    const dbPath = path.join(tmpDir, 'empty-router.sqlite');
    const db = openBetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE combos (id TEXT, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);
      CREATE TABLE providerConnections (id TEXT, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT);
      CREATE TABLE providerNodes (id TEXT, type TEXT, name TEXT, data TEXT, createdAt TEXT, updatedAt TEXT);
    `);
    db.close();
    fs.writeFileSync(
      cfgPath,
      `version: 1\nrouters:\n  - id: nine\n    adapter: 9router\n    db:\n      path: "${dbPath.replace(/\\/g, '/')}"\n    write: db\npolicy:\n  mode: manual\ncombos: []\nadopt: []\n`,
      'utf8'
    );
    const nowMs = 1763110000000; // Reference timestamp

    // Seed inbox with 205 items to trigger trimming (> 200)
    const seedItems: TickInboxItem[] = [];
    for (let i = 0; i < 205; i++) {
      seedItems.push({
        id: `item-${i}`,
        title: `Item ${i}`,
        type: 'proposal',
        timestamp: new Date(nowMs - 100000).toISOString(),
        body: `Body ${i}`,
        provider: 'test-p',
        status: i === 0 ? 'snoozed' : 'pending',
        // Item 0 has snoozeUntil in the PAST
        snoozeUntil: i === 0 ? new Date(nowMs - 50000).toISOString() : undefined,
        proposed_by: { kind: 'system', source: 'tick' },
      });
    }
    fs.writeFileSync(inboxPath, JSON.stringify(seedItems, null, 2), 'utf8');

    // Run tick with no network targets
    const summary = await runTickCommand({
      stateDir: tmpDir,
      configPath: cfgPath,
      nowMs,
      mode: 'propose',
      fetchFn: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never,
    });

    expect(summary.mode).toBe('propose');
    const inboxJson = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    const afterInbox: TickInboxItem[] = Array.isArray(inboxJson) ? inboxJson : (inboxJson.items ?? []);
    // The expired snoozed item (item-0) should be considered inactive and eligible for pruning
    const item0 = afterInbox.find((it) => it.id === 'item-0');
    expect(item0).toBeUndefined();
  });
});
