import { describe, it, expect } from 'vitest';
import { diffFenceTables } from '../src/sync/write.js';

const row = (table: string, count: number, hash: string) => ({ table, count, hash });

describe('G4 per-table fence diff', () => {
  it('only combos changed => combos DIFF expected, verdict PASS', () => {
    const d = diffFenceTables(
      [row('combos', 3, 'aaa'), row('providerConnections', 5, 'bbb')],
      [row('combos', 3, 'zzz'), row('providerConnections', 5, 'bbb')]
    );
    expect(d.unexpectedDiff).toBe(0);
    expect(d.verdict).toBe('PASS');
    const combos = d.rows.find((r) => r.table === 'combos');
    expect(combos).toMatchObject({ status: 'DIFF', expected: true, hashBefore: 'aaa', hashAfter: 'zzz' });
    expect(d.rows.find((r) => r.table === 'providerConnections')?.status).toBe('SAME');
  });

  it('a non-combos table changed => unexpectedDiff 1, verdict REVIEW', () => {
    const d = diffFenceTables(
      [row('combos', 3, 'aaa'), row('providerConnections', 5, 'bbb')],
      [row('combos', 3, 'aaa'), row('providerConnections', 6, 'ccc')]
    );
    expect(d.unexpectedDiff).toBe(1);
    expect(d.verdict).toBe('REVIEW');
    expect(d.rows.find((r) => r.table === 'providerConnections')).toMatchObject({
      status: 'DIFF',
      expected: false,
      countBefore: 5,
      countAfter: 6,
    });
  });

  it('a table appearing or disappearing is DIFF and unexpected', () => {
    const appeared = diffFenceTables([row('combos', 1, 'a')], [row('combos', 1, 'a'), row('newTable', 1, 'n')]);
    expect(appeared.verdict).toBe('REVIEW');
    expect(appeared.unexpectedDiff).toBe(1);
    expect(appeared.rows.find((r) => r.table === 'newTable')).toMatchObject({
      status: 'DIFF',
      countBefore: null,
      countAfter: 1,
    });

    const vanished = diffFenceTables([row('combos', 1, 'a'), row('gone', 2, 'g')], [row('combos', 1, 'a')]);
    expect(vanished.verdict).toBe('REVIEW');
    expect(vanished.rows.find((r) => r.table === 'gone')).toMatchObject({ status: 'DIFF', countAfter: null });
  });

  it('identical fingerprints => all SAME, verdict PASS', () => {
    const snap = [row('combos', 2, 'h1'), row('models', 40, 'h2')];
    const d = diffFenceTables(snap, snap);
    expect(d.verdict).toBe('PASS');
    expect(d.unexpectedDiff).toBe(0);
    expect(d.rows.every((r) => r.status === 'SAME')).toBe(true);
  });

  it('rows are sorted by table name so the evidence output is stable', () => {
    const d = diffFenceTables([], [row('zeta', 1, 'z'), row('alpha', 1, 'a')]);
    expect(d.rows.map((r) => r.table)).toEqual(['alpha', 'zeta']);
  });
});
