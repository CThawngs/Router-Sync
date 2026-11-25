/**
 * packages/cli/test/c46-f3-pilot-workflow-rehearsal.test.ts
 *
 * Ticket C46-F3 (`Phục vụ: S9, I4, I5`) — Red-First TDD Suite:
 *  - Controlled `apps plan`, `apps apply --write`, and `apps rollback` workflow
 *  - Negative security gates: `--yes` (`CONSENT_BYPASS_FORBIDDEN`), active/corrupt `freeze`
 *    (`FREEZE_ACTIVE`), missing/expired/`off` consent (`CONSENT_REQUIRED`), tampered consent
 *    (`CONSENT_HMAC_INVALID`), `auto-safe` without verified propose receipt
 *    (`AUTO_SAFE_RECEIPT_MISSING`), non-TTY / non-`chay` cancellation at `propose`
 *  - Multi-format catalog loading (`HarnessCatalogInput`, `{ providers: { p: ['m'] } }`,
 *    and `<stateDir>/tick-catalog.json` with optional `--catalog`)
 *  - `apps rollback --state-dir` receipt rollback (`rolledBack: true`) + valid HMAC
 *  - `tick --mode` CLI help text advertising `observe | propose | auto-safe`
 *  - Full End-to-End `os.tmpdir()` Live Pilot Rehearsal across SQLite router DB +
 *    Hermes YAML (`#` comments) + OpenCode JSONC (`//` comments)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsentValidationError,
  NINE_ROUTER_EXPECTED_APP_VERSION,
  activateFreeze,
  appendApplyReceipt,
  appendTickCostEntry,
  assertEligibleForAutoSafe,
  findVerifiedProposeReceipt,
  isPathInsideDir,
  openBetterSqlite3,
  readApplyHistory,
  resolveDeepCanonicalPath,
  saveSnapshot,
  upsertStandingConsentTarget,
} from '@routersync/core';
import { createAdapterForRouter } from '../src/adapters.js';
import { loadConfigFile } from '../src/config/loader.js';
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
import { runPlanCommand } from '../src/commands/plan.js';
import { runRollbackCommand } from '../src/commands/rollback.js';
import { runTickCommand } from '../src/commands/tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function expectAutoSafePromotionDenied(stateDir: string, target: string): void {
  try {
    assertEligibleForAutoSafe(stateDir, target);
    expect.unreachable(`Expected assertEligibleForAutoSafe(${target}) to throw`);
  } catch (err) {
    expect(err).toBeInstanceOf(ConsentValidationError);
    expect((err as ConsentValidationError).code).toBe('AUTO_SAFE_PROMOTION_DENIED');
  }
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

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

function readComboRowCanonicalSha(dbPath: string, comboName: string): {
  models: string[];
  canonicalSha256: string;
} {
  const db = openBetterSqlite3(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT id, name, kind, models FROM combos WHERE name = ? OR id = ?')
      .get(comboName, comboName) as
      | { id: string; name: string; kind: string | null; models: string }
      | undefined;
    if (!row) {
      return { models: [], canonicalSha256: sha256Text('null') };
    }
    const models = JSON.parse(row.models) as string[];
    const canonical = JSON.stringify({
      id: row.id,
      name: row.name,
      kind: row.kind,
      models,
    });
    return { models, canonicalSha256: sha256Text(canonical) };
  } finally {
    db.close();
  }
}

describe('C46-F3: apps apply --write Security Gates, Catalog Formats & Receipt Lifecycle', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.exitCode = 0;
    delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];
    delete process.env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHarnessSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f3-unit-'));
    tmpDirs.push(root);
    const stateDir = path.join(root, 'state');
    const harnessDir = path.join(root, 'hermes');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(harnessDir, { recursive: true });

    fs.writeFileSync(path.join(harnessDir, '.env'), 'OPENAI_API_KEY=dummy-unit-key\n', 'utf8');
    const hermesPath = path.join(harnessDir, 'config.yaml');
    const initialYaml = [
      '# Top-level comment preserved byte-for-byte',
      'model:',
      '  provider: openai',
      '  default: openai/gpt-4.1 # inline comment',
      'providers:',
      '  openai:',
      '    base_url: https://api.openai.com/v1',
      '    api_key_env: OPENAI_API_KEY',
      '    models:',
      '      - gpt-4.1',
      '      - gpt-4o-legacy',
      '',
    ].join('\n');
    fs.writeFileSync(hermesPath, initialYaml, 'utf8');

    const catalogPath = path.join(root, 'catalog.json');
    fs.writeFileSync(
      catalogPath,
      JSON.stringify(
        {
          openai: {
            liveModels: ['gpt-4.1', 'gpt-4.1-mini'],
            deprecatedModels: ['gpt-4o-legacy'],
          },
        },
        null,
        2
      ),
      'utf8'
    );

    return { root, stateDir, hermesPath, catalogPath, initialYaml };
  }

  it('advertises auto-safe in tick --mode CLI help and exposes --write/--state-dir/--yes on apps apply', () => {
    const program = createCliProgram();
    const tickCmd = program.commands.find((c) => c.name() === 'tick');
    expect(tickCmd).toBeDefined();
    expect(tickCmd!.helpInformation().replace(/\s+/g, ' ')).toContain(
      'Autonomy mode: observe | propose | auto-safe (default: propose)'
    );

    const appsCmd = program.commands.find((c) => c.name() === 'apps');
    expect(appsCmd).toBeDefined();
    const appsApply = appsCmd!.commands.find((c) => c.name() === 'apply');
    expect(appsApply).toBeDefined();
    const applyHelp = appsApply!.helpInformation();
    expect(applyHelp).toContain('--write');
    expect(applyHelp).toContain('--state-dir');
    expect(applyHelp).toContain('--yes');

    const appsRollback = appsCmd!.commands.find((c) => c.name() === 'rollback');
    expect(appsRollback).toBeDefined();
    expect(appsRollback!.helpInformation()).toContain('--state-dir');
  });

  it('enforces --yes prohibition, freeze gate, consent integrity, propose TTY confirmation, and auto-safe receipt requirement', async () => {
    const { stateDir, hermesPath, catalogPath } = makeHarnessSandbox();
    const preSha = sha256File(hermesPath);

    // 1. Prohibited --yes flag -> CONSENT_BYPASS_FORBIDDEN
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        yes: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/CONSENT_BYPASS_FORBIDDEN/);
    expect(sha256File(hermesPath)).toBe(preSha);

    // 2. Missing standing consent -> CONSENT_REQUIRED
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/CONSENT_REQUIRED/);
    expect(sha256File(hermesPath)).toBe(preSha);

    // 3. Freeze active & corrupt freeze.json -> FREEZE_ACTIVE
    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'propose' });
    activateFreeze(stateDir, 'unit-freeze-drill');
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/FREEZE_ACTIVE/);
    expect(sha256File(hermesPath)).toBe(preSha);

    fs.writeFileSync(path.join(stateDir, 'freeze.json'), '{broken-freeze', 'utf8');
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/FREEZE_ACTIVE/);
    fs.rmSync(path.join(stateDir, 'freeze.json'), { force: true });

    // 4. Propose non-TTY -> blocked; wrong confirmation word -> 0 writes, 0 receipts
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: false,
      })
    ).rejects.toThrow(/TTY/);
    expect(sha256File(hermesPath)).toBe(preSha);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(0);

    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesPath,
      catalog: catalogPath,
      stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'khong',
      json: true,
    });
    expect(sha256File(hermesPath)).toBe(preSha);
    expect(readApplyHistory(stateDir).receipts).toHaveLength(0);

    // 5. Auto-safe without verified propose receipt at runtime -> AUTO_SAFE_RECEIPT_MISSING
    appendApplyReceipt(stateDir, {
      target: 'harness:hermes',
      planHash: 'seed-propose-hash-0001',
      appliedAt: '2026-11-25T08:00:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
      snapshotOrBackupRef: 'seed-backup.bak',
    });
    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'auto-safe' });
    fs.rmSync(path.join(stateDir, 'apply-history.json'), { force: true });
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: false,
      })
    ).rejects.toThrow(/AUTO_SAFE_RECEIPT_MISSING/);
    expect(sha256File(hermesPath)).toBe(preSha);

    // 6. Tampered standing-consent.json HMAC -> CONSENT_HMAC_INVALID
    const consentFile = path.join(stateDir, 'standing-consent.json');
    const tampered = JSON.parse(fs.readFileSync(consentFile, 'utf8')) as {
      targets: Array<{ level: string }>;
    };
    tampered.targets[0]!.level = 'propose';
    fs.writeFileSync(consentFile, JSON.stringify(tampered, null, 2), 'utf8');
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/CONSENT_HMAC_INVALID/);
    expect(sha256File(hermesPath)).toBe(preSha);

    // 7. Valid standing-consent.json at propose + tampered/corrupt apply-history.json -> fail closed (kills Q4)
    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'propose' });
    appendApplyReceipt(stateDir, {
      target: 'harness:hermes',
      planHash: 'seed-propose-hash-q4',
      appliedAt: '2026-11-25T08:05:00.000Z',
      appliedAtLevel: 'propose',
      authorizedVia: 'interactive-tty',
      success: true,
      readBackVerified: true,
      readBackLevel: 'file-byte-verified',
      rolledBack: false,
      snapshotOrBackupRef: 'seed-q4.bak',
    });
    const historyFile = path.join(stateDir, 'apply-history.json');
    const tamperedHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as {
      hmacSha256: string;
    };
    tamperedHistory.hmacSha256 =
      (tamperedHistory.hmacSha256.startsWith('0') ? 'f' : '0') +
      tamperedHistory.hmacSha256.slice(1);
    const tamperedHistoryText = `${JSON.stringify(tamperedHistory, null, 2)}\n`;
    fs.writeFileSync(historyFile, tamperedHistoryText, 'utf8');

    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/CONSENT_HMAC_INVALID/);
    expect(sha256File(hermesPath)).toBe(preSha);
    expect(fs.readFileSync(historyFile, 'utf8')).toBe(tamperedHistoryText);

    fs.writeFileSync(historyFile, '{corrupt-apply-history-json', 'utf8');
    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesPath,
        catalog: catalogPath,
        stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
      })
    ).rejects.toThrow(/CONSENT_SCHEMA_INVALID/);
    expect(sha256File(hermesPath)).toBe(preSha);
  });

  it('supports provider-array & tick-catalog.json formats (without --catalog) and marks receipt rolledBack on apps rollback', async () => {
    const { root, stateDir, hermesPath } = makeHarnessSandbox();
    const preSha = sha256File(hermesPath);

    // Format B: { providers: { openai: ['gpt-4.1', 'gpt-4o'] } }
    const simpleCatalogPath = path.join(root, 'simple-providers.json');
    fs.writeFileSync(
      simpleCatalogPath,
      JSON.stringify({ providers: { openai: ['gpt-4.1', 'gpt-4o'] } }, null, 2),
      'utf8'
    );

    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });

    await runAppsPlanCommand({
      app: 'hermes',
      config: hermesPath,
      catalog: simpleCatalogPath,
      json: true,
    });
    const simplePlan = JSON.parse(out.splice(0).join('')) as {
      additions: Array<{ provider: string; model: string }>;
    };
    expect(simplePlan.additions).toEqual([{ provider: 'openai', model: 'gpt-4o' }]);

    // Format C: <stateDir>/tick-catalog.json resolved automatically when --catalog is omitted
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-11-25T08:00:00.000Z',
          providers: {
            openai: {
              prefix: 'openai',
              router: 'nine',
              hash: 'abc123',
              ids: ['gpt-4.1', 'gpt-4.1-mini'],
              absenceCounts: { 'gpt-4o-legacy': 3 },
              consecutiveFailures: 0,
              backoffUntilMs: 0,
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: '2026-11-25T08:00:00.000Z',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    await runAppsPlanCommand({
      app: 'hermes',
      config: hermesPath,
      stateDir,
      json: true,
    });
    const tickCatPlan = JSON.parse(out.splice(0).join('')) as {
      additions: Array<{ provider: string; model: string }>;
      removals: Array<{ provider: string; model: string }>;
      planHash: string;
    };
    expect(tickCatPlan.additions).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini' }]);
    expect(tickCatPlan.removals).toEqual([
      { provider: 'openai', model: 'gpt-4o-legacy', reason: 'deprecated-upstream' },
    ]);

    upsertStandingConsentTarget(stateDir, { target: 'harness:hermes', level: 'propose' });
    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesPath,
      stateDir,
      planHash: tickCatPlan.planHash,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    out.splice(0);

    // Verified propose receipt recorded -> eligible for auto-safe promotion!
    const receiptBeforeRollback = findVerifiedProposeReceipt(stateDir, 'harness:hermes');
    expect(receiptBeforeRollback).not.toBeNull();
    expect(receiptBeforeRollback!.appliedAtLevel).toBe('propose');
    expect(receiptBeforeRollback!.authorizedVia).toBe('interactive-tty');
    expect(receiptBeforeRollback!.readBackVerified).toBe(true);
    expect(receiptBeforeRollback!.readBackLevel).toBe('file-byte-verified');
    expect(receiptBeforeRollback!.rolledBack).toBe(false);
    expect(() => assertEligibleForAutoSafe(stateDir, 'harness:hermes')).not.toThrow();

    // Rollback marks matching receipt rolledBack=true with valid HMAC
    await runAppsRollbackCommand({
      app: 'hermes',
      config: hermesPath,
      stateDir,
      json: true,
    });
    expect(sha256File(hermesPath)).toBe(preSha);

    const historyAfterRollback = readApplyHistory(stateDir);
    expect(historyAfterRollback.valid).toBe(true);
    expect(historyAfterRollback.receipts).toHaveLength(1);
    expect(historyAfterRollback.receipts[0]!.rolledBack).toBe(true);
    expect(findVerifiedProposeReceipt(stateDir, 'harness:hermes')).toBeNull();
    try {
      assertEligibleForAutoSafe(stateDir, 'harness:hermes');
      expect.unreachable('Expected assertEligibleForAutoSafe to throw after rollback');
    } catch (err) {
      expect(err).toBeInstanceOf(ConsentValidationError);
      expect((err as ConsentValidationError).code).toBe('AUTO_SAFE_PROMOTION_DENIED');
    }
  });

  it('rejects --sandbox-copy outside os.tmpdir() with SANDBOX_OUTSIDE_TMPDIR even when ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1 (Defect A / Q11)', async () => {
    const canonRepo = resolveDeepCanonicalPath(REPO_ROOT);
    const canonTmp = resolveDeepCanonicalPath(os.tmpdir());
    if (isPathInsideDir(canonRepo, canonTmp)) {
      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f3-subtmp-'));
      tmpDirs.push(isolatedTmp);
      vi.stubEnv('TMPDIR', isolatedTmp);
      vi.stubEnv('TEMP', isolatedTmp);
      vi.stubEnv('TMP', isolatedTmp);
    }

    const outsideRoot = path.join(REPO_ROOT, `tmp-qa-non-tmpdir-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(outsideRoot, { recursive: true });
      expect(
        isPathInsideDir(
          resolveDeepCanonicalPath(outsideRoot),
          resolveDeepCanonicalPath(os.tmpdir())
        )
      ).toBe(false);

      const outsideStateDir = path.join(outsideRoot, 'state');
      const outsideHarnessDir = path.join(outsideRoot, 'hermes');
      fs.mkdirSync(outsideStateDir, { recursive: true });
      fs.mkdirSync(outsideHarnessDir, { recursive: true });
      fs.writeFileSync(
        path.join(outsideHarnessDir, '.env'),
        'OPENAI_API_KEY=dummy-outside-key\n',
        'utf8'
      );

      const outsideConfigPath = path.join(outsideHarnessDir, 'config.yaml');
      fs.writeFileSync(
        outsideConfigPath,
        [
          '# Outside tmpdir live harness config',
          'model:',
          '  provider: openai',
          '  default: openai/gpt-4.1',
          'providers:',
          '  openai:',
          '    base_url: https://api.openai.com/v1',
          '    api_key_env: OPENAI_API_KEY',
          '    models:',
          '      - gpt-4.1',
          '      - gpt-4o-legacy',
          '',
        ].join('\n'),
        'utf8'
      );
      const preOutsideSha = sha256File(outsideConfigPath);

      const { hermesPath: tmpHermesPath, catalogPath } = makeHarnessSandbox();
      const preTmpSha = sha256File(tmpHermesPath);

      activateFreeze(outsideStateDir, 'emergency-freeze');
      process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'] = '1';

      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: outsideConfigPath,
          catalog: catalogPath,
          stateDir: outsideStateDir,
          sandboxCopy: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow(/SANDBOX_OUTSIDE_TMPDIR/);

      expect(sha256File(outsideConfigPath)).toBe(preOutsideSha);
      expect(fs.existsSync(`${outsideConfigPath}.routersync.bak`)).toBe(false);
      expect(fs.existsSync(path.join(outsideStateDir, 'apply-history.json'))).toBe(false);

      // Also reject when --config is outside os.tmpdir() even if --backup is inside os.tmpdir() (kills Q11a)
      const insideTmpBackupPath = path.join(path.dirname(tmpHermesPath), 'inside-tmp-explicit.bak');
      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: outsideConfigPath,
          backup: insideTmpBackupPath,
          catalog: catalogPath,
          stateDir: outsideStateDir,
          sandboxCopy: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow(/SANDBOX_OUTSIDE_TMPDIR/);
      expect(sha256File(outsideConfigPath)).toBe(preOutsideSha);
      expect(fs.existsSync(insideTmpBackupPath)).toBe(false);

      // Also reject when config is inside os.tmpdir() but --backup escapes outside os.tmpdir()
      const escapedBackupPath = path.join(outsideRoot, 'escaped.bak');
      await expect(
        runAppsApplyCommand({
          app: 'hermes',
          config: tmpHermesPath,
          backup: escapedBackupPath,
          catalog: catalogPath,
          stateDir: outsideStateDir,
          sandboxCopy: true,
          isTTY: false,
          json: true,
        })
      ).rejects.toThrow(/SANDBOX_OUTSIDE_TMPDIR/);

      expect(sha256File(tmpHermesPath)).toBe(preTmpSha);
      expect(fs.existsSync(escapedBackupPath)).toBe(false);
    } finally {
      delete process.env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'];
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
    expect(fs.existsSync(outsideRoot)).toBe(false);
  });

  it('invalidates subsequent propose receipts on full & pre-pilot router rollback while preserving earlier receipts on partial rollback (Defect B / Q9 / Q12)', async () => {
    const SECOND_PROPOSE_PIN_MODELS = [
      'openai/gpt-4.1-mini',
      'openai/gpt-4.1',
      ...PROPOSE_PIN_MODELS.slice(2),
    ];

    function seedIsolatedRouterScenario(label: string) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `rs-c46-f3-rb-${label}-`));
      tmpDirs.push(root);
      const stateDir = path.join(root, 'state');
      const routerDir = path.join(root, 'router');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(routerDir, { recursive: true });

      const routerDbPath = path.join(routerDir, 'nine-rb.sqlite');
      const iso = '2026-11-25T08:00:00.000Z';
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
        'OpenAI RB',
        null,
        1,
        1,
        JSON.stringify({
          apiKey: 'dummy-rb-openai-key',
          baseUrl: 'https://api.openai.com/v1',
          prefix: 'openai',
        }),
        iso,
        iso
      );
      db.prepare(
        'INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('coding-main', 'coding-main', null, JSON.stringify(INITIAL_TEN_MODELS), iso, iso);
      db.close();

      const configPath = path.join(routerDir, 'routersync.yaml');
      const writePins = (pins: string[]) => {
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
            'combos:',
            '  - name: coding-main',
            '    routers:',
            '      - nine',
            '    size: 10',
            '    constraints:',
            '      freeOnly: false',
            '    pin:',
            ...pins.map((m) => `      - ${m}`),
            '    autoMaintain: true',
            'adopt:',
            '  - router: nine',
            '    name: coding-main',
            '    mode: full',
            '',
          ].join('\n'),
          'utf8'
        );
      };

      writePins(PROPOSE_PIN_MODELS);
      upsertStandingConsentTarget(stateDir, {
        target: 'router:nine/coding-main',
        level: 'propose',
      });

      return { stateDir, routerDbPath, configPath, writePins };
    }

    // 1. Two-apply full rollback (snap_1 -> snap_2 -> rollback snap_1): BOTH receipts marked rolledBack=true
    {
      const s1 = seedIsolatedRouterScenario('full');
      const apply1 = await runApplyCommand({
        configPath: s1.configPath,
        stateDir: s1.stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
      const snap1 = apply1.snapshots?.[0]?.snapshotId;
      expect(snap1).toBeTruthy();

      s1.writePins(SECOND_PROPOSE_PIN_MODELS);
      const apply2 = await runApplyCommand({
        configPath: s1.configPath,
        stateDir: s1.stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
      const snap2 = apply2.snapshots?.[0]?.snapshotId;
      expect(snap2).toBeTruthy();
      expect(snap2).not.toBe(snap1);

      expect(readApplyHistory(s1.stateDir).receipts.map((r) => r.rolledBack)).toEqual([
        false,
        false,
      ]);

      await runRollbackCommand({
        configPath: s1.configPath,
        stateDir: s1.stateDir,
        snapshotId: snap1,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });

      const histAfterFull = readApplyHistory(s1.stateDir);
      expect(histAfterFull.valid).toBe(true);
      expect(histAfterFull.receipts).toHaveLength(2);
      expect(histAfterFull.receipts[0]!.snapshotOrBackupRef).toBe(snap1);
      expect(histAfterFull.receipts[1]!.snapshotOrBackupRef).toBe(snap2);
      expect(histAfterFull.receipts.map((r) => r.rolledBack)).toEqual([true, true]);
      expect(findVerifiedProposeReceipt(s1.stateDir, 'router:nine/coding-main')).toBeNull();
      expectAutoSafePromotionDenied(s1.stateDir, 'router:nine/coding-main');
    }

    // 2. Two-apply partial rollback (snap_1 -> snap_2 -> rollback snap_2): snap_2 rolledBack=true, snap_1 stays rolledBack=false
    {
      const s2 = seedIsolatedRouterScenario('partial');
      const apply1 = await runApplyCommand({
        configPath: s2.configPath,
        stateDir: s2.stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
      const snap1 = apply1.snapshots?.[0]?.snapshotId!;

      s2.writePins(SECOND_PROPOSE_PIN_MODELS);
      const apply2 = await runApplyCommand({
        configPath: s2.configPath,
        stateDir: s2.stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
      const snap2 = apply2.snapshots?.[0]?.snapshotId!;

      await runRollbackCommand({
        configPath: s2.configPath,
        stateDir: s2.stateDir,
        snapshotId: snap2,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });

      const histAfterPartial = readApplyHistory(s2.stateDir);
      expect(histAfterPartial.valid).toBe(true);
      expect(histAfterPartial.receipts).toHaveLength(2);
      expect(histAfterPartial.receipts[0]!.rolledBack).toBe(false);
      expect(histAfterPartial.receipts[1]!.rolledBack).toBe(true);
      expect(
        findVerifiedProposeReceipt(s2.stateDir, 'router:nine/coding-main')?.snapshotOrBackupRef
      ).toBe(snap1);
      expect(() =>
        assertEligibleForAutoSafe(s2.stateDir, 'router:nine/coding-main')
      ).not.toThrow();
    }

    // 3. Manual pre-pilot snapshot rollback (snap_0 -> apply snap_1 -> rollback snap_0): snap_1 marked rolledBack=true
    {
      const s3 = seedIsolatedRouterScenario('manual-pre');
      const { config } = loadConfigFile(s3.configPath);
      const adapter = createAdapterForRouter(config.routers[0]!, s3.stateDir);
      const snap0 = await adapter.createSnapshot();
      snap0.metadata = { ...(snap0.metadata ?? {}), touchedComboIds: ['coding-main'] };
      saveSnapshot(snap0, s3.stateDir);

      const apply1 = await runApplyCommand({
        configPath: s3.configPath,
        stateDir: s3.stateDir,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });
      const snap1 = apply1.snapshots?.[0]?.snapshotId!;
      expect(snap1).not.toBe(snap0.id);
      expect(findVerifiedProposeReceipt(s3.stateDir, 'router:nine/coding-main')).not.toBeNull();

      await runRollbackCommand({
        configPath: s3.configPath,
        stateDir: s3.stateDir,
        snapshotId: snap0.id,
        write: true,
        isTTY: true,
        promptFn: async () => 'chay',
        json: true,
      });

      const histAfterManual = readApplyHistory(s3.stateDir);
      expect(histAfterManual.valid).toBe(true);
      expect(histAfterManual.receipts).toHaveLength(1);
      expect(histAfterManual.receipts[0]!.snapshotOrBackupRef).toBe(snap1);
      expect(histAfterManual.receipts[0]!.rolledBack).toBe(true);
      expect(findVerifiedProposeReceipt(s3.stateDir, 'router:nine/coding-main')).toBeNull();
      expectAutoSafePromotionDenied(s3.stateDir, 'router:nine/coding-main');
    }
  });
});

describe('C46-F3: Full End-to-End os.tmpdir() Live Pilot Rehearsal (Router SQLite + Hermes YAML + OpenCode JSONC)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.exitCode = 0;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes the complete LIVE-E2E-v2.md workflow end-to-end with byte-exact rollback, preserved comments, 0 Tier-0 tokens & latency <= 60000ms', async () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c46-f3-e2e-'));
    tmpDirs.push(sandboxRoot);

    const stateDir = path.join(sandboxRoot, 'state');
    const fakeHome = path.join(sandboxRoot, 'home');
    const routerDir = path.join(sandboxRoot, 'router');
    const hermesDir = path.join(fakeHome, '.hermes');
    const openCodeDir = path.join(fakeHome, '.config', 'opencode');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(routerDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.mkdirSync(openCodeDir, { recursive: true });

    // Isolate home/state env vars inside os.tmpdir() for hermetic tick discovery
    vi.stubEnv('ROUTERSYNC_STATE_DIR', stateDir);
    vi.stubEnv('ROUTERSYNC_HOME', fakeHome);
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('USERPROFILE', fakeHome);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(fakeHome, '.config'));
    vi.stubEnv('HERMES_HOME', hermesDir);

    const nowMs = Date.parse('2026-11-25T09:00:00.000Z');
    const initialIso = new Date(nowMs - 5 * 60_000).toISOString();

    // 1. Seed SQLite router DB
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
    ).run('coding-main', 'coding-main', null, JSON.stringify(INITIAL_TEN_MODELS), initialIso, initialIso);
    db.close();

    // 2. Seed Hermes YAML (`#` comments) + OpenCode JSONC (`//` comments)
    fs.writeFileSync(path.join(hermesDir, '.env'), 'OPENAI_API_KEY=dummy-hermes-env-key\n', 'utf8');
    const hermesConfigPath = path.join(hermesDir, 'config.yaml');
    const hermesInitialText = [
      '# Hermes Pilot YAML — comment header must survive apply & rollback',
      'model:',
      '  provider: openai',
      '  default: openai/gpt-4.1 # default slot must never change',
      'providers:',
      '  openai:',
      '    base_url: https://api.openai.com/v1',
      '    api_key_env: OPENAI_API_KEY',
      '    models:',
      '      - gpt-4.1',
      '      - gpt-4.1-mini',
      '',
    ].join('\n');
    fs.writeFileSync(hermesConfigPath, hermesInitialText, 'utf8');

    const openCodeConfigPath = path.join(openCodeDir, 'opencode.jsonc');
    const openCodeInitialText = [
      '{',
      '  // OpenCode Pilot JSONC — single-line comment must survive apply & rollback',
      '  "model": "openai/gpt-4.1",',
      '  "provider": {',
      '    "openai": {',
      '      "options": {',
      '        "baseURL": "https://api.openai.com/v1",',
      '        "apiKey": "dummy-opencode-inline-key"',
      '      },',
      '      "models": {',
      '        "gpt-4.1": { "name": "GPT-4.1" },',
      '        "gpt-4.1-mini": { "name": "GPT-4.1 Mini" }',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(openCodeConfigPath, openCodeInitialText, 'utf8');

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
        '  - name: coding-main',
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
        '    name: coding-main',
        '    mode: full',
        '',
      ].join('\n'),
      'utf8'
    );

    // Seed initial observe tick status & tick-catalog.json for Section 2 pre-flight
    fs.writeFileSync(
      path.join(stateDir, 'status.json'),
      `${JSON.stringify({ timestamp: initialIso, mode: 'observe', ok: true }, null, 2)}\n`,
      'utf8'
    );
    appendTickCostEntry(stateDir, {
      nowMs: nowMs - 5 * 60_000,
      mode: 'observe',
      totalHttpRequests: 1,
      domainRequests: { 'api.openai.com': 1 },
    });
    const baseOpenAiIds = INITIAL_TEN_MODELS.map((m) => m.split('/')[1]!);
    fs.writeFileSync(
      path.join(stateDir, 'tick-catalog.json'),
      JSON.stringify(
        {
          version: 1,
          updatedAt: initialIso,
          providers: {
            openai: {
              prefix: 'openai',
              router: 'nine',
              contentHash: 'initial-hash-v1',
              hash: 'initial-hash-v1',
              ids: baseOpenAiIds,
              absenceCounts: {},
              consecutiveFailures: 0,
              backoffUntilMs: 0,
              lastStatus: 200,
              lastLabel: 'OK',
              updatedAt: initialIso,
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    // Record pre-pilot digests & explicit pre-pilot backups
    const preRouterFileBackup = `${routerDbPath}.pre-pilot.bak`;
    fs.copyFileSync(routerDbPath, preRouterFileBackup);
    const preRouterFileSha = sha256File(routerDbPath);
    const preRouterRowSha = readComboRowCanonicalSha(routerDbPath, 'coding-main').canonicalSha256;
    const preHermesSha = sha256File(hermesConfigPath);
    const preOpenCodeSha = sha256File(openCodeConfigPath);
    const hermesPrePilotBak = `${hermesConfigPath}.pre-pilot.bak`;
    const openCodePrePilotBak = `${openCodeConfigPath}.pre-pilot.bak`;

    // -----------------------------------------------------------------------
    // Section 2: Read-Only Pre-Flight `live-check`
    // -----------------------------------------------------------------------
    const preflight = await runLiveCheckCommand({
      routerTarget: 'router:nine/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: hermesConfigPath,
      configPath,
      stateDir,
      homeDir: fakeHome,
      repoRoot: REPO_ROOT,
      nowMs,
      silent: true,
    });
    expect(preflight.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(preflight.checks.map((c) => c.id)).toContain('live_gate_hint');
    expect(preflight.checks.find((c) => c.id === 'live_gate_hint')!.detail).toContain(
      'trong os.tmpdir() — không cần cờ'
    );

    // -----------------------------------------------------------------------
    // Step 3.1: Grant `propose` consent & Dry-Run Plans (`plan` + `apps plan`)
    // -----------------------------------------------------------------------
    for (const target of ['router:nine/coding-main', 'harness:hermes', 'harness:opencode']) {
      await runConsentGrantCommand({
        target,
        level: 'propose',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      });
    }

    await runPlanCommand({ configPath, json: true });
    await runAppsPlanCommand({
      app: 'hermes',
      config: hermesConfigPath,
      stateDir,
      home: fakeHome,
      json: true,
    });
    await runAppsPlanCommand({
      app: 'opencode',
      config: openCodeConfigPath,
      stateDir,
      home: fakeHome,
      json: true,
    });

    // Zero writes during plan phase
    expect(sha256File(routerDbPath)).toBe(preRouterFileSha);
    expect(sha256File(hermesConfigPath)).toBe(preHermesSha);
    expect(sha256File(openCodeConfigPath)).toBe(preOpenCodeSha);

    // -----------------------------------------------------------------------
    // Step 3.2: Controlled `propose` Apply (`apply --write` + `apps apply --write`)
    // -----------------------------------------------------------------------
    const routerApplyRes = await runApplyCommand({
      configPath,
      stateDir,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    expect(routerApplyRes.status).toBe('SUCCESS');
    const routerSnapId = routerApplyRes.snapshots?.[0]?.snapshotId;
    expect(routerSnapId).toBeTruthy();

    await runAppsApplyCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesPrePilotBak,
      stateDir,
      home: fakeHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    await runAppsApplyCommand({
      app: 'opencode',
      config: openCodeConfigPath,
      backup: openCodePrePilotBak,
      stateDir,
      home: fakeHome,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });

    // Comments preserved & propose receipts recorded
    expect(fs.readFileSync(hermesConfigPath, 'utf8')).toContain(
      '# Hermes Pilot YAML — comment header must survive apply & rollback'
    );
    expect(fs.readFileSync(openCodeConfigPath, 'utf8')).toContain(
      '// OpenCode Pilot JSONC — single-line comment must survive apply & rollback'
    );
    expect(findVerifiedProposeReceipt(stateDir, 'router:nine/coding-main')).not.toBeNull();
    expect(findVerifiedProposeReceipt(stateDir, 'harness:hermes')).not.toBeNull();
    expect(findVerifiedProposeReceipt(stateDir, 'harness:opencode')).not.toBeNull();

    // -----------------------------------------------------------------------
    // Step 3.3: Promote to `auto-safe` & Run Deterministic `tick --mode auto-safe`
    // -----------------------------------------------------------------------
    for (const target of ['router:nine/coding-main', 'harness:hermes', 'harness:opencode']) {
      await runConsentGrantCommand({
        target,
        level: 'auto-safe',
        stateDir,
        isTTY: true,
        promptFn: async () => 'consent',
        json: true,
      });
    }

    const tickNowMs = nowMs + 20 * 60_000;
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            data: [...baseOpenAiIds, 'gpt-5.2-codex'].map((id) => ({ id })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const tickStartWall = Date.now();
    const tickSummary = await runTickCommand({
      configPath,
      stateDir,
      mode: 'auto-safe',
      nowMs: tickNowMs,
      minScanIntervalMs: 0,
      fetchFn: mockFetch,
      json: true,
    });
    const tickWallElapsedMs = Date.now() - tickStartWall;

    expect(tickSummary.effectiveMode).toBe('auto-safe');
    expect(tickSummary.tokens).toBe(0);
    expect(tickSummary.llmCalls).toBe(0);
    expect(tickSummary.paidRequests).toBe(0);
    expect(tickWallElapsedMs).toBeLessThanOrEqual(60_000);

    // New model `gpt-5.2-codex` applied automatically to router + both harnesses with comments intact!
    expect(readComboRowCanonicalSha(routerDbPath, 'coding-main').models).toContain(
      'openai/gpt-5.2-codex'
    );
    const hermesAfterTick = fs.readFileSync(hermesConfigPath, 'utf8');
    expect(hermesAfterTick).toContain('gpt-5.2-codex');
    expect(hermesAfterTick).toContain(
      '# Hermes Pilot YAML — comment header must survive apply & rollback'
    );
    expect(hermesAfterTick).toContain('# default slot must never change');

    const openCodeAfterTick = fs.readFileSync(openCodeConfigPath, 'utf8');
    expect(openCodeAfterTick).toContain('gpt-5.2-codex');
    expect(openCodeAfterTick).toContain(
      '// OpenCode Pilot JSONC — single-line comment must survive apply & rollback'
    );

    const tickPlanJson = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'plans', 'tick-plan.json'), 'utf8')
    ) as {
      detectionLatency: { maxMs: number | null };
      accounting: { tokens: number; llmCalls: number; paidRequests: number };
    };
    expect(tickPlanJson.accounting.tokens).toBe(0);
    expect(tickPlanJson.accounting.llmCalls).toBe(0);
    expect(tickPlanJson.accounting.paidRequests).toBe(0);
    expect(tickPlanJson.detectionLatency.maxMs ?? 0).toBeLessThanOrEqual(60_000);

    const activeCheck = await runLiveCheckCommand({
      routerTarget: 'router:nine/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: hermesConfigPath,
      configPath,
      stateDir,
      homeDir: fakeHome,
      repoRoot: REPO_ROOT,
      requireConsent: true,
      nowMs: tickNowMs,
      silent: true,
    });
    expect(activeCheck.status).toBe('READY_FOR_OWNER_LIVE_PILOT');
    expect(activeCheck.pilotPhase).toBe('AUTO_SAFE_ACTIVE');

    // -----------------------------------------------------------------------
    // Step 3.4: Emergency `freeze` / `unfreeze` Circuit Breaker Drill
    // -----------------------------------------------------------------------
    await runFreezeCommand({ reason: 'live-pilot-drill', stateDir, json: true });

    const frozenCheck = await runLiveCheckCommand({
      routerTarget: 'router:nine/coding-main',
      harnessTarget: 'harness:hermes',
      harnessConfigPath: hermesConfigPath,
      configPath,
      stateDir,
      homeDir: fakeHome,
      repoRoot: REPO_ROOT,
      nowMs: tickNowMs,
      silent: true,
    });
    expect(frozenCheck.status).toBe('BLOCKED');

    await expect(
      runAppsApplyCommand({
        app: 'hermes',
        config: hermesConfigPath,
        stateDir,
        home: fakeHome,
        write: true,
        isTTY: false,
      })
    ).rejects.toThrow(/FREEZE_ACTIVE/);

    await runUnfreezeCommand({
      stateDir,
      isTTY: true,
      promptFn: async () => 'unfreeze',
      json: true,
    });

    // -----------------------------------------------------------------------
    // Step 3.5: Byte-Exact Rollback Rehearsal (`rollback` + `apps rollback`)
    // -----------------------------------------------------------------------
    await runRollbackCommand({
      configPath,
      stateDir,
      snapshotId: routerSnapId,
      write: true,
      isTTY: true,
      promptFn: async () => 'chay',
      json: true,
    });
    const postRollbackRow = readComboRowCanonicalSha(routerDbPath, 'coding-main');
    expect(postRollbackRow.models).toEqual(INITIAL_TEN_MODELS);
    expect(postRollbackRow.canonicalSha256).toBe(preRouterRowSha);
    expect(findVerifiedProposeReceipt(stateDir, 'router:nine/coding-main')).toBeNull();
    expectAutoSafePromotionDenied(stateDir, 'router:nine/coding-main');
    expect(
      readApplyHistory(stateDir)
        .receipts.filter((r) => r.target === 'router:nine/coding-main')
        .every((r) => r.rolledBack === true)
    ).toBe(true);

    // Also verify raw pre-pilot SQLite file backup restores 100% byte-identical SHA-256
    fs.copyFileSync(preRouterFileBackup, routerDbPath);
    expect(sha256File(routerDbPath)).toBe(preRouterFileSha);

    await runAppsRollbackCommand({
      app: 'hermes',
      config: hermesConfigPath,
      backup: hermesPrePilotBak,
      expectedPreSha256: preHermesSha,
      stateDir,
      json: true,
    });
    await runAppsRollbackCommand({
      app: 'opencode',
      config: openCodeConfigPath,
      backup: openCodePrePilotBak,
      expectedPreSha256: preOpenCodeSha,
      stateDir,
      json: true,
    });

    expect(sha256File(hermesConfigPath)).toBe(preHermesSha);
    expect(sha256File(openCodeConfigPath)).toBe(preOpenCodeSha);
    expect(fs.readFileSync(hermesConfigPath, 'utf8')).toBe(hermesInitialText);
    expect(fs.readFileSync(openCodeConfigPath, 'utf8')).toBe(openCodeInitialText);

    const ledger = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'cost-ledger.json'), 'utf8')
    ) as {
      tier0Tokens?: number;
      ticks?: Array<{ tokens?: number; llmCalls?: number; paidRequests?: number }>;
    };
    const totalLedgerTokens =
      (ledger.tier0Tokens ?? 0) +
      (ledger.ticks ?? []).reduce((sum, t) => sum + (t.tokens ?? 0), 0);
    expect(totalLedgerTokens).toBe(0);
  }, 60_000);
});
