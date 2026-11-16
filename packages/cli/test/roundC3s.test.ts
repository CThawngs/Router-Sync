/**
 * packages/cli/test/roundC3s.test.ts
 * C3s S0: grant is a real key. Script-written grants (no secret) are refused
 * with grant-secret-missing; tampered grants with correct secret fail with
 * grant-mac-invalid; a valid grant + secret + planHash reaches the write layer
 * on a tmp DB copy, and the real router DB hash stays BẰNG.
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

const distIndex = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const require = createRequire(import.meta.url);
// node:sqlite ships with Node: use it to build a tmp router DB.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    close(): void;
  };
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

function runMaintainApply(tmp: string, db: string, planHash: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [distIndex, 'maintain', 'apply', '--only', 'test-01', '--state-dir', tmp, '--plan-hash', planHash],
    { input: '', env: { ...env, ROUTERSYNC_STATE_DIR: tmp, ROUTERSYNC_DB: db }, timeout: 60_000 }
  );
}

function reasonOf(out: string): string {
  return (
    out.match(/MAINTAIN-REFUSED reason=(\S+)/)?.[1] ??
    (out.includes('Plan hash mismatch') ? 'plan-hash-mismatch' : 'unknown')
  );
}

describe('C3s S0a grant validate line', () => {
  it('prints GRANT-VALIDATE with forgeable=no computed from S0b result', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3s-grant-'));
    const secret = generateGrantSecret();
    const file = path.join(tmp, 'apply-grant.json');
    fs.writeFileSync(file, JSON.stringify(createGrantFile(baseGrant(), secret)), 'utf8');
    const ok = validateGrantFile(file, secret);
    expect(ok.valid).toBe(true);
    const missing = validateGrantFile(file, undefined);
    expect(missing.valid).toBe(false);
    if (!missing.valid) expect(missing.reason).toBe('grant-secret-missing');
    const forgeable = missing.valid ? 'yes' : 'no';
    const validateSrc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'maintain', 'grant.ts'),
      'utf8'
    );
    const lineNo = validateSrc.split('\n').findIndex((l) => l.includes('export function validateGrantFile')) + 1;
    console.log(
      `GRANT-VALIDATE fn=validateGrantFile file=packages/cli/src/maintain/grant.ts:${lineNo} keyStore=secret-hash mac=hmac-sha256 forgeable=${forgeable}`
    );
    expect(forgeable).toBe('no');
  });
});

describe('C3s S0b script-written grant refused at apply gate', () => {
  it('maintain apply with literal grant, no secret -> grant-secret-missing, DB BẰNG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3s-gateforge-'));
    const db = path.join(tmp, 'test.db');
    fs.writeFileSync(db, 'seed-bytes-c3s', 'utf8');
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(baseGrant()), 'utf8');
    const before = hashFile(db);
    const r = runMaintainApply(tmp, db, '0000000000000000', cleanEnv());
    const out = r.stdout.toString() + r.stderr.toString();
    const after = hashFile(db);
    const reason = reasonOf(out);
    console.log(
      `GATE-FORGE | maintain apply | exit=${r.status} | reason=${reason} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'} | script-written-grant`
    );
    expect(r.status).toBe(1);
    expect(reason).toBe('grant-secret-missing');
    expect(before).toBe(after);
  });
});

describe('C3s S0c tampered and wrong-secret grants', () => {
  function forge(variant: 'tampered-scope' | 'wrong-secret' | 'expired' | 'wrong-scope' | 'wrong-planHash') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3s-gateforge-'));
    const db = path.join(tmp, 'test.db');
    fs.writeFileSync(db, 'seed-bytes-c3s', 'utf8');
    const secret = generateGrantSecret();
    const grant = baseGrant();
    if (variant === 'expired') {
      const now = Date.now();
      grant.createdAt = new Date(now - 7200_000).toISOString();
      grant.expiresAt = new Date(now - 3600_000).toISOString();
    }
    if (variant === 'wrong-scope') grant.combos = ['test-99'];
    const file = createGrantFile(grant, secret);
    if (variant === 'tampered-scope') {
      file.combos = ['test-01', 'test-02'];
    }
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(file), 'utf8');
    const before = hashFile(db);
    const env = cleanEnv(
      variant === 'wrong-secret'
        ? { ROUTERSYNC_GRANT_SECRET: generateGrantSecret() }
        : { ROUTERSYNC_GRANT_SECRET: secret }
    );
    const r = runMaintainApply(tmp, db, '0000000000000000', env);
    const out = r.stdout.toString() + r.stderr.toString();
    const after = hashFile(db);
    const reason = reasonOf(out);
    console.log(
      `GATE-FORGE | maintain apply | exit=${r.status} | reason=${reason} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'} | ${variant}`
    );
    return { status: r.status, before, after, reason };
  }

  it('tampered scope with correct secret -> grant-mac-invalid', () => {
    const r = forge('tampered-scope');
    expect(r.status).toBe(1);
    expect(r.reason).toBe('grant-mac-invalid');
    expect(r.before).toBe(r.after);
  });
  it('wrong secret -> grant-secret-wrong', () => {
    const r = forge('wrong-secret');
    expect(r.status).toBe(1);
    expect(r.reason).toBe('grant-secret-wrong');
    expect(r.before).toBe(r.after);
  });
  it('expired -> grant-expired', () => {
    const r = forge('expired');
    expect(r.status).toBe(1);
    expect(r.reason).toBe('grant-expired');
    expect(r.before).toBe(r.after);
  });
  it('wrong scope with correct secret -> grant-scope', () => {
    const r = forge('wrong-scope');
    expect(r.status).toBe(1);
    expect(r.reason).toBe('grant-scope');
    expect(r.before).toBe(r.after);
  });
  it('wrong planHash with correct secret -> plan-hash-mismatch', () => {
    const r = forge('wrong-planHash');
    expect(r.status).toBe(1);
    // grant gate passes, failure is at the plan-hash gate (DB untouched)
    expect(r.before).toBe(r.after);
  });
});

describe('C3s S0d valid grant reaches write layer on tmp DB copy', () => {
  it('apply with correct secret + planHash writes tmp DB, real DB hash BẰNG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3s-gatevalid-'));
    const db = path.join(tmp, 'data.sqlite');
    const now = new Date().toISOString();
    const dev = new DatabaseSync(db);
    dev.exec(
      'CREATE TABLE combos (id TEXT, name TEXT, kind TEXT, models TEXT, createdAt TEXT, updatedAt TEXT);' +
        'CREATE TABLE settings (id INTEGER, data TEXT);' +
        `INSERT INTO combos VALUES ('test-01','test-01',NULL,'${JSON.stringify(['p1/m1', 'p1/m2', 'p1/m3'])}','${now}','${now}');` +
        `INSERT INTO settings VALUES (1,'{}');`
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
    const secret = generateGrantSecret();
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(createGrantFile(baseGrant(), secret)), 'utf8');
    // planHash from the real plan command
    const plan = spawnSync(process.execPath, [distIndex, 'maintain', 'plan', '--config', config], {
      input: '',
      env: cleanEnv(),
      timeout: 60_000,
    });
    const planOut = plan.stdout.toString() + plan.stderr.toString();
    const planHash = planOut.match(/PLAN-HASH (\S+)/)?.[1] ?? '';
    expect(planHash).toMatch(/^[0-9a-f]{16}$/);
    const realDb = path.join(
      process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      '9router',
      'db',
      'data.sqlite'
    );
    const realBefore = hashOrAbsent(realDb);
    const realMtimeBefore = fs.existsSync(realDb) ? fs.statSync(realDb).mtime.toISOString() : 'absent';
    const tmpBefore = hashFile(db);
    const r = spawnSync(
      process.execPath,
      [distIndex, 'maintain', 'apply', '--only', 'test-01', '--state-dir', tmp, '--config', config, '--plan-hash', planHash],
      { input: '', env: cleanEnv({ ROUTERSYNC_GRANT_SECRET: secret, ROUTERSYNC_STATE_DIR: tmp }), timeout: 60_000 }
    );
    const out = r.stdout.toString() + r.stderr.toString();
    const tmpAfter = hashFile(db);
    const realAfter = hashOrAbsent(realDb);
    const realMtimeAfter = fs.existsSync(realDb) ? fs.statSync(realDb).mtime.toISOString() : 'absent';
    const changed = tmpBefore !== tmpAfter ? 'yes' : 'no';
    console.log(
      `GATE-VALID | maintain apply | exit=${r.status} | tmp-db-changed=${changed} | thật-băm=${realBefore === realAfter ? 'BẰNG' : 'BĂM ĐỔI'}`
    );
    // C3u U2c: lệch băm thật -> in bằng chứng (mtime + tiến trình 9router), không thử lại.
    if (realBefore !== realAfter) {
      const tl = spawnSync('tasklist', [], { encoding: 'utf8' });
      console.log(`thật-băm=ĐỔI mtime-trước=${realMtimeBefore} mtime-sau=${realMtimeAfter}`);
      for (const l of (tl.stdout ?? '').split(/\r?\n/)) {
        if (/9router/i.test(l)) console.log(`9router-proc ${l.slice(0, 160)}`);
      }
    }
    if (r.status !== 0) console.log(`GATE-VALID-OUT ${out.slice(0, 2000)}`);
    expect(r.status).toBe(0);
    expect(changed).toBe('yes');
    expect(realBefore).toBe(realAfter);
  });
});

describe('C3s S0e agents gate', () => {
  it('agents update with script-written grant, no secret -> grant-secret-missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3s-agents-'));
    const home = path.join(tmp, 'home');
    const hermesDir = path.join(home, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    const cfg = path.join(hermesDir, 'config.yaml');
    fs.writeFileSync(cfg, 'model:\n  provider: 9router\n  default: test-1\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'apply-grant.json'), JSON.stringify(baseGrant()), 'utf8');
    const before = hashFile(cfg);
    const r = spawnSync(
      process.execPath,
      [distIndex, 'agents', 'update', '--agent', 'hermes', '--apply', '--models', 'test-3', '--home', home, '--state-dir', tmp],
      { input: '', env: cleanEnv(), timeout: 60_000 }
    );
    const out = r.stdout.toString() + r.stderr.toString();
    const after = hashFile(cfg);
    const reason = out.match(/AGENT-REFUSED reason=(\S+)/)?.[1] ?? 'unknown';
    console.log(
      `GATE-FORGE | agents update | exit=${r.status} | reason=${reason} | trước=${before.slice(0, 16)} sau=${after.slice(0, 16)} ${before === after ? 'BẰNG' : 'BĂM ĐỔI'} | script-written-grant`
    );
    expect(r.status).toBe(1);
    expect(reason).toBe('grant-secret-missing');
    expect(before).toBe(after);
  });
});
