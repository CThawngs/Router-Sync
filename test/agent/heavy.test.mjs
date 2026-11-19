import { describe, expect, it } from 'vitest';
import { decideHeavy, parseVmStat, availableMemoryBytes, HEAVY_REAL } from '../../tools/agent/heavy.mjs';

// Same sample as packages/cli/test/c15-low-resource.test.ts (C15 Q1.3).
const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                              2000.
Pages inactive:                             500.
Pages speculative:                          250.
Pages purgeable:                            125.
Pages wired down:                          3000.
`;

describe('tools/agent/heavy.mjs — chặn lệnh nặng khi RAM trống < 1.5 GiB', () => {
  it('chặn khi RAM trống 800 MB', () => {
    expect(decideHeavy(800 * 1024 * 1024)).toBe(true);
  });

  it('cho chạy khi RAM trống 4096 MB', () => {
    expect(decideHeavy(4096 * 1024 * 1024)).toBe(false);
  });

  it('cho chạy khi force bypass (RS_FORCE_HEAVY=1 hoặc CI=true)', () => {
    expect(decideHeavy(800 * 1024 * 1024, true)).toBe(false);
    expect(decideHeavy(4096 * 1024 * 1024, true)).toBe(false);
  });

  it('C19 W1: macOS vm_stat counts free + inactive + speculative + purgeable', () => {
    expect(parseVmStat(SAMPLE)).toBe((1000 + 500 + 250 + 125) * 16384);
  });

  it('C19 W1: returns null when page size is missing', () => {
    expect(parseVmStat('Pages free: 10.\n')).toBeNull();
  });

  it('C19 W1: available memory is a positive byte count on this platform', () => {
    expect(availableMemoryBytes()).toBeGreaterThan(0);
  });
});

describe('C19 W1: mỗi lệnh nặng là danh sách bước, không có toán tử shell', () => {
  const SHELL_OPERATORS = /(^|[^\\])(&&|\|\||;|\||>|<)/;

  it.each(Object.entries(HEAVY_REAL))('%s có ít nhất một bước', (_cmd, steps) => {
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(HEAVY_REAL))('%s không chứa toán tử shell hay pnpm lặp', (_cmd, steps) => {
    for (const step of steps) {
      expect(Array.isArray(step)).toBe(true);
      for (const arg of step) {
        expect(arg).not.toMatch(SHELL_OPERATORS);
        expect(arg).not.toBe('pnpm');
      }
    }
  });
});
