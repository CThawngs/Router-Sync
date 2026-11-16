/**
 * packages/cli/src/profile/interview.ts
 * W2 interview questions (VI, 12 items) + answer parser.
 */
import { validateProfile, type Profile } from './schema.js';
import { ZodError } from 'zod';
import { INTERVIEW_QUESTIONS, type InterviewQuestion } from '@routersync/core';

export { INTERVIEW_QUESTIONS };
export type { InterviewQuestion };

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseProfileAnswers(answers: Record<string, string>): { ok: true; profile: Profile } | { ok: false; errors: string[] } {
  const pick = (id: string, fallback: string): string => {
    const v = answers[id];
    return v === undefined || v.trim() === '' ? fallback : v.trim();
  };
  const raw: Record<string, unknown> = {
    purpose: pick('purpose', 'general coding'),
    priority: splitList(pick('priority', 'quality, speed, price, context')),
    freeOnly: pick('freeOnly', 'Y').toLowerCase() !== 'n',
    preferredProviders: splitList(pick('preferredProviders', '')),
    dislikedProviders: splitList(pick('dislikedProviders', '')),
    favorites: splitList(pick('favorites', '')),
    keepHead: Number(pick('keepHead', '0')),
    allowList: splitList(pick('allowList', '')),
    denyList: splitList(pick('denyList', '')),
    automationLevel: pick('automationLevel', 'observe'),
    quotaLimit: (() => { const v = pick('limits', '10, 5+20, 25'); return v; })(),
    scanCycle: pick('scanCycle', 'daily'),
    timezone: pick('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Ho_Chi_Minh'),
  };
  try {
    const profile = validateProfile(raw);
    return { ok: true, profile };
  } catch (e) {
    // D7: một câu tiếng Việt mỗi lỗi, dạng `field: message (bạn nhập <giá trị>)`.
    if (e instanceof ZodError) {
      const errors = e.issues.map((issue) => {
        const field = issue.path.join('.') || 'profile';
        let msg = issue.message;
        if (msg.startsWith(field + ':')) msg = msg.slice(field.length + 1).trim();
        const entered = (raw as Record<string, unknown>)[field];
        const enteredStr = entered !== undefined ? ` (bạn nhập ${JSON.stringify(entered)})` : '';
        const extra = field === 'automationLevel' ? ' Lưu ý: chọn auto-safe chỉ có hiệu lực khi chủ gõ "bật tự động".' : '';
        return `${field}: ${msg}${enteredStr}.${extra}`;
      });
      return { ok: false, errors };
    }
    return { ok: false, errors: [(e as Error).message] };
  }
}
