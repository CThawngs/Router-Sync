import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { App } from '../src/App';
import { ApiProvider } from '../src/api';
import type { ApiClient } from '../src/api/client';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-151 (R17-0.1): the Overview banner counts the routers that did NOT answer.
 *
 * R16-2.4 derived the banner from the view-model, but fed it `upCount` while
 * the sentence says "did not respond". With 0 of 2 routers up the banner read
 * "0/2 routers did not respond" — the opposite of the payload. The R16 test
 * only covered the 1-of-2 case, where "up" and "down" happen to be the same
 * number, so the bug was invisible.
 *
 * This test therefore uses ASYMMETRIC cases only, plus the boundary where
 * `probedCount` is 0 (nothing was probed, so no claim about routers at all).
 * Every case runs in Vietnamese and in English, because the count sits inside
 * the translated sentence.
 */

const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

/** A stub client that reports exactly the router numbers of the case. */
/** Router reachability the stub daemon reports (R18-3). */
type StubRouter = { id: string; reachability: 'up' | 'down' | 'unknown' };

interface StubOptions {
  routers?: StubRouter[];
  reachable?: boolean;
}

function makeStub(
  upCount: number,
  probedCount: number,
  source: 'live' | 'unavailable',
  opts?: StubOptions
): ApiClient {
  const now = new Date().toISOString();
  return {
    isMock: () => false,
    getOverview: async () => ({
      meta: { source, generatedAt: now },
      isFirstRun: false,
      isPaused: false,
      routers: { upCount, probedCount },
      trackedModels: { count: 61 },
      billableRequestsToday: { code: 'by_design_zero_inference' },
      lastCheck: { code: 'daemon_running' },
      todoItems: [],
    }),
    getPipelineModules: async () => [],
    getHeartbeat: async () => ({ ticks: [], source: 'unavailable' as const, daemonReachable: true }),
    getProviders: async () => [],
    getModels: async () => [],
    getUnmatchedNames: async () => [],
    getUnknownTraits: async () => [],
    getTargets: async () => [],
    getPendingPlan: async () => ({
      meta: { source: 'unavailable' as const, reason: 'needs_p3a', generatedAt: now },
      id: 'plan',
      proposalCode: '#none',
      planHash: 'sha256',
      computedTimeAgo: '',
      impactPercent: 0,
      maxImpactPercent: 50,
      billableRequestsCount: 0,
      targetsSummary: '',
      hasRollbackBackup: false,
      sourceSummary: '',
      sourceDetail: '',
      actions: [],
      deliberateExclusions: [],
      unifiedDiff: '',
    }),
    getSnapshots: async () => [],
    getHealthSummary: async () => ({
      meta: { source: 'live' as const, generatedAt: now },
      doctorConditions: [],
      recentAlerts: [],
    }),
    getDoctor: async () => ({
      meta: { source: 'live' as const, generatedAt: now },
      overallStatus: 'healthy' as const,
      conditions: [],
    }),
    getDaemonHealth: async () => ({
      reachable: opts?.reachable ?? true,
      uptimeSeconds: 1,
      readOnly: true,
      routers: opts?.routers ?? [],
    }),
    getCombos: async () => [],
  } as unknown as ApiClient;
}

async function renderWith(
  upCount: number,
  probedCount: number,
  source: 'live' | 'unavailable' = 'live',
  opts?: StubOptions
) {
  render(
    <ApiProvider value={makeStub(upCount, probedCount, source, opts)}>
      <App />
    </ApiProvider>
  );
  await waitFor(() => {
    expect(screen.getByTestId('metric-routers-value')).toBeTruthy();
  });
}

function heroText(): string {
  return (document.getElementById('hero-t')?.textContent ?? '').trim();
}

function subtitleText(): string {
  return (screen.getByTestId('hero-subtitle').textContent ?? '').trim();
}

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

/** Cases where `downCount !== upCount`, so an "up" count cannot pass by luck. */
const ASYMMETRIC_CASES: ReadonlyArray<{ up: number; probed: number; down: number }> = [
  { up: 0, probed: 2, down: 2 },
  { up: 1, probed: 2, down: 1 },
  { up: 1, probed: 3, down: 2 },
  { up: 0, probed: 1, down: 1 },
];

