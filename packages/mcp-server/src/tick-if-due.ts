/**
 * packages/mcp-server/src/tick-if-due.ts
 *
 * C45-WP7 Tier-3 MCP Gate Tool `tick_if_due` (Phục vụ: S6, S7):
 *  - Evaluates 15-minute `evaluateTickFreshness` gate (`<stateDir>/status.json`).
 *  - Acquires atomic `<stateDir>/tick.lock` (`tryAcquireTickLock`) to prevent duplicate concurrent ticks.
 *  - Spawns detached Tier-0 `routersync tick --mode observe` with zero `@routersync/cli` package dependency.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  LOCK_HANDOFF_NONCE_ENV,
  LOCK_HANDOFF_PARENT_PID_ENV,
  evaluateTickFreshness,
  generateTickLockHandoffNonce,
  releaseTickLock,
  tryAcquireTickLock,
  updateTickLockOwner,
} from '@routersync/core';
import { sanitizeObject } from './sanitize.js';
import { resolveStatePaths } from './state.js';

export type SpawnTickFn = (params: {
  execPath: string;
  args: string[];
  stateDir: string;
  configPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}) => { pid?: number | undefined; unref?: () => void };

export interface TickIfDueResult {
  triggered: boolean;
  reason: 'fresh' | 'locked' | 'missing_status' | 'stale_status' | 'spawn_unavailable';
  lastTickAt?: string | null | undefined;
  ageMinutes?: number | null | undefined;
  minIntervalMinutes?: number | undefined;
  holderPid?: number | null | undefined;
  pid?: number | null | undefined;
  mode?: 'observe' | undefined;
  tokensUsed?: 0 | undefined;
  error?: string | undefined;
}

export interface RunTickIfDueOptions {
  stateDir: string;
  minIntervalMinutes?: number | undefined;
  configPath?: string | undefined;
  nowMs?: number | undefined;
  spawnTickFn?: SpawnTickFn | undefined;
}

export function runTickIfDue(options: RunTickIfDueOptions): TickIfDueResult {
  const minIntervalMinutes = Math.max(1, Math.min(1440, Math.trunc(options.minIntervalMinutes ?? 15)));
  const nowMs = options.nowMs ?? Date.now();
  const gateMs = minIntervalMinutes * 60_000;

  const dueCheck = evaluateTickFreshness(options.stateDir, nowMs, gateMs);
  if (!dueCheck.due) {
    return {
      triggered: false,
      reason: 'fresh',
      lastTickAt: dueCheck.lastTickAt,
      ageMinutes:
        dueCheck.ageMs !== null ? Math.round((dueCheck.ageMs / 60_000) * 100) / 100 : null,
      minIntervalMinutes,
    };
  }

  const handoffNonce = generateTickLockHandoffNonce();
  const lock = tryAcquireTickLock(options.stateDir, process.pid, nowMs, undefined, {
    issueNonce: handoffNonce,
  });
  if (!lock.acquired) {
    return {
      triggered: false,
      reason: 'locked',
      holderPid: lock.holderPid,
      lastTickAt: dueCheck.lastTickAt,
    };
  }

  const cliEntry = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
  const cliArgs = [
    cliEntry,
    'tick',
    '--mode',
    'observe',
    '--state-dir',
    options.stateDir,
    ...(options.configPath ? ['--config', options.configPath] : []),
  ];

  try {
    if (!options.spawnTickFn && !fs.existsSync(cliEntry)) {
      releaseTickLock(options.stateDir, process.pid);
      return {
        triggered: false,
        reason: 'spawn_unavailable',
        error: `Compiled CLI entrypoint not found at ${cliEntry}`,
      };
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [LOCK_HANDOFF_PARENT_PID_ENV]: String(process.pid),
      [LOCK_HANDOFF_NONCE_ENV]: handoffNonce,
    };
    const child = options.spawnTickFn
      ? options.spawnTickFn({
          execPath: process.execPath,
          args: cliArgs,
          stateDir: options.stateDir,
          configPath: options.configPath,
          env: childEnv,
        })
      : spawn(process.execPath, cliArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: childEnv,
        });

    const childPid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null;
    if (childPid !== null) {
      updateTickLockOwner(options.stateDir, childPid, nowMs, {
        expectedPid: process.pid,
        expectedNonce: handoffNonce,
        preserveNonce: true,
      });
    } else {
      releaseTickLock(options.stateDir, process.pid);
    }

    child.unref?.();

    return {
      triggered: true,
      reason: dueCheck.reason === 'missing_status' ? 'missing_status' : 'stale_status',
      pid: childPid,
      mode: 'observe',
      tokensUsed: 0,
    };
  } catch (err) {
    releaseTickLock(options.stateDir, process.pid);
    return {
      triggered: false,
      reason: 'spawn_unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerTickIfDueTool(
  server: McpServer,
  options: {
    configPath?: string | undefined;
    resolveNowMs?: (() => number) | undefined;
    spawnTickFn?: SpawnTickFn | undefined;
  } = {}
): void {
  server.tool(
    'tick_if_due',
    'Tier-3 freshness-gated zero-token tick trigger: checks <stateDir>/status.json against minIntervalMinutes (default 15) and spawns a detached `routersync tick --mode observe` only when stale and unlocked',
    {
      minIntervalMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe('Minimum freshness interval in minutes before triggering an observe tick (1..1440, default 15)'),
    },
    async (args) => {
      const paths = resolveStatePaths();
      const nowMs = options.resolveNowMs ? options.resolveNowMs() : Date.now();
      const res = runTickIfDue({
        stateDir: paths.stateDir,
        minIntervalMinutes: args.minIntervalMinutes ?? 15,
        configPath: options.configPath,
        nowMs,
        spawnTickFn: options.spawnTickFn,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(sanitizeObject(res), null, 2),
          },
        ],
      };
    }
  );
}
