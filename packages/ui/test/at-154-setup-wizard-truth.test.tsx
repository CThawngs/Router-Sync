import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SetupWizardScreen } from '../src/screens/SetupWizardScreen';
import { setLanguage, t, type Language } from '../src/i18n';
import type { SetupPreviewViewModel } from '../src/api/types';

/**
 * AT-154 (R18-4.1): the setup wizard tells the truth at every step.
 *
 * On the owner's real screenshot step 2 announced "RouterSync found 3 places on
 * your machine" and printed a tick next to OmniRoute, 9Router and OpenCode,
 * directly above the dashed "Needs P3a: nothing was detected" frame. Step 1
 * showed "Key is valid. Found 86 models." while nothing had been checked, and
 * step 4 announced "First scan done" before any scan existed.
 *
 * The illustrated walkthrough is SAMPLE content. With a live or unavailable
 * preview the wizard may not say any of it. This test walks all four steps and
 * asserts both directions: nothing is claimed without a measurement, and the
 * illustration still works when the payload really is sample content.
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

const UNAVAILABLE: SetupPreviewViewModel = {
  meta: {
    source: 'unavailable',
    reason: 'needs_p3a',
    generatedAt: '2026-10-21T12:08:51.300Z',
  },
};

const SAMPLE: SetupPreviewViewModel = {
  meta: { source: 'sample', generatedAt: '2026-10-21T12:08:51.300Z' },
  modelsFound: 86,
  combosSuggested: 2,
  billableRequests: 0,
  writtenToConfig: 0,
  detections: [
    { id: 'omniroute', textKey: 'f_d3', value: 'localhost:30128', state: 'ok' },
    { id: '9router', textKey: 'f_d4', value: 'localhost:20128', state: 'ok' },
    {
      id: 'opencode',
      textKey: 'f_d5',
      value: '~/.config/opencode/opencode.json',
      state: 'ok',
    },
  ],
};

/** Strings that only make sense when something was really measured. */
const CLAIM_KEYS = ['w_1ok', 'w_2d', 'w_4a', 'w_4b'] as const;

function claimStrings(lang: Language): string[] {
  const before = lang;
  setLanguage(lang);
  const values = CLAIM_KEYS.map((key) => t(key));
  setLanguage(before);
  return values;
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

describe('AT-154: the setup wizard claims nothing it did not measure', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    describe(`language: ${lang}`, () => {
      it('walks step 1 -> 4 with an unavailable preview and never claims a result', async () => {
        setLanguage(lang);
        const claims = claimStrings(lang);

        render(<SetupWizardScreen preview={UNAVAILABLE} />);

        // Step 1: pressing "check the key" must not produce a measured result.
        expect(screen.getByTestId('wizard-step-1')).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: t('p_ad3') }));
        await waitFor(() => {
          for (const claim of claims) {
            expect(bodyText(), `step 1 printed a claim: "${claim}"`).not.toContain(claim);
          }
        });

        // Step 2: the detection frame is there, and no illustrated sentence.
        fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
        expect(screen.getByTestId('wizard-step-2')).toBeDefined();
        expect(screen.getByTestId('wizard-detections-unavailable')).toBeDefined();
        expect(bodyText()).not.toContain(t('w_2d'));
        expect(bodyText()).not.toContain('✓');
        // The selection boxes are boxes, not claims.
        expect(bodyText()).toContain('◻');

        // Step 3 is a setting, not a measurement.
        fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
        expect(screen.getByTestId('wizard-step-3')).toBeDefined();

        // Step 4: no "first scan done", and the preview is the dashed frame.
        fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
        expect(screen.getByTestId('wizard-step-4')).toBeDefined();
        expect(bodyText()).not.toContain(t('w_4a'));
        expect(bodyText()).not.toContain(t('w_4b'));
        expect(screen.getByTestId('wizard-preview-unavailable')).toBeDefined();
        // The four preview numbers stay "—".
        for (const id of ['models', 'combos', 'billable', 'written']) {
          expect(screen.getByTestId(`wizard-preview-${id}`).textContent).toBe('—');
        }
      });
    });
  }

  it('still paints the illustration for sample content (the rule is not a blank screen)', async () => {
    setLanguage('vi');
    render(<SetupWizardScreen preview={SAMPLE} />);

    // The preview arrives synchronously here, so the sample branch is live.
    fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
    await waitFor(() => {
      expect(bodyText()).toContain(t('w_2d'));
    });
    // Sample content selects the three demo targets, which paints filled boxes.
    expect(bodyText()).toContain('◼');
  });

  describe('R20-3: negative machine claims are forbidden without live measurements', () => {
    const FORBIDDEN_NEGATIVE_CLAIMS = [
      'No target was detected on this machine',
      'Chưa dò được nơi áp dụng nào trên máy này',
      'không có nơi áp dụng nào trên máy này',
      'no router found on this machine',
    ];

    for (const lang of ['vi', 'en'] as const) {
      it(`never prints a negative machine claim in step 2 (language: ${lang})`, async () => {
        setLanguage(lang);
        const LIVE_PREVIEW: SetupPreviewViewModel = {
          meta: { source: 'live', generatedAt: '2026-10-22T12:00:00.000Z' },
          detections: [],
        };
        render(<SetupWizardScreen preview={LIVE_PREVIEW} />);
        fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
        expect(screen.getByTestId('wizard-step-2')).toBeDefined();
        for (const phrase of FORBIDDEN_NEGATIVE_CLAIMS) {
          expect(bodyText().toLowerCase()).not.toContain(phrase.toLowerCase());
        }
      });
    }
  });
});
