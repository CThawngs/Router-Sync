/**
 * test/acceptance/at-102.test.ts
 *
 * Acceptance Test AT-102 (Condition G0-4):
 *  - Asserts that root package.json engines.node (and all workspace packages)
 *    is strictly >= the maximum engines.node required by any runtime dependency.
 *  - In particular, commander@15.0.0 specifies engines.node >= 22.12.0, so root
 *    engines.node must be >= 22.12.0.
 *  - Verifies that Node versions < 22.12.0 are rejected cleanly with a structured error.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodeVersion } from '../../packages/cli/src/node-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

interface PkgJson {
  name: string;
  engines?: { node?: string; pnpm?: string };
  dependencies?: Record<string, string>;
}

function parseMinNodeVersion(rangeStr?: string): { major: number; minor: number; patch: number } | null {
  if (!rangeStr) return null;
  // Match >=X.Y.Z or >=X.Y or >=X
  const match = rangeStr.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: parseInt(match[1] ?? '0', 10),
    minor: parseInt(match[2] ?? '0', 10),
    patch: parseInt(match[3] ?? '0', 10),
  };
}

function compareVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number }
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

describe('Acceptance Test AT-102: Engine Node Version Enforcement (Condition G0-4)', () => {
  it('root package.json specifies engines.node >= 22.12.0', () => {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')
    ) as PkgJson;

    expect(rootPkg.engines?.node).toBeDefined();
    const rootMin = parseMinNodeVersion(rootPkg.engines?.node);
    expect(rootMin).not.toBeNull();
    expect(rootMin!.major).toBeGreaterThanOrEqual(22);
    expect(rootMin!.minor).toBeGreaterThanOrEqual(12);
  });

  it('all workspace packages specify engines.node matching or exceeding root', () => {
    const packagesDir = path.join(rootDir, 'packages');
    const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const pkgName of packageDirs) {
      const pkgPath = path.join(packagesDir, pkgName, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PkgJson;
      expect(pkg.engines?.node, `Package ${pkgName} missing engines.node`).toBe('>=22.12.0');
    }
  });

  it('root engines.node is >= the minimum required by any runtime dependency', () => {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')
    ) as PkgJson;
    const rootMin = parseMinNodeVersion(rootPkg.engines?.node)!;

    const packagesDir = path.join(rootDir, 'packages');
    const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const runtimeDeps = new Set<string>();

    for (const pkgName of packageDirs) {
      const pkgPath = path.join(packagesDir, pkgName, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PkgJson;
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        if (!dep.startsWith('@routersync/')) {
          runtimeDeps.add(dep);
        }
      }
    }

    for (const depName of runtimeDeps) {
      // Find dep's package.json in node_modules
      const candidatePaths = [
        path.join(rootDir, 'node_modules', depName, 'package.json'),
        path.join(rootDir, 'node_modules', '.pnpm', 'node_modules', depName, 'package.json'),
      ];
      let depPkg: PkgJson | null = null;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          depPkg = JSON.parse(fs.readFileSync(p, 'utf-8')) as PkgJson;
          break;
        }
      }

      if (depPkg?.engines?.node) {
        const depMin = parseMinNodeVersion(depPkg.engines.node);
        if (depMin) {
          const comp = compareVersions(rootMin, depMin);
          expect(
            comp >= 0,
            `Root engines (${rootPkg.engines?.node}) is lower than ${depName} engines (${depPkg.engines.node})`
          ).toBe(true);
        }
      }
    }
  });

  it('checkNodeVersion rejects versions below 22.12.0 and accepts >= 22.12.0', () => {
    expect(checkNodeVersion('v20.18.0').ok).toBe(false);
    expect(checkNodeVersion('v21.5.0').ok).toBe(false);
    expect(checkNodeVersion('v22.0.0').ok).toBe(false);
    expect(checkNodeVersion('v22.11.0').ok).toBe(false);
    expect(checkNodeVersion('v22.12.0').ok).toBe(true);
    expect(checkNodeVersion('v22.14.0').ok).toBe(true);
    expect(checkNodeVersion('v24.18.0').ok).toBe(true);
  });
});
