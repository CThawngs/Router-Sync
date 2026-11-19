#!/usr/bin/env node
// C17 T5: layered cold-start measurement.
// Two batches of N samples per layer are separated by an idle interval. Each
// sample starts a fresh Node.js process; app caches use a fresh state directory.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = path.join(ROOT, '.agent', 'work-c17', 'cold-start');
const OUTPUT = path.join(WORK, 'cold-start.json');
const CLI = path.join('packages', 'cli', 'dist', 'index.js');
const CORE = path.join('packages', 'core', 'dist', 'index.js');
const CORE_URL = pathToFileURL(path.join(ROOT, CORE)).href;
const CLI_URL = pathToFileURL(path.join(ROOT, CLI)).href;
const MIN_REST_MS = 180000;

export function parseArgs(argv) {
  let samplesPerBatch = 10;
  let restMs = 180000;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--samples-per-batch') {
      samplesPerBatch = Number(argv[++index]);
    } else if (argv[index] === '--rest-ms') {
      restMs = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (!Number.isInteger(samplesPerBatch) || samplesPerBatch < 10) {
    throw new Error('--samples-per-batch must be an integer >= 10');
  }
  if (!Number.isFinite(restMs) || restMs < MIN_REST_MS) {
    throw new Error(`--rest-ms must be at least ${MIN_REST_MS}`);
  }
  return { samplesPerBatch, restMs };
}

const cumulativeScript = `
const processStartedAt = performance.now();
await import(${JSON.stringify(CORE_URL)});
const coreImportedAt = performance.now();
const cli = await import(${JSON.stringify(CLI_URL)});
const cliImportedAt = performance.now();
const program = cli.createCliProgram().exitOverride();
await program.parseAsync([
  'node',
  'routersync',
  'verify',
  '--mock-3layer',
  '--json',
  '--state-dir',
  process.env.RS_COLD_START_STATE_DIR,
]);
const verifyCompletedAt = performance.now();
const milestones = {
  coreImportMs: coreImportedAt - processStartedAt,
  remainingCliGraphMs: cliImportedAt - coreImportedAt,
  verifyDispatchAndExecutionMs: verifyCompletedAt - cliImportedAt,
  cumulativeJsMs: verifyCompletedAt - processStartedAt,
};
process.stdout.write('\\n[routersync-cold-start] ' + JSON.stringify(milestones) + '\\n');
`;

const layers = [
  {
    name: 'node-runtime',
    args: ['--eval', 'process.exit(0)'],
  },
  {
    name: 'core-import',
    args: [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, CORE)).href)})`,
    ],
  },
  {
    name: 'cli-import',
    args: [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, CLI)).href)})`,
    ],
  },
  {
    name: 'cli-dispatch',
    args: [CLI, '--help'],
  },
  {
    name: 'verify-mock',
    args: [
      CLI,
      'verify',
      '--mock-3layer',
      '--json',
      '--state-dir',
      '__STATE_DIR__',
    ],
  },
  {
    name: 'cumulative-milestones',
    collectMilestones: true,
    args: ['--input-type=module', '--eval', cumulativeScript],
  },
];

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    n: values.length,
    minMs: sorted[0],
    p50Ms: median,
    p95Ms: percentile(values, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function parseCumulativeMilestones(stdout) {
  const match = stdout.match(/\[routersync-cold-start\]\s+(\{[^\r\n]+\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parsePerfDuration(stderr) {
  const match = stderr.match(/\[routersync-perf\]\s+(\{.*\})/);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    return Number.isFinite(payload.durationMs) ? payload.durationMs : null;
  } catch {
    return null;
  }
}

function runLayer(layer, batch, iteration) {
  const stateDir = path.join(
    '.agent',
    'work-c17',
    'cold-start',
    'runs',
    `batch-${batch}`,
    `sample-${iteration}`
  );
  const actualStateDir = path.join(ROOT, stateDir);
  fs.rmSync(actualStateDir, { recursive: true, force: true });
  const args = layer.args.map((arg) =>
    arg === '__STATE_DIR__' ? stateDir : arg
  );
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ROUTERSYNC_PERF: '1',
      RS_COLD_START_STATE_DIR: actualStateDir,
    },
  });
  const durationMs = performance.now() - startedAt;
  fs.rmSync(actualStateDir, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(
      `${layer.name} batch ${batch} sample ${iteration} failed with exit ${result.status}`
    );
  }
  const milestones = layer.collectMilestones
    ? parseCumulativeMilestones(result.stdout ?? '')
    : null;
  if (layer.collectMilestones && !milestones) {
    throw new Error(
      `${layer.name} batch ${batch} sample ${iteration} did not emit cumulative milestones`
    );
  }
  return {
    batch,
    iteration,
    layer: layer.name,
    durationMs: Math.round(durationMs * 10) / 10,
    inProcessMs: parsePerfDuration(result.stderr ?? ''),
    milestones,
  };
}

function rotate(items, offset) {
  const index = offset % items.length;
  return [...items.slice(index), ...items.slice(0, index)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { samplesPerBatch, restMs } = parseArgs(process.argv.slice(2));
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const startedAt = new Date().toISOString();
  const samples = [];
  for (let batch = 1; batch <= 2; batch += 1) {
    for (let iteration = 1; iteration <= samplesPerBatch; iteration += 1) {
      const order = rotate(layers, iteration - 1);
      for (const layer of order) {
        samples.push(runLayer(layer, batch, iteration));
      }
    }
    if (batch === 1) {
      console.log(`idle between batches: ${restMs} ms`);
      await sleep(restMs);
    }
  }

  const byLayer = {};
  for (const layer of layers) {
    const layerSamples = samples.filter((sample) => sample.layer === layer.name);
    byLayer[layer.name] = {
      overall: summarize(layerSamples.map((sample) => sample.durationMs)),
      batch1: summarize(
        layerSamples
          .filter((sample) => sample.batch === 1)
          .map((sample) => sample.durationMs)
      ),
      batch2: summarize(
        layerSamples
          .filter((sample) => sample.batch === 2)
          .map((sample) => sample.durationMs)
      ),
    };
  }

  const cumulativeSamples = samples
    .filter((sample) => sample.layer === 'cumulative-milestones')
    .map((sample) => sample.milestones);
  const cumulativePhases = {};
  for (const phase of [
    'coreImportMs',
    'remainingCliGraphMs',
    'verifyDispatchAndExecutionMs',
    'cumulativeJsMs',
  ]) {
    cumulativePhases[phase] = summarize(
      cumulativeSamples.map((sample) => sample[phase])
    );
  }

  const result = {
    generatedAt: startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      availableParallelism: os.availableParallelism?.() ?? os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemAtStartMB: Math.round(os.freemem() / 1024 / 1024),
    },
    methodology: {
      samplesPerBatch,
      batches: 2,
      restBetweenBatchesMs: restMs,
      freshStatePerVerifySample: true,
      rotatedLayerOrder: true,
      cumulativePhaseMeasurement:
        'milestones recorded inside the same fresh process',
    },
    layers: byLayer,
    cumulativePhases,
    samples,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);

  console.log(
    `COLD START OK: samples=${samples.length}; ${OUTPUT}`
  );
  for (const layer of layers) {
    const summary = byLayer[layer.name].overall;
    console.log(
      `${layer.name}: n=${summary.n} p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms`
    );
  }
  for (const [phase, summary] of Object.entries(cumulativePhases)) {
    console.log(
      `${phase}: n=${summary.n} p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms`
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
