import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../../tools/ci/check-perf.mjs');
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c16-budget-'));
  fs.writeFileSync(path.join(tmp, 'budgets.json'), JSON.stringify({
    floors: { ms: 1000, mb: 40 },
    os: { [process.platform]: { doctor: { budgetMs: 5000, budgetRssMB: 250 } } },
  }));
  fs.writeFileSync(path.join(tmp, 'perf.err'), '[routersync-perf] {"durationMs":100,"maxRssMB":50}\n');
});

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(name: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, 'perf.err', name], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('C16 R1.4: check-perf budget enforcement', () => {
  it('passes when the perf line is within the per-OS budget', () => {
    const r = run('doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BUDGET OK');
  });

  it('fails when the measured value exceeds the budget', () => {
    fs.writeFileSync(path.join(tmp, 'perf.err'), '[routersync-perf] {"durationMs":9000,"maxRssMB":50}\n');
    const r = run('doctor');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUDGET FAIL');
  });

  it('fails when the per-OS command entry is missing', () => {
    const r = run('scan');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUDGET MISSING');
  });

  it('allows a missing entry only with RS_BUDGET_BOOTSTRAP=1', () => {
    fs.writeFileSync(path.join(tmp, 'perf.err'), '[routersync-perf] {"durationMs":100,"maxRssMB":30}\n');
    const r = run('scan', { RS_BUDGET_BOOTSTRAP: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('BUDGET OK');
  });
});
