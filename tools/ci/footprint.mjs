#!/usr/bin/env node
// C15 Q2.2 / C17 T4: pack real workspace packages, install clean scenario
// trees, and measure the installed footprint in bytes. The CLI-only scenario
// is the primary number; CLI+MCP and the full workspace are also measured.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOOTPRINT_SCENARIOS,
  compareFootprintBudgets,
  resolveFootprintScenario,
  resolveNpmCliPath,
} from './footprint-scenarios.mjs';

const root = process.cwd();
const npmCliPath = resolveNpmCliPath();

function runNpm(args, cwd, timeoutMs = 300000) {
  if (npmCliPath) {
    return spawnSync(process.execPath, [npmCliPath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  }

  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmExecutable, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ENOENT') {
    console.error(`npm executable not found: ${npmExecutable}`);
    process.exit(1);
  }
  return result;
}

const work = path.resolve('.agent/work-c17/footprint');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const packs = path.join(work, 'packs');
fs.mkdirSync(packs, { recursive: true });

const packageMetadata = [];
for (const entry of fs.readdirSync('packages', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = path.join(root, 'packages', entry.name);
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageMetadata.push({
    name: manifest.name,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    directory: packageDir,
    directoryName: entry.name,
  });
}

const packedPackages = new Map();
for (const pkg of packageMetadata) {
  const packed = runNpm(
    ['pack', '--json', '--pack-destination', packs],
    pkg.directory
  );
  if (packed.status !== 0) {
    console.error(`npm pack failed for ${pkg.name}: ${packed.stderr || packed.stdout}`);
    process.exit(1);
  }

  let packResult;
  try {
    packResult = JSON.parse(packed.stdout);
  } catch {
    console.error(`npm pack returned invalid JSON for ${pkg.name}`);
    process.exit(1);
  }
  const tarballName = packResult[0]?.filename;
  if (!tarballName) {
    console.error(`npm pack did not produce a tarball for ${pkg.name}`);
    process.exit(1);
  }

  // Workspace protocol dependencies are not installable from a tarball. Strip
  // them so every internal dependency is supplied explicitly by the scenario.
  const stageDir = path.join(work, 'stage', pkg.directoryName);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const untar = spawnSync(
    'tar',
    ['-xzf', path.join(packs, tarballName), '-C', stageDir],
    { encoding: 'utf8' }
  );
  if (untar.status !== 0) {
    console.error(`untar failed for ${pkg.name}: ${untar.stderr}`);
    process.exit(1);
  }

  const stagedPackageJsonPath = path.join(stageDir, 'package', 'package.json');
  const stagedManifest = JSON.parse(fs.readFileSync(stagedPackageJsonPath, 'utf8'));
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    if (!stagedManifest[key]) continue;
    for (const [dependency, specifier] of Object.entries(stagedManifest[key])) {
      if (String(specifier).startsWith('workspace:')) {
        delete stagedManifest[key][dependency];
      }
    }
  }
  fs.writeFileSync(
    stagedPackageJsonPath,
    `${JSON.stringify(stagedManifest, null, 2)}\n`
  );

  const repacked = runNpm(
    ['pack', '--json', '--pack-destination', packs],
    path.join(stageDir, 'package')
  );
  if (repacked.status !== 0) {
    console.error(`repack failed for ${pkg.name}: ${repacked.stderr || repacked.stdout}`);
    process.exit(1);
  }
  let repackResult;
  try {
    repackResult = JSON.parse(repacked.stdout);
  } catch {
    console.error(`repack returned invalid JSON for ${pkg.name}`);
    process.exit(1);
  }
  const repackedName = repackResult[0]?.filename;
  if (!repackedName) {
    console.error(`repack did not produce a tarball for ${pkg.name}`);
    process.exit(1);
  }
  packedPackages.set(pkg.name, path.join(packs, repackedName));
}

function directorySize(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = directorySize(entryPath);
      bytes += child.bytes;
      files += child.files;
    } else {
      bytes += fs.statSync(entryPath).size;
      files += 1;
    }
  }
  return { bytes, files };
}

const measurements = {};
for (const scenario of FOOTPRINT_SCENARIOS) {
  const packageNames = resolveFootprintScenario(packageMetadata, scenario);
  const installDir = path.join(work, 'install', scenario);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'package.json'),
    `${JSON.stringify(
      { name: `footprint-${scenario}`, private: true, version: '1.0.0' },
      null,
      2
    )}\n`
  );

  const tarballs = packageNames.map((name) => packedPackages.get(name));
  const startedAt = Date.now();
  const installed = runNpm(
    ['install', '--no-audit', '--no-fund', ...tarballs],
    installDir
  );
  const installMs = Date.now() - startedAt;
  const installLog = `${installed.stdout || ''}\n${installed.stderr || ''}`;
  if (/node-gyp|gyp ERR|building native/i.test(installLog)) {
    console.error(`FOOTPRINT FAIL ${scenario}: native compilation (node-gyp) detected`);
    process.exit(1);
  }
  if (installed.status !== 0) {
    console.error(
      `npm install failed for ${scenario}: ${installLog.slice(-2000)}`
    );
    process.exit(1);
  }

  const size = directorySize(installDir);
  measurements[scenario] = {
    packageNames,
    installedBytes: size.bytes,
    installedFiles: size.files,
    installMs,
    nodeGyp: false,
  };
  console.log(
    `FOOTPRINT SCENARIO ${scenario}: ${size.files} files, ${size.bytes} bytes (${(size.bytes / 1024 / 1024).toFixed(1)} MiB), ${installMs} ms, no node-gyp`
  );
}

const primaryScenario = 'cli-only';
const primary = measurements[primaryScenario];
const result = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  unit: 'bytes',
  primaryScenario,
  packages: primary.packageNames.length,
  installedBytes: primary.installedBytes,
  installedFiles: primary.installedFiles,
  installMs: primary.installMs,
  nodeGyp: false,
  scenarios: measurements,
};
fs.writeFileSync('footprint.json', `${JSON.stringify(result, null, 2)}\n`);

const budgets = JSON.parse(fs.readFileSync('budgets.json', 'utf8'));
const problems = compareFootprintBudgets(measurements, budgets);
if (problems.length > 0) {
  console.error(`FOOTPRINT BUDGET FAIL: ${problems.join('; ')}`);
  process.exit(1);
}

console.log(
  `FOOTPRINT OK: primary=${primaryScenario}, ${primary.installedFiles} files, ${primary.installedBytes} bytes (${(primary.installedBytes / 1024 / 1024).toFixed(1)} MiB), ${primary.installMs} ms, no node-gyp`
);
