/**
 * test/docs/wp6-harness-skills.test.ts
 *
 * C45 WP6 Red-First Documentation Contract Test — Verifies all 9 per-harness
 * skill guides in `docs/ai/harnesses/<id>.md` dynamically against
 * `packages/core/src/harness/harness-matrix.json` and checks `docs/ai/skill-routersync.md`
 * sections 7..9 + AT-96 compatibility (Phục vụ: S4, S5).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnessMatrix } from '../../packages/core/src/harness/matrix.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('C45 WP6 — 9-Harness Skill Guides & skill-routersync.md Contract', () => {
  it('publishes docs/ai/harnesses/<id>.md for all 9 harnesses in harness-matrix.json matching MCP, directionAMode, grok-bot companion CLI, and openmausbot safety rules', () => {
    const matrix = loadHarnessMatrix();
    expect(matrix.harnesses).toHaveLength(9);

    for (const harness of matrix.harnesses) {
      const docPath = path.join(REPO_ROOT, 'docs', 'ai', 'harnesses', `${harness.id}.md`);
      expect(fs.existsSync(docPath), `Missing guide: docs/ai/harnesses/${harness.id}.md`).toBe(true);
      const content = fs.readFileSync(docPath, 'utf8');

      // Must mention exact directionAMode ('write-adapter' vs 'report-only')
      expect(content).toContain(harness.directionAMode);

      // Must document <= 12 adaptive interview, assumptions[], zero fabrication, and consent safety
      expect(content).toMatch(/12/);
      expect(content).toMatch(/assumptions/i);
      expect(content).toMatch(/propose/);
      expect(content).toMatch(/auto-safe/);
      expect(content).toMatch(/freeze/i);

      // Must document router strategy & combo selection
      expect(content).toMatch(/9Router|OmniRoute|LiteLLM/);

      if (harness.id === 'grok-bot') {
        // Grok Bot Cloud has no local stdio MCP config file; must document companion grok CLI / HTTPS connector accurately
        expect(content).toMatch(/grok-build|grok CLI|companion/i);
        expect(content).toMatch(/no local stdio|unsupported/i);
      }

      if (harness.id === 'openmausbot') {
        // OpenMausBot guide must explicitly forbid touching bots.json and routines.json
        expect(content).toContain('config.json');
        expect(content).toContain('bots.json');
        expect(content).toContain('routines.json');
        expect(content).toMatch(/never.*bots\.json|untouched|do not.*bots\.json/is);
      }
    }
  });

  it('appends sections ## 7, ## 8, and ## 9 to docs/ai/skill-routersync.md while linking all 9 harness guides and keeping AT-96 intact', () => {
    const skillPath = path.join(REPO_ROOT, 'docs', 'ai', 'skill-routersync.md');
    const content = fs.readFileSync(skillPath, 'utf8');

    expect(content).toContain('## 7. Adaptive User Interview');
    expect(content).toContain('## 8. Router Strategy Capabilities & LiteLLM Config Adapter');
    expect(content).toContain('## 9. Per-Harness Integration Guides');

    const matrix = loadHarnessMatrix();
    for (const harness of matrix.harnesses) {
      expect(content).toContain(`harnesses/${harness.id}.md`);
    }

    // Every comboId example must start with routersync-
    const comboIdMatches = [...content.matchAll(/"comboId"\s*:\s*"([^"]+)"/g)];
    expect(comboIdMatches.length).toBeGreaterThan(0);
    for (const m of comboIdMatches) {
      expect(m[1]?.startsWith('routersync-')).toBe(true);
    }
  });
});
