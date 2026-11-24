/**
 * packages/mcp-server/test/wp7-wp8-mcp-schedule-and-cost.test.ts
 *
 * C45-WP7+WP8 Red-First MCP Server Tests (Phục vụ: S6, S7):
 *  - 29-tool 3-tier classification (`READ_ONLY_TOOL_NAMES` = 26, `LEDGER_APPEND_TOOL_NAMES` = 2, `CONTROLLED_WRITE_TOOL_NAMES` = 1)
 *  - `cost_report` strictly read-only (0 disk writes even when `<stateDir>` does not exist — kills M7)
 *  - `research_queue` strictly read-only when `budgetExceeded: true` (`skipReason: 'WEEKLY_RESEARCH_CAP_EXCEEDED'` — kills M7)
 *  - `submit_research` `sessionId` aggregation + 6th weekly session rejection (`WEEKLY_RESEARCH_CAP_EXCEEDED` — kills M6)
 *  - `tick_if_due` 15m freshness gate, lock contention, and detached `observe` spawn (kills M2)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTickCostEntry } from '@routersync/core';
import {
  ALL_MCP_TOOL_NAMES,
  CONTROLLED_WRITE_TOOL_NAMES,
  LEDGER_APPEND_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  createRouterSyncMcpServer,
} from '../src/index.js';

describe('C45-WP7+WP8: MCP tick_if_due, cost_report & Weekly Research Cap', () => {
  let tmpDir: string;
  let stateDir: string;
  let prevStateEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp78-mcp-'));
    stateDir = path.join(tmpDir, 'state');
    prevStateEnv = process.env['ROUTERSYNC_STATE_DIR'];
    process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
  });

  afterEach(() => {
    if (prevStateEnv === undefined) delete process.env['ROUTERSYNC_STATE_DIR'];
    else process.env['ROUTERSYNC_STATE_DIR'] = prevStateEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function openClient(
    opts: Parameters<typeof createRouterSyncMcpServer>[0] = {}
  ): Promise<{
    call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any }>;
    close: () => Promise<void>;
  }> {
    const server = createRouterSyncMcpServer(opts);
    const client = new Client({ name: 'wp78-test-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return {
      async call(name: string, args: Record<string, unknown> = {}) {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
        return { isError: Boolean(res.isError), data: JSON.parse(text) };
      },
      async close() {
        await client.close();
        await server.close();
      },
    };
  }

  it('registers 26 read-only + 2 ledger-append + 1 controlled-write = 29 total tools', () => {
    expect(READ_ONLY_TOOL_NAMES).toHaveLength(26);
    expect(READ_ONLY_TOOL_NAMES).toContain('cost_report');
    expect(LEDGER_APPEND_TOOL_NAMES).toEqual(['submit_research', 'tick_if_due']);
    expect(CONTROLLED_WRITE_TOOL_NAMES).toEqual(['apply_plan']);
    expect(ALL_MCP_TOOL_NAMES).toHaveLength(29);
  });

  it('cost_report creates ZERO files or directories when stateDir does not exist (kills M7)', async () => {
    expect(fs.existsSync(stateDir)).toBe(false);
    const conn = await openClient();
    try {
      const res = await conn.call('cost_report', { weeksBack: 4 });
      expect(res.isError).toBe(false);
      expect(res.data.maxWeeklyResearchSessions).toBe(5);
      expect(res.data.currentWeek.tier0Ticks).toBe(0);
      expect(res.data.currentWeek.tier0Tokens).toBe(0);
      expect(res.data.currentWeek.tier0LlmCalls).toBe(0);
      expect(res.data.currentWeek.tier0PaidRequests).toBe(0);
      expect(res.data.currentWeek.tier1ResearchSessionsUsed).toBe(0);
      expect(res.data.currentWeek.tier1ResearchSessionsRemaining).toBe(5);
      expect(res.data.weeklyHistory).toHaveLength(4);
      // Hard zero-write assertion
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it('tracks multi-call sessionId byte/char metrics, blocks 6th weekly session, and keeps research_queue read-only (kills M6 & M7)', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const nowIso = '2026-11-24T12:00:00.000Z';
    appendTickCostEntry(stateDir, {
      nowMs: Date.parse(nowIso),
      mode: 'observe',
      totalHttpRequests: 3,
      domainRequests: { 'openrouter.ai': 2, 'models.dev': 1 },
    });
    fs.writeFileSync(
      path.join(stateDir, 'research-queue.json'),
      JSON.stringify({
        version: 1,
        updatedAt: nowIso,
        items: [
          {
            queueId: 'openai/gpt-legacy',
            id: 'openai/gpt-legacy',
            prefix: 'openai',
            modelId: 'gpt-legacy',
            label: 'NGHI-NGỪNG',
            reasons: ['AMBIGUOUS_DEPRECATION'],
            missing: ['AMBIGUOUS_DEPRECATION'],
            targetsAffected: ['router:9router/coder'],
            firstQueuedAt: nowIso,
            updatedAt: nowIso,
            verifiedAt: nowIso,
          },
        ],
      }),
      'utf8'
    );

    const conn = await openClient({ nowMs: () => Date.parse(nowIso) });
    try {
      // Two calls with same sessionId="s-1" -> 1 session, toolCallsCount=2
      for (const m of ['gpt-4o-1', 'gpt-4o-2']) {
        const sub = await conn.call('submit_research', {
          provider: 'openai',
          modelId: m,
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: 'Official OpenAI documentation confirms active status.',
          sessionId: 's-1',
        });
        expect(sub.isError).toBe(false);
        expect(sub.data.accepted).toBe(true);
      }

      // Fill sessions s-2 .. s-5 (total 5 sessions)
      for (let i = 2; i <= 5; i++) {
        const sub = await conn.call('submit_research', {
          provider: 'openai',
          modelId: `gpt-model-${i}`,
          verdict: 'active',
          url: 'https://platform.openai.com/docs/models',
          quote: `Session ${i} quote`,
          sessionId: `s-${i}`,
        });
        expect(sub.isError).toBe(false);
      }

      // 6th session s-6 MUST be rejected with WEEKLY_RESEARCH_CAP_EXCEEDED (kills M6)
      const beforeEvidence = fs.readFileSync(path.join(stateDir, 'research-evidence.json'), 'utf8');
      const blocked = await conn.call('submit_research', {
        provider: 'openai',
        modelId: 'gpt-model-6',
        verdict: 'active',
        url: 'https://platform.openai.com/docs/models',
        quote: 'Should not be appended',
        sessionId: 's-6',
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.data.errorCode).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
      expect(fs.readFileSync(path.join(stateDir, 'research-evidence.json'), 'utf8')).toBe(
        beforeEvidence
      );

      // research_queue MUST return empty items + WEEKLY_RESEARCH_CAP_EXCEEDED with ZERO disk mutations (kills M7)
      const snapshotBeforeQueue = fs
        .readdirSync(stateDir)
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(stateDir, f), 'utf8')]);
      const qRes = await conn.call('research_queue', {});
      expect(qRes.isError).toBe(false);
      expect(qRes.data.items).toEqual([]);
      expect(qRes.data.skipReason).toBe('WEEKLY_RESEARCH_CAP_EXCEEDED');
      expect(qRes.data.weeklyBudget.budgetExceeded).toBe(true);
      expect(qRes.data.weeklyBudget.usedSessions).toBe(5);
      const snapshotAfterQueue = fs
        .readdirSync(stateDir)
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(stateDir, f), 'utf8')]);
      expect(snapshotAfterQueue).toEqual(snapshotBeforeQueue);

      // cost_report reflects exact tick + session totals with zero disk writes
      const report = await conn.call('cost_report', {});
      expect(report.isError).toBe(false);
      expect(report.data.currentWeek.tier0Ticks).toBe(1);
      expect(report.data.currentWeek.totalHttpRequests).toBe(3);
      expect(report.data.currentWeek.tier1ResearchSessionsUsed).toBe(5);
      expect(report.data.currentWeek.tier1ResearchSessionsRemaining).toBe(0);
      expect(report.data.currentWeek.budgetExceeded).toBe(true);
      expect(report.data.currentWeek.tier1ToolCalls).toBe(6);
      expect(report.data.currentWeek.findingsSubmitted).toBe(6);
      expect(report.data.currentWeek.tier1SubmittedTextBytes).toBeGreaterThan(0);
      expect(report.data.currentWeek.tier1ReturnedTextBytes).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });

  it('tick_if_due enforces 15m freshness gate, respects active tick.lock, and spawns detached observe tick when due (kills M2)', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const baseMs = Date.parse('2026-11-24T12:00:00.000Z');
    let currentNowMs = baseMs + 14 * 60_000 + 59_000; // 14m59s old

    fs.writeFileSync(
      path.join(stateDir, 'status.json'),
      JSON.stringify({ timestamp: new Date(baseMs).toISOString(), mode: 'observe' }),
      'utf8'
    );

    const spawnSpy = vi.fn(() => ({ pid: 65432, unref: vi.fn() }));
    const conn = await openClient({
      nowMs: () => currentNowMs,
      spawnTickFn: spawnSpy,
    });

    try {
      // 1) Fresh at 14m59s -> skipped, 0 spawns
      const fresh = await conn.call('tick_if_due', { minIntervalMinutes: 15 });
      expect(fresh.data.triggered).toBe(false);
      expect(fresh.data.reason).toBe('fresh');
      expect(spawnSpy).not.toHaveBeenCalled();

      // 2) Stale at 15m00s -> spawns detached observe tick and writes child PID into tick.lock
      currentNowMs = baseMs + 15 * 60_000;
      const triggered = await conn.call('tick_if_due', { minIntervalMinutes: 15 });
      expect(triggered.data.triggered).toBe(true);
      expect(triggered.data.mode).toBe('observe');
      expect(triggered.data.tokensUsed).toBe(0);
      expect(triggered.data.pid).toBe(65432);
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      // 3) Immediate second call while tick.lock is held by live process.pid -> locked, 0 duplicate spawns
      fs.writeFileSync(
        path.join(stateDir, 'tick.lock'),
        JSON.stringify({ pid: process.pid, startedAt: new Date(currentNowMs).toISOString() }),
        'utf8'
      );
      const locked = await conn.call('tick_if_due', { minIntervalMinutes: 15 });
      expect(locked.data.triggered).toBe(false);
      expect(locked.data.reason).toBe('locked');
      expect(locked.data.holderPid).toBe(process.pid);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await conn.close();
    }
  });
});
