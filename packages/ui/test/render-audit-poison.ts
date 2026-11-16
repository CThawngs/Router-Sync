/**
 * packages/ui/test/render-audit-poison.ts
 *
 * AT-155 (R19-1) — the two render-audit grids, shared by the interactive audit.
 *
 * A "grid" is a check that runs over every captured DOM:
 *  - the POISON grid: no string or number of the MockApi sample data may
 *    survive on the screen (the poison set is computed at runtime, never
 *    hand-written);
 *  - the LEXICON grid: no phrase that CLAIMS a measured status may appear
 *    while the status was not measured (AT-156).
 *
 * ponytail: AT-148 still carries its own copy of these helpers. The two files
 * must not be merged in this round — AT-148 is the frozen baseline of the
 * mutation `r19-mut-interactive-claim` (it has to stay byte-identical so the
 * mutation can prove "the opening state stayed green"). Merge them when
 * AT-148 is allowed to change.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { MockApi } from "../src/api/mock";
import { hasTranslation, setLanguage, t } from "../src/i18n";
import translations from "../src/i18n/translations.json";
import { REPO_ROOT, normalizeText } from "../../../test/ui/render-audit-helpers.js";

const CATALOG = translations as unknown as {
  vi: Record<string, string>;
  en: Record<string, string>;
};

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/** Every text node of `root`, whitespace-normalised, in document order. */
export function collectTextNodes(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const text = normalizeText(node.nodeValue ?? "");
    if (text.length > 0) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

/** Every text node of `root` that contains at least one digit. */
export function collectDigitTextNodes(root: Element): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of collectTextNodes(root)) {
    if (/\d/.test(text) && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The poison set — computed at runtime from the MockApi
 * ------------------------------------------------------------------ */

export interface SampleTokens {
  strings: string[];
  numbers: string[];
}

/** Every number of 10 or more inside a string (e.g. "… error 401 …"). */
const NUMBER_IN_TEXT = /(?<![0-9.])[0-9]+(?![0-9.])/g;

/**
 * Runs the MockApi and collects every piece of sample content it can hand
 * out: strings of 4 characters or more and numbers of 10 or more.
 */
export async function collectMockSampleTokens(): Promise<SampleTokens> {
  const api = new MockApi();
  const payloads = await Promise.all([
    api.getOverview(),
    api.getPipelineModules(),
    api.getHeartbeat(),
    api.getDaemonHealth(),
    api.getProviders(),
    api.getModels(),
    api.getUnmatchedNames(),
    api.getUnknownTraits(),
    api.getCombos(),
    api.getTargets(),
    api.getPendingPlan(),
    api.getSnapshots(),
    api.getHealthSummary(),
    api.getDoctor(),
  ]);

  const strings = new Set<string>();
  const numbers = new Set<string>();

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length >= 4) strings.add(text);
      const scanner = new RegExp(NUMBER_IN_TEXT.source, "g");
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(text)) !== null) {
        if (Number(match[0]) >= 10) numbers.add(match[0]);
      }
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value) && value >= 10) numbers.add(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };

  for (const payload of payloads) walk(payload);

  return {
    strings: [...strings].sort((a, b) => a.localeCompare(b, "en")),
    numbers: [...numbers].sort((a, b) => Number(a) - Number(b)),
  };
}

/**
 * A payload value is often a translation KEY ("ago2"), so the Vietnamese text
 * never looked like the English one and an English-only leak was invisible.
 * Every payload string that resolves through the catalog is therefore expanded
 * to its Vietnamese AND English value.
 */
export function expandTokensWithCatalog(sample: SampleTokens): SampleTokens {
  const strings = new Set<string>(sample.strings);
  for (const value of sample.strings.slice()) {
    if (!hasTranslation(value)) continue;
    for (const lang of ["vi", "en"] as const) {
      setLanguage(lang);
      const translated = t(value);
      if (translated.length >= 4 && !translated.includes("{")) strings.add(translated);
    }
  }
  setLanguage("vi");
  return {
    strings: [...strings].sort((a, b) => a.localeCompare(b, "en")),
    numbers: [...sample.numbers],
  };
}

