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
 *      errors, partial per-run log failures, and empty run lists, and records `ciLogs.runIds`
 *      + `evidenceRefs.refs` metadata.
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
  test('parseSecurityAuditArgs defaults to ciRunsLimit=10 and ciBranch="main" and supports overrides', () => {
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

  test('runSecurityAudit exposes surfaces.ciLogs.{branch,runIds} and surfaces.evidenceRefs.refs deterministically', async () => {
    const repoDir = makeTempDir('rs-sec-meta-');
    initTempGitRepo(repoDir);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Clean repo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial main'], { cwd: repoDir });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: repoDir });

    // Create two evidence refs (`refs/remotes/origin/evidence/d3` and `refs/heads/evidence/c44`)
    execFileSync('git', ['checkout', '-q', '-b', 'evidence/c44'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'evidence', 'c44.txt'), 'clean c44 proof\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'c44 evidence'], { cwd: repoDir });

    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir });
    execFileSync('git', ['checkout', '-q', '-b', 'tmp-d3'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'evidence', 'd3.txt'), 'clean d3 proof\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'd3 evidence'], { cwd: repoDir });
    const d3Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/evidence/d3', d3Sha], { cwd: repoDir });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir });
    execFileSync('git', ['branch', '-D', 'tmp-d3'], { cwd: repoDir });

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
    assert.equal(report.surfaces.evidenceRefs.refsScanned, 2);
    assert.deepEqual(report.surfaces.evidenceRefs.refs, ['evidence/c44', 'origin/evidence/d3']);
  });

  test('defaultCiLogFetcher recovers executed job logs when a matrix run has a 0-step cancelled job and catches secrets', () => {
    const skToken = buildSyntheticSkToken();
    const execWithCancelledJob = (_bin, args) => {
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
            { databaseId: 55003, conclusion: 'failure', steps: [{ conclusion: 'failure' }] },
          ],
        });
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '55001') {
        return '2026-11-25T00:00:01Z clean job 1\n';
      }
      if (args[0] === 'run' && args[1] === 'view' && args[3] === '--job' && args[4] === '55003') {
        return `2026-11-25T00:00:02Z leaked=${skToken}\n`;
      }
      throw new Error('unexpected call');
    };

    const res = scanRecentCiLogs({
      enabled: true,
      execFn: execWithCancelledJob,
    });
    assert.equal(res.status, 'scanned');
    assert.equal(res.runsScanned, 1);
    assert.deepEqual(res.runIds, [990077]);
    assert.equal(res.ok, false);
    assert.ok(res.findings.some((f) => f.location.startsWith('gh-run:990077:line:') && f.rule === 'openai-api-key'));
    assert.equal(JSON.stringify(res).includes(skToken), false);
  });
});
