import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../src/profile/schema.js';
import { INTERVIEW_QUESTIONS, parseProfileAnswers } from '../src/profile/interview.js';

describe('C2b B5 profile validator (3 sai + hint)', () => {
  it('reject priority strange value', () => {
    expect(() => validateProfile({ priority: ['quality', 'weird'] })).toThrow(/priority/i);
  });

  it('reject negative keepHead', () => {
    expect(() => validateProfile({ keepHead: -1 })).toThrow(/keepHead/i);
  });

  it('reject duplicate favorites', () => {
    expect(() => validateProfile({ favorites: ['a', 'a'] })).toThrow(/trùng lặp|favorites/i);
  });

  it('accept valid profile', () => {
    const p = validateProfile({
      priority: ['speed', 'quality'],
      favorites: ['a', 'b'],
      scanCycle: 'daily',
    });
    expect(p.priority).toEqual(['speed', 'quality']);
    expect(p.scanCycle).toBe('daily');
  });

  it('reject duplicate allowList/denyList via same rule', () => {
    expect(() => validateProfile({ allowList: ['x', 'x'] })).toThrow(/trùng lặp|allowList/i);
    expect(() => validateProfile({ denyList: ['x', 'x'] })).toThrow(/trùng lặp|denyList/i);
  });
});

describe('C2b B5 interview', () => {
  it('<=12 questions (R5 C3c), includes scanCycle + limits remove/add/move', () => {
    expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(12);
    expect(INTERVIEW_QUESTIONS.map((q) => q.id)).toContain('scanCycle');
    const quota = INTERVIEW_QUESTIONS.find((q) => q.id === 'limits');
    expect(quota?.prompt).toMatch(/remove\/add\/move|gỡ|thêm/i);
  });

  it('default timezone from Intl, not fixed', () => {
    const tz = INTERVIEW_QUESTIONS.find((q) => q.id === 'timezone');
    expect(tz?.default).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('parseProfileAnswers accepts scanCycle', () => {
    const r = parseProfileAnswers({ scanCycle: 'weekly' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.scanCycle).toBe('weekly');
  });
});

describe('C2b B5 zero.yaml de-PIIed ranking policy', () => {
  it('zero.yaml differs from policy.default.yaml and has tierWeights', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const zero = fs.readFileSync(path.join(here, '../../../examples/policies/zero.yaml'), 'utf8');
    const def = fs.readFileSync(
      path.join(here, '../src/profile/policy.default.yaml'),
      'utf8'
    );
    expect(zero).not.toBe(def);
    expect(zero).toMatch(/tierWeights/);
  });
});
