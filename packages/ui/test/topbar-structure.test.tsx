import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { TopBar } from '../src/components/TopBar';

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

describe('UI-OBS-6: TopBar Structure & Controls Layout', () => {
  const defaultProps = {
    isMock: false,
    isFirstRun: false,
    isPaused: false,
    targetCount: 3,
    onTogglePause: vi.fn(),
    onOpenAgentDrawer: vi.fn(),
    isAgentDrawerOpen: false,
    onToggleFirstRun: vi.fn(),
    onToggleMobileNav: vi.fn(),
    isMobileNavOpen: false,
  };

  it('renders all essential topbar controls in rs-topbar-controls container', () => {
    const { container } = render(<TopBar {...defaultProps} />);

    const controlsContainer = container.querySelector('.rs-topbar-controls');
    expect(controlsContainer).not.toBeNull();

    // ViewMode toggle radiogroup
    const viewModeGroup = controlsContainer!.querySelector('[role="radiogroup"]');
    expect(viewModeGroup).not.toBeNull();

    // Language buttons VI / EN
    const langViBtn = Array.from(controlsContainer!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'VI'
    );
    const langEnBtn = Array.from(controlsContainer!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'EN'
    );
    expect(langViBtn).toBeDefined();
    expect(langEnBtn).toBeDefined();

    // Theme toggle button
    const themeBtn = controlsContainer!.querySelector('button.btn');
    expect(themeBtn).not.toBeNull();

    // Agent drawer button
    const agentBtn = controlsContainer!.querySelector('button[aria-expanded="false"]');
    expect(agentBtn).not.toBeNull();
  });

  it('renders emergency button specifically inside rs-topbar-emergency container and isolates it', () => {
    const { container } = render(<TopBar {...defaultProps} />);

    const emergencyContainer = container.querySelector('.rs-topbar-emergency');
    expect(emergencyContainer).not.toBeNull();

    // Emergency button must be inside emergencyContainer, and isolated from controlsContainer
    const emergencyBtn = emergencyContainer!.querySelector('button');
    expect(emergencyBtn).not.toBeNull();
    expect(emergencyBtn!.textContent).toMatch(/Dừng khẩn|Emergency pause/i);

    const controlsContainer = container.querySelector('.rs-topbar-controls');
    expect(controlsContainer!.contains(emergencyBtn)).toBe(false);
  });
});
