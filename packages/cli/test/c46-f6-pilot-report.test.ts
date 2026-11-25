/**
 * packages/cli/test/c46-f6-pilot-report.test.ts
 *
 * Ticket C46-F6 (`Phục vụ: S9`) — Read-Only `routersync pilot-report` Post-Pilot
 * Sign-Off Aggregator, Adversarial Corruption/Boundary Matrix & End-to-End
 * `OWNER-CHECKLIST.md` Pre/Post-Rollback Verification Suite.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NINE_ROUTER_EXPECTED_APP_VERSION,
  activateFreeze,
  appendApplyReceipt,
  openBetterSqlite3,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { COMMAND_CLASSES } from '../src/command-classification.js';
import { createCliProgram } from '../src/index.js';
import { runApplyCommand } from '../src/commands/apply.js';
import {
  runAppsApplyCommand,
  runAppsPlanCommand,
  runAppsRollbackCommand,
} from '../src/commands/apps.js';
import { runConsentGrantCommand } from '../src/commands/consent.js';
import { runFreezeCommand, runUnfreezeCommand } from '../src/commands/freeze.js';
import { runLiveCheckCommand } from '../src/commands/live-check.js';
import {
  assertOutPathOutsideStateDir,
  runPilotReportCommand,
} from '../src/commands/pilot-report.js';
import { runPlanCommand } from '../src/commands/plan.js';
import { runRollbackCommand } from '../src/commands/rollback.js';
import { runTickCommand } from '../src/commands/tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const INITIAL_TEN_MODELS = [
  'openai/gpt-4o-legacy',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/o3-mini',
  'openai/o4-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.5',
  'openai/gpt-5-nano',
];

const PROPOSE_PIN_MODELS = [
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/o3-mini',
  'openai/o4-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4.5',
  'openai/gpt-5-nano',
  'openai/gpt-4o-legacy',
];

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

interface DirFileSnapshot {
  relPath: string;
  sha256: string;
  mtimeMs: number;
  size: number;
}

function snapshotDirRecursive(rootDir: string): DirFileSnapshot[] {
  if (!fs.existsSync(rootDir)) return [];
  const entries: DirFileSnapshot[] = [];
  const walk = (dir: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(abs);
      } else if (dirent.isFile()) {
        const st = fs.statSync(abs);
        entries.push({
          relPath: path.relative(rootDir, abs).replace(/\\/g, '/'),
          sha256: sha256File(abs),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  };
  walk(rootDir);
  return entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function seedPassingPilotState(
  stateDir: string,
  nowMs = Date.parse('2026-11-25T10:00:00.000Z')
): void {
  fs.mkdirSync(path.join(stateDir, 'plans'), { recursive: true });

  upsertStandingConsentTarget(stateDir, {
    target: 'router:omniroute/rs-pilot',
    level: 'propose',
    nowMs,
  });
  upsertStandingConsentTarget(stateDir, {
    target: 'harness:hermes',
    level: 'propose',
    nowMs,
  });

  const routerRec = appendApplyReceipt(stateDir, {
    target: 'router:omniroute/rs-pilot',
    appliedAtLevel: 'propose',
    authorizedVia: 'interactive-tty',
    planHash: 'a'.repeat(64),
    appliedAt: new Date(nowMs + 1000).toISOString(),
    preDigest: '1'.repeat(64),
    postDigest: '2'.repeat(64),
    snapshotOrBackupRef: 'snap_1',
    success: true,
    readBackVerified: true,
    readBackLevel: 'full',
    rolledBack: false,
  });
  const harnessRec = appendApplyReceipt(stateDir, {
    target: 'harness:hermes',
    appliedAtLevel: 'propose',
    authorizedVia: 'interactive-tty',
    planHash: 'b'.repeat(64),
    appliedAt: new Date(nowMs + 2000).toISOString(),
    preDigest: '3'.repeat(64),
    postDigest: '4'.repeat(64),
    snapshotOrBackupRef: 'config.yaml.pre-pilot.bak',
    success: true,
    readBackVerified: true,
    readBackLevel: 'full',
    rolledBack: false,
  });

  upsertStandingConsentTarget(stateDir, {
    target: 'router:omniroute/rs-pilot',
    level: 'auto-safe',
    nowMs: nowMs + 3000,
  });
  upsertStandingConsentTarget(stateDir, {
    target: 'harness:hermes',
    level: 'auto-safe',
    nowMs: nowMs + 3000,
  });

  expect(routerRec.receiptId).toBeTruthy();
  expect(harnessRec.receiptId).toBeTruthy();

  fs.writeFileSync(
    path.join(stateDir, 'status.json'),
    JSON.stringify(
      {
        timestamp: new Date(nowMs + 5000).toISOString(),
        mode: 'auto-safe',
        effectiveMode: 'auto-safe',
        tokens: 0,
        llmCalls: 0,
        paidRequests: 0,
        providers: [],
        detectionLatency: {
          measuredCount: 2,
          minMs: 120,
          maxMs: 420,
          p50Ms: 270,
        },
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'plans', 'tick-plan.json'),
    JSON.stringify(
      {
        planCreatedAt: new Date(nowMs + 5000).toISOString(),
        routerActions: [],
        harnessActions: [],
        detectionLatency: {
          measuredCount: 2,
          minMs: 120,
          maxMs: 420,
          p50Ms: 270,
        },
        accounting: {
          tokens: 0,
          llmCalls: 0,
          paidRequests: 0,
        },
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'cost-ledger.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: new Date(nowMs + 5000).toISOString(),
        ticks: [
          {
            kind: 'tier0_tick',
            id: 'tick-1',
            timestamp: new Date(nowMs + 5000).toISOString(),
            isoWeek: '2026-W48',
            mode: 'auto-safe',
            tokens: 0,
            llmCalls: 0,
            paidRequests: 0,
            totalHttpRequests: 4,
            domainRequests: { '127.0.0.1': 4 },
          },
        ],
        researchSessions: [],
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'inbox.json'),
    JSON.stringify(
      {
        updatedAt: new Date(nowMs + 5000).toISOString(),
        items: [
          {
            id: 'auto-safe-1',
            label: 'AUTO-SAFE-APPLIED',
            title: 'Applied verified model list change',
            body: 'Clean auto-safe apply',
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
}

afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('C46-F6: routersync pilot-report Read-Only Sign-Off Aggregator', () => {
  it('registers pilot-report lazily in index.ts, classifies it as short, and preserves live-check import count === 1', () => {
    expect(COMMAND_CLASSES['pilot-report']).toBe('short');

    const program = createCliProgram();
    const cmd = program.commands.find((c) => c.name() === 'pilot-report');
    expect(cmd).toBeDefined();

    const longFlags = cmd!.options.map((o) => o.long);
    expect(longFlags).toEqual(
      expect.arrayContaining([
        '--state-dir',
        '--config',
        '--router-target',
        '--harness-target',
        '--serving-reflection-ms',
        '--false-removals',
        '--unplanned-interventions',
        '--out',
        '--json',
      ])
    );

    const indexSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts'),
      'utf8'
    );
    expect(indexSrc.match(/['"]\.\/commands\/live-check\.js['"]/g)).toHaveLength(1);
    expect(indexSrc).not.toMatch(/import\s+[^;]*from\s+['"]\.\/commands\/pilot-report\.js['"]/);
    expect(indexSrc).toMatch(/import\(['"]\.\/commands\/pilot-report\.js['"]\)/);
  });

  it('produces PASS JSON + 5-row Markdown S9 Sign-Off Table, writes external --out, and leaves <stateDir> 100% untouched', async () => {
    const root = makeTmpDir('rs-c46-f6-pass-');
    const stateDir = path.join(root, 'state');
    const outPath = path.join(root, 'reports', 's9-signoff.md');
    seedPassingPilotState(stateDir);

    const beforeSnap = snapshotDirRecursive(stateDir);

    const lines: string[] = [];
    process.exitCode = 0;
    const report = await runPilotReportCommand({
      stateDir,
      routerTarget: 'router:omniroute/rs-pilot',
      harnessTarget: 'harness:hermes',
      out: outPath,
      nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
      writeStdout: (text) => lines.push(text),
    });

    const afterSnap = snapshotDirRecursive(stateDir);
    expect(afterSnap).toEqual(beforeSnap);
    expect(process.exitCode).toBe(0);

    expect(report.status).toBe('PASS');
    expect(report.passed).toBe(true);
    expect(report.criteria.falseRemovals.passed).toBe(true);
    expect(report.criteria.falseRemovals.count).toBe(0);
    expect(report.criteria.rollbackByteExactMatch.passed).toBe(true);
    expect(report.criteria.rollbackByteExactMatch.matched).toBe(true);
    expect(report.criteria.detectionLatencyMs.passed).toBe(true);
    expect(report.criteria.detectionLatencyMs.maxMs).toBe(420);
    expect(report.criteria.cost.passed).toBe(true);
    expect(report.criteria.cost.tier0Tokens).toBe(0);
    expect(report.criteria.unplannedManualInterventions.passed).toBe(true);
    expect(report.criteria.unplannedManualInterventions.count).toBe(0);

    const humanOut = lines.join('');
    expect(humanOut).toContain('falseRemovals');
    expect(humanOut).toContain('rollbackByteExactMatch');
    expect(humanOut).toContain('detectionLatencyMs');
    expect(humanOut).toContain('tier0Tokens');
    expect(humanOut).toContain('unplannedManualInterventions');
    expect(humanOut).toContain('PASS');

    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, 'utf8')).toContain('PASS');
  });

  it('keeps servingReflectionMs strictly separate from detectionLatencyMs and respects 0ms & 60000ms boundaries', async () => {
    for (const boundaryLatency of [0, 60_000]) {
      const root = makeTmpDir('rs-c46-f6-d26-');
      const stateDir = path.join(root, 'state');
      seedPassingPilotState(stateDir);

      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify(
          {
            timestamp: '2026-11-25T10:00:05.000Z',
            tokens: 0,
            llmCalls: 0,
            paidRequests: 0,
            providers: [],
            detectionLatency: {
              measuredCount: 1,
              minMs: boundaryLatency,
              maxMs: boundaryLatency,
              p50Ms: boundaryLatency,
            },
          },
          null,
          2
        ),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify(
          {
            planCreatedAt: '2026-11-25T10:00:05.000Z',
            routerActions: [],
            harnessActions: [],
            detectionLatency: {
              measuredCount: 1,
              minMs: boundaryLatency,
              maxMs: boundaryLatency,
              p50Ms: boundaryLatency,
            },
            accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
          },
          null,
          2
        ),
        'utf8'
      );

      process.exitCode = 0;
      const report = await runPilotReportCommand({
        stateDir,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: 'harness:hermes',
        servingReflectionMs: 28500,
        json: true,
        silent: true,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
      });

      expect(process.exitCode).toBe(0);
      expect(report.status).toBe('PASS');
      expect(report.servingReflectionMs).toBe(28500);
      expect(report.criteria.detectionLatencyMs.maxMs).toBe(boundaryLatency);
      expect(report.criteria.detectionLatencyMs.passed).toBe(true);
    }
  });

  it('blocks --out pointing to <stateDir>, a child inside <stateDir>, an existing directory, or a symlink/junction targeting <stateDir> or forbidden runtime files (Q6, Q7)', async () => {
    const root = makeTmpDir('rs-c46-f6-out-containment-');
    const stateDir = path.join(root, 'state');
    seedPassingPilotState(stateDir);
    const beforeSnap = snapshotDirRecursive(stateDir);

    // 1. --out pointing directly to <stateDir>
    process.exitCode = 0;
    await expect(
      runPilotReportCommand({
        stateDir,
        out: stateDir,
        json: true,
        silent: true,
      })
    ).rejects.toThrow(/PILOT_REPORT_OUT_INSIDE_STATE_DIR/);
    expect(process.exitCode).toBe(1);
    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);

    // 2. --out pointing to a child path inside <stateDir>
    process.exitCode = 0;
    await expect(
      runPilotReportCommand({
        stateDir,
        out: path.join(stateDir, 'nested', 'report.json'),
        json: true,
        silent: true,
      })
    ).rejects.toThrow(/PILOT_REPORT_OUT_INSIDE_STATE_DIR/);
    expect(process.exitCode).toBe(1);
    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);

    // 3a. Directory symlink / junction outside <stateDir> targeting <stateDir> (Q6)
    const externalLinkDir = path.join(root, 'external-link-to-state');
    fs.symlinkSync(
      stateDir,
      externalLinkDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    process.exitCode = 0;
    await expect(
      runPilotReportCommand({
        stateDir,
        out: path.join(externalLinkDir, 'sneaky-report.json'),
        json: true,
        silent: true,
      })
    ).rejects.toThrow(/PILOT_REPORT_OUT_INSIDE_STATE_DIR/);
    expect(process.exitCode).toBe(1);
    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);

    // 3b. Direct file symlink & dangling file symlink targeting inside <stateDir> (when OS allows file symlinks)
    const fileLinkPath = path.join(root, 'file-link.json');
    const danglingLinkPath = path.join(root, 'dangling-link.json');
    let fileSymlinkCreated = false;
    try {
      fs.symlinkSync(path.join(stateDir, 'status.json'), fileLinkPath, 'file');
      fs.symlinkSync(path.join(stateDir, 'dangling-target.json'), danglingLinkPath, 'file');
      fileSymlinkCreated = true;
    } catch {
      fileSymlinkCreated = false;
    }
    if (fileSymlinkCreated) {
      for (const symOut of [fileLinkPath, danglingLinkPath]) {
        process.exitCode = 0;
        await expect(
          runPilotReportCommand({
            stateDir,
            out: symOut,
            json: true,
            silent: true,
          })
        ).rejects.toThrow(/PILOT_REPORT_OUT_INSIDE_STATE_DIR/);
        expect(process.exitCode).toBe(1);
        expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);
      }
    }

    // 4. Direct lexical forbidden runtime files (`bots.json`, `routines.json`) & empty `--out ""`
    for (const forbiddenOut of [
      path.join(root, 'bots.json'),
      path.join(root, 'routines.json'),
      '',
      '   ',
    ]) {
      process.exitCode = 0;
      await expect(
        runPilotReportCommand({
          stateDir,
          out: forbiddenOut,
          json: true,
          silent: true,
        })
      ).rejects.toThrow(/FORBIDDEN_RUNTIME_FILE|INVALID_ARGUMENT/);
      expect(process.exitCode).toBe(1);
      expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);
    }

    // 5. Q7a: --out pointing to an existing external directory -> INVALID_ARGUMENT (exitCode = 1)
    const existingExternalDir = path.join(root, 'existing-external-dir');
    fs.mkdirSync(existingExternalDir, { recursive: true });
    process.exitCode = 0;
    await expect(
      runPilotReportCommand({
        stateDir,
        out: existingExternalDir,
        json: true,
        silent: true,
      })
    ).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(process.exitCode).toBe(1);

    // 6. Q7b: Safe lexical basename (`safe-report.md`) resolving canonically to `bots.json` / `routines.json`
    //    6a) Real OS directory junction / symlink (works on Windows without Developer Mode AND Linux/macOS!)
    for (const forbiddenName of ['bots.json', 'routines.json']) {
      const canonicalForbiddenTarget = path.join(root, 'canonical-runtime-targets', forbiddenName);
      fs.mkdirSync(canonicalForbiddenTarget, { recursive: true });
      const sneakySafeOut = path.join(root, `safe-alias-for-${forbiddenName}.md`);
      fs.symlinkSync(
        canonicalForbiddenTarget,
        sneakySafeOut,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      process.exitCode = 0;
      await expect(
        runPilotReportCommand({
          stateDir,
          out: sneakySafeOut,
          json: true,
          silent: true,
        })
      ).rejects.toThrow(/FORBIDDEN_RUNTIME_FILE/);
      expect(process.exitCode).toBe(1);
    }

    //    6b) Real file symlink `safe-file-report.md -> bots.json` when OS permits file symlinks
    const realBotsFile = path.join(root, 'ext-files', 'bots.json');
    fs.mkdirSync(path.dirname(realBotsFile), { recursive: true });
    fs.writeFileSync(realBotsFile, '{"bots":[]}', 'utf8');
    const safeFileSymlink = path.join(root, 'safe-file-report.md');
    let botsFileSymlinkCreated = false;
    try {
      fs.symlinkSync(realBotsFile, safeFileSymlink, 'file');
      botsFileSymlinkCreated = true;
    } catch {
      botsFileSymlinkCreated = false;
    }
    if (botsFileSymlinkCreated) {
      process.exitCode = 0;
      await expect(
        runPilotReportCommand({
          stateDir,
          out: safeFileSymlink,
          json: true,
          silent: true,
        })
      ).rejects.toThrow(/FORBIDDEN_RUNTIME_FILE/);
      expect(process.exitCode).toBe(1);
    }

    //    6c) Direct canonical file target check on assertOutPathOutsideStateDir
    process.exitCode = 0;
    expect(() =>
      assertOutPathOutsideStateDir(
        path.join(root, 'clean-name.md'),
        stateDir,
        (p) => (p.endsWith('clean-name.md') ? realBotsFile : p)
      )
    ).toThrow(/FORBIDDEN_RUNTIME_FILE/);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(realBotsFile, 'utf8')).toBe('{"bots":[]}');
    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);
  });

  it('fails closed (exitCode = 1) on invalid --serving-reflection-ms, empty/whitespace D3 flags (--router-target "", --harness-target "   ", -c ""), and unknown CLI flags', async () => {
    const root = makeTmpDir('rs-c46-f6-bad-args-');
    const stateDir = path.join(root, 'state');
    seedPassingPilotState(stateDir);
    const beforeSnap = snapshotDirRecursive(stateDir);

    const invalidReflectionValues: Array<number | string> = [
      -1,
      '-1',
      Number.NaN,
      'NaN',
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      'Infinity',
      1.5,
      '1.5',
      '',
      '   ',
      'abc',
    ];

    for (const badVal of invalidReflectionValues) {
      process.exitCode = 0;
      await expect(
        runPilotReportCommand({
          stateDir,
          servingReflectionMs: badVal,
          json: true,
          silent: true,
        })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(process.exitCode).toBe(1);
    }

    // CLI Commander parse path with invalid --serving-reflection-ms strings
    for (const cliBadVal of ['-1', 'NaN', 'Infinity', '1.5', '', 'abc']) {
      process.exitCode = 0;
      const program = createCliProgram();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await expect(
        program.parseAsync([
          'node',
          'routersync',
          'pilot-report',
          '--state-dir',
          stateDir,
          '--serving-reflection-ms',
          cliBadVal,
          '--json',
        ])
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(process.exitCode).toBe(1);
    }

    // D3: Empty / whitespace --router-target, --harness-target, -c / --config / configPath fail closed!
    for (const badRouterTarget of ['', '   ']) {
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        routerTarget: badRouterTarget,
        harnessTarget: 'harness:hermes',
        json: true,
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.passed).toBe(false);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(rep.blockingReasons.join(' ')).toContain('INVALID_ARGUMENT');
      expect(process.exitCode).toBe(1);
    }

    for (const badHarnessTarget of ['', '   ']) {
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: badHarnessTarget,
        json: true,
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.passed).toBe(false);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(rep.blockingReasons.join(' ')).toContain('INVALID_ARGUMENT');
      expect(process.exitCode).toBe(1);
    }

    for (const badCfg of ['', '   ']) {
      process.exitCode = 0;
      const rep1 = await runPilotReportCommand({
        stateDir,
        config: badCfg,
        json: true,
        silent: true,
      });
      expect(rep1.status).toBe('FAIL');
      expect(rep1.passed).toBe(false);
      expect(rep1.blockingReasons.join(' ')).toContain('INVALID_ARGUMENT');
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      const rep2 = await runPilotReportCommand({
        stateDir,
        configPath: badCfg,
        json: true,
        silent: true,
      });
      expect(rep2.status).toBe('FAIL');
      expect(rep2.passed).toBe(false);
      expect(rep2.blockingReasons.join(' ')).toContain('INVALID_ARGUMENT');
      expect(process.exitCode).toBe(1);
    }

    // CLI Commander parse path for -c "", --router-target "", --harness-target "   "
    for (const cliD3Flags of [
      ['-c', ''],
      ['--router-target', ''],
      ['--harness-target', '   '],
    ]) {
      process.exitCode = 0;
      const stdoutChunks: string[] = [];
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(((chunk: string | Uint8Array) => {
          stdoutChunks.push(String(chunk));
          return true;
        }) as typeof process.stdout.write);
      try {
        const program = createCliProgram();
        await program.parseAsync([
          'node',
          'routersync',
          'pilot-report',
          '--state-dir',
          stateDir,
          ...cliD3Flags,
          '--json',
        ]);
      } finally {
        writeSpy.mockRestore();
      }
      expect(process.exitCode).toBe(1);
      const parsedCli = JSON.parse(stdoutChunks.join('')) as {
        status: string;
        blockingReasons: string[];
      };
      expect(parsedCli.status).toBe('FAIL');
      expect(parsedCli.blockingReasons.join(' ')).toContain('INVALID_ARGUMENT');
    }

    // Unknown CLI flag & excess positional argument rejected by Commander
    for (const badArgv of [
      ['node', 'routersync', 'pilot-report', '--state-dir', stateDir, '--unknown-flag'],
      ['node', 'routersync', 'pilot-report', '--state-dir', stateDir, 'unexpected-positional'],
    ]) {
      const program = createCliProgram();
      program.exitOverride();
      for (const sub of program.commands) {
        sub.exitOverride();
        sub.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      }
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      await expect(program.parseAsync(badArgv)).rejects.toThrow();
    }

    // Invalid --false-removals & --unplanned-interventions
    for (const badCount of [-1, '1.5', '', 'abc'] as Array<number | string>) {
      process.exitCode = 0;
      await expect(
        runPilotReportCommand({ stateDir, falseRemovals: badCount, silent: true })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;
      await expect(
        runPilotReportCommand({ stateDir, unplannedInterventions: badCount, silent: true })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(process.exitCode).toBe(1);
    }

    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);
  });

  it('enforces the isolated fail-closed state corruption matrix (each condition mutated independently)', async () => {
    // 1. Missing <stateDir> -> exitCode = 1, <stateDir> is NOT created on disk!
    {
      const missingStateDir = path.join(makeTmpDir('rs-c46-f6-missing-'), 'does-not-exist');
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir: missingStateDir,
        json: true,
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('STATE_DIR_MISSING');
      expect(fs.existsSync(missingStateDir)).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // 2a. standing-consent.json invalid HMAC (all other files valid)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-sc-hmac-'), 'state');
      seedPassingPilotState(stateDir);
      const consentPath = path.join(stateDir, 'standing-consent.json');
      const tampered = JSON.parse(fs.readFileSync(consentPath, 'utf8')) as Record<string, unknown>;
      tampered['hmacSha256'] = '0'.repeat(64);
      fs.writeFileSync(consentPath, JSON.stringify(tampered, null, 2), 'utf8');
      const snap = snapshotDirRecursive(stateDir);

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('CONSENT_HMAC_INVALID');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(snapshotDirRecursive(stateDir)).toEqual(snap);
    }

    // 2b. Missing standing-consent.json & legacy alias consent.json valid vs tampered
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-sc-missing-'), 'state');
      seedPassingPilotState(stateDir);
      const scRaw = fs.readFileSync(path.join(stateDir, 'standing-consent.json'), 'utf8');
      fs.unlinkSync(path.join(stateDir, 'standing-consent.json'));

      process.exitCode = 0;
      const missingSc = await runPilotReportCommand({ stateDir, silent: true });
      expect(missingSc.status).toBe('FAIL');
      expect(missingSc.blockingReasons.join(' ')).toContain('STANDING_CONSENT_MISSING');
      expect(process.exitCode).toBe(1);

      // Restore standing-consent.json + valid legacy alias consent.json -> PASS
      fs.writeFileSync(path.join(stateDir, 'standing-consent.json'), scRaw, 'utf8');
      fs.writeFileSync(path.join(stateDir, 'consent.json'), scRaw, 'utf8');
      process.exitCode = 0;
      const validAlias = await runPilotReportCommand({ stateDir, silent: true });
      expect(validAlias.status).toBe('PASS');
      expect(process.exitCode).toBe(0);

      // Tamper legacy alias consent.json HMAC -> FAIL
      const badAlias = JSON.parse(scRaw) as Record<string, unknown>;
      badAlias['hmacSha256'] = 'f'.repeat(64);
      fs.writeFileSync(path.join(stateDir, 'consent.json'), JSON.stringify(badAlias), 'utf8');
      process.exitCode = 0;
      const tamperedAlias = await runPilotReportCommand({ stateDir, silent: true });
      expect(tamperedAlias.status).toBe('FAIL');
      expect(tamperedAlias.blockingReasons.join(' ')).toContain('CONSENT_HMAC_INVALID');
      expect(process.exitCode).toBe(1);
    }

    // 3. apply-history.json invalid HMAC & missing apply-history.json
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-ah-hmac-'), 'state');
      seedPassingPilotState(stateDir);
      const historyPath = path.join(stateDir, 'apply-history.json');
      const tampered = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as Record<string, unknown>;
      tampered['hmacSha256'] = '0'.repeat(64);
      fs.writeFileSync(historyPath, JSON.stringify(tampered, null, 2), 'utf8');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('CONSENT_HMAC_INVALID');
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(process.exitCode).toBe(1);

      fs.unlinkSync(historyPath);
      process.exitCode = 0;
      const missingHist = await runPilotReportCommand({ stateDir, silent: true });
      expect(missingHist.status).toBe('FAIL');
      expect(missingHist.blockingReasons.join(' ')).toContain('APPLY_HISTORY_MISSING');
      expect(process.exitCode).toBe(1);
    }

    // 4a. freeze.json corrupted JSON
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-freeze-corrupt-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(path.join(stateDir, 'freeze.json'), '{malformed-freeze-json', 'utf8');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('FREEZE_STATE_CORRUPT');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.emergencyFreezeActive).toBe(false);
      expect(rep.criteria.unplannedManualInterventions.count).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // 4b. freeze.json frozen: true (valid JSON, active emergency freeze)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-freeze-active-'), 'state');
      seedPassingPilotState(stateDir);
      activateFreeze(stateDir, 'auto-rollback-circuit-breaker');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('EMERGENCY_FREEZE_ACTIVE');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(0);
      expect(rep.criteria.unplannedManualInterventions.emergencyFreezeActive).toBe(true);
      expect(rep.criteria.unplannedManualInterventions.count).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // 5. cost-ledger.json corrupted JSON (and negative token tamper)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-ledger-corrupt-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(path.join(stateDir, 'cost-ledger.json'), '{not-valid-json', 'utf8');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('COST_LEDGER_CORRUPT');
      expect(rep.criteria.cost.passed).toBe(false);
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(process.exitCode).toBe(1);

      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({ schemaVersion: 1, ticks: [{ tokens: -2 }] }),
        'utf8'
      );
      process.exitCode = 0;
      const negRep = await runPilotReportCommand({ stateDir, silent: true });
      expect(negRep.status).toBe('FAIL');
      expect(negRep.blockingReasons.join(' ')).toContain('COST_LEDGER_CORRUPT');
      expect(process.exitCode).toBe(1);
    }

    // 6. status.json corrupted JSON (and plans/tick-plan.json corrupted JSON independently)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-status-corrupt-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(path.join(stateDir, 'status.json'), '{bad-status-json', 'utf8');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('STATUS_JSON_CORRUPT');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-tickplan-corrupt-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        '{bad-tick-plan-json',
        'utf8'
      );

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('TICK_PLAN_CORRUPT');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(process.exitCode).toBe(1);
    }

    // 7. inbox.json corrupted JSON
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-inbox-corrupt-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(path.join(stateDir, 'inbox.json'), '{bad-inbox-json', 'utf8');

      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.blockingReasons.join(' ')).toContain('INBOX_CORRUPT');
      expect(rep.criteria.unplannedManualInterventions.stateCorruptionCount).toBe(1);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }
  });

  it('fails closed on each of the 5 S9 quantitative criteria and kills Q1, Q2, Q3, Q4, Q5, D1, D2 mutants individually', async () => {
    // Criterion 1a..1c: falseRemovals > 0 (manual flag, inbox incidents, and auto-safe receipt failure variants)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c1-manual-'), 'state');
      seedPassingPilotState(stateDir);
      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, falseRemovals: 1, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(false);
      expect(rep.criteria.falseRemovals.count).toBe(1);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(true);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(true);
      expect(rep.criteria.cost.passed).toBe(true);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(true);
      expect(process.exitCode).toBe(1);
    }

    for (const inboxItem of [
      { id: 'i1', label: 'AUTO-ROLLBACK', title: 'Incident 1' },
      { id: 'i2', label: 'INVARIANT-BLOCKED', title: 'Incident 2' },
      { id: 'i3', label: 'NOTICE', title: '[AUTO-ROLLBACK] Rolled back combo' },
    ]) {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c1-inbox-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'inbox.json'),
        JSON.stringify({ updatedAt: '2026-11-25T10:00:06.000Z', items: [inboxItem] }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(false);
      expect(rep.criteria.falseRemovals.autoRollbackIncidentCount).toBe(1);
      expect(process.exitCode).toBe(1);
    }

    for (const [success, readBackVerified] of [
      [false, true],
      [true, false],
    ] as const) {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c1-autosafe-'), 'state');
      seedPassingPilotState(stateDir);
      appendApplyReceipt(stateDir, {
        target: 'router:other/unrelated',
        appliedAtLevel: 'auto-safe',
        authorizedVia: 'standing-consent',
        planHash: 'c'.repeat(64),
        appliedAt: '2026-11-25T10:00:07.000Z',
        snapshotOrBackupRef: 'snap_auto',
        success,
        readBackVerified,
        readBackLevel: 'full',
        rolledBack: false,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: 'harness:hermes',
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.failedAutoSafeReceiptCount).toBe(1);
      expect(rep.criteria.falseRemovals.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // Criterion 2 & Q9: rollbackByteExactMatch / failedReceiptsCount > 0 (test success:false AND readBackVerified:false separately!)
    for (const [success, readBackVerified] of [
      [false, true],
      [true, false],
    ] as const) {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c2-'), 'state');
      seedPassingPilotState(stateDir);
      appendApplyReceipt(stateDir, {
        target: 'harness:hermes',
        appliedAtLevel: 'propose',
        authorizedVia: 'interactive-tty',
        planHash: 'd'.repeat(64),
        appliedAt: '2026-11-25T10:00:07.000Z',
        snapshotOrBackupRef: 'bak',
        success,
        readBackVerified,
        readBackLevel: 'full',
        rolledBack: false,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: 'harness:hermes',
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(true);
      expect(rep.criteria.rollbackByteExactMatch.failedReceiptsCount).toBe(1);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(true);
      expect(rep.criteria.cost.passed).toBe(true);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(true);
      expect(process.exitCode).toBe(1);
    }

    // Q4: Asymmetric missing target receipts when both --router-target & --harness-target are supplied
    {
      // Q4a: Router receipt verified, harness receipt missing (harnessVerified=false)
      const stateDirMissingHarness = path.join(makeTmpDir('rs-c46-f6-q4-no-harness-'), 'state');
      seedPassingPilotState(stateDirMissingHarness);
      process.exitCode = 0;
      const repNoHarness = await runPilotReportCommand({
        stateDir: stateDirMissingHarness,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: 'harness:opencode',
        silent: true,
      });
      expect(repNoHarness.status).toBe('FAIL');
      expect(repNoHarness.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(repNoHarness.blockingReasons.join(' ')).toContain('routerVerified=true');
      expect(repNoHarness.blockingReasons.join(' ')).toContain('harnessVerified=false');
      expect(process.exitCode).toBe(1);

      // Q4b: Harness receipt verified, router receipt missing (routerVerified=false)
      const stateDirMissingRouter = path.join(makeTmpDir('rs-c46-f6-q4-no-router-'), 'state');
      seedPassingPilotState(stateDirMissingRouter);
      process.exitCode = 0;
      const repNoRouter = await runPilotReportCommand({
        stateDir: stateDirMissingRouter,
        routerTarget: 'router:nine/other-combo',
        harnessTarget: 'harness:hermes',
        silent: true,
      });
      expect(repNoRouter.status).toBe('FAIL');
      expect(repNoRouter.criteria.rollbackByteExactMatch.passed).toBe(false);
      expect(repNoRouter.blockingReasons.join(' ')).toContain('routerVerified=false');
      expect(repNoRouter.blockingReasons.join(' ')).toContain('harnessVerified=true');
      expect(process.exitCode).toBe(1);
    }

    // Cleanly rolledBack: true receipts MUST NOT increment failedReceiptsCount
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c2-rolledback-'), 'state');
      seedPassingPilotState(stateDir);
      appendApplyReceipt(stateDir, {
        target: 'harness:hermes',
        appliedAtLevel: 'propose',
        authorizedVia: 'interactive-tty',
        planHash: 'e'.repeat(64),
        appliedAt: '2026-11-25T10:00:08.000Z',
        snapshotOrBackupRef: 'bak2',
        success: true,
        readBackVerified: true,
        readBackLevel: 'full',
        rolledBack: true,
      });
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        routerTarget: 'router:omniroute/rs-pilot',
        harnessTarget: 'harness:hermes',
        silent: true,
      });
      expect(rep.status).toBe('PASS');
      expect(rep.criteria.rollbackByteExactMatch.failedReceiptsCount).toBe(0);
      expect(rep.criteria.rollbackByteExactMatch.rolledBackReceiptsCount).toBe(1);
      expect(process.exitCode).toBe(0);
    }

    // Criterion 3: detectionLatencyMs > 60000, < 0, or missing
    for (const badLatency of [60_001, -1, null]) {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c3-'), 'state');
      seedPassingPilotState(stateDir);
      const latencyObj =
        badLatency === null
          ? {}
          : { detectionLatency: { measuredCount: 1, minMs: badLatency, maxMs: badLatency } };
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({ timestamp: '2026-11-25T10:00:05.000Z', providers: [], ...latencyObj }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [],
          harnessActions: [],
          ...latencyObj,
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(true);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(true);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(false);
      expect(rep.criteria.cost.passed).toBe(true);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(true);
      expect(process.exitCode).toBe(1);
    }

    // Q1: Math.max(tickPlanLatencyMs, statusLatencyMs) — both asymmetric directions must FAIL (> 60000 ms)
    for (const [statusLat, planLat] of [
      [120, 65_000],
      [65_000, 120],
    ] as const) {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-q1-'), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:05.000Z',
          providers: [],
          detectionLatency: {
            measuredCount: 1,
            minMs: statusLat,
            maxMs: statusLat,
            p50Ms: statusLat,
          },
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [],
          harnessActions: [],
          detectionLatency: {
            measuredCount: 1,
            minMs: planLat,
            maxMs: planLat,
            p50Ms: planLat,
          },
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({ stateDir, silent: true });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.detectionLatencyMs.maxMs).toBe(65_000);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // D1 unit contracts: steady-state measuredCount === 0 (PASS at 0ms or durationMs override) vs corrupt measuredCount cases (FAIL)
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-d1-unit-'), 'state');
      seedPassingPilotState(stateDir);
      const steadyLatency = { measuredCount: 0, minMs: null, maxMs: null, p50Ms: null };
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:05.000Z',
          providers: [{ provider: 'openai', ok: true }],
          detectionLatency: steadyLatency,
        }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [],
          harnessActions: [],
          detectionLatency: steadyLatency,
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );

      process.exitCode = 0;
      const steadyPass = await runPilotReportCommand({ stateDir, silent: true });
      expect(steadyPass.status).toBe('PASS');
      expect(steadyPass.criteria.detectionLatencyMs.maxMs).toBe(0);
      expect(process.exitCode).toBe(0);

      // Honors finite durationMs via Math.max when present alongside measuredCount === 0
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:05.000Z',
          providers: [],
          durationMs: 315,
          detectionLatency: steadyLatency,
        }),
        'utf8'
      );
      process.exitCode = 0;
      const steadyWithDur = await runPilotReportCommand({ stateDir, silent: true });
      expect(steadyWithDur.status).toBe('PASS');
      expect(steadyWithDur.criteria.detectionLatencyMs.maxMs).toBe(315);
      expect(process.exitCode).toBe(0);

      // Fail-closed: tick-plan.json has measuredCount === 0 WITH non-empty routerActions!
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [{ combo: 'rs-pilot', action: 'add' }],
          harnessActions: [],
          detectionLatency: steadyLatency,
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const inconsistentPlan = await runPilotReportCommand({ stateDir, silent: true });
      expect(inconsistentPlan.status).toBe('FAIL');
      expect(inconsistentPlan.blockingReasons.join(' ')).toContain('TICK_PLAN_CORRUPT');
      expect(process.exitCode).toBe(1);

      // Fail-closed: measuredCount === 1 with maxMs: null!
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [],
          harnessActions: [],
          detectionLatency: { measuredCount: 1, minMs: null, maxMs: null, p50Ms: null },
          accounting: { tokens: 0, llmCalls: 0, paidRequests: 0 },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const nullMaxWithPositiveCount = await runPilotReportCommand({ stateDir, silent: true });
      expect(nullMaxWithPositiveCount.status).toBe('FAIL');
      expect(nullMaxWithPositiveCount.blockingReasons.join(' ')).toContain('TICK_PLAN_CORRUPT');
      expect(process.exitCode).toBe(1);

      // Fail-closed: measuredCount < 0 or non-integer!
      for (const badMc of [-1, 1.5]) {
        fs.writeFileSync(
          path.join(stateDir, 'status.json'),
          JSON.stringify({
            timestamp: '2026-11-25T10:00:05.000Z',
            providers: [],
            detectionLatency: { measuredCount: badMc, minMs: null, maxMs: null },
          }),
          'utf8'
        );
        process.exitCode = 0;
        const badMcRep = await runPilotReportCommand({ stateDir, silent: true });
        expect(badMcRep.status).toBe('FAIL');
        expect(badMcRep.blockingReasons.join(' ')).toContain('STATUS_JSON_CORRUPT');
        expect(process.exitCode).toBe(1);
      }
    }

    // Criterion 4 & Q8: cost-ledger.json tier0Tokens > 0, tier0LlmCalls > 0, tier0PaidRequests > 0 individually
    for (const field of ['tokens', 'llmCalls', 'paidRequests'] as const) {
      const stateDir = path.join(makeTmpDir(`rs-c46-f6-c4-${field}-`), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          ticks: [
            {
              kind: 'tier0_tick',
              id: 't-1',
              timestamp: '2026-11-25T10:00:05.000Z',
              isoWeek: '2026-W48',
              mode: 'auto-safe',
              tokens: field === 'tokens' ? 1 : 0,
              llmCalls: field === 'llmCalls' ? 1 : 0,
              paidRequests: field === 'paidRequests' ? 1 : 0,
              totalHttpRequests: 1,
              domainRequests: {},
            },
          ],
          researchSessions: [],
        }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(true);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(true);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(true);
      expect(rep.criteria.cost.passed).toBe(false);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(true);
      expect(process.exitCode).toBe(1);
    }

    // Q2: status.json tokens / llmCalls / paidRequests > 0 individually while cost-ledger.json & tick-plan.json are 0
    for (const field of ['tokens', 'llmCalls', 'paidRequests'] as const) {
      const stateDir = path.join(makeTmpDir(`rs-c46-f6-q2-${field}-`), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'status.json'),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:05.000Z',
          providers: [],
          tokens: field === 'tokens' ? 1 : 0,
          llmCalls: field === 'llmCalls' ? 1 : 0,
          paidRequests: field === 'paidRequests' ? 1 : 0,
          detectionLatency: { measuredCount: 1, minMs: 100, maxMs: 100, p50Ms: 100 },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // Q3: plans/tick-plan.json accounting.tokens / llmCalls / paidRequests > 0 individually while cost-ledger.json & status.json are 0
    for (const field of ['tokens', 'llmCalls', 'paidRequests'] as const) {
      const stateDir = path.join(makeTmpDir(`rs-c46-f6-q3-${field}-`), 'state');
      seedPassingPilotState(stateDir);
      fs.writeFileSync(
        path.join(stateDir, 'plans', 'tick-plan.json'),
        JSON.stringify({
          planCreatedAt: '2026-11-25T10:00:05.000Z',
          routerActions: [],
          harnessActions: [],
          detectionLatency: { measuredCount: 1, minMs: 100, maxMs: 100, p50Ms: 100 },
          accounting: {
            tokens: field === 'tokens' ? 1 : 0,
            llmCalls: field === 'llmCalls' ? 1 : 0,
            paidRequests: field === 'paidRequests' ? 1 : 0,
          },
        }),
        'utf8'
      );
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // Weekly sessions 5/5 PASS, 6/5 FAIL, Q5 prior-week 6/5 FAIL, D2 ROUTERSYNC_MAX_WEEKLY_RESEARCH_SESSIONS=2 env cap FAIL, budgetExceeded:true FAIL
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c4-sessions-'), 'state');
      seedPassingPilotState(stateDir);
      const makeSessions = (n: number, isoWeek = '2026-W48') =>
        Array.from({ length: n }, (_, idx) => ({
          kind: 'tier1_research_session',
          sessionId: `sess-${isoWeek}-${idx + 1}`,
          startedAt: '2026-11-25T10:00:00.000Z',
          updatedAt: '2026-11-25T10:00:00.000Z',
          isoWeek,
          source: 'cli',
          toolCallsCount: 1,
          returnedTextBytes: 10,
          returnedTextChars: 10,
          submittedTextBytes: 10,
          submittedTextChars: 10,
          findingsSubmitted: 1,
        }));

      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          ticks: [],
          researchSessions: makeSessions(5),
        }),
        'utf8'
      );
      process.exitCode = 0;
      const passAt5 = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(passAt5.status).toBe('PASS');
      expect(passAt5.criteria.cost.passed).toBe(true);
      expect(process.exitCode).toBe(0);

      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          ticks: [],
          researchSessions: makeSessions(6),
        }),
        'utf8'
      );
      process.exitCode = 0;
      const failAt6 = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(failAt6.status).toBe('FAIL');
      expect(failAt6.criteria.cost.passed).toBe(false);
      expect(failAt6.criteria.cost.budgetExceeded).toBe(true);
      expect(process.exitCode).toBe(1);

      // Q5: 6 sessions in prior ISO week `2026-W47` while nowMs is in `2026-W48` (0 current-week sessions) -> FAIL!
      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          ticks: [],
          researchSessions: makeSessions(6, '2026-W47'),
        }),
        'utf8'
      );
      process.exitCode = 0;
      const failPriorWeek = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(failPriorWeek.status).toBe('FAIL');
      expect(failPriorWeek.criteria.cost.weeklySessionsUsed).toBe(6);
      expect(failPriorWeek.criteria.cost.budgetExceeded).toBe(true);
      expect(failPriorWeek.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);

      // D2: ROUTERSYNC_MAX_WEEKLY_RESEARCH_SESSIONS=2 env cap fails when cost-ledger.json has 3 sessions (<= 5 default, > 2 env cap)
      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          ticks: [],
          researchSessions: makeSessions(3, '2026-W48'),
        }),
        'utf8'
      );
      vi.stubEnv('ROUTERSYNC_MAX_WEEKLY_RESEARCH_SESSIONS', '2');
      process.exitCode = 0;
      const failEnvCap = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      vi.unstubAllEnvs();
      expect(failEnvCap.status).toBe('FAIL');
      expect(failEnvCap.criteria.cost.maxWeeklyResearchSessions).toBe(2);
      expect(failEnvCap.criteria.cost.weeklySessionsUsed).toBe(3);
      expect(failEnvCap.criteria.cost.budgetExceeded).toBe(true);
      expect(failEnvCap.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);

      // D2b: Explicit -c routersync.yaml research.maxWeeklyResearchSessions=2 + routers[].id alias resolution
      const cfgDir = makeTmpDir('rs-c46-f6-d2-cfg-');
      const cfgPath = path.join(cfgDir, 'routersync.yaml');
      fs.writeFileSync(
        cfgPath,
        [
          'version: 1',
          'routers:',
          '  - id: omni',
          '    adapter: omniroute',
          '    isolated: true',
          'research:',
          '  maxWeeklyResearchSessions: 2',
          '',
        ].join('\n'),
        'utf8'
      );
      process.exitCode = 0;
      const failConfigCap = await runPilotReportCommand({
        stateDir,
        config: cfgPath,
        routerTarget: 'router:omni/rs-pilot',
        harnessTarget: 'harness:hermes',
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(failConfigCap.status).toBe('FAIL');
      expect(failConfigCap.criteria.rollbackByteExactMatch.passed).toBe(true);
      expect(failConfigCap.criteria.cost.maxWeeklyResearchSessions).toBe(2);
      expect(failConfigCap.criteria.cost.weeklySessionsUsed).toBe(3);
      expect(failConfigCap.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);

      fs.writeFileSync(
        path.join(stateDir, 'cost-ledger.json'),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '2026-11-25T10:00:05.000Z',
          budgetExceeded: true,
          ticks: [],
          researchSessions: [],
        }),
        'utf8'
      );
      process.exitCode = 0;
      const failExplicitFlag = await runPilotReportCommand({
        stateDir,
        nowMs: Date.parse('2026-11-25T10:01:00.000Z'),
        silent: true,
      });
      expect(failExplicitFlag.status).toBe('FAIL');
      expect(failExplicitFlag.criteria.cost.passed).toBe(false);
      expect(process.exitCode).toBe(1);
    }

    // Criterion 5: unplannedManualInterventions > 0 individually
    {
      const stateDir = path.join(makeTmpDir('rs-c46-f6-c5-manual-'), 'state');
      seedPassingPilotState(stateDir);
      process.exitCode = 0;
      const rep = await runPilotReportCommand({
        stateDir,
        unplannedInterventions: 1,
        silent: true,
      });
      expect(rep.status).toBe('FAIL');
      expect(rep.criteria.falseRemovals.passed).toBe(true);
      expect(rep.criteria.rollbackByteExactMatch.passed).toBe(true);
      expect(rep.criteria.detectionLatencyMs.passed).toBe(true);
      expect(rep.criteria.cost.passed).toBe(true);
      expect(rep.criteria.unplannedManualInterventions.passed).toBe(false);
      expect(rep.criteria.unplannedManualInterventions.count).toBe(1);
      expect(process.exitCode).toBe(1);
    }
  });

  it('proves PASS (exitCode = 0) and zero <stateDir> mutation across exact OWNER-CHECKLIST.md progression (both pre-rollback & post-rollback)', async () => {
    const tmpRoot = makeTmpDir('rs-c46-f6-e2e-');
    const stateDir = path.join(tmpRoot, 'state');
    const fakeHome = path.join(tmpRoot, 'home');
    const routerDir = path.join(tmpRoot, 'router');
    const backupDir = path.join(tmpRoot, 'backups');
    const hermesDir = path.join(fakeHome, '.hermes');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(routerDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });

    vi.stubEnv('ROUTERSYNC_STATE_DIR', stateDir);
    vi.stubEnv('ROUTERSYNC_HOME', fakeHome);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(fakeHome, '.config'));
    vi.stubEnv('HERMES_HOME', hermesDir);

    const nowMs = Date.parse('2026-11-25T10:00:00.000Z');
    const initialIso = new Date(nowMs - 5 * 60_000).toISOString();

    const routerDbPath = path.join(routerDir, 'nine-rehearsal.sqlite');
    const db = openBetterSqlite3(routerDbPath, { restrictToDir: routerDir });
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER DEFAULT 1,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE providerNodes (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        data TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        isActive INTEGER DEFAULT 1
      );
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO settings (id, data) VALUES (1, '{}');
    `);
    for (const fullId of INITIAL_TEN_MODELS) {
      db.prepare('INSERT INTO models (id, provider, modelId, isActive) VALUES (?, ?, ?, 1)').run(
        fullId,
        'openai',
        fullId.split('/')[1]!
      );
    }
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-openai',
      'openai',
      'apikey',
      'OpenAI Rehearsal',
      null,
      1,
      1,
      JSON.stringify({
        apiKey: 'dummy-rehearsal-openai-key',
        baseUrl: 'https://api.openai.com/v1',
        prefix: 'openai',
      }),
      initialIso,
      initialIso
    );
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('rs-pilot', 'rs-pilot', null, JSON.stringify(INITIAL_TEN_MODELS), initialIso, initialIso);
    db.close();

    // Steps 2 & 3: Manual pre-pilot backups + SHA-256 digests
    fs.copyFileSync(routerDbPath, path.join(backupDir, 'router.pre-pilot.bak'));
    fs.writeFileSync(path.join(hermesDir, '.env'), 'OPENAI_API_KEY=dummy-hermes-env-key\n', 'utf8');
    const hermesConfigPath = path.join(hermesDir, 'config.yaml');
    const hermesBakPath = `${hermesConfigPath}.pre-pilot.bak`;
    const hermesInitial = [
      '# Hermes pilot config',
      'model:',
      '  provider: openai',
      '  default: openai/gpt-4.1',
      'providers:',
      '  openai:',
      '    base_url: https://api.openai.com/v1',
      '    api_key_env: OPENAI_API_KEY',
      '    models:',
      '      - gpt-4.1',
      '      - gpt-4.1-mini',
      '',
    ].join('\n');
    fs.writeFileSync(hermesConfigPath, hermesInitial, 'utf8');
    fs.copyFileSync(hermesConfigPath, hermesBakPath);
    const preHermesSha = sha256File(hermesConfigPath);

    const configPath = path.join(routerDir, 'routersync.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    isolated: false',
        '    baseUrl: http://127.0.0.1:9',
        '    db:',
        `      path: ${JSON.stringify(routerDbPath)}`,
        '    reload:',
        '      type: none',
        'schedule:',
        '  intervalMinutes: 15',
        'research:',
        '  maxWeeklyResearchSessions: 5',
        'combos:',
        '  - name: rs-pilot',
        '    routers:',
        '      - nine',
        '    size: 10',
        '    constraints:',
        '      freeOnly: false',
        '    pin:',
        ...PROPOSE_PIN_MODELS.map((m) => `      - ${m}`),
        '    autoMaintain: true',
        'adopt:',
        '  - router: nine',
        '    name: rs-pilot',
        '    mode: full',
        '',
      ].join('\n'),
      'utf8'
    );

    const observeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: INITIAL_TEN_MODELS.map((m) => ({ id: m.split('/')[1]! })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    // Step 5: Observe tick initializes status.json & tick-catalog.json cleanly
    await runTickCommand({
      configPath,
      stateDir,
      mode: 'observe',
      nowMs,
      minScanIntervalMs: 0,
      fetchFn: observeFetch,
      json: true,
    });

    // Step 6: Read-only 7-point live-check gate
    const liveCheck = await runLiveCheckCommand({
      config: configPath,
      stateDir,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: hermesConfigPath,
      nowMs: nowMs + 1000,
      json: true,
    });
    expect(liveCheck.status).toBe('READY_FOR_OWNER_LIVE_PILOT');

    // Steps 8 & 9: Grant standing consent at propose
    await runConsentGrantCommand({
      target: 'router:nine/rs-pilot',
      level: 'propose',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });
    await runConsentGrantCommand({
      target: 'harness:hermes',
      level: 'propose',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });

    // Steps 10 & 11: Dry-run plans
    await runPlanCommand({ configPath, json: true });
    await runAppsPlanCommand({
      app: 'hermes',
      config: hermesConfigPath,
      stateDir,
      home: fakeHome,
      json: true,
    });

    // Steps 12 & 13: Controlled propose apply on router & harness
    const applyOut = await runApplyCommand({
      configPath,
      stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    const snapId = applyOut.snapshots?.[0]?.snapshotId;
    expect(snapId).toBeTruthy();

    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesBakPath,
      stateDir,
      home: fakeHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });

    // Steps 14 & 15: Promote both targets to auto-safe
    await runConsentGrantCommand({
      target: 'router:nine/rs-pilot',
      level: 'auto-safe',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });
    await runConsentGrantCommand({
      target: 'harness:hermes',
      level: 'auto-safe',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });

    // Step 16: Deterministic auto-safe tick (0 LLM tokens)
    const autoSafeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              ...INITIAL_TEN_MODELS.map((m) => ({ id: m.split('/')[1]! })),
              { id: 'gpt-5.2-codex' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: Date.parse('2026-11-25T10:10:00.000Z'),
      minScanIntervalMs: 0,
      fetchFn: autoSafeFetch,
      json: true,
    });

    // Steps 17 & 18: Freeze & Unfreeze emergency circuit-breaker drill
    await runFreezeCommand({ reason: 'live-pilot-drill', stateDir, json: true });
    await runUnfreezeCommand({
      stateDir,
      isTTY: true,
      promptFn: async () => 'unfreeze',
      json: true,
    });

    // CHECKPOINT A (Pre-Rollback): pilot-report returns PASS with 0 <stateDir> mutations
    const preRollbackStateSnap = snapshotDirRecursive(stateDir);
    process.exitCode = 0;
    const preRollbackReport = await runPilotReportCommand({
      stateDir,
      config: configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      servingReflectionMs: 24300,
      nowMs: Date.parse('2026-11-25T10:12:00.000Z'),
      silent: true,
      json: true,
    });
    expect(snapshotDirRecursive(stateDir)).toEqual(preRollbackStateSnap);
    expect(process.exitCode).toBe(0);
    expect(preRollbackReport.status).toBe('PASS');
    expect(preRollbackReport.criteria.rollbackByteExactMatch.failedReceiptsCount).toBe(0);
    expect(preRollbackReport.criteria.rollbackByteExactMatch.rolledBackReceiptsCount).toBe(0);

    // Steps 19 & 20: Byte-exact rollback on router & harness
    await runRollbackCommand({
      configPath,
      stateDir,
      snapshotId: snapId!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    await runAppsRollbackCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesBakPath,
      expectedPreSha256: preHermesSha,
      stateDir,
      json: true,
    });
    expect(sha256File(hermesConfigPath)).toBe(preHermesSha);

    // Step 22 / CHECKPOINT B (Post-Rollback): pilot-report returns PASS with rolledBackReceiptsCount >= 2 & 0 <stateDir> mutations
    const postRollbackStateSnap = snapshotDirRecursive(stateDir);
    const markdownLines: string[] = [];
    process.exitCode = 0;
    const postRollbackReport = await runPilotReportCommand({
      stateDir,
      config: configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      servingReflectionMs: 24300,
      nowMs: Date.parse('2026-11-25T10:15:00.000Z'),
      writeStdout: (text) => markdownLines.push(text),
    });
    expect(snapshotDirRecursive(stateDir)).toEqual(postRollbackStateSnap);
    expect(process.exitCode).toBe(0);
    expect(postRollbackReport.status).toBe('PASS');
    expect(postRollbackReport.passed).toBe(true);
    expect(postRollbackReport.servingReflectionMs).toBe(24300);
    expect(postRollbackReport.criteria.falseRemovals.passed).toBe(true);
    expect(postRollbackReport.criteria.rollbackByteExactMatch.passed).toBe(true);
    expect(postRollbackReport.criteria.rollbackByteExactMatch.failedReceiptsCount).toBe(0);
    expect(
      postRollbackReport.criteria.rollbackByteExactMatch.rolledBackReceiptsCount
    ).toBeGreaterThanOrEqual(2);
    expect(postRollbackReport.criteria.detectionLatencyMs.passed).toBe(true);
    expect(postRollbackReport.criteria.cost.passed).toBe(true);
    expect(postRollbackReport.criteria.unplannedManualInterventions.passed).toBe(true);
    expect(markdownLines.join('')).toContain('PASS');
  }, 60_000);

  it('proves PASS (exitCode = 0, detectionLatencyMs === 0) across steady-state OWNER-CHECKLIST.md progression when Step 5 and Step 16 observe identical /v1/models catalogs (D1)', async () => {
    const tmpRoot = makeTmpDir('rs-c46-f6-steady-e2e-');
    const stateDir = path.join(tmpRoot, 'state');
    const fakeHome = path.join(tmpRoot, 'home');
    const routerDir = path.join(tmpRoot, 'router');
    const backupDir = path.join(tmpRoot, 'backups');
    const hermesDir = path.join(fakeHome, '.hermes');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(routerDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });

    vi.stubEnv('ROUTERSYNC_STATE_DIR', stateDir);
    vi.stubEnv('ROUTERSYNC_HOME', fakeHome);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(fakeHome, '.config'));
    vi.stubEnv('HERMES_HOME', hermesDir);

    const nowMs = Date.parse('2026-11-25T11:00:00.000Z');
    const initialIso = new Date(nowMs - 5 * 60_000).toISOString();

    const routerDbPath = path.join(routerDir, 'nine-steady.sqlite');
    const db = openBetterSqlite3(routerDbPath, { restrictToDir: routerDir });
    db.exec(`
      CREATE TABLE combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT,
        models TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE providerConnections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        authType TEXT NOT NULL,
        name TEXT,
        email TEXT,
        priority INTEGER DEFAULT 1,
        isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE providerNodes (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        data TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        modelId TEXT NOT NULL,
        isActive INTEGER DEFAULT 1
      );
      CREATE TABLE kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO settings (id, data) VALUES (1, '{}');
    `);
    for (const fullId of INITIAL_TEN_MODELS) {
      db.prepare('INSERT INTO models (id, provider, modelId, isActive) VALUES (?, ?, ?, 1)').run(
        fullId,
        'openai',
        fullId.split('/')[1]!
      );
    }
    db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run(
      'appVersion',
      NINE_ROUTER_EXPECTED_APP_VERSION
    );
    db.prepare(
      'INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'conn-openai',
      'openai',
      'apikey',
      'OpenAI Steady',
      null,
      1,
      1,
      JSON.stringify({
        apiKey: 'dummy-steady-openai-key',
        baseUrl: 'https://api.openai.com/v1',
        prefix: 'openai',
      }),
      initialIso,
      initialIso
    );
    db.prepare(
      'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('rs-pilot', 'rs-pilot', null, JSON.stringify(INITIAL_TEN_MODELS), initialIso, initialIso);
    db.close();

    fs.copyFileSync(routerDbPath, path.join(backupDir, 'router.pre-pilot.bak'));
    fs.writeFileSync(path.join(hermesDir, '.env'), 'OPENAI_API_KEY=dummy-hermes-env-key\n', 'utf8');
    const hermesConfigPath = path.join(hermesDir, 'config.yaml');
    const hermesBakPath = `${hermesConfigPath}.pre-pilot.bak`;
    fs.writeFileSync(
      hermesConfigPath,
      [
        '# Hermes steady pilot config',
        'model:',
        '  provider: openai',
        '  default: openai/gpt-4.1',
        'providers:',
        '  openai:',
        '    base_url: https://api.openai.com/v1',
        '    api_key_env: OPENAI_API_KEY',
        '    models:',
        '      - gpt-4.1',
        '      - gpt-4.1-mini',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.copyFileSync(hermesConfigPath, hermesBakPath);
    const preHermesSha = sha256File(hermesConfigPath);

    const configPath = path.join(routerDir, 'routersync.yaml');
    fs.writeFileSync(
      configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    isolated: false',
        '    baseUrl: http://127.0.0.1:9',
        '    db:',
        `      path: ${JSON.stringify(routerDbPath)}`,
        '    reload:',
        '      type: none',
        'schedule:',
        '  intervalMinutes: 15',
        'combos:',
        '  - name: rs-pilot',
        '    routers:',
        '      - nine',
        '    size: 10',
        '    constraints:',
        '      freeOnly: false',
        '    pin:',
        ...PROPOSE_PIN_MODELS.map((m) => `      - ${m}`),
        '    autoMaintain: true',
        'adopt:',
        '  - router: nine',
        '    name: rs-pilot',
        '    mode: full',
        '',
      ].join('\n'),
      'utf8'
    );

    // Identical steady-state /v1/models response for BOTH Step 5 and Step 16!
    const steadyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: INITIAL_TEN_MODELS.map((m) => ({ id: m.split('/')[1]! })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    // Step 5: Observe tick
    await runTickCommand({
      configPath,
      stateDir,
      mode: 'observe',
      nowMs,
      minScanIntervalMs: 0,
      fetchFn: steadyFetch,
      json: true,
    });

    // Step 6: Read-only live-check
    const liveCheck = await runLiveCheckCommand({
      config: configPath,
      stateDir,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: hermesConfigPath,
      nowMs: nowMs + 1000,
      json: true,
    });
    expect(liveCheck.status).toBe('READY_FOR_OWNER_LIVE_PILOT');

    // Steps 8, 9, 12, 13, 14, 15: Propose consent, apply, promote to auto-safe
    await runConsentGrantCommand({
      target: 'router:nine/rs-pilot',
      level: 'propose',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });
    await runConsentGrantCommand({
      target: 'harness:hermes',
      level: 'propose',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });

    const applyOut = await runApplyCommand({
      configPath,
      stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    const snapId = applyOut.snapshots?.[0]?.snapshotId;
    expect(snapId).toBeTruthy();

    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesBakPath,
      stateDir,
      home: fakeHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });

    await runConsentGrantCommand({
      target: 'router:nine/rs-pilot',
      level: 'auto-safe',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });
    await runConsentGrantCommand({
      target: 'harness:hermes',
      level: 'auto-safe',
      stateDir,
      isTTY: true,
      promptFn: async () => 'consent',
      json: true,
    });

    // Step 16: Auto-safe tick against IDENTICAL catalog (zero upstream changes -> measuredCount === 0, maxMs === null)
    await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: Date.parse('2026-11-25T11:10:00.000Z'),
      minScanIntervalMs: 0,
      fetchFn: steadyFetch,
      json: true,
    });

    const onDiskStatus = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'status.json'), 'utf8')
    ) as { detectionLatency: { measuredCount: number; maxMs: number | null } };
    const onDiskPlan = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'plans', 'tick-plan.json'), 'utf8')
    ) as { detectionLatency: { measuredCount: number; maxMs: number | null } };
    expect(onDiskStatus.detectionLatency.measuredCount).toBe(0);
    expect(onDiskStatus.detectionLatency.maxMs).toBeNull();
    expect(onDiskPlan.detectionLatency.measuredCount).toBe(0);
    expect(onDiskPlan.detectionLatency.maxMs).toBeNull();

    // Steps 19 & 20: Rollback router & harness
    await runRollbackCommand({
      configPath,
      stateDir,
      snapshotId: snapId!,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    await runAppsRollbackCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesBakPath,
      expectedPreSha256: preHermesSha,
      stateDir,
      json: true,
    });

    // Step 22: pilot-report with -c configPath returns PASS (detectionLatencyMs.maxMs === 0, exitCode = 0)
    const beforeSnap = snapshotDirRecursive(stateDir);
    process.exitCode = 0;
    const steadyReport = await runPilotReportCommand({
      stateDir,
      config: configPath,
      routerTarget: 'router:nine/rs-pilot',
      harnessTarget: 'harness:hermes',
      nowMs: Date.parse('2026-11-25T11:12:00.000Z'),
      json: true,
      silent: true,
    });
    expect(snapshotDirRecursive(stateDir)).toEqual(beforeSnap);
    expect(process.exitCode).toBe(0);
    expect(steadyReport.status).toBe('PASS');
    expect(steadyReport.passed).toBe(true);
    expect(steadyReport.criteria.detectionLatencyMs.passed).toBe(true);
    expect(steadyReport.criteria.detectionLatencyMs.maxMs).toBe(0);
  }, 60_000);
});
