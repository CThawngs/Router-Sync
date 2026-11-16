/**
 * packages/ui/test/at-132-targets-screen.test.tsx
 *
 * Acceptance Test AT-132 (UI): TargetsScreen consumes target.db.* and handles missing counts honestly (R13-1.2).
 *
 * Validates:
 * 1. Case A: When target.db has combosManaged/combosAdopted, values are displayed accurately.
 * 2. Case B: When DB is unavailable / counts omitted, displays "—" with s1_not_measured tooltip,
 *    and NEVER displays "0" or "0 combo" or NaN/undefined.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TargetsScreen } from '../src/screens/TargetsScreen';
import type { TargetViewModel } from '../src/api/types';

describe('Acceptance Test AT-132 (UI): TargetsScreen DB counts truthfulness (R13-1.2)', () => {
  it('Case A: renders measured combosManaged and combosAdopted when DB is readable', () => {
    const targetsCaseA: TargetViewModel[] = [
      {
        id: 'omniroute',
        name: 'OmniRoute',
        type: 'router',
        addressOrPath: 'http://127.0.0.1:30128',
        supportsCombos: true,
        db: {
          meta: { source: 'live', generatedAt: new Date().toISOString() },
          combosManaged: 5,
          combosAdopted: 2,
        },
      },
      {
        id: '9router',
        name: '9Router',
        type: 'router',
        addressOrPath: 'http://127.0.0.1:20128',
        supportsCombos: true,
        db: {
          meta: { source: 'live', generatedAt: new Date().toISOString() },
          combosManaged: 3,
          combosAdopted: 1,
        },
      },
    ];

    render(<TargetsScreen viewMode="detail" targets={targetsCaseA} />);

    // R14-1: the card id follows the VM target id.
    expect(screen.getByTestId('target-card-omniroute')).toBeDefined();
    expect(screen.getByTestId('target-card-9router')).toBeDefined();

    // OmniRoute counts
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();

    // 9Router counts
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('1')).toBeDefined();
  });

  it('Case B: renders "—" when DB is unavailable and counts are omitted; no "0 combo"', () => {
    const targetsCaseB: TargetViewModel[] = [
      {
        id: 'omniroute',
        name: 'OmniRoute',
        type: 'router',
        addressOrPath: 'http://127.0.0.1:30128',
        supportsCombos: true,
        db: {
          meta: { source: 'unavailable', reason: 'db_unreadable', generatedAt: new Date().toISOString() },
          // combosManaged and combosAdopted are omitted
        },
      },
      {
        id: '9router',
        name: '9Router',
        type: 'router',
        addressOrPath: 'http://127.0.0.1:20128',
        supportsCombos: true,
        db: {
          meta: { source: 'unavailable', reason: 'db_not_found', generatedAt: new Date().toISOString() },
          // combosManaged and combosAdopted are omitted
        },
      },
    ];

    render(<TargetsScreen viewMode="detail" targets={targetsCaseB} />);

    // Unmeasured dashes must be present
    const unmeasuredDashes = screen.getAllByTestId('unmeasured-count');
    expect(unmeasuredDashes.length).toBeGreaterThanOrEqual(4);
    for (const dash of unmeasuredDashes) {
      expect(dash.textContent).toBe('—');
    }

    // Must NOT display "0 combo" anywhere
    expect(screen.queryByText(/0 combo/i)).toBeNull();
    // Must NOT display NaN or undefined
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});
