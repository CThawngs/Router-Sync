/**
 * test/ui/number-provenance.ts
 *
 * R20-2: "Number Provenance" in live states (AT-159).
 *
 * In the two live audited states (live_fixture and live_fixture_up), the poison
 * grid intentionally drops numbers because a measured number could collide with
 * sample data by chance. However, this left a blind spot where an invented number
 * (such as "86 models" or phantom percentages) could be printed undetected.
 *
 * This module enforces that EVERY number token rendered on the screen in live states
 * must be traced to one of three legitimate sources:
 *   (i)   A value appearing in the JSON payloads of the six measured daemon routes;
 *   (ii)  A static number in the i18n translations catalog for the audited language;
 *   (iii) A documented derived value computed by an explicit helper with clear rationale.
 *
 * Any number not accountable to these three sources is a violation unless covered by
 * a hand-written exception in test/ui/number-provenance-allow.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');

export const ALLOW_PATH = path.join(REPO_ROOT, 'test/ui/number-provenance-allow.json');
export const TRANSLATIONS_PATH = path.join(
  REPO_ROOT,
  'packages/ui/src/i18n/translations.json',
);

export interface NumberProvenanceAllowEntry {
  route: string;
  token: string;
  reason: string;
}

export function readNumberProvenanceAllow(): NumberProvenanceAllowEntry[] {
  if (!fs.existsSync(ALLOW_PATH)) return [];
  const raw = fs.readFileSync(ALLOW_PATH, 'utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export interface ExtractedToken {
  type: 'time' | 'ratio' | 'decimal' | 'integer';
  val: string;
}

/**
 * Extracts number-carrying tokens from text in priority order so compound
 * representations (time, ratios, formatted decimals/versions) are captured intact
 * rather than fragmented into isolated integers.
 */
export function extractNumberTokens(text: string): ExtractedToken[] {
  const tokens: ExtractedToken[] = [];
  let remaining = text;

  // 1. Time formats: hh:mm:ss or hh:mm
  remaining = remaining.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (match) => {
    tokens.push({ type: 'time', val: match });
    return ' '.repeat(match.length);
  });

  // 2. Ratios: a/b (e.g. 1/2, 2/2, 0/0)
  remaining = remaining.replace(/\b\d+\s*\/\s*\d+\b/g, (match) => {
    tokens.push({ type: 'ratio', val: match.replace(/\s+/g, '') });
    return ' '.repeat(match.length);
  });

  // 3. Formatted thousands, decimals, versions, IPs (e.g. 4,000, 4.000, 0.10, 22.13.0, 127.0.0.1)
  remaining = remaining.replace(/\b\d+(?:[.,]\d+)+\b/g, (match) => {
    tokens.push({ type: 'decimal', val: match });
    return ' '.repeat(match.length);
  });

  // 4. Standalone integers (e.g. 61, 86, 0, 1, 2)
  remaining = remaining.replace(/\b\d+\b/g, (match) => {
    tokens.push({ type: 'integer', val: match });
    return ' '.repeat(match.length);
  });

  return tokens;
}

/**
 * Sample walkthrough translation keys that contain mock / invented counts (e.g. "86 models").
 * These must not excuse real numbers rendered in live states.
 */
const SAMPLE_TRANSLATION_KEYS = new Set([
  'w_1ok', // "Found 86 models" (sample wizard walkthrough)
  'w_2d',
  'w_4a',
  'w_4b',
]);

/**
 * Source (ii): Collects static number tokens from the i18n translation catalog
 * for the requested language.
 */
