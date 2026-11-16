/**
 * packages/ui/test/at-133-combos-screen.test.tsx
 *
 * Acceptance Test AT-133 (UI): CombosScreen renders unavailable state on DB failure (R13-1.3).
 *
 * Validates:
 * 1. When ApiClient returns empty array with meta.source === 'unavailable',
 *    CombosScreen renders the unavailable state (dashed border container) and NOT the empty state.
 * 2. When ApiClient returns empty array with meta.source === 'live' (or without unavailable meta),
 *    CombosScreen renders the normal empty state and NOT the unavailable container.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { CombosScreen } from '../src/screens/CombosScreen';
import { MockApi } from '../src/api/mock';
import type { ComboViewModel } from '../src/api/types';

describe('Acceptance Test AT-133 (UI): CombosScreen unavailable state handling (R13-1.3)', () => {
  it('renders unavailable container with dashed border when DB read failed', async () => {
    const mockApi = new MockApi();
    const emptyWithMeta: ComboViewModel[] = [];
    (emptyWithMeta as any).meta = {
      source: 'unavailable',
      reason: 'db_unreadable',
      generatedAt: new Date().toISOString(),
    };

    mockApi.getCombos = async () => emptyWithMeta;

    render(<CombosScreen api={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('combos-unavailable')).toBeDefined();
    });

    expect(screen.queryByTestId('combos-empty-state')).toBeNull();
  });

  it('renders normal empty-state when DB is readable but has 0 combos', async () => {
    const mockApi = new MockApi();
    const emptyLive: ComboViewModel[] = [];
    (emptyLive as any).meta = {
      source: 'live',
      generatedAt: new Date().toISOString(),
    };

    mockApi.getCombos = async () => emptyLive;

    render(<CombosScreen api={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('combos-empty-state')).toBeDefined();
    });

    expect(screen.queryByTestId('combos-unavailable')).toBeNull();
  });
});
