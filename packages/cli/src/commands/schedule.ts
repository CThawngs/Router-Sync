/**
 * packages/cli/src/commands/schedule.ts
 *
 * Scheduler artifacts & CLI handler (`routersync schedule [install|status|uninstall]`).
 * Supports Windows Task Scheduler, macOS launchd, Linux systemd --user timer,
 * Linux `crontab` (`--scheduler auto|systemd|cron`), AND C45-WP7 4-Tier Schedule Ladder
 * across all 9 harnesses from `harness-matrix.json` (Phục vụ: S6, S7).
 *
 * C4q/Q1: every artifact launches `<absolute node> <absolute dist/index.js> tick ...`
 * (see resolveTickInvocation) instead of a bare `routersync`, which only works
 * when the package is installed globally.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  emitHarnessNativeSnippets,
  getHarnessCapability,
  listHarnessCapabilities,
  resolveHarnessLadderEntry,
  type ScheduleLadderTier,
} from '@routersync/core';
import { resolveAutonomyMode } from './tick.js';
import { resolveConfigFilePath } from '../config/loader.js';

export type LinuxSchedulerMode = 'auto' | 'systemd' | 'cron';

export interface ScheduleArtifacts {
  windowsXml: string;
  systemdUnit: string;
  systemdTimer: string;
  launchdPlist: string;
  linuxCron: string;
  uninstallCommands: string[];
}

export interface TickInvocation {
  /** Absolute path to the node executable. */
  node: string;
  /** Absolute path to the CLI entry (packages/cli/dist/index.js). */
  script: string;
}

export interface ScheduleOptions {
  intervalMinutes?: number | undefined;
  autonomy?: string | undefined;
  commandArgs?: string[] | undefined;
  invocation?: TickInvocation | undefined;
  /** Directory for launchd / cron stdout/stderr logs. Default: the state dir. */
  logDir?: string | undefined;
}

export interface HarnessNativeScheduleArtifact {
  kind: 'hermes-script-cron' | 'antigravity-schedule-sidecar';
  preview: string;
  command?: string | undefined;
  notes: string;
}

export interface HarnessSchedulePlan {
  harnessId: string;
  displayName: string;
  zeroTokenScriptCapable: boolean;
  harnessNativeSupported: boolean;
  ladderTier: 'harness-native' | 'os-scheduler';
  fallbackTiers: ScheduleLadderTier[];
  selectedTier: 'harness-native-zero-token' | 'os-scheduler';
  reason: string;
  nativePreview?: string | undefined;
  nativeArtifact?: HarnessNativeScheduleArtifact | undefined;
  osArtifacts: ScheduleArtifacts;
  osFallbackArtifacts: ScheduleArtifacts;
}

export type ScheduleSpawnResult = {
  status: number | null;
  stdout?: string | undefined;
  stderr?: string | undefined;
  error?: Error | undefined;
};

export type ScheduleSpawnFn = (
  command: string,
  args: string[],
  options?: { encoding?: BufferEncoding; timeout?: number; input?: string }
) => ScheduleSpawnResult;

export const DEFAULT_INTERVAL_MINUTES = 15;
export const WINDOWS_TASK_NAME = 'RouterSync';
export const LINUX_CRON_MARKER = '# routersync-tick';

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
}

export function validateLinuxSchedulerMode(value?: string | undefined): LinuxSchedulerMode {
  if (!value || value.trim() === '') return 'auto';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'systemd' || normalized === 'cron') {
    return normalized;
  }
  throw new Error(`Invalid --scheduler "${value}": expected auto | systemd | cron`);
}

/**
 * The single place that decides how a scheduler launches RouterSync, shared by
 * Windows, macOS and Linux: absolute node + absolute CLI entry of THIS install.
 * Running from dist/commands/ finds ../index.js; from src/ (tests, tsx) it falls
 * back to ../../dist/index.js.
 */
export function resolveTickInvocation(overrides: Partial<TickInvocation> = {}): TickInvocation {
  const node = overrides.node ?? process.execPath;
  let script = overrides.script;
  if (!script) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.resolve(here, '..', 'index.js');
    script = fs.existsSync(sibling) ? sibling : path.resolve(here, '..', '..', 'dist', 'index.js');
  }
  return { node: path.resolve(node), script: path.resolve(script) };
}

