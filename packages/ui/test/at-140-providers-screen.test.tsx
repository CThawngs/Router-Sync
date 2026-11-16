import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProvidersScreen } from '../src/screens/ProvidersScreen';
import { MockApi } from '../src/api/mock';
import type { ApiClient } from '../src/api/client';
import type { ProviderViewModel, ResponseMeta } from '../src/api/types';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-140 (R17-1): the Providers screen is a pure function of the view-model.
 *
 * The R16 screen painted six prototype cards with their numbers (models,
 * quota, scan age) whatever the daemon answered, and it painted them in the
 * `unavailable` state too. Three states must stay apart:
 *
 *  - `unavailable` -> a dashed "needs P3a" frame, NO card, NO number;
 *  - `sample`      -> the prototype cards, with the "sample data" badge;
 *  - `live` + none -> an empty state, which is NOT the "needs P3a" frame.
 *
 * The sample content lives in `api/mock.ts` only, so the assertions look for
 * the sample names and numbers, not for a screenshot.
 */

function liveClient(): ApiClient {
  return { isMock: () => false, getProviders: async () => [] } as unknown as ApiClient;
}

function collection<T>(items: T[], source: ResponseMeta['source']): T[] {
  (items as unknown as { meta: ResponseMeta }).meta = {
    source,
    reason: source === 'unavailable' ? 'needs_p3a' : undefined,
    generatedAt: '2026-10-21T00:00:00.000Z',
  };
  return items;
}

const SAMPLE_NAMES = ['acme', 'lumen', 'nova', 'kite', 'orbit', 'zeta'];

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

describe('AT-140: Providers shows a card only when the view-model carries one', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`unavailable -> dashed frame, no card, no sample number (${lang})`, () => {
      setLanguage(lang);
      render(
        <ProvidersScreen
          api={liveClient()}
          providers={collection<ProviderViewModel>([], 'unavailable')}
        />
      );

      const frame = screen.getByTestId('providers-unavailable');
      expect(frame.textContent).toContain(t('s1_needs_p3a'));

      // No provider card at all.
      expect(screen.queryAllByTestId(/^provider-card-/)).toHaveLength(0);

      // No sample name and no sample number anywhere on the screen.
      const text = screen.getByTestId('providers-screen').textContent ?? '';
      for (const name of SAMPLE_NAMES) {
        expect(text).not.toContain(name);
      }
      for (const number of ['86', '41', '120', '97', '620', '1000']) {
        expect(text).not.toContain(number);
      }
      // And no summary chip either.
      expect(screen.queryByTestId('providers-summary')).toBeNull();
    });

    it(`live but empty -> empty state, not the "needs P3a" frame (${lang})`, () => {
      setLanguage(lang);
      render(
        <ProvidersScreen api={liveClient()} providers={collection<ProviderViewModel>([], 'live')} />
      );

      expect(screen.getByTestId('providers-empty-state')).toBeTruthy();
      expect(screen.queryByTestId('providers-unavailable')).toBeNull();
    });
  }

  it('sample -> the prototype cards, with the sample badge', async () => {
    const sample = await new MockApi().getProviders();
    render(<ProvidersScreen providers={sample} />);

    expect(screen.getByTestId('sample-badge')).toBeTruthy();
    expect(screen.getByTestId('sample-badge').textContent).toContain(t('r14_sample_badge'));
    // One card per prototype provider.
    const cards = document.querySelectorAll('[data-provider-status]');
    expect(cards).toHaveLength(6);
    expect(
      Array.from(cards).filter((c) => c.getAttribute('data-provider-status') === 'active')
    ).toHaveLength(4);
    expect(
      Array.from(cards).filter((c) => c.getAttribute('data-provider-status') === 'key_error')
    ).toHaveLength(1);
    expect(
      Array.from(cards).filter((c) => c.getAttribute('data-provider-status') === 'no_list_api')
    ).toHaveLength(1);
    // The summary chips count the collection, not a hard-coded "4 / 1 / 1".
    expect(screen.getByTestId('providers-summary').textContent).toContain(
      t('p_c1', { count: 4 })
    );
  });

  it('the screen and the mock agree on the numbers (one source of truth)', async () => {
    const sample = await new MockApi().getProviders();
    render(<ProvidersScreen providers={sample} />);

    const acme = sample.find((p) => p.id === 'acme');
    expect(acme).toBeDefined();
    const card = document.querySelector('[data-provider-id="acme"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain(String(acme?.modelsCount));
  });
});