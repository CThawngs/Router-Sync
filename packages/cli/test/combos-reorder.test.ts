import { describe, expect, it } from 'vitest';
import {
  formatReorderBody,
  hangMoves,
  parseOrderFile,
  parseReliabilityText,
  relabelReliabilityText,
  reorderCombo,
  reorderWithFile,
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
  ok: label === 'HANG' ? 0 : label === 'LOW-SAMPLE' ? 1 : 6,
  attempts: label === 'LOW-SAMPLE' ? 1 : 6,
});

const W4_FIXTURE = [
  'bước cần đo: 39 (giới hạn 70)',
  'cf/@cf/meta/llama-3.2-3b-instruct\tRELIABLE\tok=6/6\tp90=674ms',
  'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast\tRELIABLE\tok=6/6\tp90=719ms',
  'cf/@cf/mistralai/mistral-small-3.1-24b-instruct\tRELIABLE\tok=6/6\tp90=986ms',
  'cf/@cf/zai-org/glm-4.7-flash\tRELIABLE\tok=6/6\tp90=3080ms',
  'gemini/gemini-3.8-flash\tHANG\tok=0/6\tp90=3777ms',
  'gemini/gemini-4-hydrogen\tHANG\tok=1/6\tp90=17020ms',
  'groq/allam-2-7b\tRELIABLE\tok=6/6\tp90=1682ms',
  'groq/openai/gpt-oss-120b\tRELIABLE\tok=6/6\tp90=3122ms',
  'groq/openai/gpt-oss-20b\tRELIABLE\tok=6/6\tp90=684ms',
  'groq/qwen/qwen3.8-27b\tRELIABLE\tok=6/6\tp90=1525ms',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free\tRELIABLE\tok=6/6\tp90=2257ms',
  'nvidia/google/gemma-4-31b-it\tHANG\tok=0/6\tp90=-ms',
  'nvidia/meta/muse-glimmer-30b\tHANG\tok=0/6\tp90=-ms',
  'nvidia/nvidia/ising-calibration-1.5-31b\tRELIABLE\tok=6/6\tp90=895ms',
  'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning\tRELIABLE\tok=6/6\tp90=1777ms',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b\tRELIABLE\tok=6/6\tp90=2243ms',
  'nvidia/nvidia/nemotron-3.5-lightning-30b-a3b\tRELIABLE\tok=6/6\tp90=1754ms',
  'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b\tRELIABLE\tok=6/6\tp90=1884ms',
  'nvidia/nvidia/riva-translate-4b-instruct-v2\tRELIABLE\tok=6/6\tp90=1597ms',
  'nvidia/poolside/laguna-xs-2.1\tRELIABLE\tok=6/6\tp90=1653ms',
  'nvidia/stepfun-ai/step-5-preview\tHANG\tok=4/6\tp90=5354ms',
  'nvidia/z-ai/glm-5.3-flash\tHANG\tok=0/6\tp90=-ms',
  'chưa đo: 17 bước (hết ngân sách)',
  'xong: 22 bước, chưa đo 17',
].join('\n');

