import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISHABLE_PACKAGES,
  auditTarballEntries,
  buildPublishDryRunArgs,
  checkRegistryPackages,
  packAndAuditWorkspacePackages,
} from '../../tools/agent/pack-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

describe('M3-01 (P4): pack-verify allowlist, dry-run guard, registry check, and real pack audit', () => {
  test('declares all 8 publishable @routersync/* packages and excludes private ui', () => {
    assert.equal(PUBLISHABLE_PACKAGES.length, 8);
    assert.ok(PUBLISHABLE_PACKAGES.includes('@routersync/adapter-sdk'));
    assert.ok(PUBLISHABLE_PACKAGES.includes('@routersync/cli'));
    assert.ok(PUBLISHABLE_PACKAGES.includes('@routersync/mcp-server'));
    assert.ok(!PUBLISHABLE_PACKAGES.includes('@routersync/ui'));
  });

  test('auditTarballEntries accepts valid package manifest, docs, and compiled dist artifacts', () => {
    const valid = auditTarballEntries('@routersync/adapter-sdk', [
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/sub/module.mjs',
      'package/dist/sub/module.cjs',
      'package/dist/sub/schema.json',
    ]);
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.violations, []);
  });

  test('auditTarballEntries rejects .map, evidence/, .agent/, .env, src/, test/, yaml configs, and sqlite files', () => {
    const forbiddenCases = [
      'package/dist/index.js.map',
      'package/dist/index.d.ts.map',
      'evidence/foo.txt',
      'package/evidence/foo.txt',
      '.agent/state.json',
      'package/.agent/state.json',
      '.env',
      'package/.env',
      'package/.env.local',
      'package/settings.local.json',
      'src/index.ts',
      'package/src/index.ts',
      'package/test/foo.test.ts',
      'config.yaml',
      'package/config.yaml',
      'package/routersync.yml',
      'package/ranking.yaml',
      'package/dist/data.sqlite',
    ];

    for (const badEntry of forbiddenCases) {
      const res = auditTarballEntries('@routersync/adapter-sdk', [
        'package/package.json',
        'package/dist/index.js',
        badEntry,
      ]);
      assert.equal(
        res.ok,
        false,
        `Expected auditTarballEntries to reject forbidden entry: ${badEntry}`
      );
      assert.ok(res.violations.length >= 1);
    }

    const missingManifest = auditTarballEntries('@routersync/adapter-sdk', [
      'package/dist/index.js',
    ]);
    assert.equal(missingManifest.ok, false);
  });

  test('buildPublishDryRunArgs always enforces --dry-run and rejects dry-run negation', () => {
    const defaultArgs = buildPublishDryRunArgs();
    assert.equal(defaultArgs[0], 'publish');
    assert.ok(defaultArgs.includes('--dry-run'));

    const withJson = buildPublishDryRunArgs(['--json']);
    assert.deepEqual(withJson, ['publish', '--dry-run', '--json']);

    assert.throws(
      () => buildPublishDryRunArgs(['--no-dry-run']),
      /--dry-run/i
    );
    assert.throws(
      () => buildPublishDryRunArgs(['--dry-run=false']),
      /--dry-run/i
    );
  });

  test('checkRegistryPackages classifies E404 as unoccupied and published version as occupied via mock runner', () => {
    const mockRunner = (pkgName) => {
      if (pkgName === '@routersync/adapter-sdk') {
        return {
          status: 1,
          stdout: '',
          stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@routersync%2fadapter-sdk',
        };
      }
      return {
        status: 0,
        stdout: '"0.1.0"\n',
        stderr: '',
      };
    };

    const results = checkRegistryPackages(
      ['@routersync/adapter-sdk', '@routersync/cli'],
      mockRunner
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].name, '@routersync/adapter-sdk');
    assert.equal(results[0].status, 'unoccupied');
    assert.equal(results[0].publishedVersion, null);

    assert.equal(results[1].name, '@routersync/cli');
    assert.equal(results[1].status, 'occupied');
    assert.equal(results[1].publishedVersion, '0.1.0');
  });

  test('real npm pack across all 8 publishable workspace packages ships 0 .map files and passes allowlist + secret/path guards', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'rs-pack-verify-test-'));
    try {
      const report = packAndAuditWorkspacePackages({
        repoRoot: REPO_ROOT,
        workDir,
      });
      assert.equal(report.packages.length, 8);
      assert.ok(report.totalTarballBytes > 0);
      assert.ok(report.totalUnpackedBytes > 0);

      for (const pkg of report.packages) {
        assert.equal(pkg.audit.ok, true, `${pkg.name} failed tarball audit: ${pkg.audit.violations.join('; ')}`);
        assert.equal(pkg.secretViolations, 0, `${pkg.name} had secret violations`);
        assert.equal(pkg.personalPathViolations, 0, `${pkg.name} had personal path violations`);
        assert.ok(
          pkg.entries.every((e) => !e.endsWith('.map')),
          `${pkg.name} shipped a .map file in tarball`
        );
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
