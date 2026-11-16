/**
 * packages/cli/test/reduce-track.test.ts
 *
 * Unit tests for reduceTrack pure function (R1–R11).
 */

import { describe, it, expect } from 'vitest';
import { reduceTrack, type TrackEvent } from '../src/maintain/reduce-track.js';

describe('reduceTrack pure function', () => {
  const baseNow = 1700000000000;

  it('handles empty input gracefully', () => {
    const res = reduceTrack();
    expect(res).toEqual({
      providers: {},
      ignoredEvents: 0,
    });
  });

  it('ignores invalid or malformed events and counts them', () => {
    const events: TrackEvent[] = [
      null as unknown as TrackEvent,
      'not-an-object' as unknown as TrackEvent,
      { type: 'model_added' }, // missing provider
      { provider: 'prov1', type: 'unknown_type', timestamp: baseNow }, // invalid type
      { provider: 'prov1', type: 'model_added', timestamp: 'not-a-date', models: ['m1'] }, // bad time
      { provider: 'prov1', type: 'model_added', timestamp: baseNow }, // missing models array
      { provider: 'prov1', type: 'model_removed', timestamp: baseNow }, // missing models array
    ];

    const res = reduceTrack({ events, nowMs: baseNow });
    expect(res.ignoredEvents).toBe(7);
    expect(res.providers).toEqual({});
  });

  it('adds model within sinceMs window with full provider prefix', () => {
    const events: TrackEvent[] = [
      {
        provider: 'groq',
        type: 'model_added',
        timestamp: baseNow - 1000,
        models: ['llama-3.3-70b', 'mixtral-8x7b'],
      },
    ];

    const res = reduceTrack({ events, nowMs: baseNow, sinceMs: 60000 });
    expect(res.ignoredEvents).toBe(0);
    expect(res.providers.groq).toBeDefined();
    expect(res.providers.groq.added).toEqual([
      { id: 'groq/llama-3.3-70b' },
      { id: 'groq/mixtral-8x7b' },
    ]);
    expect(res.providers.groq.removed).toEqual([]);
    expect(res.providers.groq.status).toBe('unknown');
  });

  it('filters out model_added older than sinceMs window', () => {
    const events: TrackEvent[] = [
      {
        provider: 'groq',
        type: 'model_added',
        timestamp: baseNow - 100000,
        models: ['old-model'],
      },
      {
        provider: 'groq',
        type: 'model_added',
        timestamp: baseNow - 1000,
        models: ['new-model'],
      },
    ];

    const res = reduceTrack({ events, nowMs: baseNow, sinceMs: 50000 });
    expect(res.providers.groq.added).toEqual([{ id: 'groq/new-model' }]);
  });

  it('keeps model_removed regardless of age', () => {
    const events: TrackEvent[] = [
      {
        provider: 'openai',
        type: 'model_removed',
        timestamp: baseNow - 100000000,
        models: ['gpt-3.5-turbo-0301'],
      },
    ];

    const res = reduceTrack({ events, nowMs: baseNow, sinceMs: 1000 });
    expect(res.providers.openai.removed).toEqual(['openai/gpt-3.5-turbo-0301']);
    expect(res.providers.openai.added).toEqual([]);
  });

  it('allows newer removal to supersede earlier addition', () => {
    const events: TrackEvent[] = [
      {
        provider: 'anthropic',
        type: 'model_added',
        timestamp: baseNow - 2000,
        models: ['claude-legacy'],
      },
      {
        provider: 'anthropic',
        type: 'model_removed',
        timestamp: baseNow - 1000,
        models: ['claude-legacy'],
      },
    ];

    const res = reduceTrack({ events, nowMs: baseNow });
    expect(res.providers.anthropic.added).toEqual([]);
    expect(res.providers.anthropic.removed).toEqual(['anthropic/claude-legacy']);
  });

  it('allows newer addition to supersede earlier removal', () => {
    const events: TrackEvent[] = [
      {
        provider: 'mistral',
        type: 'model_removed',
        timestamp: baseNow - 5000,
        models: ['codestral'],
      },
      {
        provider: 'mistral',
        type: 'model_added',
        timestamp: baseNow - 1000,
        models: ['codestral'],
      },
    ];

    const res = reduceTrack({ events, nowMs: baseNow });
    expect(res.providers.mistral.added).toEqual([{ id: 'mistral/codestral' }]);
    expect(res.providers.mistral.removed).toEqual([]);
  });

  it('evaluates provider status as ok when scan is recent', () => {
    const state = {
      providers: {
        openrouter: {
          status: 'ok',
          lastScanAt: new Date(baseNow - 1000).toISOString(),
        },
      },
    };

    const res = reduceTrack({ state, nowMs: baseNow, staleMs: 10000 });
    expect(res.providers.openrouter.status).toBe('ok');
  });

  it('evaluates provider status as stale when scan is older than staleMs', () => {
    const state = {
      providers: {
        openrouter: {
          status: 'ok',
          lastScanAt: new Date(baseNow - 50000).toISOString(),
        },
      },
    };

    const res = reduceTrack({ state, nowMs: baseNow, staleMs: 10000 });
    expect(res.providers.openrouter.status).toBe('stale');
  });

  it('preserves non-ok recorded status without overwriting', () => {
    const state = {
      providers: {
        bad_auth: { status: 'auth_error', lastScanAt: new Date(baseNow - 100).toISOString() },
        unreach: { status: 'unreachable', lastScanAt: new Date(baseNow - 100).toISOString() },
        frozen: { status: 'provider_frozen', lastScanAt: new Date(baseNow - 100).toISOString() },
      },
    };

    const res = reduceTrack({ state, nowMs: baseNow });
    expect(res.providers.bad_auth.status).toBe('auth_error');
    expect(res.providers.unreach.status).toBe('unreachable');
    expect(res.providers.frozen.status).toBe('provider_frozen');
  });

  it('sorts providers and models deterministically', () => {
    const events: TrackEvent[] = [
      { provider: 'zebra', type: 'model_added', timestamp: baseNow, models: ['z2', 'z1'] },
      { provider: 'alpha', type: 'model_added', timestamp: baseNow, models: ['a2', 'a1'] },
      { provider: 'alpha', type: 'model_removed', timestamp: baseNow, models: ['r2', 'r1'] },
    ];

    const res = reduceTrack({ events, nowMs: baseNow });
    const keys = Object.keys(res.providers);
    expect(keys).toEqual(['alpha', 'zebra']);
    expect(res.providers.alpha.added).toEqual([{ id: 'alpha/a1' }, { id: 'alpha/a2' }]);
    expect(res.providers.alpha.removed).toEqual(['alpha/r1', 'alpha/r2']);
  });
});
