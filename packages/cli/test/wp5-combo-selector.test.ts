/**
 * packages/cli/test/wp5-combo-selector.test.ts
 *
 * C45 WP5 Red-First Test Suite — Specialist Non-Chat Filtering, Reliability-Driven
 * Combo Selection, 12..15 Step Ceilings, I3/I6/I7 Invariants & Full Cross-Provider
 * Interleaving (Phục vụ: S4).
 */

import { describe, it, expect } from 'vitest';
import { classifyNonChatSpecialist, isNonChat, DEFAULT_NON_CHAT_PATTERNS } from '../src/rank/filters.js';
import { interleaveAcrossProviders } from '../src/rank/interleave.js';
import {
  selectComboSteps,
  type ComboCandidateModel,
} from '../src/rank/combo-selector.js';
import type { StepReliability } from '../src/commands/combos-reliability.js';

function makeReliability(
  step: string,
  label: StepReliability['label'],
  p50: number | null = 420,
  p90: number | null = 850
): StepReliability {
  return {
    step,
    attempts: 6,
    ok: label === 'DEAD' ? 0 : label === 'LOW-SAMPLE' ? 2 : 6,
    rateLimited: label === 'RATE-LIMITED' ? 2 : 0,
    failures: label === 'DEAD' ? 6 : 0,
    headerMs: p50 !== null ? [p50] : [],
    p50,
    p90,
    label,
  };
}

describe('C45 WP5 — Non-Chat Specialist Classification (5 Families + Multimodal Preservation)', () => {
  it('filters all 5 non-chat model families by modelId and explicit metadata', () => {
    // 1. Embedding family
    expect(classifyNonChatSpecialist('openai/text-embedding-3-large')).toBe('embedding');
    expect(classifyNonChatSpecialist('baai/bge-m3')).toBe('embedding');
    expect(classifyNonChatSpecialist('intfloat/e5-large-v2')).toBe('embedding');
    expect(classifyNonChatSpecialist('nomic-ai/nomic-embed-text-v1.5')).toBe('embedding');
    expect(classifyNonChatSpecialist('jinaai/jina-embeddings-v3')).toBe('embedding');
    expect(classifyNonChatSpecialist('voyageai/voyage-code-3')).toBe('embedding');
    expect(classifyNonChatSpecialist({ modelId: 'custom/vec-v1', mode: 'embedding' })).toBe('embedding');

    // 2. Audio (TTS / ASR / STT) family
    expect(classifyNonChatSpecialist('openai/gpt-4o-mini-tts')).toBe('audio');
    expect(classifyNonChatSpecialist('openai/gpt-4o-transcribe')).toBe('audio');
    expect(classifyNonChatSpecialist('groq/whisper-large-v3-turbo')).toBe('audio');
    expect(classifyNonChatSpecialist('hexgrad/kokoro-82m')).toBe('audio');
    expect(classifyNonChatSpecialist('groq/playai-tts')).toBe('audio');
    expect(classifyNonChatSpecialist('nvidia/canary-1b')).toBe('audio');
    expect(classifyNonChatSpecialist({ modelId: 'custom/voice-v1', mode: 'audio_transcription' })).toBe('audio');

    // 3. Moderation / Safety Guard family
    expect(classifyNonChatSpecialist('openai/omni-moderation-latest')).toBe('moderation');
    expect(classifyNonChatSpecialist('groq/llama-guard-3-8b')).toBe('moderation');
    expect(classifyNonChatSpecialist('meta/prompt-guard-86m')).toBe('moderation');
    expect(classifyNonChatSpecialist('google/shieldgemma-9b')).toBe('moderation');
    expect(classifyNonChatSpecialist({ modelId: 'custom/safety-v1', mode: 'moderation' })).toBe('moderation');

    // 4. Image generation family
    expect(classifyNonChatSpecialist('openai/dall-e-3')).toBe('image-gen');
    expect(classifyNonChatSpecialist('openai/gpt-image-1')).toBe('image-gen');
    expect(classifyNonChatSpecialist('google/imagen-3.0-generate-002')).toBe('image-gen');
    expect(classifyNonChatSpecialist('black-forest-labs/flux-1-schnell')).toBe('image-gen');
    expect(classifyNonChatSpecialist('stabilityai/sdxl-turbo')).toBe('image-gen');
    expect(classifyNonChatSpecialist('recraft-ai/recraft-v3')).toBe('image-gen');
    expect(classifyNonChatSpecialist('ideogram-ai/ideogram-v2')).toBe('image-gen');
    expect(classifyNonChatSpecialist({ modelId: 'custom/painter', mode: 'image_generation' })).toBe('image-gen');

    // 5. Rerank family
    expect(classifyNonChatSpecialist('cohere/rerank-english-v3.0')).toBe('rerank');
    expect(classifyNonChatSpecialist('baai/bge-reranker-v2-m3')).toBe('rerank');
    expect(classifyNonChatSpecialist('jinaai/jina-reranker-v2-base-multilingual')).toBe('rerank');
    expect(classifyNonChatSpecialist({ modelId: 'custom/ranker', mode: 'rerank' })).toBe('rerank');
  });

  it('keeps general multimodal chat models eligible (zero false positives)', () => {
    const generalChatModels = [
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'gemini/gemini-2.5-pro',
      'gemini/gemini-2.5-flash',
      'anthropic/claude-sonnet-4-5',
      'qwen/qwen2.5-coder-32b-instruct',
      'deepseek/deepseek-r1',
    ];
    for (const modelId of generalChatModels) {
      expect(classifyNonChatSpecialist(modelId), `${modelId} must remain chat-eligible`).toBeNull();
      expect(isNonChat(modelId, [...DEFAULT_NON_CHAT_PATTERNS])).toBe(false);
    }
  });
});

