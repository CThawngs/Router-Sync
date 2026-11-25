/**
 * packages/core/src/cost/cost-ledger.ts
 *
 * C45-WP8 (`Phục vụ: S7`): Atomic Token & Network Cost Ledger (`<stateDir>/cost-ledger.json`)
 * and Weekly Tier-1 Agent Research Session Cap (`DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS = 5`).
 *
 * Invariants:
 *  - `readCostLedgerReadOnly` and `computeWeeklyResearchBudget` perform ZERO disk writes
 *    (preserving `READ_ONLY_TOOL_NAMES` invariants for `cost_report` and `research_queue`).
 *  - Every Tier-0 deterministic tick entry hard-locks `tokens: 0`, `llmCalls: 0`, `paidRequests: 0`.
 *  - Bounded ring buffers: `ticks` <= 1000 entries, `researchSessions` <= 500 entries.
 *  - Persists exclusively via `atomicWriteFileSync`.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';
import { containsSecretLikeContent, safeDecodeUriText } from '../domain/sanitize.js';
import { ResearchValidationError } from '../research/domain-registry.js';

export const COST_LEDGER_FILENAME = 'cost-ledger.json';
export const DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS = 5;
export const MAX_TICK_LEDGER_ENTRIES = 1000;
export const MAX_RESEARCH_SESSION_ENTRIES = 500;

export interface TickLedgerEntry {
  kind: 'tier0_tick';
  id: string;
  timestamp: string;
  isoWeek: string;
  mode: 'observe' | 'propose' | 'auto-safe';
  tokens: 0;
  llmCalls: 0;
  paidRequests: 0;
  totalHttpRequests: number;
  domainRequests: Record<string, number>;
}

export interface ResearchSessionLedgerEntry {
  kind: 'tier1_research_session';
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  isoWeek: string;
  source: 'mcp' | 'cli';
  toolCallsCount: number;
  returnedTextBytes: number;
  returnedTextChars: number;
  submittedTextBytes: number;
  submittedTextChars: number;
  findingsSubmitted: number;
}

export interface CostLedgerFile {
  schemaVersion: 1;
  updatedAt: string;
  ticks: TickLedgerEntry[];
  researchSessions: ResearchSessionLedgerEntry[];
}

export interface WeeklyResearchBudget {
  isoWeek: string;
  usedSessions: number;
  maxWeeklyResearchSessions: number;
  remainingSessions: number;
  budgetExceeded: boolean;
}

export class CostBudgetError extends Error {
  readonly code = 'WEEKLY_RESEARCH_CAP_EXCEEDED' as const;
  readonly budget: WeeklyResearchBudget;

  constructor(message: string, budget: WeeklyResearchBudget) {
    super(`WEEKLY_RESEARCH_CAP_EXCEEDED: ${message}`);
    this.name = 'CostBudgetError';
    this.budget = budget;
  }
}

/**
 * Computes canonical UTC ISO-8601 week identifier (e.g. `"2026-W48"`).
 */
export function getUtcIsoWeek(input: Date | number | string = Date.now()): string {
  const rawDate = input instanceof Date ? input : new Date(input);
  const ms = rawDate.getTime();
  const safeDate = Number.isFinite(ms) ? rawDate : new Date();

  const target = new Date(
    Date.UTC(safeDate.getUTCFullYear(), safeDate.getUTCMonth(), safeDate.getUTCDate())
  );
  // ISO week starts Monday (1..7); shift to nearest Thursday
  const dayNr = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNr);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Computes previous `count` UTC ISO weeks ending at `anchorMs` (most recent first).
 */
export function listRecentUtcIsoWeeks(
  count: number = 4,
  anchorMs: number = Date.now()
): string[] {
  const clamped = Math.max(1, Math.min(12, Math.floor(count)));
  const weeks: string[] = [];
  const seen = new Set<string>();
  let cursorMs = anchorMs;
  while (weeks.length < clamped) {
    const w = getUtcIsoWeek(cursorMs);
    if (!seen.has(w)) {
      seen.add(w);
      weeks.push(w);
    }
    cursorMs -= 7 * 24 * 60 * 60 * 1000;
  }
  return weeks;
}

export function resolveMaxWeeklyResearchSessions(
  configCap?: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  const rawEnv = env['ROUTERSYNC_MAX_WEEKLY_RESEARCH_SESSIONS'];
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv.trim());
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000) {
      return parsed;
    }
  }
  if (
    typeof configCap === 'number' &&
    Number.isInteger(configCap) &&
    configCap >= 0 &&
    configCap <= 1000
  ) {
    return configCap;
  }
  return DEFAULT_MAX_WEEKLY_RESEARCH_SESSIONS;
}

