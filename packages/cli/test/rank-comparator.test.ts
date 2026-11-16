/**
 * packages/cli/test/rank-comparator.test.ts
 *
 * Unit tests for:
 * 1. Policy §8.4 Strict Lexicographic Priority-Order Comparator (no weights)
 * 2. Decision D1 Provider Interleaving on Tail
 * 3. Gating filters (blacklist, non-chat, price-gate with zeroPaymentProviders)
 * 4. Invariant I3 enforcement (>= 2 steps)
 * 5. Dynamic Tier Assignment (§31 and custom)
 */

import { describe, it, expect } from 'vitest';
import {
  isBlacklisted,
  isNonChat,
  classifyPrice,
  extractProvider,
  DEFAULT_NON_CHAT_PATTERNS,
  DEFAULT_ZERO_PAYMENT_PROVIDERS,
} from '../src/rank/filters.js';
import {
  assignTier,
  computeModelScores,
  compareModelsLexicographic,
} from '../src/rank/comparator.js';
import {
  interleaveTailByProvider,
  applyRankingInterleave,
} from '../src/rank/interleave.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rankComboModels } from '../src/rank/ranker.js';
import { rankingConfigSchema, loadRankingConfig } from '../src/rank/config.js';
import type { ModelRankItem, RankingCriterion } from '../src/rank/types.js';

describe('Gating Filters (R59)', () => {
  const blacklist = ['space-bunny', 'union-alpha', 'minimax-m3.1', 'deepseek-v4-pro'];

  it('correctly identifies blacklisted models', () => {
    expect(isBlacklisted('space-bunny-70b', blacklist)).toBe(true);
    expect(isBlacklisted('oc/minimax-m3.1-flash', blacklist)).toBe(true);
    expect(isBlacklisted('deepseek-v4.1-flash', blacklist)).toBe(false);
  });

  it('supports "=" prefix for exact-match blacklist entries', () => {
    const exact = ['=nvidia/mistralai/mistral-large'];
    expect(isBlacklisted('nvidia/mistralai/mistral-large', exact)).toBe(true);
    expect(isBlacklisted('NVIDIA/MistralAI/Mistral-Large', exact)).toBe(true);
    // Prefix sibling must survive: substring matching would have killed it.
    expect(isBlacklisted('nvidia/mistralai/mistral-large-2-instruct', exact)).toBe(false);
    // Exact entry must not match a longer ID either.
    expect(isBlacklisted('oc/pulse-alpha-free', ['=pulse-alpha-free'])).toBe(false);
  });

  it('correctly identifies non-chat models including guard, transcribe, moderation', () => {
    const patterns = [...DEFAULT_NON_CHAT_PATTERNS];
    expect(isNonChat('openai/text-embedding-3-small', patterns)).toBe(true);
    expect(isNonChat('whisper-large-v3', patterns)).toBe(true);
    expect(isNonChat('meta/llama-guard-3-8b', patterns)).toBe(true);
    expect(isNonChat('groq/safeguard-prompt-guard-86m', patterns)).toBe(true);
    expect(isNonChat('groq/whisper-large-v3-turbo-transcribe', patterns)).toBe(true);
    expect(isNonChat('claude-sonnet-5-5-medium', patterns)).toBe(false);
  });

  it('correctly extracts provider prefix', () => {
    expect(extractProvider('ag/claude-sonnet-5-5-medium')).toEqual({
      provider: 'ag',
      modelName: 'claude-sonnet-5-5-medium',
    });
    expect(extractProvider('qwen3.8-max')).toEqual({
      provider: 'unknown',
      modelName: 'qwen3.8-max',
    });
  });

  it('classifies price: zero-payment-providers are FREE, missing price is PRICE_UNVERIFIED', () => {
    const zeroProviders = [...DEFAULT_ZERO_PAYMENT_PROVIDERS];

    // Providers in zeroPaymentProviders -> FREE
    expect(classifyPrice('gemini/gemini-4-argon', 'gemini', zeroProviders)).toBe('FREE');
    expect(classifyPrice('groq/qwen3.8-27b', 'groq', zeroProviders)).toBe('FREE');
    expect(classifyPrice('nvidia/deepseek-ai/deepseek-v4.1-flash', 'nvidia', zeroProviders)).toBe('FREE');
    expect(classifyPrice('ocz/flint-40b-free', 'ocz', zeroProviders)).toBe('FREE');
    expect(classifyPrice('cerebras/llama-3.3-70b', 'cerebras', zeroProviders)).toBe('FREE');

    // Suffix :free -> FREE
    expect(classifyPrice('openrouter/meta-llama/llama-3.3-70b:free', 'openrouter', zeroProviders)).toBe('FREE');
    expect(classifyPrice('bzl/gpt-oss-120b:free', 'bzl', zeroProviders)).toBe('FREE');

    // Unknown provider with no price metadata -> PRICE_UNVERIFIED (retained!)
    expect(classifyPrice('custom-prov/some-model', 'custom-prov', zeroProviders)).toBe('PRICE_UNVERIFIED');

    // Provider not in zeroPaymentProviders with confirmed positive price -> PAID
    expect(
      classifyPrice('openai/gpt-4o', 'openai', zeroProviders, {
        pricing: { prompt: '0.005', completion: '0.015' },
      })
    ).toBe('PAID');
  });
});

