/**
 * packages/cli/test/roundC3k-scan.test.ts
 * C3k K2c: stepExistsLabel follows the scan conclusion (bzl case).
 * C3k K3: normalize/suggest for replacement hints.
 */
import { describe, it, expect, vi } from 'vitest';
import { stepExistsLabel } from '../src/sync/step-exists.js';
import { normalizeModelId, suggestReplacements } from '../src/commands/dead-models.js';
import { runScanCommand } from '../src/commands/scan.js';

describe('B5.1 --per-node guard', () => {
  it('missing target -> exit code 2 and usage message', async () => {
    const savedExit = process.exitCode;
    const savedEnv = process.env['ROUTERSYNC_PER_NODE_TARGETS'];
    delete process.env['ROUTERSYNC_PER_NODE_TARGETS'];
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    });
    process.exitCode = undefined;
    try {
      await runScanCommand({ perNode: true });
      expect(process.exitCode).toBe(2);
      expect(errs.join('\n')).toContain('--per-node requires target parameter');
    } finally {
      spy.mockRestore();
      process.exitCode = savedExit;
      if (savedEnv === undefined) delete process.env['ROUTERSYNC_PER_NODE_TARGETS'];
      else process.env['ROUTERSYNC_PER_NODE_TARGETS'] = savedEnv;
    }
  });
});

describe('K2c step follows the scan conclusion', () => {
  it('bzl: catalog from failed scan (HTTP 0) -> STALE-SCAN, never EXISTS-IN-SCAN', () => {
    const set = new Set(['bzl/model-a', 'bzl/model-b']);
    expect(stepExistsLabel(0, set, 'bzl/model-a', 'model-a')).toBe('STALE-SCAN');
  });
  it('bzl: no catalog at all -> NOT-SCANNED', () => {
    expect(stepExistsLabel(undefined, null, 'bzl/x', 'x')).toBe('NOT-SCANNED');
  });
  it('valid 200 scan: step present -> EXISTS-IN-SCAN; missing -> ABSENT-UNCONFIRMED', () => {
    const set = new Set(['node-a/deepseek-v4-flash']);
    expect(stepExistsLabel(200, set, 'node-a/deepseek-v4-flash', 'deepseek-v4-flash')).toBe('EXISTS-IN-SCAN');
    expect(stepExistsLabel(200, set, 'node-a/nope', 'nope')).toBe('ABSENT-UNCONFIRMED');
  });
  it('429 / 404 are not valid conclusions', () => {
    const set = new Set(['x/a']);
    // C3s S4d: 429 (QUOTA, không có danh sách) -> QUOTA-NO-LIST, không phải STALE-SCAN.
    expect(stepExistsLabel(429, set, 'x/a', 'a')).toBe('QUOTA-NO-LIST');
    expect(stepExistsLabel(404, set, 'x/a', 'a')).toBe('STALE-SCAN');
  });
});

describe('L1a namespace models/ in matcher', () => {
  it('gemini/gemini-2.5-flash vs catalog models/gemini-2.5-flash -> EXISTS-IN-SCAN', () => {
    expect(stepExistsLabel(200, new Set(['models/gemini-2.5-flash']), 'gemini/gemini-2.5-flash', 'gemini-2.5-flash')).toBe('EXISTS-IN-SCAN');
  });
  it('variant suffix never stripped in matcher: -free step vs bare catalog -> ABSENT', () => {
    expect(stepExistsLabel(200, new Set(['deepseek-v4-flash']), 'node-a/deepseek-v4-flash-free', 'deepseek-v4-flash-free')).toBe('ABSENT-UNCONFIRMED');
  });
  it('-sale step vs bare catalog -> ABSENT', () => {
    expect(stepExistsLabel(200, new Set(['beam']), 'node-a/beam-sale', 'beam-sale')).toBe('ABSENT-UNCONFIRMED');
  });
});
describe('K3 normalize + suggest', () => {
  it('node-a: -free suffix stripped', () => {
    expect(normalizeModelId('deepseek-v4-flash-free')).toBe('deepseek-v4-flash');
  });
  it('openrouter: :free stripped', () => {
    expect(normalizeModelId('meta-llama/llama-3:free')).toBe('meta-llama/llama-3');
  });
  it('gemini: models/ prefix stripped', () => {
    expect(normalizeModelId('models/gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });
  it('suggest: rename-only (node-a -free vs bare) found; unrelated not found', () => {
    const live = ['deepseek-v4-flash', 'qwen3-30b', 'deepseek-v4-flash-preview'];
    expect(suggestReplacements('deepseek-v4-flash-free', live)).toContain('deepseek-v4-flash');
    expect(suggestReplacements('missing-model-xyz', live)).toEqual([]);
    expect(suggestReplacements('deepseek-v4-flash-free', live).length).toBeLessThanOrEqual(3);
  });
});
