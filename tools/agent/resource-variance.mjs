#!/usr/bin/env node
/**
 * tools/agent/resource-variance.mjs
 *
 * Milestone M3-02 (P5): Variance-aware cold-start & idle-memory benchmark
 * for `@routersync/cli` and `@routersync/daemon`.
 *
 * Safety invariants:
 *   - Zero live router contact: sample fixture uses `http://127.0.0.1:9`.
 *   - Never touches forbidden live ports `20128`, `30128`, or `3128`.
 *   - Dynamically reserves a free ephemeral port on `127.0.0.1` in `49152..65535`.
 *   - Records `freeMemMB` across iterations (`freeMemStartMB`, `freeMemMinMB`, `freeMemEndMB`).
 *
 * Usage:
 *   node tools/agent/resource-variance.mjs [--runs 7] [--idle-ms 250] [--json]
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SELF_PATH = fileURLToPath(import.meta.url);

export const FORBIDDEN_LIVE_PORTS = Object.freeze([20128, 30128, 3128]);

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Pure variance statistics helper.
 * Uses sample standard deviation (`n - 1` denominator) for `n >= 2`.
 */
export function computeVarianceStats(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('computeVarianceStats requires a non-empty numeric array');
  }
  const nums = values.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) {
    throw new Error('computeVarianceStats received a non-finite number');
  }

  const n = nums.length;
  const sum = nums.reduce((acc, v) => acc + v, 0);
  const meanRaw = sum / n;
  const varianceRaw =
    n >= 2
      ? nums.reduce((acc, v) => acc + (v - meanRaw) ** 2, 0) / (n - 1)
      : 0;
  const stddevRaw = Math.sqrt(varianceRaw);
  const minRaw = Math.min(...nums);
  const maxRaw = Math.max(...nums);

  return {
    n,
    mean: round2(meanRaw),
    stddev: round2(stddevRaw),
    min: round2(minRaw),
    max: round2(maxRaw),
  };
}

