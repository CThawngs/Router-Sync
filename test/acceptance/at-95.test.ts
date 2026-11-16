/**
 * test/acceptance/at-95.test.ts
 *
 * Acceptance Test AT-95: Doctor Circular Dependency Detection (Condition C4).
 *
 * Spec:
 *  - When agent harness (Hermes, DSH) points to a router managed by RouterSync,
 *    `routersync doctor` emits a circular dependency warning.
 *  - Verifies that rollback remains executable via CLI independently without AI assistance.
 *  - When harness points to direct external provider, `doctor` returns ok: true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runDoctorCommand } from '../../packages/cli/src/commands/doctor.js';

describe('Acceptance Test AT-95: Doctor Circular Dependency Check (Condition C4)', () => {
  let tmpDir: string;
  let tmpConfigPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_doctor_test_'));
    tmpConfigPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      tmpConfigPath,
      'version: 1\nrouters:\n  - id: omni\n    adapter: omniroute\n  - id: nine\n    adapter: 9router\n',
      'utf8'
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects circular dependency when Hermes config points to managed OmniRoute port (30128)', async () => {
    const hermesFile = path.join(tmpDir, 'hermes_config.json');
    fs.writeFileSync(
      hermesFile,
      JSON.stringify({
        model: 'openai/gpt-4o',
        baseUrl: 'http://localhost:30128/v1',
      }, null, 2),
      'utf8'
    );

    const report = await runDoctorCommand({
      configPath: tmpConfigPath,
      hermesConfigPath: hermesFile,
      json: true,
    });

    expect(report.ok).toBe(false);
    expect(report.circularWarnings).toHaveLength(1);
    expect(report.circularWarnings[0]?.harness).toBe('hermes');
    expect(report.circularWarnings[0]?.message.toLowerCase()).toContain('circular dependency');
    expect(report.recommendations.some((r) => r.includes('rollback'))).toBe(true);
  });

  it('detects circular dependency when DSH config points to managed 9Router port (20128)', async () => {
    const dshFile = path.join(tmpDir, 'dsh_config.yml');
    fs.writeFileSync(
      dshFile,
      `upstream:\n  provider: local-9router\n  endpoint: "http://127.0.0.1:20128"\n`,
      'utf8'
    );

    const report = await runDoctorCommand({
      configPath: tmpConfigPath,
      dshConfigPath: dshFile,
      json: true,
    });

    expect(report.ok).toBe(false);
    expect(report.circularWarnings.some((w) => w.harness === 'dsh')).toBe(true);
  });

  it('returns ok: true when harness configs point to direct external providers', async () => {
    const hermesFile = path.join(tmpDir, 'clean_hermes.json');
    fs.writeFileSync(
      hermesFile,
      JSON.stringify({
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
      }),
      'utf8'
    );

    const report = await runDoctorCommand({
      configPath: tmpConfigPath,
      hermesConfigPath: hermesFile,
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.circularWarnings).toHaveLength(0);
  });
});
