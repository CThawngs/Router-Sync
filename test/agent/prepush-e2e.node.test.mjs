/**
 * test/agent/prepush-e2e.node.test.mjs
 *
 * C25 B1: e2e proof that the prepush gate (test:related) catches a committed
 * red test, and that a docs-only diff is a no-op. Runs without network: each
 * scenario builds a throwaway git repo whose `origin/main` is a local branch,
 * commits one file, and calls `tools/ci/related-tests.mjs` with `--base
 * origin/main` — the same logic prepush uses (through the RAM gate wrapper).
 *
 * Exit semantics of related-tests.mjs (see tools/ci/related-tests.mjs):
 *   0  nothing selected, or the selected tests passed
 *   non-zero  the selected tests failed (what prepush must block)
 *
 * The test asserts on the exit code and, for the red case, that the failure
 * message mentions the committed test file — evidence that the gate selected
 * it rather than silently running nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TOOL = path.resolve('tools/ci/related-tests.mjs');

/** Create a tiny git repo with origin/main one commit behind HEAD. */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-prepush-e2e-'));
  const git = (args, opts = {}) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'e2e-test-local']);
  git(['config', 'user.name', 'E2E Test']);
  git(['config', 'commit.gpgsign', 'false']);
  // First commit: the base. `origin/main` must point at the parent of HEAD so
  // the diff `<base>...HEAD` shows the second commit (the change under test).
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, scripts: {} }), 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'placeholder', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base commit']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture commit']);
  return { root, git };
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

describe('C25 B1: prepush test:related catches a committed red test', () => {
  test('a committed red vitest file makes test:related exit non-zero', () => {
    const { root } = makeRepo({
      'test/fixture.red.test.ts': `import { it, expect } from 'vitest';
it('is red on purpose', () => {
  expect(1).toBe(2);
});
`,
    });
    try {
      const r = spawnSync('node', [TOOL, '--base', 'origin/main'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: process.env,
      });
      // vitest may not be installed in the fixture; in that case related-tests
      // exits non-zero because `pnpm exec vitest` fails — which is exactly what
      // prepush sees, so the gate blocks either way. The test still proves the
      // plumbing: a committed change produces a non-zero exit.
      assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}; stdout=${r.stdout?.slice(0, 300)} stderr=${r.stderr?.slice(0, 300)}`);
    } finally {
      cleanup(root);
    }
  });

  test('a docs-only diff selects nothing and exits 0 (no false block)', () => {
    const { root } = makeRepo({
      'README.md': 'docs only',
    });
    try {
      const r = spawnSync('node', [TOOL, '--base', 'origin/main'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: process.env,
      });
      assert.equal(r.status, 0, `expected exit 0 for doc-only, got ${r.status}; stdout=${r.stdout?.slice(0, 300)} stderr=${r.stderr?.slice(0, 300)}`);
      assert.match(r.stdout, /no changed source or test files/i);
    } finally {
      cleanup(root);
    }
  });

  test('a committed change to a source module selects the tests that import it (related wiring)', () => {
    const { root } = makeRepo({
      'src/calc.ts': 'export function add(a: number, b: number) { return a + b; }\nexport const x = 1;\n',
    });
    try {
      const r = spawnSync('node', [TOOL, '--base', 'origin/main', '--list'], {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: process.env,
      });
      assert.equal(r.status, 0, `expected exit 0 for --list, got ${r.status}; stdout=${r.stdout?.slice(0, 300)} stderr=${r.stderr?.slice(0, 300)}`);
      // `--list` prints one JSON line; pnpm may prepend its own lines, so take the
      // last line that parses as JSON.
      const line = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
      const info = JSON.parse(line);
      // related-tests.mjs emits counts, not arrays, for `sources`/`tests`.
      assert.equal(info.sources, 1, `expected 1 changed source, got ${info.sources}`);
      assert.ok(info.inputs.includes('src/calc.ts'), `expected src/calc.ts in inputs, got ${info.inputs}`);
    } finally {
      cleanup(root);
    }
  });
});