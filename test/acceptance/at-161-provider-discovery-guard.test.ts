/**
 * test/acceptance/at-161-provider-discovery-guard.test.ts
 *
 * Acceptance test for AT-161: Provider Discovery & Shrink Guards (Phase 3a / P1-DEBT-01, P1-DEBT-04, P1-DEBT-05).
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateModelListShrink,
  applyGraceCycles,
  scanOpenAiCompatibleModels,
  scanAnthropicModels,
  scanGoogleGeminiModels,
  scanOllamaModels,
  type TrackedCatalogItem,
} from '../../packages/sources/src/index.js';

describe('AT-161: Provider Discovery & Safety Guards', () => {
  describe('Shrink Guard (P1-DEBT-05 / max_shrink_ratio)', () => {
    it('allows normal fluctuations within 30% drop', () => {
      // 10 -> 8 is 20% drop (<= 30%)
      const res = evaluateModelListShrink(10, 8);
      expect(res.frozen).toBe(false);
      expect(res.shrinkRatio).toBe(0.2);
    });

    it('freezes updates when model count drops by more than 30%', () => {
      // 10 -> 6 is 40% drop (> 30%)
      const res = evaluateModelListShrink(10, 6);
      expect(res.frozen).toBe(true);
      expect(res.shrinkRatio).toBe(0.4);
      expect(res.reason).toContain('exceeding safety cap of 30%');
    });

    it('freezes completely if provider returns 0 models when previously having >= 5', () => {
      const res = evaluateModelListShrink(20, 0);
      expect(res.frozen).toBe(true);
      expect(res.shrinkRatio).toBe(1.0);
    });

    it('does not freeze if previous count was below threshold (< 5)', () => {
      // 3 -> 1 is 66% drop, but below min threshold
      const res = evaluateModelListShrink(3, 1);
      expect(res.frozen).toBe(false);
    });
  });

  describe('Grace Cycles (P1-DEBT-04 / grace_cycles >= 2)', () => {
    const t0 = '2026-10-23T00:00:00.000Z';
    const t1 = '2026-10-23T01:00:00.000Z';
    const t2 = '2026-10-23T02:00:00.000Z';
    const t3 = '2026-10-23T03:00:00.000Z';

    it('keeps a missing model in grace_period on cycle 1, and marks absent on cycle 2', () => {
      const initialCatalog: TrackedCatalogItem[] = [
        { id: 'deepseek-chat', status: 'active', consecutiveMissing: 0, lastSeenAt: t0 },
        { id: 'gpt-4o', status: 'active', consecutiveMissing: 0, lastSeenAt: t0 },
      ];

      // Cycle 1: gpt-4o missing
      const cycle1 = applyGraceCycles(initialCatalog, ['deepseek-chat'], t1);
      const gptCycle1 = cycle1.find((m: TrackedCatalogItem) => m.id === 'gpt-4o');
      expect(gptCycle1).toBeDefined();
      expect(gptCycle1?.status).toBe('grace_period');
      expect(gptCycle1?.consecutiveMissing).toBe(1);
      expect(gptCycle1?.lastSeenAt).toBe(t0); // unchanged

      // Cycle 2: gpt-4o still missing -> absent
      const cycle2 = applyGraceCycles(cycle1, ['deepseek-chat'], t2);
      const gptCycle2 = cycle2.find((m: TrackedCatalogItem) => m.id === 'gpt-4o');
      expect(gptCycle2?.status).toBe('absent');
      expect(gptCycle2?.consecutiveMissing).toBe(2);

      // Cycle 3: gpt-4o returns -> active
      const cycle3 = applyGraceCycles(cycle2, ['deepseek-chat', 'gpt-4o'], t3);
      const gptCycle3 = cycle3.find((m: TrackedCatalogItem) => m.id === 'gpt-4o');
      expect(gptCycle3?.status).toBe('active');
      expect(gptCycle3?.consecutiveMissing).toBe(0);
      expect(gptCycle3?.lastSeenAt).toBe(t3);
    });

    it('adds new models directly into active state', () => {
      const initial: TrackedCatalogItem[] = [];
      const updated = applyGraceCycles(initial, ['claude-3-5-sonnet'], t0);

      expect(updated).toHaveLength(1);
      expect(updated[0]?.id).toBe('claude-3-5-sonnet');
      expect(updated[0]?.status).toBe('active');
      expect(updated[0]?.consecutiveMissing).toBe(0);
    });
  });

  describe('Zero-Token Scanner (P1-DEBT-01 / GET /v1/models)', () => {
    it('scans models from mocked valid response cleanly with zero token spend', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            object: 'list',
            data: [
              { id: 'deepseek-chat', owned_by: 'deepseek', created: 1700000000 },
              { id: 'deepseek-coder', owned_by: 'deepseek', created: 1700000100 },
            ],
          }),
        } as unknown as Response;
      };

      const res = await scanOpenAiCompatibleModels('https://api.deepseek.com/v1', {
        apiKey: 'mock-key',
        fetchFn: mockFetch,
      });

      expect(res.ok).toBe(true);
      expect(res.models).toHaveLength(2);
      expect(res.models[0]?.id).toBe('deepseek-chat');
      expect(res.models[0]?.ownedBy).toBe('deepseek');
      expect(res.models[1]?.id).toBe('deepseek-coder');
    });

    it('returns structured failure when provider returns HTTP error without throwing', async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as unknown as Response;
      };

      const res = await scanOpenAiCompatibleModels('https://api.deepseek.com/v1', {
        fetchFn: mockFetch,
      });

      expect(res.ok).toBe(false);
      expect(res.models).toHaveLength(0);
      expect(res.error).toBe('HTTP 401 Unauthorized');
    });

    it('scans Anthropic GET /v1/models cleanly with zero-token headers', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            data: [
              { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
            ],
          }),
        } as unknown as Response;
      };

      const res = await scanAnthropicModels('sk-ant-test', { fetchFn: mockFetch });
      expect(res.ok).toBe(true);
      expect(res.models).toHaveLength(1);
      expect(res.models[0]?.id).toBe('claude-3-5-sonnet-20241022');
      expect(res.models[0]?.ownedBy).toBe('anthropic');
    });

    it('scans Google Gemini GET /v1beta/models cleanly with zero-token parameter', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            models: [
              { name: 'models/gemini-1.5-pro-latest', displayName: 'Gemini 1.5 Pro' },
            ],
          }),
        } as unknown as Response;
      };

      const res = await scanGoogleGeminiModels('gemini-key', { fetchFn: mockFetch });
      expect(res.ok).toBe(true);
      expect(res.models).toHaveLength(1);
      expect(res.models[0]?.id).toBe('gemini-1.5-pro-latest');
      expect(res.models[0]?.ownedBy).toBe('google');
    });

    it('scans Ollama GET /api/tags cleanly with zero-token call', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            models: [
              { name: 'llama3:latest' },
            ],
          }),
        } as unknown as Response;
      };

      const res = await scanOllamaModels('http://127.0.0.1:11434', { fetchFn: mockFetch });
      expect(res.ok).toBe(true);
      expect(res.models).toHaveLength(1);
      expect(res.models[0]?.id).toBe('llama3:latest');
      expect(res.models[0]?.ownedBy).toBe('ollama');
    });
  });
});
