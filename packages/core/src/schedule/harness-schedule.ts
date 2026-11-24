/**
 * packages/core/src/schedule/harness-schedule.ts
 *
 * C45-WP7 (`Phục vụ: S6, S7`): Canonical 4-Tier Schedule Ladder across all 9
 * AI coding harnesses, driven strictly by `loadHarnessMatrix()` (`harness-matrix.json`).
 *
 * Ladder Tiers:
 *  1. `harness-native`: ONLY harnesses with `scheduler.zeroTokenScriptCapable === true`
 *     (`hermes` via `no_agent: true` script cron; `antigravity` via `builtin: "schedule"` sidecar).
 *  2. `os-scheduler`: Windows Task Scheduler, macOS launchd, Linux systemd --user / cron.
 *  3. `tick-if-due`: MCP tool + opt-in MCP startup 15-minute freshness gate.
 *  4. `daemon`: Continuous local workstation / server scheduler (`routersync daemon`).
 *
 * Safety Prohibitions:
 *  - Never generates LLM prompt routines for `claude-code`, `codex`, `opencode`, `cursor`,
 *    `grok-bot`, `openmausbot`, or `dsh`.
 *  - Never touches `openmausbot/routines.json` or overwrites live `<HERMES_HOME>/cron/jobs.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../paths/atomic.js';
import {
  getHarnessCapability,
  listHarnessCapabilities,
  type HarnessCapability,
} from '../harness/matrix.js';

export const SCHEDULE_LADDER_TIERS = [
  'harness-native',
  'os-scheduler',
  'tick-if-due',
  'daemon',
] as const;

export type ScheduleLadderTier = (typeof SCHEDULE_LADDER_TIERS)[number];

export interface HarnessScheduleResolveOptions {
  intervalMinutes?: number | undefined;
  nodePath?: string | undefined;
  cliEntryPath?: string | undefined;
  mode?: 'observe' | 'propose' | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
}

export interface HarnessZeroTokenAssets {
  kind: 'hermes-script-cron' | 'antigravity-schedule-sidecar';
  posixScript?: string | undefined;
  powershellScript?: string | undefined;
  cronJobSnippetJson?: string | undefined;
  sidecarSnippetJson?: string | undefined;
  optInSettingKey?: string | undefined;
  mergeInstructions: string;
}

export interface ResolvedHarnessLadderEntry {
  harnessId: string;
  displayName: string;
  zeroTokenScriptCapable: boolean;
  harnessNativeSupported: boolean;
  schedulerType: string;
  primaryTier: 'harness-native' | 'os-scheduler';
  fallbackTiers: ScheduleLadderTier[];
  reason: string;
  assets: HarnessZeroTokenAssets | null;
}

function assertSafeScheduleToken(label: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(value)) {
    throw new Error(`Unsafe ${label} in harness schedule asset: control characters and quotes are forbidden.`);
  }
  return value;
}

function buildCronExpression(minutes: number): string {
  if (minutes >= 1440) return '0 0 * * *';
  if (minutes >= 60) {
    const hours = Math.max(1, Math.floor(minutes / 60));
    return `0 */${hours} * * *`;
  }
  return `*/${Math.max(1, minutes)} * * * *`;
}

function resolveEntryFromCapability(
  entry: HarnessCapability,
  options: HarnessScheduleResolveOptions = {}
): ResolvedHarnessLadderEntry {
  const minutes = Math.max(1, Math.floor(options.intervalMinutes ?? 15));
  const mode = options.mode === 'observe' ? 'observe' : 'propose';
  const nodePath = assertSafeScheduleToken('nodePath', options.nodePath ?? process.execPath);
  const cliEntryPath = assertSafeScheduleToken(
    'cliEntryPath',
    options.cliEntryPath ?? 'packages/cli/dist/index.js'
  );
  const extraArgs: string[] = [];
  if (options.configPath) {
    extraArgs.push('--config', assertSafeScheduleToken('configPath', options.configPath));
  }
  if (options.stateDir) {
    extraArgs.push('--state-dir', assertSafeScheduleToken('stateDir', options.stateDir));
  }

  // Hard S6/S7 zero-token capability gate: ONLY zeroTokenScriptCapable harnesses qualify for Tier 1 (kills M1).
  if (entry.scheduler.zeroTokenScriptCapable) {
    const cronExpr = buildCronExpression(minutes);

    if (entry.id === 'antigravity') {
      const sidecarManifest = {
        id: 'routersync-tick',
        builtin: 'schedule',
        intervalSeconds: minutes * 60,
        args: [
          `CRON_TZ=UTC ${cronExpr}`,
          nodePath,
          cliEntryPath,
          'tick',
          '--mode',
          mode,
          ...extraArgs,
        ],
        optInSettingKey: 'sidecars.routersync-tick.enabled',
        restart_policy: 'always',
      };

      return {
        harnessId: entry.id,
        displayName: entry.displayName,
        zeroTokenScriptCapable: true,
        harnessNativeSupported: true,
        schedulerType: entry.scheduler.schedulerType,
        primaryTier: 'harness-native',
        fallbackTiers: ['os-scheduler', 'tick-if-due', 'daemon'],
        reason:
          'Google Antigravity supports zero-token sidecar builtin="schedule" execution; falls back to OS scheduler and MCP tick_if_due when IDE is closed.',
        assets: {
          kind: 'antigravity-schedule-sidecar',
          sidecarSnippetJson: JSON.stringify(sidecarManifest, null, 2) + '\n',
          optInSettingKey: 'sidecars.routersync-tick.enabled',
          mergeInstructions:
            'Place antigravity-sidecar.snippet.json in ~/.gemini/config/sidecars/routersync-tick/sidecar.json and opt in via sidecars.routersync-tick.enabled=true.',
        },
      };
    }

    const posixNode = nodePath.replace(/\\/g, '/');
    const posixCli = cliEntryPath.replace(/\\/g, '/');
    const posixExtra = extraArgs.map((a) => `"${a.replace(/\\/g, '/')}"`).join(' ');
    const posixCmd = `"${posixNode}" "${posixCli}" tick --mode ${mode}${posixExtra ? ` ${posixExtra}` : ''}`;

    const psExtra = extraArgs.map((a) => `"${a}"`).join(' ');
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `& "${nodePath}" "${cliEntryPath}" tick --mode ${mode}${psExtra ? ` ${psExtra}` : ''}`,
      '',
    ].join('\n');

    const shScript = ['#!/usr/bin/env sh', 'set -eu', `exec ${posixCmd}`, ''].join('\n');

    const jobSnippet = {
      id: 'routersync-tick',
      name: 'routersync-tick',
      schedule: cronExpr,
      no_agent: true,
      script: 'routersync-tick.sh',
      command: posixCmd,
    };

    return {
      harnessId: entry.id,
      displayName: entry.displayName,
      zeroTokenScriptCapable: true,
      harnessNativeSupported: true,
      schedulerType: entry.scheduler.schedulerType,
      primaryTier: 'harness-native',
      fallbackTiers: ['os-scheduler', 'tick-if-due', 'daemon'],
      reason: `${entry.displayName} supports zero-token script cron (no_agent: true) via ${entry.scheduler.scriptsDir ?? '<HERMES_HOME>/scripts/'}; falls back to OS scheduler when gateway is stopped.`,
      assets: {
        kind: 'hermes-script-cron',
        posixScript: shScript,
        powershellScript: psScript,
        cronJobSnippetJson: JSON.stringify(jobSnippet, null, 2) + '\n',
        mergeInstructions:
          'Copy scripts/routersync-tick.sh (or .ps1) into <HERMES_HOME>/scripts/ and merge scripts/routersync-cron-job.snippet.json into <HERMES_HOME>/cron/jobs.json (never auto-overwritten).',
      },
    };
  }

  return {
    harnessId: entry.id,
    displayName: entry.displayName,
    zeroTokenScriptCapable: false,
    harnessNativeSupported: false,
    schedulerType: entry.scheduler.schedulerType,
    primaryTier: 'os-scheduler',
    fallbackTiers: ['tick-if-due', 'daemon'],
    reason: `[${entry.displayName}] Harness-native cron rejected for 0-token safety (${entry.scheduler.schedulerType}): ${entry.scheduler.notes} -> Use Tier 2 OS scheduler + Tier 3 MCP tick_if_due fallback.`,
    assets: null,
  };
}

export function resolveHarnessLadderEntry(
  harnessId: string,
  options: HarnessScheduleResolveOptions = {}
): ResolvedHarnessLadderEntry {
  const cap = getHarnessCapability(harnessId);
  if (!cap) {
    const valid = listHarnessCapabilities()
      .map((h) => h.id)
      .join(', ');
    throw new Error(`Unknown harness "${harnessId}". Supported harnesses: ${valid}`);
  }
  return resolveEntryFromCapability(cap, options);
}

export function listHarnessLadderEntries(
  options: HarnessScheduleResolveOptions = {}
): ResolvedHarnessLadderEntry[] {
  return listHarnessCapabilities().map((cap) => resolveEntryFromCapability(cap, options));
}

/**
 * Emits non-destructive Tier-1 zero-token schedule snippets into `targetDir`.
 *
 * Safety invariants:
 *  - NEVER modifies `<HERMES_HOME>/cron/jobs.json`
 *  - NEVER creates or touches `openmausbot/routines.json`
 *  - Writes 0 files when `harnessNativeSupported === false`
 */
export function emitHarnessNativeSnippets(
  harnessId: string,
  targetDir: string,
  options: HarnessScheduleResolveOptions = {}
): { writtenFiles: string[]; entry: ResolvedHarnessLadderEntry } {
  const entry = resolveHarnessLadderEntry(harnessId, options);
  if (!entry.harnessNativeSupported || !entry.assets) {
    return { writtenFiles: [], entry };
  }

  const resolvedRoot = path.resolve(targetDir);
  const writtenFiles: string[] = [];

  if (entry.assets.kind === 'hermes-script-cron') {
    const scriptsDir = path.join(resolvedRoot, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    const shPath = path.join(scriptsDir, 'routersync-tick.sh');
    const ps1Path = path.join(scriptsDir, 'routersync-tick.ps1');
    const snippetPath = path.join(scriptsDir, 'routersync-cron-job.snippet.json');

    atomicWriteFileSync(shPath, entry.assets.posixScript ?? '');
    try {
      fs.chmodSync(shPath, 0o755);
    } catch {
      // Ignore chmod on Windows filesystems
    }
    atomicWriteFileSync(ps1Path, entry.assets.powershellScript ?? '');
    atomicWriteFileSync(snippetPath, entry.assets.cronJobSnippetJson ?? '');

    writtenFiles.push(shPath, ps1Path, snippetPath);
    return { writtenFiles, entry };
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });
  const sidecarPath = path.join(resolvedRoot, 'antigravity-sidecar.snippet.json');
  atomicWriteFileSync(sidecarPath, entry.assets.sidecarSnippetJson ?? '');
  writtenFiles.push(sidecarPath);
  return { writtenFiles, entry };
}