export function collectCatalogNumbers(
  catalog: Record<string, unknown>,
  lang: 'vi' | 'en',
): Set<string> {
  const nums = new Set<string>();
  const stringsObj = (catalog[lang] || {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(stringsObj)) {
    if (SAMPLE_TRANSLATION_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      for (const t of extractNumberTokens(value)) {
        nums.add(t.val);
        // Also add plain unformatted variant for grouped numbers like 4,000 -> 4000
        const plain = t.val.replace(/,/g, '');
        if (plain !== t.val) nums.add(plain);
      }
    }
  }
  return nums;
}

/**
 * Source (i): Recursively harvests all numerical literals and numbers embedded in
 * string fields (ports, IPs, model identifiers, timestamps) from daemon route JSON payloads.
 */
export function collectPayloadNumbers(payloads: Record<string, unknown>): Set<string> {
  const nums = new Set<string>();

  const visit = (val: unknown): void => {
    if (typeof val === 'number' && Number.isFinite(val)) {
      nums.add(String(val));
      return;
    }
    if (typeof val === 'string') {
      for (const t of extractNumberTokens(val)) {
        nums.add(t.val);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) visit(item);
      return;
    }
    if (val && typeof val === 'object') {
      for (const v of Object.values(val as Record<string, unknown>)) {
        visit(v);
      }
    }
  };

  for (const p of Object.values(payloads)) {
    visit(p);
  }

  return nums;
}

export interface DerivedContext {
  payloads: Record<string, unknown>;
  lang: 'vi' | 'en';
}

/**
 * Source (iii): Explicit, documented derived values and tolerance rules.
 */
export function collectDerivedNumbers(context: DerivedContext): Set<string> {
  const derived = new Set<string>();
  const { payloads } = context;

  const overview = (payloads['overview'] || {}) as Record<string, unknown>;
  const health = (payloads['health'] || {}) as Record<string, unknown>;
  const targets = (Array.isArray(payloads['targets']) ? payloads['targets'] : []) as Array<
    Record<string, unknown>
  >;
  const combosPayload = (payloads['combos'] || {}) as Record<string, unknown>;
  const combosList = (Array.isArray(combosPayload['combos'])
    ? combosPayload['combos']
    : []) as Array<Record<string, unknown>>;

  // Rule 1: Formatted local time from ISO timestamps
  // Rationale: ISO timestamps (generatedAt, lastProbeAt, lastChecked) are formatted by the UI
  // into local hh:mm:ss via formatClock (Sidebar.tsx:133).
  const extractIsos = (v: unknown): string[] => {
    const isos: string[] = [];
    const walk = (item: unknown): void => {
      if (typeof item === 'string') {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(item)) isos.push(item);
        return;
      }
      if (Array.isArray(item)) {
        for (const i of item) walk(i);
        return;
      }
      if (item && typeof item === 'object') {
        for (const val of Object.values(item as Record<string, unknown>)) walk(val);
      }
    };
    walk(v);
    return isos;
  };

  for (const iso of extractIsos(payloads)) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      const opts = { hour: '2-digit' as const, minute: '2-digit' as const, second: '2-digit' as const, hour12: false };
      derived.add(d.toLocaleTimeString(undefined, opts));
      derived.add(d.toLocaleTimeString('en-US', opts));
      // Tolerance of ±1 second in case of probe transition
      derived.add(new Date(d.getTime() - 1000).toLocaleTimeString(undefined, opts));
      derived.add(new Date(d.getTime() + 1000).toLocaleTimeString(undefined, opts));
    }
  }

  // Rule 2: Dynamic Uptime with tolerance
  // Rationale: Daemon uptime ticks up during interactive UI tests. We allow values within
  // [uptime - 5, uptime + 60] seconds of the fetched payload uptime.
  const rawUptime =
    typeof health['uptime'] === 'number'
      ? health['uptime']
      : typeof (overview['daemon'] as Record<string, unknown> | undefined)?.['uptime'] === 'number'
        ? ((overview['daemon'] as Record<string, unknown>)['uptime'] as number)
        : undefined;

  if (typeof rawUptime === 'number') {
    const min = Math.max(0, rawUptime - 5);
    const max = rawUptime + 60;
    for (let u = min; u <= max; u++) {
      derived.add(String(u));
    }
  }

  // Rule 3: Health router ratios (e.g. up / probed, unreachable / probed)
  // Rationale: Header displays "1/2 router không phản hồi" or "2/2".
  const overviewRouters = overview['routers'] as
    | { upCount?: number; probedCount?: number }
    | undefined;
  const healthRouters = (health['routers'] || {}) as Record<string, { reachable?: boolean }>;
  const healthEntries = Object.values(healthRouters);

  const probedCount =
    overviewRouters?.probedCount ??
    (healthEntries.length > 0 ? healthEntries.length : targets.length > 0 ? targets.length : 2);
  const upCount =
    overviewRouters?.upCount ??
    (healthEntries.length > 0
      ? healthEntries.filter((r) => r.reachable).length
      : 1);
  const unreachableCount = probedCount - upCount;

  if (probedCount > 0) {
    derived.add(`${upCount}/${probedCount}`);
    derived.add(`${unreachableCount}/${probedCount}`);
    derived.add(`${probedCount}/${probedCount}`);
    derived.add(String(probedCount));
    derived.add(String(upCount));
    derived.add(String(unreachableCount));
  }

  // Rule 4: Module index numbers in OverviewScreen detail view
  // Rationale: OverviewScreen.tsx line 931 renders `<span className="m">{`0${idx + 1}`}</span>`
  // for the 8 pipeline modules (01, 02, ..., 08).
  for (let idx = 1; idx <= 8; idx++) {
    derived.add(`0${idx}`);
    derived.add(String(idx));
  }

  // Rule 5: Ladder preview page size
  // Rationale: CombosScreen ladder renders "Showing 10 of 60 steps" / "Đang hiện 10 trong 60 bước"
  // where 10 is the pagination cap before "Show all" is pressed.
  derived.add('10');
  derived.add('0/0'); // When 0 steps are present

  // Rule 6: Combos and targets collection counts
  derived.add(String(combosList.length));
  derived.add(String(targets.length));

  // Rule 7: Target probe HTTP status code (200)
  derived.add('200');

  return derived;
}

export interface ProvenanceAuditResult {
  token: string;
  type: string;
  route: string;
  lang: string;
  textNode: string;
}

/**
 * Checks a text node against the three provenance sources and the allow list.
 * Returns an audit violation record if the token cannot be provenanced.
 */
export function checkTextNodeProvenance(
  text: string,
  route: string,
  lang: 'vi' | 'en',
  payloadNumbers: Set<string>,
  catalogNumbers: Set<string>,
  derivedNumbers: Set<string>,
  allowList: NumberProvenanceAllowEntry[],
): ProvenanceAuditResult[] {
  const violations: ProvenanceAuditResult[] = [];
  const tokens = extractNumberTokens(text);

  for (const t of tokens) {
    const val = t.val;

    // Check allow list first
    const allowed = allowList.some(
      (entry) =>
        entry.route === route && (entry.token === val || entry.token === t.val),
    );
    if (allowed) continue;

    // Check source (i): payload JSON
    if (payloadNumbers.has(val)) continue;

    // Check source (ii): catalog static numbers
    if (catalogNumbers.has(val)) continue;

    // Check source (iii): derived numbers
    if (derivedNumbers.has(val)) continue;

    violations.push({
      token: val,
      type: t.type,
      route,
      lang,
      textNode: text,
    });
  }

  return violations;
}
