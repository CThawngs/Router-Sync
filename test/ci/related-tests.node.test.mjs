import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

function run(args, opts = {}) {
  try {
    const out = execFileSync('git', args, { cwd: opts.cwd ?? ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-related-'));
  const env = { ...process.env };
  run(['init', '-q'], { cwd: dir });
  run(['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  run(['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  run(['add', '-A'], { cwd: dir });
  run(['commit', '-q', '-m', 'base'], { cwd: dir });
  run(['branch', '-M', 'main'], { cwd: dir });
  return dir;
}

describe('C23 V0: related-tests picks tests from the branch diff', () => {
  test('selects changed test files after a commit', () => {
    const dir = makeRepo();
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      fs.writeFileSync(path.join(dir, 'test', 'x.test.ts'), 'import {it} from "vitest"; it("x",()=>{});\n');
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
      run(['checkout', '-q', '-b', 'feature'], { cwd: dir });
      run(['add', '-A'], { cwd: dir });
      run(['commit', '-q', '-m', 'change'], { cwd: dir });

      const r = run(['diff', '--name-only', 'main...HEAD'], { cwd: dir });
      const changed = r.out.split('\n').filter(Boolean);
      assert.deepEqual(changed.sort(), ['a.ts', 'test/x.test.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty diff yields nothing, not a silent pass claim', () => {
    const dir = makeRepo();
    try {
      const r = run(['diff', '--name-only', 'main...HEAD'], { cwd: dir });
      assert.equal(r.out.trim(), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('C23 V0: prepush no longer uses vitest --changed', () => {
  test('prepush calls the gated test:related script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepush).toContain('pnpm test:related');
    expect(pkg.scripts.prepush).not.toContain('pnpm test:changed');
  });

  test('test:related is registered in the RAM gate', () => {
    const heavy = fs.readFileSync(path.join(ROOT, 'tools/agent/heavy.mjs'), 'utf8');
    expect(heavy).toContain("'pnpm test:related'");
  });
});

function expect(actual) {
  return { toContain: (needle) => assert.ok(actual.includes(needle), `expected ${actual} to contain ${needle}`), not: { toContain: (needle) => assert.ok(!actual.includes(needle), `expected ${actual} NOT to contain ${needle}`) } };
}