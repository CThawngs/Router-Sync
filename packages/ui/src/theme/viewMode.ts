import { useState, useEffect } from 'react';

export type ViewMode = 'simple' | 'detail';

const VIEW_MODE_STORAGE_KEY = 'routersync_ui_view_mode';

function getInitialViewMode(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (saved === 'simple' || saved === 'detail') {
      return saved;
    }
  } catch {}
  return 'simple';
}

let currentViewMode: ViewMode = getInitialViewMode();
const listeners = new Set<(mode: ViewMode) => void>();

export function getViewMode(): ViewMode {
  return currentViewMode;
}

export function setViewMode(mode: ViewMode): void {
  currentViewMode = mode;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {}
  listeners.forEach((listener) => listener(mode));
}

export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setLocalMode] = useState<ViewMode>(currentViewMode);

  useEffect(() => {
    const handler = (newMode: ViewMode) => setLocalMode(newMode);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return [mode, setViewMode];
}
