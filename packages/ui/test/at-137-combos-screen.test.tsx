/**
 * packages/ui/test/at-137-combos-screen.test.tsx
 *
 * Acceptance Test AT-137 (UI): CombosScreen shows the real combos of the
 * view-model (R14-2).
 *
 * The fixture is the exact payload shape of GET /api/v1/combos in the S1
 * daemon (evidence r13-smoke-combos): an array, every element carries its own
 * `meta`.
 *
 * Validates:
 * 1. The picker, the ladder and the ownership label come from the VM.
 * 2. The prototype combo names and the prototype model list are NOT rendered.
 * 3. Two different combos can be selected; an adopted combo is labelled as
 *    adopted, not managed.
 * 4. With live data the builder tab shows the "needs P3b" frame instead of
 *    the prototype builder.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CombosScreen } from '../src/screens/CombosScreen';
import type { ComboViewModel } from '../src/api/types';

const COMBOS_FIXTURE: ComboViewModel[] = [
  {
    meta: {
      source: 'live',
      generatedAt: '2026-10-19T07:14:15.885Z',
    },
    id: 'routersync-fast',
    name: 'routersync-fast',
    type: 'managed',
    badgeKey: 'badge_managed',
    targets: ['omniroute', '9router'],
    strategy: 'priority',
    steps: [
      {
        position: 1,
        modelId: 'm1',
      },
    ],
  },
];

const TWO_COMBOS_FIXTURE: ComboViewModel[] = [
  COMBOS_FIXTURE[0] as ComboViewModel,
  {
    meta: {
      source: 'live',
      generatedAt: '2026-10-19T07:14:15.885Z',
    },
    id: 'my-own-combo',
    name: 'my-own-combo',
    type: 'adopted',
    badgeKey: 'badge_adopted',
    targets: ['9router'],
    strategy: 'round-robin',
    steps: [
      {
        position: 1,
        modelId: 'm2',
      },
      {
        position: 2,
        modelId: 'm3',
      },
    ],
  },
];

describe('Acceptance Test AT-137 (UI): CombosScreen is a pure function of the VM (R14-2)', () => {
  it('renders the combo of the VM with its ownership, targets and steps', () => {
    render(<CombosScreen combos={COMBOS_FIXTURE} />);

    // the real combo of the daemon is on screen
    expect(screen.getByText('routersync-fast')).toBeDefined();

    // its step comes from the VM
    expect(screen.getByText('m1')).toBeDefined();

    // the ownership label comes from the VM (managed)
    const ownership = screen.getAllByTestId('combo-ownership');
    expect(ownership).toHaveLength(1);
    // R18-5.3: the chip prints the translated label; the machine token is kept
    // in `data-ownership` so "managed, not adopted" is still pinned.
    expect(ownership[0]?.getAttribute('data-ownership')).toBe('managed');
    expect(ownership[0]?.textContent).not.toContain('managed');

    // the targets come from the VM
    expect(screen.getByText(/omniroute, 9router/)).toBeDefined();

    // the prototype combo names and prototype models are gone
    expect(screen.queryByText('coding-fast')).toBeNull();
    expect(screen.queryByText('free-all')).toBeNull();
    expect(screen.queryByText('smart-cascade')).toBeNull();
    expect(screen.queryByText('my-old-combo')).toBeNull();
    expect(screen.queryByText('nova-vision-1')).toBeNull();
  });

  it('lists and switches between two different combos, and labels an adopted combo as adopted', () => {
    render(<CombosScreen combos={TWO_COMBOS_FIXTURE} />);

    expect(screen.getByTestId('combo-picker-routersync-fast')).toBeDefined();
    expect(screen.getByTestId('combo-picker-my-own-combo')).toBeDefined();

    // the first combo is selected by default -> its steps are in the ladder
    expect(screen.getByText('m1')).toBeDefined();
    expect(screen.queryByText('m2')).toBeNull();

    // switch to the second combo -> the ladder follows the VM
    fireEvent.click(screen.getByTestId('combo-picker-my-own-combo'));
    expect(screen.getByText('m2')).toBeDefined();
    expect(screen.getByText('m3')).toBeDefined();
    expect(screen.queryByText('m1')).toBeNull();

    // ownership labels: one managed, one adopted
    const ownership = screen.getAllByTestId('combo-ownership');
    expect(ownership).toHaveLength(2);
    expect(ownership.some((el) => el.getAttribute('data-ownership') === 'managed')).toBe(true);
    // R18-5.3: one chip. The translated label is what the owner reads; the
    // machine token lives in `data-ownership` so the meaning is still pinned.
    expect(ownership.some((el) => el.getAttribute('data-ownership') === 'adopted')).toBe(true);
    expect(ownership.every((el) => !/managed|adopted/.test(el.textContent ?? ''))).toBe(true);
  });

  it('shows the "needs P3b" frame in the builder tab when the data is live', () => {
    render(<CombosScreen combos={COMBOS_FIXTURE} />);

    fireEvent.click(screen.getByRole('tab', { name: /Tạo hoặc sửa|Create or edit/ }));

    expect(screen.getByTestId('combos-builder-locked')).toBeDefined();
    // the prototype builder content must not be rendered with live data
    expect(screen.queryByTestId('builder-role-hint')).toBeNull();
    expect(screen.queryByText('nova-vision-1')).toBeNull();
    expect(screen.queryByText('acme-coder-2')).toBeNull();
  });
});
