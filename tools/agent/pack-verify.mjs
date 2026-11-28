#!/usr/bin/env node
/**
 * tools/agent/pack-verify.mjs
 *
 * Milestone M3-01 (P4): Publishable Tarball Hygiene & 5-OS Verification.
 *
 * Phases:
 *   A. Raw `npm pack --json` & strict allowlist + secret/personal-path audit on all 8 publishable packages.
 *   B. `npm publish --dry-run` readiness check (hard safety guard enforcing `--dry-run`).
 *   C. Optional read-only `npm view <pkg> version --json` availability check (`--check-registry`).
 *   D. Clean temp-dir tarball install outside `<REPO>` + offline CLI smoke (`--version`, `doctor --json`, `combos stale --router 9router`, `verify`).
 *
 * Usage:
 *   node tools/agent/pack-verify.mjs [--skip-publish-dry-run] [--check-registry] [--json]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNpmCliPath } from '../ci/footprint-scenarios.mjs';
import {
  scanLine as scanSecretLine,
  buildGuardPatterns as buildSecretGuardPatterns,
} from '../guard/no-secrets.mjs';
import {
  scanLine as scanPersonalPathLine,
  buildPatterns as buildPersonalPatterns,
  loadPrivatePatterns as loadPersonalPrivatePatterns,
} from '../guard/no-personal-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');

export const PUBLISHABLE_PACKAGES = Object.freeze([
  '@routersync/adapter-sdk',
  '@routersync/core',
  '@routersync/adapter-9router',
  '@routersync/adapter-omniroute',
  '@routersync/sources',
  '@routersync/daemon',
  '@routersync/cli',
  '@routersync/mcp-server',
]);

export const TARBALL_ENTRY_ALLOWLIST_RE =
  /^package\/(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|mjs|cjs|d\.ts|json))$/;

/** C52-R1: the exact set of public runtime registry files bundled with the CLI. */
export const BUNDLED_REGISTRY_FILES = Object.freeze([
  'providers.yaml',
  'gateways.yaml',
  'sources.yaml',
  'aliases.yaml',
  'catalog-trust.yaml',
  'models.yaml',
  'dead-models.yaml',
]);

const BUNDLED_REGISTRY_ENTRY_RE = new RegExp(
  `^package/dist/registry/(?:${BUNDLED_REGISTRY_FILES.join('|')})$`
);

