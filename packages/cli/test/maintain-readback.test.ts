/**
 * packages/cli/test/maintain-readback.test.ts
 *
 * M2-03 Phase 1 — Red-Before tests for the honest CLI READBACK banner.
 * All HTTP traffic is confined to FakeRouter on 127.0.0.1:0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import {
  runMaintainCreateCommand,
  runMaintainApplyCommand,
  runMaintainPlanCommand,
  type MaintainApplyOptions,
  type MaintainCreateOptions,
} from '../src/commands/maintain.js';
import {
  createGrantFile,
  generateGrantSecret,
  getGrantFilePath,
  type ApplyGrant,
} from '../src/maintain/grant.js';
import { FakeRouter } from '../../../test/harness/fake-router.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown; all(): unknown };
    close(): void;
  };
};

class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`EXIT_${code}`);
    this.code = code;
  }
}

type FixtureKind = 'nine' | 'omni';

interface FixtureOptions {
  baseUrl: string;
  servingWaitMs: number;
  apiKeyEnv?: string;
}

interface Fixture {
  stateDir: string;
  dbPath: string;
  configPath: string;
  secret: string;
}

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(key: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

function makeFixture(kind: FixtureKind, options: FixtureOptions): Fixture {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-m203-cli-${kind}-`));
  tempDirs.push(stateDir);
  const dbPath = path.join(stateDir, 'data.sqlite');
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);

  if (kind === 'nine') {
    db.exec(
      'CREATE TABLE combos (id TEXT, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);' +
        'CREATE TABLE settings (id INTEGER, data TEXT);'
    );
    db.prepare('INSERT INTO combos VALUES (?, ?, ?, ?, ?, ?)').run(
      'test-1',
      'test-1',
      null,
      JSON.stringify(['p1/m1', 'p1/m2', 'p1/m3', 'p1/m4']),
      now,
      now
    );
    db.prepare('INSERT INTO settings VALUES (?, ?)').run(1, '{}');
  } else {
    db.exec(
      'CREATE TABLE combos (id TEXT, name TEXT, data TEXT, created_at TEXT, updated_at TEXT, sort_order INTEGER, system_message TEXT);'
    );
    db.prepare('INSERT INTO combos VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'test-1',
      'test-1',
      JSON.stringify({ strategy: 'priority', models: ['p1/m1', 'p1/m2', 'p1/m3', 'p1/m4'], managed: true }),
      now,
      now,
      0,
      null
    );
  }
  db.close();

  const routerId = kind === 'nine' ? 'nine' : 'omni';
  const adapter = kind === 'nine' ? '9router' : 'omniroute';
  const configPath = path.join(stateDir, 'routersync.yaml');
  const lines = [
    'version: 1',
    'routers:',
    `  - id: ${routerId}`,
    `    adapter: ${adapter}`,
    '    write: db',
    '    db:',
    `      path: ${dbPath}`,
    `    baseUrl: ${options.baseUrl}`,
    `    servingWaitMs: ${options.servingWaitMs}`,
  ];
  if (options.apiKeyEnv) {
    lines.push('    auth:', `      apiKeyEnv: ${options.apiKeyEnv}`);
  }
  lines.push(
    '    reload:',
    '      type: none',
    'policy:',
    '  mode: manual',
    'combos:',
    '  - name: test-1',
    `    routers:`,
    `      - ${routerId}`,
    '    size: 3',
    'adopt: []',
    ''
  );
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');

  const secret = generateGrantSecret();
  const grant: ApplyGrant = {
    version: 1,
    id: 'abcdef0123456789',
    combos: ['test-1', 'test-9'],
    agents: ['hermes'],
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  fs.writeFileSync(
    getGrantFilePath(stateDir),
    JSON.stringify(createGrantFile(grant, secret), null, 2),
    'utf8'
  );

  fs.writeFileSync(
    path.join(stateDir, 'tracker-state.json'),
    JSON.stringify({ providers: { p1: { status: 'ok', lastScanAt: now } } }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(stateDir, 'track-events.jsonl'),
    JSON.stringify({ provider: 'p1', type: 'model_removed', models: ['m4'], timestamp: now }) + '\n',
    'utf8'
  );

  return { stateDir, dbPath, configPath, secret };
}

function readNineRows(dbPath: string): Array<{ id: string; models: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT id, models FROM combos ORDER BY id').all() as Array<{
      id: string;
      models: string;
    }>;
  } finally {
    db.close();
  }
}

async function captureRun(fn: () => Promise<void>): Promise<{
  exitCode: number;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new ExitSignal(typeof code === 'number' ? code : Number(code ?? 0));
  }) as never);

  let exitCode = 0;
  try {
    await fn();
  } catch (err) {
    if (err instanceof ExitSignal) exitCode = err.code;
    else {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
      throw err;
    }
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { exitCode, stdout, stderr };
}

async function applyOptions(fixture: Fixture, router: string, dryRun = false): Promise<MaintainApplyOptions> {
  rememberEnv('ROUTERSYNC_STATE_DIR');
  process.env['ROUTERSYNC_STATE_DIR'] = fixture.stateDir;
  const plan = await captureRun(() =>
    runMaintainPlanCommand({ configPath: fixture.configPath, router, stateDir: fixture.stateDir, json: true })
  );
  const parsed = JSON.parse(plan.stdout.join('\n')) as { planHash?: string };
  return {
    only: 'test-1',
    agents: 'hermes',
    planHash: parsed.planHash ?? '0000000000000000',
    configPath: fixture.configPath,
    router,
    stateDir: fixture.stateDir,
    dryRun,
    isTTY: false,
    secretResolver: () => fixture.secret,
  } as MaintainApplyOptions;
}

function outputOf(result: { stdout: string[]; stderr: string[] }): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

describe('M2-03: honest CLI READBACK banner', () => {
  beforeEach(() => {
    savedEnv.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('M2-03-T1 CLI: 9Router delayed reflection ends in READBACK ok=yes', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-delayed', reflectAfterPolls: 2 });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 250 });
      const oldCombo = {
        id: 'test-1', name: 'test-1', strategy: 'round-robin', managed: true,
        models: ['p1/m1', 'p1/m2', 'p1/m3', 'p1/m4'],
      };
      const reflected = { ...oldCombo, models: ['p1/m1', 'p1/m2', 'p1/m3'] };
      fake.setPreApplySnapshot([] as never);
      fake.setReflectedCombos([reflected] as never);
      fake.resetCounters();

      const options = await applyOptions(fixture, 'nine');
      const result = await captureRun(() => runMaintainApplyCommand(options));
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).toContain('READBACK ok=yes');
      expect(output).not.toContain('READBACK db-only');
      expect(output).not.toContain('READBACK stale=yes');
      expect(fake.modelsRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T2 CLI: OmniRoute apiKeyEnv + delayed reflection ends in READBACK ok=yes', async () => {
    rememberEnv('RS_M2_03_OMNI_KEY');
    process.env['RS_M2_03_OMNI_KEY'] = 'rs-m2-03-omni-test-key';
    const fake = new FakeRouter({ name: 'cli-omni-delayed', reflectAfterPolls: 2 });
    await fake.startServer();
    try {
      const fixture = makeFixture('omni', {
        baseUrl: fake.baseUrl,
        servingWaitMs: 250,
        apiKeyEnv: 'RS_M2_03_OMNI_KEY',
      });
      const oldCombo = {
        id: 'test-1', name: 'test-1', strategy: 'priority', managed: true,
        models: ['p1/m1', 'p1/m2', 'p1/m3', 'p1/m4'],
      };
      const reflected = { ...oldCombo, models: ['p1/m1', 'p1/m2', 'p1/m3'] };
      fake.setPreApplySnapshot([oldCombo] as never);
      fake.setReflectedCombos([reflected] as never);
      fake.resetCounters();

      const options = await applyOptions(fixture, 'omni');
      const result = await captureRun(() => runMaintainApplyCommand(options));
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).toContain('READBACK ok=yes');
      expect(output).not.toContain('READBACK db-only');
      expect(fake.combosRequests).toBeGreaterThanOrEqual(2);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T4 CLI: stale serving path exits 1 with rollback banner and restored SQLite', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-stale', staleServingPath: true });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 200 });
      const oldCombo = {
        id: 'test-1', name: 'test-1', strategy: 'round-robin', managed: true,
        models: ['p1/m1', 'p1/m2', 'p1/m3', 'p1/m4'],
      };
      fake.setPreApplySnapshot([] as never);
      fake.setReflectedCombos([{ ...oldCombo, models: ['p1/m1', 'p1/m2', 'p1/m3'] }] as never);
      const before = readNineRows(fixture.dbPath);
      const options = await applyOptions(fixture, 'nine');

      const result = await captureRun(() =>
        runMaintainApplyCommand(options)
      );
      const output = outputOf(result);
      expect(result.exitCode).toBe(1);
      expect(output).toContain('READBACK stale=yes rollback=yes');
      expect(output).not.toContain('READBACK ok=yes');
      expect(readNineRows(fixture.dbPath)).toEqual(before);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T5 CLI: isolated 9Router prints READBACK db-only, never ok=yes', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-isolated' });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 200 });
      const configPath = fixture.configPath;
      fs.writeFileSync(
        configPath,
        fs.readFileSync(configPath, 'utf8').replace('    write: db\n', '    write: db\n    isolated: true\n'),
        'utf8'
      );
      const options = await applyOptions(fixture, 'nine');
      const result = await captureRun(() =>
        runMaintainApplyCommand(options)
      );
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).toContain('READBACK db-only');
      expect(output).not.toContain('READBACK ok=yes');
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T5 CLI: OmniRoute HTTP 503 with credentials prints READBACK db-only', async () => {
    rememberEnv('RS_M2_03_OMNI_KEY');
    process.env['RS_M2_03_OMNI_KEY'] = 'rs-m2-03-omni-test-key';
    const fake = new FakeRouter({ name: 'cli-omni-503', servingStatusOverride: 503 });
    await fake.startServer();
    try {
      const fixture = makeFixture('omni', {
        baseUrl: fake.baseUrl,
        servingWaitMs: 200,
        apiKeyEnv: 'RS_M2_03_OMNI_KEY',
      });
      const options = await applyOptions(fixture, 'omni');
      const result = await captureRun(() => runMaintainApplyCommand(options));
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).toContain('READBACK db-only');
      expect(output).not.toContain('READBACK ok=yes');
      expect(output).not.toContain('no-serving-path-credentials');
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T5 CLI: --dry-run never prints READBACK ok=yes', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-dryrun' });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 200 });
      const options = await applyOptions(fixture, 'nine', true);
      const result = await captureRun(() =>
        runMaintainApplyCommand(options)
      );
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).not.toContain('READBACK ok=yes');
      expect(/READBACK (?:dry-run|db-only)/.test(output)).toBe(true);
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T1 CLI: maintain create --dry-run never prints READBACK ok=yes', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-create' });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 200 });
      rememberEnv('ROUTERSYNC_STATE_DIR');
      process.env['ROUTERSYNC_STATE_DIR'] = fixture.stateDir;
      const result = await captureRun(() =>
        runMaintainCreateCommand({
          name: 'test-9',
          models: 'p1/m1,p1/m2',
          configPath: fixture.configPath,
          router: 'nine',
          stateDir: fixture.stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => fixture.secret,
        } as MaintainCreateOptions)
      );
      expect(outputOf(result)).not.toContain('READBACK ok=yes');
    } finally {
      await fake.stopServer();
    }
  });

  it('M2-03-T5 CLI: maintain create isolated prints READBACK db-only, never ok=yes', async () => {
    const fake = new FakeRouter({ name: 'cli-nine-create-isolated' });
    await fake.startServer();
    try {
      const fixture = makeFixture('nine', { baseUrl: fake.baseUrl, servingWaitMs: 200 });
      fs.writeFileSync(
        fixture.configPath,
        fs.readFileSync(fixture.configPath, 'utf8').replace('    write: db\n', '    write: db\n    isolated: true\n'),
        'utf8'
      );
      rememberEnv('ROUTERSYNC_STATE_DIR');
      process.env['ROUTERSYNC_STATE_DIR'] = fixture.stateDir;
      const result = await captureRun(() =>
        runMaintainCreateCommand({
          name: 'test-9',
          models: 'p1/m1,p1/m2',
          configPath: fixture.configPath,
          router: 'nine',
          stateDir: fixture.stateDir,
          isTTY: false,
          secretResolver: () => fixture.secret,
        } as MaintainCreateOptions)
      );
      const output = outputOf(result);
      expect(result.exitCode).toBe(0);
      expect(output).toContain('READBACK db-only');
      expect(output).not.toContain('READBACK ok=yes');
    } finally {
      await fake.stopServer();
    }
  });
});
