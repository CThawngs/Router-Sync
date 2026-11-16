/**
 * packages/cli/test/providers-safety.test.ts
 *
 * Tests for provider HTTP transport safety guarantees (C4o/O4):
 * - Same-origin validation (isSameOrigin)
 * - Cross-origin pagination URL rejection (credential protection)
 * - Safe redirect handling (manual redirect with same-origin check)
 * - Payload size and pagination limits
 */

/// <reference types="node" />

import { describe, it, expect, vi } from 'vitest';
import {
  isSameOrigin,
  fetchModelList,
  SCAN_MAX_BYTES_PER_PAGE,
  type ProviderTarget,
} from '../src/sync/providers.js';

describe('C4o/O4: Provider HTTP Transport Safety Guarantees', () => {
  describe('isSameOrigin', () => {
    it('returns true when protocol, hostname, and port match exactly', () => {
      expect(isSameOrigin('https://api.openai.com/v1/models?page=2', 'https://api.openai.com/v1/models')).toBe(true);
      expect(isSameOrigin('http://localhost:8080/page2', 'http://localhost:8080/models')).toBe(true);
      expect(isSameOrigin('https://openrouter.ai:443/api/v1/models', 'https://openrouter.ai/api/v1/models')).toBe(true);
    });

    it('returns false when hostname differs', () => {
      expect(isSameOrigin('https://evil.com/models', 'https://api.openai.com/models')).toBe(false);
      expect(isSameOrigin('https://attacker.openai.com/models', 'https://openai.com/models')).toBe(false);
    });

    it('returns false when port differs', () => {
      expect(isSameOrigin('http://localhost:8081/models', 'http://localhost:8080/models')).toBe(false);
    });

    it('returns false when protocol differs', () => {
      expect(isSameOrigin('http://api.openai.com/models', 'https://api.openai.com/models')).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(isSameOrigin('not-a-url', 'https://api.openai.com/models')).toBe(false);
      expect(isSameOrigin('https://api.openai.com/models', 'invalid')).toBe(false);
    });
  });

  describe('cross-origin pagination rejection', () => {
    it('refuses to fetch cross-origin pagination URL, preventing credential leakage', async () => {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];

      const mockFetch: typeof globalThis.fetch = vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(urlInput);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: urlStr, headers });

        if (urlStr === 'https://api.provider.com/v1/models') {
          return new Response(
            JSON.stringify({
              data: [{ id: 'model-page-1' }],
              next_page: 'https://attacker-steals-tokens.com/models?page=2',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const target: ProviderTarget = {
        id: 'test-prov',
        label: 'Test Provider',
        prefix: 'test-prov',
        baseUrl: 'https://api.provider.com/v1',
        apiKey: 'sk-secret-token-12345',
        keySource: '9router-key',
      };

      const outcome = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });

      // First page was fetched with auth header
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://api.provider.com/v1/models');
      expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-secret-token-12345');

      // Attacker cross-origin URL was NEVER fetched
      const attacked = calls.some((c) => c.url.includes('attacker-steals-tokens.com'));
      expect(attacked).toBe(false);

      // Models from page 1 were kept, but pagination marked incomplete
      expect(outcome.models).toEqual(['model-page-1']);
      expect(outcome.incomplete).toBe(true);
      expect(outcome.error).toBe('incomplete-pagination');
    });

    it('allows same-origin pagination to proceed', async () => {
      const calls: string[] = [];

      const mockFetch: typeof globalThis.fetch = vi.fn(async (urlInput: string | URL | Request) => {
        const urlStr = String(urlInput);
        calls.push(urlStr);

        if (urlStr === 'https://api.provider.com/v1/models') {
          return new Response(
            JSON.stringify({
              data: [{ id: 'model-1' }],
              next_page: 'https://api.provider.com/v1/models?page=2',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr === 'https://api.provider.com/v1/models?page=2') {
          return new Response(
            JSON.stringify({
              data: [{ id: 'model-2' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const target: ProviderTarget = {
        id: 'test-prov',
        label: 'Test Provider',
        prefix: 'test-prov',
        baseUrl: 'https://api.provider.com/v1',
        apiKey: 'sk-secret',
        keySource: '9router-key',
      };

      const outcome = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });
      expect(calls).toHaveLength(2);
      expect(outcome.ok).toBe(true);
      expect(outcome.models).toEqual(['model-1', 'model-2']);
      expect(outcome.incomplete).toBe(false);
    });
  });

  describe('redirect handling under manual redirect', () => {
    it('blocks cross-origin redirects and refuses to forward Authorization headers', async () => {
      const calls: string[] = [];

      const mockFetch: typeof globalThis.fetch = vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(urlInput);
        calls.push(urlStr);
        expect((init as any)?.redirect).toBe('manual');

        if (urlStr === 'https://api.provider.com/v1/models') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://evil-harvest-keys.com/v1/models' },
          });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const target: ProviderTarget = {
        id: 'test-prov',
        label: 'Test Provider',
        prefix: 'test-prov',
        baseUrl: 'https://api.provider.com/v1',
        apiKey: 'secret-key-xyz',
        keySource: '9router-key',
      };

      const outcome = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });

      expect(calls).toHaveLength(1);
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe(302);
      expect(outcome.error).toContain('redirect-blocked');
    });

    it('follows safe same-origin redirects', async () => {
      const calls: string[] = [];

      const mockFetch: typeof globalThis.fetch = vi.fn(async (urlInput: string | URL | Request) => {
        const urlStr = String(urlInput);
        calls.push(urlStr);

        if (urlStr === 'https://api.provider.com/v1/models') {
          return new Response(null, {
            status: 301,
            headers: { Location: '/v2/models' },
          });
        }
        if (urlStr === 'https://api.provider.com/v2/models') {
          return new Response(
            JSON.stringify({
              data: [{ id: 'model-v2' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const target: ProviderTarget = {
        id: 'test-prov',
        label: 'Test Provider',
        prefix: 'test-prov',
        baseUrl: 'https://api.provider.com/v1',
        keySource: '9router-key',
      };

      const outcome = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });

      expect(calls).toEqual(['https://api.provider.com/v1/models', 'https://api.provider.com/v2/models']);
      expect(outcome.ok).toBe(true);
      expect(outcome.models).toEqual(['model-v2']);
    });
  });

  describe('payload limit protection', () => {
    it('aborts with payload-too-large when response exceeds SCAN_MAX_BYTES_PER_PAGE', async () => {
      const hugeData = 'a'.repeat(SCAN_MAX_BYTES_PER_PAGE + 1024);

      const mockFetch: typeof globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [{ id: 'model-1' }],
            padding: hugeData,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const target: ProviderTarget = {
        id: 'test-prov',
        label: 'Test Provider',
        prefix: 'test-prov',
        baseUrl: 'https://api.provider.com/v1',
        keySource: '9router-key',
      };

      const outcome = await fetchModelList(target, { fetchFn: mockFetch, retryDelaysMs: [] });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('payload-too-large');
    });
  });
});
