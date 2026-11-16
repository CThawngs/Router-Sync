import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { CombosScreen } from '../src/screens/CombosScreen';
import { OverviewScreen } from '../src/screens/OverviewScreen';
import type { ApiClient } from '../src/api/client';
import type {
  ComboViewModel,
  ModelViewModel,
  ResponseMeta,
  SystemOverview,
} from '../src/api/types';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-152 (R17-0.2 / R17-0.3): a missing value is not replaced by a guess.
 *
 * Two claims about the R16 screens:
 *  1. `/models` answers `unavailable` in the S1 slice, yet the Models screen
 *     painted a hard "0" in every state — including the state where the
 *     Overview reported 61 tracked models. "Not measured" must render "—"
 *     plus a dashed "needs P3a" frame, never a number.
 *  2. `/api/v1/combos` no longer ships a `strategy` the router never stored
 *     (R17-0.2), so the Combos screen must render "—" instead of printing a
 *     default it made up.
 */

/** Minimal client: only `isMock` matters for the "not measured" branch. */
function liveClient(): ApiClient {
  return {
    isMock: () => false,
    getModels: async () => [],
    getUnmatchedNames: async () => [],
    getUnknownTraits: async () => [],
    getCombos: async () => [],
  } as unknown as ApiClient;
}

function sampleClient(): ApiClient {
  return { ...liveClient(), isMock: () => true } as unknown as ApiClient;
}

const NOW = '2026-10-21T00:00:00.000Z';

/** An empty collection that says WHY it is empty. */
function collection<T>(items: T[], source: ResponseMeta['source']): T[] {
  (items as unknown as { meta: ResponseMeta }).meta = { source, generatedAt: NOW };
  return items;
}

const COMBO_WITHOUT_STRATEGY: ComboViewModel = {
  meta: { source: 'live', generatedAt: NOW },
  id: 'routersync-plain',
  name: 'routersync-plain',
  type: 'managed',
  badgeKey: 'badge_managed',
  targets: ['9router'],
  steps: [{ position: 1, modelId: 'm1' }],
};

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

describe('AT-152: an unmeasured value renders as "—", never as 0 or as a guess', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`models "unavailable" -> dash + dashed frame, no 0 (${lang})`, () => {
      setLanguage(lang);
      render(
        <ModelsScreen
          api={liveClient()}
          models={collection<ModelViewModel>([], 'unavailable')}
          unmatchedNames={collection([], 'unavailable')}
          unknownTraits={collection([], 'unavailable')}
        />
      );

      expect(screen.getByTestId('models-unavailable')).toBeTruthy();
      expect(screen.getByTestId('models-unavailable').textContent).toContain(t('s1_needs_p3a'));
      // The review badge is the only counter of the screen: it must not say 0.
      expect(screen.getByTestId('models-review-badge').textContent).toBe('—');
      expect(screen.queryByText('0')).toBeNull();
    });

    it(`models measured-but-empty -> dash + dashed frame, no 0 (${lang})`, () => {
      setLanguage(lang);
      render(
        <ModelsScreen
          api={liveClient()}
          models={collection<ModelViewModel>([], 'live')}
          unmatchedNames={[]}
          unknownTraits={[]}
        />
      );

      expect(screen.getByTestId('models-unavailable')).toBeTruthy();
      expect(screen.getByTestId('models-review-badge').textContent).toBe('—');
    });
  }

  it('models sample data keeps its own badge and shows no "needs P3a" frame', () => {
    render(
      <ModelsScreen
        api={sampleClient()}
        models={collection<ModelViewModel>([], 'sample')}
        unmatchedNames={[]}
        unknownTraits={[]}
      />
    );

    expect(screen.queryByTestId('models-unavailable')).toBeNull();
    expect(screen.getByTestId('models-review-badge').textContent).toBe('0');
  });

  it('a combo without a measured strategy renders "—", not a guessed default', () => {
    render(<CombosScreen combos={[COMBO_WITHOUT_STRATEGY]} />);

    expect(screen.getByTestId('combo-strategy').textContent).toBe('—');
    expect(screen.getByTestId('combo-strategy').textContent).not.toBe('round-robin');
  });

  it('the picker and the ladder state the measured step count (R17-0.4)', () => {
    const combo: ComboViewModel = {
      ...COMBO_WITHOUT_STRATEGY,
      id: 'routersync-three',
      name: 'routersync-three',
      steps: [
        { position: 1, modelId: 'm1' },
        { position: 2, modelId: 'm2' },
        { position: 3, modelId: 'm3' },
      ],
    };
    render(<CombosScreen combos={[combo]} />);

    expect(screen.getByTestId('combo-picker-steps-routersync-three').textContent).toBe(
      t('r14_combo_steps_count', { count: 3 })
    );
    expect(screen.getByTestId('combo-ladder-count').textContent).toBe(
      t('b_lad_showing', { shown: 3, total: 3 })
    );
  });

  it('the ladder count reports the collapsed view, not the full list (R17-0.4)', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      position: i + 1,
      modelId: `m${i + 1}`,
    }));
    const combo: ComboViewModel = {
      ...COMBO_WITHOUT_STRATEGY,
      id: 'routersync-long',
      name: 'routersync-long',
      steps: many,
    };
    render(<CombosScreen combos={[combo]} />);

    expect(screen.getByTestId('combo-picker-steps-routersync-long').textContent).toBe(
      t('r14_combo_steps_count', { count: 14 })
    );
    // Collapsed: 10 of 14 drawn, and the label says exactly that.
    expect(screen.getByTestId('combo-ladder-count').textContent).toBe(
      t('b_lad_showing', { shown: 10, total: 14 })
    );
  });
});

