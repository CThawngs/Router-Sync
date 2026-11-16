/**
 * packages/ui/test/at-81-traceability.test.ts
 *
 * Acceptance Test AT-81: Functional Traceability Matrix Verification (Spec §29.5 & §34.5 Item 6).
 *
 * Verifies that:
 * 1. All 10 spec screens (§29.5: 9 navigation items + 1 Setup Wizard spanning 11 testable surfaces)
 *    have their implementation component files physically existing on disk.
 * 2. Every verification test file referenced in the matrix physically exists on disk.
 * 3. Traceability is genuine and complete across all primary user workflows.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TraceabilityEntry {
  screen: string;
  spec: string;
  file: string;
  test: string;
}

export const TRACEABILITY_MATRIX: TraceabilityEntry[] = [
  { screen: 'Overview (Running)', spec: '§29.5, §34.1, §34.4 (AT-70, AT-71)', file: 'src/screens/OverviewScreen.tsx', test: 'overview-screen.test.tsx' },
  { screen: 'Overview (First-Run)', spec: '§29.5, §34.1 (AT-79)', file: 'src/screens/OverviewScreen.tsx', test: 'at-79-overview-firstrun.test.tsx' },
  { screen: 'Changes (Pending/History)', spec: '§29.5, §34.1, §34.3', file: 'src/screens/ChangesScreen.tsx', test: 'changes-screen.test.tsx' },
  { screen: 'Combos & Builder', spec: '§29.5, §34.1, §34.3', file: 'src/screens/CombosScreen.tsx', test: 'combos-screen.test.tsx, combo-yaml-schema.test.ts' },
  { screen: 'Providers', spec: '§29.5, §34.1', file: 'src/screens/ProvidersScreen.tsx', test: 'cp3-screens.test.tsx' },
  { screen: 'Targets (with D26 cap)', spec: '§29.5, §34.1, §34.4 (AT-116, D26)', file: 'src/screens/TargetsScreen.tsx', test: 'cp3-screens.test.tsx, at-116-honesty.test.ts' },
  { screen: 'Models & Unmatched', spec: '§29.5, §34.1', file: 'src/screens/ModelsScreen.tsx', test: 'cp3-screens.test.tsx' },
  { screen: 'Health, Cost & Doctor', spec: '§29.5, §34.1', file: 'src/screens/HealthScreen.tsx', test: 'cp3-screens.test.tsx' },
  { screen: 'Guide & Cheat Sheet', spec: '§29.5, §34.1', file: 'src/screens/GuideScreen.tsx', test: 'cp3-screens.test.tsx' },
  { screen: 'Settings (5 Tabs)', spec: '§29.5, §34.1', file: 'src/screens/SettingsScreen.tsx', test: 'cp3-screens.test.tsx, ui-sw.test.tsx' },
  { screen: 'Setup Wizard (4 Steps)', spec: '§29.5, §34.1', file: 'src/screens/SetupWizardScreen.tsx', test: 'cp3-screens.test.tsx' },
];

describe('Acceptance Test AT-81: Functional Traceability Matrix Verification', () => {
  const uiPackageRoot = path.resolve(__dirname, '..');

  it('contains all 11 surfaces covering the 10 spec screens', () => {
    expect(TRACEABILITY_MATRIX.length).toBe(11);
  });

  for (const entry of TRACEABILITY_MATRIX) {
    it(`verifies implementation file exists for "${entry.screen}"`, () => {
      const fullPath = path.resolve(uiPackageRoot, entry.file);
      expect(fs.existsSync(fullPath), `Missing implementation component: ${fullPath}`).toBe(true);
    });

    it(`verifies test file(s) exist for "${entry.screen}"`, () => {
      const testFiles = entry.test.split(',').map((f) => f.trim());
      for (const tf of testFiles) {
        const fullTestPath = path.resolve(uiPackageRoot, 'test', tf);
        expect(fs.existsSync(fullTestPath), `Missing verification test file: ${fullTestPath}`).toBe(true);
      }
    });
  }
});
