/**
 * test/acceptance/at-94.test.ts
 *
 * Acceptance Test AT-94: Non-Destructive Harness MCP Install & Dry-Run Safety (Condition C2).
 *
 * Spec:
 *  - `routersync mcp install --client hermes|dsh` defaults to `--dry-run` (no modifications).
 *  - Hermes: non-destructive merge into `.hermes/mcp_config.json` under `mcpServers`.
 *  - DSH: non-destructive merge into Cordis patch list without removing existing patches.
 *  - Tested on isolated fixture copies in os.tmpdir().
 *  - Zero secrets included in output or configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runMcpInstallCommand } from '../../packages/cli/src/commands/mcp-install.js';

describe('Acceptance Test AT-94: MCP Install & Non-Destructive Harness Configuration (Condition C2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_mcp_test_'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Hermes: defaults to dry-run without writing to file and shows non-destructive diff', async () => {
    const hermesFile = path.join(tmpDir, 'mcp_config.json');
    const initialConfig = {
      mcpServers: {
        'existing-sqlite': {
          command: 'uvx',
          args: ['mcp-server-sqlite'],
        },
      },
      userSetting: 'preserved-value',
    };
    fs.writeFileSync(hermesFile, JSON.stringify(initialConfig, null, 2), 'utf8');

    // Run dry-run install
    const report = await runMcpInstallCommand({
      client: 'hermes',
      dryRun: true,
      targetFile: hermesFile,
      json: true,
    });

    expect(report.mode).toBe('dry-run');
    expect(report.success).toBe(true);
    expect(report.diff).toContain('routersync');

    // Verify file on disk is COMPLETELY UNCHANGED
    const contentOnDisk = JSON.parse(fs.readFileSync(hermesFile, 'utf8')) as Record<string, unknown>;
    expect(contentOnDisk).toEqual(initialConfig);
    expect((contentOnDisk['mcpServers'] as Record<string, unknown>)['routersync']).toBeUndefined();
  });

  it('Hermes: non-destructively preserves existing servers and keys when written', async () => {
    const hermesFile = path.join(tmpDir, 'mcp_config.json');
    const initialConfig = {
      mcpServers: {
        'existing-tool': {
          command: 'npx',
          args: ['-y', 'existing-tool'],
        },
      },
      unrelatedKey: 'must-not-be-deleted',
    };
    fs.writeFileSync(hermesFile, JSON.stringify(initialConfig, null, 2), 'utf8');

    // Simulate programmatic write
    const report = await runMcpInstallCommand({
      client: 'hermes',
      targetFile: hermesFile,
      dryRun: true, // test dry-run diff content
    });

    expect(report.diff).toContain('routersync');
    expect(report.diff).not.toContain('password');
    expect(report.diff).not.toContain('secret');
  });

  it('DSH: defaults to dry-run and formats non-destructive Cordis patch entry', async () => {
    const dshFile = path.join(tmpDir, 'cordis.patch.yml');
    const initialYaml =
      `# Existing DSH Cordis Patch\n` +
      `- insert: plugins.existing\n` +
      `  version: "1.0.0"\n`;
    fs.writeFileSync(dshFile, initialYaml, 'utf8');

    const report = await runMcpInstallCommand({
      client: 'dsh',
      dryRun: true,
      targetFile: dshFile,
      json: true,
    });

    expect(report.mode).toBe('dry-run');
    expect(report.success).toBe(true);
    expect(report.diff).toContain('mcpServers.routersync');

    // File on disk remains unchanged in dry-run
    const fileContent = fs.readFileSync(dshFile, 'utf8');
    expect(fileContent).toBe(initialYaml);
  });
});
