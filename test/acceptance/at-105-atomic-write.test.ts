/**
 * test/acceptance/at-105-atomic-write.test.ts
 *
 * Acceptance test for atomic file write and formatting preservation (SPEC §32 / X3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  detectFormatting,
} from '@routersync/core';

describe('AT-105: Atomic file writes and format preservation (SPEC §32 / X3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-atomic-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('writes files atomically without leaving temp files on success', async () => {
    const targetFile = path.join(tmpDir, 'nested', 'config.json');
    const content = JSON.stringify({ mode: 'active', steps: 3 });

    await atomicWriteFile(targetFile, content);

    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, 'utf8')).toBe(content);

    // Verify no temporary files remain in folder
    const files = fs.readdirSync(path.dirname(targetFile));
    expect(files.length).toBe(1);
    expect(files[0]).toBe('config.json');
  });

  it('preserves line endings and UTF-8 BOM when updating existing file content', () => {
    // CRLF with BOM
    const crlfBom = '\uFEFFversion: 1\r\npolicy: manual\r\n';
    const fmt1 = detectFormatting(crlfBom);
    expect(fmt1.hasBom).toBe(true);
    expect(fmt1.eol).toBe('\r\n');

    // LF without BOM
    const lfPlain = 'version: 1\npolicy: manual\n';
    const fmt2 = detectFormatting(lfPlain);
    expect(fmt2.hasBom).toBe(false);
    expect(fmt2.eol).toBe('\n');
  });

  it('updates an existing file atomically, preserving content on uncorrupted rewrite', async () => {
    const targetFile = path.join(tmpDir, 'state.json');
    await atomicWriteFile(targetFile, 'initial');
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('initial');

    await atomicWriteFile(targetFile, 'updated_v2');
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('updated_v2');
  });

  it('writes files synchronously and atomically with atomicWriteFileSync', () => {
    const targetFile = path.join(tmpDir, 'sync', 'sync-config.json');
    const content = JSON.stringify({ synchronous: true, mode: 'strict' });

    atomicWriteFileSync(targetFile, content);

    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, 'utf8')).toBe(content);

    const files = fs.readdirSync(path.dirname(targetFile));
    expect(files.length).toBe(1);
    expect(files[0]).toBe('sync-config.json');
  });
});
