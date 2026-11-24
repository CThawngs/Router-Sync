/**
 * packages/core/src/consent/sandbox-guard.ts
 *
 * Hermetic Sandbox Guard for controlled writes (`assertControlledWriteSandbox`).
 *
 * Guarantees:
 *  - Unconditionally rejects OpenMausBot runtime-owned `bots.json` and `routines.json`.
 *  - Rejects real host live router DB locations and any path outside `os.tmpdir()`
 *    unless the explicit WP9 owner live-pilot environment flag is set.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertNotLiveRouterDb,
  canonicalizePath,
  isPathInsideDir,
  isSameDbFile,
} from '../sqlite/better-sqlite3.js';
import { ConsentValidationError } from './types.js';

const FORBIDDEN_RUNTIME_FILENAMES = new Set(['bots.json', 'routines.json']);

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
    throw new ConsentValidationError('SANDBOX_OUTSIDE_TMPDIR', 'Target write path is empty.');
  }

  const baseName = path.basename(targetPath).toLowerCase();
  if (FORBIDDEN_RUNTIME_FILENAMES.has(baseName)) {
    throw new ConsentValidationError(
      'FORBIDDEN_RUNTIME_FILE',
      `Refusing to touch OpenMausBot runtime-owned file '${baseName}'.`
    );
  }

  const canonTarget = canonicalizePath(targetPath);
  const canonTmp = canonicalizePath(os.tmpdir());

  if (kind === 'router-db') {
    const allowLiveRouter = env['ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE'] === '1';
    if (!allowLiveRouter) {
      for (const realLiveDb of getRealHostLiveRouterDbs()) {
        if (isSameDbFile(targetPath, realLiveDb)) {
          throw new ConsentValidationError(
            'SANDBOX_OUTSIDE_TMPDIR',
            `Refusing to write real host live router database '${targetPath}' without ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1.`
          );
        }
      }
      if (!isPathInsideDir(canonTarget, canonTmp)) {
        try {
          assertNotLiveRouterDb(targetPath);
        } catch (err) {
          throw new ConsentValidationError(
            'SANDBOX_OUTSIDE_TMPDIR',
            err instanceof Error ? err.message : String(err)
          );
        }
        throw new ConsentValidationError(
          'SANDBOX_OUTSIDE_TMPDIR',
          `Controlled router DB write path must reside inside os.tmpdir() unless ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1.`
        );
      }
    }
    return;
  }

  const allowLiveHome = env['ROUTERSYNC_ALLOW_LIVE_HOME_WRITE'] === '1';
  if (!allowLiveHome && !isPathInsideDir(canonTarget, canonTmp)) {
    throw new ConsentValidationError(
      'SANDBOX_OUTSIDE_TMPDIR',
      `Controlled harness config write path must reside inside os.tmpdir() unless ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1.`
    );
  }
}