const FORBIDDEN_ENTRY_RULES = Object.freeze([
  { name: 'source-map (.map)', regex: /\.map$/i },
  { name: 'evidence directory', regex: /(?:^|\/)evidence\//i },
  { name: '.agent directory', regex: /(?:^|\/)\.agent\//i },
  { name: 'src directory', regex: /(?:^|\/)src\//i },
  { name: 'test directory', regex: /(?:^|\/)test\//i },
  { name: '.env file', regex: /(?:^|\/)\.env(?:\.|$)/i },
  { name: '.local file', regex: /\.local\./i },
  { name: 'runtime yaml config', regex: /(?:^|\/)(?:routersync|config|ranking)\.ya?ml$/i },
  { name: 'sqlite database', regex: /\.sqlite(?:3|-wal|-shm)?$/i },
]);

/**
 * Pure validator enforcing the strict tarball entry allowlist and explicit
 * forbidden artifact rules.
 */
export function auditTarballEntries(pkgName, fileEntries) {
  const violations = [];
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    return {
      ok: false,
      violations: [`${pkgName}: tarball has no file entries`],
    };
  }

  const normalizedEntries = fileEntries.map((entry) => {
    const raw = typeof entry === 'string' ? entry : String(entry?.path ?? '');
    return raw.replace(/\\/g, '/').trim();
  });

  if (!normalizedEntries.includes('package/package.json')) {
    violations.push(`${pkgName}: missing required entry package/package.json`);
  }

  for (const entry of normalizedEntries) {
    if (!entry) {
      violations.push(`${pkgName}: empty tarball entry path`);
      continue;
    }

    for (const rule of FORBIDDEN_ENTRY_RULES) {
      if (rule.regex.test(entry)) {
        violations.push(`${pkgName}: forbidden ${rule.name} entry "${entry}"`);
      }
    }

    if (!TARBALL_ENTRY_ALLOWLIST_RE.test(entry) && !BUNDLED_REGISTRY_ENTRY_RE.test(entry)) {
      violations.push(`${pkgName}: entry outside allowlist "${entry}"`);
    }
  }

  if (pkgName === '@routersync/cli') {
    for (const name of BUNDLED_REGISTRY_FILES) {
      const expected = `package/dist/registry/${name}`;
      if (!normalizedEntries.includes(expected)) {
        violations.push(`${pkgName}: missing bundled runtime registry entry "${expected}"`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * C52-R1: compare the repository registry with the copy bundled into the
 * package. Returns synthetic-friendly names only; no file contents or host
 * paths are included in the result.
 */
export function verifyBundledRegistrySet(repoRoot, bundledDir) {
  const missing = [];
  const mismatched = [];
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const name of BUNDLED_REGISTRY_FILES) {
    const source = path.join(repoRoot, 'registry', name);
    const bundled = path.join(bundledDir, name);
    if (!fs.existsSync(bundled)) {
      missing.push(name);
      continue;
    }
    if (!fs.existsSync(source)) {
      mismatched.push(name);
      continue;
    }
    if (digest(source) !== digest(bundled)) mismatched.push(name);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

/**
 * Hard safety guard: constructs `npm publish --dry-run` arguments and refuses
 * to return any argument vector missing `--dry-run` or negating `--dry-run`.
 */
export function buildPublishDryRunArgs(extra = []) {
  if (!Array.isArray(extra)) {
    throw new Error('buildPublishDryRunArgs requires an array of extra arguments');
  }
  for (const flag of extra) {
    const str = String(flag);
    if (
      /^--no-dry-run$/i.test(str) ||
      /^--dry-run=(?:false|0|no)$/i.test(str)
    ) {
      throw new Error(`Safety violation: --dry-run is mandatory; refusing negation flag "${str}"`);
    }
  }

  const filteredExtra = extra.map(String).filter((arg) => arg !== '--dry-run');
  const args = ['publish', '--dry-run', ...filteredExtra];

  if (args[0] !== 'publish' || !args.includes('--dry-run')) {
    throw new Error('Safety violation: --dry-run is mandatory for npm publish');
  }

  return args;
}

/**
 * Parse a single `npm view <pkgName> version --json` invocation result.
 */
export function parseRegistryViewResult(pkgName, result) {
  const stdout = String(result?.stdout ?? '').trim();
  const stderr = String(result?.stderr ?? '').trim();
  const combined = `${stdout}\n${stderr}`;

  if (result?.status === 0 && stdout.length > 0) {
    let parsed = stdout;
    try {
      const jsonVal = JSON.parse(stdout);
      if (Array.isArray(jsonVal)) {
        parsed = String(jsonVal[jsonVal.length - 1] ?? '');
      } else if (typeof jsonVal === 'string') {
        parsed = jsonVal;
      } else if (jsonVal && typeof jsonVal === 'object' && typeof jsonVal.version === 'string') {
        parsed = jsonVal.version;
      }
    } catch {
      parsed = stdout.replace(/^"+|"+$/g, '');
    }
    return {
      name: pkgName,
      status: 'occupied',
      publishedVersion: parsed || 'unknown',
      note: 'chờ chủ dự án',
    };
  }

  if (/E404|404\s+Not\s+Found|is not in this registry/i.test(combined)) {
    return {
      name: pkgName,
      status: 'unoccupied',
      publishedVersion: null,
      note: 'chờ chủ dự án',
    };
  }

  return {
    name: pkgName,
    status: 'error',
    publishedVersion: null,
    error: stderr.slice(0, 240) || stdout.slice(0, 240) || `exit ${result?.status ?? 'unknown'}`,
  };
}

/**
 * Read-only registry availability check across `@routersync/*` package names.
 */
export function checkRegistryPackages(packageNames, runView) {
  return packageNames.map((pkgName) => {
    const res = runView(pkgName);
    return parseRegistryViewResult(pkgName, res);
  });
}

function createNpmRunner() {
  const npmCliPath = resolveNpmCliPath();
  return function runNpm(args, cwd, timeoutMs = 300000) {
    if (npmCliPath) {
      return spawnSync(process.execPath, [npmCliPath, ...args], {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      });
    }

    if (process.platform === 'win32') {
      return spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      });
    }

    return spawnSync('npm', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  };
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function discoverPublishableWorkspacePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  const discovered = [];
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (manifest.private === true) continue;
    discovered.push({
      name: manifest.name,
      version: manifest.version,
      directory: pkgDir,
      directoryName: entry.name,
    });
  }

  // Sort in canonical PUBLISHABLE_PACKAGES order first, then alphabetically for any unknown
  const order = new Map(PUBLISHABLE_PACKAGES.map((name, idx) => [name, idx]));
  discovered.sort((a, b) => {
    const ia = order.has(a.name) ? order.get(a.name) : 999;
    const ib = order.has(b.name) ? order.get(b.name) : 999;
    return ia !== ib ? ia - ib : a.name.localeCompare(b.name);
  });
  return discovered;
}

/**
 * Phase A: Pack all publishable workspace packages into `workDir`, inspect raw
 * tarball entries against allowlist, unpack into `stage/`, and scan all unpacked
 * text files with `no-secrets` + `no-personal-paths`.
 */
export function packAndAuditWorkspacePackages({
  repoRoot = DEFAULT_REPO_ROOT,
  workDir,
}) {
  const runNpm = createNpmRunner();
  const rawPacksDir = path.join(workDir, 'packs-raw');
  const stageRootDir = path.join(workDir, 'stage');
  fs.mkdirSync(rawPacksDir, { recursive: true });
  fs.mkdirSync(stageRootDir, { recursive: true });

  const secretExtraPatterns = buildSecretGuardPatterns(repoRoot);
  const personalPatterns = [
    ...buildPersonalPatterns({ root: repoRoot }),
    ...loadPersonalPrivatePatterns(repoRoot),
  ];

  const workspacePackages = discoverPublishableWorkspacePackages(repoRoot);
  const expectedNames = [...PUBLISHABLE_PACKAGES].sort();
  const actualNames = workspacePackages.map((p) => p.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Publishable package set mismatch: expected [${expectedNames.join(', ')}], got [${actualNames.join(', ')}]`
    );
  }

  const results = [];
  let totalTarballBytes = 0;
  let totalUnpackedBytes = 0;

  for (const pkg of workspacePackages) {
    const packed = runNpm(
      ['pack', '--json', '--pack-destination', rawPacksDir],
      pkg.directory
    );
    if (packed.status !== 0) {
      throw new Error(
        `npm pack failed for ${pkg.name}: ${(packed.stderr || packed.stdout || '').slice(0, 500)}`
      );
    }

    let packJson;
    try {
      packJson = JSON.parse(packed.stdout);
    } catch {
      throw new Error(`npm pack returned invalid JSON for ${pkg.name}`);
    }

    const meta = packJson?.[0];
    const filename = meta?.filename;
    if (!filename) {
      throw new Error(`npm pack produced no filename for ${pkg.name}`);
    }

    const tarballPath = path.join(rawPacksDir, filename);
    const tarballBytes = fs.statSync(tarballPath).size;

    const tarList = spawnSync('tar', ['-tzf', tarballPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (tarList.status !== 0) {
      throw new Error(`tar -tzf failed for ${pkg.name}: ${tarList.stderr}`);
    }

    const tarEntries = tarList.stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/\\/g, '/').trim())
      .filter((line) => line.length > 0 && !line.endsWith('/'));

    const jsonEntries = Array.isArray(meta.files)
      ? meta.files.map((f) => `package/${String(f.path).replace(/\\/g, '/').replace(/^\/+/, '')}`)
      : [];
    const entrySet = new Set([...tarEntries, ...jsonEntries]);
    const entries = [...entrySet].sort();

    const audit = auditTarballEntries(pkg.name, entries);

    const pkgStageDir = path.join(stageRootDir, pkg.directoryName);
    fs.mkdirSync(pkgStageDir, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tarballPath, '-C', pkgStageDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (untar.status !== 0) {
      throw new Error(`tar -xzf failed for ${pkg.name}: ${untar.stderr}`);
    }

    const unpackedRoot = path.join(pkgStageDir, 'package');
    const unpackedFiles = walkFiles(unpackedRoot);
    let unpackedBytes = 0;
    let secretViolations = 0;
    let personalPathViolations = 0;
    const guardIssues = [];

    for (const fullFile of unpackedFiles) {
      const stat = fs.statSync(fullFile);
      unpackedBytes += stat.size;

      const rawBuf = fs.readFileSync(fullFile);
      if (rawBuf.includes(0)) continue; // skip binary if any
      const content = rawBuf.toString('utf8');
      const relInTar = `package/${path.relative(unpackedRoot, fullFile).replace(/\\/g, '/')}`;
      const lines = content.split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const secRes = scanSecretLine(line, secretExtraPatterns);
        if (!secRes.ok) {
          secretViolations += 1;
          guardIssues.push(`${relInTar}:${idx + 1} secret violation (${secRes.violation ?? secRes.error})`);
        }
        const pathRes = scanPersonalPathLine(line, personalPatterns);
        if (!pathRes.ok) {
          personalPathViolations += 1;
          guardIssues.push(`${relInTar}:${idx + 1} personal-path violation (${pathRes.violation})`);
        }
      }
    }

    totalTarballBytes += tarballBytes;
    totalUnpackedBytes += unpackedBytes;

    results.push({
      name: pkg.name,
      version: pkg.version,
      directory: pkg.directory,
      directoryName: pkg.directoryName,
      stagePackageDir: unpackedRoot,
      tarballBytes,
      unpackedBytes,
      fileCount: entries.length,
      entries,
      audit,
      secretViolations,
      personalPathViolations,
      guardIssues,
    });
  }

  return {
    packages: results,
    totalTarballBytes,
    totalUnpackedBytes,
  };
}

function runPublishDryRunPhase(packages, runNpm, workDir) {
  const publishResults = [];
  for (const pkg of packages) {
    const args = buildPublishDryRunArgs();
    if (!args.includes('--dry-run')) {
      throw new Error('Safety violation: refusing to invoke npm publish without --dry-run');
    }

    let res = runNpm(args, pkg.directory);
    const combinedInitial = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;

    // If an npm CLI version rejects `workspace:*` protocol on in-place manifest,
    // run `npm publish --dry-run` on a staged copy with `workspace:*` rewritten to exact version.
    if (res.status !== 0 && /workspace:|EUNSUPPORTEDPROTOCOL/i.test(combinedInitial)) {
      const publishStageDir = path.join(workDir, 'publish-stage', pkg.directoryName);
      fs.cpSync(pkg.stagePackageDir, publishStageDir, { recursive: true });
      const manifestPath = path.join(publishStageDir, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const depField of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (!manifest[depField]) continue;
        for (const [dep, spec] of Object.entries(manifest[depField])) {
          if (String(spec).startsWith('workspace:')) {
            manifest[depField][dep] = pkg.version;
          }
        }
      }
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      res = runNpm(args, publishStageDir);
    }

    if (res.status !== 0) {
      throw new Error(
        `npm publish --dry-run failed for ${pkg.name} (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 500)}`
      );
    }

    const dryRunNotice = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (/\.js\.map|\.d\.ts\.map/i.test(dryRunNotice)) {
      throw new Error(`npm publish --dry-run for ${pkg.name} listed a .map file`);
    }

    publishResults.push({
      name: pkg.name,
      ok: true,
      args,
    });
  }
  return publishResults;
}

function runCleanInstallAndSmokePhase(packages, repoRoot, workDir, runNpm) {
  const stagedPacksDir = path.join(workDir, 'packs-staged');
  fs.mkdirSync(stagedPacksDir, { recursive: true });

  const stagedTarballs = [];
  for (const pkg of packages) {
    const manifestPath = path.join(pkg.stagePackageDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const depField of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      if (!manifest[depField]) continue;
      for (const [dep, spec] of Object.entries(manifest[depField])) {
        if (String(spec).startsWith('workspace:')) {
          delete manifest[depField][dep];
        }
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const repacked = runNpm(
      ['pack', '--json', '--pack-destination', stagedPacksDir],
      pkg.stagePackageDir
    );
    if (repacked.status !== 0) {
      throw new Error(
        `repack failed for ${pkg.name}: ${(repacked.stderr || repacked.stdout || '').slice(0, 500)}`
      );
    }
    const repackJson = JSON.parse(repacked.stdout);
    const repackFilename = repackJson?.[0]?.filename;
    if (!repackFilename) {
      throw new Error(`repack produced no filename for ${pkg.name}`);
    }
    stagedTarballs.push(path.join(stagedPacksDir, repackFilename));
  }

  const cleanInstallDir = path.join(workDir, 'clean-install');
  fs.mkdirSync(cleanInstallDir, { recursive: true });
  fs.writeFileSync(
    path.join(cleanInstallDir, 'package.json'),
    `${JSON.stringify(
      { name: 'rs-clean-install-smoke', private: true, version: '1.0.0' },
      null,
      2
    )}\n`,
    'utf8'
  );

  const t0 = Date.now();
  const installed = runNpm(
    ['install', '--no-audit', '--no-fund', ...stagedTarballs],
    cleanInstallDir
  );
  const installMs = Date.now() - t0;
  const installLog = `${installed.stdout ?? ''}\n${installed.stderr ?? ''}`;
  if (/node-gyp|gyp ERR|building native/i.test(installLog)) {
    throw new Error('Clean install failed: native compilation (node-gyp) detected');
  }
  if (installed.status !== 0) {
    throw new Error(
      `Clean tarball npm install failed (exit ${installed.status}): ${installLog.slice(-1500)}`
    );
  }

  // Create offline sample router fixture in <workDir>/fixture (baseUrl http://127.0.0.1:9; zero live ports)
  const fixtureDir = path.join(workDir, 'fixture');
  const fakeHome = path.join(workDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const makeSampleScript = path.join(repoRoot, 'tools', 'ci', 'make-sample-state.mjs');
  const sampleRes = spawnSync(process.execPath, [makeSampleScript, fixtureDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (sampleRes.status !== 0) {
    throw new Error(
      `make-sample-state failed: ${(sampleRes.stderr || sampleRes.stdout || '').slice(0, 500)}`
    );
  }

  const installedCliEntry = path.join(
    cleanInstallDir,
    'node_modules',
    '@routersync',
    'cli',
    'dist',
    'index.js'
  );
  if (!fs.existsSync(installedCliEntry)) {
    throw new Error('Installed @routersync/cli entrypoint missing in clean-install');
  }

  const isolatedEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
    XDG_STATE_HOME: path.join(fakeHome, '.local', 'state'),
    ROUTERSYNC_9ROUTER_DB: path.join(fixtureDir, '9router.sqlite'),
    ROUTERSYNC_OMNIROUTE_DB: path.join(fixtureDir, 'omniroute.sqlite'),
    ROUTERSYNC_STATE_DIR: path.join(fixtureDir, 'state'),
    ROUTERSYNC_CONFIG: path.join(fixtureDir, 'routersync.yaml'),
  };
  delete isolatedEnv.OMNIROUTE_DB_PATH;
  delete isolatedEnv.NINEROUTER_DB_PATH;
  delete isolatedEnv.NINE_ROUTER_DB_PATH;
  delete isolatedEnv.DATA_DIR;

  const runInstalledCli = (cliArgs, cwd = cleanInstallDir) =>
    spawnSync(process.execPath, [installedCliEntry, ...cliArgs], {
      cwd,
      env: isolatedEnv,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });

  // C52-R1: the installed package must carry a byte-identical registry copy.
  const installedRegistryDir = path.join(
    cleanInstallDir,
    'node_modules',
    '@routersync',
    'cli',
    'dist',
    'registry'
  );
  const bundledRegistry = verifyBundledRegistrySet(repoRoot, installedRegistryDir);
  if (!bundledRegistry.ok) {
    throw new Error(
      `Clean install registry mismatch (missing=${bundledRegistry.missing.join(',')} mismatched=${bundledRegistry.mismatched.join(',')})`
    );
  }

  // C52-R1: run from a cwd far away from both the repo and the install dir.
  const farCwd = path.join(workDir, 'far-cwd');
  fs.mkdirSync(farCwd, { recursive: true });

  // 1. --version
  const verRes = runInstalledCli(['--version']);
  if (verRes.status !== 0 || verRes.stdout.trim() !== '0.1.0') {
    throw new Error(
      `Clean CLI --version failed (exit ${verRes.status}, stdout="${verRes.stdout.trim()}")`
    );
  }

  // 2. doctor --json
  const docRes = runInstalledCli(['doctor', '--json']);
  if (docRes.status !== 0) {
    throw new Error(
      `Clean CLI doctor --json failed (exit ${docRes.status}): ${(docRes.stderr || docRes.stdout || '').slice(0, 500)}`
    );
  }
  let doctorPayload;
  try {
    doctorPayload = JSON.parse(docRes.stdout);
  } catch {
    throw new Error('Clean CLI doctor --json emitted invalid JSON');
  }
  if (!doctorPayload || typeof doctorPayload !== 'object') {
    throw new Error('Clean CLI doctor --json returned empty payload');
  }
  if (
    !doctorPayload.registry ||
    doctorPayload.registry.available !== true ||
    !(doctorPayload.registry.providerCount > 0)
  ) {
    throw new Error(
      `Clean CLI doctor registry invalid (REGISTRY_MISSING): ${JSON.stringify(doctorPayload.registry)}`
    );
  }

  // C52-R1: same check from a cwd outside repo and outside the install tree.
  const farDocRes = runInstalledCli(['doctor', '--json'], farCwd);
  if (farDocRes.status !== 0) {
    throw new Error(
      `Far-cwd doctor --json failed (exit ${farDocRes.status}): ${(farDocRes.stderr || farDocRes.stdout || '').slice(0, 500)}`
    );
  }
  let farDoctorPayload;
  try {
    farDoctorPayload = JSON.parse(farDocRes.stdout);
  } catch {
    throw new Error('Far-cwd doctor --json emitted invalid JSON');
  }
  if (!farDoctorPayload.registry?.available || !(farDoctorPayload.registry.providerCount > 0)) {
    throw new Error(
      `Far-cwd doctor registry invalid (REGISTRY_MISSING): ${JSON.stringify(farDoctorPayload.registry)}`
    );
  }

  // 3a. combos stale --router 9router
  const staleRes = runInstalledCli(['combos', 'stale', '--router', '9router']);
  if (staleRes.status !== 0) {
    throw new Error(
      `Clean CLI combos stale --router 9router failed (exit ${staleRes.status}): ${(staleRes.stderr || staleRes.stdout || '').slice(0, 500)}`
    );
  }

  // 3b. verify
  const verifyRes = runInstalledCli(['verify']);
  if (verifyRes.status !== 0) {
    throw new Error(
      `Clean CLI verify failed (exit ${verifyRes.status}): ${(verifyRes.stderr || verifyRes.stdout || '').slice(0, 500)}`
    );
  }

  return {
    installMs,
    nodeGyp: false,
    fixtureBaseUrl: 'http://127.0.0.1:9',
    commands: {
      version: verRes.stdout.trim(),
      doctorJsonOk: true,
      combosStaleExit: staleRes.status,
      verifyExit: verifyRes.status,
    },
    registry: {
      bundledBytesMatch: true,
      providerCount: doctorPayload.registry.providerCount,
      farCwdDoctorOk: true,
    },
  };
}

export function parsePackVerifyArgs(argv = process.argv.slice(2)) {
  let skipPublishDryRun = false;
  let checkRegistry = false;
  let json = false;

  for (const arg of argv) {
    if (arg === '--skip-publish-dry-run') skipPublishDryRun = true;
    else if (arg === '--check-registry') checkRegistry = true;
    else if (arg === '--json') json = true;
    else throw new Error(`Unknown pack-verify flag: ${arg}`);
  }

  return { skipPublishDryRun, checkRegistry, json };
}

function main() {
  const opts = parsePackVerifyArgs();
  const runNpm = createNpmRunner();
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-pack-verify-'));

  try {
    const phaseA = packAndAuditWorkspacePackages({
      repoRoot: DEFAULT_REPO_ROOT,
      workDir: tmpWork,
    });

    const phaseAFailures = [];
    for (const pkg of phaseA.packages) {
      if (!pkg.audit.ok) {
        phaseAFailures.push(...pkg.audit.violations);
      }
      if (pkg.secretViolations > 0 || pkg.personalPathViolations > 0) {
        phaseAFailures.push(...pkg.guardIssues);
      }
    }
    if (phaseAFailures.length > 0) {
      console.error('PACK_VERIFY FAIL (Phase A allowlist/guard):');
      for (const failure of phaseAFailures) console.error(`  - ${failure}`);
      process.exit(1);
    }

    const phaseB = opts.skipPublishDryRun
      ? { skipped: true, packages: [] }
      : {
          skipped: false,
          packages: runPublishDryRunPhase(phaseA.packages, runNpm, tmpWork),
        };

    const phaseC = opts.checkRegistry
      ? {
          enabled: true,
          packages: checkRegistryPackages(PUBLISHABLE_PACKAGES, (pkgName) =>
            runNpm(['view', pkgName, 'version', '--json'], DEFAULT_REPO_ROOT, 30000)
          ),
        }
      : { enabled: false, packages: [] };

    if (phaseC.enabled) {
      const regErrors = phaseC.packages.filter((p) => p.status === 'error');
      if (regErrors.length > 0) {
        console.error(
          `PACK_VERIFY FAIL (Phase C registry view): ${regErrors.map((e) => `${e.name}: ${e.error}`).join('; ')}`
        );
        process.exit(1);
      }
    }

    const phaseD = runCleanInstallAndSmokePhase(
      phaseA.packages,
      DEFAULT_REPO_ROOT,
      tmpWork,
      runNpm
    );

    const summary = {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      packageCount: phaseA.packages.length,
      totalTarballBytes: phaseA.totalTarballBytes,
      totalUnpackedBytes: phaseA.totalUnpackedBytes,
      packages: phaseA.packages.map((p) => ({
        name: p.name,
        version: p.version,
        fileCount: p.fileCount,
        tarballBytes: p.tarballBytes,
        unpackedBytes: p.unpackedBytes,
        secretViolations: p.secretViolations,
        personalPathViolations: p.personalPathViolations,
      })),
      publishDryRun: {
        skipped: phaseB.skipped,
        verifiedCount: phaseB.packages.length,
      },
      registryCheck: phaseC,
      cleanInstallSmoke: phaseD,
    };

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    for (const pkg of summary.packages) {
      console.log(
        `PACK_TARBALL package=${pkg.name} files=${pkg.fileCount} tarballBytes=${pkg.tarballBytes} unpackedBytes=${pkg.unpackedBytes} maps=0 secrets=0 personalPaths=0`
      );
    }
    console.log(
      `PACK_TOTALS packages=${summary.packageCount} totalTarballBytes=${summary.totalTarballBytes} totalUnpackedBytes=${summary.totalUnpackedBytes}`
    );
    console.log(
      `PACK_PUBLISH_DRY_RUN skipped=${summary.publishDryRun.skipped} verified=${summary.publishDryRun.verifiedCount}`
    );
    if (summary.registryCheck.enabled) {
      for (const reg of summary.registryCheck.packages) {
        console.log(
          `PACK_REGISTRY package=${reg.name} status=${reg.status} publishedVersion=${reg.publishedVersion ?? 'none'}`
        );
      }
    }
    console.log(
      `PACK_CLEAN_SMOKE ok=true installMs=${phaseD.installMs} nodeGyp=false version=${phaseD.commands.version} doctorJson=true combosStale=0 verify=0 registryBytesMatch=true providerCount=${phaseD.registry.providerCount} farCwdDoctorOk=true`
    );
  } catch (err) {
    console.error(`PACK_VERIFY FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
