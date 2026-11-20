import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failingStepContext, summarize } from '../../tools/agent/ci-watch.mjs';

// Synthetic failing log: noise + the failure in the middle + a `Post ...`
// step at the very end that must not leak into the context.
const filler = (prefix, from, to) =>
  Array.from({ length: to - from }, (_, i) => `${prefix}${from + i} noise line`);
const synthLog = [
  ...filler('2026-11-20T10:00:00Z Build ', 0, 6).map((l) => `verify (windows-11-arm, node 24)\tBuild\t${l}`),
  '2026-11-20T10:05:00Z Error: Hook timed out in 10000ms.',
  '2026-11-20T10:05:00Z ??? test/acceptance/at-143-combo-strategy.test.ts:235:3',
  '  235|   beforeAll(() => {',
  ...filler('2026-11-20T10:00:00Z Build ', 6, 30).map((l) => `verify (windows-11-arm, node 24)\tBuild\t${l}`),
  'verify (windows-11-arm, node 24)\tPost Checkout code\t2026-11-20T11:00:00Z Post job done',
].join('\n');

const job = {
  id: 1,
  name: 'verify (windows-11-arm, node 24)',
  steps: [
    { name: 'Build', conclusion: 'failure' },
    { name: 'Post Checkout code', conclusion: 'success' },
  ],
};

describe('C27 E1: ci-watch prints failing-step lines', () => {
  it('failingStepContext: stepNames from steps[] + context around the first error marker', () => {
    const ctx = failingStepContext(synthLog, job);
    assert.deepEqual(ctx.stepNames, ['Build']);
    assert.ok(ctx.context.includes('Hook timed out'), 'context must contain the timeout error');
    assert.ok(ctx.context.includes('at-143-combo-strategy.test.ts'), 'context must contain the failing test name');
    assert.ok(!ctx.context.includes('Post job done'), 'context must stop before the tail Post step');
  });

  it('summarize: carries stepNames + context for the failing job', () => {
    const results = summarize([job], { 1: synthLog });
    assert.ok(results[0].stepNames.includes('Build'));
    assert.ok(results[0].context.includes('Hook timed out'));
  });
});
