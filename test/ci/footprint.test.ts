import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  compareFootprintBudgets,
  npmCliCandidates,
  resolveFootprintScenario,
  resolveNpmCliPath,
} = require('../../tools/ci/footprint-scenarios.mjs');

const PACKAGES = [
  { name: '@routersync/adapter-sdk', dependencies: [] },
  { name: '@routersync/core', dependencies: ['@routersync/adapter-sdk'] },
  { name: '@routersync/adapter-9router', dependencies: ['@routersync/core'] },
  { name: '@routersync/adapter-omniroute', dependencies: ['@routersync/core'] },
  { name: '@routersync/daemon', dependencies: ['@routersync/core'] },
  { name: '@routersync/sources', dependencies: ['@routersync/core'] },
  {
    name: '@routersync/cli',
    dependencies: [
      '@routersync/adapter-9router',
      '@routersync/adapter-omniroute',
      '@routersync/adapter-sdk',
      '@routersync/core',
      '@routersync/daemon',
      '@routersync/sources',
    ],
  },
  { name: '@routersync/mcp-server', dependencies: ['@routersync/core'] },
  { name: '@routersync/ui', dependencies: [] },
];

describe('C17 T4: footprint scenarios', () => {
  it('finds npm in official Unix and Windows Node.js layouts', () => {
    const unixPrefix = '/opt/hostedtoolcache/node/24.0.0/x64';
    const unixCandidates = npmCliCandidates(`${unixPrefix}/bin/node`, {
      nodePrefix: unixPrefix,
      pathApi: path.posix,
    });
    expect(unixCandidates).toContain(
      '/opt/hostedtoolcache/node/24.0.0/x64/lib/node_modules/npm/bin/npm-cli.js'
    );

    const windowsPrefix = 'C:\\Program Files\\nodejs';
    const windowsCandidates = npmCliCandidates(`${windowsPrefix}\\node.exe`, {
      nodePrefix: windowsPrefix,
      pathApi: path.win32,
    });
    expect(windowsCandidates).toContain(
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    );
  });

  it('resolves an existing npm CLI without assuming a platform layout', () => {
    const expected = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    const resolved = resolveNpmCliPath({
      executablePath: '/opt/node/bin/node',
      nodePrefix: '/opt/node',
      pathApi: path.posix,
      exists: (candidate) => candidate === expected,
    });

    expect(resolved).toBe(expected);
  });

  it('resolves the CLI-only install to its internal dependency closure', () => {
    expect(resolveFootprintScenario(PACKAGES, 'cli-only')).toEqual([
      '@routersync/adapter-9router',
      '@routersync/adapter-omniroute',
      '@routersync/adapter-sdk',
      '@routersync/cli',
      '@routersync/core',
      '@routersync/daemon',
      '@routersync/sources',
    ]);
  });

  it('adds the MCP server only to the cli-mcp-server scenario', () => {
    expect(resolveFootprintScenario(PACKAGES, 'cli-mcp-server')).toContain(
      '@routersync/mcp-server'
    );
    expect(resolveFootprintScenario(PACKAGES, 'cli-only')).not.toContain(
      '@routersync/mcp-server'
    );
  });

  it('includes every workspace package in the all scenario', () => {
    expect(resolveFootprintScenario(PACKAGES, 'all')).toHaveLength(PACKAGES.length);
    expect(resolveFootprintScenario(PACKAGES, 'all')).toContain('@routersync/ui');
  });

  it('fails when a measured scenario exceeds its byte budget', () => {
    const budgets = {
      footprint: {
        unit: 'bytes',
        scenarios: {
          'cli-only': { maxBytes: 100 },
        },
      },
    };
    const problems = compareFootprintBudgets(
      { 'cli-only': { installedBytes: 101 } },
      budgets
    );

    expect(problems).toEqual(['cli-only: installedBytes 101 > 100']);
  });
});