describe('AT-151: the banner counts the routers that did not answer', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    describe(`language: ${lang}`, () => {
      for (const testCase of ASYMMETRIC_CASES) {
        it(`${testCase.up}/${testCase.probed} up -> "${testCase.down}/${testCase.probed}" not answered`, async () => {
          setLanguage(lang);
          await renderWith(testCase.up, testCase.probed);

          const expected = t('d_hero_warn_routers', {
            down: testCase.down,
            probed: testCase.probed,
          });
          expect(heroText()).toBe(expected);
          // The displayed string carries the DOWN count first.
          expect(heroText()).toContain(`${testCase.down}/${testCase.probed} `);
          // The tile keeps showing the raw measured pair (up/probed).
          expect(screen.getByTestId('metric-routers-value').textContent).toBe(
            `${testCase.up}/${testCase.probed}`
          );
        });
      }

      it('the 0-of-2 case does NOT print the up count (the R16 bug)', async () => {
        setLanguage(lang);
        await renderWith(0, 2);

        expect(heroText()).toBe(t('d_hero_warn_routers', { down: 2, probed: 2 }));
        expect(heroText()).not.toContain('0/2');
      });

      it('every probed router up -> the banner is the healthy one', async () => {
        setLanguage(lang);
        await renderWith(2, 2);
        expect(heroText()).toBe(t('d_hero'));
      });

      it('probedCount 0 -> no claim about routers, the tile shows a dash', async () => {
        setLanguage(lang);
        await renderWith(0, 0);

        expect(heroText()).toBe(t('d_hero_unmeasured'));
        expect(screen.getByTestId('metric-routers-value').textContent).toBe('—');
        // No "N/M routers ..." sentence at all.
        expect(heroText()).not.toMatch(/\d+\/\d+/);
      });
    });
  }
});

/**
 * AT-151 (R18-3): the line right under the banner may not contradict it.
 *
 * On the owner's real screenshot the yellow banner said "1/2 routers did not
 * respond" while the subtitle under it said "Nothing needs your attention
 * right now". Both strings were separately defensible; together they were a
 * lie. The subtitle is now derived from the same state as the banner:
 *   - daemon not reachable      -> claim nothing;
 *   - a router did not answer   -> name the measured ones, else neutral text;
 *   - nothing measured          -> claim nothing;
 *   - every probed router up    -> the calm sentence is finally allowed.
 * The table below pins every one of those states, in VI and EN.
 */
describe('AT-151 (R18-3): the banner subtitle never contradicts the banner', () => {
  // R19-3.1: the named routers are PRODUCT names now (`OmniRoute`,
  // `9Router`), not the raw ids the daemon speaks.
  const DOWN_NAME = t('r18_hero_sub_down_named', { routers: 'OmniRoute, 9Router' });
  const CALM = t('d_hero_p_none');

  for (const lang of ['vi', 'en'] as readonly Language[]) {
    describe(`language: ${lang}`, () => {
      it('0/2 up -> the subtitle names the routers that did not answer', async () => {
        setLanguage(lang);
        await renderWith(0, 2, 'live', {
          routers: [
            { id: 'omniroute', reachability: 'down' },
            { id: '9router', reachability: 'down' },
          ],
        });

        expect(subtitleText()).toBe(
          t('r18_hero_sub_down_named', { routers: 'OmniRoute, 9Router' })
        );
        // R19-3.1: the reader gets the PRODUCT name, not the daemon id.
        expect(subtitleText()).toContain('OmniRoute');
        expect(subtitleText()).toContain('9Router');
        // The raw machine ids must not reach the reader.
        expect(subtitleText()).not.toContain('omniroute');
        expect(subtitleText()).not.toContain('9router');
        expect(subtitleText()).not.toBe(CALM);
      });

      it('1/2 up -> only the router that did not answer is named', async () => {
        setLanguage(lang);
        await renderWith(1, 2, 'live', {
          routers: [
            { id: 'omniroute', reachability: 'down' },
            { id: '9router', reachability: 'up' },
          ],
        });

        expect(subtitleText()).toBe(t('r18_hero_sub_down_named', { routers: 'OmniRoute' }));
        expect(subtitleText()).toContain('OmniRoute');
        // The router that DID answer is named neither by id nor by product.
        expect(subtitleText()).not.toContain('9router');
        expect(subtitleText()).not.toContain('9Router');
        expect(subtitleText()).not.toContain('omniroute');
        expect(subtitleText()).not.toBe(CALM);
      });

      it('2/2 up -> the calm sentence is allowed, and only then', async () => {
        setLanguage(lang);
        await renderWith(2, 2, 'live', {
          routers: [
            { id: 'omniroute', reachability: 'up' },
            { id: '9router', reachability: 'up' },
          ],
        });

        expect(subtitleText()).toBe(t('d_hero_p_none'));
      });

      it('a router is down but no router name was measured -> neutral sentence', async () => {
        setLanguage(lang);
        await renderWith(1, 2, 'live', { routers: [] });

        expect(subtitleText()).toBe(t('r18_hero_sub_down_unnamed'));
        expect(subtitleText()).not.toBe(CALM);
      });

      it('probedCount 0 -> no claim in the subtitle either', async () => {
        setLanguage(lang);
        await renderWith(0, 0);

        expect(subtitleText()).toBe(t('r18_hero_sub_unknown'));
        expect(subtitleText()).not.toBe(CALM);
      });

      it('daemon not reachable -> no claim, even with a measured down router', async () => {
        setLanguage(lang);
        await renderWith(1, 2, 'live', {
          reachable: false,
          routers: [
            { id: 'omniroute', reachability: 'down' },
            { id: '9router', reachability: 'up' },
          ],
        });

        expect(subtitleText()).toBe(t('r18_hero_sub_unknown'));
        expect(subtitleText()).not.toBe(CALM);
        // No router is named at all — neither by id nor by product name.
        expect(subtitleText()).not.toContain('omniroute');
        expect(subtitleText()).not.toContain('OmniRoute');
        expect(subtitleText()).not.toContain('9router');
        expect(subtitleText()).not.toContain('9Router');
      });
    });
  }

  // The exact string from the owner's screenshot, as a regression guard.
  it('the warning banner and the calm subtitle cannot appear together', async () => {
    await renderWith(1, 2, 'live', { routers: [] });
    expect(heroText()).toBe(t('d_hero_warn_routers', { down: 1, probed: 2 }));
    expect(subtitleText()).not.toBe(t('d_hero_p_none'));
    expect(DOWN_NAME).not.toBe(CALM);
    // The named sentence carries the product names, so it is a different
    // string from the one built out of the raw ids.
    expect(DOWN_NAME).not.toBe(t('r18_hero_sub_down_named', { routers: 'omniroute, 9router' }));
  });
});

