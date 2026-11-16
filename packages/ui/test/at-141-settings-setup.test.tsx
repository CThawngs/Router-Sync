import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { SetupWizardScreen } from '../src/screens/SetupWizardScreen';
import { MockApi } from '../src/api/mock';
import type { ApiClient } from '../src/api/client';
import type { SettingsViewModel, SetupPreviewViewModel } from '../src/api/types';
import { setLanguage, t, type Language } from '../src/i18n';

/**
 * AT-141 (R17-2): Settings and SetupWizard show only measured values.
 *
 * The R16 screens printed prototype settings as facts: a "3 / 7" shadow week,
 * a "50%" impact cap, "2" and "30" limits, `http://127.0.0.1:4173`, and a
 * wizard that claimed four numbers, two router addresses and one config path.
 * The S1 daemon measures `policyMode` (plus its source) and nothing else.
 */

/** S1-shaped settings: policyMode only, and the daemon had no YAML. */
const S1_SETTINGS: SettingsViewModel = {
  meta: { source: 'live', generatedAt: '2026-10-21T00:00:00.000Z' },
  policyMode: 'manual',
  policyModeSource: 'default',
};

/** No settings at all: the endpoint answered "not measured". */
const NO_SETTINGS: SettingsViewModel = {
  meta: { source: 'unavailable', reason: 'needs_p3a', generatedAt: '2026-10-21T00:00:00.000Z' },
};

const NO_PREVIEW: SetupPreviewViewModel = {
  meta: { source: 'unavailable', reason: 'needs_p3a', generatedAt: '2026-10-21T00:00:00.000Z' },
};

/** Hard-coded prototype values that must NOT survive a live screen. */
const PROTOTYPE_STRINGS = ['3 / 7', '50%', 'http://127.0.0.1:4173', 'localhost:30128', 'localhost:20128', 'opencode.json'];

function liveClient(): ApiClient {
  return { isMock: () => false, getSetupPreview: async () => NO_PREVIEW } as unknown as ApiClient;
}

afterEach(() => {
  cleanup();
  setLanguage('vi');
});

describe('AT-141: Settings shows the measured policy mode and dashes elsewhere', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`S1 settings -> policyMode + default source, everything else a dash (${lang})`, () => {
      setLanguage(lang);
      render(<SettingsScreen settings={S1_SETTINGS} />);

      // General tab: the address and the scan schedule.
      expect(screen.getByTestId('settings-local-url').textContent).toBe('—');
      expect(screen.getByTestId('settings-scan-schedule').textContent).toBe('—');

      // Safety tab: the policy mode, the shadow week and the limits.
      fireEvent.click(screen.getByRole('tab', { name: t('s_tab2') }));
      expect(screen.getByTestId('settings-policy-mode').textContent).toBe('manual');
      expect(screen.getByTestId('settings-policy-source').textContent).toBe(
        t('s_policy_default_source')
      );

      // Unmeasured fields render the dash, not a prototype number.
      expect(screen.getByTestId('settings-shadow-week').textContent).toBe('—');
      expect(screen.getByTestId('settings-limit-impact').textContent).toBe('—');
      expect(screen.getByTestId('settings-limit-min-models').textContent).toBe('—');
      expect(screen.getByTestId('settings-limit-min-providers').textContent).toBe('—');
      expect(screen.getByTestId('settings-limit-backups').textContent).toBe('—');

      const text = screen.getByTestId('settings-screen').textContent ?? '';
      for (const value of PROTOTYPE_STRINGS) {
        expect(text).not.toContain(value);
      }
    });

    it(`settings unavailable -> a dashed frame and no policy claim (${lang})`, () => {
      setLanguage(lang);
      render(<SettingsScreen settings={NO_SETTINGS} />);

      fireEvent.click(screen.getByRole('tab', { name: t('s_tab2') }));
      expect(screen.getByTestId('settings-policy-mode').textContent).toBe('—');
      expect(screen.getByTestId('settings-unavailable')).toBeTruthy();
      // The MCP client list lives on the "AI" tab and is not measured either.
      fireEvent.click(screen.getByRole('tab', { name: t('s_tab3') }));
      expect(screen.getByTestId('settings-mcp-unavailable')).toBeTruthy();
    });
  }

  it('sample settings -> the prototype values are shown (and only then)', () => {
    render(<SettingsScreen isMock={true} />);
    return waitFor(() => {
      expect(screen.getByTestId('settings-local-url').textContent).toBe(
        'http://127.0.0.1:4173'
      );
      fireEvent.click(screen.getByRole('tab', { name: t('s_tab2') }));
      expect(screen.getByTestId('settings-shadow-week').textContent).toBe('3 / 7');
      expect(screen.getByTestId('settings-limit-impact').textContent).toBe('50%');
      expect(screen.getByTestId('settings-limit-backups').textContent).toBe('30');
    });
  });
});

describe('AT-141: the setup wizard claims nothing it did not detect', () => {
  for (const lang of ['vi', 'en'] as readonly Language[]) {
    it(`no preview -> dashed frames, no address and no number (${lang})`, async () => {
      setLanguage(lang);
      render(<SetupWizardScreen api={liveClient()} preview={NO_PREVIEW} />);

      // Step 2: the detection cards are replaced by a dashed frame.
      fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-detections-unavailable')).toBeTruthy();
      });
      const step2Text = screen.getByTestId('wizard-step-2').textContent ?? '';
      expect(step2Text).not.toContain('localhost:30128');
      expect(step2Text).not.toContain('localhost:20128');
      expect(step2Text).not.toContain('opencode.json');

      // Step 4: the four numbers are dashes.
      fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
      fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-preview-unavailable')).toBeTruthy();
      });
      expect(screen.getByTestId('wizard-preview-models').textContent).toBe('—');
      expect(screen.getByTestId('wizard-preview-combos').textContent).toBe('—');
      expect(screen.getByTestId('wizard-preview-billable').textContent).toBe('—');
      expect(screen.getByTestId('wizard-preview-written').textContent).toBe('—');
    });
  }

  it('sample preview -> the four numbers and the detected addresses', async () => {
    const preview = await new MockApi().getSetupPreview();
    render(<SetupWizardScreen preview={preview} />);

    fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-target-omniroute').textContent).toContain(
        'localhost:30128'
      );
    });
    expect(screen.getByTestId('wizard-target-9router').textContent).toContain('localhost:20128');

    fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
    fireEvent.click(screen.getByRole('button', { name: t('w_next') }));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-preview-models').textContent).toBe('86');
    });
    expect(screen.getByTestId('wizard-preview-combos').textContent).toBe('2');
    expect(screen.getByTestId('wizard-preview-billable').textContent).toBe('0');
    expect(screen.getByTestId('wizard-preview-written').textContent).toBe('0');
  });
});