/**
 * packages/core/test/wp8-cost-ledger.test.ts
 *
 * C45-WP8 Red-First Unit Tests (Phục vụ: S7):
 *  - Atomic `<stateDir>/cost-ledger.json` persistence with zero leftover `.tmp` files
 *  - Zero-write `readCostLedgerReadOnly` & `computeWeeklyResearchBudget`
 *  - ISO-8601 UTC week bucketing (`YYYY-Www`) & ring-buffer caps (1000 ticks, 500 sessions)
 *  - Multi-call `sessionId` aggregation (UTF-8 byte & char metrics)
 *  - Hard `maxWeeklyResearchSessions` cap (default = 5, 6th session rejected, 0-cap edge case)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CostBudgetError,
  DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS,
  MAX_RESEARCH_SESSION_ENTRIES,
  MAX_TICK_LEDGER_ENTRIES,
  appendTickCostEntry,
  assertWeeklyResearchSessionAllowed,
  computeWeeklyResearchBudget,
  getUtcIsoWeek,
  readCostLedgerReadOnly,
  recordResearchSessionActivity,
} from '../src/index.js';

describe('C45-WP8: Atomic Cost Ledger & Weekly Research Cap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp8-ledger-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes deterministic UTC ISO-8601 week identifiers', () => {
    expect(getUtcIsoWeek('2026-11-24T12:00:00.000Z')).toBe('2026-W48');
    expect(getUtcIsoWeek('2026-01-01T00:00:00.000Z')).toBe('2026-W01');
  });

  it('reads missing stateDir completely read-only without creating directories or files', () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    const ledger = readCostLedgerReadOnly(missingDir);
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.ticks).toEqual([]);
    expect(ledger.researchSessions).toEqual([]);

    const budget = computeWeeklyResearchBudget(missingDir, {
      nowMs: Date.parse('2026-11-24T12:00:00.000Z'),
    });
    expect(budget).toEqual({
      isoWeek: '2026-W48',
      usedSessions: 0,
      maxWeeklyResearchSessions: DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS,
      remainingSessions: 5,
      budgetExceeded: false,
    });
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  it('appends Tier-0 tick entries atomically with hard 0-token invariants and 1000-entry ring buffer', () => {
    expect(MAX_TICK_LEDGER_ENTRIES).toBe(1000);
    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');

    const preseededTicks = Array.from({ length: 998 }, (_, i) => ({
      kind: 'tier0_tick' as const,
      id: `tick-${i}`,
      timestamp: new Date(baseMs + i * 1000).toISOString(),
      isoWeek: '2026-W48',
      mode: 'observe' as const,
      tokens: 0 as const,
      llmCalls: 0 as const,
      paidRequests: 0 as const,
      totalHttpRequests: 2,
      domainRequests: { 'models.dev': 1, 'openrouter.ai': 1 },
    }));
    fs.writeFileSync(
      path.join(tmpDir, 'cost-ledger.json'),
      JSON.stringify({ schemaVersion: 1, updatedAt: new Date(baseMs).toISOString(), ticks: preseededTicks, researchSessions: [] }),
      'utf8'
    );
    for (let i = 998; i < 1005; i++) {
      const entry = appendTickCostEntry(tmpDir, {
        id: `tick-${i}`,
        nowMs: baseMs + i * 1000,
        mode: 'observe',
        totalHttpRequests: 2,
        domainRequests: { 'openrouter.ai': 1, 'models.dev': 1 },
      });
      expect(entry.tokens).toBe(0);
      expect(entry.llmCalls).toBe(0);
      expect(entry.paidRequests).toBe(0);
    }

    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['cost-ledger.json']);

    const persisted = readCostLedgerReadOnly(tmpDir);
    expect(persisted.ticks).toHaveLength(1000);
    expect(persisted.ticks[0]?.id).toBe('tick-5');
    expect(persisted.ticks[999]?.id).toBe('tick-1004');
  });

  it('aggregates same-sessionId calls and enforces exact maxWeeklyResearchSessions=5 cap (kills M6)', () => {
    expect(DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS).toBe(5);
    expect(MAX_RESEARCH_SESSION_ENTRIES).toBe(500);
    const week1Ms = Date.parse('2026-11-24T12:00:00.000Z'); // 2026-W48

    // Two calls sharing sessionId="sess-1" count as ONE session and sum UTF-8 bytes vs chars
    const vnSubmitted = '{"quote":"Bằng chứng ngừng hỗ trợ chính thức"}';
    const vnReturned = '{"accepted":true}';
    const s1a = recordResearchSessionActivity(tmpDir, {
      sessionId: 'sess-1',
      source: 'mcp',
      nowMs: week1Ms,
      submittedPayload: vnSubmitted,
      returnedPayload: vnReturned,
      findingsDelta: 1,
    });
    expect(s1a.toolCallsCount).toBe(1);
    expect(s1a.submittedTextBytes).toBe(Buffer.byteLength(vnSubmitted, 'utf8'));
    expect(s1a.submittedTextChars).toBe(vnSubmitted.length);
    expect(s1a.submittedTextBytes).toBeGreaterThan(s1a.submittedTextChars);

    const s1b = recordResearchSessionActivity(tmpDir, {
      sessionId: 'sess-1',
      source: 'mcp',
      nowMs: week1Ms + 10_000,
      submittedPayload: vnSubmitted,
      returnedPayload: vnReturned,
      findingsDelta: 1,
    });
    expect(s1b.toolCallsCount).toBe(2);
    expect(s1b.findingsSubmitted).toBe(2);
    expect(s1b.submittedTextBytes).toBe(Buffer.byteLength(vnSubmitted, 'utf8') * 2);

    // Fill remaining 4 sessions (sess-2 .. sess-5 -> total 5 sessions in 2026-W48)
    for (let idx = 2; idx <= 5; idx++) {
      recordResearchSessionActivity(tmpDir, {
        sessionId: `sess-${idx}`,
        source: 'mcp',
        nowMs: week1Ms + idx * 60_000,
        submittedPayload: '{}',
        returnedPayload: '{}',
        findingsDelta: 1,
      });
    }

    const atCapBudget = computeWeeklyResearchBudget(tmpDir, { nowMs: week1Ms });
    expect(atCapBudget.usedSessions).toBe(5);
    expect(atCapBudget.remainingSessions).toBe(0);
    expect(atCapBudget.budgetExceeded).toBe(true);

    // Existing session "sess-5" in the same week can still record follow-up call
    expect(() =>
      assertWeeklyResearchSessionAllowed(tmpDir, { sessionId: 'sess-5', nowMs: week1Ms })
    ).not.toThrow();

    // 6th new session MUST throw CostBudgetError('WEEKLY_RESEARCH_CAP_EXCEEDED') (kills M6 > vs >=)
    const beforeRaw = fs.readFileSync(path.join(tmpDir, 'cost-ledger.json'), 'utf8');
    expect(() =>
      assertWeeklyResearchSessionAllowed(tmpDir, { sessionId: 'sess-6', nowMs: week1Ms })
    ).toThrow(CostBudgetError);
    expect(() =>
      recordResearchSessionActivity(tmpDir, {
        sessionId: 'sess-6',
        source: 'mcp',
        nowMs: week1Ms + 600_000,
        submittedPayload: '{}',
        returnedPayload: '{}',
        findingsDelta: 1,
      })
    ).toThrow(/WEEKLY_RESEARCH_CAP_EXCEEDED/);
    expect(fs.readFileSync(path.join(tmpDir, 'cost-ledger.json'), 'utf8')).toBe(beforeRaw);

    // Next ISO week resets weekly session allowance cleanly
    const week2Ms = week1Ms + 7 * 24 * 60 * 60 * 1000;
    const sNextWeek = recordResearchSessionActivity(tmpDir, {
      sessionId: 'sess-6',
      source: 'cli',
      nowMs: week2Ms,
      submittedPayload: '{"id":"openai/gpt-4"}',
      returnedPayload: '{"ok":true}',
      findingsDelta: 1,
    });
    expect(sNextWeek.isoWeek).not.toBe('2026-W48');
    expect(computeWeeklyResearchBudget(tmpDir, { nowMs: week2Ms }).usedSessions).toBe(1);

    // 0-cap edge case blocks immediately
    expect(() =>
      assertWeeklyResearchSessionAllowed(tmpDir, {
        sessionId: 'zero-cap-sess',
        nowMs: week2Ms,
        maxWeeklyResearchSessions: 0,
      })
    ).toThrow(CostBudgetError);
  });
});