/** Reject values that could break out of an XML / plist / unit-file / crontab field. */
function assertSafeValue(label: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(value)) {
    throw new Error(`Unsafe ${label} for scheduler artifact: control characters and double quotes are not allowed.`);
  }
  return value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** systemd: backslash is an escape, % and $ are expanded; quote tokens with spaces.
 *  Newlines and `"` were already rejected by assertSafeValue. */
function systemdToken(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * Escapes literal `%` as `\%` per `crontab(5)` rules (where unescaped `%` becomes newline)
 * and escapes `$` / `` ` `` / `\` inside double-quoted shell arguments (kills M4).
 */
function escapeCrontabDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/%/g, '\\%');
}

function buildCronSchedulePrefix(minutes: number): string {
  if (minutes >= 1440) return '0 0 * * *';
  if (minutes >= 60) {
    const hours = Math.max(1, Math.min(23, Math.floor(minutes / 60)));
    return `0 */${hours} * * *`;
  }
  return `*/${Math.max(1, minutes)} * * * *`;
}

/**
 * Idempotently merges a `# routersync-tick` cron line into an existing crontab
 * without clobbering unrelated user cron entries (kills M4).
 */
export function mergeLinuxCrontab(existingCrontab: string, cronLine: string): string {
  const cleanLine = cronLine.trim();
  if (!cleanLine.endsWith(LINUX_CRON_MARKER)) {
    throw new Error(`Invalid RouterSync cron line: missing ${LINUX_CRON_MARKER} suffix.`);
  }
  const keptLines = existingCrontab
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(LINUX_CRON_MARKER));

  // Trim trailing empty lines so output ends cleanly with single newline
  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') {
    keptLines.pop();
  }
  keptLines.push(cleanLine);
  return keptLines.join('\n') + '\n';
}

/**
 * Removes only lines ending with `# routersync-tick` from an existing crontab.
 */
export function removeLinuxCrontabEntry(existingCrontab: string): string {
  const keptLines = existingCrontab
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(LINUX_CRON_MARKER));
  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === '') {
    keptLines.pop();
  }
  return keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
}

/** Windows Task Scheduler needs a UTF-16 LE file with BOM when the XML says UTF-16. */
export function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.from('\uFEFF' + xml, 'utf16le');
}