describe('Tier Assignment (§31 Human Hierarchy & Dynamic Tiers)', () => {
  const tierRules = {
    tier1_claude: ['claude-sonnet-5-5-medium', 'claude-opus-5-5-medium', 'claude-sonnet-4-6'],
    tier2_gemini4: ['gemini-4-argon-high', 'gemini-4-argon', 'gemini-4'],
    tier3_deepseek_v4_1: ['deepseek-v4.1-flash'],
    tier4_glm5_3: ['glm-5.3-flash', 'glm-5.3-free'],
    tier5_node_b_flagships: ['qwen3.8-max', 'qwen3-coder-plus', 'qwen3.8-omni-flash', 'qwen3.7-max'],
    tier6_fallback: [
      'gemini-3.8-flash',
      'ag/gemini-3.8-flash-high',
      'sambanova/gpt-oss-120b',
      'groq/qwen/qwen3.8-27b',
      'groq/openai/gpt-oss-120b',
      'bzl/',
      'openrouter/',
    ],
  };

  it('assigns Tier 1 to Claude models', () => {
    expect(assignTier('ag/claude-sonnet-5-5-medium', tierRules)).toBe(1);
    expect(assignTier('ag/claude-opus-5-5-medium', tierRules)).toBe(1);
  });

  it('assigns Tier 2 to Gemini 4 models', () => {
    expect(assignTier('gemini/gemini-4-argon', tierRules)).toBe(2);
  });

  it('assigns Tier 3 to DeepSeek V4.1', () => {
    expect(assignTier('nvidia/deepseek-ai/deepseek-v4.1-flash', tierRules)).toBe(3);
  });

  it('assigns Tier 4 to GLM 5.3', () => {
    expect(assignTier('provider-z/z-ai/glm-5.3-free', tierRules)).toBe(4);
  });

  it('assigns Tier 5 to node-b flagships', () => {
    expect(assignTier('node-b/qwen3-coder-plus', tierRules)).toBe(5);
  });

  it('assigns Tier 6 to Policy §31.6 resilient fallback models', () => {
    expect(assignTier('ag/gemini-3.8-flash', tierRules)).toBe(6);
    expect(assignTier('sambanova/gpt-oss-120b', tierRules)).toBe(6);
    expect(assignTier('groq/qwen/qwen3.8-27b', tierRules)).toBe(6);
    expect(assignTier('openrouter/meta-llama/llama-3.3-70b:free', tierRules)).toBe(6);
  });

  it('assigns 99 to unrated models when no rule matches', () => {
    expect(assignTier('some-obscure-model-v1', tierRules)).toBe(99);
  });
});

