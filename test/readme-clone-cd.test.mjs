import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function repoNameFromUrl(url) {
  const clean = url.trim().replace(/[\s"'`]+$/, '');
  const last = clean.split('/').filter(Boolean).at(-1) ?? '';
  return last.replace(/\.git$/i, '');
}

/** Mọi cặp `git clone <url>` / `cd <dir>` trong cùng một khối lệnh phải khớp tên repo. */
export function extractCloneCdPairs(markdown) {
  const pairs = [];
  for (const block of markdown.matchAll(/```[^\n]*\r?\n([\s\S]*?)```/g)) {
    const lines = block[1].split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
    for (let i = 0; i < lines.length - 1; i++) {
      const clone = lines[i].match(/^git\s+clone\s+(\S+)/);
      if (!clone) continue;
      const cd = lines[i + 1].match(/^cd\s+(\S+)/);
      if (cd) pairs.push({ url: clone[1], dir: cd[1] });
    }
  }
  return pairs;
}

describe('README quickstart clone/cd consistency', () => {
  it('every cd after git clone matches the repository name from the URL', () => {
    const pairs = extractCloneCdPairs(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.dir, `${pair.url} -> ${pair.dir}`).toBe(repoNameFromUrl(pair.url));
    }
  });
});
