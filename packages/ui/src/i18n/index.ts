import { useState, useEffect } from 'react';
import translationsData from './translations.json';

export type Language = 'vi' | 'en';

type TranslationsMap = Record<string, string>;
interface Translations {
  vi: TranslationsMap;
  en: TranslationsMap;
}

const data = translationsData as unknown as Translations;

const STORAGE_KEY = 'routersync_ui_lang';

let currentLang: Language = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'vi' || saved === 'en') {
      return saved;
    }
  } catch {}
  return 'vi';
})();

const listeners = new Set<(lang: Language) => void>();

/**
 * AT-147 (R16-2.8): runtime i18n honesty.
 *
 * `t()` used to fall back to the raw key text without a trace, so a broken
 * translation looked exactly like a working screen. Every key that reaches the
 * raw-key fallback is recorded here, which lets a test assert "no key was
 * missing" instead of "no key looked wrong".
 *
 * Module-level `Set`: `t()` runs during the render of every screen, so the
 * recorder must not hold React state and must not allocate per call. The set is
 * bounded by the number of distinct translation keys, and `resetMissingI18nKeys()`
 * clears it between test cases.
 */
const missingI18nKeys = new Set<string>();

/** Clears the recorded missing-key set. */
export function resetMissingI18nKeys(): void {
  missingI18nKeys.clear();
}

/** Sorted, unique list of the keys `t()` could not resolve. */
export function getMissingI18nKeys(): string[] {
  return Array.from(missingI18nKeys).sort();
}

/**
 * True when the key resolves in Vietnamese or in English.
 *
 * Language-independent by design: it answers "is this key translated at all?",
 * while the recorder answers "did the raw-key fallback happen at runtime?".
 */
export function hasTranslation(key: string): boolean {
  return Boolean(data.vi[key]) || Boolean(data.en[key]);
}

export function getLanguage(): Language {
  return currentLang;
}

export function setLanguage(lang: Language): void {
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
  document.documentElement.lang = lang;
  listeners.forEach((listener) => listener(lang));
}

export function t(key: string, placeholders?: Record<string, string | number>): string {
  const dict = data[currentLang] || data.vi;
  const resolved = dict[key] || data.en[key];
  if (!resolved) {
    // AT-147: the key is absent from the current language AND from English,
    // so `t()` returns the raw key text. Record it — the return value below
    // stays exactly what it always was.
    missingI18nKeys.add(key);
  }
  let text = resolved || key;
  if (placeholders) {
    for (const [pKey, pVal] of Object.entries(placeholders)) {
      text = text.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(pVal));
    }
  }
  return text;
}

export function useLanguage(): [Language, (lang: Language) => void] {
  const [lang, setLang] = useState<Language>(currentLang);

  useEffect(() => {
    const handler = (newLang: Language) => setLang(newLang);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return [lang, setLanguage];
}

export function useI18n() {
  const [lang, setLang] = useLanguage();
  return { lang, setLang, t };
}