export function buildScheduleArtifacts(options: ScheduleOptions = {}): ScheduleArtifacts {
  const minutes = Math.max(1, Math.floor(options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES));
  const autonomy = assertSafeValue('autonomy', options.autonomy ?? 'observe');
  const intervalSec = minutes * 60;
  const isoDuration = `PT${minutes}M`;
  const cmdArgs = (options.commandArgs ?? ['daemon', '--mode', 'observe']).map((a) => assertSafeValue('argument', a));
  const inv = options.invocation ?? resolveTickInvocation();
  const node = assertSafeValue('node path', inv.node);
  const script = assertSafeValue('script path', inv.script);
  const logDir = assertSafeValue('log dir', options.logDir ?? resolveStateDir());
  const argStr = cmdArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const winArgs = `"${script}" ${argStr}`;

  // LogonTrigger + TimeTrigger. No task is created by this function, on any OS.
  const windowsXml = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Author>RouterSync</Author><Description>${escapeXml(`routersync ${argStr} (dry-run artifact, import manually)`)}</Description></RegistrationInfo>`,
    '  <Triggers>',
    '    <LogonTrigger><Enabled>true</Enabled><Delay>PT1M</Delay></LogonTrigger>',
    `    <TimeTrigger><Enabled>true</Enabled><Repetition><Interval>${isoDuration}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary></TimeTrigger>`,
    '  </Triggers>',
    '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries><ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Priority>7</Priority></Settings>',
    `  <Actions><Exec><Command>${escapeXml(node)}</Command><Arguments>${escapeXml(winArgs)}</Arguments></Exec></Actions>`,
    '</Task>',
  ].join('\n');

  // tick is a run-once command: Type=oneshot and no Restart (the timer re-runs it).
  const systemdUnit = [
    '[Unit]',
    `Description=RouterSync ${argStr.replace(/%/g, '%%')} (dry-run artifact)`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${[node, script, ...cmdArgs].map(systemdToken).join(' ')}`,
    `Environment=AUTONOMY=${autonomy}`,
    'Nice=10',
    'IOSchedulingClass=idle',
    'CPUWeight=20',
    'MemoryHigh=512M',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');

  const systemdTimer = [
    '[Unit]',
    `Description=Run RouterSync ${argStr.replace(/%/g, '%%')} every ${minutes} minutes (dry-run artifact)`,
    '',
    '[Timer]',
    'OnBootSec=1min',
    `OnUnitActiveSec=${minutes}min`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
  ].join('\n');

  // No KeepAlive: tick exits after each run, KeepAlive would make launchd respawn it every ~10s.
  const plistArgs = [node, script, ...cmdArgs].map((a) => `<string>${escapeXml(a)}</string>`).join('');
  const launchdPlist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>com.routersync.daemon</string>',
    `  <key>ProgramArguments</key><array>${plistArgs}</array>`,
    `  <key>StartInterval</key><integer>${intervalSec}</integer>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>LowPriorityIO</key><true/>',
    '  <key>Nice</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${escapeXml(path.join(logDir, 'schedule-stdout.log'))}</string>`,
    `  <key>StandardErrorPath</key><string>${escapeXml(path.join(logDir, 'schedule-stderr.log'))}</string>`,
    '</dict>',
    '</plist>',
  ].join('\n');

  const cronSchedule = buildCronSchedulePrefix(minutes);
  const cronTokens = [node, script, ...cmdArgs].map((tok) => `"${escapeCrontabDoubleQuoted(tok)}"`);
  const cronLogFile = path.posix.join(logDir.replace(/\\/g, '/'), 'logs', 'cron-tick.log');
  const linuxCron = `${cronSchedule} ${cronTokens.join(' ')} >> "${escapeCrontabDoubleQuoted(cronLogFile)}" 2>&1 ${LINUX_CRON_MARKER}`;

  const uninstallCommands = [
    `schtasks /delete /tn "${WINDOWS_TASK_NAME}" /f`,
    `systemctl --user disable --now routersync-daemon.service routersync-daemon.timer; (crontab -l 2>/dev/null | grep -v "${LINUX_CRON_MARKER}" | crontab -)`,
    'launchctl unload ~/Library/LaunchAgents/com.routersync.daemon.plist; rm ~/Library/LaunchAgents/com.routersync.daemon.plist',
  ];

  return { windowsXml, systemdUnit, systemdTimer, launchdPlist, linuxCron, uninstallCommands };
}

export function validateIntervalMinutes(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_INTERVAL_MINUTES;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`Invalid --interval-minutes "${value}": must be an integer >= 1`);
  }
  return num;
}

export function buildTickScheduleArtifacts(
  options: {
    intervalMinutes?: number | undefined;
    mode?: string | undefined;
    invocation?: TickInvocation | undefined;
    logDir?: string | undefined;
    configPath?: string | undefined;
    stateDir?: string | undefined;
  } = {}
): ScheduleArtifacts {
  const mode = resolveAutonomyMode(options.mode);
  const args = ['tick', '--mode', mode];
  if (options.configPath) {
    args.push('-c', path.resolve(options.configPath));
  }
  if (options.stateDir) {
    args.push('--state-dir', path.resolve(options.stateDir));
  }
  return buildScheduleArtifacts({
    intervalMinutes: options.intervalMinutes !== undefined ? validateIntervalMinutes(options.intervalMinutes) : DEFAULT_INTERVAL_MINUTES,
    autonomy: mode,
    commandArgs: args,
    invocation: options.invocation,
    logDir: options.logDir ?? (options.stateDir ? path.resolve(options.stateDir) : undefined),
  });
}

/**
 * C45-WP1 + C45-WP7 (`Phục vụ: S6, S7`): Resolves the verified 4-tier schedule plan
 * for a given harness directly via `resolveHarnessLadderEntry` (`harness-matrix.json`),
 * never overwriting live user `jobs.json` or `routines.json`.
 */
