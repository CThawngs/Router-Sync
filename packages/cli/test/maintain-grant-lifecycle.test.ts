/**
 * packages/cli/test/maintain-grant-lifecycle.test.ts
 *
 * M2-01 (ADR-MAINTAIN-02) + C45-WP4 (§3.2.2): Grant Lifecycle, policy-scoped
 * standing-consent combo allowlist (default []), strict --agents allowlist
 * grammar, programmatic non-PTY test seams, grant-status --json zero-leak output,
 * and grant cryptographic/schema corruption hardening.
 *
 * Isolation invariant: 100% temp dirs + node:sqlite fixtures, zero router ports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { upsertStandingConsentTarget } from '@routersync/core';
import {
  runMaintainAuthorizeCommand,
  runMaintainGrantStatusCommand,
  runMaintainRevokeGrantCommand,
  runMaintainCreateCommand,
  runMaintainApplyCommand,
  runMaintainPlanCommand,
  type MaintainAuthorizeOptions,
  type MaintainApplyOptions,
  type MaintainCreateOptions,
} from '../src/commands/maintain.js';
import {
  createGrantFile,
  generateGrantSecret,
  getGrantFilePath,
  validateGrantFile,
  type ApplyGrant,
} from '../src/maintain/grant.js';
import * as grantMod from '../src/maintain/grant.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
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

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedStandingConsentCombos(stateDir: string, combos: string[]): void {
  for (const combo of combos) {
    upsertStandingConsentTarget(stateDir, {
      target: `router:nine/${combo}`,
      level: 'propose',
      ttlDays: 30,
    });
  }
}

function makeIsolatedRouterFixture(dir: string): { dbPath: string; configPath: string } {
  const dbPath = path.join(dir, 'data.sqlite');
  const now = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE combos (id TEXT, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);' +
      'CREATE TABLE settings (id INTEGER, data TEXT);' +
      `INSERT INTO combos VALUES ('test-1','test-1',NULL,'${JSON.stringify(['p1/m1', 'p1/m2', 'p1/m3'])}','${now}','${now}');` +
      `INSERT INTO combos VALUES ('test-2','test-2',NULL,'${JSON.stringify(['p1/m1', 'p1/m2'])}','${now}','${now}');` +
      `INSERT INTO combos VALUES ('coding-main','coding-main',NULL,'${JSON.stringify(['p1/m1', 'p1/m2'])}','${now}','${now}');` +
      "INSERT INTO settings VALUES (1,'{}');"
  );
  db.close();

  const configPath = path.join(dir, 'routersync.yaml');
  fs.writeFileSync(
    configPath,
    [
      'version: 1',
      'routers:',
      '  - id: nine',
      '    adapter: 9router',
      '    write: db',
      '    db:',
      `      path: ${dbPath}`,
      '    reload:',
      '      type: none',
      'policy:',
      '  mode: manual',
      'combos:',
      '  - name: test-1',
      '    routers:',
      '      - nine',
      '    size: 3',
      '  - name: test-2',
      '    routers:',
      '      - nine',
      '    size: 2',
      '  - name: coding-main',
      '    routers:',
      '      - nine',
      '    size: 2',
      'adopt: []',
      '',
    ].join('\n'),
    'utf8'
  );
  return { dbPath, configPath };
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
    if (err instanceof ExitSignal) {
      exitCode = err.code;
    } else {
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

function extractRefusalReason(stderr: string[]): string | undefined {
  const joined = stderr.join('\n');
  return joined.match(/MAINTAIN-REFUSED reason=(\S+)/)?.[1];
}

describe('M2-01 Grant Lifecycle & Policy-Scoped Allowlist Grammar (ADR-MAINTAIN-02 + C45-WP4)', () => {
  const tempDirs: string[] = [];
  let savedGrantSecret: string | undefined;
  let savedApplyGrantSecret: string | undefined;
  let savedStateDir: string | undefined;
  let savedStdinTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedGrantSecret = process.env['ROUTERSYNC_GRANT_SECRET'];
    savedApplyGrantSecret = process.env['ROUTERSYNC_APPLY_GRANT_SECRET'];
    savedStateDir = process.env['ROUTERSYNC_STATE_DIR'];
    savedStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    delete process.env['ROUTERSYNC_GRANT_SECRET'];
    delete process.env['ROUTERSYNC_APPLY_GRANT_SECRET'];
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedGrantSecret !== undefined) process.env['ROUTERSYNC_GRANT_SECRET'] = savedGrantSecret;
    else delete process.env['ROUTERSYNC_GRANT_SECRET'];
    if (savedApplyGrantSecret !== undefined) {
      process.env['ROUTERSYNC_APPLY_GRANT_SECRET'] = savedApplyGrantSecret;
    } else {
      delete process.env['ROUTERSYNC_APPLY_GRANT_SECRET'];
    }
    if (savedStateDir !== undefined) process.env['ROUTERSYNC_STATE_DIR'] = savedStateDir;
    else delete process.env['ROUTERSYNC_STATE_DIR'];
    if (savedStdinTTY) Object.defineProperty(process.stdin, 'isTTY', savedStdinTTY);
    else delete (process.stdin as { isTTY?: unknown }).isTTY;

    for (const d of tempDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  describe('M2-01-T1: Strict --only grammar & default [] standing-consent policy in authorize and apply', () => {
    const invalidPatterns: Array<{ input: string; expectedReason: string }> = [
      { input: '', expectedReason: 'no-only' },
      { input: '   ', expectedReason: 'no-only' },
      { input: 'test-1,', expectedReason: 'only-pattern' },
      { input: ',test-1', expectedReason: 'only-pattern' },
      { input: 'test-1,,test-2', expectedReason: 'only-pattern' },
      { input: 'test-1, test-2', expectedReason: 'only-pattern' },
      { input: 'test-1', expectedReason: 'only-pattern' },
      { input: 'prod-1', expectedReason: 'only-pattern' },
    ];

    for (const { input, expectedReason } of invalidPatterns) {
      it(`rejects --only ${JSON.stringify(input)} when standing-consent.json is absent in maintain authorize with ${expectedReason}`, async () => {
        const stateDir = makeTempWorkspace('rs-m201-t1-auth-');
        tempDirs.push(stateDir);

        const res = await captureRun(() =>
          runMaintainAuthorizeCommand({
            only: input,
            stateDir,
            isTTY: true,
            promptFn: async () => 'chay',
          } as MaintainAuthorizeOptions)
        );

        expect(res.exitCode).toBe(1);
        expect(extractRefusalReason(res.stderr)).toBe(expectedReason);
        expect(fs.existsSync(getGrantFilePath(stateDir))).toBe(false);
      });

      it(`rejects --only ${JSON.stringify(input)} when standing-consent.json is absent in maintain apply with ${expectedReason}`, async () => {
        const stateDir = makeTempWorkspace('rs-m201-t1-apply-');
        tempDirs.push(stateDir);

        const res = await captureRun(() =>
          runMaintainApplyCommand({
            only: input,
            stateDir,
            planHash: '0000000000000000',
            isTTY: false,
          } as MaintainApplyOptions)
        );

        expect(res.exitCode).toBe(1);
        expect(extractRefusalReason(res.stderr)).toBe(expectedReason);
      });
    }
  });

  describe('M2-01-T2: Strict --agents allowlist grammar in authorize and apply', () => {
    const invalidAgents = ['', '   ', 'hermes,', ',hermes', 'hermes,,dsh', 'hermes, dsh', 'claude'];

    for (const rawAgents of invalidAgents) {
      it(`rejects --agents ${JSON.stringify(rawAgents)} in maintain authorize with agents-invalid`, async () => {
        const stateDir = makeTempWorkspace('rs-m201-t2-auth-');
        tempDirs.push(stateDir);

        const res = await captureRun(() =>
          runMaintainAuthorizeCommand({
            only: 'test-1',
            agents: rawAgents,
            stateDir,
            isTTY: true,
            promptFn: async () => 'chay',
          } as MaintainAuthorizeOptions)
        );

        expect(res.exitCode).toBe(1);
        expect(extractRefusalReason(res.stderr)).toBe('agents-invalid');
        expect(fs.existsSync(getGrantFilePath(stateDir))).toBe(false);
      });

      it(`rejects --agents ${JSON.stringify(rawAgents)} in maintain apply with agents-invalid`, async () => {
        const stateDir = makeTempWorkspace('rs-m201-t2-apply-');
        tempDirs.push(stateDir);

        const res = await captureRun(() =>
          runMaintainApplyCommand({
            only: 'test-1',
            agents: rawAgents,
            stateDir,
            planHash: '0000000000000000',
            isTTY: false,
          } as MaintainApplyOptions)
        );

        expect(res.exitCode).toBe(1);
        expect(extractRefusalReason(res.stderr)).toBe('agents-invalid');
      });
    }
  });

  describe('M2-01-T3: Full grant lifecycle via programmatic seams & grant-status --json zero-leak', () => {
    it('refuses non-TTY authorize, create, and apply with reason=no-tty when policy consent exists but no grant exists', async () => {
      const stateDir = makeTempWorkspace('rs-m201-t3-notty-');
      tempDirs.push(stateDir);
      const { configPath } = makeIsolatedRouterFixture(stateDir);
      seedStandingConsentCombos(stateDir, ['test-1', 'test-9']);

      const authRes = await captureRun(() =>
        runMaintainAuthorizeCommand({
          only: 'test-1',
          stateDir,
          isTTY: false,
          promptFn: async () => 'chay',
        } as MaintainAuthorizeOptions)
      );
      expect(authRes.exitCode).toBe(1);
      expect(extractRefusalReason(authRes.stderr)).toBe('no-tty');
      expect(fs.existsSync(getGrantFilePath(stateDir))).toBe(false);

      const createRes = await captureRun(() =>
        runMaintainCreateCommand({
          name: 'test-9',
          models: 'p1/m1,p1/m2',
          configPath,
          router: 'nine',
          stateDir,
          isTTY: false,
        } as MaintainCreateOptions)
      );
      expect(createRes.exitCode).toBe(1);
      expect(extractRefusalReason(createRes.stderr)).toBe('no-tty');

      const applyRes = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-1',
          configPath,
          router: 'nine',
          planHash: '0000000000000000',
          stateDir,
          isTTY: false,
        } as MaintainApplyOptions)
      );
      expect(applyRes.exitCode).toBe(1);
      expect(extractRefusalReason(applyRes.stderr)).toBe('no-tty');
    });

    it('runs full authorize -> grant-status --json (zero-leak) -> apply -> scope/secret/MAC/expiry checks -> revoke lifecycle (including real combo coding-main)', async () => {
      const stateDir = makeTempWorkspace('rs-m201-t3-full-');
      tempDirs.push(stateDir);
      process.env['ROUTERSYNC_STATE_DIR'] = stateDir;
      const { configPath } = makeIsolatedRouterFixture(stateDir);
      seedStandingConsentCombos(stateDir, ['test-1', 'coding-main']);

      // 1. Issue grant via programmatic TTY + promptFn seam (deduplicates test-1,test-1 and hermes,hermes)
      const authRes = await captureRun(() =>
        runMaintainAuthorizeCommand({
          only: 'test-1,test-1,coding-main',
          agents: 'hermes,hermes,opencode',
          hours: '2',
          stateDir,
          isTTY: true,
          promptFn: async () => 'chay',
        } as MaintainAuthorizeOptions)
      );
      expect(authRes.exitCode).toBe(0);
      const secretLine = authRes.stdout.find((l) => l.startsWith('GRANT-SECRET '));
      expect(secretLine).toBeDefined();
      const issuedSecret = secretLine!.slice('GRANT-SECRET '.length).trim();
      expect(issuedSecret.length).toBeGreaterThanOrEqual(32);

      const grantPath = getGrantFilePath(stateDir);
      expect(fs.existsSync(grantPath)).toBe(true);
      const rawDiskGrant = JSON.parse(fs.readFileSync(grantPath, 'utf8')) as Record<string, unknown>;
      expect(rawDiskGrant['combos']).toEqual(['test-1', 'coding-main']);
      expect(rawDiskGrant['agents']).toEqual(['hermes', 'opencode']);

      // 2. grant-status --json active output + strict zero-leak verification
      const statusActive = await captureRun(() =>
        runMaintainGrantStatusCommand({ stateDir, json: true })
      );
      expect(statusActive.exitCode).toBe(0);
      expect(statusActive.stdout).toHaveLength(1);
      const rawStatusJson = statusActive.stdout[0]!;
      const parsedStatus = JSON.parse(rawStatusJson) as Record<string, unknown>;
      expect(parsedStatus).toMatchObject({
        active: true,
        id: rawDiskGrant['id'],
        combos: ['test-1', 'coding-main'],
        agents: ['hermes', 'opencode'],
        createdAt: rawDiskGrant['createdAt'],
        expiresAt: rawDiskGrant['expiresAt'],
      });
      expect(typeof parsedStatus['remainingMin']).toBe('number');
      expect(parsedStatus).not.toHaveProperty('secret');
      expect(parsedStatus).not.toHaveProperty('secretHash');
      expect(parsedStatus).not.toHaveProperty('salt');
      expect(parsedStatus).not.toHaveProperty('mac');
      expect(rawStatusJson).not.toContain(issuedSecret);
      expect(rawStatusJson).not.toContain(String(rawDiskGrant['secretHash']));
      expect(rawStatusJson).not.toContain(String(rawDiskGrant['salt']));
      expect(rawStatusJson).not.toContain(String(rawDiskGrant['mac']));

      // 3. Compute planHash on isolated tmp fixture
      const planRes = await captureRun(() =>
        runMaintainPlanCommand({ configPath, router: 'nine', stateDir, json: true })
      );
      expect(planRes.exitCode).toBe(0);
      const planObj = JSON.parse(planRes.stdout.join('\n')) as { planHash: string };
      expect(planObj.planHash).toMatch(/^[0-9a-f]{16}$/);

      // 4. Non-TTY apply succeeds for both test-1 AND real combo coding-main when valid grant matches scope
      for (const comboTarget of ['test-1', 'coding-main']) {
        const applyOk = await captureRun(() =>
          runMaintainApplyCommand({
            only: comboTarget,
            agents: 'hermes',
            planHash: planObj.planHash,
            configPath,
            router: 'nine',
            stateDir,
            dryRun: true,
            isTTY: false,
            secretResolver: () => issuedSecret,
          } as MaintainApplyOptions)
        );
        expect(applyOk.exitCode).toBe(0);
        expect(applyOk.stdout.join('\n')).toContain(`grant=${String(rawDiskGrant['id'])}`);
      }

      // 5. Out-of-scope combo (test-2 when grant only covers test-1,coding-main) refuses grant-scope / grant-scope-combo
      const outCombo = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-2',
          agents: 'hermes',
          planHash: planObj.planHash,
          configPath,
          router: 'nine',
          stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => issuedSecret,
        } as MaintainApplyOptions)
      );
      expect(outCombo.exitCode).toBe(1);
      expect(extractRefusalReason(outCombo.stderr)).toBe('grant-scope');
      expect(outCombo.stderr.join('\n')).toContain('grant-scope-combo');

      // 6. Out-of-scope agent (dsh when grant only covers hermes,opencode) refuses grant-scope / grant-scope-agent
      const outAgent = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-1',
          agents: 'dsh',
          planHash: planObj.planHash,
          configPath,
          router: 'nine',
          stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => issuedSecret,
        } as MaintainApplyOptions)
      );
      expect(outAgent.exitCode).toBe(1);
      expect(extractRefusalReason(outAgent.stderr)).toBe('grant-scope');
      expect(outAgent.stderr.join('\n')).toContain('grant-scope-agent');

      // 7. Wrong secret -> grant-secret-wrong
      const wrongSecret = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-1',
          agents: 'hermes',
          planHash: planObj.planHash,
          configPath,
          router: 'nine',
          stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => 'wrong-secret-candidate',
        } as MaintainApplyOptions)
      );
      expect(wrongSecret.exitCode).toBe(1);
      expect(extractRefusalReason(wrongSecret.stderr)).toBe('grant-secret-wrong');

      // 8. Tampered combos on disk with valid secret -> grant-mac-invalid
      const tampered = { ...rawDiskGrant, combos: ['test-1', 'test-2'] };
      fs.writeFileSync(grantPath, JSON.stringify(tampered, null, 2), 'utf8');
      const tamperedRes = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-1',
          agents: 'hermes',
          planHash: planObj.planHash,
          configPath,
          router: 'nine',
          stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => issuedSecret,
        } as MaintainApplyOptions)
      );
      expect(tamperedRes.exitCode).toBe(1);
      expect(extractRefusalReason(tamperedRes.stderr)).toBe('grant-mac-invalid');

      // 9. Expired grant -> grant-expired
      const nowMs = Date.now();
      const expiredBase: ApplyGrant = {
        version: 1,
        id: 'abcdef0123456789',
        combos: ['test-1'],
        agents: ['hermes'],
        createdAt: new Date(nowMs - 7200_000).toISOString(),
        expiresAt: new Date(nowMs - 60_000).toISOString(),
      };
      const expiredSecret = generateGrantSecret();
      fs.writeFileSync(grantPath, JSON.stringify(createGrantFile(expiredBase, expiredSecret), null, 2), 'utf8');
      const expiredRes = await captureRun(() =>
        runMaintainApplyCommand({
          only: 'test-1',
          agents: 'hermes',
          planHash: planObj.planHash,
          configPath,
          router: 'nine',
          stateDir,
          dryRun: true,
          isTTY: false,
          secretResolver: () => expiredSecret,
        } as MaintainApplyOptions)
      );
      expect(expiredRes.exitCode).toBe(1);
      expect(extractRefusalReason(expiredRes.stderr)).toBe('grant-expired');

      // 10. Revoke deletes grant and grant-status --json reports active: false
      const revokeRes = await captureRun(() => runMaintainRevokeGrantCommand({ stateDir }));
      expect(revokeRes.exitCode).toBe(0);
      expect(revokeRes.stdout.join('\n')).toContain('GRANT-REVOKED');
      expect(fs.existsSync(grantPath)).toBe(false);

      const statusAfterRevoke = await captureRun(() =>
        runMaintainGrantStatusCommand({ stateDir, json: true })
      );
      expect(statusAfterRevoke.exitCode).toBe(0);
      const inactiveJson = JSON.parse(statusAfterRevoke.stdout[0]!) as Record<string, unknown>;
      expect(inactiveJson['active']).toBe(false);
    });
  });

  describe('M2-01-T4: Hex & JSON array corruption hardening in grant.ts', () => {
    it('rejects JSON array grant file [] cleanly with grant-invalid', () => {
      const stateDir = makeTempWorkspace('rs-m201-t4-arr-');
      tempDirs.push(stateDir);
      const grantPath = getGrantFilePath(stateDir);
      fs.writeFileSync(grantPath, '[]', 'utf8');

      const v1 = validateGrantFile(grantPath, 'some-secret');
      expect(v1.valid).toBe(false);
      if (!v1.valid) expect(v1.reason).toBe('grant-invalid');

      const readGrantFn = (grantMod as Record<string, unknown>)['readGrant'] as
        | ((p: string) => { ok: boolean; reason?: string })
        | undefined;
      expect(typeof readGrantFn).toBe('function');
      const r1 = readGrantFn!(grantPath);
      expect(r1.ok).toBe(false);
      expect(r1.reason).toBe('grant-invalid');
    });

    it('rejects truncated or non-hex salt, secretHash, and mac with grant-invalid without throwing', () => {
      const stateDir = makeTempWorkspace('rs-m201-t4-hex-');
      tempDirs.push(stateDir);
      const grantPath = getGrantFilePath(stateDir);

      const now = Date.now();
      const base: ApplyGrant = {
        version: 1,
        id: '1122334455667788',
        combos: ['test-1'],
        agents: ['hermes'],
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600_000).toISOString(),
      };
      const secret = generateGrantSecret();
      const validGrantFile = createGrantFile(base, secret);

      const corruptedVariants = [
        { ...validGrantFile, salt: 'abcd' },
        { ...validGrantFile, salt: 'zz'.repeat(16) },
        { ...validGrantFile, secretHash: '1234' },
        { ...validGrantFile, mac: '1234' },
        { ...validGrantFile, mac: 'gg'.repeat(32) },
      ];

      const verifyGrantSecretFn = (grantMod as Record<string, unknown>)['verifyGrantSecret'] as
        | ((g: unknown, s: string | undefined) => { ok?: boolean; valid?: boolean; reason?: string })
        | undefined;
      expect(typeof verifyGrantSecretFn).toBe('function');

      for (const corrupted of corruptedVariants) {
        fs.writeFileSync(grantPath, JSON.stringify(corrupted), 'utf8');
        const res = validateGrantFile(grantPath, secret);
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.reason).toBe('grant-invalid');
        }

        const directVerify = verifyGrantSecretFn!(corrupted, secret);
        expect(directVerify.ok ?? directVerify.valid).toBe(false);
        expect(directVerify.reason).toBe('grant-invalid');
      }
    });
  });
});
