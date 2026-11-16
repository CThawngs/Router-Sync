/**
 * packages/cli/test/roundC3u.test.ts
 * C3u: U0b GATE-FLOW (typed=chay writes / typed=no refuses on tmp config),
 * U2a ISOLATION-CHECK (child env probe), U3a SECRET-SELFTEST (non-TTY).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { applyAgentModelUpdate } from '../src/commands/agents.js';

const distIndex = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

function shaOf(f: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function makeHermesTmp(): { tmp: string; home: string; cfg: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3u-gateflow-'));
  const home = path.join(tmp, 'home');
  const hermesDir = path.join(home, '.hermes');
  fs.mkdirSync(hermesDir, { recursive: true });
  const cfg = path.join(hermesDir, 'config.yaml');
  fs.writeFileSync(cfg, 'model:\n  provider: 9router\n  default: test-1\n', 'utf8');
  return { tmp, home, cfg };
}

describe('C3u U0b GATE-FLOW agents tty-confirm', () => {
  it('typed=chay -> authorized=yes, tmp config changed', async () => {
    const { tmp, home, cfg } = makeHermesTmp();
    const before = shaOf(cfg);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await applyAgentModelUpdate('hermes', {
        customHome: home,
        stateDir: tmp,
        models: ['test-3'],
        promptFn: async () => 'chay',
      });
      expect(r.configPath).toBe(cfg);
    } finally {
      delete (process.stdin as unknown as Record<string, unknown>)['isTTY'];
    }
    const after = shaOf(cfg);
    console.log(
      `GATE-FLOW | agents tty-confirm | typed=chay | authorized=yes | tmp-config-changed=${before !== after ? 'yes' : 'no'}`
    );
    expect(before !== after).toBe(true);
  });

  it('typed=no -> authorized=no, tmp config unchanged', async () => {
    const { tmp, home, cfg } = makeHermesTmp();
    const before = shaOf(cfg);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(
        applyAgentModelUpdate('hermes', {
          customHome: home,
          stateDir: tmp,
          models: ['test-3'],
          promptFn: async () => 'no',
        })
      ).rejects.toThrow(/confirm-required/);
    } finally {
      delete (process.stdin as unknown as Record<string, unknown>)['isTTY'];
    }
    const after = shaOf(cfg);
    console.log(
      `GATE-FLOW | agents tty-confirm | typed=no | authorized=no | tmp-config-changed=${before !== after ? 'yes' : 'no'}`
    );
    expect(before).toBe(after);
  });
});

describe('C3u U2a ISOLATION-CHECK child env', () => {
  it('child HOME/APPDATA/state-dir point to tmp, real 9router DB not visible', () => {
    const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'c3u-iso-check-'));
    const appdata = path.join(iso, 'AppData', 'Roaming');
    const localAppdata = path.join(iso, 'AppData', 'Local');
    const stateDir = path.join(iso, 'state');
    const code =
      "const os=require('os');" +
      "console.log(JSON.stringify({homedir:os.homedir(),appdata:process.env.APPDATA,state:process.env.ROUTERSYNC_STATE_DIR}))";
    const r = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: iso,
        USERPROFILE: iso,
        APPDATA: appdata,
        LOCALAPPDATA: localAppdata,
        ROUTERSYNC_STATE_DIR: stateDir,
      },
      timeout: 60_000,
    });
    const probe = JSON.parse((r.stdout ?? '').trim()) as { homedir: string; appdata: string; state: string };
    const dbUnderIsolated = path.join(probe.appdata, '9router', 'db', 'data.sqlite');
    const visible = fs.existsSync(dbUnderIsolated) ? 'yes' : 'no';
    console.log(
      `ISOLATION-CHECK child-env-home=${probe.homedir === iso ? 'tmp' : 'NOT-TMP'} appdata=${probe.appdata === appdata ? 'tmp' : 'NOT-TMP'} state-dir=${probe.state === stateDir ? 'tmp' : 'NOT-TMP'} real-9router-db-visible=${visible}`
    );
    expect(probe.homedir).toBe(iso);
    expect(probe.appdata).toBe(appdata);
    expect(probe.state).toBe(stateDir);
    expect(visible).toBe('no');
  });
});

describe('C3u U3a SECRET-SELFTEST non-TTY', () => {
  it('maintain secret-selftest without TTY -> result=missing tty=no', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3u-selftest-'));
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env['ROUTERSYNC_GRANT_SECRET'];
    const r = spawnSync(process.execPath, [distIndex, 'maintain', 'secret-selftest', '--state-dir', tmp], {
      encoding: 'utf8',
      input: '',
      env,
      timeout: 60_000,
    });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const line = out.split(/\r?\n/).find((l) => l.startsWith('SECRET-SELFTEST')) ?? '';
    console.log(line);
    expect(r.status).toBe(0);
    expect(line).toBe('SECRET-SELFTEST result=missing tty=no grants-checked=1');
  });
});