export function resolveHarnessSchedulePlan(
  harnessId: string,
  options: {
    intervalMinutes?: number | undefined;
    mode?: string | undefined;
    invocation?: TickInvocation | undefined;
    logDir?: string | undefined;
    configPath?: string | undefined;
    stateDir?: string | undefined;
  } = {}
): HarnessSchedulePlan {
  const cap = getHarnessCapability(harnessId);
  if (!cap) {
    const valid = listHarnessCapabilities().map((h) => h.id).join(', ');
    throw new Error(`Unknown --harness "${harnessId}". Supported harnesses: ${valid}`);
  }

  const minutes =
    options.intervalMinutes !== undefined
      ? validateIntervalMinutes(options.intervalMinutes)
      : DEFAULT_INTERVAL_MINUTES;
  const mode = resolveAutonomyMode(options.mode);
  const inv = options.invocation ?? resolveTickInvocation();
  const osArtifacts = buildTickScheduleArtifacts({
    intervalMinutes: minutes,
    mode,
    invocation: inv,
    logDir: options.logDir,
    configPath: options.configPath,
    stateDir: options.stateDir,
  });

  const ladder = resolveHarnessLadderEntry(harnessId, {
    intervalMinutes: minutes,
    nodePath: inv.node,
    cliEntryPath: inv.script,
    mode: mode === 'observe' ? 'observe' : 'propose',
    configPath: options.configPath,
    stateDir: options.stateDir,
  });

  if (ladder.harnessNativeSupported && ladder.assets) {
    const preview =
      ladder.assets.kind === 'hermes-script-cron'
        ? `${(ladder.assets.cronJobSnippetJson ?? '').trim()}\n# routersync-tick.sh\n${ladder.assets.posixScript ?? ''}`
        : `// ~/.gemini/config/sidecars/routersync-tick/sidecar.json\n${(ladder.assets.sidecarSnippetJson ?? '').trim()}`;

    return {
      harnessId: ladder.harnessId,
      displayName: ladder.displayName,
      zeroTokenScriptCapable: ladder.zeroTokenScriptCapable,
      harnessNativeSupported: true,
      ladderTier: ladder.primaryTier,
      fallbackTiers: ladder.fallbackTiers,
      selectedTier: 'harness-native-zero-token',
      reason: ladder.reason,
      nativePreview: preview,
      nativeArtifact: {
        kind: ladder.assets.kind,
        command: cap.scheduler.nativeCommand,
        preview,
        notes: cap.scheduler.notes,
      },
      osArtifacts,
      osFallbackArtifacts: osArtifacts,
    };
  }

  return {
    harnessId: ladder.harnessId,
    displayName: ladder.displayName,
    zeroTokenScriptCapable: ladder.zeroTokenScriptCapable,
    harnessNativeSupported: ladder.harnessNativeSupported,
    ladderTier: ladder.primaryTier,
    fallbackTiers: ladder.fallbackTiers,
    selectedTier: ladder.harnessNativeSupported ? 'harness-native-zero-token' : 'os-scheduler',
    reason: ladder.reason,
    nativePreview: undefined,
    nativeArtifact: undefined,
    osArtifacts,
    osFallbackArtifacts: osArtifacts,
  };
}

/** Accepts the confirmation word with or without diacritics, in any case. */
export function isConfirmAnswer(answer: string): boolean {
  const normalized = answer.trim().normalize('NFC').toLowerCase();
  return normalized === 'chay' || normalized === 'ch\u1EA1y';
}

function askTypeChay(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (ans) => {
      rl.close();
      resolve(isConfirmAnswer(ans));
    });
  });
}

