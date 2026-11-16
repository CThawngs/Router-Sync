/**
 * packages/ui/test/at-136-targets-screen.test.tsx
 *
 * Acceptance Test AT-136 (UI): TargetsScreen shows ONLY what the view-model
 * carries (R14-1).
 *
 * The fixture is the exact payload shape of GET /api/v1/targets in the S1
 * daemon (evidence r13-smoke-targets): two routers, readBackLevel 'db-only',
 * db.combosManaged 1, db.combosAdopted 0, and NO applyState (daemon S1 never
 * wrote anything, so it never claims an apply outcome).
 *
 * Validates:
 * 1. The cards come from the VM: OmniRoute + 9Router, and no OpenCode card.
 * 2. The counts come from the VM: combosManaged 1, combosAdopted 0.
 * 3. An unmeasured apply state renders "—" (never "verified" / "pending reload").
 * 4. The read-back chip carries the VM level 'db-only'.
 * 5. No hard-coded "4 / 4" / "3 / 4" rows, no tier chip, no preview/live switch.
 * 6. `targets` undefined -> no card, no invented number.
 * 7. db.meta unavailable -> the counts are "—", never 0.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TargetsScreen } from '../src/screens/TargetsScreen';
import type { TargetViewModel } from '../src/api/types';
import type { ApiClient } from '../src/api/client';

const TARGETS_FIXTURE: TargetViewModel[] = [
  {
    id: 'omniroute',
    name: 'OmniRoute',
    type: 'router',
    addressOrPath: 'http://127.0.0.1:59128',
    supportsCombos: true,
    readBackLevel: 'db-only',
    derivedFrom: 'no_key_in_s1',
    db: {
      meta: {
        source: 'live',
        generatedAt: '2026-10-19T07:14:10.446Z',
      },
      combosManaged: 1,
      combosAdopted: 0,
    },
    probe: {
      meta: {
        source: 'unavailable',
        reason: 'router_unreachable',
        generatedAt: '2026-10-19T07:14:10.454Z',
      },
      reachability: 'down',
    },
  },
  {
    id: '9router',
    name: '9Router',
    type: 'router',
    addressOrPath: 'http://127.0.0.1:59129',
    supportsCombos: true,
    readBackLevel: 'db-only',
    derivedFrom: 'no_key_in_s1',
    db: {
      meta: {
        source: 'live',
        generatedAt: '2026-10-19T07:14:10.451Z',
      },
      combosManaged: 1,
      combosAdopted: 0,
    },
    probe: {
      meta: {
        source: 'unavailable',
        reason: 'router_unreachable',
        generatedAt: '2026-10-19T07:14:10.454Z',
      },
      reachability: 'down',
    },
  },
];

describe('Acceptance Test AT-136 (UI): TargetsScreen is a pure function of the VM (R14-1)', () => {
  it('renders the targets of the VM, their measured counts, and nothing else', () => {
    render(<TargetsScreen targets={TARGETS_FIXTURE} />);

    // --- cards come from the VM -------------------------------------------
    expect(screen.getByTestId('target-card-omniroute')).toBeDefined();
    expect(screen.getByTestId('target-card-9router')).toBeDefined();
    expect(screen.queryByTestId('target-card-opencode')).toBeNull();
    expect(screen.queryByText('OpenCode')).toBeNull();

    expect(screen.getByText('OmniRoute')).toBeDefined();
    expect(screen.getByText('9Router')).toBeDefined();

    // --- counts come from the VM ------------------------------------------
    const managed = screen.getAllByTestId('combos-managed-count');
    expect(managed).toHaveLength(2);
    for (const el of managed) expect(el.textContent).toBe('1');

    const adopted = screen.getAllByTestId('combos-adopted-count');
    expect(adopted).toHaveLength(2);
    for (const el of adopted) expect(el.textContent).toBe('0');

    // --- apply state was never measured -> "—" ----------------------------
    const applyChips = screen.getAllByTestId('apply-chip');
    expect(applyChips).toHaveLength(2);
    for (const chip of applyChips) {
      expect(chip.textContent).toContain('—');
      expect(chip.textContent).not.toContain('đã xác minh');
      expect(chip.textContent).not.toContain('chờ tải lại');
    }
    expect(screen.queryByText(/đã xác minh/)).toBeNull();
    expect(screen.queryByText(/chờ tải lại/)).toBeNull();

    // --- read-back chip carries the VM level ------------------------------
    // R16-3.1: the chip showed the level TWICE ("chỉ đọc DB · db-only"). Now
    // it shows the translated label ONCE; the machine level stays in the
    // data-level attribute.
    const readBackChips = screen.getAllByTestId('readback-chip');
    expect(readBackChips).toHaveLength(2);
    for (const chip of readBackChips) {
      expect(chip.getAttribute('data-level')).toBe('db-only');
      expect(chip.textContent).toBe('chỉ đọc DB');
      expect(chip.textContent).not.toContain('· db-only');
    }

    // --- no hard-coded prototype rows / switches ---------------------------
    expect(screen.queryByText('4 / 4')).toBeNull();
    expect(screen.queryByText('3 / 4')).toBeNull();
    expect(screen.queryByText('T1 · API')).toBeNull();
    expect(screen.queryByText('T2 · File')).toBeNull();
    expect(screen.queryByText('T3 · SQLite')).toBeNull();
    // no tier chip: the daemon S1 does not report an integration tier
    expect(screen.queryByTestId('tier-chip')).toBeNull();
    // no preview/live switch: S1 is read-only, there is no write action
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('renders no card and no invented number when the targets are not loaded yet', () => {
    const pendingApi = {
      isMock: () => true,
      getTargets: () => new Promise<never>(() => {}),
    } as unknown as ApiClient;

    render(<TargetsScreen api={pendingApi} />);

    expect(screen.getByTestId('targets-empty-state')).toBeDefined();
    expect(screen.queryByTestId('target-card-omniroute')).toBeNull();
    expect(screen.queryByTestId('target-card-9router')).toBeNull();
    expect(screen.queryByText('4 / 4')).toBeNull();
    expect(screen.queryByText('3 / 4')).toBeNull();
    expect(screen.queryAllByTestId('unmeasured-count')).toHaveLength(0);
  });

  it('renders "—" for the combo counts when the router DB is unavailable', () => {
    const dbUnavailable: TargetViewModel[] = [
      {
        id: 'omniroute',
        name: 'OmniRoute',
        type: 'router',
        addressOrPath: 'http://127.0.0.1:59128',
        supportsCombos: true,
        readBackLevel: 'db-only',
        db: {
          meta: {
            source: 'unavailable',
            reason: 'db_not_found',
            generatedAt: '2026-10-19T07:14:10.446Z',
          },
        },
      },
    ];

    render(<TargetsScreen targets={dbUnavailable} />);

    expect(screen.getByTestId('combos-managed-count').textContent).toBe('—');
    expect(screen.getByTestId('combos-adopted-count').textContent).toBe('—');
    // a zero must never be invented for an unreadable DB
    expect(screen.queryByText('0')).toBeNull();
  });
});
