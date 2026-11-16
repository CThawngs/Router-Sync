/**
 * packages/cli/test/router-db-path-guard.test.ts
 *
 * C4n/N5: the refusal branch of the write-target guard.
 *
 * `assertWriteTargetMatchesPlan` refuses a write when the file the writer
 * would touch is NOT the file the plan was computed from. Without that
 * refusal, a plan shown for one database could be applied to another.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { clearConfiguredRouterDbPaths, setConfiguredRouterDbPaths } from '@routersync/core';
import { assertWriteTargetMatchesPlan } from '../src/sync/write.js';

let tmpDir = '';

function makeFakeDb(file: string, comboName: string): void {
  const db = new Database(file);
  db.exec('CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, kind TEXT, models TEXT)');
  db.prepare('INSERT INTO combos (id, name, kind, models) VALUES (?, ?, ?, ?)').run(
    `routersync-${comboName}`,
    comboName,
    'custom',
    JSON.stringify(['a/model'])
  );
  db.close();
}

describe('C4n/N5: write-target guard refuses a mismatched database', () => {
  const origEnvDb = process.env['ROUTERSYNC_9ROUTER_DB'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c4n-guard-'));
    clearConfiguredRouterDbPaths();
  });

  afterEach(() => {
    if (origEnvDb === undefined) delete process.env['ROUTERSYNC_9ROUTER_DB'];
    else process.env['ROUTERSYNC_9ROUTER_DB'] = origEnvDb;
    clearConfiguredRouterDbPaths();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('accepts the write when the plan and the write target are the same file', () => {
    const dbFile = path.join(tmpDir, 'one.sqlite');
    makeFakeDb(dbFile, 'combo-one');
    setConfiguredRouterDbPaths({ '9router': dbFile });

    expect(() => assertWriteTargetMatchesPlan('9router', dbFile)).not.toThrow();
  });

  it('refuses the write when the plan was computed from a different database', () => {
    const plannedDb = path.join(tmpDir, 'planned.sqlite');
    const currentDb = path.join(tmpDir, 'current.sqlite');
    makeFakeDb(plannedDb, 'combo-planned');
    makeFakeDb(currentDb, 'combo-current');
    setConfiguredRouterDbPaths({ '9router': currentDb });

    expect(() => assertWriteTargetMatchesPlan('9router', plannedDb)).toThrow(/WRITE-GUARD/);
    expect(() => assertWriteTargetMatchesPlan('9router', plannedDb)).toThrow(/Refusing to write/);
  });

  it('is a no-op when the caller did not plan against a database', () => {
    const dbFile = path.join(tmpDir, 'one.sqlite');
    makeFakeDb(dbFile, 'combo-one');
    setConfiguredRouterDbPaths({ '9router': dbFile });

    expect(() => assertWriteTargetMatchesPlan('9router', undefined)).not.toThrow();
  });
});
