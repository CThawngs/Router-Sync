import { describe, expect, it } from 'vitest';
import {
  checkOfficial,
  clearOfficialCache,
  extractModelIds,
  resolveOfficialSource,
} from '../src/commands/stale-official.js';

const OPENROUTER = {
  provider: 'openrouter',
  label: 'OpenRouter models API',
  url: 'https://openrouter.ai/api/v1/models',
  kind: 'model-list-api' as const,
};

function fakeFetch(payload: unknown, init?: { ok?: boolean; status?: number }) {
  return (async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function failingFetch() {
  return (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

const fixedNow = () => new Date('2026-11-20T00:00:00.000Z');

describe('C21 Y3: official source conclusions', () => {
  it('resolves known public providers and rejects unknown ones', () => {
    expect(resolveOfficialSource('openrouter')?.url).toBe(OPENROUTER.url);
    expect(resolveOfficialSource('or')?.provider).toBe('openrouter');
    expect(resolveOfficialSource('<pp01>')).toBeNull();
  });

  it('extracts ids from an OpenRouter-style payload', () => {
    const ids = extractModelIds(OPENROUTER, {
      data: [{ id: 'vendor/model-a' }, { id: 'models/vendor/model-b' }],
    });
    expect([...ids].sort()).toEqual(['vendor/model-a', 'vendor/model-b']);
  });

  it('reports LISTED-UPSTREAM when the catalog contains the model', async () => {
    clearOfficialCache();
    const result = await checkOfficial('openrouter', 'vendor/model-a', {
      fetchImpl: fakeFetch({ data: [{ id: 'vendor/model-a' }] }),
      now: fixedNow,
    });
    expect(result.conclusion).toBe('LISTED-UPSTREAM');
    expect(result.source?.url).toBe(OPENROUTER.url);
    expect(result.checkedAt).toBe('2026-11-20T00:00:00.000Z');
  });

  it('reports NOT-LISTED-UPSTREAM when a reachable catalog omits the model', async () => {
    clearOfficialCache();
    const result = await checkOfficial('openrouter', 'vendor/model-z', {
      fetchImpl: fakeFetch({ data: [{ id: 'vendor/model-a' }] }),
      now: fixedNow,
    });
    expect(result.conclusion).toBe('NOT-LISTED-UPSTREAM');
  });

  it('reports UPSTREAM-UNREACHABLE on a network error, never NOT-LISTED', async () => {
    clearOfficialCache();
    const result = await checkOfficial('openrouter', 'vendor/model-a', {
      fetchImpl: failingFetch(),
      now: fixedNow,
    });
    expect(result.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('reports UPSTREAM-UNREACHABLE on an HTTP error, never NOT-LISTED', async () => {
    clearOfficialCache();
    const result = await checkOfficial('openrouter', 'vendor/model-a', {
      fetchImpl: fakeFetch({}, { ok: false, status: 503 }),
      now: fixedNow,
    });
    expect(result.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('reports NO-OFFICIAL-SOURCE for a provider without a catalog', async () => {
    clearOfficialCache();
    const result = await checkOfficial('<pp01>', 'vendor/model-a', { now: fixedNow });
    expect(result.conclusion).toBe('NO-OFFICIAL-SOURCE');
  });
});