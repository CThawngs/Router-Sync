/**
 * test/acceptance/at-134-doctor-overview-i18n.test.ts
 *
 * Acceptance Test AT-134: Static audit ensuring all daemon handler codes have i18n keys (R13-1.4).
 *
 * Scans all packages/daemon/src/handlers/*.ts for `code: '...'` and verifies that every emitted
 * code exists in packages/ui/src/i18n/translations.json for both Vietnamese ('vi') and English ('en').
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Acceptance Test AT-134: Daemon handler codes i18n mapping audit (R13-1.4)', () => {
  it('every code emitted by daemon handlers exists in translations.json for vi and en', () => {
    const handlersDir = path.resolve(process.cwd(), 'packages/daemon/src/handlers');
    expect(fs.existsSync(handlersDir)).toBe(true);

    const handlerFiles = fs
      .readdirSync(handlersDir)
      .filter((f) => f.endsWith('.ts'));

    const emittedCodes = new Set<string>();

    const codeRegex = /code:\s*['"]([a-zA-Z0-9_]+)['"]/g;
    for (const file of handlerFiles) {
      const filePath = path.join(handlersDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = codeRegex.exec(content)) !== null) {
        if (match[1]) {
          emittedCodes.add(match[1]);
        }
      }
    }

    expect(emittedCodes.size).toBeGreaterThan(0);

    const translationsPath = path.resolve(process.cwd(), 'packages/ui/src/i18n/translations.json');
    expect(fs.existsSync(translationsPath)).toBe(true);

    const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8')) as {
      vi: Record<string, string>;
      en: Record<string, string>;
    };

    const missingVi: string[] = [];
    const missingEn: string[] = [];

    for (const code of emittedCodes) {
      if (!translations.vi[code]) {
        missingVi.push(code);
      }
      if (!translations.en[code]) {
        missingEn.push(code);
      }
    }

    expect(
      missingVi,
      `Handler codes missing from translations.json [vi]: ${missingVi.join(', ')}`
    ).toEqual([]);

    expect(
      missingEn,
      `Handler codes missing from translations.json [en]: ${missingEn.join(', ')}`
    ).toEqual([]);
  });
});
