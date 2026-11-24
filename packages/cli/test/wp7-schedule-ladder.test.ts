/**
 * packages/cli/test/wp7-schedule-ladder.test.ts
 *
 * C45-WP7 Red-First CLI Tests (Phục vụ: S6, S7):
 *  - `linuxCron` generation (`%` -> `\%` crontab escaping, `# routersync-tick` marker, newline/quote rejection)
 *  - Idempotent Linux crontab install/uninstall (`mergeLinuxCrontab`, `removeLinuxCrontabEntry`, `--scheduler auto|systemd|cron`)
 *  - `--harness <all 9>` `--dry-run --json` zero-write & Tier 1 vs Tier 2 classification (kills M1 & M4)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHarnessMatrix } from '@routersync/core';
import {
  buildTickScheduleArtifacts,
  mergeLinuxCrontab,
  removeLinuxCrontabEntry,
  runScheduleCommand,
  type TickInvocation,
} from '../src/commands/schedule.js';

describe('C45-WP7: Linux Crontab Artifact, Fallback & 9-Harness Dry-Run CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp7-cli-sched-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds linuxCron with escaped %, # routersync-tick marker, and daily 0 0 * * * support (kills M4)', () => {
    const inv: TickInvocation = {
      node: '/opt/node 100%/bin/node',
      script: '/opt/rs%dir/packages/cli/dist/index.js',
    };
    const artifacts15 = buildTickScheduleArtifacts({
      intervalMinutes: 15,
      mode: 'propose',
      invocation: inv,
      logDir: '/var/log/rs%state',
    });

    expect(artifacts15.linuxCron).toBeDefined();
    expect(artifacts15.linuxCron.startsWith('*/15 * * * * ')).toBe(true);
    expect(artifacts15.linuxCron.endsWith('# routersync-tick')).toBe(true);
    expect(artifacts15.linuxCron).not.toContain('\n');
    // Literal % MUST be escaped as \% in crontab(5)
    expect(artifacts15.linuxCron).toContain('100\\%');
    expect(artifacts15.linuxCron).toContain('rs\\%dir');
    expect(artifacts15.linuxCron).toContain('rs\\%state');
    expect(artifacts15.linuxCron).not.toMatch(/(?<!\\)%/);

    const artifactsDaily = buildTickScheduleArtifacts({
      intervalMinutes: 1440,
      mode: 'observe',
      invocation: { node: '/usr/bin/node', script: '/opt/rs/index.js' },
      logDir: '/var/rs',
    });
    expect(artifactsDaily.linuxCron.startsWith('0 0 * * * ')).toBe(true);
    expect(artifactsDaily.linuxCron.endsWith('# routersync-tick')).toBe(true);
  });

  it('merges and removes # routersync-tick idempotently without clobbering user cron entries (kills M4)', () => {
    const existing = [
      '# User backup cron',
      '0 3 * * * /usr/local/bin/backup.sh',
      '*/30 * * * * "/usr/bin/node" "/old/index.js" tick # routersync-tick',
      '15 4 * * 0 /usr/local/bin/weekly-clean.sh',
      '',
    ].join('\n');

    const newLine =
      '*/15 * * * * "/usr/bin/node" "/new/index.js" tick --mode propose >> "/tmp/logs/cron-tick.log" 2>&1 # routersync-tick';

    const mergedOnce = mergeLinuxCrontab(existing, newLine);
    const mergedTwice = mergeLinuxCrontab(mergedOnce, newLine);
    expect(mergedOnce).toBe(mergedTwice);
    expect(mergedOnce).toContain('0 3 * * * /usr/local/bin/backup.sh');
    expect(mergedOnce).toContain('15 4 * * 0 /usr/local/bin/weekly-clean.sh');
    expect(mergedOnce).not.toContain('/old/index.js');
    expect(mergedOnce.match(/# routersync-tick/g)).toHaveLength(1);

    const cleaned = removeLinuxCrontabEntry(mergedOnce);
    expect(cleaned).toContain('0 3 * * * /usr/local/bin/backup.sh');
    expect(cleaned).toContain('15 4 * * 0 /usr/local/bin/weekly-clean.sh');
    expect(cleaned).not.toContain('# routersync-tick');
  });

  it('falls back from systemd to cron on Linux when --scheduler auto sees unavailable systemctl --user', async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string | undefined }> = [];
    let currentCrontab = '0 2 * * * /bin/echo keep-me\n';

    const mockSpawn = (cmd: string, args: string[], opts?: { input?: string }) => {
      calls.push({ cmd, args, input: opts?.input });
      if (cmd === 'systemctl') {
        return { status: 1, stdout: '', stderr: 'Failed to connect to bus' };
      }
      if (cmd === 'crontab' && args[0] === '-l') {
        return { status: 0, stdout: currentCrontab, stderr: '' };
      }
      if (cmd === 'crontab' && args[0] === '-') {
        currentCrontab = opts?.input ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const stateDir = path.join(tmpDir, 'state');
    const homeDir = path.join(tmpDir, 'home');
    await runScheduleCommand({
      action: 'install',
      scheduler: 'auto',
      stateDir,
      homeDir,
      platformOverride: 'linux',
      allowNonTtyForTest: true,
      spawnFn: mockSpawn as never,
    });

    expect(currentCrontab).toContain('/bin/echo keep-me');
    expect(currentCrontab).toContain('# routersync-tick');

    await runScheduleCommand({
      action: 'uninstall',
      scheduler: 'cron',
      stateDir,
      homeDir,
      platformOverride: 'linux',
      allowNonTtyForTest: true,
      spawnFn: mockSpawn as never,
    });
    expect(currentCrontab).toContain('/bin/echo keep-me');
    expect(currentCrontab).not.toContain('# routersync-tick');
  });

  it('executes --dry-run --json across all 9 harnesses with zero disk writes and strict Tier 1/2 separation (kills M1)', async () => {
    const matrix = loadHarnessMatrix();
    const stateDir = path.join(tmpDir, 'never-created-state');

    for (const h of matrix.harnesses) {
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
        logs.push(String(msg));
      });
      try {
        await runScheduleCommand({
          action: 'install',
          dryRun: true,
          harness: h.id,
          scheduler: 'auto',
          stateDir,
          json: true,
        });
      } finally {
        spy.mockRestore();
      }

      expect(fs.existsSync(stateDir)).toBe(false);
      const parsed = JSON.parse(logs.join('\n')) as Record<string, any>;
      expect(parsed.dryRun).toBe(true);
      expect(typeof parsed.linuxCron).toBe('string');
      expect(parsed.linuxCron).toContain('# routersync-tick');

      if (h.id === 'hermes' || h.id === 'antigravity') {
        expect(parsed.harnessPlan.harnessNativeSupported).toBe(true);
        expect(parsed.harnessPlan.ladderTier).toBe('harness-native');
      } else {
        expect(parsed.harnessPlan.harnessNativeSupported).toBe(false);
        expect(parsed.harnessPlan.ladderTier).toBe('os-scheduler');
        expect(parsed.harnessPlan.fallbackTiers).toContain('tick-if-due');
      }
    }
  });
});
