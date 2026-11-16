/**
 * test/acceptance/at-169-cli-e2e-matrix.test.ts
 *
 * Acceptance test for AT-169: CLI Subprocess Execution Matrix & Command Contract (SPEC §31).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('AT-169: CLI Subprocess Execution Matrix', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const cliEntry = path.join(rootDir, 'packages', 'cli', 'dist', 'index.js');
  const commonEnv = {
    ...process.env,
    ROUTERSYNC_NODE_CHECK: 'skip',
  };

  it('executes root CLI --help successfully with zero exit code', () => {
    const output = execFileSync(process.execPath, [cliEntry, '--help'], {
      encoding: 'utf8',
      env: commonEnv,
    });

    expect(output).toContain('Usage: routersync');
    expect(output).toContain('Keeps model lists and combos in sync');
  });

  it('executes root CLI --version successfully', () => {
    const output = execFileSync(process.execPath, [cliEntry, '--version'], {
      encoding: 'utf8',
      env: commonEnv,
    });

    // The version comes from the package manifest, never from a literal.
    const cliPkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'packages', 'cli', 'package.json'), 'utf8')
    ) as { version: string };
    expect(output.trim()).toBe(cliPkg.version);
  });

  const commands = [
    { name: 'init', keyword: 'Initialize' },
    { name: 'scan', keyword: 'Scan' },
    { name: 'plan', keyword: 'Compute deterministic combo changes' },
    { name: 'apply', keyword: 'Apply calculated plan' },
    { name: 'rollback', keyword: 'Rollback router state' },
    { name: 'status', keyword: 'Display status' },
    { name: 'doctor', keyword: 'Diagnose harness configuration' },
    { name: 'mcp', keyword: 'Manage MCP server integrations' },
    { name: 'daemon', keyword: 'Run the RouterSync local daemon' },
  ];

  for (const cmd of commands) {
    it(`executes "routersync ${cmd.name} --help" cleanly`, () => {
      const output = execFileSync(process.execPath, [cliEntry, cmd.name, '--help'], {
        encoding: 'utf8',
        env: commonEnv,
      });

      expect(output).toContain(cmd.keyword);
    });
  }
});
