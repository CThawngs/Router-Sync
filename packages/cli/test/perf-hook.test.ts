import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');

describe('C12 M2: ROUTERSYNC_PERF hook', () => {
  it('does not emit perf JSON when ROUTERSYNC_PERF is unset', () => {
    const res = spawnSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_PERF: undefined },
    });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('[routersync-perf]');
  });

  it('emits valid perf JSON on stderr when ROUTERSYNC_PERF=1', () => {
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
    expect(typeof parsed.rssMB).toBe('number');
    expect(parsed.rssMB).toBeGreaterThan(0);
    expect(typeof parsed.heapUsedMB).toBe('number');
  });
});
