/**
 * packages/core/src/consent/sandbox-guard.ts
 *
 * Hermetic Sandbox Guard for controlled writes (`assertControlledWriteSandbox`)
 * and shared canonical `tick-plan.json` SHA-256 hash computation.
 *
 * Guarantees:
 *  - Unconditionally rejects OpenMausBot runtime-owned `bots.json` and `routines.json`
 *    (checked against both lexical and symlink-resolved basenames).
 *  - Resolves `fs.realpathSync.native` on the deepest existing ancestor directory
 *    (and follows dangling symlinks) before comparing against canonical `os.tmpdir()`,
 *    supporting non-existent files under macOS `/var/folders -> /private/var/folders`
 *    and Windows 8.3 short temp paths while blocking directory symlink/junction escapes.
 *  - Rejects real host live router DB locations and any path outside `os.tmpdir()`
 *    unless the explicit WP9 owner live-pilot environment flag is set.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertNotLiveRouterDb,
  isPathInsideDir,
  isSameDbFile,
} from '../sqlite/better-sqlite3.js';
import { ConsentValidationError } from './types.js';

const FORBIDDEN_RUNTIME_FILENAMES = new Set(['bots.json', 'routines.json']);

function stripWindowsExtendedPrefix(rawPath: string): string {
  if (rawPath.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + rawPath.slice(8);
  }
  if (rawPath.startsWith('\\\\?\\')) {
    return rawPath.slice(4);
  }
  return rawPath;
}

/**
 * Resolves `targetPath` to its deepest canonical real path on disk by walking
 * upward through non-existent trailing path segments until finding the nearest
 * existing ancestor (or dangling symlink), resolving via `fs.realpathSync.native`
 * (or `fs.readlinkSync`), and re-attaching remaining relative segments.
 */
