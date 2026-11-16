/**
 * packages/cli/src/verify/l3-scanner.ts
 *
 * Implements L3 upstream changelog/RSS/releases scanner according to registry/sources.yaml.
 * Runs at most once per day, cached by content hash.
 * Zero-token: pure public HTTP GET.
 * Extracts title/date/link and detects deprecation / release notices.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { L3NoticeItem, L3ScanState } from './types.js';

export interface L3ScannerOptions {
  sourcesFilePath?: string | undefined;
  stateDir?: string | undefined;
  nowMs?: number | undefined;
  minIntervalMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

export interface UpstreamSourceEntry {
  id: string;
  url: string;
  loai: string;
  reliability?: number | undefined;
}

const DEFAULT_L3_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function readRegistrySources(sourcesFilePath?: string): UpstreamSourceEntry[] {
  let p = sourcesFilePath;
  if (!p) {
    const candidates = [
      path.join(process.cwd(), 'registry', 'sources.yaml'),
      path.join(process.cwd(), '..', '..', 'registry', 'sources.yaml'),
      path.join(process.cwd(), '..', 'registry', 'sources.yaml'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        p = c;
        break;
      }
    }
  }
  if (!p || !fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const out: UpstreamSourceEntry[] = [];
  let cur: Partial<UpstreamSourceEntry> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+-\s+id:\s*(.+)$/);
    if (m) {
      if (cur && cur.id && cur.url) out.push(cur as UpstreamSourceEntry);
      cur = { id: m[1]!.trim() };
      continue;
    }
    if (cur) {
      const k = line.match(/^\s+(url|loai|reliability):\s*(.*)$/);
      if (k && k[1]) {
        const val = k[2]?.trim().replace(/^["']|["']$/g, '') ?? '';
        if (k[1] === 'reliability') cur.reliability = Number(val) || 0;
        else if (k[1] === 'url') cur.url = val;
        else if (k[1] === 'loai') cur.loai = val;
      }
    }
  }
  if (cur && cur.id && cur.url) out.push(cur as UpstreamSourceEntry);
  return out;
}

const MONTH_NUMBERS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const LIFECYCLE_WORDING = /deprecat|shut ?down|retir|decommission|discontinu|\beol\b|sunset|replacement/i;

function classifyNoticeType(title: string): L3NoticeItem['noticeType'] {
  const lower = title.toLowerCase();
  if (lower.includes('will be deprecated') || lower.includes('upcoming deprecation') || lower.includes('sunset planned')) {
    return 'upcoming_deprecation';
  }
  if (lower.includes('deprecat') || lower.includes('shut down') || lower.includes('retire') || lower.includes('discontinued') || lower.includes('eol')) {
    return 'deprecated';
  }
  if (lower.includes('new model') || lower.includes('introducing') || lower.includes('release') || lower.includes('launch')) {
    return 'release';
  }
  return 'info';
}

// A4: only a date that is actually written upstream, never today's date.
function extractNoticeDate(title: string): string | null {
  const isoDateMatch = title.match(/\b(20\d{2}-[01]\d-[0-3]\d)\b/);
  if (isoDateMatch?.[1]) return isoDateMatch[1];

  const slashDateMatch = title.match(/\b(20\d{2})\/([01]\d)\/([0-3]\d)\b/);
  if (slashDateMatch?.[1] && slashDateMatch[2] && slashDateMatch[3]) {
    return `${slashDateMatch[1]}-${slashDateMatch[2]}-${slashDateMatch[3]}`;
  }

  // Deprecation tables often print MM/DD/YY (e.g. 09/21/26).
  const shortSlashMatch = title.match(/\b([01]\d)\/([0-3]\d)\/(\d{2})\b/);
  if (shortSlashMatch?.[1] && shortSlashMatch[2] && shortSlashMatch[3]) {
    return `20${shortSlashMatch[3]}-${shortSlashMatch[1]}-${shortSlashMatch[2]}`;
  }

  const textDateMatch = title.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (textDateMatch?.[1] && textDateMatch[2] && textDateMatch[3]) {
    const monthNum = MONTH_NUMBERS[textDateMatch[1].slice(0, 3).toLowerCase()] ?? '01';
    const dayNum = textDateMatch[2].padStart(2, '0');
    return `${textDateMatch[3]}-${monthNum}-${dayNum}`;
  }

  return null;
}

const MODEL_ID_HINT = /gemini|claude|gpt|deepseek|llama|mistral|qwen|pulse|davinci|babbage|curie|jamba|nova|command|mixtral/i;

// A4: a concrete model id carries a separator or a version digit; bare words like "gemini" do not.
function extractModelTokens(text: string): string[] {
  const tokens = text.match(/[a-zA-Z0-9]+(?:[-._:/@][a-zA-Z0-9]+)+/g) ?? [];
  return tokens.filter((token) => {
    const lower = token.toLowerCase();
    if (/^https?/i.test(lower)) return false;
    if (/^(http|https|github|api|models|version|release|notice|update)$/i.test(lower)) return false;
    // Dates and price/duration figures are not model ids.
    if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) return false;
    if (/^\d{1,4}([/.:-]\d{1,4}){1,3}$/.test(lower)) return false;
    if (MODEL_ID_HINT.test(lower)) return true;
    if (/\d/.test(lower)) return true;
    return lower.includes('/') && lower.length > 3;
  });
}

function looksLikeModelId(value: string): boolean {
  const text = value.trim();
  if (text.length < 3 || text.length > 120) return false;
  if (/\s/.test(text)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text) && (/[/:]/.test(text) || /\d/.test(text));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse upstream headings and deprecation tables into notices.
 *
 * Provider deprecation pages publish their real model ids and shutdown dates in
 * `<table>` rows, not headings, so headings alone return zero notices on those
 * pages (OpenAI, Groq). Table rows are only read when the page itself talks about
 * lifecycle changes, which keeps marketing/blog tables out.
 */
