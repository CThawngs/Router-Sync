import { describe, expect, it } from 'vitest';

const mod = await import(new URL('../../vitest.config.ts', import.meta.url));
const cfg = mod.default;

// Effective hookTimeout: project value wins; `extends: true` inherits the root;
// otherwise the vitest default of 10000 applies.
function effectiveHook(t) {
  if (t.hookTimeout !== undefined) return t.hookTimeout;
  if (t.extends === true) return cfg.test.hookTimeout;
  return 10000;
}

describe('C27 E0: effective vitest hook timeouts', () => {
  const projects = cfg.test.projects ?? [];
  it('projects cover root-tools, packages and ui', () => {
    const names = projects.map((p) => p.test?.name);
    expect(names).toContain('root-tools');
    expect(names).toContain('packages');
    expect(names).toContain('ui');
  });
  for (const proj of projects.filter((p) => p.test?.name !== 'e2e')) {
    const t = proj.test ?? {};
    it(`project ${t.name} has effective hookTimeout >= 30000`, () => {
      expect(effectiveHook(t)).toBeGreaterThanOrEqual(30000);
    });
  }
});
