import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWatchdogExempt, WATCHDOG_MS } from '../src/watchdog.js';
import { runVerifyCommand } from '../src/commands/verify.js';
import { runRankCommand } from '../src/commands/rank.js';
import { openBetterSqlite3 } from '@routersync/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');
const watchdogUrl = pathToFileURL(path.resolve(here, '../dist/watchdog.js')).href;

describe('C14 (a): watchdog', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c14-wd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exempts daemon only', () => {
    expect(isWatchdogExempt(['node', 'cli', 'daemon'])).toBe(true);
    expect(isWatchdogExempt(['node', 'cli', 'doctor'])).toBe(false);
    expect(isWatchdogExempt(['node', 'cli'])).toBe(false);
  });

  it('default watchdog is 120 s', () => {
    expect(WATCHDOG_MS).toBe(120_000);
  });

  it('exits 124 when a non-exempt command exceeds the deadline', () => {
    const f = path.join(tmp, 'wd.mjs');
    fs.writeFileSync(f, [
      `import { installWatchdog } from ${JSON.stringify(watchdogUrl)};`,
      `installWatchdog(['node','x','doctor'], 60);`,
      `setTimeout(() => {}, 500);`,
    ].join('\n'));
    const res = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 });
    expect(res.status).toBe(124);
    expect(res.stderr).toContain('watchdog: timeout, exit 124');
  });

  it('does not fire for daemon even past the deadline', () => {
    const f = path.join(tmp, 'wd.mjs');
    fs.writeFileSync(f, [
      `import { installWatchdog } from ${JSON.stringify(watchdogUrl)};`,
      `installWatchdog(['node','x','daemon'], 60);`,
      `setTimeout(() => { process.stdout.write('ok'); }, 200);`,
    ].join('\n'));
    const res = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ok');
  });
});

describe('C14 (e): doctor reports low-resource state', () => {
  it('shows forced-on mode and manual reason', () => {
    const res = spawnSync(process.execPath, [cliEntry, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_LOW_RESOURCE: '1' },
      timeout: 20000,
    });
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.lowResource).toBe(true);
    expect(report.lowResourceReason).toContain('manual');
  });

  it('shows forced-off mode with null reason', () => {
    const res = spawnSync(process.execPath, [cliEntry, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_LOW_RESOURCE: '0' },
      timeout: 20000,
    });
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.lowResource).toBe(false);
    expect(report.lowResourceReason).toBeNull();
  });
});

describe('C14 (f): verify --json compact / --full / --out', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c14-verify-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('compact JSON omits records and stays <= 100 KB', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      await runVerifyCommand({ mock3Layer: true, json: true });
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('modelsVerified');
      expect(parsed).toHaveProperty('incomplete');
      expect(parsed).not.toHaveProperty('records');
      expect(Buffer.byteLength(jsonLine!, 'utf8')).toBeLessThanOrEqual(100 * 1024);
    } finally { spy.mockRestore(); }
  });

  it('full JSON includes records', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    try {
      await runVerifyCommand({ mock3Layer: true, json: true, full: true });
      const jsonLine = logs.find((l) => l.trim().startsWith('{'));
      const parsed = JSON.parse(jsonLine!);
      expect(parsed).toHaveProperty('records');
      expect(Array.isArray(parsed.records)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('--out writes the JSON to a file', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = path.join(tmp, 'verify.json');
    try {
      await runVerifyCommand({ mock3Layer: true, json: true, out });
      expect(fs.existsSync(out)).toBe(true);
      expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toHaveProperty('modelsVerified');
    } finally { spy.mockRestore(); }
  });
});

describe('C14 (f): rank --out', () => {
  let tmp: string;
  const origEnv = { ...process.env };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c14-rank-'));
    const db9 = path.join(tmp, '9.sqlite');
    const dbO = path.join(tmp, 'o.sqlite');
    const a = openBetterSqlite3(db9, { restrictToDir: tmp });
    a.exec("CREATE TABLE combos (id TEXT, name TEXT, models TEXT); INSERT INTO combos VALUES ('c','x','[\"p/m1\",\"p/m2\"]');");
    a.close();
    const b = openBetterSqlite3(dbO, { restrictToDir: tmp });
    b.exec("CREATE TABLE combos (id TEXT, name TEXT, data TEXT); INSERT INTO combos VALUES ('c','y','{\"models\":[\"p/m1\",\"p/m2\"]}');");
    b.close();
    process.env['ROUTERSYNC_9ROUTER_DB'] = db9;
    process.env['ROUTERSYNC_OMNIROUTE_DB'] = dbO;
  });
  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes compact JSON to --out', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = path.join(tmp, 'rank.json');
    try {
      await runRankCommand({ json: true, out });
      expect(fs.existsSync(out)).toBe(true);
      expect(Array.isArray(JSON.parse(fs.readFileSync(out, 'utf8')))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
