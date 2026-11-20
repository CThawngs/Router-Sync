import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('C26 D1: prepush chain really invokes the RAM-gated related tests', () => {
  test('prepush contains lint, typecheck:changed, heavy test:related, validate-workflows in order', () => {
    const chain = PKG.scripts['prepush'];
    const steps = [
      'pnpm lint',
      'pnpm typecheck:changed',
      'node tools/agent/heavy.mjs -- pnpm test:related',
      'node tools/ci/validate-workflows.mjs',
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = chain.indexOf(step, cursor + 1);
      assert.ok(at > cursor, `prepush must run "${step}" in order; got: ${chain}`);
      cursor = at;
    }
    // The mutant from C24 replaced the heavy-wrapped related step with
    // `pnpm test:changed`, which only looks at the uncommitted working tree.
    assert.ok(!chain.includes('pnpm test:changed'), 'prepush must not use test:changed (it misses committed red tests)');
  });

  test('test:related script goes through heavy.mjs (the RAM gate)', () => {
    assert.equal(PKG.scripts['test:related'], 'node tools/agent/heavy.mjs -- pnpm test:related');
  });
});
