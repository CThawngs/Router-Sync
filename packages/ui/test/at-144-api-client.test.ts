import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '../src/api';
import { HttpApi } from '../src/api/http';
import { MockApi } from '../src/api/mock';

/**
 * AT-144 - R16-1: the UI must pick the API client from `VITE_API`.
 *
 * Two failures are covered:
 *  1. STATIC: `import.meta?.env` / `import.meta ?.env` anywhere under
 *     packages/ui/src — Vite's `vite:define` plugin only replaces the plain
 *     `import.meta.env` expression, so the optional-chaining form never
 *     reaches the bundle and `VITE_API` never arrives.
 *  2. RUNTIME: with `VITE_API=http` the client must be `HttpApi`; without the
 *     variable it must be `MockApi`.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, '..', 'src');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('AT-144: API client selection from VITE_API', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no file under packages/ui/src uses optional chaining on import.meta', () => {
    const files = listFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      content.split(/\r?\n/).forEach((raw, index) => {
        if (raw.includes('import.meta?.') || raw.includes('import.meta ?.')) {
          violations.push(
            `${path.relative(srcDir, file)}:${index + 1} -> ${raw.trim()}`
          );
        }
      });
    }

    expect(
      violations,
      `import.meta must be written exactly as "import.meta.env" (Vite replaces only that form):\n${violations.join('\n')}`
    ).toEqual([]);
  });

  it('picks HttpApi when VITE_API=http', () => {
    vi.stubEnv('VITE_API', 'http');
    const api = createApiClient();
    expect(api).toBeInstanceOf(HttpApi);
    expect(api.isMock()).toBe(false);
  });

  it('picks MockApi when VITE_API is not set', () => {
    vi.stubEnv('VITE_API', undefined);
    const api = createApiClient();
    expect(api).toBeInstanceOf(MockApi);
    expect(api.isMock()).toBe(true);
  });

  it('picks MockApi for any other VITE_API value', () => {
    vi.stubEnv('VITE_API', 'mock');
    expect(createApiClient()).toBeInstanceOf(MockApi);
  });
});
