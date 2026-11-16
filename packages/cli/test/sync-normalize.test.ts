/**
 * packages/cli/test/sync-normalize.test.ts
 *
 * ROUND 56 rule R6: the namespace normalizer is pure and must map the three
 * identifier shapes (combo step, provider form, catalog key) onto one key.
 * This is the only test added in ROUND 56.
 */

import { describe, it, expect } from 'vitest';
import {
  splitStep,
  normalizeModelName,
  comparisonKey,
  parseComboStep,
  catalogKey,
  stepExistsIn,
} from '../src/sync/normalize.js';

describe('splitStep', () => {
  it('splits at the first slash and keeps nested segments in the model', () => {
    expect(splitStep('nvidia/deepseek-ai/deepseek-v4.1-flash')).toEqual({
      prefix: 'nvidia',
      model: 'deepseek-ai/deepseek-v4.1-flash',
    });
  });

  it('lower-cases the prefix only', () => {
    expect(splitStep('AIHM/Kimi-K2')).toEqual({ prefix: 'aihm', model: 'Kimi-K2' });
  });

  it('returns an empty prefix when there is no namespace', () => {
    expect(splitStep('gpt-4o')).toEqual({ prefix: '', model: 'gpt-4o' });
  });
});

describe('normalizeModelName', () => {
  it('lower-cases and trims', () => {
    expect(normalizeModelName('  Qwen/Qwen3.8-Max  ')).toBe('qwen/qwen3.8-max');
  });

  it('drops the Google models/ namespace from both sides', () => {
    expect(normalizeModelName('models/gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(normalizeModelName('gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });

  it('drops the Cloudflare @cf/ namespace', () => {
    expect(normalizeModelName('@cf/zai-org/glm-5.2')).toBe('zai-org/glm-5.2');
    expect(normalizeModelName('zai-org/glm-5.2')).toBe('zai-org/glm-5.2');
  });

  it('drops OpenRouter routing variants', () => {
    expect(normalizeModelName('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(
      'nvidia/nemotron-3-ultra-550b-a55b'
    );
  });

  it('does not reduce a bare variant token to an empty string', () => {
    expect(normalizeModelName(':free')).toBe(':free');
  });
});

describe('comparison keys collapse the three identifier shapes', () => {
  it('combo step and live id share a key', () => {
    const step = parseComboStep('gemini/models/gemini-3.8-flash');
    const live = comparisonKey('gemini', 'gemini-3.8-flash');
    expect(step.key).toBe(live);
  });

  it('catalog key carries the same provider and normalized model', () => {
    expect(catalogKey('NVIDIA', 'deepseek-ai/DeepSeek-V4.1-Flash')).toBe(
      'nvidia:deepseek-ai/deepseek-v4.1-flash'
    );
    expect(parseComboStep('nvidia/deepseek-ai/DeepSeek-V4.1-Flash').key).toBe(
      'nvidia/deepseek-ai/deepseek-v4.1-flash'
    );
  });

  it('the same model under two namespaces stays distinct', () => {
    const a = parseComboStep('groq/openai/gpt-oss-120b');
    const b = parseComboStep('nvidia/openai/gpt-oss-120b');
    expect(a.key).not.toBe(b.key);
  });
});

describe('stepExistsIn', () => {
  const live = new Set([
    comparisonKey('cohere', 'c4ai-aya-expanse-32b'),
    comparisonKey('cohere', 'command-a-03-2025'),
  ]);

  it('matches a live model', () => {
    expect(stepExistsIn(parseComboStep('cohere/command-a-03-2025'), live)).toBe(true);
  });

  it('does not match a delisted model', () => {
    expect(stepExistsIn(parseComboStep('cohere/command-r-08-2024'), live)).toBe(false);
  });

  it('does not match across providers', () => {
    expect(stepExistsIn(parseComboStep('nvidia/command-a-03-2025'), live)).toBe(false);
  });
});

// R57: node-a strips -free suffix from its live list. The combo step has -free;
// the live list does not. These must NOT match (removal is correct).
describe('R57 node-a variant suffix mismatch', () => {
  it('node-a combo step with -free does not match live key without -free', () => {
    // Live: node-a returns 'deepseek-v4.1-flash' (no -free)
    const liveKey = comparisonKey('node-a', 'deepseek-v4.1-flash');
    // Combo step: 'node-a/deepseek-v4.1-flash-free'
    const step = parseComboStep('node-a/deepseek-v4.1-flash-free');
    // -free is a VARIANT_SUFFIX only when it is the last token after a colon.
    // 'deepseek-v4.1-flash-free' ends with '-free' not ':-free', so it is NOT
    // stripped by normalizeModelName. The keys differ → removal is correct.
    expect(step.key).not.toBe(liveKey);
  });

  it('node-a combo step without -free matches live key', () => {
    const liveKey = comparisonKey('node-a', 'deepseek-v4.1-flash');
    const step = parseComboStep('node-a/deepseek-v4.1-flash');
    expect(step.key).toBe(liveKey);
  });
});
