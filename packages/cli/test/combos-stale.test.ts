import { describe, it, expect } from 'vitest';
import type { RouterModelState } from '@routersync/core';
import { classifyComboStep, buildStaleReport } from '../src/commands/combos-stale.js';

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
      availableModels: new Set(['gemini/gemini-2.5-flash']),
      comboModels: new Set(['gemini/gemini-2.5-flash', 'groq/unknown']),
    });
    const report = buildStaleReport(['9router'], new Map([['9router', s]]));
    expect(report.rows).toHaveLength(2);
    expect(report.counts.PRESENT).toBe(1);
    expect(report.counts.ABSENT).toBe(1);
    expect(Object.values(report.counts).reduce((a, b) => a + b, 0)).toBe(report.rows.length);
    expect(report.note).toContain('unknown-to-snapshot');
  });
});
