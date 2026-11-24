/**
 * packages/mcp-server/src/cost-report.ts
 *
 * C45-WP8 Read-Only MCP Tool `cost_report` (Phục vụ: S7):
 *  - Strictly read-only: NEVER creates `<stateDir>` or mutates any file on disk.
 *  - Reports Tier-0 deterministic tick HTTP/domain accounting (`tokens: 0`, `llmCalls: 0`,
 *    `paidRequests: 0`) and Tier-1 weekly research session usage against `maxWeeklyResearchSessions`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  getUtcIsoWeek,
  listRecentUtcIsoWeeks,
  readCostLedgerReadOnly,
  resolveMaxWeeklyResearchSessions,
  type CostLedgerFile,
} from '@routersync/core';
import { sanitizeObject } from './sanitize.js';
import { resolveStatePaths } from './state.js';

export interface WeeklyCostSummary {
  isoWeek: string;
  tier0Ticks: number;
  tier0Tokens: 0;
  tier0LlmCalls: 0;
  tier0PaidRequests: 0;
  totalHttpRequests: number;
  domainRequests: Record<string, number>;
  tier1ResearchSessionsUsed: number;
  tier1ResearchSessionsRemaining: number;
  budgetExceeded: boolean;
  tier1ToolCalls: number;
  tier1ReturnedTextBytes: number;
  tier1ReturnedTextChars: number;
  tier1SubmittedTextBytes: number;
  tier1SubmittedTextChars: number;
  findingsSubmitted: number;
}

export interface CostReportSummary {
  currentIsoWeek: string;
  maxWeeklyResearchSessions: number;
  currentWeek: WeeklyCostSummary;
  weeklyHistory: WeeklyCostSummary[];
}

export interface CostReportToolOptions {
  configPath?: string | undefined;
  resolveNowMs?: (() => number) | undefined;
}

export function readConfiguredMaxWeeklySessionsReadOnly(configPath?: string): number {
  const candidates: string[] = [];
  if (configPath) candidates.push(path.resolve(configPath));
  if (process.env['ROUTERSYNC_CONFIG']) {
    candidates.push(path.resolve(process.env['ROUTERSYNC_CONFIG']));
  }
  const home = process.env['ROUTERSYNC_HOME'] || os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'routersync', 'config.yaml'));
  } else {
    const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
    candidates.push(path.join(xdg, 'routersync', 'config.yaml'));
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = parseYaml(fs.readFileSync(candidate, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const research = (parsed as Record<string, unknown>)['research'];
        if (research && typeof research === 'object' && !Array.isArray(research)) {
          const cap = (research as Record<string, unknown>)['maxWeeklyResearchSessions'];
          if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 0) {
            return resolveMaxWeeklyResearchSessions(cap);
          }
        }
      }
      break;
    } catch {
      // Read-only best-effort fallback
    }
  }
  return resolveMaxWeeklyResearchSessions(undefined);
}

function summarizeSingleIsoWeek(
  ledger: CostLedgerFile,
  isoWeek: string,
  maxWeeklyResearchSessions: number
): WeeklyCostSummary {
  const weekTicks = ledger.ticks.filter((t) => t.isoWeek === isoWeek);
  const domainRequests: Record<string, number> = {};
  let totalHttpRequests = 0;
  for (const tick of weekTicks) {
    totalHttpRequests += tick.totalHttpRequests;
    for (const [host, count] of Object.entries(tick.domainRequests ?? {})) {
      domainRequests[host] = (domainRequests[host] ?? 0) + count;
    }
  }

  const weekSessions = ledger.researchSessions.filter((s) => s.isoWeek === isoWeek);
  const distinctSessionIds = new Set(weekSessions.map((s) => s.sessionId));
  const used = distinctSessionIds.size;
  const remaining = Math.max(0, maxWeeklyResearchSessions - used);

  let tier1ToolCalls = 0;
  let tier1ReturnedTextBytes = 0;
  let tier1ReturnedTextChars = 0;
  let tier1SubmittedTextBytes = 0;
  let tier1SubmittedTextChars = 0;
  let findingsSubmitted = 0;

  for (const s of weekSessions) {
    tier1ToolCalls += s.toolCallsCount;
    tier1ReturnedTextBytes += s.returnedTextBytes;
    tier1ReturnedTextChars += s.returnedTextChars;
    tier1SubmittedTextBytes += s.submittedTextBytes;
    tier1SubmittedTextChars += s.submittedTextChars;
    findingsSubmitted += s.findingsSubmitted;
  }

  return {
    isoWeek,
    tier0Ticks: weekTicks.length,
    tier0Tokens: 0,
    tier0LlmCalls: 0,
    tier0PaidRequests: 0,
    totalHttpRequests,
    domainRequests,
    tier1ResearchSessionsUsed: used,
    tier1ResearchSessionsRemaining: remaining,
    budgetExceeded: used >= maxWeeklyResearchSessions,
    tier1ToolCalls,
    tier1ReturnedTextBytes,
    tier1ReturnedTextChars,
    tier1SubmittedTextBytes,
    tier1SubmittedTextChars,
    findingsSubmitted,
  };
}

export function computeCostReportPayload(options: {
  stateDir: string;
  configPath?: string | undefined;
  nowMs?: number | undefined;
  isoWeek?: string | undefined;
  weeksBack?: number | undefined;
}): CostReportSummary {
  const nowMs = options.nowMs ?? Date.now();
  const maxWeeklyResearchSessions = readConfiguredMaxWeeklySessionsReadOnly(options.configPath);
  // Strictly read-only: NEVER creates stateDir or writes any file
  const ledger = readCostLedgerReadOnly(options.stateDir);
  const currentIsoWeek = options.isoWeek ?? getUtcIsoWeek(nowMs);
  const weeksBack = Math.max(1, Math.min(12, Math.trunc(options.weeksBack ?? 4)));
  const recentWeeks = listRecentUtcIsoWeeks(weeksBack, nowMs);
  if (options.isoWeek && !recentWeeks.includes(options.isoWeek)) {
    recentWeeks[0] = options.isoWeek;
  }

  const currentWeek = summarizeSingleIsoWeek(
    ledger,
    currentIsoWeek,
    maxWeeklyResearchSessions
  );
  const weeklyHistory = recentWeeks.map((week) =>
    summarizeSingleIsoWeek(ledger, week, maxWeeklyResearchSessions)
  );

  return {
    currentIsoWeek,
    maxWeeklyResearchSessions,
    currentWeek,
    weeklyHistory,
  };
}

export function registerCostReportTool(
  server: McpServer,
  options: CostReportToolOptions = {}
): void {
  server.tool(
    'cost_report',
    'Reads <stateDir>/cost-ledger.json strictly read-only (zero disk writes) and reports Tier-0 zero-token tick HTTP domain counts plus Tier-1 weekly research session budget usage',
    {
      isoWeek: z
        .string()
        .regex(/^\d{4}-W\d{2}$/)
        .optional()
        .describe('Optional target UTC ISO-8601 week (e.g. 2026-W48); defaults to current UTC week'),
      weeksBack: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Number of historical ISO weeks to include in weeklyHistory (1..12, default 4)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const nowMs = options.resolveNowMs ? options.resolveNowMs() : Date.now();
      const report = computeCostReportPayload({
        stateDir: paths.stateDir,
        configPath: options.configPath,
        nowMs,
        isoWeek: args.isoWeek,
        weeksBack: args.weeksBack ?? 4,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(sanitizeObject(report), null, 2),
          },
        ],
      };
    }
  );
}
