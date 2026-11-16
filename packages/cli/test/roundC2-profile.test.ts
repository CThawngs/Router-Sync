import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileSchema, validateProfile, DEFAULT_PROFILE } from '../src/profile/schema.js';
import { INTERVIEW_QUESTIONS } from '../src/profile/interview.js';

describe('W2 profile validator', () => {
  it('accepts DEFAULT_PROFILE', () => {
    expect(() => ProfileSchema.parse(DEFAULT_PROFILE)).not.toThrow();
    expect(validateProfile({}).freeOnly).toBe(true);
  });
  it('rejects bad automationLevel', () => {
    expect(() => validateProfile({ automationLevel: 'auto' })).toThrow();
  });
  it('rejects bad keepHead negative', () => {
    expect(() => validateProfile({ keepHead: -1 })).toThrow();
  });
  it('accepts favorites from prompt with keepHead 7', () => {
    const p = validateProfile({
      favorites: ['crouton-alpha', 'pulse-alpha', 'claude-sonnet-5-5', 'claude-sonnet-4-6'],
      keepHead: 7,
    });
    expect(p.favorites).toContain('crouton-alpha');
    expect(p.keepHead).toBe(7);
  });
  it('quotaLimit accepts 2.5', () => {
    expect(validateProfile({ quotaLimit: 2.5 }).quotaLimit).toBe(2.5);
  });
});

describe('W2 interview', () => {
  it('has 12 questions each with default (R5 C3c: favorites merged, limits replaces quotaLimit)', () => {
    expect(INTERVIEW_QUESTIONS).toHaveLength(12);
    for (const q of INTERVIEW_QUESTIONS) {
      expect(q.id).toBeTruthy();
      expect(q.prompt).toBeTruthy();
      expect(q.default).toBeDefined();
    }
  });
});

describe('W2 example yaml no secrets', () => {
  it('example yaml exists and is clean', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const files = [path.join(root, 'examples', 'policies', 'zero.yaml'), path.join(root, 'packages', 'cli', 'src', 'profile', 'policy.default.yaml')];
    for (const f of files) {
      expect(fs.existsSync(f), f).toBe(true);
      const c = fs.readFileSync(f, 'utf8');
      expect(c).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
      expect(c).not.toMatch(/C:\\Users/);
      expect(c).not.toMatch(/sk-/);
    }
  });
});
