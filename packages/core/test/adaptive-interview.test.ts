/**
 * packages/core/test/adaptive-interview.test.ts
 *
 * C45 WP6 Red-First Test Suite — <= 12-Question Adaptive Interview State Machine,
 * Router Strategy Capabilities Matrix, Explicit Assumptions, and Zero Fabrication
 * of Factual Inventory (Phục vụ: S4, S5).
 */

import { describe, it, expect } from 'vitest';
import {
  INTERVIEW_QUESTIONS,
  ROUTER_STRATEGY_CAPABILITIES,
  getRouterStrategyCapabilities,
  ADAPTIVE_INTERVIEW_FLOW,
  ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
  createAdaptiveInterviewPlan,
  finalizeAdaptiveProfile,
  mergeProfileNonDestructive,
} from '../src/profile/questions.js';

describe('C45 WP5/WP6 Core — Router Strategy Capabilities & Legacy Question Lock', () => {
  it('keeps INTERVIEW_QUESTIONS locked at length 12 while exporting ROUTER_STRATEGY_CAPABILITIES for 9router, omniroute, and litellm', () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(12);
    expect(ROUTER_STRATEGY_CAPABILITIES).toHaveLength(3);

    const nine = getRouterStrategyCapabilities('9router')[0]!;
    expect(nine.credentialPoolLevel.supported).toBe(true);
    expect(nine.comboRoutingLevel.canonicalStrategies).toEqual(['fallback', 'round-robin']);
    expect(nine.comboRoutingLevel.defaultRecommended).toBe('fallback');

    const omni = getRouterStrategyCapabilities('omniroute')[0]!;
    expect(omni.credentialPoolLevel.supported).toBe(true);
    expect(omni.comboRoutingLevel.canonicalStrategies).toEqual(['priority', 'weighted', 'round-robin']);
    expect(omni.comboRoutingLevel.defaultRecommended).toBe('priority');

    const litellm = getRouterStrategyCapabilities('litellm')[0]!;
    expect(litellm.credentialPoolLevel.supported).toBe(true);
    expect(litellm.comboRoutingLevel.canonicalStrategies).toEqual(['fallbacks', 'simple-shuffle', 'least-busy']);
    expect(litellm.comboRoutingLevel.defaultRecommended).toBe('fallbacks');
  });
});

