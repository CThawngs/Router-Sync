import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TourModal, TOUR_STEPS } from '../src/components/TourModal';
import { App } from '../src/App';
import { ApiProvider, MockApi } from '../src/api';
import { setLanguage, t } from '../src/i18n';
import translationsData from '../src/i18n/translations.json';

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

describe('UI-NIT-3: Onboarding Tour v2 (Spotlight Overlay) Accessibility & Navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    setLanguage('vi');
  });

  it('renders with accessibility dialog role, modal attributes, and labelledby/describedby', () => {
    const handleClose = vi.fn();
    render(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('tour-modal-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('tour-modal-desc');

    const title = screen.getByText(t('tour_s1_title'));
    expect(title.id).toBe('tour-modal-title');
    const desc = screen.getByText(t('tour_s1_desc'));
    expect(desc.id).toBe('tour-modal-desc');

    // aria-live announcement
    const liveRegion = screen.getByTestId('tour-aria-live');
    expect(liveRegion).toBeTruthy();
    expect(liveRegion.textContent).toContain(t('tour_s1_title'));
  });

  it('navigates through all 9 steps using Next and Prev buttons', () => {
    const handleClose = vi.fn();
    render(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);

    // Step 1: Prev disabled, Next enabled, counter 1 / 9
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('1 / 9');
    const prevBtn = screen.getByTestId('tour-prev-btn');
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true);
    const nextBtn = screen.getByTestId('tour-next-btn');
    expect(nextBtn).toBeTruthy();

    // Steps 2 to 8
    for (let i = 2; i <= 8; i++) {
      fireEvent.click(screen.getByTestId('tour-next-btn'));
      expect(screen.getByTestId('tour-step-counter').textContent).toBe(`${i} / 9`);
      expect((screen.getByTestId('tour-prev-btn') as HTMLButtonElement).disabled).toBe(false);
    }

    // Step 9: Finish button replaces Next, Guide button is visible if onNavigate provided
    fireEvent.click(screen.getByTestId('tour-next-btn'));
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('9 / 9');
    expect(screen.getByText(t('tour_s9_title'))).toBeTruthy();
    expect(screen.queryByTestId('tour-next-btn')).toBeNull();

    const finishBtn = screen.getByTestId('tour-finish-btn');
    expect(finishBtn).toBeTruthy();

    // Clicking Finish triggers onClose
    fireEvent.click(finishBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('navigates backwards using Prev button', () => {
    render(<TourModal isOpen={true} isMock={true} onClose={vi.fn()} />);

    const nextBtn = screen.getByTestId('tour-next-btn');
    const prevBtn = screen.getByTestId('tour-prev-btn');

    fireEvent.click(nextBtn); // Step 2
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('2 / 9');

    fireEvent.click(prevBtn); // Back to Step 1
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('1 / 9');
    expect(screen.getByText(t('tour_s1_title'))).toBeTruthy();
    expect((prevBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on Skip button click, Close button click, or Backdrop click', () => {
    const handleClose = vi.fn();
    const { rerender } = render(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);

    // Skip button
    fireEvent.click(screen.getByTestId('tour-skip-btn'));
    expect(handleClose).toHaveBeenCalledTimes(1);

    // Close button
    handleClose.mockClear();
    rerender(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);
    fireEvent.click(screen.getByTestId('tour-close-btn'));
    expect(handleClose).toHaveBeenCalledTimes(1);

    // Backdrop click
    handleClose.mockClear();
    rerender(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);
    fireEvent.click(screen.getByTestId('tour-modal-backdrop'));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('handles keyboard navigation with Escape, ArrowRight, and ArrowLeft', () => {
    const handleClose = vi.fn();
    render(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);

    // ArrowRight advances step
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('2 / 9');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('3 / 9');

    // ArrowLeft goes back
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('2 / 9');

    // Escape closes modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus inside the modal with Tab and Shift+Tab', () => {
    render(<TourModal isOpen={true} isMock={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Focus last element and press Tab -> wraps to first
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(first);

    // Focus first element and press Shift+Tab -> wraps to last
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('honestly distinguishes Mock mode vs Live S1 mode in step 4 and step 5 descriptions', () => {
    // 1. Mock mode
    const { unmount } = render(<TourModal isOpen={true} isMock={true} onClose={vi.fn()} />);
    // Step 1 -> Step 4
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 2
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 3
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 4 (Tiles)
    expect(screen.getByText(t('tour_s4_title'))).toBeTruthy();
    const mockDesc = screen.getByText(t('tour_s4_desc_mock'));
    expect(mockDesc).toBeTruthy();
    expect(mockDesc.textContent).toMatch(/zero-inference/i);

    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 5 (Changes)
    expect(screen.getByText(t('tour_s5_title'))).toBeTruthy();
    expect(screen.getByText(t('tour_s5_desc_mock'))).toBeTruthy();
    unmount();

    // 2. Live S1 mode
    render(<TourModal isOpen={true} isMock={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 2
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 3
    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 4 (Tiles)
    expect(screen.getByText(t('tour_s4_title'))).toBeTruthy();
    const liveDesc = screen.getByText(t('tour_s4_desc_live'));
    expect(liveDesc).toBeTruthy();
    expect(liveDesc.textContent).toMatch(/zero-inference/i);

    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 5 (Changes)
    expect(screen.getByText(t('tour_s5_title'))).toBeTruthy();
    expect(screen.getByText(t('tour_s5_desc_live'))).toBeTruthy();
  });

  it('renders spotlight ring when target element exists with non-zero dimensions', () => {
    // Render target element in document
    const target = document.createElement('nav');
    target.setAttribute('data-tour', 'nav');
    target.getBoundingClientRect = () => ({
      top: 100,
      left: 20,
      bottom: 400,
      right: 220,
      width: 200,
      height: 300,
      x: 20,
      y: 100,
      toJSON: () => {},
    });
    document.body.appendChild(target);

    try {
      render(<TourModal isOpen={true} isMock={true} onClose={vi.fn()} />);

      // Step 1: intro (no target) -> centered fallback
      expect(screen.queryByTestId('tour-spotlight-ring')).toBeNull();

      // Step 2: nav -> has target
      fireEvent.click(screen.getByTestId('tour-next-btn'));
      const ring = screen.getByTestId('tour-spotlight-ring');
      expect(ring).toBeTruthy();
      expect(ring.classList.contains('rs-tour-spotlight')).toBe(true);
    } finally {
      document.body.removeChild(target);
    }
  });

  it('falls back gracefully to centered modal without crashing when target is missing or 0x0', () => {
    // In this test, no target element exists for step 2
    render(<TourModal isOpen={true} isMock={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('tour-next-btn')); // Step 2
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('2 / 9');
    // Spotlight ring is NOT rendered when target is missing
    expect(screen.queryByTestId('tour-spotlight-ring')).toBeNull();
    // Modal dialog is still safely rendered
    expect(screen.getByTestId('tour-modal')).toBeTruthy();
  });

  it('Step 9: clicking Go to Guide navigates to guide and closes tour', () => {
    const handleClose = vi.fn();
    const handleNavigate = vi.fn();

    render(
      <TourModal
        isOpen={true}
        isMock={true}
        onClose={handleClose}
        onNavigate={handleNavigate}
      />,
    );

    // Jump to Step 9
    for (let i = 1; i <= 8; i++) {
      fireEvent.click(screen.getByTestId('tour-next-btn'));
    }
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('9 / 9');

    const guideBtn = screen.getByTestId('tour-guide-btn');
    expect(guideBtn).toBeTruthy();
    expect(guideBtn.textContent).toBe(t('tour_open_guide'));

    fireEvent.click(guideBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(handleNavigate).toHaveBeenCalledWith('guide');
  });

  it('makes zero network calls (fetch / XMLHttpRequest = 0) during full tour navigation', () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    const xhrSpy = vi.spyOn(window, 'XMLHttpRequest');

    const handleClose = vi.fn();
    render(<TourModal isOpen={true} isMock={true} onClose={handleClose} />);

    // Advance through all 9 steps
    for (let i = 1; i <= 8; i++) {
      fireEvent.click(screen.getByTestId('tour-next-btn'));
    }
    expect(screen.getByTestId('tour-step-counter').textContent).toBe('9 / 9');

    // Finish step 9
    fireEvent.click(screen.getByTestId('tour-finish-btn'));
    expect(handleClose).toHaveBeenCalledTimes(1);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(xhrSpy).toHaveBeenCalledTimes(0);

    fetchSpy.mockRestore();
    xhrSpy.mockRestore();
  });

  it('has i18n key parity for all tour_* keys between vi and en translations', () => {
    const viKeys = Object.keys(translationsData.vi).filter((k) => k.startsWith('tour_'));
    const enKeys = Object.keys(translationsData.en).filter((k) => k.startsWith('tour_'));

    expect(viKeys.length).toBeGreaterThan(0);
    expect(enKeys.length).toBeGreaterThan(0);
    expect(viKeys.sort()).toEqual(enKeys.sort());

    for (const key of viKeys) {
      const viVal = (translationsData.vi as Record<string, string>)[key];
      const enVal = (translationsData.en as Record<string, string>)[key];
      expect(typeof viVal).toBe('string');
      expect(viVal?.trim().length).toBeGreaterThan(0);
      expect(typeof enVal).toBe('string');
      expect(enVal?.trim().length).toBeGreaterThan(0);
    }

    for (const step of TOUR_STEPS) {
      expect((translationsData.vi as Record<string, string>)[step.titleKey]).toBeTruthy();
      expect((translationsData.en as Record<string, string>)[step.titleKey]).toBeTruthy();
      expect((translationsData.vi as Record<string, string>)[step.descKey]).toBeTruthy();
      expect((translationsData.en as Record<string, string>)[step.descKey]).toBeTruthy();
      if (step.descKeyMock) {
        expect((translationsData.vi as Record<string, string>)[step.descKeyMock]).toBeTruthy();
        expect((translationsData.en as Record<string, string>)[step.descKeyMock]).toBeTruthy();
      }
      if (step.descKeyLive) {
        expect((translationsData.vi as Record<string, string>)[step.descKeyLive]).toBeTruthy();
        expect((translationsData.en as Record<string, string>)[step.descKeyLive]).toBeTruthy();
      }
    }
  });

  it('restores focus to previously active element when tour modal closes on Escape', async () => {
    const FocusHarness = () => {
      const [isOpen, setIsOpen] = React.useState(false);
      return (
        <div>
          <button data-testid="trigger-btn" onClick={() => setIsOpen(true)}>
            Open Tour
          </button>
          <TourModal isOpen={isOpen} isMock={true} onClose={() => setIsOpen(false)} />
        </div>
      );
    };

    render(<FocusHarness />);

    const triggerBtn = screen.getByTestId('trigger-btn');
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    fireEvent.click(triggerBtn);
    expect(screen.getByTestId('tour-modal')).toBeTruthy();

    await waitFor(() => {
      expect(document.activeElement).not.toBe(triggerBtn);
    });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('tour-modal')).toBeNull();
      expect(document.activeElement).toBe(triggerBtn);
    });
  });
});

describe('UI-NIT-3: Tour Integration in App Shell & Persistence', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    localStorage.clear();
    setLanguage('vi');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
  });

  it('opens on first visit, and persists completed state when closed', async () => {
    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    // Tour modal appears on initial first-run visit
    const tourModal = await waitFor(() => screen.getByTestId('tour-modal'));
    expect(tourModal).toBeTruthy();

    // Close the tour
    const closeBtn = screen.getByTestId('tour-close-btn');
    fireEvent.click(closeBtn);

    // Tour modal is dismissed
    await waitFor(() => {
      expect(screen.queryByTestId('tour-modal')).toBeNull();
    });

    // localStorage recorded completion
    expect(localStorage.getItem('routersync.tour.v1')).toBe('completed');
  });

  it('respects query parameter ?tour=0 to suppress tour even on fresh visit', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, search: '?tour=0' },
      writable: true,
    });

    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeTruthy();
    });

    expect(screen.queryByTestId('tour-modal')).toBeNull();
  });

  it('respects query parameter ?tour=1 to force tour even if already completed', async () => {
    localStorage.setItem('routersync.tour.v1', 'completed');
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, search: '?tour=1' },
      writable: true,
    });

    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    const tourModal = await waitFor(() => screen.getByTestId('tour-modal'));
    expect(tourModal).toBeTruthy();
  });

  it('re-opens tour from Guide screen replay button', async () => {
    localStorage.setItem('routersync.tour.v1', 'completed');
    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    await waitFor(() => screen.getByRole('navigation'));
    expect(screen.queryByTestId('tour-modal')).toBeNull();

    // Navigate to Guide screen
    const guideNavBtn = screen.getByRole('button', { name: new RegExp(t('nav_guide'), 'i') });
    fireEvent.click(guideNavBtn);

    // Find and click Replay Tour button
    const replayBtn = await waitFor(() => screen.getByTestId('guide-replay-tour'));
    fireEvent.click(replayBtn);

    // Tour reopens
    expect(screen.getByTestId('tour-modal')).toBeTruthy();
  });

  it('re-opens tour from Settings screen replay button', async () => {
    localStorage.setItem('routersync.tour.v1', 'completed');
    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    await waitFor(() => screen.getByRole('navigation'));
    expect(screen.queryByTestId('tour-modal')).toBeNull();

    // Navigate to Settings screen
    const settingsNavBtn = screen.getByRole('button', { name: new RegExp(t('nav_settings'), 'i') });
    fireEvent.click(settingsNavBtn);

    // Find and click Replay Tour button in General tab
    const replayBtn = await waitFor(() => screen.getByTestId('settings-replay-tour'));
    fireEvent.click(replayBtn);

    // Tour reopens
    expect(screen.getByTestId('tour-modal')).toBeTruthy();
  });

  it('closes tour immediately when Emergency Stop button is clicked', async () => {
    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    await waitFor(() => screen.getByTestId('tour-modal'));

    // Emergency pause button is in DOM
    const pauseBtn = screen.getByRole('button', { name: new RegExp(t('pause'), 'i') });
    expect(pauseBtn).toBeTruthy();

    // Click emergency pause
    fireEvent.click(pauseBtn);

    // Tour must be closed immediately
    await waitFor(() => {
      expect(screen.queryByTestId('tour-modal')).toBeNull();
    });
  });

  it('suppresses tour when Setup Wizard is active', async () => {
    const api = new MockApi();
    await api.setFirstRun(true);
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    await waitFor(() => screen.getByTestId('tour-modal'));

    // Open setup wizard
    const setupStartBtn = screen.getByRole('button', { name: new RegExp(`^${t('fb_b')}$`, 'i') });
    fireEvent.click(setupStartBtn);
    // Tour must not overlay wizard
    expect(screen.queryByTestId('tour-modal')).toBeNull();
  });

  it('handles localStorage.setItem throw gracefully without crashing UI', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError: localStorage full');
    });

    const api = new MockApi();
    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>,
    );

    const tourModal = await waitFor(() => screen.getByTestId('tour-modal'));
    expect(tourModal).toBeTruthy();

    const closeBtn = screen.getByTestId('tour-close-btn');
    expect(() => fireEvent.click(closeBtn)).not.toThrow();

    await waitFor(() => {
      expect(screen.queryByTestId('tour-modal')).toBeNull();
    });

    setItemSpy.mockRestore();
  });
});
