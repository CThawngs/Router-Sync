import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkOfficial,
  clearOfficialCache,
  extractModelIds,
  resolveOfficialSource,
  PER_ID_429_LIMIT,
  perIdStatusConclusion,
  setPerId429Limit,
} from '../src/commands/stale-official.js';
import { hfModelUrl } from '../src/sync/confirm.js';

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

describe('C26 D5: HF and NVIDIA catalog sources', () => {
  const HF = {
    provider: 'hf', label: 'Hugging Face public models API',
    url: 'https://huggingface.co/api/models', kind: 'model-list-api' as const,
  };
  const NVIDIA = {
    provider: 'nvidia', label: 'NVIDIA models (models.dev community catalog)',
    url: 'https://models.dev/api.json', kind: 'catalog-api' as const,
  };

  it('resolves the two highest-row public providers; nvidia is a catalog, not official', () => {
    expect(resolveOfficialSource('hf')?.url).toBe(HF.url);
    const nvidia = resolveOfficialSource('nvidia');
    expect(nvidia?.url).toBe(NVIDIA.url);
    expect(nvidia?.kind).toBe('catalog-api');
    expect(nvidia?.kind).not.toBe('official');
  });

  it('extracts Hugging Face bare-array ids and models.dev catalog ids', () => {
    expect([...extractModelIds(HF, [{ id: 'org/model-a' }])]).toEqual(['org/model-a']);
    const ids = extractModelIds(NVIDIA, { nvidia: { models: { 'nvidia/model-b': {} } } });
    expect([...ids]).toEqual(['nvidia/model-b']);
  });

  it('reports UPSTREAM-UNREACHABLE on a network error for the new sources', async () => {
    clearOfficialCache();
    for (const provider of ['hf', 'nvidia']) {
      const result = await checkOfficial(provider, 'vendor/model-a', { fetchImpl: failingFetch(), now: fixedNow });
      expect(result.conclusion).toBe('UPSTREAM-UNREACHABLE');
    }
  });
});

