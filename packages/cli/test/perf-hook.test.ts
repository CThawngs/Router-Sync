import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');

describe('C13: ROUTERSYNC_PERF hook (maxRSS)', () => {
  it('does not emit perf JSON when ROUTERSYNC_PERF is unset', () => {
    const res = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_PERF: undefined },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('[routersync-perf]');
  });

  it('emits valid perf JSON with maxRssMB on stderr when ROUTERSYNC_PERF=1', () => {
    const res = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_PERF: '1' },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('[routersync-perf]');
    const match = res.stderr.match(/\[routersync-perf\]\s+(\{.*\})/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(typeof parsed.pid).toBe('number');
    expect(typeof parsed.durationMs).toBe('number');
    expect(parsed.durationMs).toBeGreaterThan(0);
    expect(typeof parsed.cpuUserMs).toBe('number');
    expect(typeof parsed.cpuSystemMs).toBe('number');
    // C13: maxRssMB replaces rssMB (uses process.resourceUsage().maxRSS)
    expect(typeof parsed.maxRssMB).toBe('number');
    // maxRssMB can be 0 for very short-lived processes (< 1 MB)
    expect(parsed.maxRssMB).toBeGreaterThanOrEqual(0);
    // rssMB must NOT be present (mutation guard)
    expect(parsed.rssMB).toBeUndefined();
    expect(typeof parsed.heapUsedMB).toBe('number');
  });
});
