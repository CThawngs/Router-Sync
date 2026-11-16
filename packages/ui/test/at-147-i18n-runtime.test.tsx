import React from 'react';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, waitFor, cleanup, within, screen } from '@testing-library/react';
import { App } from '../src/App';
import { ApiProvider } from '../src/api';
import { MockApi } from '../src/api/mock';
import type { ApiClient } from '../src/api/client';
import type { ScreenId } from '../src/components/Sidebar';
import { setViewMode } from '../src/theme/viewMode';
import { formatClock } from '../src/utils/time';
import {
  t,
  setLanguage,
  resetMissingI18nKeys,
  getMissingI18nKeys,
  hasTranslation,
  type Language,
} from '../src/i18n';

/**
 * AT-147 (R16-2.8): runtime i18n honesty.
 *
 * (a) `t()` records every key it could not resolve.
 * (b) rendering every route in VI and in EN must leave the recorded set empty.
 * (c) in EN the rendered DOM must not contain Vietnamese diacritics.
 *
 * The test drives the real `<App>` through the real sidebar, so it fails when
 * a screen asks for a key that no dictionary has — not when a string merely
 * "looks wrong".
 */

type ViewMode = 'simple' | 'detail';

/**
 * Vietnamese-specific diacritics.
 *
 *  - U+1EA0–U+1EF9 — the tone-marked Latin letters (ả ẳ ẵ ặ ầ ấ ẩ ẫ ậ ẹ ẻ ẽ
 *    ế ề ể ễ ệ ỉ ị ọ ỏ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ụ ủ ứ ử ữ ự ỳ ỵ ỷ ỹ) and the
 *    tone-marked ơ/ư forms.
 *  - U+0102/U+0103 — Ă/ă (a with breve).
 *  - U+0110/U+0111 — Đ/đ (D with stroke).
 *  - U+01A0/U+01A1 — Ơ/ơ (O with horn).
 *  - U+01AF/U+01B0 — Ư/ư (U with horn).
 *  - U+00C0–U+00C3, U+00E0–U+00E3, U+00DD, U+00FD — À Á Â Ã Ý / à á â ã ý:
 *    the plain Latin-1 base letters the spec enumerates as Vietnamese.
 *
 * Deliberately NOT flagged: the remaining plain Latin-1 letters (é è ê ì í ò ó
 * ô õ ù ú ü ö ä ñ ç å ø æ ß). They belong to other languages, so a bare
 * "Müller" or "café" inside a product name is not a Vietnamese sentence. Every
 * real Vietnamese sentence still contains at least one character of the set
 * above (ơ ư đ ă â or a tone mark), so no Vietnamese sentence slips through.
 */
const VN_DIACRITIC_RE = /[\u1EA0-\u1EF9\u0102\u0103\u0110\u0111\u01A0\u01A1\u01AF\u01B0\u00C0-\u00C3\u00E0-\u00E3\u00DD\u00FD]/g;

/**
 * Language-independent tokens that may legitimately carry a diacritic
 * (product names, router/host names, file paths). Only WHOLE TOKENS are
 * masked — never a character class — so a Vietnamese sentence is still caught.
 *
 * "Tiếng Việt" is the ENDONYM of the language: a language picker shows each
 * language in its own name in every UI language (like "Deutsch" in a German
 * picker), so it is a proper name, not an untranslated sentence.
 */
const ALLOWED_TOKENS: readonly string[] = [
  'RouterSync', // product name
  'OmniRoute', // router product
  '9Router', // router product
  'OpenCode', // agent app
  'Hermes', // agent app
  'DeepSeek', // model vendor
  'localhost:20128', // 9Router default address
  'localhost:30128', // OmniRoute default address
  '~/.config/opencode/opencode.json', // agent config path
  'Tiếng Việt', // endonym of the Vietnamese language (language picker)
];

/**
 * Replaces every allowed token with spaces of the same length, so the offsets
 * of the remaining text (and therefore the reported snippets) stay exact.
 */
function maskAllowedTokens(text: string): string {
  let out = text;
  for (const token of ALLOWED_TOKENS) {
    out = out.split(token).join(' '.repeat(token.length));
  }
  return out;
}

/**
 * Returns the distinct Vietnamese diacritic characters found in `text`.
 */
