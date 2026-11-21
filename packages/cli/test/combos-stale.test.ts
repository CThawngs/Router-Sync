import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouterModelState } from '@routersync/core';
import {
  buildStaleReport,
  classifyComboStep,
  parseStaleSource,
  runCombosStaleCommand,
  serializeStaleReport,
  serializeStaleReportJson,
} from '../src/commands/combos-stale.js';

function state(overrides: Partial<RouterModelState> = {}): RouterModelState {
  return {
    router: '9router',
    enabledModels: new Set(),
    disabledModels: new Set(),
    comboModels: new Set(),
    customModels: new Set(),
    catalogModels: new Set(),
    availableModels: new Set(),
    connectionEnabledModels: new Set(),
    classify: () => ({ tier: 'A', inCombo: true, inconsistent: false }),
    ...overrides,
  } as RouterModelState;
}

describe('C15 Q4: combos stale statuses', () => {
  it('classifies the four statuses', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash', 'groq/llama-3.1-8b']),
      disabledModels: new Set(['gemini/gemini-2.5-pro']),
      comboModels: new Set([
        'gemini/gemini-2.5-flash',
        'gemini/models/gemini-2.5-flash',
        'gemini/gemini-2.5-pro',
        'groq/unknown-model',
      ]),
    });
    expect(classifyComboStep('gemini/gemini-2.5-flash', s)).toBe('PRESENT');
    expect(classifyComboStep('gemini/models/gemini-2.5-flash', s)).toBe('PRESENT-NORMALIZED');
    expect(classifyComboStep('gemini/gemini-2.5-pro', s)).toBe('DISABLED');
    expect(classifyComboStep('groq/unknown-model', s)).toBe('ABSENT');
  });

  it('reports counts that match rows', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash', 'groq/llama-3.1-8b']),
      comboModels: new Set(['gemini/gemini-2.5-flash', 'groq/unknown']),
    });
    const report = buildStaleReport(['9router'], new Map([['9router', s]]));
    expect(report.rows).toHaveLength(2);
    expect(report.counts.PRESENT).toBe(1);
    expect(report.counts.ABSENT).toBe(1);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.rows.length);
    expect(report.source).toBe('direct');
    expect(report.note).toContain('directly available router state');
  });

  it('says UNVERIFIABLE is not ABSENT when any row is UNVERIFIABLE (C32 M3.2)', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash']),
      comboModels: new Set(['gemini/gemini-2.5-flash', 'hf/some-model']),
    });
    const report = buildStaleReport(['9router'], new Map([['9router', s]]));
    expect(report.counts.UNVERIFIABLE).toBeGreaterThan(0);
    expect(report.note).toMatch(/UNVERIFIABLE \(\d+ rows\)/);
    expect(report.note).toMatch(/NOT the same as ABSENT/);
    expect(report.note).toMatch(/never a removal argument/);
  });

  it('does not add the UNVERIFIABLE note when every row has evidence', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash']),
      comboModels: new Set(['gemini/gemini-2.5-flash']),
    });
    const report = buildStaleReport(['9router'], new Map([['9router', s]]));
    expect(report.counts.UNVERIFIABLE).toBe(0);
    expect(report.note).not.toMatch(/UNVERIFIABLE \(/);
  });

  it('labels direct and snapshot reports with their evidence source', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash']),
      comboModels: new Set(['gemini/gemini-2.5-flash']),
    });
    const states = new Map([['9router', s]]);

    const direct = buildStaleReport(['9router'], states, 'direct');
    const snapshot = buildStaleReport(['9router'], states, 'snapshot');

    expect(direct.source).toBe('direct');
    expect(snapshot.source).toBe('snapshot');
    expect(snapshot.note).toContain('unknown-to-snapshot');
  });

  it.each(['direct', 'snapshot'] as const)(
    'writes source=%s as the first line and in the JSON payload',
    (source) => {
      const s = state({
        availableModels: new Set(['gemini/gemini-2.5-flash']),
        comboModels: new Set(['gemini/gemini-2.5-flash']),
      });
      const report = buildStaleReport(['9router'], new Map([['9router', s]]), source);
      const output = serializeStaleReport(report);
      const lines = output.split('\n');

      expect(lines[0]).toBe(`source=${source}`);
      expect(JSON.parse(lines.slice(1).join('\n')).source).toBe(source);
    }
  );

  it('keeps strict --json output parseable as one JSON document', () => {
    const s = state({
      availableModels: new Set(['gemini/gemini-2.5-flash']),
      comboModels: new Set(['gemini/gemini-2.5-flash']),
    });
    const report = buildStaleReport(['9router'], new Map([['9router', s]]), 'snapshot');
    const parsed = JSON.parse(serializeStaleReportJson(report));

    expect(parsed.source).toBe('snapshot');
    expect(parsed.rows).toHaveLength(1);
  });

  it('omits routers without an availability reader instead of reporting false ABSENT rows', () => {
    const report = buildStaleReport([], new Map(), 'direct', ['omniroute']);

    expect(report.routers).toEqual([]);
    expect(report.omittedRouters).toEqual(['omniroute']);
    expect(report.rows).toEqual([]);
    expect(report.counts.ABSENT).toBe(0);
    expect(report.note).toContain('without an availability reader');
  });

  it('reports OmniRoute as unreadable when its database is missing (C31 L1)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'rs-omni-missing-'));
    try {
      const report = await runCombosStaleCommand({
        router: 'omniroute',
        env: { ROUTERSYNC_OMNIROUTE_DB: join(dir, 'storage.sqlite') },
      });

      // It has a reader now: it must be named, not omitted, and it must not
      // claim ABSENT for models it could not see.
      expect(report.routers).toEqual(['omniroute']);
      expect(report.omittedRouters).toEqual([]);
      expect(report.rows).toEqual([]);
      expect(report.counts.ABSENT).toBe(0);
      expect(report.status).toBe('UNKNOWN');
      expect(report.unavailable.map((u) => u.router)).toContain('omniroute');
      expect(report.unavailable[0]?.reason).toMatch(/could not be opened|not resolved/);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('accepts only the documented source values', () => {
    expect(parseStaleSource('direct')).toBe('direct');
    expect(parseStaleSource('snapshot')).toBe('snapshot');
    expect(() => parseStaleSource('registry')).toThrow(/direct.*snapshot/);
  });
});