const X2_FIXTURE = [
  'bước cần đo: 17 (giới hạn 70)',
  'oc/big-pickle\tRATE-LIMITED\tok=0/1\tp90=1597ms\tquota=1',
  'openrouter/baidu/ernie-5.5-flash-preview:free\tDEAD\tok=1/1\tp90=3312ms',
  'oc/deepseek-v4.1-flash-free\tRATE-LIMITED\tok=0/1\tp90=449ms\tquota=1',
  'openrouter/inclusionai/ling-3.2-flash:free\tDEAD\tok=0/1\tp90=5584ms',
  'oc/hy4-flash-free\tRATE-LIMITED\tok=0/1\tp90=791ms\tquota=1',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free\tDEAD\tok=1/1\tp90=994ms',
  'oc/iceman-free\tRATE-LIMITED\tok=0/1\tp90=457ms\tquota=1',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free\tDEAD\tok=1/1\tp90=1274ms',
  'oc/longcat-2.5-free\tRATE-LIMITED\tok=0/1\tp90=417ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-lightning:free\tDEAD\tok=1/1\tp90=872ms',
  'oc/mimo-v2.6-flash-free\tRATE-LIMITED\tok=0/1\tp90=2619ms\tquota=1',
  'openrouter/nvidia/nemotron-3.5-super-vl:free\tDEAD\tok=1/1\tp90=901ms',
  'oc/nemotron-3.5-lightning-free\tRATE-LIMITED\tok=0/1\tp90=583ms\tquota=1',
  'openrouter/openrouter/free\tDEAD\tok=1/1\tp90=845ms',
  'oc/nemotron-3.5-super-vl-free\tRATE-LIMITED\tok=0/1\tp90=2575ms\tquota=1',
  'openrouter/recursive/flint-v1.0:free\tDEAD\tok=1/1\tp90=1219ms',
  'oc/tidepool-alpha-free\tRATE-LIMITED\tok=0/1\tp90=1854ms\tquota=1',
  'requests=17/30 theo provider=oc:9,openrouter:8',
  'xong: 17 bước, chưa đo 0; requests=17/30 theo provider=oc:9,openrouter:8',
].join('\n');

