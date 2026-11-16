/**
 * packages/core/test/path-inside-dir.test.ts
 *
 * C4n/N8: the directory-restriction check of the SQLite driver.
 *
 * The old check was `resolvedPath.startsWith(resolvedAllowedDir)` on
 * lowercased strings. Two bugs:
 *   - a sibling directory with the same prefix passed: `/tmp/abc` was
 *     accepted for the allowed dir `/tmp/ab`;
 *   - lowercasing made the comparison case-insensitive on Linux, where the
 *     filesystem IS case-sensitive.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isPathInsideDir } from '../src/sqlite/better-sqlite3.js';

describe('C4n/N8: isPathInsideDir', () => {
  const dir = path.resolve('/tmp/allowed');

  it('accepts a file directly inside the directory', () => {
    expect(isPathInsideDir(path.join(dir, 'db.sqlite'), dir)).toBe(true);
  });

  it('accepts a file in a nested subdirectory', () => {
    expect(isPathInsideDir(path.join(dir, 'sub', 'db.sqlite'), dir)).toBe(true);
  });

  it('accepts the directory itself', () => {
    expect(isPathInsideDir(dir, dir)).toBe(true);
  });

  it('rejects a sibling directory with the same prefix', () => {
    // The old startsWith() check accepted this.
    expect(isPathInsideDir(path.resolve('/tmp/allowed-other', 'db.sqlite'), dir)).toBe(false);
    expect(isPathInsideDir(path.resolve('/tmp/allowedXYZ', 'db.sqlite'), dir)).toBe(false);
  });

  it('rejects a path outside the directory', () => {
    expect(isPathInsideDir(path.resolve('/tmp/elsewhere/db.sqlite'), dir)).toBe(false);
    expect(isPathInsideDir(path.resolve('/var/data/db.sqlite'), dir)).toBe(false);
  });

  it('rejects a parent directory', () => {
    expect(isPathInsideDir(path.resolve('/tmp'), dir)).toBe(false);
  });

  it('rejects a relative path that escapes the directory', () => {
    expect(isPathInsideDir(path.join(dir, '..', 'escaped.sqlite'), dir)).toBe(false);
  });
});