function emptyCostLedger(): CostLedgerFile {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    ticks: [],
    researchSessions: [],
  };
}

/**
 * Strictly read-only load of `<stateDir>/cost-ledger.json`.
 * Creates ZERO files or directories when absent or corrupt.
 */
export function readCostLedgerReadOnly(stateDir: string): CostLedgerFile {
  const ledgerPath = path.join(stateDir, COST_LEDGER_FILENAME);
  try {
    if (!fs.existsSync(ledgerPath)) {
      return emptyCostLedger();
    }
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CostLedgerFile>;
    if (!parsed || typeof parsed !== 'object') {
      return emptyCostLedger();
    }
    const ticks = Array.isArray(parsed.ticks)
      ? parsed.ticks.filter(
          (t): t is TickLedgerEntry =>
            Boolean(t && typeof t === 'object' && t.kind === 'tier0_tick')
        )
      : [];
    const researchSessions = Array.isArray(parsed.researchSessions)
      ? parsed.researchSessions.filter(
          (s): s is ResearchSessionLedgerEntry =>
            Boolean(s && typeof s === 'object' && s.kind === 'tier1_research_session')
        )
      : [];
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      ticks,
      researchSessions,
    };
  } catch {
    return emptyCostLedger();
  }
}

function saveCostLedgerAtomic(stateDir: string, ledger: CostLedgerFile): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const ledgerPath = path.join(stateDir, COST_LEDGER_FILENAME);
  atomicWriteFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Computes weekly Tier-1 research session budget strictly read-only (`0` writes).
 */
export function computeWeeklyResearchBudget(
  stateDir: string,
  options: {
    nowMs?: number | undefined;
    isoWeek?: string | undefined;
    maxWeeklyResearchSessions?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {}
): WeeklyResearchBudget {
  const isoWeek = options.isoWeek ?? getUtcIsoWeek(options.nowMs ?? Date.now());
  const maxSessions = resolveMaxWeeklyResearchSessions(
    options.maxWeeklyResearchSessions,
    options.env
  );
  const ledger = readCostLedgerReadOnly(stateDir);
  const distinctIds = new Set(
    ledger.researchSessions
      .filter((s) => s.isoWeek === isoWeek)
      .map((s) => s.sessionId)
  );
  const usedSessions = distinctIds.size;
  const remainingSessions = Math.max(0, maxSessions - usedSessions);
  const budgetExceeded = usedSessions >= maxSessions;

  return {
    isoWeek,
    usedSessions,
    maxWeeklyResearchSessions: maxSessions,
    remainingSessions,
    budgetExceeded,
  };
}

/**
 * Verifies whether a `submit_research` / `research submit` call is allowed under
 * the current ISO week's session cap BEFORE any finding is written to disk.
 */
export function assertWeeklyResearchSessionAllowed(
  stateDir: string,
  options: {
    sessionId?: string | undefined;
    nowMs?: number | undefined;
    maxWeeklyResearchSessions?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  } = {}
): { sessionId: string; isoWeek: string; isExistingSession: boolean; budget: WeeklyResearchBudget } {
  const nowMs = options.nowMs ?? Date.now();
  const isoWeek = getUtcIsoWeek(nowMs);
  if (
    typeof options.sessionId === 'string' &&
    (containsSecretLikeContent(options.sessionId) ||
      containsSecretLikeContent(safeDecodeUriText(options.sessionId)))
  ) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research sessionId contains secret or API-key-like material and was rejected.'
    );
  }
  const cleanSessionId =
    typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim().slice(0, 128)
      : `auto-${isoWeek}-${randomUUID().slice(0, 12)}`;
  if (containsSecretLikeContent(cleanSessionId)) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research sessionId contains secret or API-key-like material and was rejected.'
    );
  }

  const ledger = readCostLedgerReadOnly(stateDir);
  const isExistingSession = ledger.researchSessions.some(
    (s) => s.isoWeek === isoWeek && s.sessionId === cleanSessionId
  );
  const budget = computeWeeklyResearchBudget(stateDir, {
    nowMs,
    isoWeek,
    maxWeeklyResearchSessions: options.maxWeeklyResearchSessions,
    env: options.env,
  });

  if (!isExistingSession && budget.usedSessions >= budget.maxWeeklyResearchSessions) {
    throw new CostBudgetError(
      `Weekly research session cap reached for ${isoWeek} (${budget.usedSessions}/${budget.maxWeeklyResearchSessions} sessions used). Wait until next ISO week or pass an active sessionId from ${isoWeek}.`,
      budget
    );
  }

  return { sessionId: cleanSessionId, isoWeek, isExistingSession, budget };
}

