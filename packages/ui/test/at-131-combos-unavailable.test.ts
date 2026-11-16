/**
 * packages/ui/test/at-131-combos-unavailable.test.ts
 *
 * Acceptance Test AT-131 (UI): HttpApi distinguishes 'unavailable' DB from empty 'no combos' (R12-3b, R13-1).
 *
 * Validates that when the daemon reports both DBs failed:
 * { meta: { source: 'unavailable', reason: 'db_unreadable' }, combos: [] }
 * HttpApi.getCombos() preserves the meta metadata on the returned array,
 * allowing UI callers to display "unavailable" rather than falsely saying "no combos yet".
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpApi } from '../src/api/http';
import type { ResponseMeta } from '../src/api/types';

describe('Acceptance Test AT-131 (UI): HttpApi getCombos unavailable detection (R12-3b, R13-1)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('preserves meta.source = "unavailable" when both router databases fail', async () => {
    const mockDaemonResponse = {
      meta: {
        source: 'unavailable' as const,
        reason: 'db_unreadable',
        generatedAt: '2026-10-19T00:00:00.000Z',
      },
      combos: [],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDaemonResponse,
    } as unknown as Response);

    const api = new HttpApi('http://127.0.0.1:3100');
    const combos = await api.getCombos();

    expect(Array.isArray(combos)).toBe(true);
    expect(combos.length).toBe(0);

    // Provenance metadata must be attached to distinguish unavailable from empty
    const meta = (combos as unknown as { meta?: ResponseMeta }).meta;
    expect(meta).toBeDefined();
    expect(meta?.source).toBe('unavailable');
    expect(meta?.reason).toBe('db_unreadable');
  });

  it('returns clean array without unavailable meta when databases are healthy', async () => {
    const mockHealthyCombos = [
      {
        meta: { source: 'live' as const, generatedAt: '2026-10-19T00:00:00.000Z' },
        id: 'routersync-fast',
        name: 'Fast Combo',
        type: 'managed' as const,
        badgeKey: 'badge_managed',
        targets: ['omniroute', '9router'],
        strategy: 'priority',
        steps: [{ position: 1, modelId: 'm1' }],
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockHealthyCombos,
    } as unknown as Response);

    const api = new HttpApi('http://127.0.0.1:3100');
    const combos = await api.getCombos();

    expect(Array.isArray(combos)).toBe(true);
    expect(combos.length).toBe(1);
    expect((combos as unknown as { meta?: ResponseMeta }).meta).toBeUndefined();
    expect(combos[0]?.meta?.source).toBe('live');
  });
});
