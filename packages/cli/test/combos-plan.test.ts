// C33 N3: `combos plan` — nhóm, hai phương án, và dự đoán thời gian.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildComboPlan,
  buildStats,
  parseProbeText,
  predictHeaderMs,
  runCombosPlan,
  type ProbeRow,
} from '../src/commands/combos-plan.js';

const T0 = Date.parse('2026-11-21T20:00:00.000Z');
const T1 = Date.parse('2026-11-21T20:10:00.000Z');

function row(model: string, verdict: ProbeRow['verdict'], ms: number, startedAt: string): ProbeRow {
  return { model, verdict, ms, startedAt };
}
const at = (t: number) => new Date(t).toISOString();

describe('C33 N3: parseProbeText', () => {
  it('đọc dòng kết quả và startedAt', () => {
    const text = [
      'bắt đầu=2026-11-21T20:38:40.242Z tổng=231 OK=26',
      'nvidia/a/b\tOK\thttp=200\ttotal=283ms\tusage=nvidia/a/b',
      'nvidia/c/d\tEOL-GONE\thttp=410\ttotal=144ms\tusage=không có dòng usage',
      'bước 404\tERROR\thttp=404\ttotal=20ms',
    ].join('\n');
    const rows = parseProbeText(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.model).toBe('nvidia/a/b');
    expect(rows[0]?.ms).toBe(283);
    expect(rows[0]?.startedAt).toBe('2026-11-21T20:38:40.242Z');
    expect(rows[1]?.verdict).toBe('EOL-GONE');
  });
});

describe('C33 N3.1: nhóm bước', () => {
  it('lỗi cứng 2 lượt cách nhau > 1 phút → REMOVE', () => {
    const stats = buildStats([
      [row('p/gone', 'EOL-GONE', 300, at(T0))],
      [row('p/gone', 'EOL-GONE', 350, at(T1))],
    ]);
    expect(stats.get('p/gone')?.group).toBe('REMOVE');
  });

  it('lỗi cứng 1 lượt → KHÔNG REMOVE', () => {
    const stats = buildStats([[row('p/gone', 'EOL-GONE', 300, at(T0))]]);
    expect(stats.get('p/gone')?.group).toBe('UNTESTED');
  });

  it('503 trơn (ERROR-5XX) 2 lượt → KHÔNG REMOVE', () => {
    const stats = buildStats([
      [row('p/err', 'ERROR-5XX', 300, at(T0))],
      [row('p/err', 'ERROR-5XX', 300, at(T1))],
    ]);
    expect(stats.get('p/err')?.group).not.toBe('REMOVE');
  });

  it('TIMEOUT-NO-HEADER 2 lượt → MOVE-END', () => {
    const stats = buildStats([
      [row('p/slow', 'TIMEOUT-NO-HEADER', 20_000, at(T0))],
      [row('p/slow', 'TIMEOUT-NO-HEADER', 20_000, at(T1))],
    ]);
    expect(stats.get('p/slow')?.group).toBe('MOVE-END');
  });

  it('OK 2 lượt → KEEP, sắp theo thời gian', () => {
    const stats = buildStats([
      [row('p/fast', 'OK', 100, at(T0)), row('p/slow', 'OK', 900, at(T0))],
      [row('p/fast', 'OK', 120, at(T1)), row('p/slow', 'OK', 950, at(T1))],
    ]);
    const plan = buildComboPlan('c', ['p/slow', 'p/fast'], stats);
    expect(plan.planB.steps.join(',')).toBe('p/fast,p/slow');
  });

  it('404 (ERROR) → FAST-ERROR, không vào nhóm gỡ', () => {
    const stats = buildStats([
      [row('hf/x/y', 'ERROR', 30, at(T0))],
      [row('hf/x/y', 'ERROR', 40, at(T1))],
    ]);
    expect(stats.get('hf/x/y')?.group).toBe('FAST-ERROR');
    const plan = buildComboPlan('c', ['hf/x/y'], stats);
    expect(plan.remove).toHaveLength(0);
  });

  it('mutation: nếu ABSENT (một lượt) vào được nhóm gỡ thì test đỏ', () => {
    const stats = buildStats([[row('p/absent', 'ERROR', 30, at(T0))]]);
    expect(stats.get('p/absent')?.group).not.toBe('REMOVE');
  });
});

describe('C33 N3.2: hai phương án', () => {
  it('A bỏ nhóm gỡ, đưa nhóm timeout xuống cuối; B chỉ giữ OK', () => {
    const stats = buildStats([
      [
        row('p/ok', 'OK', 100, at(T0)),
        row('p/gone', 'EOL-GONE', 200, at(T0)),
        row('p/slow', 'TIMEOUT-NO-HEADER', 20_000, at(T0)),
        row('p/404', 'ERROR', 30, at(T0)),
      ],
      [
        row('p/ok', 'OK', 120, at(T1)),
        row('p/gone', 'EOL-GONE', 220, at(T1)),
        row('p/slow', 'TIMEOUT-NO-HEADER', 20_000, at(T1)),
        row('p/404', 'ERROR', 40, at(T1)),
      ],
    ]);
    const plan = buildComboPlan('c', ['p/ok', 'p/gone', 'p/slow', 'p/404'], stats);
    expect(plan.planA.steps.join(',')).toBe('p/ok,p/404,p/slow');
    expect(plan.planB.steps.join(',')).toBe('p/ok');
    expect(plan.planA.removed).toBe(1);
    expect(plan.planA.movedToEnd).toBe(1);
  });

  it('dự đoán thời gian tới header theo mô hình N0', () => {
    const stats = buildStats([
      [row('p/ok', 'OK', 500, at(T0)), row('p/gone', 'EOL-GONE', 300, at(T0))],
      [row('p/ok', 'OK', 700, at(T1)), row('p/gone', 'EOL-GONE', 300, at(T1))],
    ]);
    const ms = predictHeaderMs(['p/gone', 'p/ok'], stats);
    expect(typeof ms).toBe('number');
    expect(ms as number).toBeGreaterThan(0);
  });
});

describe('C33 N3.6: chạy thật trên file tạm', () => {
  it('đọc 2 file probe + thứ tự combo giả, ghi kế hoạch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-plan-'));
    try {
      const f1 = join(dir, 'r1.txt');
      const f2 = join(dir, 'r2.txt');
      const line = (m: string, v: string, ms: number) => `${m}\t${v}\thttp=-\ttotal=${ms}ms\tusage=-`;
      writeFileSync(f1, ['bắt đầu=2026-11-21T20:00:00.000Z tổng=2', line('p/ok', 'OK', 300), line('p/gone', 'EOL-GONE', 200)].join('\n'));
      writeFileSync(f2, ['bắt đầu=2026-11-21T20:10:00.000Z tổng=2', line('p/ok', 'OK', 320), line('p/gone', 'EOL-GONE', 220)].join('\n'));
      const out = join(dir, 'plan.json');
      const plan = runCombosPlan({
        from: [f1, f2],
        out,
        readState: () => ({ combos: [{ name: 'c', steps: ['p/ok', 'p/gone'] }], dbPath: join(dir, 'data.sqlite') }),
        log: () => undefined,
      });
      expect(plan.combos).toHaveLength(1);
      expect(plan.counts.REMOVE).toBe(1);
      expect(plan.combos[0]?.planB.steps.join(',')).toBe('p/ok');
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});