/**
 * test/ui/render-audit-helpers.ts
 *
 * AT-148 (R16-3) — shared helpers for the render audit.
 *
 * Scope note: this file is type-checked by the ROOT tsconfig, which includes
 * every TypeScript file under the `test` directory and uses `lib: ES2022`
 * (no DOM) with `module: NodeNext`.
 * There is no DOM lib there, so every DOM-dependent helper lives in the UI
 * package test file; this module only owns the pure string / file logic.
 *
 * What the module does:
 *  - the allow list is read from disk and every entry must carry a
 *    hand-written reason (an entry without a reason is a hard error, not a
 *    silently accepted exception);
 *  - a poison token only matches as a whole "identifier" — `acme` must not
 *    match inside `acme-coder-2`, and `412` must not match inside `4120`;
 *  - the audit line format is stable so two runs can be diffed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One allowed token on ONE route, plus the hand-written reason why it may show
 * up there.
 *
 * R17-4: the entry used to be `{ token, reason }`, so a number like `41` was
 * excused on EVERY route and could hide the same leak elsewhere. The scope is
 * now a single route; a leak on another screen cannot hide behind it.
 */
export interface AllowEntry {
  route: string;
  token: string;
  reason: string;
}

export interface AllowList {
  entries: AllowEntry[];
}

/** True when `route` + `token` may be printed (exact route only). */
export function isAllowed(
  allow: AllowList,
  route: string,
  token: string,
): boolean {
  return allow.entries.some(
    (entry) => entry.route === route && entry.token === token,
  );
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (this file lives in `<root>/test/ui/`). */
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/** The only allow mechanism of the audit. */
export const ALLOW_LIST_PATH = path.join(HERE, "render-audit-allow.json");

/**
 * Reads the allow list.
 *
 * Throws when the file is malformed or when an entry has no hand-written
 * reason: an unexplained exception is worse than a red test, because it hides
 * a sample leak behind an allow list nobody can audit.
 */
export function readAllowList(filePath: string = ALLOW_LIST_PATH): AllowList {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) {
    throw new Error(
      `[AT-148] ${filePath} must be {"entries": [{"token": "...", "reason": "..."}]}`,
    );
  }
  const entries: AllowEntry[] = [];
  for (const rawEntry of parsed.entries) {
    const entry = rawEntry as Partial<AllowEntry>;
    if (typeof entry.token !== "string" || entry.token.trim() === "") {
      throw new Error(
        `[AT-148] ${filePath}: every entry needs a non-empty "token"`,
      );
    }
    if (typeof entry.route !== "string" || entry.route.trim() === "") {
      throw new Error(
        `[AT-148] ${filePath}: entry "${entry.token}" needs a "route"; a token may only be excused on one route`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(
        `[AT-148] ${filePath}: entry "${entry.token}" needs a hand-written "reason"`,
      );
    }
    entries.push({
      route: entry.route,
      token: entry.token,
      reason: entry.reason,
    });
  }
  return { entries };
}

/** Collapses every whitespace run into a single space and trims. */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Characters that make a token part of a LONGER identifier. `acme` must not
 * match inside `acme-coder-2`; `412` must not match inside `4120`.
 */
const IDENTIFIER_EDGE = "A-Za-z0-9_\\-";

/** Escapes a literal for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the whole-identifier matcher of a token.
 *
 * Numbers additionally refuse a `.` neighbour, so `412` does not match inside
 * `412.5`.
 */
export function tokenPattern(token: string): RegExp {
  const escaped = escapeRegExp(token);
  const isNumeric = /^[0-9]+(\.[0-9]+)?$/.test(token);
  const left = isNumeric
    ? "(?<![A-Za-z0-9_.\\-])"
    : `(?<![${IDENTIFIER_EDGE}])`;
  const right = isNumeric ? "(?![A-Za-z0-9_.\\-])" : `(?![${IDENTIFIER_EDGE}])`;
  return new RegExp(`${left}${escaped}${right}`);
}

/** True when `token` occurs in `text` as a whole identifier. */
export function containsToken(text: string, token: string): boolean {
  return tokenPattern(token).test(text);
}

/**
 * Returns every token of `tokens` that occurs in `text` as a whole
 * identifier. The result is sorted so the report is deterministic.
 */
export function findTokenHits(
  text: string,
  tokens: readonly string[],
): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    if (!text.includes(token)) continue;
    if (containsToken(text, token)) hits.push(token);
  }
  return hits.sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Formats one audit line.
 *
 * `<route> | <state> | <lang> | <text node(s) that contain a digit>`
 *
 * A route without any digit-bearing text node prints the em-dash `-`.
 */
export function formatAuditLine(
  route: string,
  state: string,
  lang: string,
  texts: readonly string[],
): string {
  const field = texts.length === 0 ? "-" : texts.join(" | ");
  return `${route} | ${state} | ${lang} | ${field}`;
}

/** Formats one violation line of the poison report. */
export function formatViolation(
  route: string,
  state: string,
  lang: string,
  token: string,
  textNode: string,
): string {
  return `${route} | ${state} | ${lang} | ${token} | ${textNode}`;
}
