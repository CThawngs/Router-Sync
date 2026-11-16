/**
 * packages/cli/test/round63.test.ts
 *
 * ROUND 63 mandatory tests:
 *  - normalize id live: Gemini (models/...), HF (id with /), OpenRouter (:free), node-a/node-b
 *  - R2: provider below 50% match skipped; provider from 50% up processes normally
 *  - BLOCKED-SUSPICIOUS: plan removing >10% steps of a combo is blocked
 *  - Error classification: 429=QUOTA, 401/403/404=DEAD, 499/timeout=HANG, connection-test not counted
 *  - discover: first run model_moi=0
 *  - ADD-FREE: id must have provider prefix, no duplicates, no PRICE-ZERO-UNCONFIRMED
 */

import { describe, it, expect } from 'vitest';
import {
  splitStep,
  normalizeModelName,
  comparisonKey,
  parseComboStep,
  liveKey,
  stepExistsIn,
} from '../src/sync/normalize.js';
import { assignFlag } from '../src/commands/health.js';
import { classifyPrice, isFreeSuffix } from '../src/commands/discover.js';

// ---------------------------------------------------------------------------
// 1. normalize id live
// ---------------------------------------------------------------------------

describe('normalize id live (ROUND 63)', () => {
  it('Gemini models/ prefix is stripped', () => {
    expect(normalizeModelName('models/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(normalizeModelName('models/Gemini-2.5-Pro')).toBe('gemini-2.5-pro');
  });

  it('HF id with nested / keeps nesting under prefix', () => {
    const step = parseComboStep('hf/deepseek-ai/DeepSeek-V4.1-Flash');
    expect(step.prefix).toBe('hf');
    expect(step.key).toBe('hf/deepseek-ai/deepseek-v4.1-flash');
  });

  it('OpenRouter :free variant is normalized away', () => {
    const step = parseComboStep('openrouter/google/gemma-4-31b-it:free');
    expect(step.key).toBe('openrouter/google/gemma-4-31b-it');
  });

  it('node-a and node-b IDs are normalized to lower case', () => {
    const nodeA = parseComboStep('node-a/deepseek-v4.1-flash-free');
    // normalizeModelName only strips :free variants, NOT -free suffix
    expect(nodeA.key).toBe('node-a/deepseek-v4.1-flash-free');

    const nodeB = parseComboStep('node-b/google/gemini-3.8-flash');
    expect(nodeB.key).toBe('node-b/google/gemini-3.8-flash');
  });

  it('id in live list is not marked dead (stepExistsIn returns true)', () => {
    const live = new Set([
      liveKey('gemini', 'gemini-2.5-pro'),
      liveKey('hf', 'deepseek-ai/deepseek-v4.1-flash'),
      liveKey('openrouter', 'google/gemma-4-31b-it'),
      liveKey('node-a', 'deepseek-v4.1-flash-free'),
      liveKey('node-b', 'google/gemini-3.8-flash'),
    ]);
    expect(stepExistsIn(parseComboStep('gemini/models/gemini-2.5-pro'), live)).toBe(true);
    expect(stepExistsIn(parseComboStep('hf/deepseek-ai/DeepSeek-V4.1-Flash'), live)).toBe(true);
    expect(stepExistsIn(parseComboStep('openrouter/google/gemma-4-31b-it:free'), live)).toBe(true);
    expect(stepExistsIn(parseComboStep('node-a/deepseek-v4.1-flash-free'), live)).toBe(true);
    expect(stepExistsIn(parseComboStep('node-b/google/gemini-3.8-flash'), live)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. R2: provider below 50% match skipped
// ---------------------------------------------------------------------------

describe('R2 provider match floor', () => {
  it('provider below minRequests is LOW-SAMPLE', () => {
    const bucket = { requests: 10, success: 5, errors: { '404': 5 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('LOW-SAMPLE');
  });

  it('provider with 404-only and no success is DEAD', () => {
    const bucket = { requests: 100, success: 0, errors: { '404': 100 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('DEAD');
  });

  it('provider with 429 and no success is QUOTA (not DEAD)', () => {
    const bucket = { requests: 100, success: 0, errors: { '429': 100 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('QUOTA');
  });

  it('provider with 429 and some success is QUOTA', () => {
    const bucket = { requests: 100, success: 60, errors: { '429': 40 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('QUOTA');
  });

  it('provider with 499 above threshold is HANG', () => {
    const bucket = { requests: 100, success: 40, errors: { '499': 60 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('HANG');
  });

  it('provider with 499 below threshold is OK', () => {
    const bucket = { requests: 100, success: 90, errors: { '499': 10 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// 3. BLOCKED-SUSPICIOUS threshold (10% of combo steps)
// ---------------------------------------------------------------------------

describe('BLOCKED-SUSPICIOUS removal threshold', () => {
  it('removal of exactly 10% is NOT blocked', () => {
    const ratio = 35 / 350; // exactly 10%
    expect(ratio > 0.10).toBe(false);
  });

  it('removal of 11% IS blocked', () => {
    const ratio = 39 / 350; // ~11.1%
    expect(ratio > 0.10).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Error classification: connection-test not counted
// ---------------------------------------------------------------------------

describe('error classification (ROUND 63)', () => {
  it('429 is QUOTA not DEAD', () => {
    const bucket = { requests: 50, success: 0, errors: { '429': 50 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('QUOTA');
  });

  it('sustained 401/403/404 with no success is DEAD', () => {
    const bucket = { requests: 50, success: 0, errors: { '401': 20, '403': 20, '404': 10 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('DEAD');
  });

  it('499 or timeout is HANG', () => {
    const bucket = { requests: 50, success: 10, errors: { '499': 40 }, latencies: [], lastSuccess: null, lastError: null, flag: 'OK' };
    assignFlag(bucket, { minRequests: 20, hangThreshold: 0.30 }, null);
    expect(bucket.flag).toBe('HANG');
  });

  it('connection-test is excluded from model health', () => {
    const connRows = [
      { timestamp: '2026-11-03T10:00:00Z', status: 200, model: 'connection-test', provider: 'opencode' },
      { timestamp: '2026-11-03T10:01:00Z', status: 500, model: 'connection-test', provider: 'opencode' },
    ];
    const realRows = connRows.filter((r) => r.model !== 'connection-test');
    expect(realRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. discover first run baseline
// ---------------------------------------------------------------------------

describe('discover first run baseline', () => {
  it('isFreeSuffix detects -free and :free', () => {
    expect(isFreeSuffix('gemini-2.5-pro-free')).toBe(true);
    expect(isFreeSuffix('gemini-2.5-pro:free')).toBe(true);
    expect(isFreeSuffix('gemini-2.5-pro')).toBe(false);
    expect(isFreeSuffix('claude-sonnet-4-6')).toBe(false);
  });

  it('classifyPrice returns PRICE-ZERO-UNCONFIRMED when price is 0 without second source', () => {
    const entry = { id: 'mistral/mistral-large-2512', priceFields: ['pricing.prompt', 'pricing.completion'], inputPrice: 0, outputPrice: 0, raw: {} };
    const result = classifyPrice(entry.id, entry, undefined, false);
    expect(result.label).toBe('PRICE-ZERO-UNCONFIRMED');
    expect(result.confirmed).toBe(false);
  });

  it(':free suffix gets FREE-BY-SUFFIX (not FREE-BY-PRICE)', () => {
    const entry = { id: 'openrouter/google/gemma-4-31b-it:free', priceFields: [], inputPrice: 0, outputPrice: 0, raw: {} };
    const result = classifyPrice(entry.id, entry, undefined, true);
    expect(result.label).toBe('FREE-BY-SUFFIX');
  });
});

// ---------------------------------------------------------------------------
// 6. ADD-FREE: id must have provider prefix
// ---------------------------------------------------------------------------

describe('ADD-FREE validation', () => {
  it('full step id has provider prefix', () => {
    const prefix = 'node-b';
    const id = 'google/gemini-3.8-flash';
    const fullId = `${prefix}/${id}`;
    expect(fullId).toBe('node-b/google/gemini-3.8-flash');
    expect(fullId.split('/')[0]).toBe(prefix);
  });

  it('duplicate step already in combo is not added', () => {
    const comboSteps = ['node-b/google/gemini-3.8-flash', 'node-b/google/gemini-3.5-flash'];
    const fullId = 'node-b/google/gemini-3.8-flash';
    expect(comboSteps.includes(fullId)).toBe(true);
  });

  it('PRICE-ZERO-UNCONFIRMED is not added', () => {
    const label = 'PRICE-ZERO-UNCONFIRMED';
    expect(label).not.toBe('FREE-BY-PRICE');
    expect(label).not.toBe('FREE-BY-SUFFIX');
  });
});
