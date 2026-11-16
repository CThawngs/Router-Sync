import React from 'react';
import { describe, it as vitestIt, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor as tlWaitFor, cleanup, within } from '@testing-library/react';
import { App } from '../src/App';
import { ApiProvider } from '../src/api';
import type { ApiClient } from '../src/api/client';
import { t } from '../src/i18n';

/**
 * R19-0: the UI suite runs its files in parallel, so the App's six requests
 * can take longer than the vitest default (5 s) on a loaded machine. The
 * R19-0b evidence shows AT-149 test 1 dying on that deadline while the same
 * file passed in 2.2 s in isolation. Only the DEADLINES move here: no
 * assertion is added, removed or weakened.
 */
const WAIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;

/** `waitFor` with a deadline this file can live with. */
function waitFor<T>(fn: () => T, opts?: { timeout?: number }): Promise<T> {
  return tlWaitFor(fn, { timeout: WAIT_TIMEOUT_MS, ...opts });
}

/**
 * `it` with a deadline this file can live with.
 *
 * R19-0c: the helper is a plain `const` (not a renamed function) so the source
 * keeps the literal `it` call at every test site. The assertion counter
 * (`tools/agent/assert-counts.mjs`) counts cases with the regex
 * `\b(?:it|test)\s*\(`, so a renamed wrapper would look like 10 lost cases.
 */
const it: (name: string, fn: () => void | Promise<void>) => void = (name, fn) =>
  vitestIt(name, fn, TEST_TIMEOUT_MS);

/**
 * AT-149 (R16-2): the shell and the Overview must be a pure function of the
 * view-model.
 *
 * R16-2 collected six claims about the app shell. This test turns every one
 * of them into an assertion, so that a later "shortcut" (a hard-coded chip, a
 * hard-coded banner, a badge that survives an unavailable endpoint) turns the
 * test RED instead of quietly painting a lie.
 *
 * The claims:
 *  1. the top bar chip carries the MEASURED number of targets;
 *  2. the global strip says where the data comes from (sample / unreachable);
 *  3. the changes badge comes from the pending plan and disappears when the
 *     plan is not available;
 *  4. the sidebar heartbeat box reports the daemon uptime and never a
 *     made-up scan age;
 *  5. the Overview hero is derived from the view-model (routers up/probed,
 *     read-only notice, review button);
 *  6. the KPI tiles and the five step counters show a value only when the
 *     view-model carries one.
 */

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

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

interface StubOptions {
  isMock?: boolean;
  /** `undefined` -> the view-model carries no router numbers at all. */
  upCount?: number | undefined;
  probedCount?: number | undefined;
  trackedModels?: number | undefined;
  requestsCount?: number | undefined;
  lastCheckCode?: string | undefined;
  targetCount?: number;
  planAvailable?: boolean;
  planActions?: number;
  reachable?: boolean;
  uptimeSeconds?: number;
  readOnly?: boolean;
  heartbeatMeasured?: boolean;
  overviewSource?: 'live' | 'sample' | 'unavailable';
  /** true -> the view-model carries NO numbers at all. */
  empty?: boolean;
}