export function parseChangelogNotices(
  sourceId: string,
  url: string,
  content: string,
  nowIsoDate: string = new Date().toISOString().slice(0, 10)
): L3NoticeItem[] {
  const notices: L3NoticeItem[] = [];
  const seenTitles = new Set<string>();

  const push = (rawTitle: string, typeOverride?: L3NoticeItem['noticeType'], dateOverride?: string | null): void => {
    const title = rawTitle.trim();
    if (title.length < 4 || seenTitles.has(title) || notices.length >= 60) return;
    seenTitles.add(title);
    const date = dateOverride ?? extractNoticeDate(title);
    notices.push({
      sourceId,
      url,
      title,
      date,
      modelMatches: [...new Set(extractModelTokens(title))],
      noticeType: typeOverride ?? classifyNoticeType(title),
      snippet: title,
    });
  };

  // Parse HTML headings or markdown list items / headers
  const headingMatches = [
    ...content.matchAll(/<h[123][^>]*>(.*?)<\/h[123]>/gis),
    ...content.matchAll(/^[#]{1,3}\s+(.+)$/gm),
  ];
  for (const match of headingMatches.slice(0, 20)) {
    push(stripTags(match[1] ?? ''));
  }

  // Deprecation tables: a row counts only when it carries a date or a model id,
  // which skips the header row without hardcoding column names. The table header
  // supplies the lifecycle context ("Shutdown date", "Deprecated model") that the
  // row text itself usually omits.
  if (LIFECYCLE_WORDING.test(content)) {
    const tableMatches = [...content.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
    for (const table of tableMatches.slice(0, 40)) {
      const rowMatches = [...(table[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      const readCells = (rowHtml: string): string[] =>
        [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
          .map((cell) => stripTags(cell[1] ?? ''))
          .filter((cell) => cell.length > 0);

      const headerCells = rowMatches[0] ? readCells(rowMatches[0][1] ?? '') : [];
      const lifecycleTable = LIFECYCLE_WORDING.test(headerCells.join(' '));

      for (const row of rowMatches.slice(1, 121)) {
        const cells = readCells(row[1] ?? '');
        if (cells.length < 2) continue;

        const carriesDate = cells.some((cell) => extractNoticeDate(cell) !== null);
        const carriesModelId = cells.some((cell) => looksLikeModelId(cell) || extractModelTokens(cell).length > 0);
        if (!carriesDate && !carriesModelId) continue;

        const rowTitle = cells.join(' | ');
        // The lifecycle date is the first dated cell (shutdown column), never a
        // later snapshot/price date. A row whose status cell says "Active" has no
        // shutdown scheduled yet, so it stays informational.
        const rowDate = cells.map((cell) => extractNoticeDate(cell)).find((value) => value !== null) ?? null;
        const stillActive = cells.some((cell) => /^active$/i.test(cell.trim()));
        let typeOverride: L3NoticeItem['noticeType'] | undefined;
        if (lifecycleTable && !stillActive) {
          typeOverride = rowDate && rowDate > nowIsoDate ? 'upcoming_deprecation' : 'deprecated';
        }
        push(rowTitle, typeOverride, rowDate);
      }
    }
  }

  return notices;
}

export function loadL3Cache(cachePath: string): L3ScanState {
  if (!fs.existsSync(cachePath)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), sourceHashes: {}, notices: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Partial<L3ScanState>;
    if (raw && typeof raw === 'object') {
      return {
        version: 1,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        sourceHashes: (raw.sourceHashes as Record<string, string>) ?? {},
        notices: Array.isArray(raw.notices) ? (raw.notices as L3NoticeItem[]) : [],
      };
    }
  } catch {
    // Corrupted: start fresh
  }
  return { version: 1, updatedAt: new Date(0).toISOString(), sourceHashes: {}, notices: [] };
}

export async function runL3Scan(options: L3ScannerOptions = {}): Promise<{
  state: L3ScanState;
  fromCache: boolean;
  requests: number;
}> {
  const nowMs = options.nowMs ?? Date.now();
  const minInterval = options.minIntervalMs ?? DEFAULT_L3_MIN_INTERVAL_MS;
  const sDir = options.stateDir ?? path.join(process.cwd(), '.routersync');
  if (!fs.existsSync(sDir)) fs.mkdirSync(sDir, { recursive: true });

  const cachePath = path.join(sDir, 'l3-cache.json');
  const cached = loadL3Cache(cachePath);
  const lastUpdatedMs = Date.parse(cached.updatedAt);

  if (
    Number.isFinite(lastUpdatedMs) &&
    lastUpdatedMs > 0 &&
    nowMs - lastUpdatedMs >= 0 &&
    nowMs - lastUpdatedMs < minInterval
  ) {
    return { state: cached, fromCache: true, requests: 0 };
  }

  const rawSources = readRegistrySources(options.sourcesFilePath);
  const sources = rawSources.filter(
    (s) => !s.loai || s.loai === 'changelog' || s.loai === 'trang-trang-thai' || s.loai === 'deprecations'
  );
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  let requests = 0;
  const newHashes: Record<string, string> = { ...cached.sourceHashes };
  const allNotices: L3NoticeItem[] = [];

  for (const s of sources) {
    try {
      requests++;
      const res = await fetchFn(s.url, {
        headers: { 'User-Agent': 'routersync-verify/0.1' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 200) {
        const text = await res.text();
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        newHashes[s.id] = hash;
        const parsed = parseChangelogNotices(s.id, s.url, text);
        allNotices.push(...parsed);
      }
    } catch {
      // Non-fatal
    }
  }

  const newState: L3ScanState = {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    sourceHashes: newHashes,
    notices: allNotices.length > 0 ? allNotices : cached.notices,
  };

  fs.writeFileSync(cachePath, JSON.stringify(newState, null, 2), 'utf8');
  return { state: newState, fromCache: false, requests };
}
