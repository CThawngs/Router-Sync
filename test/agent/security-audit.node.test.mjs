/**
 * test/agent/security-audit.node.test.mjs
 *
 * M4-02 (P7) & C46-F4 (P4): Hermetic unit & CLI tests for `tools/agent/security-audit.mjs`.
 *
 * Verifies:
 *   1. Synthetic secret (`sk-...`, `ghp_...`, `github_pat_...`, PEM key), `.env` file,
 *      K6.2 git string, and personal path detection in `scanRepoFiles`, `scanEvidenceRefs`,
 *      `scanPackedTarballs`, and `scanRecentCiLogs`.
 *   2. Strict Zero-Leak Rule: matched secret tokens, personal paths, error messages, and usernames
 *      NEVER appear in returned findings, JSON output, stdout, or stderr.
 *   3. CLI flags `--repo-root` and `--tarballs-dir` exit with code `1` on injected
 *      `sk-...` / `.env` artifacts while leaking `0` secret characters.
 *   4. Programmatic router write-gate checklist (`auditRouterWriteGates`) passes 100%
 *      in `os.tmpdir()` (`grant`, `approval-token`, `--yes-write-router`, 0 live ports)
 *      and fails closed (`HIGH` finding) when any gate check reports a bypass.
 *   5. Real repo `scanRepoFiles(REPO_ROOT)` + `scanEvidenceRefs(REPO_ROOT)` have `0` `HIGH` findings.
 *   6. C46-F4: `--with-ci-logs` defaults to 10 completed `main` runs, fails closed on offline/fetch
 *      errors, partial per-run/per-job log failures, mid-run cancelled jobs with executed steps,
 *      and empty run lists, validates CLI flags strictly, and deduplicates `origin/evidence/*` refs.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as securityAuditMod from '../../tools/agent/security-audit.mjs';
import {
  SEVERITY,
  scanRepoFiles,
  scanEvidenceRefs,
  scanPackedTarballs,
  scanRecentCiLogs,
  auditRouterWriteGates,
  runSecurityAudit,
  parseSecurityAuditArgs,
} from '../../tools/agent/security-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const AUDIT_SCRIPT = path.join(REPO_ROOT, 'tools', 'agent', 'security-audit.mjs');

const tempDirs = [];
function makeTempDir(prefix = 'rs-sec-audit-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Construct synthetic credentials dynamically so static guards never see literal tokens
function buildSyntheticSkToken() {
  return ['sk', '-proj-', 'SyntheticLeakCanary998877665544332211xyz'].join('');
}

function buildOfflineErrorCanaryToken() {
  return ['sk', '-proj-', 'SecretShouldNotLeak1234567890'].join('');
}

function buildSyntheticGithubPat() {
  return ['ghp_', 'SyntheticPatCanary11223344556677889900ab'].join('');
}

function buildSyntheticPemHeader() {
  return ['-----BEGIN ', 'RSA PRIVATE ', 'KEY-----'].join('');
}

function buildSyntheticPersonalWinPath() {
  return ['C:', '\\', 'Users', '\\', 'canaryperson99', '\\', 'Documents', '\\', 'keys.txt'].join('');
}

function assertStrictZeroLeakSchema(findings) {
  for (const f of findings) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['count', 'id', 'location', 'remediation', 'rule', 'severity', 'surface']
    );
  }
}

function initTempGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test Bot'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: dir });
}

describe('M4-02 (P7): tools/agent/security-audit.mjs multi-surface auditor & write-gate checklist', () => {
  test('scanRepoFiles catches synthetic sk- token, PEM key, .env file, and personal path with zero secret leakage', () => {
    const repoDir = makeTempDir('rs-sec-repo-');
    initTempGitRepo(repoDir);

    const skToken = buildSyntheticSkToken();
    const ghPat = buildSyntheticGithubPat();
    const pemHeader = buildSyntheticPemHeader();
    const winPath = buildSyntheticPersonalWinPath();

    fs.writeFileSync(path.join(repoDir, '.env.example'), 'OMNIROUTE_URL=http://127.0.0.1:9\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env'), `OPENAI_API_KEY=${skToken}\n`, 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'leaked-notes.txt'),
      `token=${ghPat}\n${pemHeader}\npath=${winPath}\n`,
      'utf8'
    );
    execFileSync('git', ['add', '.env.example', 'leaked-notes.txt'], { cwd: repoDir });

    const res = scanRepoFiles(repoDir);
    assert.equal(res.ok, false);
    assert.ok(res.findings.length >= 3, 'Expected findings for .env, secrets, and personal path');
    assert.ok(res.findings.every((f) => f.severity === SEVERITY.HIGH));
    assert.ok(res.findings.some((f) => f.rule === 'dotenv-file'));

    // Strict Zero-Leak check on serialized findings
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(skToken), false, 'Leaked synthetic sk- token in JSON');
    assert.equal(serialized.includes(ghPat), false, 'Leaked synthetic ghp_ token in JSON');
    assert.equal(serialized.includes('canaryperson99'), false, 'Leaked personal path username in JSON');

    assertStrictZeroLeakSchema(res.findings);
  });

  test('scanEvidenceRefs scans evidence/* git refs without checkout and catches injected token with zero leak', () => {
    const repoDir = makeTempDir('rs-sec-ev-');
    initTempGitRepo(repoDir);

    const skToken = buildSyntheticSkToken();
    fs.mkdirSync(path.join(repoDir, 'evidence', 'M4'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'evidence', 'M4', 'sample.out.txt'),
      `Authorization: Bearer ${skToken}\n`,
      'utf8'
    );
    execFileSync('git', ['checkout', '-q', '-b', 'evidence/m4-test'], { cwd: repoDir });
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'evidence snapshot'], { cwd: repoDir });
    execFileSync('git', ['checkout', '-q', '--orphan', 'main'], { cwd: repoDir });
    execFileSync('git', ['rm', '-rf', '-q', '.'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Clean main\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'clean main'], { cwd: repoDir });

    const res = scanEvidenceRefs(repoDir);
    assert.equal(res.ok, false);
    assert.ok(res.refsScanned >= 1);
    assert.ok(res.findings.some((f) => f.surface === 'evidence-refs' && f.severity === SEVERITY.HIGH));
    assert.equal(JSON.stringify(res).includes(skToken), false, 'Leaked synthetic token from evidence ref');
  });

  test('scanPackedTarballs detects .env and secret inside synthetic .tgz tarball with zero leak', () => {
    const workDir = makeTempDir('rs-sec-tar-');
    const pkgBuildDir = path.join(workDir, 'pkg-src', 'package');
    const tarballsDir = path.join(workDir, 'tarballs');
    fs.mkdirSync(path.join(pkgBuildDir, 'dist'), { recursive: true });
    fs.mkdirSync(tarballsDir, { recursive: true });

    const skToken = buildSyntheticSkToken();
    fs.writeFileSync(
      path.join(pkgBuildDir, 'package.json'),
      JSON.stringify({ name: '@routersync/synthetic', version: '0.1.0' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(pkgBuildDir, '.env'), `SECRET=${skToken}\n`, 'utf8');
    fs.writeFileSync(path.join(pkgBuildDir, 'dist', 'index.js'), `export const k = "${skToken}";\n`, 'utf8');

    const tgzPath = path.join(tarballsDir, 'routersync-synthetic-0.1.0.tgz');
    const tarCreate = spawnSync('tar', ['-czf', tgzPath, '-C', path.join(workDir, 'pkg-src'), 'package'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(tarCreate.status, 0, `tar -czf failed: ${tarCreate.stderr}`);

    const res = scanPackedTarballs(REPO_ROOT, { tarballsDir });
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.surface === 'tarballs' && f.severity === SEVERITY.HIGH));
    assert.equal(JSON.stringify(res).includes(skToken), false, 'Leaked synthetic token from tarball');
  });

  test('scanRecentCiLogs skips when offline by default and catches secrets in fetched CI logs without echoing them', () => {
    const offline = scanRecentCiLogs({ enabled: false });
    assert.equal(offline.status, 'skipped_offline_flag');
    assert.equal(offline.ok, true);

    const skToken = buildSyntheticSkToken();
    const winPath = buildSyntheticPersonalWinPath();
    const posixRunnerDir = ['/', 'home', '/runner/work/Router-Sync/Router-Sync'].join('');
    const winRunnerDir = ['C:', '\\', 'Users', '\\', 'runneradmin', '\\', 'AppData', '\\', 'Local'].join('');
    const withCiLogs = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => [
        {
          id: 999001,
          headSha: 'abc1234',
          workflowName: 'CI',
          log: [
            `2026-11-24T00:00:01Z ${posixRunnerDir}`,
            `2026-11-24T00:00:02Z ${winRunnerDir}`,
            `2026-11-24T00:00:03Z leaked=${skToken} host=${winPath}`,
          ].join('\n'),
        },
      ],
    });
    assert.equal(withCiLogs.ok, false);
    assert.ok(withCiLogs.findings.length >= 2);
    const outStr = JSON.stringify(withCiLogs);
    assert.equal(outStr.includes(skToken), false);
    assert.equal(outStr.includes('canaryperson99'), false);
  });

  test('auditRouterWriteGates passes all 3 gates (grant, approval-token, --yes-write-router) in os.tmpdir() and fails closed on gate bypass', async () => {
    const gateRes = await auditRouterWriteGates();
    assert.equal(gateRes.ok, true, `Write gates failed: ${JSON.stringify(gateRes)}`);
    assert.equal(gateRes.findings.length, 0);
    assert.equal(gateRes.gates.grant.ok, true);
    assert.ok(gateRes.gates.grant.checksPassed >= 5);
    assert.equal(gateRes.gates.approvalToken.ok, true);
    assert.ok(gateRes.gates.approvalToken.checksPassed >= 5);
    assert.equal(gateRes.gates.yesWriteRouter.ok, true);
    assert.ok(gateRes.gates.yesWriteRouter.checksPassed >= 2);

    // Simulated bypass in any of the 3 gates must yield HIGH finding and ok: false
    for (const gateName of ['grant', 'approval-token', 'yes-write-router']) {
      const bypassed = await auditRouterWriteGates({ _simulateBypassGate: gateName });
      assert.equal(bypassed.ok, false, `Expected bypass of ${gateName} to fail audit`);
      assert.ok(
        bypassed.findings.some((f) => f.surface === 'write-gates' && f.severity === SEVERITY.HIGH),
        `Expected HIGH write-gates finding when ${gateName} is bypassed`
      );
    }
  });

  test('CLI execution exits 1 on synthetic sk- commit/tarball with 0 occurrences of token in stdout/stderr', () => {
    const repoDir = makeTempDir('rs-sec-cli-q1-');
    initTempGitRepo(repoDir);

    const skToken = buildSyntheticSkToken();
    fs.writeFileSync(path.join(repoDir, 'config-leak.yaml'), `apiKey: ${skToken}\n`, 'utf8');
    execFileSync('git', ['add', 'config-leak.yaml'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'inject synthetic token'], { cwd: repoDir });

    const cliRun = spawnSync(
      process.execPath,
      [AUDIT_SCRIPT, '--repo-root', repoDir, '--skip-write-gates'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      }
    );

    assert.equal(cliRun.status, 1, `Expected exitCode 1, got ${cliRun.status}`);
    assert.equal(cliRun.stdout.includes(skToken), false, 'Leaked synthetic token on stdout');
    assert.equal(cliRun.stderr.includes(skToken), false, 'Leaked synthetic token on stderr');
  });

  test('real repository repo-files and evidence-refs pass with 0 HIGH findings', async () => {
    const report = await runSecurityAudit({
      repoRoot: REPO_ROOT,
      skipTarballs: true,
      skipWriteGates: true,
      withCiLogs: false,
    });
    assert.equal(report.ok, true, `Unexpected findings on real repo: ${JSON.stringify(report.findings)}`);
    assert.equal(report.highCount, 0);
  });
});

describe('C46-F4 (P4): Hardened networked CI log & evidence ref security audit', () => {
  test('parseSecurityAuditArgs defaults to ciRunsLimit=10 and ciBranch="main", supports overrides, and rejects missing/flag-swallowed/non-integer values', () => {
    const defaults = parseSecurityAuditArgs(['--with-ci-logs', '--json']);
    assert.equal(defaults.withCiLogs, true);
    assert.equal(defaults.json, true);
    assert.equal(defaults.ciRunsLimit, 10);
    assert.equal(defaults.ciBranch, 'main');

    const overridden = parseSecurityAuditArgs([
      '--with-ci-logs',
      '--ci-runs-limit',
      '15',
      '--ci-branch',
      'release/v1',
    ]);
    assert.equal(overridden.ciRunsLimit, 15);
    assert.equal(overridden.ciBranch, 'release/v1');

    const allBranches = parseSecurityAuditArgs(['--with-ci-logs', '--ci-branch', 'all']);
    assert.equal(allBranches.ciBranch, 'all');

    const explicitEmptyBranch = parseSecurityAuditArgs(['--with-ci-logs', '--ci-branch', '']);
    assert.equal(explicitEmptyBranch.ciBranch, '');

    // Reject missing value, flag-swallowing, non-integer, zero, negative, and non-numeric --ci-runs-limit
    for (const badArgs of [
      ['--with-ci-logs', '--ci-runs-limit'],
      ['--with-ci-logs', '--ci-runs-limit', '--json'],
      ['--with-ci-logs', '--ci-runs-limit', '1.9'],
      ['--with-ci-logs', '--ci-runs-limit', '0'],
      ['--with-ci-logs', '--ci-runs-limit', '-5'],
      ['--with-ci-logs', '--ci-runs-limit', ''],
      ['--with-ci-logs', '--ci-runs-limit', 'ten'],
    ]) {
      assert.throws(
        () => parseSecurityAuditArgs(badArgs),
        /Invalid --ci-runs-limit value/,
        `Expected parseSecurityAuditArgs(${JSON.stringify(badArgs)}) to reject invalid --ci-runs-limit`
      );
    }

    // Reject missing value or flag-swallowing on --ci-branch, --repo-root, and --tarballs-dir
    for (const [badArgs, expectedPattern] of [
      [['--with-ci-logs', '--ci-branch'], /Missing value for --ci-branch/],
      [['--with-ci-logs', '--ci-branch', '--json'], /Missing value for --ci-branch/],
      [['--repo-root'], /Missing value for --repo-root/],
      [['--repo-root', '--json'], /Missing value for --repo-root/],
      [['--repo-root', ''], /Missing value for --repo-root/],
      [['--tarballs-dir'], /Missing value for --tarballs-dir/],
      [['--tarballs-dir', '--json'], /Missing value for --tarballs-dir/],
      [['--tarballs-dir', ''], /Missing value for --tarballs-dir/],
    ]) {
      assert.throws(
        () => parseSecurityAuditArgs(badArgs),
        expectedPattern,
        `Expected parseSecurityAuditArgs(${JSON.stringify(badArgs)}) to reject missing/swallowed flag value`
      );
    }
  });

  test('scanRecentCiLogs fails closed when logFetcher throws and leaks 0 error/secret characters', () => {
    const errorCanary = buildOfflineErrorCanaryToken();
    const res = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => {
        throw new Error(`offline ${errorCanary} host-unreachable`);
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 'fetch_failed');
    assert.equal(res.runsScanned, 0);
    assert.deepEqual(res.runIds, []);
    assert.equal(res.findings.length, 1);
    assert.deepEqual(res.findings[0], {
      id: 'SEC-0001',
      surface: 'ci-logs',
      location: 'gh-run:list',
      rule: 'ci-log-fetch-failed',
      severity: SEVERITY.HIGH,
      count: 1,
      remediation:
        'Ensure network connectivity and gh authentication before running --with-ci-logs; never treat unreachable CI logs as clean.',
    });
    assertStrictZeroLeakSchema(res.findings);

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(errorCanary), false, 'Leaked secret canary from fetch error');
    assert.equal(serialized.includes('host-unreachable'), false, 'Leaked raw error text into report');
  });

  test('scanRecentCiLogs fails closed on 0 runs unless allowEmptyRuns is explicitly true', () => {
    const emptyRes = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => [],
    });

    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.runsScanned, 0);
    assert.deepEqual(emptyRes.runIds, []);
    assert.ok(
      emptyRes.findings.some(
        (f) =>
          f.surface === 'ci-logs' &&
          f.location === 'gh-run:list' &&
          f.rule === 'ci-log-empty-runs' &&
          f.severity === SEVERITY.HIGH &&
          f.count === 1
      ),
      `Expected HIGH ci-log-empty-runs finding, got ${JSON.stringify(emptyRes.findings)}`
    );
    assertStrictZeroLeakSchema(emptyRes.findings);

    const allowedEmpty = scanRecentCiLogs({
      enabled: true,
      allowEmptyRuns: true,
      logFetcher: () => [],
    });
    assert.equal(allowedEmpty.ok, true);
    assert.equal(allowedEmpty.findings.length, 0);
  });

  test('runSecurityAudit forwards allowEmptyCiRuns=false by default and fails closed on 0 CI runs (kills Q7)', async () => {
    const repoDir = makeTempDir('rs-sec-empty-ci-');
    initTempGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Clean repo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial main'], { cwd: repoDir });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoDir });

    const report = await runSecurityAudit({
      repoRoot: repoDir,
      skipTarballs: true,
      skipWriteGates: true,
      withCiLogs: true,
      ciLogFetcher: () => [],
    });

    assert.equal(report.ok, false);
    assert.equal(report.highCount, 1);
    assert.equal(report.surfaces.ciLogs.ok, false);
    assert.equal(report.surfaces.ciLogs.status, 'empty_runs');
    assert.equal(report.surfaces.ciLogs.runsScanned, 0);
    assert.ok(
      report.findings.some(
        (f) =>
          f.surface === 'ci-logs' &&
          f.location === 'gh-run:list' &&
          f.rule === 'ci-log-empty-runs' &&
          f.severity === SEVERITY.HIGH
      )
    );
    assertStrictZeroLeakSchema(report.findings);

    const allowedReport = await runSecurityAudit({
      repoRoot: repoDir,
      skipTarballs: true,
      skipWriteGates: true,
      withCiLogs: true,
      allowEmptyCiRuns: true,
      ciLogFetcher: () => [],
    });
    assert.equal(allowedReport.ok, true);
    assert.equal(allowedReport.highCount, 0);
    assert.equal(allowedReport.surfaces.ciLogs.status, 'scanned');
  });

  test('scanRecentCiLogs and defaultCiLogFetcher fail closed on partial per-run log failure without swallowing errors', () => {
    const errorCanary = buildOfflineErrorCanaryToken();

    // Case 1: Run 1 succeeds, Run 2 reports per-run log fetch failure (`logError: true`)
    const partialRes = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => [
        { id: 700001, headSha: '111aaaa', workflowName: 'CI', log: '2026-11-25T00:00:00Z all good' },
        { id: 700002, headSha: '222bbbb', workflowName: 'CI', logError: true },
      ],
    });
    assert.equal(partialRes.ok, false);
    assert.equal(partialRes.status, 'fetch_failed');
    assert.equal(partialRes.runsScanned, 1);
    assert.deepEqual(partialRes.runIds, [700001]);
    assert.ok(
      partialRes.findings.some(
        (f) =>
          f.surface === 'ci-logs' &&
          f.location === 'gh-run:700002' &&
          f.rule === 'ci-log-fetch-failed' &&
          f.severity === SEVERITY.HIGH
      )
    );
    assertStrictZeroLeakSchema(partialRes.findings);

    // Case 2: defaultCiLogFetcher passes `--branch main --status completed --limit 10` and marks failed `gh run view --log`
    assert.equal(typeof securityAuditMod.defaultCiLogFetcher, 'function');
    const recordedCalls = [];
    const simulatedExec = (_bin, args) => {
      recordedCalls.push(args);
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 880001,
            headSha: 'abcdef1234567',
            workflowName: 'CI',
            status: 'completed',
            headBranch: 'main',
          },
          {
            databaseId: 880002,
            headSha: 'fedcba7654321',
            workflowName: 'CI',
            status: 'completed',
            headBranch: 'main',
          },
        ]);
      }
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '880001') {
        return '2026-11-25T01:00:00Z clean workflow output\n';
      }
      throw new Error(`network reset ${errorCanary}`);
    };

    const viaDefaultFetcher = scanRecentCiLogs({
      enabled: true,
      execFn: simulatedExec,
    });
    assert.deepEqual(recordedCalls[0], [
      'run',
      'list',
      '--branch',
      'main',
      '--status',
      'completed',
      '--limit',
      '10',
      '--json',
      'databaseId,headSha,workflowName,status,headBranch',
    ]);
    assert.equal(viaDefaultFetcher.ok, false);
    assert.equal(viaDefaultFetcher.status, 'fetch_failed');
    assert.equal(viaDefaultFetcher.branch, 'main');
    assert.deepEqual(viaDefaultFetcher.runIds, [880001]);
    assert.ok(
      viaDefaultFetcher.findings.some(
        (f) => f.location === 'gh-run:880002' && f.rule === 'ci-log-fetch-failed'
      )
    );
    assert.equal(JSON.stringify(viaDefaultFetcher).includes(errorCanary), false);
  });

  test('defaultCiLogFetcher fails closed when per-job --job <id> --log fallback throws with 0 secret canary leakage (kills Q1)', () => {
    const errorCanary = buildOfflineErrorCanaryToken();
    const execPerJobFailure = (_bin, args) => {
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 990088,
            headSha: '88aa99bb00cc11',
            workflowName: 'CI',
            status: 'completed',
            headBranch: 'main',
          },
        ]);
      }
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '990088' && args[3] === '--log') {
        throw new Error('log not found: 66000');
      }
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '990088' && args[3] === '--json') {
        return JSON.stringify({
          jobs: [
            { databaseId: 66001, conclusion: 'success', steps: [{ conclusion: 'success' }] },
            { databaseId: 66002, conclusion: 'success', steps: [{ conclusion: 'success' }] },
          ],
        });
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '66001') {
        return '2026-11-25T00:00:01Z clean job J1 output\n';
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '66002') {
        throw new Error(`job J2 log truncated ${errorCanary}`);
      }
      throw new Error('unexpected gh invocation');
    };

    const res = scanRecentCiLogs({
      enabled: true,
      execFn: execPerJobFailure,
    });

    assert.equal(res.ok, false);
    assert.equal(res.status, 'fetch_failed');
    assert.equal(res.runsScanned, 0);
    assert.deepEqual(res.runIds, []);
    assert.ok(
      res.findings.some(
        (f) =>
          f.surface === 'ci-logs' &&
          f.location === 'gh-run:990088' &&
          f.rule === 'ci-log-fetch-failed' &&
          f.severity === SEVERITY.HIGH &&
          f.count === 1
      )
    );
    assertStrictZeroLeakSchema(res.findings);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(errorCanary), false, 'Leaked canary from per-job log error');
    assert.equal(serialized.includes('truncated'), false, 'Leaked raw per-job error message');
  });

  test('runSecurityAudit exposes surfaces.ciLogs.{branch,runIds} and deduplicates shared-SHA evidenceRefs remote-first (kills Q8)', async () => {
    const repoDir = makeTempDir('rs-sec-meta-');
    initTempGitRepo(repoDir);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Clean repo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial main'], { cwd: repoDir });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoDir });

    // Create BOTH local `refs/heads/evidence/d3` AND remote-tracking `refs/remotes/origin/evidence/d3` at identical SHA
    execFileSync('git', ['checkout', '-q', '-b', 'evidence/d3'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'evidence', 'd3.txt'), 'clean d3 proof\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'd3 evidence'], { cwd: repoDir });
    const d3Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/evidence/d3', d3Sha], { cwd: repoDir });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir });

    let receivedMeta = null;
    const report = await runSecurityAudit({
      repoRoot: repoDir,
      skipTarballs: true,
      skipWriteGates: true,
      withCiLogs: true,
      ciLogFetcher: (limit, meta) => {
        receivedMeta = { limit, ...meta };
        return [
          { id: 501, headSha: 'aaa1111', workflowName: 'CI', log: 'clean run 1' },
          { id: 502, headSha: 'bbb2222', workflowName: 'CI', log: 'clean run 2' },
        ];
      },
    });

    assert.equal(report.ok, true);
    assert.equal(receivedMeta?.limit, 10);
    assert.equal(receivedMeta?.branch, 'main');
    assert.equal(report.surfaces.ciLogs.branch, 'main');
    assert.equal(report.surfaces.ciLogs.runsScanned, 2);
    assert.deepEqual(report.surfaces.ciLogs.runIds, [501, 502]);
    assert.equal(report.surfaces.evidenceRefs.refsScanned, 1);
    assert.deepEqual(report.surfaces.evidenceRefs.refs, ['origin/evidence/d3']);

    // When local `refs/heads/evidence/d3` diverges to a distinct commit SHA, BOTH refs must be scanned
    execFileSync('git', ['checkout', '-q', 'evidence/d3'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'evidence', 'd3-extra.txt'), 'diverged local d3 proof\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'diverged local d3'], { cwd: repoDir });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir });

    const divergedScan = scanEvidenceRefs(repoDir);
    assert.equal(divergedScan.ok, true);
    assert.equal(divergedScan.refsScanned, 2);
    assert.deepEqual(divergedScan.refNames, ['evidence/d3', 'origin/evidence/d3']);

    // Broken/missing evidence ref passed explicitly must fail closed instead of returning 0 findings
    const brokenRefScan = scanEvidenceRefs(repoDir, ['refs/heads/evidence/missing-ref']);
    assert.equal(brokenRefScan.ok, false);
    assert.ok(
      brokenRefScan.findings.some(
        (f) => f.surface === 'evidence-refs' && f.rule === 'evidence-ref-scan-failed' && f.severity === SEVERITY.HIGH
      )
    );
    assertStrictZeroLeakSchema(brokenRefScan.findings);
  });

  test('defaultCiLogFetcher skips 0-step cancelled jobs but scans mid-run cancelled jobs that executed steps (kills Q6)', () => {
    const skToken = buildSyntheticSkToken();
    const execWithCancelledJobs = (_bin, args) => {
      if (args[0] === 'run' && args[1] === 'list') {
        return JSON.stringify([
          {
            databaseId: 990077,
            headSha: '7bd0160a10dc04',
            workflowName: 'CI',
            status: 'completed',
            headBranch: 'main',
          },
        ]);
      }
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '990077' && args[3] === '--log') {
        throw new Error('log not found: 55002');
      }
      if (args[0] === 'run' && args[1] === 'view' && args[2] === '990077' && args[3] === '--json') {
        return JSON.stringify({
          jobs: [
            { databaseId: 55001, conclusion: 'success', steps: [{ conclusion: 'success' }] },
            { databaseId: 55002, conclusion: 'cancelled', steps: [] },
            {
              databaseId: 55004,
              conclusion: 'cancelled',
              steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }],
            },
          ],
        });
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '55001') {
        return '2026-11-25T00:00:01Z clean job 1\n';
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '55004') {
        return `2026-11-25T00:00:02Z mid-run cancelled leaked=${skToken}\n`;
      }
      throw new Error(`unexpected call: ${JSON.stringify(args)}`);
    };

    const res = scanRecentCiLogs({
      enabled: true,
      execFn: execWithCancelledJobs,
    });
    assert.equal(res.status, 'scanned');
    assert.equal(res.runsScanned, 1);
    assert.deepEqual(res.runIds, [990077]);
    assert.equal(res.ok, false);
    assert.ok(
      res.findings.some(
        (f) =>
          f.surface === 'ci-logs' &&
          f.location.startsWith('gh-run:990077:line:') &&
          f.rule === 'openai-api-key' &&
          f.severity === SEVERITY.HIGH
      )
    );
    assertStrictZeroLeakSchema(res.findings);
    assert.equal(JSON.stringify(res).includes(skToken), false);
  });

  test('C46-F4B: scanRecentCiLogs and scanRepoFiles allow mid-path /home/, runner/placeholder prefixes, and invalid dot/hyphen usernames (0 false positives)', () => {
    const posixHome = (suffix) => ['/ho', 'me/', suffix].join('');
    const filePlaceholderUri = ['file:', '///<USER_DIR>/home/custom/file.json'].join(''); // no-secrets:allow: synthetic placeholder URI fixture
    const cleanLogLines = [
      '2026-11-25T10:00:01Z sandbox config="/tmp/rs-c46-f3-e2e-0CXhOp/home/.hermes/config.yaml"',
      '2026-11-25T10:00:02Z sandbox user="/tmp/rs-c46-f3-e2e-0CXhOp/home/pilotuser/config.yaml"',
      '2026-11-25T10:00:03Z macos temp="/private/var/folders/xx/yy/T/rs-123/home/custom/file.json"',
      '2026-11-25T10:00:04Z win temp="C:/Users/runneradmin/AppData/Local/Temp/rs-123/home/custom/file.json"', // no-secrets:allow: synthetic runneradmin CI path fixture
      '2026-11-25T10:00:05Z linux runner="/home/runner/home/custom/file.json"', // no-secrets:allow: synthetic runner CI path fixture
      '2026-11-25T10:00:06Z masked user="<USER_DIR>/home/custom/file.json" repo="<REPO_ROOT>/home/custom/file.json"', // no-secrets:allow: synthetic placeholder path fixture
      `2026-11-25T10:00:07Z masked home="<HOME>/home/custom/file.json" u="<USER>/home/custom/file.json" uri="${filePlaceholderUri}"`, // no-secrets:allow: synthetic placeholder path fixture
      '2026-11-25T10:00:08Z rel="./home/custom/file.json" parent="../home/custom/file.json" url="https://github.com/home/settings"',
      `2026-11-25T10:00:09Z dot=${posixHome('.hermes/config.yaml')} flag=${posixHome('-flag')}`,
      posixHome('.hermes/config.yaml'),
      posixHome('-flag'),
      '/home/alice/.config /home/bob/.config /home/user/.config /home/example/.config /home/test/.config /home/mock/.config',
    ];

    const ciRes = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => [
        {
          id: 45644456985,
          headSha: 'ad83fe8be8d9',
          workflowName: 'CI',
          log: cleanLogLines.join('\n'),
        },
      ],
    });
    assert.equal(ciRes.ok, true, `Expected 0 CI log findings, got: ${JSON.stringify(ciRes.findings)}`);
    assert.equal(ciRes.findings.length, 0);

    const repoDir = makeTempDir('rs-c46-f4b-clean-');
    initTempGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'sandbox-notes.txt'), cleanLogLines.join('\n') + '\n', 'utf8');
    execFileSync('git', ['add', 'sandbox-notes.txt'], { cwd: repoDir });
    const repoRes = scanRepoFiles(repoDir);
    assert.equal(repoRes.ok, true, `Expected 0 repo findings, got: ${JSON.stringify(repoRes.findings)}`);
    assert.equal(repoRes.findings.length, 0);
  });

  test('C46-F4B: scanRecentCiLogs and scanRepoFiles fail closed on root-anchored /home/<username> across all delimiters and emit both personal-posix-path + file-url on file:///home/<username>', () => { // no-secrets:allow: test title describes file URI rule
    const posixHome = (suffix) => ['/ho', 'me/', suffix].join('');
    const fileUriLeak = ['file:', '///', 'ho', 'me/realperson/doc.md'].join('');
    const leakCases = [
      posixHome('realperson/.config/app.yaml'),
      `cd ${posixHome('realperson')}`,
      `"${posixHome('realperson/.hermes/config.yaml')}"`,
      `'${posixHome('realperson/file')}'`,
      `\`${posixHome('realperson/file')}\``,
      `HOME=${posixHome('realperson')}`,
      `PATH=/usr/bin:${posixHome('realperson/bin')}`,
      `(${posixHome('realperson')})`,
      `[${posixHome('realperson')}]`,
      `{${posixHome('realperson')}}`,
      `a,${posixHome('realperson')}`,
      `a;${posixHome('realperson')}`,
      `<dir>${posixHome('realperson')}</dir>`,
      posixHome('_svc/key'),
      posixHome('x/key'),
    ];

    for (const [idx, line] of leakCases.entries()) {
      const ciRes = scanRecentCiLogs({
        enabled: true,
        logFetcher: () => [{ id: 880000 + idx, headSha: 'deadbeef', workflowName: 'CI', log: line }],
      });
      assert.equal(ciRes.ok, false, `Expected CI log violation for case #${idx}: ${line}`);
      assert.ok(
        ciRes.findings.some((f) => f.rule === 'personal-posix-path' && f.severity === SEVERITY.HIGH),
        `Expected personal-posix-path finding for case #${idx}`
      );
      assertStrictZeroLeakSchema(ciRes.findings);
      assert.equal(JSON.stringify(ciRes).includes('realperson'), false);
      assert.equal(JSON.stringify(ciRes).includes('_svc'), false);
    }

    // Verify root-anchored file URI fires BOTH personal-posix-path AND file-url
    const uriRes = scanRecentCiLogs({
      enabled: true,
      logFetcher: () => [{ id: 889999, headSha: 'deadbeef', workflowName: 'CI', log: fileUriLeak }],
    });
    assert.equal(uriRes.ok, false);
    const rules = uriRes.findings.map((f) => f.rule).sort();
    assert.ok(rules.includes('personal-posix-path'), `Expected personal-posix-path in ${JSON.stringify(rules)}`);
    assert.ok(rules.includes('file-url'), `Expected file-url in ${JSON.stringify(rules)}`);
    assertStrictZeroLeakSchema(uriRes.findings);
    assert.equal(JSON.stringify(uriRes).includes('realperson'), false);
  });
});
