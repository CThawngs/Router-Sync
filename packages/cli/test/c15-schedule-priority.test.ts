import { describe, it, expect } from 'vitest';
import { buildTickScheduleArtifacts } from '../src/commands/schedule.js';

const a = buildTickScheduleArtifacts({ mode: 'propose', logDir: '/tmp/rs-log' });

describe('C15 Q2.4: low-priority schedule artifacts', () => {
  it('Windows XML has low Priority, IgnoreNew, short execution limit, no battery run', () => {
    expect(a.windowsXml).toContain('<Priority>7</Priority>');
    expect(a.windowsXml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(a.windowsXml).toContain('<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>');
    expect(a.windowsXml).toContain('<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>');
  });

  it('systemd unit has Nice, idle IO, CPUWeight and MemoryHigh', () => {
    expect(a.systemdUnit).toContain('Nice=10');
    expect(a.systemdUnit).toContain('IOSchedulingClass=idle');
    expect(a.systemdUnit).toContain('CPUWeight=20');
    expect(a.systemdUnit).toContain('MemoryHigh=512M');
  });

  it('launchd plist has Background process type, LowPriorityIO and Nice', () => {
    expect(a.launchdPlist).toContain('<key>ProcessType</key><string>Background</string>');
    expect(a.launchdPlist).toContain('<key>LowPriorityIO</key><true/>');
    expect(a.launchdPlist).toContain('<key>Nice</key><integer>10</integer>');
  });
});
