/**
 * test/docs/c45-wp9-live-readiness.test.ts
 *
 * C45-WP9 (`Phục vụ: S9`) — Red-First contract suite for:
 *  - `docs/runbook/LIVE-E2E-v2.md` (6 sections, 5 measurable S9 criteria, owner cutover steps)
 *  - Additive preservation of legacy `docs/runbook/LIVE-E2E.md`
 *  - Enrollment in `test/docs/agent-docs.test.ts` and cross-links in `docs/RELEASE-CANDIDATE.md` & `docs/WORKFLOW.md`
 *  - K6.2 git safety scan & workspace `0.1.0` version lock
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readRel(...parts: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
}

function existsRel(...parts: string[]): boolean {
  return fs.existsSync(path.join(REPO_ROOT, ...parts));
}

describe('C45-WP9: docs/runbook/LIVE-E2E-v2.md & enrolled docs readiness (Phục vụ: S9)', () => {
  it('preserves legacy docs/runbook/LIVE-E2E.md untouched and provides docs/runbook/LIVE-E2E-v2.md', () => {
    expect(existsRel('docs', 'runbook', 'LIVE-E2E.md')).toBe(true);
    expect(existsRel('docs', 'runbook', 'LIVE-E2E-v2.md')).toBe(true);

    const legacy = readRel('docs', 'runbook', 'LIVE-E2E.md');
    expect(legacy).toContain('LIVE-E2E');
    expect(legacy).toContain('maintain authorize');
  });

  it('documents Phục vụ: S9, owner-only hard-stop banner, 6 sections, and all 5 measurable S9 criteria', () => {
    const runbook = readRel('docs', 'runbook', 'LIVE-E2E-v2.md');

    expect(runbook).toContain('Phục vụ: S9');
    expect(runbook).toContain('sẵn sàng chạy thật');
    expect(runbook).toContain('READY_FOR_OWNER_LIVE_PILOT');
    expect(runbook).toContain('routines.json');

    // Core WP9 / WP4 / WP7 / WP8 CLI & release commands
    const requiredSnippets = [
      'routersync doctor --json',
      'routersync live-check',
      'routersync consent grant',
      'routersync plan',
      'routersync tick',
      'routersync freeze',
      'routersync unfreeze',
      'routersync rollback',
      'routersync apps rollback',
      'tools/release/prepare-v1-release.mjs',
      '1.0.0-rc.1',
      '1.0.0',
      'git push origin v1.0.0-rc.1',
      'git push origin v1.0.0',
    ];
    for (const snippet of requiredSnippets) {
      expect(runbook, `Missing required snippet in LIVE-E2E-v2.md: ${snippet}`).toContain(snippet);
    }

    // All 5 measurable S9 pass criteria
    const measurableCriteria = [
      'falseRemovals',
      'rollbackByteExactMatch',
      'detectionLatencyMs',
      'tier0Tokens',
      'unplannedManualInterventions',
    ];
    for (const criterion of measurableCriteria) {
      expect(runbook, `Missing measurable S9 criterion: ${criterion}`).toContain(criterion);
    }

    // K6.2 forbidden git strings must never appear in LIVE-E2E-v2.md
    const forbidden = [
      ['push origin', 'master'].join(' '),
      ['--', 'tags'].join(''),
      ['git push', '--all'].join(' '),
    ];
    for (const bad of forbidden) {
      expect(runbook).not.toContain(bad);
    }
  });

  it('enrolls LIVE-E2E-v2.md and schedule-ladder.md in agent-docs.test.ts and cross-links from RELEASE-CANDIDATE.md & WORKFLOW.md', () => {
    const agentDocsTest = readRel('test', 'docs', 'agent-docs.test.ts');
    expect(agentDocsTest).toContain("'docs/runbook/LIVE-E2E-v2.md'");
    expect(agentDocsTest).toContain("'docs/schedule-ladder.md'");

    const releaseCandidate = readRel('docs', 'RELEASE-CANDIDATE.md');
    expect(releaseCandidate).toContain('docs/runbook/LIVE-E2E-v2.md');
    expect(releaseCandidate).toContain('routersync live-check');

    const workflow = readRel('docs', 'WORKFLOW.md');
    expect(workflow).toContain('docs/runbook/LIVE-E2E-v2.md');
    expect(workflow).toContain('routersync live-check');
  });

  it('keeps workspace package.json versions locked at 0.1.0 prior to owner release cutover', () => {
    const cliPkg = JSON.parse(readRel('packages', 'cli', 'package.json')) as { version: string };
    const corePkg = JSON.parse(readRel('packages', 'core', 'package.json')) as { version: string };
    expect(cliPkg.version).toBe('0.1.0');
    expect(corePkg.version).toBe('0.1.0');
  });
});
