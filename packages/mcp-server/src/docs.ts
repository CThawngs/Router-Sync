/**
 * packages/mcp-server/src/docs.ts
 *
 * Real full-text search over the repository's Markdown documentation.
 *
 * The previous `search_docs` matched four hardcoded strings, so every query
 * outside that list returned nothing while the tool still reported success.
 * This module walks `docs/**` and README.md on disk, caps the work it does, and
 * returns the file, line number and snippet for every real hit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocHit {
  file: string;
  line: number;
  snippet: string;
}

export interface DocSearchOptions {
  query: string;
  maxFiles?: number;
  maxHits?: number;
  maxBytesPerFile?: number;
}

export interface DocSearchResult {
  root: string;
  query: string;
  searchedFiles: number;
  hits: DocHit[];
  truncated: boolean;
  reason?: string;
}

const MAX_DEFAULT_FILES = 200;
const MAX_DEFAULT_HITS = 40;
const MAX_DEFAULT_BYTES = 400_000;
const MAX_WALK_DEPTH = 3;
const SNIPPET_RADIUS = 120;

/** Repository root, resolved from the compiled dist/ directory (dist -> package -> repo). */
export function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

interface WalkState {
  files: string[];
  truncated: boolean;
}

function walkMarkdown(dir: string, depth: number, limit: number, state: WalkState): void {
  if (state.files.length >= limit) {
    state.truncated = true;
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.files.length >= limit) {
      state.truncated = true;
      return;
    }
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    if (entry.name.startsWith('.')) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) walkMarkdown(full, depth + 1, limit, state);
      continue;
    }
    if (entry.name.endsWith('.md')) state.files.push(full);
  }
}

function collectMarkdownFiles(root: string, limit: number): WalkState {
  const state: WalkState = { files: [], truncated: false };
  walkMarkdown(path.join(root, 'docs'), 0, limit, state);
  const readme = path.join(root, 'README.md');
  if (state.files.length < limit && fs.existsSync(readme)) state.files.unshift(readme);
  return state;
}

function buildSnippet(line: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(line.length, index + needleLength + SNIPPET_RADIUS);
  const head = start > 0 ? '...' : '';
  const tail = end < line.length ? '...' : '';
  return `${head}${line.slice(start, end).trim()}${tail}`;
}

/**
 * Literal, case-insensitive search. Kept literal on purpose: a user searching
 * "I3" or "chay" must not be handed regex semantics by accident.
 */
export function searchDocs(options: DocSearchOptions): DocSearchResult {
  const query = options.query.trim();
  const maxFiles = options.maxFiles ?? MAX_DEFAULT_FILES;
  const maxHits = options.maxHits ?? MAX_DEFAULT_HITS;
  const maxBytes = options.maxBytesPerFile ?? MAX_DEFAULT_BYTES;
  const root = resolveRepoRoot();

  if (query.length === 0) {
    return {
      root,
      query,
      searchedFiles: 0,
      hits: [],
      truncated: false,
      reason: 'EMPTY_QUERY',
    };
  }

  const walked = collectMarkdownFiles(root, maxFiles);
  const needle = query.toLowerCase();
  const hits: DocHit[] = [];
  let searchedFiles = 0;
  let skippedLargeFile = false;

  for (const filePath of walked.files) {
    if (hits.length >= maxHits) break;

    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    if (size > maxBytes) {
      skippedLargeFile = true;
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    searchedFiles += 1;
    const relative = path.relative(root, filePath).replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= maxHits) break;
      const line = lines[index] ?? '';
      const matchIndex = line.toLowerCase().indexOf(needle);
      if (matchIndex === -1) continue;
      hits.push({
        file: relative,
        line: index + 1,
        snippet: buildSnippet(line, matchIndex, needle.length),
      });
    }
  }

  const result: DocSearchResult = {
    root,
    query,
    searchedFiles,
    hits,
    truncated: hits.length >= maxHits || walked.truncated,
  };
  if (skippedLargeFile) result.reason = 'SOME_FILES_OVER_BYTE_CAP';
  return result;
}
