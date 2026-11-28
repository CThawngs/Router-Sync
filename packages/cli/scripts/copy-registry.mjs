#!/usr/bin/env node
/**
 * packages/cli/scripts/copy-registry.mjs
 *
 * C52-R1: copy the runtime registry YAML files into dist/registry so the
 * published @routersync/cli tarball is self-contained. Fails loudly when any
 * source file is missing; never emits an empty registry silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const DEST_DIR = path.join(PACKAGE_DIR, 'dist', 'registry');

const RUNTIME_REGISTRY_FILES = Object.freeze([
  'providers.yaml',
  'gateways.yaml',
  'sources.yaml',
  'aliases.yaml',
  'catalog-trust.yaml',
  'models.yaml',
  'dead-models.yaml',
]);

function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  for (const name of RUNTIME_REGISTRY_FILES) {
    const source = path.join(REPO_ROOT, 'registry', name);
    if (!fs.existsSync(source)) {
      console.error(`[copy-registry] missing source registry file: ${name}`);
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(source, path.join(DEST_DIR, name));
  }
  console.log(`[copy-registry] bundled ${RUNTIME_REGISTRY_FILES.length} runtime registry files`);
}

main();