describe('Policy §8.4 Lexicographic Priority-Order Comparison (No Weights)', () => {
  const criteria: RankingCriterion[] = [
    { id: 'crit1', name: 'Criterion 1', priority: 1 },
    { id: 'crit2', name: 'Criterion 2', priority: 2 },
    { id: 'crit3', name: 'Criterion 3', priority: 3 },
  ];

  it('higher priority criterion strictly wins even if lower criteria have higher scores', () => {
    const itemA: ModelRankItem = {
      id: 'modelA',
      raw: 'modelA',
      provider: 'provA',
      tier: 1,
      scores: { crit1: 5, crit2: 1, crit3: 1 },
      totalScore: 0,
      originalIndex: 0,
      priceStatus: 'FREE',
      isDropped: false,
    };
    const itemB: ModelRankItem = {
      id: 'modelB',
      raw: 'modelB',
      provider: 'provB',
      tier: 2,
      scores: { crit1: 4, crit2: 10, crit3: 10 },
      totalScore: 0,
      originalIndex: 1,
      priceStatus: 'FREE',
      isDropped: false,
    };

    // itemA has crit1=5 > crit1=4 -> itemA must rank before itemB (negative result)
    const result = compareModelsLexicographic(itemA, itemB, criteria);
    expect(result).toBeLessThan(0);
  });

  it('checks next priority criterion only when higher priority criterion ties', () => {
    const itemA: ModelRankItem = {
      id: 'modelA',
      raw: 'modelA',
      provider: 'provA',
      tier: 1,
      scores: { crit1: 5, crit2: 3, crit3: 10 },
      totalScore: 0,
      originalIndex: 0,
      priceStatus: 'FREE',
      isDropped: false,
    };
    const itemB: ModelRankItem = {
      id: 'modelB',
      raw: 'modelB',
      provider: 'provB',
      tier: 1,
      scores: { crit1: 5, crit2: 4, crit3: 1 },
      totalScore: 0,
      originalIndex: 1,
      priceStatus: 'FREE',
      isDropped: false,
    };

    // crit1 ties (5 vs 5). crit2 decides: itemB (4) > itemA (3) -> itemB wins (positive result)
    const result = compareModelsLexicographic(itemA, itemB, criteria);
    expect(result).toBeGreaterThan(0);
  });
});

