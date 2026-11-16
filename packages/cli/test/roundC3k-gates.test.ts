/**
 * packages/cli/test/roundC3k-gates.test.ts
 * C3k K1: isTestBypass must not reach production. authorize is TTY-only;
 * create/apply/agents bypass works only under VITEST=true (and create/apply
 * keep the os.tmpdir guard). Non-TTY + env set, outside vitest, must refuse.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkAgentWriteAuthorization } from '../src/commands/agents.js';
import { getGrantFilePath } from '../src/maintain/grant.js';

function setStdinTTY(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ROUTERSYNC_TEST_FAST'];
  delete process.env['ROUTERSYNC_TEST_CONFIRM'];
  delete process.env['VITEST'];
});

describe('K1 write-gate bypass is test-only', () => {
  it('agents: env set but no VITEST + non-TTY -> not authorized (no-tty)', () => {
    setStdinTTY(false);
    delete process.env['VITEST'];
    process.env['ROUTERSYNC_TEST_FAST'] = '1';
    process.env['ROUTERSYNC_TEST_CONFIRM'] = '1';
    const auth = checkAgentWriteAuthorization({ agent: 'hermes' });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe('no-tty');
  });

  it('L3b agents: env set + VITEST=true but no injected flag -> REFUSED no-tty', () => {
    setStdinTTY(false);
    process.env['VITEST'] = 'true';
    process.env['ROUTERSYNC_TEST_FAST'] = '1';
    process.env['ROUTERSYNC_TEST_CONFIRM'] = '1';
    const auth = checkAgentWriteAuthorization({ agent: 'hermes' });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe('no-tty');
  });
  it('L3b agents: injected allowTestBypass + env -> authorized (test-only)', () => {
    setStdinTTY(false);
    process.env['VITEST'] = 'true';
    process.env['ROUTERSYNC_TEST_FAST'] = '1';
    process.env['ROUTERSYNC_TEST_CONFIRM'] = '1';
    const auth = checkAgentWriteAuthorization({ agent: 'hermes', allowTestBypass: true });
    expect(auth.authorized).toBe(true);
  });

  it('maintain authorize: non-TTY + env set -> MAINTAIN-REFUSED no-tty, no grant file', async () => {
    setStdinTTY(false);
    delete process.env['VITEST'];
    process.env['ROUTERSYNC_TEST_FAST'] = '1';
    process.env['ROUTERSYNC_TEST_CONFIRM'] = 'chay';
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_k1_auth_'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runMaintainAuthorizeCommand } = await import('../src/commands/maintain.js');
    await expect(
      runMaintainAuthorizeCommand({ only: 'test-1', hours: '1', stateDir } as never)
    ).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(getGrantFilePath(stateDir))).toBe(false);
    errSpy.mockRestore();
  });
});

describe('K1b daemon/mcp-server write-import ban (working tree, untracked-aware)', () => {
  it('packages/daemon/src and packages/mcp-server/src import no write modules', () => {
    const banned = /sync\/write|applyStepRemovals|restoreCombosFromBackup|writeCombos|adapter\.(write|rollback)/;
    const offenders: string[] = [];
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    for (const dir of ['packages/daemon/src', 'packages/mcp-server/src'].map((d) => path.join(root, d))) {
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.ts')) {
            const src = fs.readFileSync(p, 'utf8');
            if (banned.test(src)) offenders.push(p);
          }
        }
      };
      walk(dir);
    }
    expect(offenders).toEqual([]);
  });
});
