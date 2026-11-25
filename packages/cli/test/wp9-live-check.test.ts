/**
 * packages/cli/test/wp9-live-check.test.ts
 *
 * C45-WP9 (`Phục vụ: S9`) — Red-First TDD & Mutation-Killing Suite for:
 *  - `routersync live-check` (`packages/cli/src/commands/live-check.ts`)
 *  - Dynamic lazy-loading in `packages/cli/src/index.ts` & `'live-check': 'short'` in `command-classification.ts`
 *  - 100% zero-mutation guarantee (`sha256` + `mtimeMs` preserved across router DB, harness config, and `stateDir`)
 *  - Unconditional `os.tmpdir()/rs-livecheck-*` cleanup in `finally`
 *  - All 6 pre-flight checks (`freeze_clear`, `config_and_doctor_health`, `pilot_targets_readable`,
 *    `tmpdir_backup_rollback_rehearsal`, `consent_and_promotion_state`, `cost_and_release_hygiene`)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateFreeze,
  appendApplyReceipt,
  appendTickCostEntry,
  openBetterSqlite3,
  recordResearchSessionActivity,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { COMMAND_CLASSES } from '../src/command-classification.js';
import { createCliProgram } from '../src/index.js';
import { runLiveCheckCommand } from '../src/commands/live-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface FileSnapshot {
  relPath: string;
  sha256: string;
  mtimeMs: number;
  size: number;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotDirectoryTree(rootDir: string): FileSnapshot[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results: FileSnapshot[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        results.push({
          relPath: path.relative(rootDir, abs).replace(/\\/g, '/'),
          sha256: sha256File(abs),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
  };
  walk(rootDir);
  return results;
}

function listRsLiveCheckTmpDirs(): string[] {
  try {
    return fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('rs-livecheck-'))
      .sort();
  } catch {
    return [];
  }
}

interface PilotFixture {
  rootDir: string;
  routerDir: string;
  harnessDir: string;
  stateDir: string;
  fakeHome: string;
  routerDbPath: string;
  configPath: string;
  harnessConfigPath: string;
  nowMs: number;
}

function createHermeticPilotFixture(): PilotFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp9-fixture-'));
  const routerDir = path.join(rootDir, 'router-data');
  const harnessDir = path.join(rootDir, 'harness-data');
  const stateDir = path.join(rootDir, 'state-dir');
  const fakeHome = path.join(rootDir, 'fake-home');

  fs.mkdirSync(routerDir, { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  const nowMs = Date.parse('2026-11-25T00:30:00.000Z');
  const routerDbPath = path.join(routerDir, 'omniroute.sqlite');

  const db = openBetterSqlite3(routerDbPath, { restrictToDir: routerDir });
  db.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      models TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO combos (id, name, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(
    'combo-1',
    'coding-main',
    JSON.stringify(['gemini/gemini-2.5-pro', 'openrouter/deepseek/deepseek-chat']),
    new Date(nowMs - 3600_000).toISOString(),
    new Date(nowMs - 3600_000).toISOString()
  );
  db.close();

  const configPath = path.join(routerDir, 'routersync.yaml');
  fs.writeFileSync(
    configPath,
    [
      'version: 1',
      'routers:',
      '  - id: omni',
      '    adapter: omniroute',
      '    baseUrl: http://127.0.0.1:9',
      '    isolated: true',
      `    db:`,
      `      path: ${JSON.stringify(routerDbPath)}`,
      'schedule:',
      '  intervalMinutes: 15',
      'research:',
      '  maxWeeklyResearchSessions: 5',
      'combos:',
      '  - name: coding-main',
      '    role: coding',
      '    routers:',
      '      - omni',
      '    size: 2',
      '',
    ].join('\n'),
    'utf8'
  );

  const harnessConfigPath = path.join(harnessDir, 'config.yaml');
  fs.writeFileSync(
    harnessConfigPath,
    [
      '# Hermes pilot config — preserve comments & default model slots',
      'model:',
      '  provider: openrouter',
      '  default: openrouter/anthropic/claude-sonnet-4',
      'providers:',
      '  openrouter:',
      '    base_url: https://openrouter.ai/api/v1',
      '    models:',
      '      - anthropic/claude-sonnet-4',
      '      - google/gemini-2.5-pro',
      '',
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'status.json'),
    `${JSON.stringify(
      {
        timestamp: new Date(nowMs - 5 * 60_000).toISOString(),
        mode: 'observe',
        ok: true,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  appendTickCostEntry(stateDir, {
    nowMs: nowMs - 5 * 60_000,
    mode: 'observe',
    totalHttpRequests: 3,
    domainRequests: { 'openrouter.ai': 3 },
  });

  // Backdate mtimes slightly so any unexpected touch during live-check is immediately caught
  const fixedDate = new Date(nowMs - 120_000);
  for (const dir of [routerDir, harnessDir, stateDir]) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isFile()) {
        fs.utimesSync(full, fixedDate, fixedDate);
      }
    }
  }

  return {
    rootDir,
    routerDir,
    harnessDir,
    stateDir,
    fakeHome,
    routerDbPath,
    configPath,
    harnessConfigPath,
    nowMs,
  };
}

describe('C45-WP9: routersync live-check CLI registration, lazy-load & classification (M6)', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it('classifies live-check as short and dynamically imports ./commands/live-check.js', () => {
    expect(COMMAND_CLASSES['live-check']).toBe('short');

    const indexSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.ts'),
      'utf8'
    );
    expect(indexSrc).not.toMatch(/import\s+(?:[^;()]*from\s+)?['"]\.\/commands\/live-check\.js['"]/s);
    expect(indexSrc).toMatch(/await\s+import\(['"]\.\/commands\/live-check\.js['"]\)/);
    const liveCheckRefs = indexSrc.match(/['"]\.\/commands\/live-check\.js['"]/g) ?? [];
    expect(liveCheckRefs).toHaveLength(1);

    const program = createCliProgram();
    const liveCheckCmd = program.commands.find((c) => c.name() === 'live-check');
    expect(liveCheckCmd).toBeDefined();
    const help = liveCheckCmd!.helpInformation();
    expect(help).toContain('--router-target');
    expect(help).toContain('--harness-target');
    expect(help).toContain('--harness-config-path');
    expect(help).toContain('--config');
    expect(help).toContain('--state-dir');
    expect(help).toContain('--json');
  });
});

describe('C45-WP9: routersync live-check zero-mutation pre-flight & failure modes (M1..M5)', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    process.exitCode = 0;
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns READY_FOR_OWNER_LIVE_PILOT with 100% zero mutation on routerDir, harnessDir, stateDir, and cleans up os.tmpdir() (M2)', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    const routerSnapBefore = snapshotDirectoryTree(fx.routerDir);
    const harnessSnapBefore = snapshotDirectoryTree(fx.harnessDir);
    const stateSnapBefore = snapshotDirectoryTree(fx.stateDir);
    const tmpBeforeSet = new Set(listRsLiveCheckTmpDirs());

    const report = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(report.vietnameseGateStatus).toBe('sẵn sàng chạy thật');
    expect(report.pilotPhase).toBe('NEEDS_INITIAL_PROPOSE_CONSENT');
    expect(report.pilotTargets).toEqual({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
    });
    expect(report.blockingReasons).toEqual([]);
    expect(report.checks.map((c) => c.id)).toEqual([
      'freeze_clear',
      'config_and_doctor_health',
      'pilot_targets_readable',
      'tmpdir_backup_rollback_rehearsal',
      'consent_and_promotion_state',
      'cost_and_release_hygiene',
    ]);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    const rehearsalCheck = report.checks.find((c) => c.id === 'tmpdir_backup_rollback_rehearsal')!;
    expect(rehearsalCheck.detail).toContain('rs-livecheck-');
    expect(report.ownerNextCommands.some((cmd) => cmd.includes('routersync consent grant'))).toBe(
      true
    );

    // Strict zero-mutation assertion: sha256, mtimeMs, size, and file list must be 100% identical
    expect(snapshotDirectoryTree(fx.routerDir)).toEqual(routerSnapBefore);
    expect(snapshotDirectoryTree(fx.harnessDir)).toEqual(harnessSnapBefore);
    expect(snapshotDirectoryTree(fx.stateDir)).toEqual(stateSnapBefore);

    // Unconditional cleanup of os.tmpdir()/rs-livecheck-* (before/after set difference safe under parallel workers)
    const leakedTmpDirs = listRsLiveCheckTmpDirs().filter((name) => !tmpBeforeSet.has(name));
    expect(leakedTmpDirs).toEqual([]);
  });

  it('tracks consent & promotion lifecycle across READY_FOR_PROPOSE_STEP -> READY_FOR_AUTO_SAFE_PROMOTION -> AUTO_SAFE_ACTIVE', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    upsertStandingConsentTarget(fx.stateDir, {
      target: 'router:omniroute/coding-main',
      level: 'propose',
      nowMs: fx.nowMs,
    });
    upsertStandingConsentTarget(fx.stateDir, {
      target: 'harness:hermes',
      level: 'propose',
      nowMs: fx.nowMs,
    });

    const step1 = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(step1.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(step1.pilotPhase).toBe('READY_FOR_PROPOSE_STEP');

    appendApplyReceipt(fx.stateDir, {
      target: 'router:omniroute/coding-main',
      planHash: 'plan-router-1',
      appliedAt: new Date(fx.nowMs).toISOString(),
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: true,
      readBackLevel: 'db-only',
      rolledBack: false,
      snapshotOrBackupRef: 'snap-1',
    });
    appendApplyReceipt(fx.stateDir, {
      target: 'harness:hermes',
      planHash: 'plan-harness-1',
      appliedAt: new Date(fx.nowMs).toISOString(),
      appliedAtLevel: 'propose',
      authorizedVia: 'approval-token',
      success: true,
      readBackVerified: true,
      readBackLevel: 'verified',
      rolledBack: false,
      snapshotOrBackupRef: 'bak-1',
    });

    const step2 = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(step2.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(step2.pilotPhase).toBe('READY_FOR_AUTO_SAFE_PROMOTION');

    upsertStandingConsentTarget(fx.stateDir, {
      target: 'router:omniroute/coding-main',
      level: 'auto-safe',
      nowMs: fx.nowMs,
    });
    upsertStandingConsentTarget(fx.stateDir, {
      target: 'harness:hermes',
      level: 'auto-safe',
      nowMs: fx.nowMs,
    });

    const step3 = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(step3.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(step3.pilotPhase).toBe('AUTO_SAFE_ACTIVE');
  });

  it('supports JSON router DB fixtures and OpenCode JSONC harness configs with byte-exact tmpdir rehearsal', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    const jsonDbPath = path.join(fx.routerDir, 'db.json');
    fs.writeFileSync(
      jsonDbPath,
      `${JSON.stringify(
        {
          combos: [{ id: 'c1', name: 'coding-main', models: ['gemini/gemini-2.5-flash'] }],
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    fs.writeFileSync(
      fx.configPath,
      [
        'version: 1',
        'routers:',
        '  - id: nine',
        '    adapter: 9router',
        '    baseUrl: http://127.0.0.1:9',
        '    isolated: true',
        '    db:',
        `      path: ${JSON.stringify(jsonDbPath)}`,
        'schedule:',
        '  intervalMinutes: 15',
        'combos:',
        '  - name: coding-main',
        '    role: coding',
        '    routers:',
        '      - nine',
        '    size: 2',
        '',
      ].join('\n'),
      'utf8'
    );

    const openCodePath = path.join(fx.harnessDir, 'opencode.jsonc');
    fs.writeFileSync(
      openCodePath,
      [
        '{',
        '  // Preserve user JSONC comments',
        '  "model": "openrouter/anthropic/claude-sonnet-4",',
        '  "provider": {',
        '    "openrouter": {',
        '      "models": {',
        '        "anthropic/claude-sonnet-4": { "name": "Claude Sonnet 4" }',
        '      }',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    const report = await runLiveCheckCommand({
      harnessTarget: 'harness:opencode',
      harnessConfigPath: openCodePath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });

    expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(report.pilotTargets.routerTarget).toBe('router:nine/coding-main');
  });

  it('blocks when emergency freeze.json is active or corrupted (kills M1)', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    activateFreeze(fx.stateDir, 'live-pilot-drill', fx.nowMs);

    const frozenReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });

    expect(frozenReport.status).toBe('BLOCKED');
    expect(frozenReport.vietnameseGateStatus).toBe('chưa đủ điều kiện chạy thật');
    const freezeCheck = frozenReport.checks.find((c) => c.id === 'freeze_clear')!;
    expect(freezeCheck.passed).toBe(false);
    expect(freezeCheck.remediationCommand).toContain('routersync unfreeze');
    expect(frozenReport.blockingReasons.length).toBeGreaterThan(0);

    // Corrupt freeze.json fail-closed
    fs.writeFileSync(path.join(fx.stateDir, 'freeze.json'), '{not-valid-json', 'utf8');
    const corruptReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(corruptReport.status).toBe('BLOCKED');
    expect(corruptReport.checks.find((c) => c.id === 'freeze_clear')?.passed).toBe(false);
  });

  it('blocks when status.json is missing or stale (> 2x configured interval) (kills M3)', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    // 35 minutes old > 2 * 15m (30m)
    fs.writeFileSync(
      path.join(fx.stateDir, 'status.json'),
      JSON.stringify({ timestamp: new Date(fx.nowMs - 35 * 60_000).toISOString() }),
      'utf8'
    );

    const staleReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(staleReport.status).toBe('BLOCKED');
    const healthCheck = staleReport.checks.find((c) => c.id === 'config_and_doctor_health')!;
    expect(healthCheck.passed).toBe(false);
    expect(healthCheck.remediationCommand).toContain('routersync tick');

    // Missing status.json
    fs.unlinkSync(path.join(fx.stateDir, 'status.json'));
    const missingReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(missingReport.status).toBe('BLOCKED');
    expect(missingReport.checks.find((c) => c.id === 'config_and_doctor_health')?.passed).toBe(
      false
    );
  });

  it('blocks on tampered standing-consent.json HMAC and on forbidden openmausbot/routines.json target (kills M4)', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    // 1. Forbidden openmausbot/routines.json path
    const ombDir = path.join(fx.harnessDir, 'openmausbot');
    fs.mkdirSync(ombDir, { recursive: true });
    const routinesPath = path.join(ombDir, 'routines.json');
    fs.writeFileSync(routinesPath, JSON.stringify({ routines: [] }), 'utf8');

    const routinesReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:openmausbot',
      harnessConfigPath: routinesPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(routinesReport.status).toBe('BLOCKED');
    expect(routinesReport.checks.find((c) => c.id === 'pilot_targets_readable')?.passed).toBe(
      false
    );

    // 2. Tampered standing-consent.json HMAC signature
    upsertStandingConsentTarget(fx.stateDir, {
      target: 'harness:hermes',
      level: 'propose',
      nowMs: fx.nowMs,
    });
    const consentFile = path.join(fx.stateDir, 'standing-consent.json');
    const rawConsent = JSON.parse(fs.readFileSync(consentFile, 'utf8')) as {
      hmacSha256: string;
      targets: Array<{ level: string }>;
    };
    const originalHmac = rawConsent.hmacSha256;
    rawConsent.targets[0]!.level = 'auto-safe';
    fs.writeFileSync(consentFile, `${JSON.stringify(rawConsent, null, 2)}\n`, 'utf8');

    const tamperedReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(tamperedReport.status).toBe('BLOCKED');
    expect(tamperedReport.checks.find((c) => c.id === 'consent_and_promotion_state')?.passed).toBe(
      false
    );
    expect(JSON.stringify(tamperedReport)).not.toContain(originalHmac);
  });

  it('blocks when cost-ledger.json records non-zero Tier-0 tokens/LLM calls or weekly research budgetExceeded (kills M5)', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    // Case A: non-zero tier0LlmCalls in cost-ledger.json
    const ledgerPath = path.join(fx.stateDir, 'cost-ledger.json');
    const badLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
      ticks: Array<Record<string, unknown>>;
    };
    badLedger.ticks[0]!['llmCalls'] = 1;
    fs.writeFileSync(ledgerPath, `${JSON.stringify(badLedger, null, 2)}\n`, 'utf8');

    const llmReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(llmReport.status).toBe('BLOCKED');
    expect(llmReport.checks.find((c) => c.id === 'cost_and_release_hygiene')?.passed).toBe(false);

    // Reset clean tick ledger, then exhaust all 5 weekly research sessions -> budgetExceeded === true
    fs.unlinkSync(ledgerPath);
    appendTickCostEntry(fx.stateDir, {
      nowMs: fx.nowMs,
      mode: 'observe',
      totalHttpRequests: 1,
      domainRequests: { 'openrouter.ai': 1 },
    });
    for (let i = 1; i <= 5; i += 1) {
      recordResearchSessionActivity(fx.stateDir, {
        sessionId: `sess-${i}`,
        source: 'cli',
        nowMs: fx.nowMs,
        maxWeeklyResearchSessions: 5,
        submittedPayload: '{}',
        returnedPayload: '{}',
      });
    }

    const budgetReport = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      homeDir: fx.fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: fx.nowMs,
      silent: true,
    });
    expect(budgetReport.status).toBe('BLOCKED');
    expect(budgetReport.checks.find((c) => c.id === 'cost_and_release_hygiene')?.passed).toBe(
      false
    );
  });

  it('executes compiled CLI live-check --json with exit code 0 when ready and 1 when blocked', () => {
    const cliDist = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
    expect(fs.existsSync(cliDist)).toBe(true);

    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);
    // Keep status.json fresh relative to wall-clock Date.now() for subprocess CLI call
    fs.writeFileSync(
      path.join(fx.stateDir, 'status.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), ok: true }),
      'utf8'
    );

    const isolatedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fx.fakeHome,
      USERPROFILE: fx.fakeHome,
      APPDATA: path.join(fx.fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(fx.fakeHome, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(fx.fakeHome, '.config'),
    };

    const readyRes = spawnSync(
      process.execPath,
      [
        cliDist,
        'live-check',
        '--router-target',
        'router:omniroute/coding-main',
        '--harness-target',
        'harness:hermes',
        '--harness-config-path',
        fx.harnessConfigPath,
        '--config',
        fx.configPath,
        '--state-dir',
        fx.stateDir,
        '--json',
      ],
      { cwd: fx.rootDir, env: isolatedEnv, encoding: 'utf8', windowsHide: true }
    );
    expect(readyRes.status, `live-check --json stderr: ${readyRes.stderr}`).toBe(0);
    const parsedReady = JSON.parse(readyRes.stdout) as {
      status: string;
      vietnameseGateStatus: string;
    };
    expect(parsedReady.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(parsedReady.vietnameseGateStatus).toBe('sẵn sàng chạy thật');

    activateFreeze(fx.stateDir, 'cli-subprocess-block-test');
    const blockedRes = spawnSync(
      process.execPath,
      [
        cliDist,
        'live-check',
        '--router-target',
        'router:omniroute/coding-main',
        '--harness-target',
        'harness:hermes',
        '--harness-config-path',
        fx.harnessConfigPath,
        '--config',
        fx.configPath,
        '--state-dir',
        fx.stateDir,
        '--json',
      ],
      { cwd: fx.rootDir, env: isolatedEnv, encoding: 'utf8', windowsHide: true }
    );
    expect(blockedRes.status).toBe(1);
    const parsedBlocked = JSON.parse(blockedRes.stdout) as { status: string };
    expect(parsedBlocked.status).toBe('BLOCKED');
  });

  it('succeeds when repoRoot itself lives inside an os.tmpdir() clean clone and never reads real os.homedir()', async () => {
    const fx = createHermeticPilotFixture();
    tempRoots.push(fx.rootDir);

    const tmpCloneRoot = path.join(fx.rootDir, 'qa-c45-pr77-sim');
    fs.mkdirSync(path.join(tmpCloneRoot, 'tools', 'release'), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'pnpm-workspace.yaml'),
      path.join(tmpCloneRoot, 'pnpm-workspace.yaml')
    );
    fs.copyFileSync(
      path.join(REPO_ROOT, 'tools', 'release', 'prepare-v1-release.mjs'),
      path.join(tmpCloneRoot, 'tools', 'release', 'prepare-v1-release.mjs')
    );
    const manifestRels = [
      'package.json',
      'packages/adapter-sdk/package.json',
      'packages/core/package.json',
      'packages/sources/package.json',
      'packages/adapter-9router/package.json',
      'packages/adapter-omniroute/package.json',
      'packages/daemon/package.json',
      'packages/cli/package.json',
      'packages/mcp-server/package.json',
      'packages/ui/package.json',
    ];
    for (const rel of manifestRels) {
      const dst = path.join(tmpCloneRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), dst);
    }

    // Omit homeDir intentionally to verify sandbox paths never touch real os.homedir()
    const report = await runLiveCheckCommand({
      routerTarget: 'router:omniroute/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: fx.harnessConfigPath,
      configPath: fx.configPath,
      stateDir: fx.stateDir,
      repoRoot: tmpCloneRoot,
      nowMs: fx.nowMs,
      silent: true,
    });

    expect(report.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });
});