function makeStub(options: StubOptions = {}): ApiClient {
  const {
    isMock = false,
    upCount = 1,
    probedCount = 2,
    trackedModels = 12,
    requestsCount = undefined,
    lastCheckCode = undefined,
    targetCount = 3,
    planAvailable = true,
    planActions = 2,
    reachable = true,
    uptimeSeconds = 42,
    readOnly = true,
    heartbeatMeasured = false,
    overviewSource = 'live',
  } = options;

  const now = new Date().toISOString();
  const empty = options.empty === true;
  const hasRouters = !empty && typeof upCount === 'number' && typeof probedCount === 'number';
  const models = empty ? undefined : trackedModels;
  const requests = empty ? undefined : requestsCount;
  const lastCheck = empty ? undefined : lastCheckCode;

  const overview = {
    meta: { source: overviewSource, generatedAt: now },
    isFirstRun: false,
    isPaused: false,
    ...(hasRouters ? { routers: { upCount, probedCount } } : {}),
    ...(typeof models === 'number' ? { trackedModels: { count: models } } : {}),
    ...(typeof requests === 'number' ? { billableRequestsToday: { count: requests } } : {}),
    ...(lastCheck ? { lastCheck: { code: lastCheck } } : {}),
    todoItems: [],
  };

  const plan = {
    meta: {
      source: planAvailable ? ('live' as const) : ('unavailable' as const),
      reason: planAvailable ? undefined : ('needs_p3a' as const),
      generatedAt: now,
    },
    id: 'plan-stub',
    proposalCode: '#stub',
    planHash: 'sha256-stub',
    computedTimeAgo: '',
    impactPercent: 0,
    maxImpactPercent: 50,
    billableRequestsCount: 0,
    targetsSummary: '',
    hasRollbackBackup: false,
    sourceSummary: '',
    sourceDetail: '',
    actions: Array.from({ length: planActions }, (_, i) => ({
      id: `act${i + 1}`,
      type: 'add',
      modelId: 'm1',
      titleKey: 'c_a1',
      description: 'c_a1w',
      appliesTo: 'c_a1t',
      risk: 'low',
      source: 'auto',
    })),
    deliberateExclusions: [],
    unifiedDiff: '',
  };

  return {
    isMock: () => isMock,
    getOverview: async () => overview,
    getPipelineModules: async () => [],
    getHeartbeat: async () =>
      heartbeatMeasured
        ? {
            ticks: [
              { id: 't1', status: 'ok' as const },
              { id: 't2', status: 'missed' as const },
            ],
            source: 'measured' as const,
            uptimeSeconds,
            lastProbeAt: '2026-10-20T10:00:00.000Z',
            daemonReachable: reachable,
          }
        : {
            ticks: [],
            source: 'unavailable' as const,
            uptimeSeconds,
            lastProbeAt: '2026-10-20T10:00:00.000Z',
            daemonReachable: reachable,
          },
    getProviders: async () => [],
    getModels: async () => [],
    getUnmatchedNames: async () => [],
    getUnknownTraits: async () => [],
    getTargets: async () =>
      Array.from({ length: targetCount }, (_, i) => ({ id: `t${i + 1}`, name: `t${i + 1}` })),
    getPendingPlan: async () => plan,
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
    getDaemonHealth: async () => ({ reachable, uptimeSeconds, readOnly }),
    getCombos: async () => [],
  } as unknown as ApiClient;
}

async function renderApp(options: StubOptions = {}): Promise<void> {
  render(
    <ApiProvider value={makeStub(options)}>
      <App />
    </ApiProvider>
  );
  await waitFor(() => {
    expect(screen.getByRole('navigation')).toBeTruthy();
  });
}

/** The sidebar entry of a screen, including its badge text. */
function navEntry(label: string): HTMLElement {
  const nav = within(screen.getByRole('navigation'));
  const buttons = nav.getAllByRole('button');
  const found = buttons.find((button) => (button.textContent ?? '').trim().startsWith(label));
  if (!found) {
    throw new Error(
      `Sidebar has no entry "${label}". Found: ${buttons.map((b) => (b.textContent ?? '').trim()).join(' | ')}`
    );
  }
  return found;
}

/** The hero title of the Overview screen. */
function heroTitle(): string {
  return (document.getElementById('hero-t')?.textContent ?? '').trim();
}

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ *
 * 1. the top bar chip
 * ------------------------------------------------------------------ */