export function appendTickCostEntry(
  stateDir: string,
  input: {
    id?: string | undefined;
    timestamp?: string | undefined;
    nowMs?: number | undefined;
    mode: 'observe' | 'propose' | 'auto-safe';
    totalHttpRequests: number;
    domainRequests: Record<string, number>;
  }
): TickLedgerEntry {
  const nowMs = input.nowMs ?? (input.timestamp ? Date.parse(input.timestamp) : Date.now());
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timestamp = input.timestamp ?? new Date(safeNowMs).toISOString();
  const isoWeek = getUtcIsoWeek(safeNowMs);

  const normalizedDomains: Record<string, number> = {};
  for (const [rawHost, count] of Object.entries(input.domainRequests)) {
    const cleanHost = rawHost.trim().toLowerCase();
    if (!cleanHost || !Number.isFinite(count) || count <= 0) continue;
    normalizedDomains[cleanHost] = (normalizedDomains[cleanHost] ?? 0) + Math.floor(count);
  }

  const entry: TickLedgerEntry = {
    kind: 'tier0_tick',
    id: input.id ?? `tick-${safeNowMs}-${randomUUID().slice(0, 8)}`,
    timestamp,
    isoWeek,
    mode: input.mode,
    tokens: 0,
    llmCalls: 0,
    paidRequests: 0,
    totalHttpRequests: Math.max(0, Math.floor(input.totalHttpRequests)),
    domainRequests: normalizedDomains,
  };

  const ledger = readCostLedgerReadOnly(stateDir);
  const nextTicks = [...ledger.ticks, entry];
  if (nextTicks.length > MAX_TICK_LEDGER_ENTRIES) {
    nextTicks.splice(0, nextTicks.length - MAX_TICK_LEDGER_ENTRIES);
  }

  saveCostLedgerAtomic(stateDir, {
    schemaVersion: 1,
    updatedAt: timestamp,
    ticks: nextTicks,
    researchSessions: ledger.researchSessions,
  });

  return entry;
}

export function recordResearchSessionActivity(
  stateDir: string,
  input: {
    sessionId?: string | undefined;
    source: 'mcp' | 'cli';
    nowMs?: number | undefined;
    maxWeeklyResearchSessions?: number | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    submittedPayload: string;
    returnedPayload: string;
    findingsDelta?: number | undefined;
  }
): ResearchSessionLedgerEntry {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const check = assertWeeklyResearchSessionAllowed(stateDir, {
    sessionId: input.sessionId,
    nowMs,
    maxWeeklyResearchSessions: input.maxWeeklyResearchSessions,
    env: input.env,
  });

  const subStr = String(input.submittedPayload ?? '');
  const retStr = String(input.returnedPayload ?? '');
  const subBytes = Buffer.byteLength(subStr, 'utf8');
  const subChars = subStr.length;
  const retBytes = Buffer.byteLength(retStr, 'utf8');
  const retChars = retStr.length;
  const findingsDelta = Math.max(0, Math.floor(input.findingsDelta ?? 1));

  const ledger = readCostLedgerReadOnly(stateDir);
  const nextSessions = [...ledger.researchSessions];
  const existingIdx = nextSessions.findIndex(
    (s) => s.isoWeek === check.isoWeek && s.sessionId === check.sessionId
  );

  let targetEntry: ResearchSessionLedgerEntry;
  if (existingIdx >= 0) {
    const prev = nextSessions[existingIdx]!;
    targetEntry = {
      ...prev,
      updatedAt: nowIso,
      toolCallsCount: prev.toolCallsCount + 1,
      submittedTextBytes: prev.submittedTextBytes + subBytes,
      submittedTextChars: prev.submittedTextChars + subChars,
      returnedTextBytes: prev.returnedTextBytes + retBytes,
      returnedTextChars: prev.returnedTextChars + retChars,
      findingsSubmitted: prev.findingsSubmitted + findingsDelta,
    };
    nextSessions[existingIdx] = targetEntry;
  } else {
    targetEntry = {
      kind: 'tier1_research_session',
      sessionId: check.sessionId,
      startedAt: nowIso,
      updatedAt: nowIso,
      isoWeek: check.isoWeek,
      source: input.source,
      toolCallsCount: 1,
      submittedTextBytes: subBytes,
      submittedTextChars: subChars,
      returnedTextBytes: retBytes,
      returnedTextChars: retChars,
      findingsSubmitted: findingsDelta,
    };
    nextSessions.push(targetEntry);
    if (nextSessions.length > MAX_RESEARCH_SESSION_ENTRIES) {
      nextSessions.splice(0, nextSessions.length - MAX_RESEARCH_SESSION_ENTRIES);
    }
  }

  saveCostLedgerAtomic(stateDir, {
    schemaVersion: 1,
    updatedAt: nowIso,
    ticks: ledger.ticks,
    researchSessions: nextSessions,
  });

  return targetEntry;
}