function findDiacriticChars(text: string): string[] {
  const matches = maskAllowedTokens(text).match(VN_DIACRITIC_RE);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Returns up to `max` text snippets around the Vietnamese diacritics, so a
 * failing assertion points at the sentence that has to be translated.
 */
function findDiacriticSnippets(text: string, max = 6): string[] {
  const masked = maskAllowedTokens(text);
  const scanner = new RegExp(VN_DIACRITIC_RE.source, 'g');
  const snippets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(masked)) !== null) {
    const start = Math.max(0, match.index - 45);
    const end = Math.min(masked.length, match.index + match[0].length + 45);
    snippets.push(text.slice(start, end).replace(/\s+/g, ' ').trim());
    if (snippets.length >= max) break;
  }
  return snippets;
}

/**
 * Walks the rendered DOM and returns every distinct TEXT NODE that carries a
 * Vietnamese diacritic. Per text node (instead of per page) the report names
 * the exact string that has to be translated.
 */
function findDiacriticTextNodes(root: HTMLElement): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const raw = node.nodeValue ?? '';
    if (raw.trim().length > 0 && findDiacriticChars(raw).length > 0) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!seen.has(text)) {
        seen.add(text);
        found.push(text);
      }
    }
    node = walker.nextNode();
  }
  return found;
}

/** Sidebar label key per screen. `setup` has no sidebar entry (see openScreen). */
const NAV_KEYS: Partial<Record<ScreenId, string>> = {
  overview: 'nav_overview',
  changes: 'nav_changes',
  combos: 'nav_combos',
  providers: 'nav_providers',
  targets: 'nav_targets',
  models: 'nav_models',
  health: 'nav_health',
  agents: 'nav_agents',
  guide: 'nav_guide',
  settings: 'nav_settings',
};

/**
 * A marker that only exists once the screen finished loading its data, so the
 * test never asserts on a half-rendered screen.
 */
const READY_SELECTOR: Record<ScreenId, string> = {
  overview: '[data-testid="metric-tile"]',
  changes: '[data-testid="change-action-act1"]',
  combos: '[data-testid="combo-ladder"]',
  providers: '[data-testid="provider-card-acme"]',
  targets: '[data-testid="target-card-omniroute"]',
  models: '[data-testid="model-row-kite-code-3"]',
  health: '[data-testid="doctor-row-c1"]',
  agents: '[data-testid="agents-screen"]',
  guide: '[data-testid="guide-screen"]',
  settings: '[data-testid="settings-screen"]',
  setup: '[data-testid="wizard-step-1"]',
};

const ALL_SCREENS: readonly ScreenId[] = [
  'overview',
  'changes',
  'combos',
  'providers',
  'targets',
  'models',
  'health',
  'agents',
  'guide',
  'settings',
  'setup',
];

/**
 * The overview shows its technical pipeline only in the detail view, so the
 * ready marker differs per view mode.
 */
function readySelector(id: ScreenId, viewMode: ViewMode): string {
  if (id === 'overview' && viewMode === 'detail') {
    return '[data-testid="pipeline-module-m1"]';
  }
  return READY_SELECTOR[id];
}

/** Finds the sidebar button carrying the given translated label. */
function navButton(container: HTMLElement, label: string): HTMLElement {
  const nav = within(container).getByRole('navigation');
  const buttons = within(nav).getAllByRole('button');
  const found = buttons.find((button) => {
    const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text === label) return true;
    // The "changes" entry carries a badge right after its label ("Changes5").
    return text.startsWith(label) && /^\d+$/.test(text.slice(label.length).trim());
  });
  if (!found) {
    const labels = buttons.map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
    throw new Error(`Sidebar has no button labelled "${label}". Found: ${labels.join(' | ')}`);
  }
  return found;
}

/** Clicks the sidebar entry of a screen and waits until the screen is ready. */
async function openScreen(
  container: HTMLElement,
  id: ScreenId,
  viewMode: ViewMode
): Promise<void> {
  const key = NAV_KEYS[id];
  if (key === undefined) {
    // The setup wizard has no sidebar entry: it is reached from the guide.
    await openScreen(container, 'guide', viewMode);
    fireEvent.click(within(container).getByRole('button', { name: t('g_open') }));
  } else {
    const button = navButton(container, t(key));
    fireEvent.click(button);
    expect(button.getAttribute('aria-current'), `sidebar entry "${id}" is not active`).toBe('page');
  }
  const marker = readySelector(id, viewMode);
  await waitFor(
    () => {
      expect(
        container.querySelector(marker),
        `screen "${id}" did not render its ready marker ${marker}`
      ).not.toBeNull();
    },
    { timeout: 3000 }
  );
}