export function resolveDeepCanonicalPath(targetPath: string, depth = 0): string {
  if (depth > 40) {
    throw new ConsentValidationError(
      'SANDBOX_OUTSIDE_TMPDIR',
      `SANDBOX_OUTSIDE_TMPDIR: Too many symbolic link levels while resolving path: ${targetPath}`
    );
  }
  const abs = path.resolve(stripWindowsExtendedPrefix(targetPath));
  const tailSegments: string[] = [];
  let cur = abs;

  while (true) {
    try {
      const realAncestor = stripWindowsExtendedPrefix(fs.realpathSync.native(cur));
      return tailSegments.length > 0
        ? path.join(realAncestor, ...tailSegments.reverse())
        : realAncestor;
    } catch {
      const lstat = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (lstat?.isSymbolicLink()) {
        const rawLink = fs.readlinkSync(cur);
        const linkedTarget = path.resolve(path.dirname(cur), rawLink);
        const resolvedLink = resolveDeepCanonicalPath(linkedTarget, depth + 1);
        return tailSegments.length > 0
          ? path.join(resolvedLink, ...tailSegments.reverse())
          : resolvedLink;
      }
      const parent = path.dirname(cur);
      if (parent === cur) {
        return tailSegments.length > 0 ? path.join(cur, ...tailSegments.reverse()) : cur;
      }
      tailSegments.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function normalizeTickPlanConfigPath(rawConfigPath: string | undefined): string {
  if (typeof rawConfigPath !== 'string') return '';
  const trimmed = rawConfigPath.trim();
  if (trimmed.length === 0) return '';
  return path.resolve(stripWindowsExtendedPrefix(trimmed));
}

export interface CanonicalTickRouterActionInput {
  router: string;
  comboName: string;
  provider: string;
  modelId: string;
  action: string;
}

export interface CanonicalTickHarnessActionInput {
  harnessId: string;
  configPath?: string | undefined;
  providerId: string;
  modelId: string;
  action: string;
}

export function computeCanonicalTickPlanHash(plan: {
  routerActions?: CanonicalTickRouterActionInput[] | undefined;
  harnessActions?: CanonicalTickHarnessActionInput[] | undefined;
}): string | null {
  if (!Array.isArray(plan.routerActions) || !Array.isArray(plan.harnessActions)) {
    return null;
  }
  const canonicalPayload = JSON.stringify({
    routerActions: plan.routerActions.map((a) => ({
      router: a.router,
      comboName: a.comboName,
      provider: a.provider,
      modelId: a.modelId,
      action: a.action,
    })),
    harnessActions: plan.harnessActions.map((a) => ({
      harnessId: a.harnessId,
      configPath: normalizeTickPlanConfigPath(a.configPath),
      providerId: a.providerId,
      modelId: a.modelId,
      action: a.action,
    })),
  });
  return crypto.createHash('sha256').update(canonicalPayload).digest('hex').slice(0, 16);
}

function getRealHostLiveRouterDbs(): string[] {
  const realHome = os.homedir();
  return [
    path.join(realHome, '.9router', 'db', 'data.sqlite'),
    path.join(realHome, 'AppData', 'Roaming', '9router', 'db', 'data.sqlite'),
    path.join(realHome, '.omniroute', 'storage.sqlite'),
    path.join(realHome, 'AppData', 'Roaming', 'omniroute', 'storage.sqlite'),
  ];
}

export function assertControlledWriteSandbox(
  targetPath: string,
  kind: 'router-db' | 'harness-config',
  env: NodeJS.ProcessEnv = process.env
): void {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new ConsentValidationError(
      'SANDBOX_OUTSIDE_TMPDIR',
      'SANDBOX_OUTSIDE_TMPDIR: Target write path is empty.'
    );
  }

  const deepTarget = resolveDeepCanonicalPath(targetPath);
  const lexicalBase = path.basename(targetPath).toLowerCase();
  const realBase = path.basename(deepTarget).toLowerCase();
  for (const baseName of [lexicalBase, realBase]) {
    if (FORBIDDEN_RUNTIME_FILENAMES.has(baseName)) {
      throw new ConsentValidationError(
        'FORBIDDEN_RUNTIME_FILE',
        `FORBIDDEN_RUNTIME_FILE: Refusing to touch OpenMausBot runtime-owned file '${baseName}'.`
      );
    }
  }

  const deepTmp = resolveDeepCanonicalPath(os.tmpdir());

  if (kind === 'router-db') {
    const allowLiveRouter = env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] === '1';
    if (!allowLiveRouter) {
      const foldCase = process.platform === 'win32' || process.platform === 'darwin';
      const normDeepTarget = foldCase ? deepTarget.toLowerCase() : deepTarget;
      for (const realLiveDb of getRealHostLiveRouterDbs()) {
        const deepLiveDb = resolveDeepCanonicalPath(realLiveDb);
        const normDeepLiveDb = foldCase ? deepLiveDb.toLowerCase() : deepLiveDb;
        if (normDeepTarget === normDeepLiveDb || isSameDbFile(targetPath, realLiveDb)) {
          throw new ConsentValidationError(
            'SANDBOX_OUTSIDE_TMPDIR',
            `SANDBOX_OUTSIDE_TMPDIR: Refusing to write real host live router database '${targetPath}' without ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1.`
          );
        }
      }
      if (!isPathInsideDir(deepTarget, deepTmp)) {
        try {
          assertNotLiveRouterDb(targetPath);
        } catch (err) {
          throw new ConsentValidationError(
            'SANDBOX_OUTSIDE_TMPDIR',
            `SANDBOX_OUTSIDE_TMPDIR: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        throw new ConsentValidationError(
          'SANDBOX_OUTSIDE_TMPDIR',
          `SANDBOX_OUTSIDE_TMPDIR: Controlled router DB write path must reside inside os.tmpdir() unless ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1.`
        );
      }
    }
    return;
  }

  const allowLiveHome = env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'] === '1';
  if (!allowLiveHome && !isPathInsideDir(deepTarget, deepTmp)) {
    throw new ConsentValidationError(
      'SANDBOX_OUTSIDE_TMPDIR',
      `SANDBOX_OUTSIDE_TMPDIR: Controlled harness config write path must reside inside os.tmpdir() unless ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1.`
    );
  }
}
