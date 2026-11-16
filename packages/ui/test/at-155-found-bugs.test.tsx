import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import { App } from '../src/App';
import { ApiProvider } from '../src/api';
import type { ApiClient } from '../src/api/client';
import type { DoctorConditionViewModel } from '../src/api/types';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-155 (R19-1): the bugs the INTERACTIVE render audit found.
 *
 * The audit scans the DOM of every route in every daemon state and every
 * language. Two of its hits were not a false positive of the grid, they were
 * real lies of the product:
 *
 *  1. the "Safety breaker" card of the Changes screen printed a breaker state
 *     and counters that nothing measured
 *     ("state: closed · consecutive failures: 0/3 · max_change_ratio: 12%/50%")
 *     and a "Normal. RouterSync is allowed to write." line with a check glyph,
 *     although the S1 view-model carries no breaker state at all;
 *  2. the Health screen printed "0 pass · 0 fail · 0 not evaluated" when the
 *     doctor had checked nothing — it reads like a clean bill of health.
 *
 * Both are fixed the way DECISIONS 2026-10-19-01 asks for: the screen is a
 * pure function of the view-model, so a state that was not measured is not
 * stated. This file is the dedicated test of both fixes.
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

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

const NOW = '2026-10-22T03:45:01.192Z';

function makeStub(conditions: DoctorConditionViewModel[]): ApiClient {
  return {
    isMock: () => false,
    getOverview: async () => ({
      meta: { source: 'unavailable', reason: 'needs_p3a', generatedAt: NOW },
      isFirstRun: false,
      isPaused: false,
      routers: { upCount: 0, probedCount: 0 },
      trackedModels: { count: 0 },
      billableRequestsToday: { code: 'by_design_zero_inference' },
      lastCheck: { code: 'daemon_running' },
      todoItems: [],
    }),
    getPipelineModules: async () => [],
    getHeartbeat: async () => ({
      ticks: [],
      source: 'unavailable' as const,
      daemonReachable: false,
    }),
    getProviders: async () => [],
    getModels: async () => [],
    getUnmatchedNames: async () => [],
    getUnknownTraits: async () => [],
    getTargets: async () => [],
    getPendingPlan: async () => ({
      meta: { source: 'unavailable', reason: 'needs_p3a', generatedAt: NOW },
      id: 'plan',
      proposalCode: '#none',
      planHash: 'sha256',
      computedTimeAgo: '',
      impactPercent: 0,
      maxImpactPercent: 50,
      billableRequestsCount: 0,
      targetsSummary: '',
      hasRollbackBackup: false,
      sourceDetail: '',
      actions: [],
      deliberateExclusions: [],
      unifiedDiff: '',
    }),
    getSnapshots: async () => [],
    getHealthSummary: async () => ({
      meta: { source: 'unavailable', reason: 'needs_p3a', generatedAt: NOW },
      doctorConditions: [],
      recentAlerts: [],
    }),
    getDoctor: async () => ({
      meta: { source: 'live', generatedAt: NOW },
      overallStatus: 'healthy' as const,
      conditions,
    }),
    getDaemonHealth: async () => ({
      reachable: true,
      uptimeSeconds: 1,
      readOnly: true,
      routers: [],
    }),
    getCombos: async () => [],
  } as unknown as ApiClient;
}

async function renderApp(conditions: DoctorConditionViewModel[] = []) {
  const { container } = render(
    <ApiProvider value={makeStub(conditions)}>
      <App />
    </ApiProvider>,
  );
  await waitFor(() => {
    expect(within(container).getByRole('navigation')).toBeTruthy();
  });
  return { container };
}

/** Clicks the sidebar entry whose label starts with `label`. */
function goTo(container: HTMLElement, label: string): void {
  const nav = within(container).getByRole('navigation');
  const button = within(nav)
    .getAllByRole('button')
    .find((candidate) => (candidate.textContent ?? '').trim().startsWith(label));
  if (!button) {
    const labels = within(nav)
      .getAllByRole('button')
      .map((candidate) => (candidate.textContent ?? '').trim());
    throw new Error(`no sidebar entry "${label}", found: ${labels.join(' | ')}`);
  }
  fireEvent.click(button);
}

/** Escapes a label so it can be used inside a regular expression. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('AT-155: the bugs the interactive render audit found', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    describe(`language: ${lang}`, () => {
      /* --- bug 1: the safety breaker card of the Changes screen ------- */

      it('the safety breaker card states no breaker state and no invented numbers', async () => {
        setLanguage(lang);
        const { container } = await renderApp();
        goTo(container, t('nav_changes'));
        // the breaker card lives in the second tab of the Changes screen
        fireEvent.click(
          screen.getByRole('tab', { name: new RegExp(`^${escapeRe(t('c_tab2'))}`) }),
        );
        await waitFor(() => {
          expect(document.getElementById('cb-t')).toBeTruthy();
        });

        const card = (document.getElementById('cb-t')?.textContent ?? '').trim();
        // The card says the rule and that the state was not measured.
        expect(card).toContain(t('r19_cb_state_unknown'));
        // It must NOT state a state that nothing measured.
        expect(card).not.toMatch(/closed|open\b/i);
        expect(card).not.toMatch(/0\s*\/\s*3/);
        expect(card).not.toMatch(/\d+\s*%/);
        // It must NOT say that RouterSync is allowed to write.
        expect(card).not.toMatch(/RouterSync được phép ghi|allowed to write/i);
      });

      /* --- bug 2: the doctor summary of the Health screen ------------ */

      it('the doctor says that nothing was checked when it had no condition', async () => {
        setLanguage(lang);
        const { container } = await renderApp([]);
        goTo(container, t('nav_health'));
        await waitFor(() => {
          expect(screen.getByTestId('health-screen')).toBeTruthy();
        });

        fireEvent.click(screen.getByRole('button', { name: t('h_dr') }));
        await waitFor(() => {
          expect(screen.getByTestId('doctor-notice')).toBeTruthy();
        });

        const notice = (screen.getByTestId('doctor-notice').textContent ?? '').trim();
        expect(notice).toBe(t('r19_doctor_nothing_checked'));
        // No count of passes and failures may be printed when nothing ran.
        expect(notice).not.toMatch(/\b0\b/);
        expect(notice).not.toMatch(/pass|fail|đạt|không đạt/i);
      });

      it('the doctor still counts the states it really checked', async () => {
        setLanguage(lang);
        const conditions: DoctorConditionViewModel[] = [
          { id: 'c1', condKey: 'k1', state: 'pass' },
          { id: 'c2', condKey: 'k2', state: 'fail' },
          { id: 'c3', condKey: 'k3', state: 'not_checked' },
        ];
        const { container } = await renderApp(conditions);
        goTo(container, t('nav_health'));
        await waitFor(() => {
          expect(screen.getByTestId('health-screen')).toBeTruthy();
        });

        fireEvent.click(screen.getByRole('button', { name: t('h_dr') }));
        await waitFor(() => {
          expect(screen.getByTestId('doctor-notice')).toBeTruthy();
        });

        const notice = (screen.getByTestId('doctor-notice').textContent ?? '').trim();
        expect(notice).toBe(t('r14_doctor_summary', { pass: 1, fail: 1, notChecked: 1 }));
      });
    });
  }
});
