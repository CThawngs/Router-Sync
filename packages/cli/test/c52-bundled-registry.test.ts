/**
 * C52-R1 (Red-First): the published @routersync/cli tarball must carry the
 * runtime registry, loaders must find it from a far cwd, and the bundled copy
 * must be byte-identical to the repository registry.
 *
 * All identifiers used here are synthetic; no real provider, model, router,
 * username or path from the project host appears in this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_REGISTRY_FILES,
  auditTarballEntries,
  verifyBundledRegistrySet,
} from '../../../tools/agent/pack-verify.mjs';
import {
  findBundledRegistryFile,
  isPublicRegistryMissing,
} from '../src/registry/bundled.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DIST_REGISTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'registry');

describe('C52-R1: bundled runtime registry', () => {
  it('declares the exact seven runtime registry files', () => {
    expect([...BUNDLED_REGISTRY_FILES].sort()).toEqual(
      [
        'aliases.yaml',
        'catalog-trust.yaml',
        'dead-models.yaml',
        'gateways.yaml',
        'models.yaml',
        'providers.yaml',
        'sources.yaml',
      ].sort()
    );
  });

  it('accepts a CLI tarball that carries every bundled registry file', () => {
    const entries = [
      'package/package.json',
      'package/dist/index.js',
      ...BUNDLED_REGISTRY_FILES.map((name) => `package/dist/registry/${name}`),
    ];
    const res = auditTarballEntries('@routersync/cli', entries);
    expect(res.ok, JSON.stringify(res.violations)).toBe(true);
  });

  it('mutation: dropping the copy step (missing bundled entry) is rejected', () => {
    const entries = [
      'package/package.json',
      'package/dist/index.js',
      ...BUNDLED_REGISTRY_FILES.slice(1).map((name) => `package/dist/registry/${name}`),
    ];
    const res = auditTarballEntries('@routersync/cli', entries);
    expect(res.ok).toBe(false);
    expect(res.violations.join('\n')).toMatch(/registry/);
  });

  it('mutation: an unrelated yaml still stays outside the allowlist', () => {
    const entries = [
      'package/package.json',
      'package/dist/index.js',
      'package/dist/registry/mystery.yaml',
    ];
    expect(auditTarballEntries('@routersync/cli', entries).ok).toBe(false);
  });

  it('bundled copy is byte-identical to the repository registry', () => {
    const res = verifyBundledRegistrySet(REPO_ROOT, DIST_REGISTRY);
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it('mutation: a missing bundled file is reported with its name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c52-mut-missing-'));
    try {
      for (const name of BUNDLED_REGISTRY_FILES) {
        fs.writeFileSync(path.join(tmp, name), `name: ${name}\n`, 'utf8');
      }
      fs.rmSync(path.join(tmp, 'sources.yaml'));
      const res = verifyBundledRegistrySet(REPO_ROOT, tmp);
      expect(res.ok).toBe(false);
      expect(res.missing).toContain('sources.yaml');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('mutation: a drifted bundled file is reported with its name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c52-mut-drift-'));
    try {
      for (const name of BUNDLED_REGISTRY_FILES) {
        const source = fs.readFileSync(path.join(REPO_ROOT, 'registry', name));
        fs.writeFileSync(path.join(tmp, name), source);
      }
      fs.writeFileSync(path.join(tmp, 'providers.yaml'), 'providers: {}\nalias: {}\n', 'utf8');
      const res = verifyBundledRegistrySet(REPO_ROOT, tmp);
      expect(res.ok).toBe(false);
      expect(res.mismatched).toContain('providers.yaml');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves a bundled registry file from a module-shaped dist directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c52-mod-'));
    try {
      const moduleDir = path.join(tmp, 'dist', 'sync');
      const bundledDir = path.join(tmp, 'dist', 'registry');
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.mkdirSync(bundledDir, { recursive: true });
      fs.writeFileSync(path.join(bundledDir, 'providers.yaml'), 'providers: {}\n', 'utf8');
      expect(findBundledRegistryFile(moduleDir, 'providers.yaml')).toBe(
        path.join(bundledDir, 'providers.yaml')
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports REGISTRY_MISSING instead of falling back to an empty table', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c52-empty-'));
    try {
      const moduleDir = path.join(tmp, 'dist', 'verify');
      expect(isPublicRegistryMissing(tmp, moduleDir)).toBe(true);
      fs.mkdirSync(path.join(tmp, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'registry', 'providers.yaml'), 'providers: {}\n', 'utf8');
      expect(isPublicRegistryMissing(tmp, moduleDir)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
