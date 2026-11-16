/**
 * test/harness/state-dir-setup.ts
 *
 * Owner brief 2026-10-15 §4b: the managed-id ledger write path is REAL product
 * code (the VITEST branch was removed from the 9Router adapter), so every test
 * run must redirect the state directory to a throwaway tmp dir. This also
 * exercises the ROUTERSYNC_STATE_DIR override on every run that writes the
 * ledger — the injection point the owner asked for (option or env var).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setDefaultRestrictDir } from '../../packages/core/src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-test-state-'));
process.env['ROUTERSYNC_STATE_DIR'] = tmp;
setDefaultRestrictDir(os.tmpdir());