/**
 * Renders the whole app on the sample API client and waits until the shell is
 * up: the app loads its overview asynchronously and shows a loading screen
 * until that promise settles.
 */
async function renderApp(viewMode: ViewMode): Promise<{ container: HTMLElement }> {
  setViewMode(viewMode);
  const api = new MockApi();
  const result = render(
    <ApiProvider value={api}>
      <App />
    </ApiProvider>
  );
  await waitFor(
    () => {
      expect(
        within(result.container).getByRole('navigation'),
        'the app shell did not render'
      ).toBeTruthy();
    },
    { timeout: 5000 }
  );
  return result;
}

afterEach(() => {
  cleanup();
  setLanguage('vi');
  setViewMode('simple');
});

/**
 * jsdom does not implement `window.matchMedia`; the shell asks for the
 * prefers-color-scheme on every render. Same stub as at-78-theme.test.ts.
 */
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

describe('AT-147: runtime i18n honesty', () => {
  describe('(b) every route renders without a missing translation key', () => {
    const languages: readonly Language[] = ['vi', 'en'];
    const viewModes: readonly ViewMode[] = ['simple', 'detail'];

    for (const lang of languages) {
      for (const viewMode of viewModes) {
        it(
          `records no missing key while visiting every screen in ${lang.toUpperCase()} (${viewMode} view)`,
          async () => {
            resetMissingI18nKeys();
            setLanguage(lang);

            const { container } = await renderApp(viewMode);

            for (const id of ALL_SCREENS) {
              await openScreen(container, id, viewMode);
            }

            const missing = getMissingI18nKeys();
            expect(
              missing,
              `Missing i18n keys while rendering every screen in ${lang.toUpperCase()} (${viewMode} view):\n` +
                missing.map((key) => `  - ${key}`).join('\n')
            ).toEqual([]);
          },
          60000
        );
      }
    }
  });

  describe('(c) the EN DOM contains no Vietnamese diacritics', () => {
    const viewModes: readonly ViewMode[] = ['simple', 'detail'];

    for (const viewMode of viewModes) {
      it(
        `renders every screen in EN without a single Vietnamese diacritic (${viewMode} view)`,
        async () => {
          resetMissingI18nKeys();
          setLanguage('en');

          const { container } = await renderApp(viewMode);

          const violations: { screen: ScreenId; chars: string[]; texts: string[] }[] = [];

          for (const id of ALL_SCREENS) {
            await openScreen(container, id, viewMode);
            const text = container.textContent ?? '';
            const chars = findDiacriticChars(text);
            if (chars.length > 0) {
              violations.push({
                screen: id,
                chars,
                texts: findDiacriticTextNodes(container),
              });
            }
          }

          expect(
            violations,
            'Vietnamese diacritics found in the EN DOM:\n' +
              violations
                .map(
                  (v) =>
                    `  - screen "${v.screen}": [${v.chars.join(' ')}]\n` +
                    v.texts.map((text) => `      "${text}"`).join('\n')
                )
                .join('\n')
          ).toEqual([]);
        },
        60000
      );
    }
  });

  describe('positive control — the checks are not vacuous', () => {
    it('flags a known Vietnamese sample string and passes plain English', () => {
      expect(findDiacriticChars('Chưa đo ở S1').length).toBeGreaterThan(0);
      expect(findDiacriticSnippets('Chưa đo ở S1').length).toBeGreaterThan(0);
      expect(findDiacriticChars('Everything is running fine')).toEqual([]);
      expect(findDiacriticChars('RouterSync on localhost:30128')).toEqual([]);
    });

    it('records a deliberately unknown key and clears it on reset', () => {
      resetMissingI18nKeys();
      expect(getMissingI18nKeys()).toEqual([]);

      expect(t('__at147_missing_probe__')).toBe('__at147_missing_probe__');
      expect(getMissingI18nKeys()).toEqual(['__at147_missing_probe__']);
      expect(hasTranslation('__at147_missing_probe__')).toBe(false);

      resetMissingI18nKeys();
      expect(getMissingI18nKeys()).toEqual([]);

      expect(hasTranslation('nav_overview')).toBe(true);
    });
  });
});

/**
 * AT-147 extension (R18-5.1, R18-5.2): what the owner actually reads.
 *
 * The payload carries machine enums — `up`, `down`, `unknown`, `pass`, `fail`,
 * `not_checked`, `warning`, `error`, `healthy` — and the screens used to print
 * them straight into a Vietnamese sentence. The same for timestamps: the sidebar
 * printed `2026-10-21T12:08:51.300Z`. These cases scan the rendered DOM for a
 * standalone enum and for a raw ISO stamp, so a screen that regresses to the
 * payload token fails here instead of looking merely "odd".
 */
