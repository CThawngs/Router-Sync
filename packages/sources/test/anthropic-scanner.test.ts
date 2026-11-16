/**
 * packages/sources/test/anthropic-scanner.test.ts
 */

import { describe, it, expect } from 'vitest';
import { scanAnthropicModels } from '../src/discovery/anthropic-scanner.js';

describe('scanAnthropicModels (P1-DEBT-01 / SPEC §23.2)', () => {
  it('discovers models from Anthropic GET /v1/models response cleanly', async () => {
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/models');
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers?.['x-api-key']).toBe('sk-ant-test-key');
      expect(headers?.['anthropic-version']).toBe('2023-06-01');

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          data: [
            {
              type: 'model',
              id: 'claude-3-5-sonnet-20241022',
              display_name: 'Claude 3.5 Sonnet',
              created_at: '2024-10-22T00:00:00Z',
            },
            {
              type: 'model',
              id: 'claude-3-5-haiku-20241022',
              display_name: 'Claude 3.5 Haiku',
              created_at: '2024-10-22T00:00:00Z',
            },
          ],
          has_more: false,
        }),
      } as unknown as Response;
    };

    const res = await scanAnthropicModels('sk-ant-test-key', {
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(res.ok).toBe(true);
    expect(res.models).toHaveLength(2);
    expect(res.models[0]?.id).toBe('claude-3-5-sonnet-20241022');
    expect(res.models[0]?.ownedBy).toBe('anthropic');
    expect(res.models[1]?.id).toBe('claude-3-5-haiku-20241022');
    expect(res.models[1]?.ownedBy).toBe('anthropic');
  });

  it('handles HTTP error without crashing', async () => {
    const mockFetch = async () => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as unknown as Response;
    };

    const res = await scanAnthropicModels('invalid-key', {
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(res.ok).toBe(false);
    expect(res.models).toHaveLength(0);
    expect(res.error).toBe('HTTP 401 Unauthorized');
  });

  it('handles invalid response payload format', async () => {
    const mockFetch = async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ error: 'malformed' }),
      } as unknown as Response;
    };

    const res = await scanAnthropicModels('sk-ant-test-key', {
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('missing data array');
  });
});
