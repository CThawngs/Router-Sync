/**
 * packages/cli/test/wp8-tick-and-research-cost.test.ts
 *
 * C45-WP8 Red-First CLI Cost & Guard Integration Tests (Phục vụ: S7):
 *  - `runTickCommand` writes `<stateDir>/cost-ledger.json` with `tokens: 0`, `llmCalls: 0`,
 *    `paidRequests: 0`, and per-domain HTTP counts
 *  - `runTickCommand` blocks poisoned L2/L3 URLs (`UNLISTED_OUTBOUND_DOMAIN` / `FORBIDDEN_LLM_ENDPOINT`)
 *  - `runTickCommand` `--toast` console notification when proposals are recorded
 *  - `runResearchCommand` read-only `queue` budget reporting & `submit` 5-session weekly cap
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NINE_ROUTER_EXPECTED_APP_VERSION,
  OutboundGuardError,
  clearConfiguredRouterDbPaths,
  openBetterSqlite3,
  readCostLedgerReadOnly,
  setConfiguredRouterDbPaths,
} from '@routersync/core';
import { runTickCommand } from '../src/commands/tick.js';
import { runResearchCommand } from '../src/commands/research.js';
import { runL2Scan } from '../src/verify/l2-scanner.js';
import { runL3Scan } from '../src/verify/l3-scanner.js';

describe('C45-WP8: Tick Cost Accounting, Toast & CLI Research Weekly Cap', () => {
  let tmpDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp8-cli-cost-'));
    stateDir = path.join(tmpDir, 'state');
    const dbPath = path.join(tmpDir, 'nine.sqlite');
    const db = openBetterSqlite3(dbPath, {});
    db.exec('CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
    db.exec('CREATE TABLE keyValue (namespace TEXT, key TEXT, value TEXT)');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.exec(
      'CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT, name TEXT, authType TEXT, isActive INTEGER, apiKey TEXT, providerSpecificData TEXT, data TEXT)'
    );
    db.exec(
      'CREATE TABLE providerNodes (id TEXT PRIMARY KEY, data TEXT)'
    );
    db.exec(
      'CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, models TEXT, data TEXT, kind TEXT, sortOrder INTEGER, createdAt TEXT, updatedAt TEXT)'
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, name, authType, isActive, apiKey, providerSpecificData, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-groq',
      'groq',
      'groq',
      'apikey',
      1,
      'gsk_test_dummy',
      JSON.stringify({ baseUrl: 'https://api.groq.com/openai/v1' }),
      JSON.stringify({ apiKey: 'gsk_test_dummy', baseUrl: 'https://api.groq.com/openai/v1' })
    );
    db.prepare(
      'INSERT INTO combos (id, name, models, data, kind, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'c1',
      'Coder',
      JSON.stringify(['groq/llama-3.1-8b-instant', 'groq/gemma2-9b-it']),
      JSON.stringify({ models: ['groq/llama-3.1-8b-instant', 'groq/gemma2-9b-it'] }),
      null,
      0,
      '2026-11-24T00:00:00.000Z',
      '2026-11-24T00:00:00.000Z'
    );
    db.close();

    setConfiguredRouterDbPaths({
      '9router': dbPath,
      omniroute: path.join(tmpDir, 'isolated-omniroute.sqlite'),
    });

    configPath = path.join(tmpDir, 'routersync.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    isolated: true',
        '    db:',
        `      path: "${dbPath.replace(/\\/g, '/')}"`,
        'adopt:',
        '  - router: 9router',
        '    name: Coder',
        '    mode: full',
        'policy:',
        '  mode: manual',
        'research:',
        '  maxWeeklyResearchSessions: 5',
        '',
      ].join('\n'),
      'utf8'
    );
  });

  afterEach(() => {
    clearConfiguredRouterDbPaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records deterministic tier0_tick cost ledger entry with per-domain HTTP counts and prints --toast line', async () => {
    const mockFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.groq.com')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'llama-3.1-8b-instant' },
              { id: 'gemma2-9b-it' },
              { id: 'llama-99-brand-new-model' },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (url.includes('openrouter.ai/api/v1/models')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes('models.dev/api.json')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('<html></html>', { status: 200 });
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const summary = await runTickCommand({
        configPath,
        stateDir,
        homeDir: path.join(tmpDir, 'home'),
        mode: 'propose',
        toast: true,
        nowMs: Date.parse('2026-11-24T12:00:00.000Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(summary.tokens).toBe(0);
      expect(summary.llmCalls).toBe(0);
      expect(summary.paidRequests).toBe(0);
      expect(summary.inboxAdded).toBeGreaterThan(0);
      expect(logs.some((line) => line.includes('[routersync toast]'))).toBe(true);

      const ledger = readCostLedgerReadOnly(stateDir);
      expect(ledger.ticks).toHaveLength(1);
      const tickEntry = ledger.ticks[0]!;
      expect(tickEntry.kind).toBe('tier0_tick');
      expect(tickEntry.isoWeek).toBe('2026-W48');
      expect(tickEntry.tokens).toBe(0);
      expect(tickEntry.llmCalls).toBe(0);
      expect(tickEntry.paidRequests).toBe(0);
      expect(tickEntry.totalHttpRequests).toBeGreaterThanOrEqual(3);
      expect(tickEntry.domainRequests['api.groq.com']).toBe(1);
      expect(tickEntry.domainRequests['openrouter.ai']).toBeGreaterThanOrEqual(1);
      expect(tickEntry.domainRequests['models.dev']).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('rejects poisoned L2/L3/research URLs before invoking underlying fetch spy', async () => {
    const spyFetch = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(
      runL2Scan({
        stateDir,
        openRouterUrl: 'https://unlisted-evil.example/v1/models',
        fetchFn: spyFetch as unknown as typeof fetch,
      })
    ).rejects.toThrow(OutboundGuardError);

    await expect(
      runL2Scan({
        stateDir,
        openRouterUrl: 'https://openrouter.ai/api/v1/chat/completions',
        fetchFn: spyFetch as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN_LLM_ENDPOINT' });

    const poisonedSources = path.join(tmpDir, 'poisoned-sources.yaml');
    fs.writeFileSync(
      poisonedSources,
      [
        'version: 1',
        'sources:',
        '  - id: evil-feed',
        '    url: https://unlisted-evil.example/v1/models',
        '    loai: catalog',
        '    reliability: 0.9',
        '',
      ].join('\n'),
      'utf8'
    );

    await expect(
      runL3Scan({
        stateDir,
        sourcesFilePath: poisonedSources,
        fetchFn: spyFetch as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: 'UNLISTED_OUTBOUND_DOMAIN' });

    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('enforces 5-session weekly cap in CLI research submit and reports budgetExceeded read-only in research queue', async () => {
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    for (let i = 1; i <= 5; i++) {
      const f = path.join(tmpDir, `ev-${i}.json`);
      fs.writeFileSync(
        f,
        JSON.stringify({
          provider: 'openai',
          modelId: `gpt-4o-mini-${i}`,
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: `Model ${i} active`,
          sessionId: `cli-sess-${i}`,
        }),
        'utf8'
      );
      await runResearchCommand({
        subcommand: 'submit',
        file: f,
        stateDir,
        configPath,
        nowMs,
      });
    }

    // 6th distinct session in same week must fail with WEEKLY_RESEARCH_CAP_EXCEEDED and NOT append evidence
    const f6 = path.join(tmpDir, 'ev-6.json');
    fs.writeFileSync(
      f6,
      JSON.stringify({
        provider: 'openai',
        modelId: 'gpt-4o-mini-6',
        verdict: 'active',
        url: 'https://platform.openai.com/docs/models',
        quote: 'Should be blocked by weekly cap',
        sessionId: 'cli-sess-6',
      }),
      'utf8'
    );

    await expect(
      runResearchCommand({
        subcommand: 'submit',
        file: f6,
        stateDir,
        configPath,
        nowMs,
      })
    ).rejects.toThrow(/WEEKLY_RESEARCH_CAP_EXCEEDED/);

    const evidenceRecords = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'research-evidence.json'), 'utf8')
    ) as unknown[];
    expect(evidenceRecords).toHaveLength(5);

    // Read-only research queue reports WEEKLY_RESEARCH_CAP_EXCEEDED with zero disk writes
    const beforeFiles = fs.readdirSync(stateDir).sort();
    const queueLogs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      queueLogs.push(String(msg));
    });
    try {
      await runResearchCommand({ subcommand: 'queue', stateDir, configPath, nowMs, json: true });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(stateDir).sort()).toEqual(beforeFiles);
    const queuePayload = JSON.parse(queueLogs.join('\n')) as Record<string, any>;
    expect(queuePayload.skipReason).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
    expect(queuePayload.weeklyBudget.budgetExceeded).toBe(true);
  });
});
