/**
 * packages/cli/test/doctor-json.test.ts
 *
 * Tests K8.3: `routersync doctor --json` emits a machine-readable report.
 * Captures console.log output, parses JSON, and asserts the required fields
 * are present. On an empty machine (no config, no router DBs) the report must
 * still be valid JSON with ok:false and a non-empty nextSteps list, never
 * throwing an unhandled error.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { openBetterSqlite3 } from '@routersync/core';

async function captureJsonReport(opts: { json?: boolean; configPath?: string }): Promise<any> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await runDoctorCommand({ json: true, configPath: opts.configPath });
  } finally {
    console.log = origLog;
  }
  const jsonStr = logs.join('\n');
  return JSON.parse(jsonStr);
}

/** Captures the TEXT (non-JSON) doctor output. */
async function captureTextReport(opts: { configPath?: string }): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  try {
    await runDoctorCommand({ json: false, configPath: opts.configPath });
  } finally {
    console.log = origLog;
  }
  return logs.join('\n');
}

describe('K8.3: routersync doctor --json', async () => {
  const REQUIRED_TOP_FIELDS = [
    'ok', 'ready', 'os', 'arch', 'node', 'pnpm', 'build',
    'stateDir', 'tickStateDir', 'syncStateDir', 'configPath', 'rankingPolicy', 'routers',
    'apps', 'schedule', 'nextSteps', 'circularWarnings',
    'validationWarnings', 'authKeys', 'recommendations', 'timestamp',
  ];

  const REQUIRED_RANKING_POLICY_FIELDS = ['present', 'path'];
  const REQUIRED_ROUTER_FIELDS = ['routerId', 'adapter', 'dbPath', 'found', 'readable'];
  const REQUIRED_APP_FIELDS = ['name', 'configPath', 'detected'];
  const REQUIRED_SCHEDULE_FIELDS = ['installed', 'detail'];

  it('emits valid JSON with all required top-level fields', async () => {
    const report = await captureJsonReport({});
    for (const field of REQUIRED_TOP_FIELDS) {
      expect(report).toHaveProperty(field);
    }
    expect(typeof report.ok).toBe('boolean');
    expect(typeof report.ready).toBe('boolean');
    expect(typeof report.os).toBe('string');
    expect(typeof report.arch).toBe('string');
    expect(typeof report.node).toBe('string');
    expect(Array.isArray(report.routers)).toBe(true);
    expect(Array.isArray(report.apps)).toBe(true);
    expect(Array.isArray(report.nextSteps)).toBe(true);
    expect(Array.isArray(report.circularWarnings)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(typeof report.timestamp).toBe('string');
  });

  it('rankingPolicy has present and path fields', async () => {
    const report = await captureJsonReport({});
    expect(typeof report.rankingPolicy.present).toBe('boolean');
    expect(typeof report.rankingPolicy.path).toBe('string');
  });

  it('every router entry has the required fields', async () => {
    const report = await captureJsonReport({});
    for (const router of report.routers) {
      for (const field of REQUIRED_ROUTER_FIELDS) {
        expect(router).toHaveProperty(field);
      }
      expect(typeof router.found).toBe('boolean');
      expect(typeof router.readable).toBe('boolean');
      expect(router.dbPath === null || typeof router.dbPath === 'string').toBe(true);
    }
  });

  it('every app entry has the required fields', async () => {
    const report = await captureJsonReport({});
    for (const app of report.apps) {
      for (const field of REQUIRED_APP_FIELDS) {
        expect(app).toHaveProperty(field);
      }
      expect(typeof app.detected).toBe('boolean');
      expect(app.configPath === null || typeof app.configPath === 'string').toBe(true);
    }
  });

  it('schedule has installed and detail fields', async () => {
    const report = await captureJsonReport({});
    expect(typeof report.schedule.installed).toBe('boolean');
    expect(typeof report.schedule.detail).toBe('string');
  });

  it('honors options.configPath in doctor report', async () => {
    const customConfig = path.resolve('/custom/path/to/config.yaml');
    const report = await captureJsonReport({ configPath: customConfig });
    expect(report.configPath).toBe(customConfig);
  });

  it('labels tier A as combo members and reports available models', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-doctor-basis-'));
    const dbPath = path.join(tmp, 'nine.sqlite');
    const db = openBetterSqlite3(dbPath, {});
    db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, models TEXT)');
    db.exec(`INSERT INTO combos (id, name, models) VALUES ('c1', 'Coder', '["gemini/gemini-3.8-flash"]')`);
    db.close();
    const configPath = path.join(tmp, 'config.yaml');
    fs.writeFileSync(configPath, [
      'version: 1',
      'routers:',
      '  - id: nine',
      '    adapter: 9router',
      '    baseUrl: http://localhost:30128',
      'policy:',
      '  mode: manual',
      '',
    ].join('\n'), 'utf8');
    const previousConfig = process.env['ROUTERSYNC_CONFIG'];
    const previousDb = process.env['ROUTERSYNC_9ROUTER_DB'];
    process.env['ROUTERSYNC_CONFIG'] = configPath;
    process.env['ROUTERSYNC_9ROUTER_DB'] = dbPath;
    try {
      const report = await captureJsonReport({});
      const nine = report.routers.find((r: any) => r.adapter === '9router');
      expect(nine).toBeDefined();
      expect(nine.basis).toBe('combo-members');
      expect(nine.tiers.A).toBe(1);
      expect(typeof nine.available).toBe('number');
      const text = await captureTextReport({});
      expect(text).toContain('A (models referenced by combos)=1');
      expect(text).toContain('basis=combo-members');
      expect(text).toContain('available in router');
    } finally {
      if (previousConfig === undefined) delete process.env['ROUTERSYNC_CONFIG'];
      else process.env['ROUTERSYNC_CONFIG'] = previousConfig;
      if (previousDb === undefined) delete process.env['ROUTERSYNC_9ROUTER_DB'];
      else process.env['ROUTERSYNC_9ROUTER_DB'] = previousDb;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads sync-last.json from ROUTERSYNC_SYNC_STATE_DIR override', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sync-state-test-'));
    const dummySyncLast = path.join(tmpDir, 'sync-last.json');
    const dummyBackup9 = path.join(tmpDir, '9router.bak');
    const dummyBackupOmni = path.join(tmpDir, 'omniroute.bak');
    fs.writeFileSync(dummyBackup9, 'dummy9', 'utf8');
    fs.writeFileSync(dummyBackupOmni, 'dummyOmni', 'utf8');
    fs.writeFileSync(dummySyncLast, JSON.stringify({
      at: '2026-11-14T12:00:00.000Z',
      routers: {
        '9router': { backup: dummyBackup9, changed: [] },
        'omniroute': { backup: dummyBackupOmni, changed: [] },
      },
    }), 'utf8');

    const origEnv = process.env['ROUTERSYNC_SYNC_STATE_DIR'];
    process.env['ROUTERSYNC_SYNC_STATE_DIR'] = tmpDir;
    try {
      const report = await captureJsonReport({});
      expect(report.syncStateDir).toBe(tmpDir);
      const hasBackupMention = report.recommendations.some((r: string) =>
        r.includes('Đã có bằng chứng sao lưu gần nhất')
      );
      expect(hasBackupMention).toBe(true);
      const inValidationWarnings = report.validationWarnings.some((w: any) =>
        w.message?.includes('Đã có bằng chứng sao lưu gần nhất')
      );
      expect(inValidationWarnings).toBe(false);
    } finally {
      if (origEnv !== undefined) {
        process.env['ROUTERSYNC_SYNC_STATE_DIR'] = origEnv;
      } else {
        delete process.env['ROUTERSYNC_SYNC_STATE_DIR'];
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('on an empty machine, ready is false and nextSteps is non-empty', async () => {
    // Point at a config path that does not exist to force a clean, empty state.
    const report = await captureJsonReport({ configPath: '/nonexistent/config.yaml' });
    expect(report.ready).toBe(false);
    expect(Array.isArray(report.nextSteps)).toBe(true);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    for (const step of report.nextSteps) {
      expect(typeof step).toBe('string');
      expect(step.length).toBeGreaterThan(0);
    }
  });

  it('does not print any secret or personal path in report object and JSON', async () => {
    const report = await captureJsonReport({});
    // Check report object directly:
    for (const key of report.authKeys) {
      expect(key).not.toHaveProperty('value');
      expect(key).not.toHaveProperty('secret');
      if (key.keyName) {
        expect(key.keyName).not.toMatch(/^sk-[A-Za-z0-9_\-]{20,}/);
        expect(key.keyName).not.toMatch(/^ghp_[A-Za-z0-9]{20,}/);
      }
    }
    for (const step of report.nextSteps) {
      expect(step).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(step).not.toMatch(/sk-[A-Za-z0-9_\-]{20,}/);
    }
    for (const rec of report.recommendations) {
      expect(rec).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(rec).not.toMatch(/sk-[A-Za-z0-9_\-]{20,}/);
    }
    const jsonStr = JSON.stringify(report);
    expect(jsonStr).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(jsonStr).not.toMatch(/sk-[A-Za-z0-9_\-]{20,}/);
    expect(jsonStr).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});

/**
 * C4n/N1: the text mode of `routersync doctor` must print the
 * "Khuyến nghị" section whenever there is a recommendation, even when there
 * is no circular warning and no validation warning. Before the fix the
 * section lived inside the else-branch, so a machine with no warnings never
 * saw the combo-timeout hints or the backup-evidence notices.
 */
describe('C4n/N1: doctor text mode prints the recommendations section', async () => {
  it('prints "Khuyến nghị" with the recommendation lines', async () => {
    const text = await captureTextReport({ configPath: '/nonexistent/config.yaml' });
    expect(text).toContain('Khuyến nghị');
    // The section must not be empty: it lists the recommendation lines.
    const section = text.slice(text.indexOf('Khuyến nghị'));
    expect(section).toMatch(/\n {2}\* \S/);
  });

  it('the text output and the JSON output carry the same recommendations', async () => {
    const text = await captureTextReport({ configPath: '/nonexistent/config.yaml' });
    const report = await captureJsonReport({ configPath: '/nonexistent/config.yaml' });
    for (const rec of report.recommendations as string[]) {
      expect(text).toContain(rec);
    }
  });
});
