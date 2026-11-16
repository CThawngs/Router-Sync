import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../src/components/Sidebar';
import type { HeartbeatHistory } from '../src/api/types';

describe('UI-OBS-5: Sidebar Heartbeat Ticks', () => {
  it('renders exactly 24 heartbeat ticks with no block characters (U+2580..U+259F)', () => {
    render(<Sidebar currentScreen="overview" onSelectScreen={() => {}} />);

    const strip = screen.getByTestId('heartbeat-strip');
    expect(strip).toBeInTheDocument();
    expect(strip.getAttribute('role')).toBe('img');
    expect(strip.getAttribute('aria-label')).toBeTruthy();

    const ticks = screen.getAllByTestId('heartbeat-tick');
    expect(ticks).toHaveLength(24);

    // Ticks must not contain Unicode block elements (U+2580..U+259F)
    const blockCharRegex = /[\u2580-\u259F]/;
    for (const tick of ticks) {
      expect(tick.textContent).not.toMatch(blockCharRegex);
      expect(tick.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('applies proper status classes for ok, warning, and missed ticks', () => {
    const mockHistory: HeartbeatHistory = {
      source: 'measured',
      daemonReachable: true,
      uptimeSeconds: 3600,
      lastProbeAt: '2026-10-27T08:00:00Z',
      ticks: [
        { id: 't_0', status: 'ok' },
        { id: 't_1', status: 'warning' },
        { id: 't_2', status: 'missed' },
        ...Array.from({ length: 21 }, (_, i) => ({
          id: `t_${i + 3}`,
          status: 'ok' as const,
        })),
      ],
    };

    render(<Sidebar currentScreen="overview" onSelectScreen={() => {}} heartbeat={mockHistory} />);

    const ticks = screen.getAllByTestId('heartbeat-tick');
    expect(ticks).toHaveLength(24);

    expect(ticks[0]).toHaveClass('hb-tick-ok');
    expect(ticks[1]).toHaveClass('hb-tick-warning');
    expect(ticks[2]).toHaveClass('hb-tick-missed');
  });
});