/** Cheap pre-filter + exact whole-identifier check. */
function mentions(text: string, token: string): boolean {
  return text.includes(token) && containsWholeToken(text, token);
}

/**
 * A token only matches as a whole identifier: `acme` must not match inside
 * `acme-coder-2`, and `412` must not match inside `4120`.
 */
const IDENTIFIER_EDGE = "A-Za-z0-9_\\-";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenPattern(token: string): RegExp {
  const escaped = escapeRegExp(token);
  const isNumeric = /^[0-9]+(\.[0-9]+)?$/.test(token);
  const left = isNumeric ? "(?<![A-Za-z0-9_.\\-])" : `(?<![${IDENTIFIER_EDGE}])`;
  const right = isNumeric ? "(?![A-Za-z0-9_.\\-])" : `(?![${IDENTIFIER_EDGE}])`;
  return new RegExp(`${left}${escaped}${right}`);
}

export function containsWholeToken(text: string, token: string): boolean {
  return tokenPattern(token).test(text);
}

/**
 * Builds the poison token set.
 *
 * A token from the MockApi is EXEMPT when the app's own static copy (the i18n
 * catalog) says it on its own — then it is vocabulary, not sample data. The
 * rule is deliberately strict: a catalog value only excuses a token when it
 * mentions THAT token and no other sample token.
 *
 * R19-1 (AT-155): a payload value is often a translation KEY, so the expanded
 * token is a whole sentence ("Tệp SQLite của router đọc được"). Such a
 * sentence mentions the smaller tokens it is built from ("router"), which used
 * to keep the sentence itself out of the exemption — and the app prints the
 * same sentence in the live states, where the doctor really measured it. A
 * token is therefore also exempt when every OTHER token its catalog value
 * mentions is a PART of it.
 */
export function buildPoisonTokens(sample: SampleTokens): string[] {
  const catalogValues = [
    ...Object.values(CATALOG.vi),
    ...Object.values(CATALOG.en),
  ].filter((value): value is string => typeof value === "string");

  const candidates = [...sample.strings, ...sample.numbers];

  const mentionedBy = catalogValues.map((value) =>
    candidates.filter((token) => mentions(value, token)),
  );

  const exempt = new Set<string>();
  for (const token of candidates) {
    const excused = mentionedBy.some(
      (list) =>
        list.includes(token) &&
        list.every((other) => other === token || token.includes(other)),
    );
    if (excused) exempt.add(token);
  }

  return candidates
    .filter((token) => !exempt.has(token))
    .filter((token, index, all) => all.indexOf(token) === index)
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** True when the token is a plain number (a measured number can equal it). */
export function isNumberToken(token: string): boolean {
  return /^[0-9]+(\.[0-9]+)?$/.test(token);
}

/* ------------------------------------------------------------------ *
 * AT-156: the status-claim vocabulary
 * ------------------------------------------------------------------ */

export const LEXICON_PATH = path.join(
  REPO_ROOT,
  "test",
  "ui",
  "status-claim-lexicon.json",
);

export interface StatusClaimLexicon {
  tokens: string[];
  allow: Array<{ route: string; token: string; reason: string }>;
}

export function readStatusClaimLexicon(): StatusClaimLexicon {
  return JSON.parse(fs.readFileSync(LEXICON_PATH, "utf8")) as StatusClaimLexicon;
}

/**
 * Which claim tokens a block of rendered text carries.
 *
 * A Vietnamese phrase is matched as a substring; an ASCII word is matched on a
 * word boundary, so "found" does not fire on "unfounded".
 */
export function scanStatusClaims(
  text: string,
  tokens: readonly string[],
): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    const isAsciiWord = /^[A-Za-z][A-Za-z -]*$/.test(token);
    const found = isAsciiWord
      ? new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text)
      : text.toLowerCase().includes(token.toLowerCase());
    if (found) hits.push(token);
  }
  return hits;
}
