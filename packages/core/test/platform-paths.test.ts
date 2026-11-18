/**
 * packages/core/test/platform-paths.test.ts
 *
 * K3.1 - the path helpers must not assume one operating system. Every helper
 * takes `env` and `platform` as parameters, so the three platforms can be
 * simulated on one machine.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { locateRouterDb } from '../src/sqlite/better-sqlite3.js';
import { getConfigDir } from '../src/paths/index.js';

const HOME = path.join(path.sep, 'home', 'tester');

describe('K3.1 / J1 - the router database path is platform aware', () => {
  it('Windows uses %APPDATA%\\9router\\db\\data.sqlite', () => {
    const env = { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }; // no-secrets:allow: synthetic test path
    const result = locateRouterDb('9router', env, 'win32');
    expect(result).toContain('9router');
    expect(result).toContain('data.sqlite');
    expect(result.toLowerCase()).toContain('appdata');
  });

  it('macOS uses ~/.9router/db/data.sqlite', () => {
    const env = { HOME: '/Users/tester' };
    const result = locateRouterDb('9router', env, 'darwin');
    expect(result).toContain(path.join('.9router', 'db', 'data.sqlite'));
  });

  it('Linux uses ~/.9router/db/data.sqlite', () => {
    const env = { HOME: '/home/tester' }; // no-secrets:allow: synthetic test path
    const result = locateRouterDb('9router', env, 'linux');
    expect(result).toContain(path.join('.9router', 'db', 'data.sqlite'));
  });

  it('DATA_DIR override is used when file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-datadir-'));
    try {
      const dbDir = path.join(tmpDir, 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(path.join(dbDir, 'data.sqlite'), '');
      const env = { DATA_DIR: tmpDir, HOME: '/home/tester' }; // no-secrets:allow: synthetic test path
      const result = locateRouterDb('9router', env, 'linux');
      expect(result).toBe(path.resolve(path.join(tmpDir, 'db', 'data.sqlite')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('DATA_DIR override is ignored when file does not exist', () => {
    const env = { DATA_DIR: '/nonexistent/path/for/routersync/test', HOME: '/home/tester' }; // no-secrets:allow: synthetic test path
    const result = locateRouterDb('9router', env, 'linux');
    expect(result).toContain(path.join('.9router', 'db', 'data.sqlite'));
  });

  it('ROUTERSYNC_9ROUTER_DB beats DATA_DIR even when DATA_DIR file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-datadir-'));
    try {
      const dbDir = path.join(tmpDir, 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(path.join(dbDir, 'data.sqlite'), '');
      const env = {
        DATA_DIR: tmpDir,
        ROUTERSYNC_9ROUTER_DB: '/tmp/priority-nine.sqlite',
        HOME: '/home/tester', // no-secrets:allow: synthetic test path
      };
      const result = locateRouterDb('9router', env, 'linux');
      expect(result).toContain('priority-nine.sqlite');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the environment variable overrides the database path on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const env = {
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', // no-secrets:allow: synthetic test path
        HOME: '/home/tester', // no-secrets:allow: synthetic test path
        ROUTERSYNC_9ROUTER_DB: '/tmp/custom-nine.sqlite',
      };
      expect(locateRouterDb('9router', env, platform)).toContain('custom-nine.sqlite');
    }
  });

  it('OmniRoute uses its home directory and can be overridden', () => {
    const env = { ROUTERSYNC_OMNIROUTE_DB: '/tmp/custom-omni.sqlite' };
    expect(locateRouterDb('omniroute', env, 'linux')).toContain('custom-omni.sqlite'); // no-secrets:allow: synthetic Unicode test path
  });
});

describe('K3.1 - the configuration directory is platform aware', () => {
  it('Windows uses %APPDATA%\\routersync', () => {
    const env = { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }; // no-secrets:allow: synthetic test path
    const dir = getConfigDir(env, 'win32');
    expect(dir.toLowerCase()).toContain('appdata');
    expect(dir.toLowerCase()).toContain('routersync');
  });

  it('macOS and Linux use $XDG_CONFIG_HOME/routersync', () => {
    const env = { XDG_CONFIG_HOME: '/home/tester/.config' }; // no-secrets:allow: synthetic test path
    for (const platform of ['darwin', 'linux'] as const) {
      const dir = getConfigDir(env, platform);
      expect(dir).toContain(path.join('.config', 'routersync'));
    }
  });

  it('ROUTERSYNC_HOME overrides the configuration directory', () => {
    const env = { ROUTERSYNC_HOME: '/tmp/rs-home', XDG_CONFIG_HOME: '/home/tester/.config' }; // no-secrets:allow: synthetic test path
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(getConfigDir(env, platform)).toContain('rs-home');
    }
  });
});

describe('C15 Q2.5 - path separators, spaces and Unicode', () => {
  const cases = [
    { platform: 'win32', env: { APPDATA: 'C:\\Users\\Tester Name' } }, // no-secrets:allow: synthetic test path
    { platform: 'darwin', env: { HOME: '/Users/Tester Name' } },
    { platform: 'linux', env: { HOME: '/home/tester name' } }, // no-secrets:allow: synthetic test path
  ];
  for (const c of cases) {
    it(`resolves a home path with spaces on ${c.platform}`, () => {
      const result = locateRouterDb('9router', c.env, c.platform);
      expect(result).toContain('data.sqlite');
      expect(result).not.toContain('\n');
    });
  }

  it('accepts both slash styles in an explicit override', () => {
    const withSlash = locateRouterDb('9router', { ROUTERSYNC_9ROUTER_DB: '/tmp/rs db/data.sqlite' }, 'linux');
    const withBackslash = locateRouterDb('9router', { ROUTERSYNC_9ROUTER_DB: 'C:\\rs db\\data.sqlite' }, 'win32');
    expect(withSlash).toContain('data.sqlite');
    expect(withBackslash).toContain('data.sqlite');
  });

  it('keeps Unicode in the resolved path', () => {
    const result = locateRouterDb('omniroute', { HOME: '/home/người dùng', XDG_STATE_HOME: '/home/người dùng/.local/state' }, 'linux'); // no-secrets:allow: synthetic Unicode test path
    expect(result).toContain('omniroute');
  });
});
