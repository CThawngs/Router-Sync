import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import type { FirstRunViewModel, SystemOverview } from '../src/api/types';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-142 (R17-3): the first-run Overview claims only what it measured.
 *
 * The R16 branch printed a fixed "0 / 4" progress line and three "detected"
 * rows (two router addresses and one config path) for any payload, and it
 * offered the demo toggle even when the data was live. Now:
 *  - the demo toggle exists only for `sample` content;
 *  - the progress line comes from `FirstRunViewModel.checklistDone`;
 *  - the detection rows come from `FirstRunViewModel.detections`, and with no
 *    detections the card shows a dashed "needs P3a" frame instead.
 */

const NOW = '2026-10-21T00:00:00.000Z';

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

function overviewOf(source: 'live' | 'sample' | 'unavailable'): SystemOverview {
  return {
    meta: { source, generatedAt: NOW },
    isFirstRun: true,
    isPaused: false,
    routers: { upCount: 0, probedCount: 2 },
    trackedModels: { count: 0 },
    billableRequestsToday: {},
    lastCheck: {},
    todoItems: [],
  };
}

function renderBranch(source: 'live' | 'sample' | 'unavailable', firstRun?: FirstRunViewModel) {
  render(
    <OverviewScreen
      overview={overviewOf(source)}
      pipelineModules={[]}
      firstRun={firstRun}
      onNavigate={() => {}}
      onToggleFirstRun={() => {}}
      onOpenAgentDrawer={() => {}}
    />
  );
}

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

describe('AT-142: the first-run branch claims nothing it did not measure', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`live payload -> no demo toggle, no "0 / 4", dashed detections (${lang})`, () => {
      setLanguage(lang);
      renderBranch('live');

      expect(screen.queryByTestId('firstrun-demo-toggle')).toBeNull();
      expect(screen.queryByText('0 / 4')).toBeNull();
      expect(screen.getByTestId('firstrun-checklist').textContent).toBe('—');
      expect(screen.getByTestId('firstrun-detections-unavailable')).toBeTruthy();

      const text = document.body.textContent ?? '';
      expect(text).not.toContain('localhost:30128');
      expect(text).not.toContain('localhost:20128');
      expect(text).not.toContain('opencode.json');
    });

    it(`unavailable payload -> same, and no demo toggle (${lang})`, () => {
      setLanguage(lang);
      renderBranch('unavailable');

      expect(screen.queryByTestId('firstrun-demo-toggle')).toBeNull();
      expect(screen.getByTestId('firstrun-detections-unavailable')).toBeTruthy();
    });
  }

  it('sample payload -> the demo toggle and the sample content, with the badge', () => {
    renderBranch('sample', {
      checklistDone: 2,
      detections: [
        { id: 'd1', textKey: 'f_d1', state: 'ok' },
        { id: 'd3', textKey: 'f_d3', value: 'localhost:30128', state: 'ok' },
      ],
    });

    expect(screen.getByTestId('firstrun-demo-toggle')).toBeTruthy();
    expect(screen.getByTestId('sample-badge')).toBeTruthy();
    expect(screen.getByTestId('firstrun-checklist').textContent).toBe('2 / 4');
    expect(screen.queryByTestId('firstrun-detections-unavailable')).toBeNull();
    expect(document.body.textContent).toContain('localhost:30128');
    expect(document.body.textContent).toContain(t('f_d1'));
  });

  it('the checklist percent is derived from checklistDone', () => {
    renderBranch('sample', { checklistDone: 3 });
    expect(screen.getByTestId('firstrun-checklist').textContent).toBe('3 / 4');
  });
});