describe('AT-149: the shell never paints a number it did not measure', () => {
  it('1. the top-bar chip shows the measured target count and no sample wording', async () => {
    await renderApp({ targetCount: 3 });

    const chip = await waitFor(() => screen.getByTestId('mode-chip'));
    const text = (chip.textContent ?? '').trim();
    expect(text).toBe(t('tb_targets', { count: 3 }));
    expect(text).not.toContain('2 active');
    expect(text).not.toContain('1 preview');
    expect(text).not.toContain('2 active · 1 preview');
  });

  it('2. the global strip says SAMPLE for the mock client', async () => {
    await renderApp({ isMock: true, overviewSource: 'sample' });
    await waitFor(() => {
      expect(screen.getByTestId('data-source-sample')).toBeTruthy();
    });
    expect(screen.queryByTestId('data-source-unreachable')).toBeNull();
  });

  it('2b. the global strip says UNREACHABLE when the daemon does not answer', async () => {
    await renderApp({ reachable: false });
    await waitFor(() => {
      expect(screen.getByTestId('data-source-unreachable')).toBeTruthy();
    });
    expect(screen.queryByTestId('data-source-sample')).toBeNull();
  });

  it('3. the changes badge follows the pending plan and vanishes when it is unavailable', async () => {
    await renderApp({ planAvailable: true, planActions: 2 });
    await waitFor(() => {
      expect(navEntry(t('nav_changes')).textContent).toContain('2');
    });

    cleanup();

    await renderApp({ planAvailable: false, planActions: 0 });
    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeTruthy();
    });
    // The badge is gone: the entry carries the label only.
    expect((navEntry(t('nav_changes')).textContent ?? '').trim()).toBe(t('nav_changes'));
  });

  it('4. the heartbeat box reports the daemon uptime and invents no scan age', async () => {
    await renderApp({ uptimeSeconds: 42, heartbeatMeasured: false });

    const strip = screen.getByTestId('heartbeat-strip');
    // 24 marks, all of them the dashed "not measured" mark.
    expect(strip.children.length).toBe(24);
    expect(strip.getAttribute('aria-label')).toBe(t('hb_aria_unavailable'));

    const label = (screen.getByTestId('heartbeat-label').textContent ?? '').trim();
    expect(label).toContain(t('hb_uptime', { seconds: 42 }));
    expect(label.toLowerCase()).not.toContain('scanned');
  });

  it('5. the Overview hero is derived from the view-model', async () => {
    await renderApp({ upCount: 1, probedCount: 2 });
    await waitFor(() => {
      // R17-0.1: the sentence counts the routers that did NOT answer, so the
      // first placeholder is `down`, not `up`.
      expect(heroTitle()).toBe(t('d_hero_warn_routers', { down: 1, probed: 2 }));
    });

    cleanup();

    await renderApp({ upCount: 2, probedCount: 2 });
    await waitFor(() => {
      expect(heroTitle()).toBe(t('d_hero'));
    });

    cleanup();

    await renderApp({ upCount: 2, probedCount: 2, overviewSource: 'unavailable' });
    await waitFor(() => {
      expect(heroTitle()).toBe(t('d_hero_warn'));
    });
  });

  it('5b. the read-only sentence appears only when the daemon says read-only', async () => {
    await renderApp({ readOnly: true });
    await waitFor(() => {
      expect(screen.getByRole('main').textContent).toContain(t('d_hero_readonly'));
    });

    cleanup();

    await renderApp({ readOnly: false });
    await waitFor(() => {
      expect(screen.getByRole('main').textContent).not.toContain(t('d_hero_readonly'));
    });
  });

  it('5c. the review button disappears when the pending plan is unavailable', async () => {
    await renderApp({ planAvailable: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('d_hero_btn') })).toBeTruthy();
    });

    cleanup();

    await renderApp({ planAvailable: false });
    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: t('d_hero_btn') })).toBeNull();
  });

  it('6. the "not measured" label appears if and only if the tile shows a dash', async () => {
    // A full view-model: every number is known.
    await renderApp({
      upCount: 2,
      probedCount: 2,
      trackedModels: 12,
      requestsCount: 7,
      lastCheckCode: 'daemon_running',
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('metric-tile').length).toBe(4);
    });
    expect(screen.getByTestId('metric-routers-value').textContent).toBe('2/2');
    expect(screen.getByTestId('metric-models-value').textContent).toBe('12');
    expect(screen.queryAllByText(t('s1_not_measured')).length).toBe(0);

    cleanup();

    // An empty view-model: every number is unknown.
    await renderApp({ empty: true });
    await waitFor(() => {
      expect(screen.getAllByTestId('metric-tile').length).toBe(4);
    });
    expect(screen.getByTestId('metric-routers-value').textContent).toBe('—');
    expect(screen.getByTestId('metric-models-value').textContent).toBe('—');
    // One label per tile, and no more.
    expect(screen.getAllByText(t('s1_not_measured')).length).toBe(4);
  });

  it('6b. the five step counters come from the view-model', async () => {
    await renderApp({ trackedModels: 12, targetCount: 3, planAvailable: true, planActions: 2 });
    await waitFor(() => {
      expect(screen.getByTestId('how-step-1')).toBeTruthy();
    });

    expect(screen.getByTestId('how-step-count-1').textContent).toBe('—');
    expect(screen.getByTestId('how-step-count-2').textContent).toBe(
      t('d_h2c_unit', { count: 12 })
    );
    expect(screen.getByTestId('how-step-count-3').textContent).toBe('—');
    expect(screen.getByTestId('how-step-count-4').textContent).toBe(t('d_h4c'));
    expect(screen.getByTestId('how-step-count-5').textContent).toBe(
      t('d_h5c_unit', { count: 3 })
    );
  });
});
