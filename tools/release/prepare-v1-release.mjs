#!/usr/bin/env node
/**
 * tools/release/prepare-v1-release.mjs
 *
 * Deterministic release version-bump helper for RouterSync (C45 WP0 — Phục vụ: S10).
 *
 * - Default mode is strictly read-only (`--dry-run`).
 * - Updates `version` across the root manifest and all 9 workspace packages
 *   (8 publishable `@routersync/*` packages + private `@routersync/ui`) only when
 *   `--write` (or `--apply-version`) is explicitly supplied.
 * - Uses atomic temp-file + rename writes and reads each updated manifest back
 *   to confirm the persisted version matches `--target`.
 * - Never runs `npm publish`, never creates git tags, and never touches live routers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOWED_TARGETS = ['1.0.0', '1.0.0-rc.1'];

export const WORKSPACE_MANIFESTS = [
  { relPath: 'package.json', publishable: false },
  { relPath: 'packages/adapter-sdk/package.json', publishable: true },
  { relPath: 'packages/core/package.json', publishable: true },
  { relPath: 'packages/sources/package.json', publishable: true },
  { relPath: 'packages/adapter-9router/package.json', publishable: true },
  { relPath: 'packages/adapter-omniroute/package.json', publishable: true },
  { relPath: 'packages/daemon/package.json', publishable: true },
  { relPath: 'packages/cli/package.json', publishable: true },
  { relPath: 'packages/mcp-server/package.json', publishable: true },
  { relPath: 'packages/ui/package.json', publishable: false },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

export function parseArgs(argv) {
  const opts = {
    target: '1.0.0',
    write: false,
    json: false,
    help: false,
    root: DEFAULT_REPO_ROOT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.write = false;
    } else if (arg === '--write' || arg === '--apply-version') {
      opts.write = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --target (expected 1.0.0 or 1.0.0-rc.1).');
      }
      opts.target = next;
      i += 1;
    } else if (arg.startsWith('--target=')) {
      opts.target = arg.slice('--target='.length);
    } else if (arg === '--root') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --root.');
      }
      opts.root = path.resolve(next);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      opts.root = path.resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function writeAtomicJson(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`
  );
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function prepareV1Release({
  target = '1.0.0',
  write = false,
  root = DEFAULT_REPO_ROOT,
} = {}) {
  if (!ALLOWED_TARGETS.includes(target)) {
    throw new Error(
      `Unsupported --target "${target}". Allowed values: ${ALLOWED_TARGETS.join(', ')}`
    );
  }

  const distTag = target.includes('-rc.') ? 'next' : 'latest';
  const entries = [];

  for (const spec of WORKSPACE_MANIFESTS) {
    const absPath = path.join(root, spec.relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing workspace manifest: ${spec.relPath}`);
    }
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    const previousVersion = String(parsed.version ?? '');
    const isPrivate = Boolean(parsed.private);
    const changed = previousVersion !== target;

    if (write && changed) {
      const updated = { ...parsed, version: target };
      const serialized = `${JSON.stringify(updated, null, 2)}\n`;
      writeAtomicJson(absPath, serialized);

      const readBack = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      if (readBack.version !== target) {
        throw new Error(
          `Read-back verification failed for ${spec.relPath}: expected "${target}", got "${readBack.version}"`
        );
      }
    }

    entries.push({
      relPath: spec.relPath,
      name: String(parsed.name ?? ''),
      publishable: spec.publishable && !isPrivate,
      private: isPrivate,
      previousVersion,
      targetVersion: target,
      changed,
      written: Boolean(write && changed),
    });
  }

  const publishablePackages = entries.filter((e) => e.publishable);
  const privatePackages = entries.filter((e) => !e.publishable);

  return {
    mode: write ? 'write' : 'dry-run',
    target,
    distTag,
    explicitTag: `v${target}`,
    explicitTagPushCommand: `git push origin v${target}`,
    totalManifests: entries.length,
    publishableCount: publishablePackages.length,
    privateCount: privatePackages.length,
    entries,
  };
}

function printUsage() {
  console.log(
    [
      'Usage: node tools/release/prepare-v1-release.mjs [options]',
      '',
      'Options:',
      '  --target <1.0.0|1.0.0-rc.1>   Target release version (default: 1.0.0)',
      '  --dry-run                     Preview version updates without modifying files (default)',
      '  --write, --apply-version      Write target version to workspace package.json files',
      '  --root <dir>                  Override repository root directory (for isolated tests)',
      '  --json                        Output machine-readable JSON summary',
      '  -h, --help                    Show this help message',
    ].join('\n')
  );
}

function formatTextReport(result) {
  const lines = [
    `RouterSync v1 Release Preparation (${result.mode.toUpperCase()})`,
    `Target version : ${result.target}`,
    `npm dist-tag   : ${result.distTag}`,
    `Publishable    : ${result.publishableCount} packages`,
    `Private        : ${result.privateCount} packages`,
    '',
  ];

  for (const entry of result.entries) {
    const scopeLabel = entry.publishable ? 'publish' : 'private';
    const actionLabel = entry.written
      ? 'UPDATED'
      : entry.changed
        ? 'WOULD-UPDATE'
        : 'UNCHANGED';
    lines.push(
      `  [${scopeLabel}] ${entry.name.padEnd(32)} ${entry.previousVersion} -> ${entry.targetVersion} (${actionLabel})`
    );
  }

  lines.push('');
  lines.push('Owner-only explicit tag command (never run by bots):');
  lines.push(`  git tag -a ${result.explicitTag} -m "Release ${result.explicitTag}"`);
  lines.push(`  ${result.explicitTagPushCommand}`);

  return lines.join('\n');
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printUsage();
      process.exit(0);
    }
    const result = prepareV1Release({
      target: opts.target,
      write: opts.write,
      root: opts.root,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextReport(result));
    }
  } catch (err) {
    console.error(`[prepare-v1-release] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
