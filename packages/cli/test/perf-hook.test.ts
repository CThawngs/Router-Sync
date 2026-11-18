import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxRssKbToMb } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');

describe('C15 Q1.2: ROUTERSYNC_PERF maxRSS unit', () => {
  it('converts kilobytes to MB on every platform', () => {
    expect(maxRssKbToMb(4096)).toBe(4);
    expect(maxRssKbToMb(5120)).toBe(5);
    expect(maxRssKbToMb(1024 * 48)).toBe(48);
  });

  it('does not emit perf JSON when ROUTERSYNC_PERF is unset', () => {
    const res = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_PERF: undefined },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('[routersync-perf]');
  });

  it('emits maxRssMB > 0 for a real --version run with ROUTERSYNC_PERF=1', () => {
    const res = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_PERF: '1' },
    });
    expect(res.status).toBe(0);
    const match = res.stderr.match(/\[routersync-perf\]\s+(\{.*\})/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.maxRssMB).toBeGreaterThan(0);
    expect(parsed.rssMB).toBeUndefined();
    expect(typeof parsed.heapUsedMB).toBe('number');
  });
});