describe('C40 X1: sắp xếp lại combo', () => {
  it('đọc nhãn reliability từ output combos reliability', () => {
    const text = [
      'cf/a\tRELIABLE\tok=6/6\tp90=674ms',
      'gemini/b\tHANG\tok=0/6\tp90=-ms',
      'oc/c\tRATE-LIMITED\tok=0/6\tp90=-ms',
      'openrouter/openrouter/free\tLOW-SAMPLE\tok=1/1\tp90=845ms',
    ].join('\n');
    const parsed = parseReliabilityText(text);
    expect(parsed.get('cf/a')?.p90Ms).toBe(674);
    expect(parsed.get('gemini/b')?.label).toBe('HANG');
    expect(parsed.get('gemini/b')?.p90Ms).toBeNull();
    expect(parsed.get('oc/c')?.label).toBe('RATE-LIMITED');
    expect(parsed.get('openrouter/openrouter/free')?.label).toBe('LOW-SAMPLE');
    expect(parsed.get('openrouter/openrouter/free')?.p90Ms).toBe(845);
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

  it('Y1: đọc tệp thứ tự, bỏ chú thích và dòng trống', () => {
    const parsed = parseOrderFile('# tiêu đề\ngroq/a\n\ngroq/a\ncf/b\n');
    expect(parsed.steps).toEqual(['groq/a', 'cf/b']);
    expect(parsed.comments).toEqual(['# tiêu đề']);
    expect(parsed.blankLines).toBe(2);
  });

  it('Y1: bước trong tệp đứng đầu đúng thứ tự', () => {
    const order = ['cf/a', 'groq/b', 'nvidia/c', 'oc/d'];
    const stats = new Map([
      ['cf/a', stat('cf/a', 'KEEP', 100)],
      ['groq/b', stat('groq/b', 'KEEP', 200)],
      ['nvidia/c', stat('nvidia/c', 'KEEP', 300)],
    ]);
    const file = parseOrderFile('nvidia/c\ncf/a\n');
    const result = reorderWithFile(order, stats, new Map(), file);
    expect(result.order.slice(0, 2)).toEqual(['nvidia/c', 'cf/a']);
    expect(sameSteps(order, result.order)).toBe(true);
    expect(result.usedFile).toBe(true);
  });

  it('Y1: bước HANG trong tệp bị chặn, dòng lạ được báo', () => {
    const order = ['cf/a', 'gemini/hang', 'groq/b'];
    const relMap = new Map<string, ReliabilityInfo>([['gemini/hang', rel(null, 'HANG')]]);
    const file = parseOrderFile('gemini/hang\ncf/a\nkhong/khop\n');
    const result = reorderWithFile(order, new Map(), relMap, file);
    expect(result.order[0]).toBe('cf/a');
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.step).toBe('gemini/hang');
    expect(result.unknownLines).toEqual(['khong/khop']);
  });

  it('Y1: tệp rỗng thì dùng thứ tự speed', () => {
    const order = ['cf/a', 'groq/b'];
    const result = reorderWithFile(order, new Map(), new Map(), parseOrderFile('# chỉ chú thích\n'));
    expect(result.usedFile).toBe(false);
    expect(result.order).toEqual(order);
  });

  it('Y1: mutation — cho phép HANG đứng đầu thì đỏ', () => {
    const order = ['cf/a', 'gemini/hang'];
    const relMap = new Map<string, ReliabilityInfo>([['gemini/hang', rel(null, 'HANG')]]);
    const result = reorderWithFile(order, new Map(), relMap, parseOrderFile('gemini/hang\n'));
    expect(result.order[0] === 'gemini/hang').toBe(false);
  });

  it('in vị trí cũ -> mới của bước HANG', () => {
    const order = ['gemini/hang', 'cf/a', 'cf/b'];
    const result = reorderCombo(order, new Map(), new Map([['gemini/hang', rel(null, 'HANG')]]));
    expect(hangMoves(result)).toEqual([{ step: 'gemini/hang', oldIndex: 0, newIndex: 2 }]);
  });
});

describe('R2: relabelReliabilityText và xếp hạng LOW-SAMPLE', () => {
  it('tính lại w4 (22 bước, 0 đổi) và x2 (17 bước: 7 DEAD -> LOW-SAMPLE, 9 RATE-LIMITED, 1 DEAD)', () => {
    const w4Out = relabelReliabilityText(W4_FIXTURE);
    expect(w4Out.changes).toHaveLength(0);
    expect(parseReliabilityText(w4Out.text).size).toBe(22);

    const x2Out = relabelReliabilityText(X2_FIXTURE);
    expect(x2Out.changes).toHaveLength(7);
    expect(x2Out.changes.every((c) => c.from === 'DEAD' && c.to === 'LOW-SAMPLE')).toBe(true);
    expect(x2Out.changes.map((c) => c.step)).toEqual([
      'openrouter/baidu/ernie-5.5-flash-preview:free',
      'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/nvidia/nemotron-3.5-lightning:free',
      'openrouter/nvidia/nemotron-3.5-super-vl:free',
      'openrouter/openrouter/free',
      'openrouter/recursive/flint-v1.0:free',
    ]);

    const parsedX2 = parseReliabilityText(x2Out.text);
    expect(parsedX2.size).toBe(17);
    expect(parsedX2.get('openrouter/inclusionai/ling-3.2-flash:free')?.label).toBe('DEAD');
    expect(parsedX2.get('oc/big-pickle')?.label).toBe('RATE-LIMITED');
    expect(parsedX2.get('openrouter/openrouter/free')?.label).toBe('LOW-SAMPLE');
  });

  it('LOW-SAMPLE giữ hạng 4 (không tự lên hạng 1 RELIABLE) và không bị chặn trong --order file', () => {
    const lowInfo: ReliabilityInfo = { label: 'LOW-SAMPLE', p90Ms: 845, ok: 1, attempts: 1 };
    const deadInfo: ReliabilityInfo = { label: 'DEAD', p90Ms: 5584, ok: 0, attempts: 1 };
    const rank = stepRank('openrouter/openrouter/free', undefined, lowInfo);
    expect(rank).toEqual({ rank: 4, reason: 'LOW-SAMPLE ok=1/1 p90=845ms' });

    const order = ['cf/a', 'openrouter/openrouter/free', 'openrouter/inclusionai/ling-3.2-flash:free'];
    const relMap = new Map<string, ReliabilityInfo>([
      ['cf/a', rel(674, 'RELIABLE')],
      ['openrouter/openrouter/free', lowInfo],
      ['openrouter/inclusionai/ling-3.2-flash:free', deadInfo],
    ]);
    const file = parseOrderFile('openrouter/openrouter/free\nopenrouter/inclusionai/ling-3.2-flash:free\n');
    const result = reorderWithFile(order, new Map(), relMap, file);
    expect(result.order[0]).toBe('openrouter/openrouter/free');
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.step).toBe('openrouter/inclusionai/ling-3.2-flash:free');
  });
});
