import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_LIVE_PORTS,
  computeVarianceStats,
  parseResourceVarianceArgs,
  reserveEphemeralPort,
} from '../../tools/agent/resource-variance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'tools', 'agent', 'resource-variance.mjs');

describe('M3-02 (P5): resource-variance stats, CLI flags, port isolation, and CLI+daemon benchmark', () => {
  test('computeVarianceStats calculates exact n, mean, sample stddev (n - 1), min, and max', () => {
    const stats = computeVarianceStats([10, 12, 14, 16, 18, 20, 22]);
    assert.deepEqual(stats, {
      n: 7,
      mean: 16,
      stddev: 4.32,
      min: 10,
      max: 22,
    });

    const uniform = computeVarianceStats([5, 5, 5, 5, 5, 5, 5]);
    assert.deepEqual(uniform, {
      n: 7,
      mean: 5,
      stddev: 0,
      min: 5,
      max: 5,
    });
  });

  test('parseResourceVarianceArgs defaults to runs=7 and rejects runs < 7 without --allow-small-n', () => {
    const defaults = parseResourceVarianceArgs([]);
    assert.equal(defaults.runs, 7);
    assert.equal(defaults.idleMs, 250);
    assert.equal(defaults.json, false);

    assert.throws(
      () => parseResourceVarianceArgs(['--runs', '3']),
      /runs.*>= 7|at least 7/i
    );

    const smallAllowed = parseResourceVarianceArgs([
      '--runs',
      '2',
      '--allow-small-n',
      '--idle-ms',
      '50',
      '--json',
    ]);
    assert.equal(smallAllowed.runs, 2);
    assert.equal(smallAllowed.idleMs, 50);
    assert.equal(smallAllowed.json, true);
  });

  test('reserveEphemeralPort binds 127.0.0.1 in 49152..65535 and never returns forbidden live ports', async () => {
    assert.deepEqual([...FORBIDDEN_LIVE_PORTS].sort((a, b) => a - b), [3128, 20128, 30128]);
    const port = await reserveEphemeralPort();
    assert.ok(port >= 49152 && port <= 65535, `Expected ephemeral port >= 49152, got ${port}`);
    assert.ok(!FORBIDDEN_LIVE_PORTS.includes(port));
  });

  test('end-to-end resource-variance CLI measures CLI + daemon cold-start & idle RSS with freeMemMB and zero live port contact', () => {
    const rejected = spawnSync(process.execPath, [SCRIPT_PATH, '--runs', '3'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0, 'runs < 7 without --allow-small-n must fail');

    const run = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--runs', '2', '--allow-small-n', '--idle-ms', '50', '--json'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120000,
      }
    );
    assert.equal(
      run.status,
      0,
      `resource-variance failed (exit ${run.status}): ${run.stderr || run.stdout}`
    );

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.runs, 2);
    assert.equal(payload.fixtureBaseUrl, 'http://127.0.0.1:9');
    assert.equal(typeof payload.freeMemStartMB, 'number');
    assert.equal(typeof payload.freeMemMinMB, 'number');
    assert.equal(typeof payload.freeMemEndMB, 'number');
    assert.ok(payload.freeMemMinMB > 0);

    assert.equal(payload.daemonPorts.length, 2);
    for (const port of payload.daemonPorts) {
      assert.ok(port >= 49152 && port <= 65535, `daemon port ${port} outside 49152..65535`);
      assert.ok(!FORBIDDEN_LIVE_PORTS.includes(port), `daemon touched forbidden port ${port}`);
    }

    for (const key of [
      'cliColdStartMs',
      'cliIdleRssMB',
      'daemonColdStartMs',
      'daemonIdleRssMB',
    ]) {
      const m = payload.metrics[key];
      assert.ok(m, `missing metric ${key}`);
      assert.equal(m.n, 2);
      assert.ok(m.mean > 0, `${key}.mean must be > 0`);
      assert.ok(m.min <= m.mean && m.mean <= m.max, `${key} min/mean/max ordering invalid`);
      assert.ok(Number.isFinite(m.stddev) && m.stddev >= 0, `${key}.stddev must be >= 0`);
    }
  });
});
