import { describe, expect, it } from 'vitest';
import {
  formatReorderBody,
  hangMoves,
  parseReliabilityText,
  reorderCombo,
  sameSteps,
  stepRank,
  type ReliabilityInfo,
} from '../src/commands/combos-reorder.js';
import type { StepStat } from '../src/commands/combos-plan.js';

function stat(model: string, group: StepStat['group'], medianMs: number, verdicts: StepStat['verdicts'] = ['OK']): StepStat {
  return {
    model,
    runs: 2,
    startedAts: [],
    verdicts,
    medianMs,
    okCount: verdicts.filter((v) => v === 'OK').length,
    timeoutCount: 0,
    hangCount: 0,
    hardCount: 0,
    fastErrorCount: 0,
    group,
  };
}

const rel = (p90Ms: number | null, label: ReliabilityInfo['label'] = 'RELIABLE'): ReliabilityInfo => ({
  label,
  p90Ms,
  ok: label === 'HANG' ? 0 : 6,
  attempts: 6,
});

describe('C40 X1: sắp xếp lại combo', () => {
  it('đọc nhãn reliability từ output combos reliability', () => {
    const text = [
      'cf/a\tRELIABLE\tok=6/6\tp90=674ms',
      'gemini/b\tHANG\tok=0/6\tp90=-ms',
      'oc/c\tRATE-LIMITED\tok=0/6\tp90=-ms',
    ].join('\n');
    const parsed = parseReliabilityText(text);
    expect(parsed.get('cf/a')?.p90Ms).toBe(674);
    expect(parsed.get('gemini/b')?.label).toBe('HANG');
    expect(parsed.get('gemini/b')?.p90Ms).toBeNull();
    expect(parsed.get('oc/c')?.label).toBe('RATE-LIMITED');
  });

  it('bước HANG luôn xếp hạng 6', () => {
    const rank = stepRank('gemini/b', stat('gemini/b', 'KEEP', 10), rel(null, 'HANG'));
    expect(rank.rank).toBe(6);
    expect(rank.reason).toContain('HANG');
  });

  it('mutation: đưa HANG vào hạng 1 thì đỏ', () => {
    const rank = stepRank('gemini/b', undefined, rel(null, 'HANG'));
    expect(rank.rank === 1).toBe(false);
  });

  it('giữ nguyên số bước, không mất không nhân đôi', () => {
    const order = [
      'gemini/hang',
      'cf/a',
      'oc/limited',
      'groq/b',
      'nvidia/unmeasured',
      'hf/dead',
      'cf/slow',
    ];
    const stats = new Map([
      ['cf/a', stat('cf/a', 'KEEP', 700)],
      ['groq/b', stat('groq/b', 'KEEP', 400)],
      ['oc/limited', stat('oc/limited', 'FAST-ERROR', 100, ['RATE-LIMITED'])],
      ['hf/dead', stat('hf/dead', 'FAST-ERROR', 50, ['ERROR'])],
      ['cf/slow', stat('cf/slow', 'KEEP', 9000)],
    ]);
    const reliability = new Map<string, ReliabilityInfo>([['gemini/hang', rel(null, 'HANG')]]);
    const result = reorderCombo(order, stats, reliability);

    expect(sameSteps(order, result.order)).toBe(true);
    expect(result.order).toHaveLength(order.length);
    expect(new Set(result.order).size).toBe(order.length);
    expect(result.order.at(-1)).toBe('gemini/hang');
    expect(result.details.get('gemini/hang')?.oldIndex).toBe(0);
    expect(result.details.get('cf/a')?.rank).toBe(1);
    expect(result.details.get('oc/limited')?.rank).toBe(3);
    expect(result.details.get('nvidia/unmeasured')?.rank).toBe(4);
    expect(result.details.get('hf/dead')?.rank).toBe(5);
    expect(formatReorderBody(result).join('\n')).toContain('hạng 6');
  });

  it('in vị trí cũ -> mới của bước HANG', () => {
    const order = ['gemini/hang', 'cf/a', 'cf/b'];
    const result = reorderCombo(order, new Map(), new Map([['gemini/hang', rel(null, 'HANG')]]));
    expect(hangMoves(result)).toEqual([{ step: 'gemini/hang', oldIndex: 0, newIndex: 2 }]);
  });
});
