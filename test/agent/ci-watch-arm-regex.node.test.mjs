import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { summarize, exitCodeFor } = await import('../../tools/agent/ci-watch.mjs');

describe('C25 P1.1: masked-job regex matches ci.yml continue-on-error jobs', () => {
  test('MASKED_JOB_NAME_RE in ci-watch.mjs matches the expanded ARM job names in ci.yml', () => {
    const source = readFileSync(new URL('../../tools/agent/ci-watch.mjs', import.meta.url), 'utf8');
    const match = source.match(/MASKED_JOB_NAME_RE = \/\^([^/]+)\$\//);
    assert.ok(match, 'MASKED_JOB_NAME_RE definition missing');
    const re = new RegExp(`^${match[1]}$`);
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const osValues = ['ubuntu-latest', 'ubuntu-24.04-arm', 'macos-latest', 'windows-latest', 'windows-11-arm'];
    const nodeValues = [22, 24];
    for (const os of osValues) {
      for (const node of nodeValues) {
        const name = `verify (${os}, node ${node})`;
        if (os === 'windows-11-arm') assert.ok(re.test(name), `expected ${name} to be masked`);
        else assert.ok(!re.test(name), `expected ${name} NOT to be masked`);
      }
    }
  });

  test('summarize still marks the ARM job masked and the other jobs not', () => {
    const jobs = [
      { id: 1, name: 'verify (windows-11-arm, node 24)', conclusion: 'failure', steps: [{ name: 'Run Tests', conclusion: 'failure' }] },
      { id: 2, name: 'verify (ubuntu-latest, node 22)', conclusion: 'failure', steps: [{ name: 'Run Tests', conclusion: 'failure' }] },
    ];
    const out = summarize(jobs, {
      1: 'AssertionError: boom',
      2: 'AssertionError: boom2',
    });
    assert.equal(out[0].kind, 'masked');
    assert.equal(out[1].kind, 'code');
    assert.equal(exitCodeFor(out), 11);
  });
});