/**
 * AT-151 (R19-3.1): a router reaches the reader under its PRODUCT name.
 *
 * The daemon speaks ids (`omniroute`, `9router`); the reader knows products
 * (`OmniRoute`, `9Router`). The R18-3 banner printed the raw id, which reads
 * like a machine token rather than a name. The catalog is
 * `r19_router_label_<id>`: a name is LOOKED UP, never guessed. An id nobody
 * described is printed exactly as it arrived — a product name is never
 * invented for a router the catalog does not know.
 */
describe('AT-151 (R19-3.1): the banner subtitle names routers by product name', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    describe(`language: ${lang}`, () => {
      it('a known router shows its product name, never its raw id', async () => {
        setLanguage(lang);
        await renderWith(0, 2, 'live', {
          routers: [
            { id: 'omniroute', reachability: 'down' },
            { id: '9router', reachability: 'down' },
          ],
        });

        expect(subtitleText()).toContain('OmniRoute');
        expect(subtitleText()).toContain('9Router');
        expect(subtitleText()).toBe(
          t('r18_hero_sub_down_named', { routers: 'OmniRoute, 9Router' })
        );
        expect(subtitleText()).not.toContain('omniroute');
        expect(subtitleText()).not.toContain('9router');
        // The banner title carries the count only, never a router id.
        expect(heroText()).not.toContain('omniroute');
        expect(heroText()).not.toContain('9router');
      });

      it('the rendered sentence is not the raw-id sentence', async () => {
        setLanguage(lang);
        await renderWith(0, 2, 'live', {
          routers: [
            { id: 'omniroute', reachability: 'down' },
            { id: '9router', reachability: 'down' },
          ],
        });

        expect(subtitleText()).not.toBe(
          t('r18_hero_sub_down_named', { routers: 'omniroute, 9router' })
        );
      });

      it('an unknown router id is printed verbatim, no name is invented for it', async () => {
        setLanguage(lang);
        await renderWith(0, 2, 'live', {
          routers: [
            { id: 'weirdrouter', reachability: 'down' },
            { id: 'omniroute', reachability: 'down' },
          ],
        });

        // The raw id reaches the reader exactly as the daemon sent it.
        expect(subtitleText()).toContain('weirdrouter');
        expect(subtitleText()).toBe(
          t('r18_hero_sub_down_named', { routers: 'weirdrouter, OmniRoute' })
        );
        // The known router next to it is still named by its product.
        expect(subtitleText()).toContain('OmniRoute');
        // ...exactly once: the unknown id did not borrow that product name.
        expect(subtitleText().split('OmniRoute')).toHaveLength(2);
        // No product name was invented for the id the catalog does not know.
        expect(subtitleText()).not.toMatch(/Weird/);
        expect(subtitleText()).not.toContain('weirdRouter');
        expect(subtitleText()).not.toContain('weird router');
      });
    });
  }
});