describe('C45 WP5 — Reliability-Aware Combo Selector & Interleaving', () => {
  it('excludes 100% of DEAD and HANG steps even when listed in profile.favorites and emits warnings', () => {
    const candidates: ComboCandidateModel[] = [
      {
        step: 'groq/llama-3.3-70b-versatile',
        provider: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        free: true,
        pricingKnown: true,
        qualityScore: 88,
        reliability: makeReliability('groq/llama-3.3-70b-versatile', 'RELIABLE', 220, 410),
      },
      {
        step: 'gemini/gemini-2.5-flash',
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        free: true,
        pricingKnown: true,
        qualityScore: 90,
        reliability: makeReliability('gemini/gemini-2.5-flash', 'RELIABLE', 310, 620),
      },
      {
        step: 'nvidia/deepseek-r1-hang',
        provider: 'nvidia',
        modelId: 'deepseek-r1-hang',
        free: true,
        pricingKnown: true,
        qualityScore: 99,
        reliability: makeReliability('nvidia/deepseek-r1-hang', 'HANG', 5000, 30000),
      },
      {
        step: 'cerebras/qwen-dead',
        provider: 'cerebras',
        modelId: 'qwen-dead',
        free: true,
        pricingKnown: true,
        qualityScore: 98,
        reliability: makeReliability('cerebras/qwen-dead', 'DEAD', null, null),
      },
    ];

    const res = selectComboSteps({
      candidates,
      options: {
        profile: {
          budget: 'free-only',
          favorites: ['nvidia/deepseek-r1-hang', 'cerebras/qwen-dead', 'groq/llama-3.3-70b-versatile'],
          priority: ['quality', 'speed'],
        },
        routerKind: '9router',
      },
    });

    expect(res.insufficientCandidates).toBe(false);
    expect(res.selectedSteps).not.toContain('nvidia/deepseek-r1-hang');
    expect(res.selectedSteps).not.toContain('cerebras/qwen-dead');
    expect(res.selectedSteps).toEqual([
      'groq/llama-3.3-70b-versatile',
      'gemini/gemini-2.5-flash',
    ]);

    const hangExcluded = res.excluded.find((e) => e.step === 'nvidia/deepseek-r1-hang');
    const deadExcluded = res.excluded.find((e) => e.step === 'cerebras/qwen-dead');
    expect(hangExcluded?.reason).toBe('unreliable-hang');
    expect(deadExcluded?.reason).toBe('unreliable-dead');
    expect(res.warnings.some((w) => w.includes('nvidia/deepseek-r1-hang') && /HANG/i.test(w))).toBe(true);
    expect(res.warnings.some((w) => w.includes('cerebras/qwen-dead') && /DEAD/i.test(w))).toBe(true);
    expect(res.recommendedStrategy).toBe('fallback');
  });

  it('excludes all 5 specialist non-chat families during combo selection', () => {
    const candidates: ComboCandidateModel[] = [
      { step: 'openai/gpt-4o', provider: 'openai', modelId: 'gpt-4o', free: false, pricingKnown: true, qualityScore: 92 },
      { step: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', free: false, pricingKnown: true, qualityScore: 95 },
      { step: 'openai/text-embedding-3-large', provider: 'openai', modelId: 'text-embedding-3-large', free: false, pricingKnown: true, qualityScore: 99 },
      { step: 'openai/gpt-4o-mini-tts', provider: 'openai', modelId: 'gpt-4o-mini-tts', free: false, pricingKnown: true, qualityScore: 99 },
      { step: 'groq/llama-guard-3-8b', provider: 'groq', modelId: 'llama-guard-3-8b', free: true, pricingKnown: true, qualityScore: 99 },
      { step: 'black-forest-labs/flux-1-schnell', provider: 'black-forest-labs', modelId: 'flux-1-schnell', free: true, pricingKnown: true, qualityScore: 99 },
      { step: 'cohere/rerank-english-v3.0', provider: 'cohere', modelId: 'rerank-english-v3.0', free: false, pricingKnown: true, qualityScore: 99 },
    ];

    const res = selectComboSteps({
      candidates,
      options: {
        profile: { budget: 'paid', priority: ['quality'] },
        routerKind: 'omniroute',
      },
    });

    expect(res.selectedSteps).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-4o']);
    expect(res.excluded.map((e) => e.reason).sort()).toEqual([
      'non-chat-specialist:audio',
      'non-chat-specialist:embedding',
      'non-chat-specialist:image-gen',
      'non-chat-specialist:moderation',
      'non-chat-specialist:rerank',
    ]);
    expect(res.recommendedStrategy).toBe('priority');
  });

  it('enforces default maxSteps=12 for paid and maxSteps=15 for free-only, clamping <= 15 by default', () => {
    const providers = ['gemini', 'groq', 'nvidia', 'cerebras', 'sambanova'];
    const pool20: ComboCandidateModel[] = [];
    for (let i = 0; i < 20; i += 1) {
      const prov = providers[i % providers.length]!;
      pool20.push({
        step: `${prov}/chat-model-${String(i + 1).padStart(2, '0')}`,
        provider: prov,
        modelId: `chat-model-${String(i + 1).padStart(2, '0')}`,
        free: true,
        pricingKnown: true,
        qualityScore: 95 - i,
        reliability: makeReliability(`${prov}/chat-model-${String(i + 1).padStart(2, '0')}`, 'RELIABLE'),
      });
    }

    const paidRes = selectComboSteps({
      candidates: pool20,
      options: { profile: { budget: 'paid' }, routerKind: 'litellm' },
    });
    expect(paidRes.selectedSteps).toHaveLength(12);
    expect(paidRes.recommendedStrategy).toBe('fallbacks');

    const freeRes = selectComboSteps({
      candidates: pool20,
      options: { profile: { budget: 'free-only' }, routerKind: '9router' },
    });
    expect(freeRes.selectedSteps).toHaveLength(15);

    // Passing maxSteps: 25 without allowAbove15 clamps strictly to 15
    const clampedRes = selectComboSteps({
      candidates: pool20,
      options: { profile: { budget: 'paid' }, maxSteps: 25 },
    });
    expect(clampedRes.selectedSteps).toHaveLength(15);
  });

  it('enforces Invariant I6 (free-only rejects paid and pricingKnown=false) and I3 (< 2 surviving steps)', () => {
    const candidates: ComboCandidateModel[] = [
      { step: 'groq/free-1', provider: 'groq', modelId: 'free-1', free: true, pricingKnown: true },
      { step: 'openai/paid-1', provider: 'openai', modelId: 'paid-1', free: false, pricingKnown: true },
      { step: 'mystery/unknown-price', provider: 'mystery', modelId: 'unknown-price', free: true, pricingKnown: false },
    ];

    const res = selectComboSteps({
      candidates,
      options: { profile: { budget: 'free-only' } },
    });

    expect(res.insufficientCandidates).toBe(true);
    expect(res.selectedSteps).toEqual([]);
    expect(res.excluded.filter((e) => e.reason === 'budget-free-only')).toHaveLength(2);
    expect(res.warnings.some((w) => /I3|at least 2/i.test(w))).toBe(true);
  });

  it('guarantees adjacentSameProviderCount === 0 across a 12-step 4-provider combo even when input is grouped by provider', () => {
    const providers = ['gemini', 'groq', 'nvidia', 'sambanova'];
    // Deliberately group all gemini models at the top with highest scores (99, 98, 97)
    // so naive score-sorting WITHOUT interleaveAcrossProviders would emit 3 adjacent gemini steps!
    const candidates: ComboCandidateModel[] = [];
    providers.forEach((prov, pIdx) => {
      for (let m = 1; m <= 3; m += 1) {
        const step = `${prov}/model-${m}`;
        candidates.push({
          step,
          provider: prov,
          modelId: `model-${m}`,
          free: true,
          pricingKnown: true,
          qualityScore: 100 - pIdx * 10 - m,
          reliability: makeReliability(step, 'RELIABLE', 250 + m * 10, 500 + m * 20),
        });
      }
    });

    const res = selectComboSteps({
      candidates,
      options: {
        profile: { budget: 'paid', priority: ['quality'] },
        routerKind: '9router',
      },
    });

    expect(res.selectedSteps).toHaveLength(12);
    expect(res.adjacentSameProviderCount).toBe(0);
    for (let i = 1; i < res.selectedSteps.length; i += 1) {
      const prevProv = res.selectedSteps[i - 1]!.split('/')[0];
      const currProv = res.selectedSteps[i]!.split('/')[0];
      expect(currProv, `step ${i - 1} and ${i} shared provider ${currProv}`).not.toBe(prevProv);
    }

    // Also verify odd-count max-remaining-bucket optimality (5 items: 3 groq, 2 gemini)
    const oddInterleaved = interleaveAcrossProviders([
      { step: 'gemini/g1', provider: 'gemini', score: 95 },
      { step: 'gemini/g2', provider: 'gemini', score: 94 },
      { step: 'groq/q1', provider: 'groq', score: 80 },
      { step: 'groq/q2', provider: 'groq', score: 79 },
      { step: 'groq/q3', provider: 'groq', score: 78 },
    ]);
    expect(oddInterleaved.adjacentSameProviderCount).toBe(0);
    expect(oddInterleaved.ordered.map((x) => x.provider)).toEqual([
      'groq',
      'gemini',
      'groq',
      'gemini',
      'groq',
    ]);
  });
});
