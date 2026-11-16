import { describe, it, expect } from 'vitest';
import { buildScheduleArtifacts, buildTickScheduleArtifacts, DEFAULT_INTERVAL_MINUTES } from '../src/commands/schedule.js';
import { computeBackoffMs, classifyFailureLabel } from '../src/commands/tick.js';
import { CAPABILITIES, AUTOMATION_LEVELS } from '../../daemon/src/capability.js';

describe('ROUND C2 daemon/schedule', () => {
  it('default interval 15min, all 3 OS artifacts present', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(15);
    const a = buildScheduleArtifacts();
    expect(a.windowsXml).toContain('PT15M');
    expect(a.systemdUnit.length).toBeGreaterThan(0);
    expect(a.systemdTimer).toContain('OnUnitActiveSec');
    expect(a.launchdPlist).toContain('<integer>900</integer>');
  });

  it('custom interval reflected in all artifacts', () => {
    const a = buildScheduleArtifacts({ intervalMinutes: 30 });
    expect(a.windowsXml).toContain('PT30M');
    expect(a.systemdTimer).toContain('30min');
    expect(a.launchdPlist).toContain('<integer>1800</integer>');
  });

  it('dry-run only: uninstall commands exist, nothing executes creation', () => {
    const a = buildScheduleArtifacts();
    expect(a.uninstallCommands).toHaveLength(3);
    expect(a.uninstallCommands.join('\n')).toContain('schtasks /delete');
    expect(a.uninstallCommands.join('\n')).toContain('systemctl --user disable');
    expect(a.uninstallCommands.join('\n')).toContain('launchctl unload');
    const all = Object.values(a).flat().join('\n');
    expect(all).not.toContain('schtasks /create');
  });

  it('B4 schedule artifacts: login task observe, IgnoreNew, systemd oneshot, launchd RunAtLoad without KeepAlive', () => {
    const a = buildScheduleArtifacts();
    expect(a.windowsXml).toContain('LogonTrigger');
    expect(a.windowsXml).toContain('MultipleInstancesPolicy>IgnoreNew');
    expect(a.windowsXml).toContain('daemon --mode observe');
    expect(a.systemdUnit).toContain('Type=oneshot');
    expect(a.systemdUnit).not.toContain('Restart=');
    expect(a.systemdUnit).toContain('WantedBy=default.target');
    expect(a.systemdUnit).toContain('AUTONOMY=observe');
    expect(a.systemdUnit).not.toContain('AUTONOMY=propose');
    expect(a.launchdPlist).toContain('RunAtLoad');
    expect(a.launchdPlist).not.toContain('KeepAlive');
    expect(a.uninstallCommands[0]).toContain('RouterSync');
    expect(a.uninstallCommands[1]).toContain('routersync-daemon');
    expect(a.uninstallCommands[2]).toContain('com.routersync.daemon');
  });

  it('registry ids unique; automation has no full', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...AUTOMATION_LEVELS]).toEqual(['observe', 'propose', 'auto-safe']);
    expect(AUTOMATION_LEVELS).not.toContain('full');
  });

  it('F1 tick schedule artifacts & backoff / failure labels', () => {
    const def = buildTickScheduleArtifacts();
    expect(def.windowsXml).toContain('tick --mode propose');
    expect(def.systemdUnit).toContain('AUTONOMY=propose');
    const t = buildTickScheduleArtifacts({ intervalMinutes: 15, mode: 'observe' });
    expect(t.windowsXml).toContain('tick --mode observe');
    expect(t.systemdUnit).toMatch(/ExecStart=.* tick --mode observe/);
    expect(t.launchdPlist).toContain('<string>tick</string>');
    expect(computeBackoffMs(1)).toBe(120_000);
    expect(computeBackoffMs(2)).toBe(240_000);
    expect(computeBackoffMs(20)).toBe(21_600_000);
    expect(classifyFailureLabel(429)).toBe('QUOTA');
    expect(classifyFailureLabel(503)).toBe('TRANSIENT');
    expect(classifyFailureLabel(401)).toBe('AUTH_ERROR');
  });
});
