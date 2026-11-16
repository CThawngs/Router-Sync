import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTheme, setTheme, toggleTheme } from '../src/theme';

describe('Acceptance Test AT-78: Theme Management and prefers-color-scheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to auto mode and sets data-theme="auto" on documentElement', () => {
    setTheme('auto');
    expect(getTheme()).toBe('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBe('auto');
  });

  it('persists fixed light or dark selection to localStorage', () => {
    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(localStorage.getItem('routersync_ui_theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(localStorage.getItem('routersync_ui_theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggles theme based on window.matchMedia prefers-color-scheme when currently auto', () => {
    setTheme('auto');

    // Mock matchMedia returning dark preference
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    // In auto mode with dark preferred, toggling switches to light
    toggleTheme();
    expect(getTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // Toggling from light switches to dark
    toggleTheme();
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
