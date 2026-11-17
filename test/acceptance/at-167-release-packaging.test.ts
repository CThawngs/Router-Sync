/**
 * test/acceptance/at-167-release-packaging.test.ts
 *
 * Acceptance test for Phase 4 Release Packaging and Final Project Completion (v0.1.0-prealpha).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('AT-167: Release Packaging & Final Completion (v0.1.0-prealpha)', () => {
  const rootDir = path.resolve(__dirname, '../..');

  it('validates CLI binary entrypoint and executable shebang', () => {
    const cliDist = path.join(rootDir, 'packages', 'cli', 'dist', 'index.js');
    expect(fs.existsSync(cliDist)).toBe(true);

    const content = fs.readFileSync(cliDist, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);

    // Execute compiled CLI --version. The value comes from the package
    // manifest, so it can never drift away from the published version.
    const cliPkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'packages', 'cli', 'package.json'), 'utf8')
    ) as { version: string };
    const output = execFileSync(process.execPath, [cliDist, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, ROUTERSYNC_NODE_CHECK: 'skip' },
    });
    expect(output.trim()).toBe(cliPkg.version);
    expect(output.trim()).toBe('0.1.0');
  });

  it('validates MCP server binary entrypoint and executable shebang', () => {
    const mcpDist = path.join(rootDir, 'packages', 'mcp-server', 'dist', 'index.js');
    expect(fs.existsSync(mcpDist)).toBe(true);

    const content = fs.readFileSync(mcpDist, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('validates production UI bundle distribution assets', () => {
    const uiDist = path.join(rootDir, 'packages', 'ui', 'dist');
    expect(fs.existsSync(uiDist)).toBe(true);

    const htmlPath = path.join(uiDist, 'index.html');
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('RouterSync');

    const assetsDir = path.join(uiDist, 'assets');
    expect(fs.existsSync(assetsDir)).toBe(true);
    const assetFiles = fs.readdirSync(assetsDir);
    expect(assetFiles.some((f) => f.endsWith('.js'))).toBe(true);
    expect(assetFiles.some((f) => f.endsWith('.css'))).toBe(true);
    expect(assetFiles.some((f) => f.endsWith('.woff2'))).toBe(true);
  });

  it('verifies uniform metadata across all workspace package.json files', () => {
    const packages = [
      'adapter-sdk',
      'adapter-9router',
      'adapter-omniroute',
      'core',
      'daemon',
      'sources',
      'ui',
      'cli',
      'mcp-server',
    ];

    for (const pkg of packages) {
      const pkgPath = path.join(rootDir, 'packages', pkg, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);

      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        name: string;
        license?: string;
        author?: string;
        engines?: { node?: string };
      };

      expect(pkgJson.license).toBe('MIT');
      expect(pkgJson.author).toBe('CThawngs');
      if (pkg !== 'ui') {
        expect(pkgJson.engines?.node).toContain('>=22.12.0');
      }
    }
  });

  it('verifies release verification script registered in root package.json', () => {
    const rootPkgPath = path.join(rootDir, 'package.json');
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(rootPkg.scripts?.['verify:release']).toBeDefined();
    expect(rootPkg.scripts?.['e2e']).toBeDefined();
    expect(rootPkg.scripts?.['test']).toBeDefined();
  });
});