describe('Decision D1 Provider Interleaving', () => {
  it('interleaves tail models across distinct providers round-robin', () => {
    const tail: ModelRankItem[] = [
      { id: 'm1', raw: 'm1', provider: 'provA', tier: 99, scores: {}, totalScore: 0, originalIndex: 0, priceStatus: 'FREE', isDropped: false },
      { id: 'm2', raw: 'm2', provider: 'provA', tier: 99, scores: {}, totalScore: 0, originalIndex: 1, priceStatus: 'FREE', isDropped: false },
      { id: 'm3', raw: 'm3', provider: 'provA', tier: 99, scores: {}, totalScore: 0, originalIndex: 2, priceStatus: 'FREE', isDropped: false },
      { id: 'm4', raw: 'm4', provider: 'provB', tier: 99, scores: {}, totalScore: 0, originalIndex: 3, priceStatus: 'FREE', isDropped: false },
      { id: 'm5', raw: 'm5', provider: 'provB', tier: 99, scores: {}, totalScore: 0, originalIndex: 4, priceStatus: 'FREE', isDropped: false },
      { id: 'm6', raw: 'm6', provider: 'provC', tier: 99, scores: {}, totalScore: 0, originalIndex: 5, priceStatus: 'FREE', isDropped: false },
    ];

    const interleaved = interleaveTailByProvider(tail, true);
    const providers = interleaved.map((m) => m.provider);

    expect(providers).toEqual(['provA', 'provB', 'provC', 'provA', 'provB', 'provA']);
    expect(interleaved.filter((m) => m.provider === 'provA').map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('End-to-End rankComboModels & Invariant I3', () => {
  const configWithTiers = rankingConfigSchema.parse({
    tierRules: {
      tier1_claude: ['claude-sonnet-5-5-medium'],
      tier2_gemini4: ['gemini-4-argon'],
      tier3_deepseek_v4_1: ['deepseek-v4.1-flash'],
      tier4_glm5_3: ['glm-5.3-free'],
      tier6_fallback: ['fallback-1', 'fallback-2', 'fallback-3'],
    },
    // Declare the interleave target explicitly instead of leaning on the schema
    // default. The default is now `[99]` on purpose (the human-chosen tier order
    // must never be round-robin scrambled), so this block keeps testing D1
    // interleaving itself rather than the default.
    interleaving: { applyToTiers: [6, 99] },
  });

  it('filters blacklist and non-chat, ranks by tiers, and interleaves tail', () => {
    const inputModels = [
      'space-bunny-bad', // dropped by blacklist
      'openai/text-embedding-3', // dropped by non-chat
      'provider-z/z-ai/glm-5.3-free', // Tier 4
      'ag/claude-sonnet-5-5-medium', // Tier 1
      'gemini/gemini-4-argon', // Tier 2
      'nvidia/deepseek-ai/deepseek-v4.1-flash', // Tier 3
      'ag/fallback-1', // Tier 6, provider ag
      'ag/fallback-2', // Tier 6, provider ag
      'node-b/fallback-3', // Tier 6, provider node-b
    ];

    const res = rankComboModels('my-combo', '9router', inputModels, configWithTiers);

    expect(res.droppedCount).toBe(2);
    expect(res.retainedCount).toBe(7);
    expect(res.rankedModels[0]?.id).toBe('ag/claude-sonnet-5-5-medium');
    expect(res.rankedModels[1]?.id).toBe('gemini/gemini-4-argon');
    expect(res.rankedModels[2]?.id).toBe('nvidia/deepseek-ai/deepseek-v4.1-flash');
    expect(res.rankedModels[3]?.id).toBe('provider-z/z-ai/glm-5.3-free');

    const tailProviders = res.rankedModels.slice(4).map((m) => m.provider);
    expect(tailProviders).toEqual(['ag', 'node-b', 'ag']);
  });

  it('throws Invariant Violation I3 when retained steps < 2', () => {
    const inputModels = ['space-bunny-bad', 'openai/text-embedding-3', 'ag/claude-sonnet-5-5-medium'];
    expect(() => rankComboModels('fragile-combo', '9router', inputModels, configWithTiers)).toThrow(
      /INVARIANT VIOLATION I3/
    );
  });

  describe('Mandatory Round 60 Ranking Invariants & Gating Tests', () => {
    it('provider trong zeroPaymentProviders không bị gỡ', () => {
      const input = [
        'groq/llama-3.1-8b-instant',
        'gemini/gemini-2.0-flash',
        'nvidia/nemotron-4-340b',
        'cerebras/llama-3.1-70b',
      ];
      const res = rankComboModels('zero-pay-combo', '9router', input, configWithTiers);
      expect(res.droppedCount).toBe(0);
      expect(res.retainedCount).toBe(4);
      expect(res.rankedModels.map((m) => m.id)).toEqual(expect.arrayContaining(input));
    });

    it('thiếu giá không bị gỡ (unverified price is retained)', () => {
      const input = [
        'custom-provider/unknown-price-model-1',
        'custom-provider/unknown-price-model-2',
      ];
      const res = rankComboModels('unverified-price-combo', '9router', input, configWithTiers);
      expect(res.droppedCount).toBe(0);
      expect(res.retainedCount).toBe(2);
      expect(res.rankedModels[0]?.priceStatus).toBe('PRICE_UNVERIFIED');
      expect(res.rankedModels[1]?.priceStatus).toBe('PRICE_UNVERIFIED');
    });

    it('combo <2 bước ném lỗi Invariant I3', () => {
      const singleModelInput = ['ag/claude-sonnet-5-5-medium'];
      expect(() => rankComboModels('single-step-combo', '9router', singleModelInput, configWithTiers)).toThrow(
        /INVARIANT VIOLATION I3/
      );
    });

    it('kết quả là hoán vị đầu vào trừ bước bị gỡ', () => {
      const input = [
        'space-bunny-drop', // blacklist -> dropped
        'openai/whisper-large-v3', // non-chat -> dropped
        'ag/claude-sonnet-5-5-medium',
        'groq/llama-3.1-70b',
        'gemini/gemini-4-argon',
        'node-b/qwen3.8-max',
      ];
      const res = rankComboModels('permutation-combo', '9router', input, configWithTiers);

      expect(res.droppedCount).toBe(2);
      expect(res.retainedCount).toBe(4);

      const droppedIds = res.droppedModels.map((m) => m.id);
      expect(droppedIds).toEqual(['space-bunny-drop', 'openai/whisper-large-v3']);

      const rankedIds = res.rankedModels.map((m) => m.id);
      // Verify rankedIds + droppedIds is an exact permutation of input
      expect(rankedIds.length + droppedIds.length).toBe(input.length);
      const allResultIds = [...rankedIds, ...droppedIds].sort();
      const expectedIds = [...input].sort();
      expect(allResultIds).toEqual(expectedIds);

      // Verify no duplicates created
      expect(new Set(rankedIds).size).toBe(rankedIds.length);
    });
  });
});

/**
 * Regression guard for a real incident: the built-in default for
 * `interleaving.applyToTiers` used to be `[6, 99]`, which round-robin
 * scrambled the human-chosen tier 6 (GLM 5.3) block any time a run used the
 * default config instead of the live YAML. The human-selected tier order is
 * authoritative, so only the unrated tail (tier 99) may be interleaved.
 */
describe('Human-chosen tier order is never round-robin scrambled by default', () => {
  const makeItem = (id: string, provider: string, tier: number, originalIndex: number): ModelRankItem => ({
    id,
    raw: { id },
    provider,
    tier,
    scores: {},
    totalScore: 0,
    originalIndex,
    priceStatus: 'FREE',
    isDropped: false,
  });

  it('default config interleaves only tier 99, never tier 6', () => {
    const config = rankingConfigSchema.parse({});
    expect(config.interleaving.applyToTiers).toEqual([99]);
  });

  it('applyRankingInterleave() preserves tier 6 order verbatim and interleaves only tier 99', () => {
    const items = [
      makeItem('hf/glm-a', 'hf', 6, 0),
      makeItem('hf/glm-b', 'hf', 6, 1),
      makeItem('nvidia/glm-c', 'nvidia', 6, 2),
      makeItem('nvidia/glm-d', 'nvidia', 6, 3),
      makeItem('hf/unknown-a', 'hf', 99, 4),
      makeItem('hf/unknown-b', 'hf', 99, 5),
      makeItem('nvidia/unknown-c', 'nvidia', 99, 6),
      makeItem('nvidia/unknown-d', 'nvidia', 99, 7),
    ];

    const ids = applyRankingInterleave(items).map((item) => item.id);

    // Tier 6 must keep the human-chosen order verbatim (no provider round-robin).
    expect(ids.slice(0, 4)).toEqual(['hf/glm-a', 'hf/glm-b', 'nvidia/glm-c', 'nvidia/glm-d']);
    // Tier 99 is still round-robin interleaved by provider.
    expect(ids.slice(4)).toEqual(['hf/unknown-a', 'nvidia/unknown-c', 'hf/unknown-b', 'nvidia/unknown-d']);
  });

  it('I6: loadRankingConfig throws on broken YAML instead of silent fallback', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-rank-i6-'));
    const badPath = path.join(tmpDir, 'ranking.yaml');
    fs.writeFileSync(badPath, 'version: 1\nblacklist: [unclosed\n', 'utf8');
    try {
      expect(() => loadRankingConfig(badPath)).toThrow(/Failed to parse ranking\.yaml/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('I2/I5: separates OPERATOR-DISABLED and PROVIDER-INACTIVE from DEAD and enforces <=10% shrink cap', () => {
    const cfg = rankingConfigSchema.parse({
      blacklist: ['dead-1', 'dead-2', 'dead-3'],
      operatorDisabled: ['=op-disabled-1'],
      providerInactive: ['=prov-inactive-1'],
    });
    const models = [
      'dead-1',
      'dead-2',
      'dead-3',
      'op-disabled-1',
      'prov-inactive-1',
      'ag/model-a',
      'ag/model-b',
      'ag/model-c',
      'ag/model-d',
      'ag/model-e',
    ];
    // 10 steps with maxShrinkRatio=0.10 -> at most 1 dropped per cycle; operatorDisabled & providerInactive retained without confirmation
    const res1 = rankComboModels('c1', '9router', models, cfg, { maxShrinkRatio: 0.10 });
    expect(res1.droppedCount).toBe(1);
    expect(res1.shrinkCappedCount).toBe(2);
    expect(res1.pendingOperatorDisabled).toEqual(['op-disabled-1']);
    expect(res1.pendingProviderInactive).toEqual(['prov-inactive-1']);

    // With per-group confirmation and no shrink cap, all 5 are dropped with distinct evidenceLabels
    const res2 = rankComboModels('c1', '9router', models, cfg, {
      allowOperatorDisabled: true,
      allowProviderInactive: true,
    });
    expect(res2.droppedCount).toBe(5);
    expect(res2.droppedModels.map((m) => m.evidenceLabel)).toEqual([
      'DEAD',
      'DEAD',
      'DEAD',
      'OPERATOR-DISABLED',
      'PROVIDER-INACTIVE',
    ]);
  });
});
