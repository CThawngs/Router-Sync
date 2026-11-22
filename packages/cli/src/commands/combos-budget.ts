/**
 * packages/cli/src/commands/combos-budget.ts
 *
 * C40 X0: quota-aware probing helpers — pure functions plus a small counter.
 * No router writes, no secrets. Every branch is pinned by a test.
 */

/** Mã/lỗi cho thấy đã chạm quota gói miễn phí, không phải lỗi model. */
export const QUOTA_RE = /FreeUsageLimitError|free usage limit|insufficient_quota|quota|rate.?limit.*free/i;

export const DEFAULT_REQUEST_BUDGET = 40;
export const PROVIDER_GAP_MS = 3_000;
export const MAX_CONSECUTIVE_SAME_PROVIDER = 3;

export function providerOf(step: string): string {
  return step.split('/')[0] ?? '(unknown)';
}

export function isQuotaBody(body: string): boolean {
  return QUOTA_RE.test(body);
}

/** RATE-LIMITED do quota được gắn chú thích "quota" để phân biệt 429 thường. */
export function classifyStep(input: { verdict: string; body?: string }): { verdict: string; quota: boolean } {
  const quota = input.verdict === 'RATE-LIMITED' && isQuotaBody(input.body ?? '');
  return { verdict: input.verdict, quota };
}

/**
 * Xen kẽ provider: cứ mỗi provider một bước cho tới hết. Kết quả không có quá
 * 3 bước liên tiếp cùng provider (trừ khi danh sách chỉ có đúng một provider).
 */
export function interleaveProviders(steps: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const step of steps) {
    const provider = providerOf(step);
    const list = groups.get(provider) ?? [];
    list.push(step);
    groups.set(provider, list);
  }
  const out: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const list of groups.values()) {
      const next = list.shift();
      if (next !== undefined) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}

export function maxConsecutiveSameProvider(steps: string[]): number {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const step of steps) {
    const provider = providerOf(step);
    run = provider === previous ? run + 1 : 1;
    previous = provider;
    if (run > best) best = run;
  }
  return best;
}

/** Đếm request đã gửi, chia theo provider; từ chối khi vượt ngân sách. */
export class RequestBudget {
  readonly limit: number;
  private used = 0;
  private readonly byProvider = new Map<string, number>();

  constructor(limit = DEFAULT_REQUEST_BUDGET) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  get count(): number {
    return this.used;
  }

  reserve(provider: string): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    this.byProvider.set(provider, (this.byProvider.get(provider) ?? 0) + 1);
    return true;
  }

  /** Các bước sẽ không kịp gửi vì đã hết ngân sách. */
  unmeasured(steps: string[], startIndex: number): string[] {
    return steps.slice(Math.max(0, startIndex));
  }

  tally(): string {
    const parts = [...this.byProvider.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([p, n]) => `${p}:${n}`);
    return `requests=${this.used}/${this.limit} theo provider=${parts.join(',') || '(none)'}`;
  }
}

/** Bước đã trả 429/quota trong cửa sổ gần đây thì bỏ qua, không tính là lỗi mới. */
export function recentQuotaSteps(text: string, nowMs: number, windowMs = 30 * 60_000): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split('\t');
    if (p.length < 3) continue;
    if (p[1] !== 'RATE-LIMITED') continue;
    if (!p.some((x) => x === 'quota=1' || x.includes('FreeUsageLimitError'))) continue;
    const step = p[0];
    if (!step || !step.includes('/')) continue;
    const stamp = p.find((x) => x.startsWith('at='))?.slice(3);
    const at = stamp ? Date.parse(stamp) : nowMs;
    if (Number.isFinite(at) && nowMs - at > windowMs) continue;
    if (!out.includes(step)) out.push(step);
  }
  return out;
}

/** Chờ đủ 3 giây giữa hai request liên tiếp tới cùng một provider. */
export function providerDelayMs(
  lastProvider: string | null,
  provider: string,
  lastAtMs: number | null,
  nowMs: number,
  gapMs = PROVIDER_GAP_MS
): number {
  if (lastProvider === null || lastProvider !== provider || lastAtMs === null) return 0;
  return Math.max(0, gapMs - (nowMs - lastAtMs));
}
