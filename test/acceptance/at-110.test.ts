/**
 * test/acceptance/at-110.test.ts
 *
 * Acceptance Test AT-110 (Spec §33.3, Gate L, 2026-10-15):
 *  - Gate L lab results are recorded in docs/adapters/9router.md and
 *    docs/compat-matrix.md with the correct source label (COPY) and OS (Windows).
 *  - The five spec §33.3 questions are answered or marked UNVERIFIED with a reason.
 *  - The D26 9Router policy cap is documented.
 *  - Negative-result honesty: 'kind=custom never reflects' is recorded.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NINE_DOC = path.join(REPO_ROOT, 'docs/adapters/9router.md');
const MATRIX_DOC = path.join(REPO_ROOT, 'docs/compat-matrix.md');

describe('Acceptance Test AT-110: Gate L lab results documented with source label + OS', () => {
  const nineDoc = fs.readFileSync(NINE_DOC, 'utf-8');
  const matrixDoc = fs.readFileSync(MATRIX_DOC, 'utf-8');

  it('9router.md records Gate L with COPY label and Windows OS', () => {
    expect(nineDoc).toContain('Gate L');
    expect(nineDoc).toMatch(/Source label:\s*\*{0,2}COPY/);
    expect(nineDoc).toMatch(/OS:\s*\*{0,2}Windows 11/);
  });

  it('9router.md answers all five spec §33.3 questions', () => {
    // Q1: refresh mechanism observed (kind=null reflects ≤20s without restart)
    expect(nineDoc).toMatch(/appeared on `GET \/v1\/models` within ~20 s/);
    // Q2: after restart still visible
    expect(nineDoc).toMatch(/still listed after restart/);
    // Q3: kind column is the differing column; negative result recorded
    expect(nineDoc).toContain("kind = 'custom'");
    expect(nineDoc).toMatch(/never appeared|never reflect/);
    // Q4: no RAM→DB clobber (row-level writes)
    expect(nineDoc).toMatch(/row-level/);
    // Q5: no reload endpoint; dashboard login UNVERIFIED
    expect(nineDoc).toMatch(/No reload\/refresh route/);
    expect(nineDoc).toMatch(/UNVERIFIED/);
  });

  it('9router.md records written-pending-reload applyState and D26 cap', () => {
    expect(nineDoc).toContain('written-pending-reload');
    expect(nineDoc).toMatch(/policy\.mode.*capped at `manual`\/`shadow`/);
    expect(nineDoc).toContain('D26');
  });

  it('compat-matrix.md records the Gate L finding with label and OS', () => {
    expect(matrixDoc).toMatch(/Gate L, COPY, Windows/);
    expect(matrixDoc).toContain('written-pending-reload');
    expect(matrixDoc).toContain('D26');
  });
});
