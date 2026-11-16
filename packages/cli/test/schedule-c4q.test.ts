/**
 * C4q/Q1: scheduler artifacts. Nothing here installs a schedule or touches the
 * real state dir; install-path tests point ROUTERSYNC_STATE_DIR at a temp dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildScheduleArtifacts,
  buildTickScheduleArtifacts,
  encodeWindowsTaskXml,
  isConfirmAnswer,
  resolveTickInvocation,
  runScheduleCommand,
  type TickInvocation,
} from '../src/commands/schedule.js';

const isWin = process.platform === 'win32';
const INV: TickInvocation = isWin
  ? { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\rs\\packages\\cli\\dist\\index.js' }
  : { node: '/usr/local/bin/node', script: '/opt/rs/packages/cli/dist/index.js' };
const LOG_DIR = isWin ? 'C:\\state' : '/var/state';

function tick(mode = 'propose') {
  return buildTickScheduleArtifacts({ mode, invocation: INV, logDir: LOG_DIR });
}

describe('C4q Q1: scheduler artifacts', () => {
  it('launchd plist has no KeepAlive, keeps StartInterval + RunAtLoad, and log paths', () => {
    const { launchdPlist } = tick();
    expect(launchdPlist).not.toContain('KeepAlive');
    expect(launchdPlist).toContain('<key>StartInterval</key><integer>900</integer>');
    expect(launchdPlist).toContain('<key>RunAtLoad</key><true/>');
    expect(launchdPlist).toContain('<key>StandardOutPath</key>');
    expect(launchdPlist).toContain('<key>StandardErrorPath</key>');
    expect(launchdPlist).toContain(path.join(LOG_DIR, 'schedule-stdout.log'));
    expect(launchdPlist).toContain(`<string>${INV.node}</string><string>${INV.script}</string>`);
  });

  it('systemd unit: oneshot, no Restart, ExecStart is absolute node + absolute script', () => {
    const { systemdUnit } = tick();
    expect(systemdUnit).toContain('Type=oneshot');
    expect(systemdUnit).not.toContain('Restart=');
    const exec = systemdUnit.split('\n').find((l) => l.startsWith('ExecStart='))!;
    // systemd requires the first token to be an absolute path starting with "/".
    const posix = buildTickScheduleArtifacts({
      mode: 'propose',
      invocation: { node: '/usr/bin/node', script: '/opt/rs/dist/index.js' },
      logDir: '/var/state',
    }).systemdUnit;
    expect(posix).toContain('ExecStart=/usr/bin/node /opt/rs/dist/index.js tick --mode propose');
    expect(exec.startsWith('ExecStart=')).toBe(true);
    expect(exec).toContain('tick --mode propose');
  });

  it('Windows XML: Command is the absolute node path, Arguments are script + tick args', () => {
    const { windowsXml } = tick('observe');
    expect(windowsXml).toContain(`<Command>${INV.node}</Command>`);
    expect(windowsXml).toContain(`<Arguments>&quot;${INV.script}&quot; tick --mode observe</Arguments>`);
    expect(windowsXml).not.toContain('<Command>routersync</Command>');
    expect(path.isAbsolute(INV.node)).toBe(true);
  });

  it('Windows XML file is encoded as UTF-16 LE with BOM and round-trips', () => {
    const { windowsXml } = tick();
    const buf = encodeWindowsTaskXml(windowsXml);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xfe);
    expect(buf.subarray(2).toString('utf16le')).toBe(windowsXml);
    expect(windowsXml).toContain('encoding="UTF-16"');
  });

  it('resolveTickInvocation: absolute node + absolute script, overridable', () => {
    const inv = resolveTickInvocation();
    expect(path.isAbsolute(inv.node)).toBe(true);
    expect(path.isAbsolute(inv.script)).toBe(true);
    expect(inv.script.endsWith(path.join('dist', 'index.js')) || inv.script.endsWith('index.js')).toBe(true);
    expect(resolveTickInvocation({ node: INV.node, script: INV.script })).toEqual(INV);
  });

  it('all three OS artifacts use the same invocation', () => {
    const a = tick();
    expect(a.windowsXml).toContain(INV.node);
    expect(a.launchdPlist).toContain(INV.node);
    expect(a.systemdUnit).toContain(INV.script.replace(/\\/g, '\\\\'));
    expect(a.windowsXml).toContain(INV.script);
    expect(a.launchdPlist).toContain(INV.script);
  });

  it('invalid mode is rejected by the artifact builder', () => {
    expect(() => buildTickScheduleArtifacts({ mode: 'foo', invocation: INV })).toThrow(/Unknown --mode "foo"/);
  });

  describe('runScheduleCommand rejects a bad --mode before any write', () => {
    let tmp: string;
    let stateDir: string;
    const saved = process.env['ROUTERSYNC_STATE_DIR'];
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sched-'));
      stateDir = path.join(tmp, 'state');
      process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env['ROUTERSYNC_STATE_DIR'];
      else process.env['ROUTERSYNC_STATE_DIR'] = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    for (const action of ['install', 'dry-run', 'uninstall']) {
      it(`action=${action}: throws and creates nothing`, async () => {
        await expect(runScheduleCommand({ action, mode: 'foo', dryRun: action === 'dry-run' })).rejects.toThrow(
          /Unknown --mode "foo"/
        );
        expect(fs.existsSync(stateDir)).toBe(false);
      });
    }
  });

  describe('injection guards', () => {
    it('escapes XML special characters in paths (Windows XML and plist)', () => {
      const inv: TickInvocation = { node: '/opt/a&b/<node>', script: "/opt/it's/index.js" };
      const a = buildTickScheduleArtifacts({ mode: 'propose', invocation: inv, logDir: '/var/s' });
      expect(a.windowsXml).toContain('/opt/a&amp;b/&lt;node&gt;');
      expect(a.windowsXml).not.toContain('a&b');
      expect(a.launchdPlist).toContain('/opt/a&amp;b/&lt;node&gt;');
      expect(a.launchdPlist).toContain('/opt/it&apos;s/index.js');
    });

    it('rejects newline and double quote in any path (systemd directive injection)', () => {
      const bad = ['/opt/x\nExecStartPre=/bin/evil', '/opt/x"y', '/opt/x\r\nz'];
      for (const node of bad) {
        expect(() => buildTickScheduleArtifacts({ mode: 'propose', invocation: { node, script: '/s/index.js' } })).toThrow(
          /Unsafe node path/
        );
      }
      expect(() =>
        buildTickScheduleArtifacts({ mode: 'propose', invocation: { node: '/n', script: '/s\nWantedBy=x' } })
      ).toThrow(/Unsafe script path/);
      expect(() => buildTickScheduleArtifacts({ mode: 'propose', invocation: INV, logDir: '/l\n' })).toThrow(/Unsafe log dir/);
    });

    it('quotes systemd tokens with spaces and escapes %', () => {
      const a = buildScheduleArtifacts({
        commandArgs: ['tick'],
        invocation: { node: '/opt/my node/node', script: '/opt/100%/index.js' },
        logDir: '/l',
      });
      expect(a.systemdUnit).toContain('ExecStart="/opt/my node/node" /opt/100%%/index.js tick');
    });

    it('R1.3: embeds -c and --state-dir into schedule artifacts across all 3 OSes with proper escaping', () => {
      const configPath = isWin ? 'C:\\my config\\routersync.yaml' : '/opt/my config/routersync.yaml';
      const stateDir = isWin ? 'C:\\my state\\dir' : '/var/my state/dir';

      const a = buildTickScheduleArtifacts({
        mode: 'propose',
        invocation: INV,
        configPath,
        stateDir,
      });

      // 1. Windows XML
      expect(a.windowsXml).toContain('<Command>' + INV.node + '</Command>');
      expect(a.windowsXml).toContain('-c');
      expect(a.windowsXml).toContain('--state-dir');
      expect(a.windowsXml).toContain('&quot;' + path.resolve(configPath) + '&quot;');
      expect(a.windowsXml).toContain('&quot;' + path.resolve(stateDir) + '&quot;');

      // 2. Linux systemd Unit
      expect(a.systemdUnit).toContain('ExecStart=');
      expect(a.systemdUnit).toContain('-c');
      expect(a.systemdUnit).toContain('--state-dir');
      expect(a.systemdUnit).toContain('"' + path.resolve(configPath).replace(/\\/g, '\\\\') + '"');
      expect(a.systemdUnit).toContain('"' + path.resolve(stateDir).replace(/\\/g, '\\\\') + '"');

      // 3. macOS launchd Plist
      expect(a.launchdPlist).toContain('<key>ProgramArguments</key><array>');
      expect(a.launchdPlist).toContain('<string>-c</string>');
      expect(a.launchdPlist).toContain('<string>' + path.resolve(configPath) + '</string>');
      expect(a.launchdPlist).toContain('<string>--state-dir</string>');
      expect(a.launchdPlist).toContain('<string>' + path.resolve(stateDir) + '</string>');
    });
  });

  describe('confirmation word', () => {
    it('accepts "chay" and "chạy" in any case, trimmed', () => {
      for (const ok of ['chay', 'CHAY', ' chay ', 'ch\u1EA1y', 'CH\u1EA0Y', 'cha\u0323y'.normalize('NFC')]) {
        expect(isConfirmAnswer(ok)).toBe(true);
      }
      for (const no of ['', 'y', 'yes', 'chayy', 'cha']) expect(isConfirmAnswer(no)).toBe(false);
    });
  });
});