export function parseResourceVarianceArgs(argv = process.argv.slice(2)) {
  let runs = 7;
  let idleMs = 250;
  let json = false;
  let allowSmallN = false;
  let childMode = null;
  let childPort = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs') {
      runs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--idle-ms') {
      idleMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--allow-small-n') {
      allowSmallN = true;
    } else if (arg === '--child-cli') {
      childMode = 'cli';
    } else if (arg === '--child-daemon') {
      childMode = 'daemon';
      childPort = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown resource-variance argument: ${arg}`);
    }
  }

  if (!Number.isInteger(idleMs) || idleMs < 0) {
    throw new Error(`Invalid --idle-ms value: ${idleMs}`);
  }

  if (!childMode) {
    if (!Number.isInteger(runs) || runs < 2) {
      throw new Error(`Invalid --runs value: ${runs} (must be integer >= 2)`);
    }
    if (!allowSmallN && runs < 7) {
      throw new Error(`--runs must be >= 7 (got ${runs})`);
    }
  }

  return { runs, idleMs, json, allowSmallN, childMode, childPort };
}

function tryBindPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Reserve a free ephemeral loopback port strictly within `49152..65535` on `127.0.0.1`.
 * Explicitly refuses `20128`, `30128`, and `3128`.
 */
export async function reserveEphemeralPort() {
  const minPort = 49152;
  const maxPort = 65535;
  const span = maxPort - minPort + 1;
  const startOffset = Math.floor(Math.random() * span);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = minPort + ((startOffset + attempt * 37) % span);
    if (
      candidate < minPort ||
      candidate > maxPort ||
      FORBIDDEN_LIVE_PORTS.includes(candidate)
    ) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const ok = await tryBindPort(candidate);
    if (ok) return candidate;
  }

  throw new Error('Unable to reserve a free ephemeral port in 49152..65535 on 127.0.0.1');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChildCliWorker(idleMs) {
  const cliUrl = pathToFileURL(
    path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')
  ).href;
  const { createCliProgram } = await import(cliUrl);

  let capturedStdout = '';
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    capturedStdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };

  try {
    const fakeHome = process.env.HOME || os.tmpdir();
    await createCliProgram().parseAsync([
      'node',
      'routersync',
      'doctor',
      '--json',
      '--hermes',
      path.join(fakeHome, 'missing-hermes.json'),
      '--dsh',
      path.join(fakeHome, 'missing-dsh.yml'),
    ]);
  } finally {
    process.stdout.write = origStdoutWrite;
  }

  const parsed = JSON.parse(capturedStdout);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('CLI doctor --json returned invalid payload');
  }

  if (typeof process.send === 'function') {
    process.send({ type: 'cli_ready' });
  }

  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
  await sleep(idleMs);

  const mem = process.memoryUsage();
  const metrics = {
    type: 'cli_metrics',
    idleRssMB: round2(mem.rss / 1048576),
    idleHeapMB: round2(mem.heapUsed / 1048576),
  };

  if (typeof process.send === 'function') {
    await new Promise((resolve) => process.send(metrics, resolve));
    if (typeof process.disconnect === 'function') process.disconnect();
  } else {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  }
}

async function runChildDaemonWorker(port, idleMs) {
  if (!Number.isInteger(port) || port < 49152 || port > 65535 || FORBIDDEN_LIVE_PORTS.includes(port)) {
    throw new Error(`Refusing daemon benchmark on invalid/forbidden port: ${port}`);
  }

  const daemonUrl = pathToFileURL(
    path.join(REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js')
  ).href;
  const { startDaemonServer } = await import(daemonUrl);

  const { server } = await startDaemonServer({ host: '127.0.0.1', port });

  const shutdown = async () => {
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
    await sleep(idleMs);
    const mem = process.memoryUsage();
    const metrics = {
      type: 'daemon_metrics',
      idleRssMB: round2(mem.rss / 1048576),
      idleHeapMB: round2(mem.heapUsed / 1048576),
    };
    await new Promise((resolve) => server.close(() => resolve()));
    if (typeof process.send === 'function') {
      await new Promise((resolve) => process.send(metrics, resolve));
      if (typeof process.disconnect === 'function') process.disconnect();
    }
    process.exit(0);
  };

  process.on('message', (msg) => {
    if (msg && msg.type === 'sample_and_shutdown') {
      shutdown().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    }
  });

  process.once('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}

function httpGetHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/health',
        headers: {
          Host: `127.0.0.1:${port}`,
          Connection: 'close',
        },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function measureCliIteration(idleMs, childEnv) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let coldStartMs = null;
    let metrics = null;
    let stderrBuf = '';

    const child = spawn(
      process.execPath,
      ['--expose-gc', SELF_PATH, '--child-cli', '--idle-ms', String(idleMs)],
      {
        cwd: REPO_ROOT,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }
    );

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('message', (msg) => {
      if (msg?.type === 'cli_ready' && coldStartMs === null) {
        coldStartMs = round2(Number(process.hrtime.bigint() - t0) / 1_000_000);
      } else if (msg?.type === 'cli_metrics') {
        metrics = msg;
      }
    });

    child.on('error', (err) => reject(err));

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`CLI benchmark child exited ${code}: ${stderrBuf.slice(0, 400)}`));
        return;
      }
      if (coldStartMs === null || !metrics) {
        reject(new Error(`CLI benchmark child missing IPC metrics: ${stderrBuf.slice(0, 400)}`));
        return;
      }
      resolve({
        coldStartMs,
        idleRssMB: metrics.idleRssMB,
        idleHeapMB: metrics.idleHeapMB,
      });
    });
  });
}

async function measureDaemonIteration(idleMs, childEnv) {
  const port = await reserveEphemeralPort();
  if (FORBIDDEN_LIVE_PORTS.includes(port) || port < 49152) {
    throw new Error(`Unsafe port selected: ${port}`);
  }

  const t0 = process.hrtime.bigint();
  let stderrBuf = '';
  let metrics = null;

  const child = spawn(
    process.execPath,
    ['--expose-gc', SELF_PATH, '--child-daemon', String(port), '--idle-ms', String(idleMs)],
    {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  child.on('message', (msg) => {
    if (msg?.type === 'daemon_metrics') {
      metrics = msg;
    }
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });

  try {
    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Daemon exited prematurely (${child.exitCode}): ${stderrBuf.slice(0, 400)}`
        );
      }
      // eslint-disable-next-line no-await-in-loop
      healthy = await httpGetHealth(port);
      if (healthy) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(15);
    }

    if (!healthy) {
      throw new Error(`Timed out polling daemon /api/v1/health on 127.0.0.1:${port}`);
    }

    const coldStartMs = round2(Number(process.hrtime.bigint() - t0) / 1_000_000);
    child.send({ type: 'sample_and_shutdown' });

    const exitCode = await exitPromise;
    if (exitCode !== 0 || !metrics) {
      throw new Error(
        `Daemon benchmark child failed on shutdown (exit ${exitCode}): ${stderrBuf.slice(0, 400)}`
      );
    }

    return {
      port,
      coldStartMs,
      idleRssMB: metrics.idleRssMB,
      idleHeapMB: metrics.idleHeapMB,
    };
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
}

function buildIsolatedFixture(tmpRoot) {
  const sampleDir = path.join(tmpRoot, 'sample');
  const fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const makeSampleScript = path.join(REPO_ROOT, 'tools', 'ci', 'make-sample-state.mjs');
  const res = spawnSync(process.execPath, [makeSampleScript, sampleDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(
      `Failed to prepare sample state: ${(res.stderr || res.stdout || '').slice(0, 400)}`
    );
  }

  const childEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    XDG_STATE_HOME: path.join(fakeHome, '.local', 'state'),
    ROUTERSYNC_9ROUTER_DB: path.join(sampleDir, '9router.sqlite'),
    ROUTERSYNC_OMNIROUTE_DB: path.join(sampleDir, 'omniroute.sqlite'),
    ROUTERSYNC_STATE_DIR: path.join(sampleDir, 'state'),
    ROUTERSYNC_CONFIG: path.join(sampleDir, 'routersync.yaml'),
  };

  delete childEnv.OMNIROUTE_DB_PATH;
  delete childEnv.NINEROUTER_DB_PATH;
  delete childEnv.NINE_ROUTER_DB_PATH;
  delete childEnv.DATA_DIR;
  delete childEnv.ROUTERSYNC_DAEMON_TOKEN;
  delete childEnv.ROUTERSYNC_DAEMON_TOKEN_FILE;
  delete childEnv.ROUTERSYNC_PERF;

  return { childEnv };
}

