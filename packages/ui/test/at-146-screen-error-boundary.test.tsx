import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { App } from '../src/App';
import { ApiProvider } from '../src/api';
import type { ApiClient } from '../src/api/client';
import { t } from '../src/i18n';

/**
 * AT-146 (R16-1): one error boundary per screen.
 *
 * Before R16 a single malformed field unmounted the WHOLE React tree: the
 * user saw a white page with no way back to the app. Now every route is
 * wrapped in its own boundary, so a screen that cannot render shows a short,
 * honest error card while the sidebar, the top bar and every other screen
 * keep working.
 *
 * This test throws INSIDE one screen and checks that the rest of the
 * application survives.
 */

/**
 * jsdom does not implement `window.matchMedia`; the shell asks for the
 * prefers-color-scheme on every render (same stub as at-78-theme / at-147).
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

/**
 * A client that behaves like the real one on every route except the combos
 * route, which hands back a combo whose `strategy` is an OBJECT. React
 * refuses an object as a child, so the combos screen throws while rendering.
 */
function makeBrokenApi(): ApiClient {
  const base = {
    isMock: () => false,
    getOverview: async () => ({
      meta: { source: 'live' as const, generatedAt: new Date().toISOString() },
      routers: { upCount: 1, probedCount: 2 },
      trackedModels: { count: 3 },
      billableRequestsToday: { code: 'by_design_zero_inference' },
      lastCheck: { code: 'daemon_running' },
    }),
    getPipelineModules: async () => [],
    getHeartbeat: async () => ({
      ticks: [],
      source: 'unavailable' as const,
      daemonReachable: true,
    }),
    getProviders: async () => [],
    getModels: async () => [],
    getUnmatchedNames: async () => [],
    getUnknownTraits: async () => [],
    getTargets: async () => [],
    getPendingPlan: async () => ({
      meta: { source: 'unavailable' as const, reason: 'needs_p3a', generatedAt: new Date().toISOString() },
      id: 'plan-empty',
      proposalCode: '#none',
      planHash: 'sha256-empty',
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
      meta: { source: 'live' as const, generatedAt: new Date().toISOString() },
      doctorConditions: [],
      recentAlerts: [],
    }),
    getDoctor: async () => ({
      meta: { source: 'live' as const, generatedAt: new Date().toISOString() },
      overallStatus: 'healthy' as const,
      conditions: [],
    }),
    getDaemonHealth: async () => ({ reachable: true, uptimeSeconds: 5, readOnly: true }),
  };
  return {
    ...base,
    getCombos: async () =>
      [
        {
          id: 'broken',
          name: 'Broken Combo',
          strategy: { fallbackStrategy: 'fallback' } as unknown as string,
          type: 'managed',
          targets: [],
          steps: [],
        },
      ] as never,
  } as unknown as ApiClient;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AT-146: a broken screen must not blank the whole application', () => {
  it('shows a local error card on the broken screen and keeps the sidebar alive', async () => {
    // The error boundary logs the diagnostic to the console on purpose.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ApiProvider value={makeBrokenApi()}>
        <App />
      </ApiProvider>
    );

    // The shell is up.
    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeTruthy();
    });

    // Open the broken screen.
    fireEvent.click(screen.getByRole('button', { name: t('nav_combos') }));

    await waitFor(() => {
      expect(screen.getByTestId('screen-error-fallback')).toBeTruthy();
    });

    const fallback = screen.getByTestId('screen-error-fallback');
    // The fallback says what happened and carries a short code.
    expect(fallback.textContent).toContain(t('err_boundary_title'));
    expect(fallback.textContent).toContain('RS-SCREEN-001');
    expect(fallback.getAttribute('data-screen-id')).toBe('combos');

    // The shell survives: the sidebar is still there with its entries.
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('nav_overview') })).toBeTruthy();

    // Another screen still renders.
    fireEvent.click(screen.getByRole('button', { name: t('nav_overview') }));
    await waitFor(() => {
      expect(screen.getAllByTestId('metric-tile').length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('screen-error-fallback')).toBeNull();

    expect(consoleError).toHaveBeenCalled();
  });
});
