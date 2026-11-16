/**
 * packages/cli/test/roundC3t.test.ts
 * C3t T0: maintain create gate uses the same grant secret as apply;
 * grant file never contains the plaintext secret; agents TTY-only write
 * without a grant needs typed confirm (confirm-required).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createGrantFile,
  generateGrantSecret,
  validateGrantFile,
  type ApplyGrant,
} from '../src/maintain/grant.js';
import { checkAgentWriteAuthorization } from '../src/commands/agents.js';
import { computeCoverage } from '../src/commands/health.js';

const distIndex = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
};

function hashFile(f: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
function hashOrAbsent(f: string): string {
  return fs.existsSync(f) ? hashFile(f).slice(0, 16) : 'absent';
}
function baseGrant(): ApplyGrant {
  const now = new Date();
  return {
    version: 1,
    id: 'abcdef1234567890',
    combos: ['test-01'],
    agents: ['hermes'],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
  };
}
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env['VITEST'];
  delete env['ROUTERSYNC_TEST_CONFIRM'];
  delete env['ROUTERSYNC_TEST_FAST'];
  delete env['ROUTERSYNC_GRANT_SECRET'];
  // C3u U2a: con bài cách ly — đường mặc định không thể trỏ vào AppData\Roaming\9router.
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'c3u-iso-'));
  env['HOME'] = iso;
  env['USERPROFILE'] = iso;
  env['APPDATA'] = path.join(iso, 'AppData', 'Roaming');
  env['LOCALAPPDATA'] = path.join(iso, 'AppData', 'Local');
  if (!('ROUTERSYNC_STATE_DIR' in extra)) env['ROUTERSYNC_STATE_DIR'] = iso;
  return { ...env, ...extra };
}
function makeTmpDbWithConfig(tmp: string): { db: string; config: string } {
  const db = path.join(tmp, 'data.sqlite');
  const now = new Date().toISOString();
  const dev = new DatabaseSync(db);
  dev.exec(
    'CREATE TABLE combos (id TEXT, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);' +
      'CREATE TABLE settings (id INTEGER, data TEXT);' +
      `INSERT INTO combos VALUES ('c1','c1',NULL,'${JSON.stringify(['p1/m1', 'p1/m2', 'p1/m3'])}','${now}','${now}');` +
      "INSERT INTO settings VALUES (1,'{}');"
  );
  dev.close();
  const config = path.join(tmp, 'config.yaml');
  fs.writeFileSync(
    config,
    [
      'version: 1',
      'routers:',
      '  - id: nine',
      '    adapter: 9router',
      '    write: db',
      '    db:',
      `      path: ${db}`,
      '    reload:',
      '      type: none',
      'policy:',
      '  mode: manual',
      'combos:',
      '  - name: test-01',
      '    routers:',
      '      - nine',
      '    size: 3',
      'adopt: []',
      '',
    ].join('\n'),
    'utf8'
  );
  return { db, config };
}
function reasonOf(out: string): string {
  return out.match(/MAINTAIN-REFUSED reason=(\S+)/)?.[1] ?? 'unknown';
}
function runMaintainCreate(tmp: string, db: string, config: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [distIndex, 'maintain', 'create', 'test-01', '--models', 'p1/m1,p1/m2,p1/m3', '--state-dir', tmp, '--config', config, '--router', 'nine'],
    { input: '', env: { ...env, ROUTERSYNC_STATE_DIR: tmp, ROUTERSYNC_DB: db }, timeout: 60_000 }
  );
}

describe('C3t T0c maintain create gate', () => {
  it('GATE-FORGE maintain create with script-written grant -> grant-secret-missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3t-createforge-'));
    const { db, config } = makeTmpDbWithConfig(tmp);
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(baseGrant()), 'utf8');
    const before = hashFile(db);
    const r = runMaintainCreate(tmp, db, config, cleanEnv());
    const out = r.stdout.toString() + r.stderr.toString();
    const after = hashFile(db);
    const reason = reasonOf(out);
    console.log(
      `GATE-FORGE | maintain create | exit=${r.status} | reason=${reason} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'} | script-written-grant`
    );
    expect(r.status).toBe(1);
    expect(reason).toBe('grant-secret-missing');
    expect(before).toBe(after);
  });
});

describe('C3t T0c2 maintain create valid grant', () => {
  it('GATE-VALID maintain create with secret writes tmp DB, real DB hash stays BẰNG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3t-createvalid-'));
    const { db, config } = makeTmpDbWithConfig(tmp);
    const secret = generateGrantSecret();
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(createGrantFile(baseGrant(), secret)), 'utf8');
    const realDb = path.join(
      process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      '9router', 'db', 'data.sqlite'
    );
    const realBefore = hashOrAbsent(realDb);
    const tmpBefore = hashFile(db);
    const r = runMaintainCreate(tmp, db, config, cleanEnv({ ROUTERSYNC_GRANT_SECRET: secret }));
    const tmpAfter = hashFile(db);
    const realAfter = hashOrAbsent(realDb);
    const changed = tmpBefore !== tmpAfter ? 'yes' : 'no';
    console.log(
      `GATE-VALID | maintain create | exit=${r.status} | tmp-db-changed=${changed} | thật-băm=${realBefore === realAfter ? 'BẰNG' : 'BĂM ĐỔI'}`
    );
    if (r.status !== 0) console.log(`GATE-VALID-OUT ${(r.stdout.toString() + r.stderr.toString()).slice(0, 2000)}`);
    expect(r.status).toBe(0);
    expect(changed).toBe('yes');
    expect(realBefore).toBe(realAfter);
  });
});

describe('C3t T0d grant file has no plaintext secret', () => {
  it('GRANT-FILE-CHECK plaintext-secret-in-file=no', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3t-grantfile-'));
    const secret = generateGrantSecret();
    const file = path.join(tmp, 'apply-grant.json');
    fs.writeFileSync(file, JSON.stringify(createGrantFile(baseGrant(), secret)), 'utf8');
    const content = fs.readFileSync(file, 'utf8');
    const noPlain = !content.includes(secret);
    console.log(`GRANT-FILE-CHECK plaintext-secret-in-file=${noPlain ? 'no' : 'yes'}`);
    expect(noPlain).toBe(true);
    expect(validateGrantFile(file, secret).valid).toBe(true);
    expect(validateGrantFile(file, undefined).valid).toBe(false);
  });
});

describe('C3t T0e agents tty-only needs confirm', () => {
  it('GATE-UNIT agents tty-only without grant -> confirm-required', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3t-tty-'));
    const prev = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const auth = checkAgentWriteAuthorization({ agent: 'hermes', stateDir: tmp });
      console.log(
        `GATE-UNIT | agents tty-only | authorized=${auth.authorized ? 'yes' : 'no'} | reason=${auth.reason ?? 'none'}`
      );
      expect(auth.authorized).toBe(false);
      expect(auth.reason).toBe('confirm-required');
    } finally {
      if (prev) Object.defineProperty(process.stdin, 'isTTY', prev);
      else delete (process.stdin as { isTTY?: unknown }).isTTY;
    }
  });
});

describe('C3t T2b coverage sum check', () => {
  it('computeCoverage ok+quota+unscanned = total (kiểm: tổng bằng)', () => {
    const cov = computeCoverage(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b']), new Set(['c']));
    const sum = cov.ok.length + cov.quota.length + cov.unscanned.length;
    console.log(
      `COVERAGE-UNIT ok=${cov.ok.length} quota=${cov.quota.length} unscanned=${cov.unscanned.length} sum=${sum} total=4 ${sum === 4 ? '(kiểm: tổng bằng)' : ''}`
    );
    expect(sum).toBe(4);
  });
});
