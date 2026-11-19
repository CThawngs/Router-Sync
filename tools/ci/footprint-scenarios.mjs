#!/usr/bin/env node
// Shared footprint scenario and budget helpers.

import fs from 'node:fs';
import path from 'node:path';

export const FOOTPRINT_SCENARIOS = Object.freeze([
  'cli-only',
  'cli-mcp-server',
  'all',
]);

const SCENARIO_ROOTS = Object.freeze({
  'cli-only': ['@routersync/cli'],
  'cli-mcp-server': ['@routersync/cli', '@routersync/mcp-server'],
});

/**
 * Return the npm CLI locations used by official Node.js distributions.
 *
 * Windows keeps npm below the executable directory. Unix distributions keep it
 * below the installation prefix (`<prefix>/lib/node_modules/npm`). The extra
 * prefix candidate also covers Homebrew-style layouts where the executable is
 * under a versioned Cellar directory.
 */
export function npmCliCandidates(
  executablePath,
  options = {}
) {
  const pathApi = options.pathApi ?? path;
  const nodePrefix = options.nodePrefix;
  const executableDirectory = pathApi.dirname(executablePath);
  const candidates = [
    pathApi.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(
      executableDirectory,
      '..',
      '..',
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
  ];

  if (nodePrefix) {
    candidates.push(
      pathApi.join(nodePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.join(nodePrefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    );
  }

  return [...new Set(candidates.map((candidate) => pathApi.normalize(candidate)))];
}

export function resolveNpmCliPath(options = {}) {
  const executablePath = options.executablePath ?? process.execPath;
  const nodePrefix = options.nodePrefix ?? process.config.variables.node_prefix;
  const exists = options.exists ?? ((candidate) => fs.existsSync(candidate));
  const candidates = npmCliCandidates(executablePath, {
    nodePrefix,
    pathApi: options.pathApi,
  });

  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export function resolveFootprintScenario(packages, scenario) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('footprint scenario requires package metadata');
  }

  const packagesByName = new Map();
  for (const pkg of packages) {
    if (!pkg?.name || packagesByName.has(pkg.name)) {
      throw new Error(`invalid or duplicate package metadata: ${pkg?.name ?? '<missing>'}`);
    }
    packagesByName.set(pkg.name, pkg);
  }

  let roots;
  if (scenario === 'all') {
    roots = [...packagesByName.keys()];
  } else {
    roots = SCENARIO_ROOTS[scenario];
  }
  if (!roots) {
    throw new Error(`unknown footprint scenario: ${scenario}`);
  }

  const resolved = new Set();
  const visit = (name) => {
    if (resolved.has(name)) return;
    const pkg = packagesByName.get(name);
    if (!pkg) {
      throw new Error(`footprint scenario references missing package: ${name}`);
    }
    resolved.add(name);
    for (const dependency of pkg.dependencies ?? []) {
      if (packagesByName.has(dependency)) visit(dependency);
    }
  };

  for (const root of roots) visit(root);
  return [...resolved].sort();
}

export function compareFootprintBudgets(measurements, budgets) {
  const footprint = budgets?.footprint;
  if (!footprint) return ['footprint: missing budget configuration'];
  if (footprint.unit !== 'bytes') {
    return [`footprint: unsupported budget unit ${footprint.unit ?? '<missing>'}`];
  }

  const problems = [];
  const configuredScenarios = footprint.scenarios ?? {};
  for (const [scenario, limit] of Object.entries(configuredScenarios)) {
    const measurement = measurements?.[scenario];
    if (!measurement) {
      problems.push(`${scenario}: missing measurement`);
      continue;
    }
    if (measurement.installedBytes > limit.maxBytes) {
      problems.push(
        `${scenario}: installedBytes ${measurement.installedBytes} > ${limit.maxBytes}`
      );
    }
  }
  for (const scenario of Object.keys(measurements ?? {})) {
    if (!configuredScenarios[scenario]) {
      problems.push(`${scenario}: missing budget entry`);
    }
  }
  return problems;
}