async function runBenchmark(opts) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-resource-variance-'));

  try {
    const { childEnv } = buildIsolatedFixture(tmpRoot);

    const freeSamples = [];
    const cliColdStartSamples = [];
    const cliIdleRssSamples = [];
    const cliIdleHeapSamples = [];
    const daemonColdStartSamples = [];
    const daemonIdleRssSamples = [];
    const daemonIdleHeapSamples = [];
    const daemonPorts = [];

    for (let i = 0; i < opts.runs; i += 1) {
      freeSamples.push(Math.round(os.freemem() / 1048576));

      // eslint-disable-next-line no-await-in-loop
      const cliSample = await measureCliIteration(opts.idleMs, childEnv);
      cliColdStartSamples.push(cliSample.coldStartMs);
      cliIdleRssSamples.push(cliSample.idleRssMB);
      cliIdleHeapSamples.push(cliSample.idleHeapMB);

      // eslint-disable-next-line no-await-in-loop
      const daemonSample = await measureDaemonIteration(opts.idleMs, childEnv);
      daemonPorts.push(daemonSample.port);
      daemonColdStartSamples.push(daemonSample.coldStartMs);
      daemonIdleRssSamples.push(daemonSample.idleRssMB);
      daemonIdleHeapSamples.push(daemonSample.idleHeapMB);
    }

    const freeMemEndMB = Math.round(os.freemem() / 1048576);
    freeSamples.push(freeMemEndMB);
    const freeMemStartMB = freeSamples[0];
    const freeMemMinMB = Math.min(...freeSamples);

    const metrics = {
      cliColdStartMs: computeVarianceStats(cliColdStartSamples),
      cliIdleRssMB: computeVarianceStats(cliIdleRssSamples),
      cliIdleHeapMB: computeVarianceStats(cliIdleHeapSamples),
      daemonColdStartMs: computeVarianceStats(daemonColdStartSamples),
      daemonIdleRssMB: computeVarianceStats(daemonIdleRssSamples),
      daemonIdleHeapMB: computeVarianceStats(daemonIdleHeapSamples),
    };

    const payload = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      runs: opts.runs,
      idleMs: opts.idleMs,
      fixtureBaseUrl: 'http://127.0.0.1:9',
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemStartMB,
      freeMemMinMB,
      freeMemEndMB,
      daemonPorts,
      metrics,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(
      `# RouterSync Resource Variance Benchmark (platform=${payload.platform}/${payload.arch} node=${payload.node} runs=${payload.runs} idleMs=${payload.idleMs})`
    );
    console.log(
      `# Host Memory: totalMemMB=${payload.totalMemMB} freeMemStartMB=${payload.freeMemStartMB} freeMemMinMB=${payload.freeMemMinMB} freeMemEndMB=${payload.freeMemEndMB}`
    );
    console.log(
      'target                 |  n |   mean | stddev |    min |    max | unit'
    );
    console.log(
      '-----------------------+----+--------+--------+--------+--------+-----'
    );

    const rows = [
      ['cli_cold_start_ms', metrics.cliColdStartMs, 'ms'],
      ['cli_idle_rss_mb', metrics.cliIdleRssMB, 'MB'],
      ['cli_idle_heap_mb', metrics.cliIdleHeapMB, 'MB'],
      ['daemon_cold_start_ms', metrics.daemonColdStartMs, 'ms'],
      ['daemon_idle_rss_mb', metrics.daemonIdleRssMB, 'MB'],
      ['daemon_idle_heap_mb', metrics.daemonIdleHeapMB, 'MB'],
    ];

    for (const [label, stat, unit] of rows) {
      console.log(
        `${label.padEnd(22)} | ${String(stat.n).padStart(2)} | ${stat.mean.toFixed(2).padStart(6)} | ${stat.stddev.toFixed(2).padStart(6)} | ${stat.min.toFixed(2).padStart(6)} | ${stat.max.toFixed(2).padStart(6)} | ${unit}`
      );
    }

    for (const [label, stat] of rows) {
      console.log(
        `RESOURCE_VARIANCE target=${label} n=${stat.n} mean=${stat.mean.toFixed(2)} stddev=${stat.stddev.toFixed(2)} min=${stat.min.toFixed(2)} max=${stat.max.toFixed(2)} freeMemStartMB=${freeMemStartMB} freeMemMinMB=${freeMemMinMB} freeMemEndMB=${freeMemEndMB}`
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseResourceVarianceArgs();
  if (opts.childMode === 'cli') {
    await runChildCliWorker(opts.idleMs);
    return;
  }
  if (opts.childMode === 'daemon') {
    await runChildDaemonWorker(opts.childPort, opts.idleMs);
    return;
  }
  await runBenchmark(opts);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    console.error(`RESOURCE_VARIANCE FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
