/**
 * packages/daemon/src/config/lint.ts
 *
 * Minimal YAML-subset syntax lint for the RouterSync config file (R16-4).
 *
 * WHY THIS EXISTS: the daemon ships with ZERO external npm dependencies
 * (daemon S1 rule: only the workspace package `@routersync/core` is
 * importable), so it cannot use the `yaml` parser the CLI uses. The doctor
 * still has to tell "this file is broken" apart from "this file is fine",
 * so this module implements a conservative, line-based lint of the YAML
 * subset a `routersync.yaml` is written in.
 *
 * WHAT IT REJECTS:
 *  - a TAB used for indentation (a YAML parser rejects it),
 *  - a quoted scalar that is never closed (a YAML parser rejects it),
 *  - a line that cannot be a mapping entry, a sequence item, a flow
 *    collection or a document marker (a YAML parser rejects it),
 *  - a flow collection that is never closed (a YAML parser rejects it),
 *  - a document that is not a top-level mapping (an empty file, a bare
 *    scalar, a bare sequence). A YAML parser accepts those as null or as a
 *    scalar, but the RouterSync config schema is an OBJECT, so they are not
 *    a config.
 *
 * WHAT IT DOES NOT DO: it does NOT run the CLI's zod schema
 * (`packages/cli/src/config/schema.ts`). Passing this lint only means "the
 * file is syntactically usable"; it does not mean "this is a valid
 * RouterSync config" — the daemon claims only what it can prove.
 */

export interface ConfigLintResult {
  ok: boolean;
  /** Machine-readable token describing WHY the file was rejected. */
  reason?: string | undefined;
}

const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d*$/;

/** Strips a trailing `#` comment (a `#` that starts a word, outside quotes). */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Net `[`/`{` depth of a fragment (quote aware). */
function flowDelta(text: string): number {
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '[' || ch === '{') delta++;
    else if (ch === ']' || ch === '}') delta--;
  }
  return delta;
}

/**
 * True when `text` is a YAML mapping entry (`key: value` / `key:`).
 * YAML requires whitespace (or end of line) after the `:`.
 */
function isMappingEntry(text: string): boolean {
  const idx = text.indexOf(':');
  if (idx <= 0) return false;
  const key = text.slice(0, idx).trim();
  if (key.length === 0) return false;
  const rest = text.slice(idx + 1);
  return rest.length === 0 || /^\s/.test(rest);
}

/** The value part of a mapping entry (everything after the first `:`). */
function mappingValue(text: string): string {
  const idx = text.indexOf(':');
  return idx < 0 ? '' : text.slice(idx + 1).trim();
}

/** True when a quoted scalar is started but never closed. */
function hasUnclosedQuote(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("'")) return !(t.length >= 2 && t.endsWith("'"));
  if (t.startsWith('"')) return !(t.length >= 2 && t.endsWith('"'));
  return false;
}

/**
 * Lints the raw text of a RouterSync config file.
 *
 * @param raw The full file content.
 * @returns `{ ok: true }` when the document is a syntactically usable YAML
 *          mapping, otherwise `{ ok: false, reason }` with a stable token.
 */
export function lintConfigText(raw: string): ConfigLintResult {
  const lines = raw.split(/\r?\n/);

  let topLevelMapping = false;
  let flowDepth = 0;
  let blockScalarIndent = -1;
  // Indent of the last mapping key whose value was a PLAIN scalar, used to
  // recognise the continuation lines of a multi-line plain scalar.
  let plainValueIndent = -1;

  for (const rawLine of lines) {
    const indentMatch = /^[ \t]*/.exec(rawLine);
    const indent = indentMatch ? indentMatch[0] : '';
    if (indent.includes('\t')) {
      return { ok: false, reason: 'tab_indentation' };
    }

    const body = stripComment(rawLine.slice(indent.length));
    const trimmed = body.trim();
    if (trimmed === '') continue;

    if (flowDepth > 0) {
      flowDepth += flowDelta(body);
      continue;
    }

    if (blockScalarIndent >= 0) {
      if (indent.length > blockScalarIndent) continue; // literal block content
      blockScalarIndent = -1;
    }

    if (trimmed === '---' || trimmed === '...') continue; // document markers

    if (trimmed.startsWith('-')) {
      const item = trimmed === '-' ? '' : trimmed.slice(1).trim();
      if (hasUnclosedQuote(item)) {
        return { ok: false, reason: 'unclosed_quote' };
      }
      if (item !== '' && isMappingEntry(item) && hasUnclosedQuote(mappingValue(item))) {
        return { ok: false, reason: 'unclosed_quote' };
      }
      // A plain scalar sequence item (`- openrouter`) is legal YAML.
      plainValueIndent = -1;
      continue;
    }

    if (isMappingEntry(trimmed)) {
      const value = mappingValue(trimmed);
      if (hasUnclosedQuote(value)) {
        return { ok: false, reason: 'unclosed_quote' };
      }
      if (indent.length === 0) {
        topLevelMapping = true;
      }
      if (BLOCK_SCALAR_INDICATOR.test(value)) {
        blockScalarIndent = indent.length;
        plainValueIndent = -1;
        continue;
      }
      const delta = flowDelta(value);
      if (delta > 0) {
        flowDepth = delta;
        plainValueIndent = -1;
        continue;
      }
      // A plain (unquoted, non-empty) value may continue on the next,
      // more indented line — remember its indent so that continuation is
      // not mistaken for a broken line.
      plainValueIndent = value !== '' && !value.startsWith("'") && !value.startsWith('"') ? indent.length : -1;
      continue;
    }

    // Not a mapping entry and not a sequence item: legal only as the
    // continuation of a multi-line plain scalar.
    if (plainValueIndent >= 0 && indent.length > plainValueIndent) continue;

    return { ok: false, reason: 'unparsable_line' };
  }

  if (flowDepth > 0) {
    return { ok: false, reason: 'unclosed_flow' };
  }
  if (!topLevelMapping) {
    return { ok: false, reason: 'not_a_mapping' };
  }
  return { ok: true };
}
