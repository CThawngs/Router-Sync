/**
 * test/acceptance/at-168-package-hygiene.test.ts
 *
 * Acceptance test for AT-168: Package Distribution Hygiene & Clean Tarball Boundaries (SPEC §31).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('AT-168: Package Distribution Hygiene & Tarball Boundaries', () => {
  const rootDir = path.resolve(__dirname, '../..');
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

  it('declares explicit files whitelist containing dist for every workspace package', () => {
    for (const pkg of packages) {
      const pkgJsonPath = path.join(rootDir, 'packages', pkg, 'package.json');
      expect(fs.existsSync(pkgJsonPath)).toBe(true);

      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        name: string;
        files?: string[];
      };

      expect(Array.isArray(pkgJson.files)).toBe(true);
      expect(pkgJson.files).toContain('dist');
      expect(pkgJson.files).not.toContain('test');
      expect(pkgJson.files).not.toContain('src');
    }
  });

  it('ensures compiled dist directories exist for all packages', () => {
    for (const pkg of packages) {
      const distPath = path.join(rootDir, 'packages', pkg, 'dist');
      expect(fs.existsSync(distPath)).toBe(true);
    }
  });

  it('verifies main and types entrypoints resolve to dist directory', () => {
    const libraryPackages = [
      'adapter-sdk',
      'adapter-9router',
      'adapter-omniroute',
      'core',
      'daemon',
      'sources',
      'cli',
      'mcp-server',
    ];

    for (const pkg of libraryPackages) {
      const pkgJsonPath = path.join(rootDir, 'packages', pkg, 'package.json');
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        main?: string;
        types?: string;
      };

      expect(pkgJson.main).toBeDefined();
      expect(pkgJson.main?.startsWith('./dist/')).toBe(true);

      expect(pkgJson.types).toBeDefined();
      expect(pkgJson.types?.startsWith('./dist/')).toBe(true);
    }
  });
});
