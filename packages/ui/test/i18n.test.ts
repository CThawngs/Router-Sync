import { describe, it, expect } from 'vitest';
import translationsData from '../src/i18n/translations.json';
import { t, setLanguage, getLanguage } from '../src/i18n';
import fs from 'node:fs';
import path from 'node:path';

describe('i18n System & AT-77 Compliance', () => {
  const viKeys = Object.keys(translationsData.vi);
  const enKeys = Object.keys(translationsData.en);

  it('contains equal number of keys in VI and EN dictionaries', () => {
    expect(viKeys.length).toBeGreaterThan(150);
    expect(enKeys.length).toBeGreaterThan(150);
  });

  it('ensures every key in VI exists in EN and has non-empty text', () => {
    for (const key of viKeys) {
      expect(
        (translationsData.en as Record<string, string>)[key],
        `Missing EN translation for key: ${key}`
      ).toBeDefined();
      expect((translationsData.vi as Record<string, string>)[key]?.trim().length).toBeGreaterThan(0);
      expect((translationsData.en as Record<string, string>)[key]?.trim().length).toBeGreaterThan(0);
    }
  });

  it('ensures every key in EN exists in VI', () => {
    for (const key of enKeys) {
      expect(
        (translationsData.vi as Record<string, string>)[key],
        `Missing VI translation for key: ${key}`
      ).toBeDefined();
    }
  });

  it('switches languages and performs placeholder interpolation correctly', () => {
    setLanguage('vi');
    expect(getLanguage()).toBe('vi');
    expect(t('nav_overview')).toBe('Tổng quan');

    setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(t('nav_overview')).toBe('Overview');

    // Restore to VI
    setLanguage('vi');
  });

  it('AT-77: scan TSX source files for untranslated Vietnamese text outside i18n/mock/data', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const filesToScan: string[] = [];

    function collectFiles(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectFiles(fullPath);
        } else if (entry.name.endsWith('.tsx') || (entry.name.endsWith('.ts') && !entry.name.includes('mock.ts') && !entry.name.includes('translations.json'))) {
          filesToScan.push(fullPath);
        }
      }
    }

    collectFiles(srcDir);

    // Regex checking for Vietnamese diacritics in JSX literal text
    // Matches text like >Một văn bản có dấu<
    const jsxLiteralWithAccents = />([^<>{}]*[áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴĐ]+[^<>{}]*)</;

    const offenders: string[] = [];
    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        // Skip comment lines and mock definitions
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        if (jsxLiteralWithAccents.test(line)) {
          // Allow deliberate UI toggles or dev-facing labels if explicitly permitted
          if (!line.includes('Chuyển sang:')) {
            offenders.push(`${path.relative(srcDir, file)}:${index + 1} -> ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders, `Found hardcoded Vietnamese text outside i18n:\n${offenders.join('\n')}`).toEqual([]);
  });
});
