import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'tools/ci/run-smoke.mjs');

const CLI_STUB = `
// Stub CLI: prints a perf line so the fake checker sees one.
const name = process.argv[2] ?? 'doctor';
process.stderr.write('[routersync-perf] ' + JSON.stringify({ durationMs: 1, maxRssMB: 1 }) + '\\n');
`;

/**
 * Writes a fake check-perf that fails for the given command names, optionally
 * only on the first N attempts (state is kept in a file).
 */
function writeFakeChecker(dir, options) {
  const failures = JSON.stringify(options.failCommands ?? []);
  const failTimes = options.failTimes ?? 1;
  const stateFile = path.join(dir, 'state.txt');
  fs.writeFileSync(stateFile, '0');
  const file = path.join(dir, 'fake-check-perf.mjs');
  fs.writeFileSync(
    file,
    [
      "import fs from 'node:fs';",
      `const failures = new Set(${failures});`,
      `const failTimes = ${failTimes};`,
      `const stateFile = ${JSON.stringify(stateFile)};`,
      // run-smoke.mjs calls: <checker> <stderrFile> <commandName>
      'const stderrFile = process.argv[2];',
      'const name = process.argv[3];',
      'const text = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, "utf8") : "";',
      'if (!text.includes("[routersync-perf]")) {',
      '  console.error(`NO PERF LINE: ${name}`);',
      '  process.exit(1);',
      '}',
      'if (!failures.has(name)) { console.log(`BUDGET OK ${name}`); process.exit(0); }',
      'const seen = Number(fs.readFileSync(stateFile, "utf8") || "0");',
      'fs.writeFileSync(stateFile, String(seen + 1));',
      'if (seen + 1 <= failTimes) {',
      '  console.error(`BUDGET FAIL ${name}: durationMs 9999 > 1`);',
      '  process.exit(1);',
      '}',
      'console.log(`BUDGET OK ${name}`);',
      '',
    ].join('\n'),
    'utf8'
  );
  return file;
}

function runSmoke(dir, checker) {
  return spawnSync(
    process.execPath,
    [SCRIPT],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        RS_SMOKE_CLI: path.join(dir, 'stub-cli.mjs'),
        RS_CHECK_PERF: checker,
        RS_SMOKE_PERF_DIR: path.join(dir, 'perf'),
        RS_SMOKE_ATTEMPTS: '2',
      },
    }
  );
}

describe('C20 X0: smoke budget failures are never swallowed', () => {
  it('exits non-zero when a middle command is over budget and passes at the end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-smoke-mid-'));
    try {
      fs.writeFileSync(path.join(dir, 'stub-cli.mjs'), CLI_STUB, 'utf8');
      // "plan" is the 2nd of 5 commands; "rank-json" (the last) is fine.
      const checker = writeFakeChecker(dir, { failCommands: ['plan'], failTimes: 5 });
      const result = runSmoke(dir, checker);

      expect(result.status).not.toBe(0);
      // The run must not stop at the first failure: all five commands are attempted.
      for (const name of ['doctor', 'plan', 'verify', 'scan', 'rank-json']) {
        expect(result.stdout + result.stderr).toContain(`over budget: ${name}`.replace('over budget: ', ''));
      }
      expect(result.stdout + result.stderr).toMatch(/SMOKE SUMMARY: 1\/5 over budget/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes with exactly one RETRY line when the failure clears on the second attempt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-smoke-retry-'));
    try {
      fs.writeFileSync(path.join(dir, 'stub-cli.mjs'), CLI_STUB, 'utf8');
      // Fails once on "doctor", then every command passes.
      const checker = writeFakeChecker(dir, { failCommands: ['doctor'], failTimes: 1 });
      const result = runSmoke(dir, checker);
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(0);
      expect(output.match(/RETRY:/g) ?? []).toHaveLength(1);
      expect(output).toMatch(/SMOKE SUMMARY: 5\/5 within budget/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});