/**
 * AT-152 (R19-3.2): the "billable requests" line is a SENTENCE, not a number.
 *
 * The Overview tile used to read "0 billable requests (by-design zero
 * inference)" / "0 yêu cầu tính phí (thiết kế zero-inference)": a hard "0"
 * that looked like a measurement the daemon never made. The payload now
 * carries only a `code` — `count` is deliberately absent — and the line
 * states the design instead: no billable endpoint is called. A number must
 * not come back, in any language, and the line may never be a bare digit.
 */
describe('AT-152 (R19-3.2): the billable-requests line states the design and prints no number', () => {
  /** The exact sentence the product must show, per language. */
  const EXPECTED_SENTENCE: Record<Language, string> = {
    vi: 'Không gọi endpoint tính phí (thiết kế zero-inference)',
    en: 'No billable endpoint is called (by-design zero inference)',
  };

  /** The payload as the daemon sends it: a code, and no count at all. */
  const OVERVIEW_FIXTURE: SystemOverview = {
    meta: { source: 'live', generatedAt: NOW },
    isFirstRun: false,
    isPaused: false,
    routers: { upCount: 2, probedCount: 2 },
    trackedModels: { count: 61 },
    billableRequestsToday: { code: 'by_design_zero_inference' },
    lastCheck: { code: 'daemon_running' },
    todoItems: [],
  };

  const renderOverview = () =>
    render(
      <OverviewScreen
        overview={OVERVIEW_FIXTURE}
        pipelineModules={[]}
        onNavigate={() => {}}
        onToggleFirstRun={() => {}}
        onOpenAgentDrawer={() => {}}
      />
    );

  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`the line is the number-free sentence (${lang})`, () => {
      setLanguage(lang);
      renderOverview();

      const line = screen.getByTestId('metric-requests-value').textContent ?? '';
      expect(line).toBe(t('by_design_zero_inference'));
      expect(line).toBe(EXPECTED_SENTENCE[lang]);
    });

    it(`the line is not a number and carries no digit (${lang})`, () => {
      setLanguage(lang);
      renderOverview();

      const line = screen.getByTestId('metric-requests-value').textContent ?? '';
      // A bare number is never the line — that is what a printed "0" is.
      expect(line).not.toBe('0');
      expect(line).not.toMatch(/^\s*\d+\s*$/);
      // No digit at all: the count is not printed next to the sentence either.
      expect(line).not.toMatch(/\d/);
      // No standalone digit number for the count.
      expect(line).not.toMatch(/(^|\s)\d+(\s|$)/);
      // The sentence still explains the design it reports.
      expect(line.toLowerCase()).toContain('zero');
    });
  }
});