describe('AT-147 (R18-5): no raw enum and no raw ISO stamp reaches the screen', () => {
  /**
   * A whole-word match: `up` inside "update" must not fire.
   *
   * R19-2: `unwritten` joined the list — it is an enum value of
   * `applyState` and must never reach the screen as a raw token.
   */
  const RAW_ENUM = /\b(up|down|unknown|pass|fail|not_checked|warning|error|healthy|unwritten)\b/;

  const openScreen = async (label: string) => {
    const button = await screen.findByRole('button', { name: label });
    fireEvent.click(button);
    return button;
  };

  afterEach(() => {
    cleanup();
    setLanguage('vi');
  });

  it('renders the targets screen without printing a router enum', async () => {
    setLanguage('vi');
    render(
      <ApiProvider value={new MockApi()}>
        <App />
      </ApiProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value')).toBeDefined();
    });

    await openScreen(t('nav_targets'));
    await waitFor(() => {
      expect(screen.getByTestId('targets-screen')).toBeDefined();
    });

    const cells = Array.from(document.querySelectorAll('[data-testid="target-probe-value"]'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const text = (cell.textContent ?? '').trim();
      // Strip the measured HTTP status, which is a number and belongs there.
      const label = text.replace(/\s·\s\d+$/, '').trim();
      expect(label).not.toBe('');
      expect(RAW_ENUM.test(label), `raw enum painted on Targets: "${text}"`).toBe(false);
    }
  });

  it('never paints the raw "unwritten" enum on the targets screen (R19-2)', async () => {
    // R19-2 (DECISIONS 2026-10-18-01): 'unwritten' is a NEW value of the
    // applyState enum. A screen must print it through the catalog
    // (r19_apply_unwritten), never as the raw token.
    setLanguage('vi');
    const mock = new MockApi();
    const api = new Proxy(mock, {
      get(target, prop, receiver) {
        if (prop === 'getTargets') {
          return async () =>
            (await target.getTargets()).map((item) => ({
              ...item,
              applyState: 'unwritten' as const,
            }));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as ApiClient;

    render(
      <ApiProvider value={api}>
        <App />
      </ApiProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value')).toBeDefined();
    });

    await openScreen(t('nav_targets'));
    await waitFor(() => {
      expect(screen.getByTestId('targets-screen')).toBeDefined();
    });

    const chips = Array.from(document.querySelectorAll('[data-testid="apply-chip"]'));
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const text = (chip.textContent ?? '').trim();
      expect(text).toContain(t('r19_apply_unwritten'));
      expect(text, `raw enum painted on the apply chip: "${text}"`).not.toMatch(/\bunwritten\b/);
      // the machine token stays in the attribute, not in the text
      expect(chip.getAttribute('data-apply-state')).toBe('unwritten');
    }
  });

  it('renders the doctor overall status through the catalog', async () => {
    setLanguage('vi');
    render(
      <ApiProvider value={new MockApi()}>
        <App />
      </ApiProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value')).toBeDefined();
    });

    await openScreen(t('nav_health'));
    await waitFor(() => {
      expect(screen.getByTestId('doctor-overall')).toBeDefined();
    });

    const overall = screen.getByTestId('doctor-overall').textContent ?? '';
    const value = overall.replace(t('r14_doctor_overall'), '').trim();
    expect(value).not.toBe('');
    expect(RAW_ENUM.test(value), `raw enum painted as the overall status: "${value}"`).toBe(false);
  });

  it('the sidebar probe line shows a clock, never an ISO stamp', async () => {
    setLanguage('vi');
    render(
      <ApiProvider value={new MockApi()}>
        <App />
      </ApiProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value')).toBeDefined();
    });

    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('formats an instant in a fixed time zone (independent of this machine)', () => {
    // 12:08:51Z is 19:08:51 in Asia/Ho_Chi_Minh and 12:08:51 in UTC.
    expect(formatClock('2026-10-21T12:08:51.300Z', 'Asia/Ho_Chi_Minh')).toBe('19:08:51');
    expect(formatClock('2026-10-21T12:08:51.300Z', 'UTC')).toBe('12:08:51');
    // Unreadable input is omitted, never printed raw.
    expect(formatClock('not-a-date')).toBeUndefined();
    expect(formatClock(undefined)).toBeUndefined();
    expect(formatClock('')).toBeUndefined();
  });
});
