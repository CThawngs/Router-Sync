/**
 * packages/cli/test/roundC3o.test.ts
 * C3o: O1(d) PLAN-SUSPECT unit, O2(b) externalLabel unit,
 * O3(e) hình dạng lỗi thật của 127.0.0.1:1 trên Windows (in ra, không đoán).
 */
import { describe, it, expect } from 'vitest';
import { isPlanSuspect } from '../src/commands/plan.js';
import { externalLabel } from '../src/commands/dead-models.js';

describe('C3o O1(d) PLAN-SUSPECT', () => {
  it('rules thật: gỡ ít, giữ nhiều -> không suspect', () => {
    expect(isPlanSuspect(100, 10, 90)).toBe(false);
    expect(isPlanSuspect(2469, 1, 2468)).toBe(false);
  });
  it('rules rỗng: gỡ >25% bước hoặc giữ=0 -> PLAN-SUSPECT', () => {
    // Gỡ 3957 trên 3944 bước như hành vi daemon cũ hiện ra ở C3n.
    expect(isPlanSuspect(3944, 3957, 0)).toBe(true);
    expect(isPlanSuspect(100, 30, 70)).toBe(true);
    expect(isPlanSuspect(100, 0, 0)).toBe(true);
  });
  it('router không có bước: không suspect khi không gỡ', () => {
    expect(isPlanSuspect(0, 0, 0)).toBe(false);
  });
});

describe('C3o O2(b) externalLabel', () => {
  it('chỉ bản ghi ngoài thực sự khớp (models-dev:/openrouter:) mới là CÒN-Ở-NGUỒN-NGOÀI', () => {
    expect(externalLabel('models-dev:huggingface/Qwen3-235B-A22B', true)).toBe('CÒN-Ở-NGUỒN-NGOÀI');
    expect(externalLabel('openrouter:openai/gpt-5', true)).toBe('CÒN-Ở-NGUỒN-NGOÀI');
  });
  it('nhà phủ=0 không có bản ghi chéo -> VẮNG-CATALOG, NGUỒN-NGOÀI-KHÔNG-PHỦ', () => {
    expect(externalLabel(null, false)).toBe('VẮNG-CATALOG, NGUỒN-NGOÀI-KHÔNG-PHỦ');
    expect(externalLabel(null, true)).toBe('VẮNG-CATALOG+NGUỒN-NGOÀI');
  });
  it('không còn nhãn KHỚP-CHÉO hay ngoài:node-a/... của id bước', () => {
    expect(externalLabel('ngoài:node-a/beam-free', false)).toBe('VẮNG-CATALOG, NGUỒN-NGOÀI-KHÔNG-PHỦ');
  });
});

describe('C3o O3(e) lỗi 127.0.0.1:1', () => {
  it('in hình dạng lỗi thật (name/code/cause.code/errors[0].code)', async () => {
    try {
      await fetch('http://127.0.0.1:1', { signal: AbortSignal.timeout(5000) });
      console.log('ERR-SHAPE 127.0.0.1:1 = fetch succeeded (unexpected)');
    } catch (e) {
      const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string; errors?: Array<{ code?: string; message?: string }> }; errors?: Array<{ code?: string }> };
      const c = err.cause;
      console.log(`ERR-SHAPE 127.0.0.1:1 name=${err.name} code=${err.code} cause.code=${err.cause?.code} errors[0].code=${err.errors?.[0]?.code ?? err.cause?.errors?.[0]?.code}`);
      console.log(`ERR-DETAIL message=${String(err.message).slice(0, 200)}`);
      console.log(`ERR-DETAIL cause.message=${String(c?.message).slice(0, 200)} cause.errors=${JSON.stringify(c?.errors ?? err.errors ?? null).slice(0, 300)}`);
    }
  }, 15000);
});