function defaultSpawnFn(
  command: string,
  args: string[],
  options?: { encoding?: BufferEncoding; timeout?: number; input?: string }
): ScheduleSpawnResult {
  const res = spawnSync(command, args, {
    encoding: options?.encoding ?? 'utf8',
    timeout: options?.timeout,
    input: options?.input,
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    error: res.error,
  };
}

export function queryScheduleStatus(
  platform: NodeJS.Platform = process.platform,
  options: { homeDir?: string | undefined; spawnFn?: ScheduleSpawnFn | undefined } = {}
): {
  os: string;
  taskName: string;
  installed: boolean;
  detail: string;
} {
  const homeDir = options.homeDir ?? os.homedir();
  const run = options.spawnFn ?? defaultSpawnFn;

  if (platform === 'win32') {
    const res = run('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], { encoding: 'utf8', timeout: 5_000 });
    const installed = res.status === 0;
    return {
      os: 'windows',
      taskName: WINDOWS_TASK_NAME,
      installed,
      detail: installed ? (res.stdout || '').trim().split(/\r?\n/)[0] ?? 'present' : 'not-registered',
    };
  }
  if (platform === 'darwin') {
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.routersync.daemon.plist');
    const installed = fs.existsSync(plistPath);
    return {
      os: 'macos',
      taskName: 'com.routersync.daemon',
      installed,
      detail: installed ? plistPath : 'not-registered',
    };
  }
  const timerPath = path.join(homeDir, '.config', 'systemd', 'user', 'routersync-daemon.timer');
  if (fs.existsSync(timerPath)) {
    return {
      os: 'linux',
      taskName: 'routersync-daemon.timer',
      installed: true,
      detail: timerPath,
    };
  }
  const cronRes = run('crontab', ['-l'], { encoding: 'utf8', timeout: 5_000 });
  if (cronRes.status === 0 && (cronRes.stdout ?? '').includes(LINUX_CRON_MARKER)) {
    return {
      os: 'linux',
      taskName: 'crontab#routersync-tick',
      installed: true,
      detail: 'crontab (# routersync-tick)',
    };
  }
  return {
    os: 'linux',
    taskName: 'routersync-daemon.timer',
    installed: false,
    detail: 'not-registered',
  };
}

export interface RunScheduleCommandOptions {
  action?: string | undefined;
  harness?: string | undefined;
  scheduler?: string | undefined;
  intervalMinutes?: string | undefined;
  mode?: string | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
  config?: string | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
  homeDir?: string | undefined;
  platformOverride?: NodeJS.Platform | undefined;
  allowNonTtyForTest?: boolean | undefined;
  spawnFn?: ScheduleSpawnFn | undefined;
}

function readExistingCrontab(run: ScheduleSpawnFn): string {
  const res = run('crontab', ['-l'], { encoding: 'utf8', timeout: 5_000 });
  if (res.status === 0) {
    return res.stdout ?? '';
  }
  const msg = `${res.stderr ?? ''} ${res.stdout ?? ''}`.toLowerCase();
  if (msg.includes('no crontab')) {
    return '';
  }
  return '';
}

function isSystemdUserAvailable(run: ScheduleSpawnFn): boolean {
  const res = run('systemctl', ['--user', 'status'], { encoding: 'utf8', timeout: 5_000 });
  if (res.error) return false;
  // systemctl --user status returns 0 when running or degraded, non-zero (1) when bus/systemd unavailable unless stdout shows State:
  if (res.status === 0) return true;
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  if (/Failed to connect to bus|System has not been booted with systemd|not found/i.test(out)) {
    return false;
  }
  return /State:\s*(running|degraded)/i.test(out);
}

export async function runScheduleCommand(options: RunScheduleCommandOptions = {}): Promise<void> {
  const action = (options.action ?? 'dry-run').toLowerCase();
  const interval = validateIntervalMinutes(options.intervalMinutes);
  const mode = resolveAutonomyMode(options.mode);
  const linuxScheduler = validateLinuxSchedulerMode(options.scheduler);
  const targetPlatform = options.platformOverride ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const run = options.spawnFn ?? defaultSpawnFn;

  const explicitCfg = options.configPath ?? options.config;
  let resolvedConfig: string | undefined;
  if (explicitCfg) {
    resolvedConfig = path.resolve(explicitCfg);
  } else {
    try {
      const defaultCfg = resolveConfigFilePath();
      if (fs.existsSync(defaultCfg)) {
        resolvedConfig = path.resolve(defaultCfg);
      }
    } catch {
      // ignore
    }
  }

  const resolvedState = options.stateDir ? path.resolve(options.stateDir) : path.resolve(resolveStateDir());

  const harnessPlan = options.harness
    ? resolveHarnessSchedulePlan(options.harness, {
        intervalMinutes: interval,
        mode,
        configPath: resolvedConfig,
        stateDir: resolvedState,
      })
    : undefined;

  if (action === 'status') {
    const st = queryScheduleStatus(targetPlatform, { homeDir, spawnFn: run });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...st,
            intervalMinutes: interval,
            scheduler: linuxScheduler,
            ...(harnessPlan ? { harnessPlan } : {}),
          },
          null,
          2
        )
      );
    } else {
      console.log(
        `SCHEDULE-STATUS os=${st.os} task=${st.taskName} installed=${st.installed ? 'yes' : 'no'} interval=${interval}m detail=${st.detail}`
      );
      if (harnessPlan) {
        console.log(`HARNESS-SCHEDULE harness=${harnessPlan.harnessId} tier=${harnessPlan.selectedTier} reason=${harnessPlan.reason}`);
      }
    }
    return;
  }

  const artifacts = harnessPlan
    ? harnessPlan.osArtifacts
    : buildTickScheduleArtifacts({
        intervalMinutes: interval,
        mode,
        configPath: resolvedConfig,
        stateDir: resolvedState,
      });

  if (options.dryRun || action === 'dry-run' || (action !== 'install' && action !== 'uninstall')) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            action,
            platform: targetPlatform,
            scheduler: linuxScheduler,
            intervalMinutes: interval,
            mode,
            ...(harnessPlan ? { harnessPlan } : {}),
            ...artifacts,
          },
          null,
          2
        )
      );
    } else {
      console.log(`DRY-RUN: chỉ sinh artifact (action=${action}, interval=${interval}m, mode=${mode}), không cài đặt gì cả.`);
      if (harnessPlan) {
        console.log(`--- harnessSchedule (${harnessPlan.harnessId} -> ${harnessPlan.selectedTier}) ---`);
        console.log(harnessPlan.reason);
        if (harnessPlan.nativePreview) {
          console.log(harnessPlan.nativePreview);
        }
      }
      console.log('--- windowsXml (Windows Task Scheduler) ---');
      console.log(artifacts.windowsXml);
      console.log('--- launchdPlist (macOS launchd) ---');
      console.log(artifacts.launchdPlist);
      console.log('--- systemdUnit (Linux systemd --user service) ---');
      console.log(artifacts.systemdUnit);
      console.log('--- systemdTimer (Linux systemd --user timer) ---');
      console.log(artifacts.systemdTimer);
      console.log('--- linuxCron (Linux crontab fallback) ---');
      console.log(artifacts.linuxCron);
      console.log('--- uninstallCommands ---');
      console.log(artifacts.uninstallCommands.join('\n'));
    }
    return;
  }

  if (!options.allowNonTtyForTest) {
    if (!process.stdin.isTTY) {
      console.error(`[routersync schedule] Error: 'schedule ${action}' requires an interactive TTY (or pass --dry-run).`);
      process.exitCode = 1;
      return;
    }

    const ok = await askTypeChay(`Xác nhận thực thi 'routersync schedule ${action}' trên hệ điều hành? Gõ 'chay' để tiếp tục: `);
    if (!ok) {
      console.log(`[routersync schedule] Đã hủy '${action}'. Không có thay đổi nào được thực hiện.`);
      return;
    }
  }

  if (!fs.existsSync(resolvedState)) fs.mkdirSync(resolvedState, { recursive: true });

  if (action === 'install') {
    if (harnessPlan?.harnessNativeSupported) {
      const targetSnippetDir = path.join(resolvedState, 'schedules', harnessPlan.harnessId);
      emitHarnessNativeSnippets(harnessPlan.harnessId, targetSnippetDir, {
        intervalMinutes: interval,
        mode: mode === 'observe' ? 'observe' : 'propose',
        configPath: resolvedConfig,
        stateDir: resolvedState,
      });
    }

    if (targetPlatform === 'win32') {
      const xmlFile = path.join(resolvedState, 'routersync-task.xml');
      fs.writeFileSync(xmlFile, encodeWindowsTaskXml(artifacts.windowsXml));
      const res = run('schtasks', ['/create', '/tn', WINDOWS_TASK_NAME, '/xml', xmlFile, '/f'], { encoding: 'utf8' });
      if (res.status !== 0) {
        console.error(`[routersync schedule] schtasks install failed: ${res.stderr || res.stdout}`);
        process.exitCode = 1;
        return;
      }
      console.log(`SCHEDULE-INSTALLED os=windows task=${WINDOWS_TASK_NAME} interval=${interval}m`);
      return;
    }
    if (targetPlatform === 'darwin') {
      const dir = path.join(homeDir, 'Library', 'LaunchAgents');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const plistFile = path.join(dir, 'com.routersync.daemon.plist');
      fs.writeFileSync(plistFile, artifacts.launchdPlist, 'utf8');
      run('launchctl', ['load', plistFile], { encoding: 'utf8' });
      console.log(`SCHEDULE-INSTALLED os=macos plist=${plistFile} interval=${interval}m`);
      return;
    }

    const useCron =
      linuxScheduler === 'cron' ||
      (linuxScheduler === 'auto' && !isSystemdUserAvailable(run));

    if (useCron) {
      const logDir = path.join(resolvedState, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const existing = readExistingCrontab(run);
      const updated = mergeLinuxCrontab(existing, artifacts.linuxCron);
      const res = run('crontab', ['-'], { encoding: 'utf8', input: updated });
      if (res.status !== 0) {
        console.error(`[routersync schedule] crontab install failed: ${res.stderr || res.stdout}`);
        process.exitCode = 1;
        return;
      }
      console.log(`SCHEDULE-INSTALLED os=linux scheduler=cron interval=${interval}m`);
      return;
    }

    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'routersync-daemon.service'), artifacts.systemdUnit, 'utf8');
    fs.writeFileSync(path.join(unitDir, 'routersync-daemon.timer'), artifacts.systemdTimer, 'utf8');
    const reloadRes = run('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    const enableRes = run('systemctl', ['--user', 'enable', '--now', 'routersync-daemon.timer'], { encoding: 'utf8' });
    if (reloadRes.status !== 0 || enableRes.status !== 0) {
      console.error(`[routersync schedule] systemctl --user install failed: ${enableRes.stderr || reloadRes.stderr}`);
      process.exitCode = 1;
      return;
    }
    console.log(`SCHEDULE-INSTALLED os=linux scheduler=systemd unit=${unitDir}/routersync-daemon.timer interval=${interval}m`);
    return;
  }

  if (action === 'uninstall') {
    if (targetPlatform === 'win32') {
      run('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'], { encoding: 'utf8' });
      console.log(`SCHEDULE-UNINSTALLED os=windows task=${WINDOWS_TASK_NAME}`);
      return;
    }
    if (targetPlatform === 'darwin') {
      const plistFile = path.join(homeDir, 'Library', 'LaunchAgents', 'com.routersync.daemon.plist');
      run('launchctl', ['unload', plistFile], { encoding: 'utf8' });
      if (fs.existsSync(plistFile)) fs.unlinkSync(plistFile);
      console.log(`SCHEDULE-UNINSTALLED os=macos plist=${plistFile}`);
      return;
    }

    if (linuxScheduler === 'cron' || linuxScheduler === 'auto') {
      const existing = readExistingCrontab(run);
      if (existing.includes(LINUX_CRON_MARKER)) {
        const cleaned = removeLinuxCrontabEntry(existing);
        run('crontab', ['-'], { encoding: 'utf8', input: cleaned });
      }
    }
    if (linuxScheduler === 'systemd' || linuxScheduler === 'auto') {
      run('systemctl', ['--user', 'disable', '--now', 'routersync-daemon.service', 'routersync-daemon.timer'], { encoding: 'utf8' });
      const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
      for (const fname of ['routersync-daemon.service', 'routersync-daemon.timer']) {
        const fpath = path.join(unitDir, fname);
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
      }
    }
    console.log('SCHEDULE-UNINSTALLED os=linux task=routersync-daemon.timer');
  }
}
