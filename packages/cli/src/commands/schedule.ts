/**
 * packages/cli/src/commands/schedule.ts
 *
 * Scheduler artifacts & CLI handler (`routersync schedule [install|status|uninstall]`).
 * Supports Windows Task Scheduler, macOS launchd, and Linux systemd --user timer
 * (default every 15 minutes).
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
import { resolveAutonomyMode } from './tick.js';
import { resolveConfigFilePath } from '../config/loader.js';

export interface ScheduleArtifacts {
  windowsXml: string;
  systemdUnit: string;
  systemdTimer: string;
  launchdPlist: string;
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
  /** Directory for launchd stdout/stderr logs. Default: the state dir. */
  logDir?: string | undefined;
}

export const DEFAULT_INTERVAL_MINUTES = 15;
export const WINDOWS_TASK_NAME = 'RouterSync';

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['ROUTERSYNC_STATE_DIR'] || path.join(os.homedir(), '.routersync');
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

/** Reject values that could break out of an XML / plist / unit-file field. */
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

  const uninstallCommands = [
    `schtasks /delete /tn "${WINDOWS_TASK_NAME}" /f`,
    'systemctl --user disable --now routersync-daemon.service routersync-daemon.timer',
    'launchctl unload ~/Library/LaunchAgents/com.routersync.daemon.plist; rm ~/Library/LaunchAgents/com.routersync.daemon.plist',
  ];

  return { windowsXml, systemdUnit, systemdTimer, launchdPlist, uninstallCommands };
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

export function queryScheduleStatus(platform: NodeJS.Platform = process.platform): {
  os: string;
  taskName: string;
  installed: boolean;
  detail: string;
} {
  if (platform === 'win32') {
    const res = spawnSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], { encoding: 'utf8', timeout: 5_000 });
    const installed = res.status === 0;
    return {
      os: 'windows',
      taskName: WINDOWS_TASK_NAME,
      installed,
      detail: installed ? (res.stdout || '').trim().split(/\r?\n/)[0] ?? 'present' : 'not-registered',
    };
  }
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.routersync.daemon.plist');
    const installed = fs.existsSync(plistPath);
    return {
      os: 'macos',
      taskName: 'com.routersync.daemon',
      installed,
      detail: installed ? plistPath : 'not-registered',
    };
  }
  const timerPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'routersync-daemon.timer');
  const installed = fs.existsSync(timerPath);
  return {
    os: 'linux',
    taskName: 'routersync-daemon.timer',
    installed,
    detail: installed ? timerPath : 'not-registered',
  };
}

export interface RunScheduleCommandOptions {
  action?: string | undefined;
  intervalMinutes?: string | undefined;
  mode?: string | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
  config?: string | undefined;
  configPath?: string | undefined;
  stateDir?: string | undefined;
}

export async function runScheduleCommand(options: RunScheduleCommandOptions = {}): Promise<void> {
  const action = (options.action ?? 'dry-run').toLowerCase();
  // C4q/Q1: validate before generating files or touching the disk.
  const interval = validateIntervalMinutes(options.intervalMinutes);
  const mode = resolveAutonomyMode(options.mode);

  if (action === 'status') {
    const st = queryScheduleStatus();
    if (options.json) {
      console.log(JSON.stringify({ ...st, intervalMinutes: interval }, null, 2));
    } else {
      console.log(
        `SCHEDULE-STATUS os=${st.os} task=${st.taskName} installed=${st.installed ? 'yes' : 'no'} interval=${interval}m detail=${st.detail}`
      );
    }
    return;
  }

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

  const artifacts = buildTickScheduleArtifacts({
    intervalMinutes: interval,
    mode,
    configPath: resolvedConfig,
    stateDir: resolvedState,
  });

  if (options.dryRun || action === 'dry-run' || (action !== 'install' && action !== 'uninstall')) {
    if (options.json) {
      console.log(JSON.stringify({ dryRun: true, action, intervalMinutes: interval, mode, ...artifacts }, null, 2));
    } else {
      console.log(`DRY-RUN: chỉ sinh artifact (action=${action}, interval=${interval}m, mode=${mode}), không cài đặt gì cả.`);
      console.log('--- windowsXml (Windows Task Scheduler) ---');
      console.log(artifacts.windowsXml);
      console.log('--- launchdPlist (macOS launchd) ---');
      console.log(artifacts.launchdPlist);
      console.log('--- systemdUnit (Linux systemd --user service) ---');
      console.log(artifacts.systemdUnit);
      console.log('--- systemdTimer (Linux systemd --user timer) ---');
      console.log(artifacts.systemdTimer);
      console.log('--- uninstallCommands ---');
      console.log(artifacts.uninstallCommands.join('\n'));
    }
    return;
  }

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

  const stateDir = resolveStateDir();
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  if (action === 'install') {
    if (process.platform === 'win32') {
      const xmlFile = path.join(stateDir, 'routersync-task.xml');
      fs.writeFileSync(xmlFile, encodeWindowsTaskXml(artifacts.windowsXml));
      const res = spawnSync('schtasks', ['/create', '/tn', WINDOWS_TASK_NAME, '/xml', xmlFile, '/f'], { encoding: 'utf8' });
      if (res.status !== 0) {
        console.error(`[routersync schedule] schtasks install failed: ${res.stderr || res.stdout}`);
        process.exitCode = 1;
        return;
      }
      console.log(`SCHEDULE-INSTALLED os=windows task=${WINDOWS_TASK_NAME} interval=${interval}m`);
      return;
    }
    if (process.platform === 'darwin') {
      const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const plistFile = path.join(dir, 'com.routersync.daemon.plist');
      fs.writeFileSync(plistFile, artifacts.launchdPlist, 'utf8');
      spawnSync('launchctl', ['load', plistFile], { encoding: 'utf8' });
      console.log(`SCHEDULE-INSTALLED os=macos plist=${plistFile} interval=${interval}m`);
      return;
    }
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'routersync-daemon.service'), artifacts.systemdUnit, 'utf8');
    fs.writeFileSync(path.join(unitDir, 'routersync-daemon.timer'), artifacts.systemdTimer, 'utf8');
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    spawnSync('systemctl', ['--user', 'enable', '--now', 'routersync-daemon.timer'], { encoding: 'utf8' });
    console.log(`SCHEDULE-INSTALLED os=linux unit=${unitDir}/routersync-daemon.timer interval=${interval}m`);
    return;
  }

  if (action === 'uninstall') {
    if (process.platform === 'win32') {
      spawnSync('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'], { encoding: 'utf8' });
      console.log(`SCHEDULE-UNINSTALLED os=windows task=${WINDOWS_TASK_NAME}`);
      return;
    }
    if (process.platform === 'darwin') {
      const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.routersync.daemon.plist');
      spawnSync('launchctl', ['unload', plistFile], { encoding: 'utf8' });
      if (fs.existsSync(plistFile)) fs.unlinkSync(plistFile);
      console.log(`SCHEDULE-UNINSTALLED os=macos plist=${plistFile}`);
      return;
    }
    spawnSync('systemctl', ['--user', 'disable', '--now', 'routersync-daemon.service', 'routersync-daemon.timer'], { encoding: 'utf8' });
    console.log('SCHEDULE-UNINSTALLED os=linux task=routersync-daemon.timer');
  }
}
