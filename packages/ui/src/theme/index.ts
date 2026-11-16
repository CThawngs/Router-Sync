import { useState, useEffect } from 'react';

export type Theme = 'light' | 'dark' | 'auto';

const THEME_STORAGE_KEY = 'routersync_ui_theme';

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') {
      return saved;
    }
  } catch {}
  return 'auto';
}

let currentTheme: Theme = getInitialTheme();
const listeners = new Set<(theme: Theme) => void>();

function applyThemeToDOM(theme: Theme) {
  if (theme === 'auto') {
    document.documentElement.setAttribute('data-theme', 'auto');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// Initial apply
applyThemeToDOM(currentTheme);

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
  applyThemeToDOM(theme);
  listeners.forEach((listener) => listener(theme));
}

export function toggleTheme(): void {
  // Toggle between light and dark (or auto -> light -> dark -> auto)
  if (currentTheme === 'light') {
    setTheme('dark');
  } else if (currentTheme === 'dark') {
    setTheme('light');
  } else {
    // If auto, toggle based on current preferred color scheme
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(isDark ? 'light' : 'dark');
  }
}

export function useTheme(): [Theme, (theme: Theme) => void, () => void] {
  const [theme, setLocalTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    const handler = (newTheme: Theme) => setLocalTheme(newTheme);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return [theme, setTheme, toggleTheme];
}
