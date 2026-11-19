import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { deriveBudget, median, summarizeSamplesByRunner } = require('../../tools/ci/budgets.mjs');

const DARWIN_VERIFY_SAMPLES = [
  { ms: 1833.3, mb: 190, runner: 'macos-latest', arch: 'arm64', node: 24, runId: '44328241893' },
  { ms: 2566.2, mb: 180, runner: 'macos-latest', arch: 'arm64', node: 22, runId: '44328241893' },
  { ms: 3047.7, mb: 180, runner: 'macos-latest', arch: 'arm64', node: 22, runId: '44310611988' },
  { ms: 2366.9, mb: 190, runner: 'macos-latest', arch: 'arm64', node: 24, runId: '44310611988' },
  { ms: 2025.5, mb: 190, runner: 'macos-latest', arch: 'arm64', node: 24, runId: '44303173142' },
  { ms: 2789, mb: 179, runner: 'macos-latest', arch: 'arm64', node: 22, runId: '44303173142' },
];

describe('C17 T2: CI budget derivation', () => {
  it('uses the standard median for an even number of samples', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('keeps every historical darwin verify sample within the new budget', () => {
    const result = deriveBudget(DARWIN_VERIFY_SAMPLES, { ms: 1000, mb: 40 });

    expect(result.budgetMs).toBe(3353);
    expect(result.budgetRssMB).toBe(232);
    for (const sample of DARWIN_VERIFY_SAMPLES) {
      expect(sample.ms).toBeLessThanOrEqual(result.budgetMs);
      expect(sample.mb).toBeLessThanOrEqual(result.budgetRssMB);
    }
  });

  it('records sample counts per runner and architecture', () => {
    const summary = summarizeSamplesByRunner(DARWIN_VERIFY_SAMPLES);
    expect(summary).toEqual([
      { runner: 'macos-latest', arch: 'arm64', count: 6 },
    ]);
  });

  it('rejects budget provenance that is not a successful main-branch push', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-budget-source-'));
    try {
      fs.writeFileSync(
        path.join(temporaryDirectory, 'run.log'),
        'verify (ubuntu-latest, node 24)\tBUDGET OK\tBUDGET OK doctor (linux): 100 ms / 50 MB\n'
      );
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('tools/ci/build-budgets.mjs'),
          '--run',
          '123=run.log',
          '--source',
          '123=pull_request,feature,success,2026-11-19T00:00:00Z,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '--run',
          '124=run.log',
          '--source',
          '124=push,main,success,2026-11-18T00:00:00Z,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '--run',
          '125=run.log',
          '--source',
          '125=push,main,success,2026-11-17T00:00:00Z,cccccccccccccccccccccccccccccccccccccccc',
          '--out',
          'budgets.json',
        ],
        {
          cwd: temporaryDirectory,
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('successful push to main');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects budget source runs without distinct chronological ordering', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-budget-order-'));
    try {
      fs.writeFileSync(
        path.join(temporaryDirectory, 'run.log'),
        'verify (ubuntu-latest, node 24)\tBUDGET OK\tBUDGET OK doctor (linux): 100 ms / 50 MB\n'
      );
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('tools/ci/build-budgets.mjs'),
          '--run',
          '123=run.log',
          '--source',
          '123=push,main,success,2026-11-19T00:00:00Z,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '--run',
          '124=run.log',
          '--source',
          '124=push,main,success,2026-11-19T00:00:00Z,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '--run',
          '125=run.log',
          '--source',
          '125=push,main,success,2026-11-17T00:00:00Z,cccccccccccccccccccccccccccccccccccccccc',
          '--out',
          'budgets.json',
        ],
        {
          cwd: temporaryDirectory,
          encoding: 'utf8',
        }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('distinct chronological timestamps');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('keeps different architectures on the same runner in separate groups', () => {
    const samples = [
      { runner: 'shared-runner', arch: 'x64', ms: 10, mb: 20 },
      { runner: 'shared-runner', arch: 'arm64', ms: 30, mb: 40 },
    ];
    const summary = summarizeSamplesByRunner(samples);

    expect(summary.map((group: { runner: string; arch: string; count: number }) => ({
      runner: group.runner,
      arch: group.arch,
      count: group.count,
    }))).toEqual([
      { runner: 'shared-runner', arch: 'arm64', count: 1 },
      { runner: 'shared-runner', arch: 'x64', count: 1 },
    ]);
  });
});