describe('C28 H1: HF per-id existence check', () => {
  const URL_A = hfModelUrl('org/model-a');

  function captureFetch(
    status: number,
    extra: { urls?: string[]; jsonThrows?: boolean; throwError?: boolean; body?: unknown } = {},
  ) {
    const urls = extra.urls ?? [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (extra.throwError) throw new Error('network down');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (extra.jsonThrows) throw new Error('invalid JSON');
          return extra.body ?? {};
        },
      };
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('200 → LISTED-UPSTREAM via the per-id URL (catalog never fetched)', async () => {
    const { fetchImpl, urls } = captureFetch(200, { body: { id: 'org/model-a' } });
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow });
    expect(res.conclusion).toBe('LISTED-UPSTREAM');
    expect(res.provider).toBe('hf');
    expect(res.source?.url).toBe('https://huggingface.co/api/models');
    expect(urls).toEqual([URL_A]);
  });

  it('200 with unparseable body → UPSTREAM-UNREACHABLE', async () => {
    const { fetchImpl } = captureFetch(200, { jsonThrows: true });
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('404 → NOT-LISTED-UPSTREAM', async () => {
    const { fetchImpl } = captureFetch(404);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow });
    expect(res.conclusion).toBe('NOT-LISTED-UPSTREAM');
  });

  it('429 hết lượt → UPSTREAM-UNREACHABLE (C30 K3.1: hết lượt vì giới hạn tốc độ, không phải repo bị hạn chế)', async () => {
    const { fetchImpl } = captureFetch(429);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
    expect(res.detail).toContain('429');
    expect(res.conclusion).not.toBe('NOT-LISTED-UPSTREAM');
  });

  it('C30 K3.2: 500 → UPSTREAM-UNREACHABLE (lỗi máy chủ, không phải repo bị hạn chế)', async () => {
    const { fetchImpl } = captureFetch(500);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('C30 K3.2: 502 → UPSTREAM-UNREACHABLE', async () => {
    const { fetchImpl } = captureFetch(502);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('C30 K3.2: 401 → ACCESS-RESTRICTED-OR-ABSENT (repo cần đăng nhập)', async () => {
    const { fetchImpl } = captureFetch(401);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('ACCESS-RESTRICTED-OR-ABSENT');
  });

  it('C30 K3.2: 403 → ACCESS-RESTRICTED-OR-ABSENT (repo bị chặn)', async () => {
    const { fetchImpl } = captureFetch(403);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('ACCESS-RESTRICTED-OR-ABSENT');
  });

  it('C30 K3.2: 418 (4xx khác ngoài 404/429) → ACCESS-RESTRICTED-OR-ABSENT', async () => {
    const { fetchImpl } = captureFetch(418);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('ACCESS-RESTRICTED-OR-ABSENT');
  });

  it('C30 K3.2: hết thời gian chờ (timeout) → UPSTREAM-UNREACHABLE', async () => {
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
  });

  it('C30 K3.2 mutation: nếu 500 quay lại ACCESS-RESTRICTED-OR-ABSENT thì perIdStatusConclusion đỏ', () => {
    // Hợp đồng phi mạng: bảng mã trạng thái phải khớp từng nhánh.
    expect(perIdStatusConclusion(404)).toBe('NOT-LISTED-UPSTREAM');
    expect(perIdStatusConclusion(429)).toBe('UPSTREAM-UNREACHABLE');
    expect(perIdStatusConclusion(500)).toBe('UPSTREAM-UNREACHABLE');
    expect(perIdStatusConclusion(503)).toBe('UPSTREAM-UNREACHABLE');
    expect(perIdStatusConclusion(401)).toBe('ACCESS-RESTRICTED-OR-ABSENT');
    expect(perIdStatusConclusion(403)).toBe('ACCESS-RESTRICTED-OR-ABSENT');
    expect(perIdStatusConclusion(410)).toBe('ACCESS-RESTRICTED-OR-ABSENT');
  });

  it('C29 J0.3 mutation: with limit raised, 429s keep retrying (never 404)', async () => {
    setPerId429Limit(8);
    try {
      const { fetchImpl, urls } = captureFetch(429);
      const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
      expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
      expect(urls).toHaveLength(9);
    } finally {
      setPerId429Limit(4);
    }
  });

  it('network error → UPSTREAM-UNREACHABLE with detail', async () => {
    const { fetchImpl } = captureFetch(0, { throwError: true });
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow });
    expect(res.conclusion).toBe('UPSTREAM-UNREACHABLE');
    expect(res.detail).toBeDefined();
  });

  it('strips models/ prefix before the per-id probe', async () => {
    const { fetchImpl, urls } = captureFetch(200);
    await checkOfficial('hf', 'models/org/model-a', { fetchImpl, now: fixedNow });
    expect(urls[0]).toBe(URL_A);
  });

  it('nvidia: LISTED-IN-CATALOG from catalog id; NOT-IN-CATALOG when absent', async () => {
    clearOfficialCache();
    const listed = await checkOfficial('nvidia', 'nvidia/model-b', {
      fetchImpl: fakeFetch([{ id: 'nvidia/model-b' }]),
      now: fixedNow,
    });
    expect(listed.conclusion).toBe('LISTED-IN-CATALOG');
    expect(listed.source?.kind).toBe('catalog-api');
    clearOfficialCache();
    const missing = await checkOfficial('nvidia', 'nvidia/model-b', {
      fetchImpl: fakeFetch([]),
      now: fixedNow,
    });
    expect(missing.conclusion).toBe('NOT-IN-CATALOG');
    // Community catalog absence is not the removal claim of NOT-LISTED-UPSTREAM.
    expect(missing.conclusion).not.toBe('NOT-LISTED-UPSTREAM');
  });

  it('C29 J0.1 mutation: 403 → ACCESS-RESTRICTED-OR-ABSENT (also not LISTED/NOT-LISTED), digest 64-hex sha256', async () => {
    const { fetchImpl } = captureFetch(403);
    const res = await checkOfficial('hf', 'org/model-a', { fetchImpl, now: fixedNow, retryDelayMs: 0 });
    expect(res.conclusion).toBe('ACCESS-RESTRICTED-OR-ABSENT');
    expect(res.conclusion).not.toBe('LISTED-UPSTREAM');
    expect(res.conclusion).not.toBe('NOT-LISTED-UPSTREAM');
    const digest = createHash('sha256').update(res.conclusion).digest('hex');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update('ACCESS-RESTRICTED-OR-ABSENT').digest('hex'));
  });
});