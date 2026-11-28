/**
 * packages/cli/src/registry/bundled.ts
 *
 * C52-R1: runtime registry discovery for installed packages.
 *
 * Search order (highest priority first):
 *   1. caller-supplied cwd tree
 *   2. module directory tree (checkout / ts source)
 *   3. registry bundled next to the compiled module (published package)
 *
 * Z1 invariant: a local override (providers.local.yaml) is NEVER resolved from
 * cwd or the module tree. This module only locates the PUBLIC registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_REGISTRY_FILES = Object.freeze([
  'providers.yaml',
  'gateways.yaml',
  'sources.yaml',
  'aliases.yaml',
  'catalog-trust.yaml',
  'models.yaml',
  'dead-models.yaml',
] as const);

export type BundledRegistryFileName = (typeof BUNDLED_REGISTRY_FILES)[number];

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MODULE_DIR = MODULE_DIR;

function walkUpForFile(startDir: string, fileName: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, 'registry', fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate a registry file shipped beside a compiled module. Both the
 * `dist/registry` layout (published package) and a `registry` directory
 * directly under the module directory are accepted.
 */
export function findBundledRegistryFile(
  moduleDir: string,
  fileName: string
): string | null {
  const candidates = [
    path.resolve(moduleDir, '..', 'registry', fileName),
    path.resolve(moduleDir, 'registry', fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the public providers table across cwd, module tree and bundled copy.
 */
export function findPublicRegistryFile(
  cwd: string = process.cwd(),
  moduleDir: string = MODULE_DIR
): string | null {
  return (
    walkUpForFile(cwd, 'providers.yaml') ??
    walkUpForFile(moduleDir, 'providers.yaml') ??
    findBundledRegistryFile(moduleDir, 'providers.yaml')
  );
}

/** True only when no public registry file can be found anywhere. */
export function isPublicRegistryMissing(
  cwd: string = process.cwd(),
  moduleDir: string = MODULE_DIR
): boolean {
  return findPublicRegistryFile(cwd, moduleDir) === null;
}
