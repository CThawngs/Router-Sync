import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { setPriority } = vi.hoisted(() => ({ setPriority: vi.fn() }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, setPriority };
});

import { isLowResource, applyLowResourcePriority, _resetLowResourceCache } from '../src/low-resource.js';

describe('C14 (d): applyLowResourcePriority', () => {
  const orig = { ...process.env };
  beforeEach(() => { setPriority.mockClear(); _resetLowResourceCache(); });
  afterEach(() => { process.env = { ...orig }; _resetLowResourceCache(); });

  it('lowers priority when low-resource is forced on', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '1';
    expect(isLowResource()).toBe(true);
    expect(applyLowResourcePriority()).toBe(true);
    expect(setPriority).toHaveBeenCalledTimes(1);
  });

  it('does nothing when low-resource is forced off', () => {
    process.env['ROUTERSYNC_LOW_RESOURCE'] = '0';
    expect(applyLowResourcePriority()).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });
});
