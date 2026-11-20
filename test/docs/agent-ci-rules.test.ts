import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

describe('C22 Z4: the CI/CD rules exist in AGENTS.md', () => {
  const section = agents.split('## 7. CI/CD: definition of done')[1]?.split('## 8.')[0] ?? '';

  it('has a CI/CD section with all eight rules', () => {
    expect(section).not.toBe('');
    for (let i = 1; i <= 8; i += 1) {
      expect(section).toMatch(new RegExp(`^${i}\\. `, 'm'));
    }
  });

  it('mentions prepush before pushing', () => {
    expect(section).toContain('pnpm prepush');
  });

  it('mentions ci-watch and the rerun rule', () => {
    expect(section).toContain('ci-watch.mjs');
    expect(section).toContain('--failed');
  });

  it('forbids weakening CI to get green', () => {
    expect(section).toContain('continue-on-error');
    expect(section).toContain('build-budgets.mjs');
  });

  it('requires five OS before merge and a squash title that matches', () => {
    expect(section).toContain('five OS');
    expect(section.toLowerCase()).toContain('squash title');
  });

  it('keeps the actions node24 rule', () => {
    expect(section).toContain('runs.using');
  });

  it('keeps the CI section of every REPORT', () => {
    expect(section).toContain('first-attempt green rate');
  });
});