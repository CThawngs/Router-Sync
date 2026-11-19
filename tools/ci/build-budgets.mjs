#!/usr/bin/env node
// Rebuild budgets.json from GitHub Actions logs captured with `gh run view --log`.
// Usage: node tools/ci/build-budgets.mjs --run <runId>=<logPath> --source <runId>=push,main,success,<createdAt>,<headSha> [--out budgets.json]
import fs from 'node:fs';
import path from 'node:path';
import { deriveBudget, summarizeSamplesByRunner, DEFAULT_FLOORS } from './budgets.mjs';

const RUNNER_ARCH = Object.freeze({
  'ubuntu-latest': 'x64',
  'ubuntu-24.04-arm': 'arm64',
  'macos-latest': 'arm64',
  'windows-latest': 'x64',
  'windows-11-arm': 'arm64',
});

function parseBudgetLines(logText, runId) {
  const samples = [];
  for (const line of logText.split(/\r?\n/)) {
    const budget = line.match(/BUDGET OK (\S+) \((linux|darwin|win32)\): ([0-9.]+) ms \/ ([0-9]+) MB/);
    if (!budget) continue;
    const job = line.split('\t')[0];
    const jobInfo = job.match(/verify \(([^,]+), node (\d+)\)/);
    if (!jobInfo) continue;
    const [, runner, nodeText] = jobInfo;
    const arch = RUNNER_ARCH[runner];
    if (!arch) throw new Error(`Unknown runner architecture: ${runner}`);
    samples.push({
      command: budget[1],
      os: budget[2],
      ms: Number(budget[3]),
      mb: Number(budget[4]),
      runner,
      arch,
      node: Number(nodeText),
      runId,
    });
  }
  return samples;
}

function parseArgs(argv) {
  const runs = [];
  let output = 'budgets.json';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') {
      const value = argv[++index] ?? '';
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error('Expected --run <runId>=<logPath>');
      }
      const run = {
        id: value.slice(0, separator),
        logPath: value.slice(separator + 1),
        event: '',
        branch: '',
        conclusion: '',
        createdAt: '',
        headSha: '',
      };
      const existing = runs.find((candidate) => candidate.id === run.id);
      if (existing) {
        if (existing.logPath) throw new Error(`Duplicate budget source run: ${run.id}`);
        existing.logPath = run.logPath;
      } else {
        runs.push(run);
      }
      continue;
    }
    if (arg === '--source') {
      const value = argv[++index] ?? '';
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(
          'Expected --source <runId>=<event>,<branch>,<conclusion>,<createdAt>,<headSha>'
        );
      }
      const [event, branch, conclusion, createdAt, headSha] = value
        .slice(separator + 1)
        .split(',');
      if (!event || !branch || !conclusion || !createdAt || !headSha) {
        throw new Error(
          'Expected --source <runId>=<event>,<branch>,<conclusion>,<createdAt>,<headSha>'
        );
      }
      if (Number.isNaN(Date.parse(createdAt))) {
        throw new Error(`Budget source run ${value.slice(0, separator)} has an invalid createdAt`);
      }
      if (!/^[0-9a-f]{40}$/i.test(headSha)) {
        throw new Error(`Budget source run ${value.slice(0, separator)} has an invalid headSha`);
      }
      const source = {
        id: value.slice(0, separator),
        logPath: '',
        event,
        branch,
        conclusion,
        createdAt,
        headSha,
      };
      const existing = runs.find((candidate) => candidate.id === source.id);
      if (existing) {
        if (existing.event) throw new Error(`Duplicate budget source metadata: ${source.id}`);
        existing.event = source.event;
        existing.branch = source.branch;
        existing.conclusion = source.conclusion;
        existing.createdAt = source.createdAt;
        existing.headSha = source.headSha;
      } else {
        runs.push(source);
      }
      continue;
    }
    if (arg === '--out') {
      output = argv[++index] ?? '';
      if (!output) throw new Error('Expected --out <path>');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (runs.length === 0) throw new Error('At least one --run is required');
  return { runs, output };
}

const args = parseArgs(process.argv.slice(2));
const allSamples = [];
for (const run of args.runs) {
  if (!run.logPath) continue;
  const text = fs.readFileSync(path.resolve(run.logPath), 'utf8');
  allSamples.push(...parseBudgetLines(text, run.id));
}
if (allSamples.length === 0) throw new Error('No BUDGET OK samples found');

const runIds = args.runs.map((run) => run.id);
if (new Set(runIds).size !== runIds.length) {
  throw new Error('Budget source runs must be unique');
}
if (args.runs.length !== 3) {
  throw new Error('Budget generation requires exactly three verified main-branch CI runs');
}
for (const run of args.runs) {
  if (!/^[0-9]+$/.test(run.id)) {
    throw new Error(`Budget source run id must be numeric: ${run.id}`);
  }
  if (!run.logPath) {
    throw new Error(`Budget source run ${run.id} is missing its captured log`);
  }
  if (run.event !== 'push' || run.branch !== 'main' || run.conclusion !== 'success') {
    throw new Error(
      `Budget source run ${run.id} must be a successful push to main`
    );
  }
}

const orderedRuns = [...args.runs].sort(
  (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
);
for (let index = 1; index < orderedRuns.length; index += 1) {
  if (Date.parse(orderedRuns[index].createdAt) >= Date.parse(orderedRuns[index - 1].createdAt)) {
    throw new Error('Budget source runs must have distinct chronological timestamps');
  }
}
if (new Set(orderedRuns.map((run) => run.headSha)).size !== orderedRuns.length) {
  throw new Error('Budget source runs must use distinct head SHAs');
}

const existingBudgets = fs.existsSync(args.output)
  ? JSON.parse(fs.readFileSync(args.output, 'utf8'))
  : {};
const budgets = {
  generatedFrom: 'gh run view --log; verified successful main-branch CI runs',
  formula: 'budget = max(ceil(1.25 * median), ceil(1.1 * maxObserved), floor)',
  formulaDetails: {
    durationMs: 'max(ceil(1.25 * medianMs), ceil(1.1 * maxObservedMs), floors.ms)',
    maxRssMB: 'max(ceil(1.25 * medianRssMB), ceil(1.1 * maxObservedRssMB), floors.mb)',
  },
  floors: DEFAULT_FLOORS,
  sampleRuns: orderedRuns.map((run) => run.id),
  sourceRuns: orderedRuns.map((run, order) => ({
    order: order + 1,
    runId: run.id,
    event: run.event,
    branch: run.branch,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    headSha: run.headSha,
  })),
  os: {},
};

// Footprint limits are measured from clean package installs rather than the
// performance logs. Preserve the reviewed section when rebuilding OS budgets.
if (existingBudgets.footprint) budgets.footprint = existingBudgets.footprint;

for (const os of ['linux', 'darwin', 'win32']) {
  const osSamples = allSamples.filter((sample) => sample.os === os);
  if (osSamples.length === 0) continue;
  budgets.os[os] = {};
  for (const command of [...new Set(osSamples.map((sample) => sample.command))].sort()) {
    const samples = osSamples.filter((sample) => sample.command === command);
    budgets.os[os][command] = {
      ...deriveBudget(samples, DEFAULT_FLOORS),
      samplesByRunner: summarizeSamplesByRunner(samples),
    };
  }
}

fs.writeFileSync(args.output, `${JSON.stringify(budgets, null, 2)}\n`);
console.log(`budgets written: ${args.output}; runs=${orderedRuns.map((run) => run.id).join(',')}; samples=${allSamples.length}`);