describe('C45 WP6 Core — Adaptive Interview <= 12 Question Ceiling & Zero Fabrication', () => {
  it('enforces <= 12 questions across every simulated persona (vague beginner, solo student, multi-router power user)', () => {
    expect(ADAPTIVE_INTERVIEW_MAX_QUESTIONS).toBe(12);
    expect(ADAPTIVE_INTERVIEW_FLOW.allQuestions.length).toBeLessThanOrEqual(12);

    // Persona A: Non-technical vague user -> finishes in 8 core everyday questions (<= 12)
    const vaguePlan = createAdaptiveInterviewPlan({
      purpose: 'just help me code',
      harnesses: 'not sure',
      routers: 'idk',
      keyedProviders: 'not sure',
      budget: 'idk',
      priority: 'whatever',
      automationLevel: 'idk',
      scanCycle: 'not sure',
    });
    expect(vaguePlan.powerUserDetected).toBe(false);
    expect(vaguePlan.questionsToAsk.length).toBeGreaterThanOrEqual(7);
    expect(vaguePlan.questionsToAsk.length).toBeLessThanOrEqual(8);
    expect(vaguePlan.questionsToAsk.length).toBeLessThanOrEqual(12);

    // Cover all 7 required C45 WP6 domains in everyday track
    const coreDomains = vaguePlan.coreQuestions.map((q) => q.domain);
    expect(coreDomains).toEqual(
      expect.arrayContaining([
        'purpose',
        'harnesses',
        'routers',
        'keyedProviders',
        'budget',
        'priority',
        'automationLevel',
        'scanCycle',
      ])
    );

    // Persona B: Solo student (free-only + long-context) -> <= 12 questions
    const studentSession = finalizeAdaptiveProfile({
      purpose: 'coding and reading big repos',
      harnesses: 'Claude Code, OpenCode',
      routers: '9Router',
      keyedProviders: 'Gemini, Groq',
      budget: 'free-only',
      priority: 'long-context, speed',
      automationLevel: 'propose',
      scanCycle: 'daily',
    });
    expect(studentSession.valid).toBe(true);
    expect(studentSession.questionCountAsked).toBeLessThanOrEqual(12);
    expect(studentSession.profile.budget).toBe('free-only');
    expect(studentSession.profile.harnesses).toEqual(['claude-code', 'opencode']);
    expect(studentSession.profile.routers).toEqual(['9router']);
    expect(studentSession.profile.keyedProviders).toEqual(['gemini', 'groq']);
    expect(studentSession.profile.priority[0]).toBe('context');

    // Persona C: Multi-router power user -> triggers follow-ups but strictly <= 12 questions total
    const powerPlan = createAdaptiveInterviewPlan({
      purpose: 'multi-agent software factory with custom limits',
      harnesses: 'Hermes, OpenMausBot, OpenCode, DSH',
      routers: '9Router, OmniRoute, LiteLLM',
      keyedProviders: 'OpenAI, Anthropic, Gemini, Groq',
      budget: 'paid',
      priority: 'quality, speed, long-context',
      automationLevel: 'auto-safe',
      scanCycle: 'hourly',
    });
    expect(powerPlan.powerUserDetected).toBe(true);
    expect(powerPlan.questionsToAsk.length).toBeLessThanOrEqual(12);

    const powerSession = finalizeAdaptiveProfile({
      purpose: 'multi-agent software factory with custom limits',
      harnesses: 'Hermes, OpenMausBot, OpenCode, DSH',
      routers: '9Router, OmniRoute, LiteLLM',
      keyedProviders: 'OpenAI, Anthropic, Gemini, Groq',
      budget: 'paid',
      priority: 'quality, speed, long-context',
      automationLevel: 'auto-safe',
      scanCycle: 'hourly',
      routerMode: 'merge',
      limits: '10, 5+20, 25',
      favorites: 'anthropic/claude-sonnet-4-5',
      blockList: 'openai/gpt-4o-mini-tts',
    });
    expect(powerSession.valid).toBe(true);
    expect(powerSession.questionCountAsked).toBeLessThanOrEqual(12);
    expect(powerSession.consentNote).toMatch(/propose.*verified read-back/i);
  });

  it('records explicit assumptions[] on vague inputs and NEVER fabricates harnesses, routers, keyedProviders, favorites, or allowList', () => {
    const res = finalizeAdaptiveProfile({
      purpose: 'idk',
      harnesses: 'not sure',
      routers: 'khong biet',
      keyedProviders: '',
      budget: 'whatever',
      priority: 'anything good',
      automationLevel: 'not sure',
      scanCycle: '',
    });

    expect(res.valid).toBe(true);
    // Conservative safe defaults on preferences
    expect(res.profile.budget).toBe('free-only');
    expect(res.profile.freeOnly).toBe(true);
    expect(res.profile.automationLevel).toBe('propose');
    expect(res.profile.scanCycle).toBe('daily');

    // ZERO fabrication on factual inventory
    expect(res.profile.harnesses).toEqual([]);
    expect(res.profile.routers).toEqual([]);
    expect(res.profile.keyedProviders).toEqual([]);
    expect(res.profile.favorites).toEqual([]);
    expect(res.profile.allowList).toEqual([]);

    // Explicit assumptions recorded for every defaulted/uncertain answer
    const assumedFields = res.assumptions.map((a) => a.field);
    expect(assumedFields).toEqual(
      expect.arrayContaining([
        'purpose',
        'harnesses',
        'routers',
        'keyedProviders',
        'budget',
        'priority',
        'automationLevel',
        'scanCycle',
      ])
    );
  });

  it('merges non-destructively over an existing profile without wiping favorites, blockList, allowList, or existing inventory on blank answers', () => {
    const existing = {
      purpose: 'coding',
      budget: 'free-only',
      freeOnly: true,
      harnesses: ['hermes', 'openmausbot'],
      routers: ['9router'],
      keyedProviders: ['gemini', 'groq'],
      favorites: ['gemini/gemini-2.5-pro'],
      allowList: ['gemini/gemini-2.5-pro', 'groq/llama-3.3-70b-versatile'],
      denyList: ['bad/model-1'],
      blockList: ['bad/model-1'],
      routerMode: 'merge',
      quotaLimit: '8, 4+12, 20',
      automationLevel: 'propose',
      scanCycle: 'daily',
    };

    const merged = mergeProfileNonDestructive(existing, {
      scanCycle: 'weekly',
      harnesses: '',
      routers: '',
      keyedProviders: '',
    });

    expect(merged.valid).toBe(true);
    expect(merged.profile.scanCycle).toBe('weekly');
    expect(merged.profile.harnesses).toEqual(['hermes', 'openmausbot']);
    expect(merged.profile.routers).toEqual(['9router']);
    expect(merged.profile.keyedProviders).toEqual(['gemini', 'groq']);
    expect(merged.profile.favorites).toEqual(['gemini/gemini-2.5-pro']);
    expect(merged.profile.allowList).toEqual([
      'gemini/gemini-2.5-pro',
      'groq/llama-3.3-70b-versatile',
    ]);
    expect(merged.profile.denyList).toEqual(['bad/model-1']);
  });
});
