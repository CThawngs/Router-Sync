/**
 * packages/cli/test/maintain-plan.test.ts
 *
 * Unit tests for computePlan pure function (M1–M11, Condition D26).
 */

import { describe, it, expect } from 'vitest';
import { computePlan, type MaintainPlanInput } from '../src/maintain/plan.js';

describe('computePlan pure function', () => {
  it('blocks unmanaged combos', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'user-combo',
          managed: false,
          adopted: false,
          models: ['provider/m1', 'provider/m2'],
        },
      ],
      providers: {},
    };

    const res = computePlan(input);
    expect(res.removes).toHaveLength(0);
    expect(res.adds).toHaveLength(0);
    expect(res.blocked).toContainEqual({ combo: 'user-combo', reason: 'unmanaged' });
  });

  it('blocks 9router when policyMode is not manual or shadow (Condition D26)', () => {
    const input: MaintainPlanInput = {
      router: '9router',
      policyMode: 'automatic',
      combos: [
        {
          id: 'combo-fast',
          managed: true,
          models: ['p1/m1', 'p1/m2'],
        },
      ],
      providers: {},
    };

    const res = computePlan(input);
    expect(res.blocked).toContainEqual({ combo: 'combo-fast', reason: 'd26-manual' });
  });

  it('allows 9router with shadow or manual policyMode', () => {
    const input: MaintainPlanInput = {
      router: '9router',
      policyMode: 'shadow',
      combos: [
        {
          id: 'combo-fast',
          managed: true,
          models: ['p1/m1', 'p1/m2'],
        },
      ],
      providers: {},
    };

    const res = computePlan(input);
    expect(res.blocked).not.toContainEqual(expect.objectContaining({ reason: 'd26-manual' }));
  });

  it('removes model if in removed list and remaining models >= 2', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-trio',
          managed: true,
          models: ['p1/m1', 'p1/m2', 'p1/m3'],
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          removed: ['p1/m1'],
        },
      },
    };

    const res = computePlan(input);
    expect(res.removes).toEqual([
      { combo: 'combo-trio', model: 'p1/m1', reason: 'model-removed' },
    ]);
    expect(res.removes.length).toBe(1);
  });

  it('blocks removal if remaining count would fall below 2 (min-steps rule)', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-duo',
          managed: true,
          models: ['p1/m1', 'p1/m2'],
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          removed: ['p1/m1'],
        },
      },
    };

    const res = computePlan(input);
    expect(res.removes).toHaveLength(0);
    expect(res.blocked).toContainEqual({ combo: 'combo-duo', reason: 'min-steps' });
  });

  it('adds matching candidate models up to maxAdds cap', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-all',
          managed: true,
          models: ['p1/base1', 'p1/base2'],
          rule: {
            providers: ['p1'],
            match: '^p1/coder-',
            maxAdds: 2,
          },
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          added: [
            { id: 'p1/coder-3' },
            { id: 'p1/coder-1' },
            { id: 'p1/coder-2' },
            { id: 'p1/chat-general' }, // does not match regex
          ],
        },
      },
    };

    const res = computePlan(input);
    expect(res.adds).toEqual([
      { combo: 'combo-all', model: 'p1/coder-1', position: 'end' },
      { combo: 'combo-all', model: 'p1/coder-2', position: 'end' },
    ]);
    expect(res.blocked).toContainEqual({ combo: 'combo-all', reason: 'add-cap' });
  });

  it('blocks non-free additions for freeOnly combo', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-free',
          managed: true,
          freeOnly: true,
          models: ['p1/f1', 'p1/f2'],
          rule: {
            providers: ['p1'],
          },
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          added: [
            { id: 'p1/free-model', free: true },
            { id: 'p1/paid-model', free: false },
          ],
        },
      },
    };

    const res = computePlan(input);
    expect(res.adds).toEqual([
      { combo: 'combo-free', model: 'p1/free-model', position: 'end' },
    ]);
    expect(res.blocked).toContainEqual({
      combo: 'combo-free',
      model: 'p1/paid-model',
      reason: 'not-free',
    });
  });

  it('prohibits additions for adopt-guard combo while allowing removals', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-adopted',
          managed: false,
          adopted: true,
          adoptMode: 'guard',
          models: ['p1/m1', 'p1/m2', 'p1/m3'],
          rule: {
            providers: ['p1'],
          },
        },
      ],
      providers: {
        p1: {
          status: 'ok',
          removed: ['p1/m1'],
          added: [{ id: 'p1/m4' }],
        },
      },
    };

    const res = computePlan(input);
    expect(res.removes).toEqual([
      { combo: 'combo-adopted', model: 'p1/m1', reason: 'model-removed' },
    ]);
    expect(res.adds).toHaveLength(0);
    expect(res.blocked).toContainEqual({ combo: 'combo-adopted', reason: 'adopt-guard' });
  });

  it('blocks combo when provider status is not ok', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-fragile',
          managed: true,
          models: ['p1/m1', 'p1/m2'],
          rule: { providers: ['p1'] },
        },
      ],
      providers: {
        p1: {
          status: 'auth_error',
        },
      },
    };

    const res = computePlan(input);
    expect(res.blocked).toContainEqual({ combo: 'combo-fragile', reason: 'provider-not-ok' });
  });

  it('produces deterministic 16-hex planHash', () => {
    const input: MaintainPlanInput = {
      router: 'omniroute',
      combos: [
        {
          id: 'combo-hash',
          managed: true,
          models: ['p1/m1', 'p1/m2', 'p1/m3'],
        },
      ],
      providers: {
        p1: { status: 'ok', removed: ['p1/m1'] },
      },
    };

    const res1 = computePlan(input);
    const res2 = computePlan(input);
    expect(res1.planHash).toMatch(/^[0-9a-f]{16}$/);
    expect(res1.planHash).toBe(res2.planHash);
  });
});
