/**
 * test/acceptance/at-104-safe-filenames.test.ts
 *
 * Acceptance test for safe filename validation and slugification (SPEC §32 / X2).
 */

import { describe, it, expect } from 'vitest';
import {
  isSafeFilename,
  safeSlug,
  createSnapshotId,
} from '@routersync/core';

describe('AT-104: Safe filenames and cross-platform identifiers (SPEC §32 / X2)', () => {
  it('rejects Windows reserved filenames across platforms', () => {
    const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'aux.json', 'prn.log'];
    for (const name of reserved) {
      expect(isSafeFilename(name)).toBe(false);
      expect(isSafeFilename(name.toLowerCase())).toBe(false);
    }
  });

  it('rejects filenames with illegal characters, trailing dots, or trailing spaces', () => {
    const illegalChars = ['model:v1', 'file*test', 'name?id', 'hello<world>', 'pipe|line', 'slash/path', 'back\\slash'];
    for (const name of illegalChars) {
      expect(isSafeFilename(name)).toBe(false);
    }

    expect(isSafeFilename('test.')).toBe(false);
    expect(isSafeFilename('test ')).toBe(false);
    expect(isSafeFilename(' ')).toBe(false);
    expect(isSafeFilename('')).toBe(false);
    expect(isSafeFilename('a'.repeat(241))).toBe(false);
  });

  it('accepts valid, safe filenames', () => {
    const valid = [
      'snapshot-20261023T020000Z-a1b2c3d4.json',
      'catalog.sqlite',
      'openai-gpt-4o.json',
      'routersync-daemon.log',
      'config.yaml',
    ];
    for (const name of valid) {
      expect(isSafeFilename(name)).toBe(true);
    }
  });

  it('sanitizes arbitrary inputs into safe slugs without colons or reserved words', () => {
    expect(safeSlug('anthropic/claude-3.5-sonnet:beta')).toBe('anthropic-claude-3.5-sonnet-beta');
    expect(safeSlug('deepseek:v3 (chat+code)')).toBe('deepseek-v3-chat-code');
    expect(safeSlug('CON')).toBe('rs-con');
    expect(safeSlug('NUL')).toBe('rs-nul');
    expect(safeSlug('   ')).toBe('rs-item');
    expect(safeSlug('...')).toBe('rs-item');
  });

  it('generates colon-free, cross-platform snapshot identifiers (YYYYMMDDTHHMMSSZ-<8hex>)', () => {
    const id = createSnapshotId();
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(id.includes(':')).toBe(false);
    expect(isSafeFilename(`${id}.json`)).toBe(true);
  });
});
