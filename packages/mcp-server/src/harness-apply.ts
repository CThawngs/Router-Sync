/**
 * packages/mcp-server/src/harness-apply.ts
 *
 * Self-contained lossless harness config surgery + backup/read-back/byte-exact
 * automatic rollback for MCP `apply_plan` (C45-WP4, Phục vụ: S3, S4, S9).
 *
 * Aligned 100% with WP2 (`packages/cli/src/apps/write-adapter.ts`):
 *  - Hermes: `providers.<id>` AND `custom_providers` (sequence & map) + lossless `models:` insertion + `.env` key check.
 *  - OpenMausBot: `instances.<id>.config.managedModels` insertion + `driver/type === 'openai-compat'` guard + `bots.json`/`routines.json` refusal.
 *  - OpenCode: `provider.<id>.models` map update/insertion + `.env` & `auth.json` key check.
 *  - DSH: Cordis `llm-pi-ai` `providers.<id>.models` update/insertion + full Cordis row/comment non-models digest.
 *  - Cross-adapter guards: `UNKEYED_PROVIDER`, `DEFAULT_SLOT_PROTECTED`, and `NO_PLANNED_CHANGES`.
 *
 * Dependency boundary: uses ONLY `yaml@2.9.1`, Node built-ins, and `@routersync/core`
 * (`getHarnessCapability`, `assertControlledWriteSandbox`, `resolveDeepCanonicalPath`, `isPathInsideDir`, `atomicWriteFileSync`),
 * keeping `@routersync/mcp-server` 100% decoupled from `@routersync/cli`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  assertControlledWriteSandbox,
  atomicWriteFileSync,
  getHarnessCapability,
  isPathInsideDir,
  resolveDeepCanonicalPath,
} from '@routersync/core';

export interface HarnessPlanActionInput {
  harnessId: string;
  configPath: string;
  providerId: string;
  modelId: string;
  action: 'ADD_MODEL' | 'REMOVE_MODEL';
}

export type HarnessPreFlightErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'UNKEYED_PROVIDER'
  | 'DEFAULT_SLOT_PROTECTED'
  | 'NO_PLANNED_CHANGES'
  | 'INVALID_HARNESS_CONFIG';

export type HarnessPreFlightResult =
  | { ok: true }
  | { ok: false; errorCode: HarnessPreFlightErrorCode; message: string };

export interface HarnessControlledApplyResult {
  success: boolean;
  harnessId: string;
  configPath: string;
  backupPath: string;
  readBackVerified: boolean;
  rolledBack: boolean;
  preDigest: string;
  postDigest: string;
  errorCode?: HarnessPreFlightErrorCode | undefined;
  error?: string | undefined;
}

interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
}

interface DefaultSlotEntry {
  rawValue: string;
  providerHint?: string | undefined;
}

interface ProviderMetaDigest {
  endpointFingerprint: string;
  authFingerprint: string;
  nonModelsFingerprint: string;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function detectNewline(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function nonEmptyStr(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLocalRouterPortUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):(?:20128|30128)(?:\/|$)/i.test(rawUrl.trim());
}

const CANONICAL_JSON_SECRET_KEYS = new Set([
  'apikey',
  'key',
  'token',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'secret',
  'secretkey',
  'clientsecret',
  'credential',
  'credentials',
]);

function isCanonicalSecretFieldName(key: string): boolean {
  return CANONICAL_JSON_SECRET_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

function hasJsonSecretField(rec: Record<string, unknown>): boolean {
  return Object.entries(rec).some(
    ([k, v]) => isCanonicalSecretFieldName(k) && typeof v === 'string' && v.trim().length > 0
  );
}

function extractDotEnvValue(rawRhs: string): string {
  const s = rawRhs.trim();
  if (!s || s.startsWith('#')) return '';
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0]!;
    for (let i = 1; i < s.length; i += 1) {
      if (quote === '"' && s[i] === '\\') {
        i += 1;
        continue;
      }
      if (s[i] === quote) {
        return s.slice(1, i).trim();
      }
    }
    return s.slice(1).replace(/\s+#.*$/, '').trim();
  }
  const commentMatch = s.match(/\s+#/);
  const unquoted =
    commentMatch && commentMatch.index !== undefined
      ? s.slice(0, commentMatch.index).trim()
      : s;
  if (unquoted === '""' || unquoted === "''") return '';
  return unquoted;
}

function readEnvVariableNamesOnly(envFilePaths: string[]): Set<string> {
  const keys = new Set<string>();
  for (const envPath of envFilePaths) {
    if (!envPath || !fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m?.[1]) continue;
        const val = extractDotEnvValue(m[2] ?? '');
        if (val.length > 0) keys.add(m[1]);
      }
    } catch {
      // Ignore unreadable .env
    }
  }
  return keys;
}

function extractEnvNameList(raw: unknown): string[] {
  if (typeof raw === 'string') {
    const s = nonEmptyStr(raw);
    return s ? [s] : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => nonEmptyStr(item)).filter((item): item is string => Boolean(item));
  }
  return [];
}

function resolveEffectiveHarnessHomeDir(configPath: string): string | undefined {
  const realTarget = resolveDeepCanonicalPath(configPath);
  const realHome = resolveDeepCanonicalPath(os.homedir());
  const realTmp = resolveDeepCanonicalPath(os.tmpdir());
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const normHome = fold ? realHome.toLowerCase() : realHome;
  const normTmp = fold ? realTmp.toLowerCase() : realTmp;
  if (normHome !== normTmp && !isPathInsideDir(realHome, realTmp) && isPathInsideDir(realTarget, realTmp)) {
    return undefined;
  }
  return isPathInsideDir(realTarget, realHome) ? os.homedir() : undefined;
}

function readOpenCodeAuthProviders(homeDir?: string): Set<string> {
  const out = new Set<string>();
  if (!homeDir) return out;
  const authPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
  if (!fs.existsSync(authPath)) return out;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && (typeof v === 'object' || typeof v === 'string')) {
          out.add(k);
        }
      }
    }
  } catch {
    // Ignore unreadable auth.json
  }
  return out;
}

function applySpanReplacements(text: string, edits: SpanEdit[]): string {
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let prevStart = text.length + 1;
  let out = text;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > prevStart) {
      throw new Error(`Invalid or overlapping span edit [${edit.start}, ${edit.end}]`);
    }
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    prevStart = edit.start;
  }
  return out;
}

function getLineIndentAt(text: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) {
    lineStart -= 1;
  }
  let cursor = lineStart;
  while (cursor < offset && (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9)) {
    cursor += 1;
  }
  return text.slice(lineStart, cursor);
}

/**
 * Computes exact column indentation for a YAML mapping key, converting leading
 * sequence markers (`- `) on the first key of a sequence-item map into spaces.
 */
function getYamlKeyColumnIndent(text: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) {
    lineStart -= 1;
  }
  return text.slice(lineStart, offset).replace(/[^\t]/g, ' ');
}

// ---------------------------------------------------------------------------
// Minimal Lossless JSON / JSONC AST
// ---------------------------------------------------------------------------

type JsoncNode = JsoncObjectNode | JsoncArrayNode | JsoncStringNode | JsoncPrimitiveNode;

interface JsoncPropertyNode {
  key: string;
  keyStart: number;
  keyEnd: number;
  colonIndex: number;
  value: JsoncNode;
  start: number;
  end: number;
}

interface JsoncObjectNode {
  kind: 'object';
  start: number;
  end: number;
  properties: JsoncPropertyNode[];
}

interface JsoncArrayNode {
  kind: 'array';
  start: number;
  end: number;
  elements: JsoncNode[];
}

interface JsoncStringNode {
  kind: 'string';
  start: number;
  end: number;
  value: string;
}

interface JsoncPrimitiveNode {
  kind: 'primitive';
  start: number;
  end: number;
  value: number | boolean | null;
}

function parseJsoncRoot(text: string): JsoncNode {
  let pos = text.startsWith('\uFEFF') ? 1 : 0;
  const len = text.length;

  function skipTrivia(): void {
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        pos += 1;
        continue;
      }
      if (ch === 47 && pos + 1 < len) {
        const next = text.charCodeAt(pos + 1);
        if (next === 47) {
          pos += 2;
          while (pos < len && text.charCodeAt(pos) !== 10) pos += 1;
          continue;
        }
        if (next === 42) {
          pos += 2;
          let closed = false;
          while (pos + 1 < len) {
            if (text.charCodeAt(pos) === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              closed = true;
              break;
            }
            pos += 1;
          }
          if (!closed) throw new SyntaxError('Unterminated JSONC block comment');
          continue;
        }
      }
      break;
    }
  }

  function parseString(): JsoncStringNode {
    const start = pos;
    if (text.charCodeAt(pos) !== 34) throw new SyntaxError(`Expected '"' at ${pos}`);
    pos += 1;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 92) {
        pos += 2;
        continue;
      }
      if (ch === 34) {
        pos += 1;
        return { kind: 'string', start, end: pos, value: JSON.parse(text.slice(start, pos)) as string };
      }
      if (ch < 32) throw new SyntaxError(`Control char in string at ${pos}`);
      pos += 1;
    }
    throw new SyntaxError('Unterminated string');
  }

  function parseObject(): JsoncObjectNode {
    const start = pos;
    pos += 1;
    const properties: JsoncPropertyNode[] = [];
    skipTrivia();
    if (pos < len && text.charCodeAt(pos) === 125) {
      pos += 1;
      return { kind: 'object', start, end: pos, properties };
    }
    while (pos < len) {
      skipTrivia();
      if (pos < len && text.charCodeAt(pos) === 125) {
        pos += 1;
        return { kind: 'object', start, end: pos, properties };
      }
      const keyNode = parseString();
      skipTrivia();
      if (pos >= len || text.charCodeAt(pos) !== 58) throw new SyntaxError(`Expected ':' at ${pos}`);
      const colonIndex = pos;
      pos += 1;
      skipTrivia();
      const valNode = parseValue();
      properties.push({
        key: keyNode.value,
        keyStart: keyNode.start,
        keyEnd: keyNode.end,
        colonIndex,
        value: valNode,
        start: keyNode.start,
        end: valNode.end,
      });
      skipTrivia();
      if (pos < len && text.charCodeAt(pos) === 44) {
        pos += 1;
        continue;
      }
      if (pos < len && text.charCodeAt(pos) === 125) {
        pos += 1;
        return { kind: 'object', start, end: pos, properties };
      }
      throw new SyntaxError(`Expected ',' or '}' at ${pos}`);
    }
    throw new SyntaxError('Unterminated object');
  }

  function parseArray(): JsoncArrayNode {
    const start = pos;
    pos += 1;
    const elements: JsoncNode[] = [];
    skipTrivia();
    if (pos < len && text.charCodeAt(pos) === 93) {
      pos += 1;
      return { kind: 'array', start, end: pos, elements };
    }
    while (pos < len) {
      skipTrivia();
      if (pos < len && text.charCodeAt(pos) === 93) {
        pos += 1;
        return { kind: 'array', start, end: pos, elements };
      }
      elements.push(parseValue());
      skipTrivia();
      if (pos < len && text.charCodeAt(pos) === 44) {
        pos += 1;
        continue;
      }
      if (pos < len && text.charCodeAt(pos) === 93) {
        pos += 1;
        return { kind: 'array', start, end: pos, elements };
      }
      throw new SyntaxError(`Expected ',' or ']' at ${pos}`);
    }
    throw new SyntaxError('Unterminated array');
  }

  function parsePrimitive(): JsoncPrimitiveNode {
    const start = pos;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44 || ch === 125 || ch === 93 || ch === 47) {
        break;
      }
      pos += 1;
    }
    const token = text.slice(start, pos);
    return { kind: 'primitive', start, end: pos, value: JSON.parse(token) as number | boolean | null };
  }

  function parseValue(): JsoncNode {
    skipTrivia();
    if (pos >= len) throw new SyntaxError('Unexpected end of JSONC input');
    const ch = text.charCodeAt(pos);
    if (ch === 123) return parseObject();
    if (ch === 91) return parseArray();
    if (ch === 34) return parseString();
    return parsePrimitive();
  }

  const root = parseValue();
  skipTrivia();
  if (pos !== len) throw new SyntaxError(`Trailing token at ${pos}`);
  return root;
}

function jsoncNodeToValue(node: JsoncNode): unknown {
  switch (node.kind) {
    case 'string':
    case 'primitive':
      return node.value;
    case 'array':
      return node.elements.map(jsoncNodeToValue);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) out[prop.key] = jsoncNodeToValue(prop.value);
      return out;
    }
  }
}

function findJsoncProperty(obj: JsoncObjectNode, key: string): JsoncPropertyNode | undefined {
  return obj.properties.find((p) => p.key === key);
}

function formatYamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function buildYamlModelsSeqEdit(
  text: string,
  seqNode: YAMLSeq,
  removeSet: ReadonlySet<string>,
  addIds: readonly string[]
): SpanEdit | null {
  if (!seqNode.range) throw new Error('YAML sequence node missing range');
  const nl = detectNewline(text);
  const [seqStart, seqValueEnd] = seqNode.range;
  const firstItem = seqNode.items[0];
  const useMapItems = isMap(firstItem);
  const mapHasName =
    useMapItems &&
    (firstItem as YAMLMap).items.some(
      (pair) => isScalar(pair.key) && String(pair.key.value) === 'name'
    );

  const rawSeq = text.slice(seqStart, seqValueEnd).trim();
  if (Boolean((seqNode as { flow?: boolean }).flow) || rawSeq.startsWith('[')) {
    const flowParts: string[] = [];
    for (const item of seqNode.items) {
      let modelId = '';
      if (isScalar(item)) modelId = String(item.value ?? '').trim();
      else if (isMap(item)) modelId = String(item.get('id') ?? '').trim();
      if (modelId && removeSet.has(modelId)) continue;
      const itemRange = (item as { range?: [number, number, number] }).range;
      flowParts.push(itemRange ? text.slice(itemRange[0], itemRange[1]).trim() : formatYamlScalar(modelId));
    }
    for (const id of addIds) {
      if (useMapItems) {
        flowParts.push(`{ id: ${JSON.stringify(id)}${mapHasName ? `, name: ${JSON.stringify(id)}` : ''} }`);
      } else {
        flowParts.push(JSON.stringify(id));
      }
    }
    return { start: seqStart, end: seqValueEnd, replacement: `[${flowParts.join(', ')}]` };
  }

  const itemIndent = getLineIndentAt(text, seqStart);
  const segments: string[] = [];
  let kept = 0;
  let prevEnd = seqStart;

  for (let idx = 0; idx < seqNode.items.length; idx++) {
    const item = seqNode.items[idx];
    const itemRange = (item as { range?: [number, number, number] } | undefined)?.range;
    if (!itemRange) continue;
    let dashPos = itemRange[0];
    while (dashPos > seqStart && text.charCodeAt(dashPos - 1) !== 45) dashPos -= 1;
    if (dashPos > seqStart && text.charCodeAt(dashPos - 1) === 45) dashPos -= 1;
    else if (dashPos > 0 && dashPos !== seqStart && text.charCodeAt(dashPos - 1) === 45) dashPos -= 1;

    let itemLineStart = dashPos;
    if (idx > 0) {
      while (
        itemLineStart > prevEnd &&
        (text.charCodeAt(itemLineStart - 1) === 32 || text.charCodeAt(itemLineStart - 1) === 9)
      ) {
        itemLineStart -= 1;
      }
      if (itemLineStart > prevEnd) {
        const inter = text.slice(prevEnd, itemLineStart);
        if (inter.trim().length > 0) segments.push(inter.endsWith('\n') ? inter : `${inter}${nl}`);
      }
    }
    prevEnd = itemRange[2];

    let modelId = '';
    if (isScalar(item)) modelId = String(item.value ?? '').trim();
    else if (isMap(item)) modelId = String(item.get('id') ?? '').trim();
    if (modelId && removeSet.has(modelId)) continue;

    let slice = text.slice(dashPos, itemRange[2]);
    if (!slice.endsWith('\n')) slice += nl;
    segments.push(`${itemIndent}${slice}`);
    kept++;
  }

  for (const id of addIds) {
    if (useMapItems) {
      const safeId = formatYamlScalar(id);
      const nameLine = mapHasName ? `${nl}${itemIndent}  name: ${safeId}` : '';
      segments.push(`${itemIndent}- id: ${safeId}${nameLine}${nl}`);
    } else {
      segments.push(`${itemIndent}- ${formatYamlScalar(id)}${nl}`);
    }
    kept++;
  }

  if (kept === 0) {
    return { start: seqStart, end: seqValueEnd, replacement: `[]${nl}` };
  }
  const joined = segments.join('');
  const replacement = joined.startsWith(itemIndent) ? joined.slice(itemIndent.length) : joined;
  return { start: seqStart, end: seqValueEnd, replacement };
}

function buildYamlMissingModelsInsertionEdit(
  text: string,
  mapNode: YAMLMap,
  addIds: readonly string[],
  fallbackIndent: string
): SpanEdit | null {
  if (addIds.length === 0 || !mapNode.range) return null;
  const nl = detectNewline(text);
  const firstPair = mapNode.items[0];
  const keyRange = (firstPair?.key as { range?: [number, number, number] } | undefined)?.range;
  const propIndent = keyRange ? getYamlKeyColumnIndent(text, keyRange[0]) : fallbackIndent;
  const insertPos = mapNode.range[1];
  const prefix = insertPos > 0 && text.charCodeAt(insertPos - 1) !== 10 ? nl : '';
  const lines = addIds.map((id) => `${propIndent}  - id: ${formatYamlScalar(id)}`).join(nl);
  return {
    start: insertPos,
    end: insertPos,
    replacement: `${prefix}${propIndent}models:${nl}${lines}${nl}`,
  };
}

function omitKeysSorted(obj: Record<string, unknown>, omit: readonly string[]): Record<string, unknown> {
  const omitSet = new Set(omit);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (!omitSet.has(k)) out[k] = obj[k];
  }
  return out;
}

function extractYamlSeqIds(seq: YAMLSeq | undefined): string[] {
  if (!seq || !isSeq(seq)) return [];
  const out: string[] = [];
  for (const item of seq.items) {
    if (isScalar(item) && String(item.value ?? '').trim()) out.push(String(item.value).trim());
    else if (isMap(item) && String(item.get('id') ?? '').trim()) out.push(String(item.get('id')).trim());
  }
  return out;
}

function extractYamlCommentsOutsideSpans(
  text: string,
  excludedSpans: ReadonlyArray<[number, number]>
): string[] {
  const comments: string[] = [];
  let lineStart = 0;
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const lineEnd = lineStart + rawLine.length;
    const inExcluded = excludedSpans.some(([s, e]) => lineStart >= s && lineEnd <= e);
    if (!inExcluded) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('#')) {
        comments.push(trimmed);
      }
    }
    lineStart = lineEnd + 1;
  }
  return comments;
}

interface HarnessSnapshotView {
  providerModels: Map<string, string[]>;
  keyedProviders: Set<string>;
  defaultSlots: Map<string, DefaultSlotEntry>;
  providerMeta: Map<string, ProviderMetaDigest>;
  nonModelsDigest: string;
  applyChanges: (changes: Map<string, { removeSet: Set<string>; addIds: string[] }>) => string;
}

function serializeSlotsAndMeta(
  defaultSlots: Map<string, DefaultSlotEntry>,
  providerMeta: Map<string, ProviderMetaDigest>
): Record<string, unknown> {
  const slotsObj: Record<string, DefaultSlotEntry> = {};
  for (const k of [...defaultSlots.keys()].sort()) {
    slotsObj[k] = defaultSlots.get(k)!;
  }
  const metaObj: Record<string, ProviderMetaDigest> = {};
  for (const k of [...providerMeta.keys()].sort()) {
    metaObj[k] = providerMeta.get(k)!;
  }
  return { slots: slotsObj, meta: metaObj };
}

function parseHarnessSnapshot(
  harnessId: string,
  text: string,
  configPath: string
): HarnessSnapshotView {
  const homeDir = resolveEffectiveHarnessHomeDir(configPath);

  // -------------------------------------------------------------------------
  // 1. OpenCode (`opencode.json` / `opencode.jsonc`)
  // -------------------------------------------------------------------------
  if (harnessId === 'opencode') {
    const node = parseJsoncRoot(text);
    if (node.kind !== 'object') throw new Error('OpenCode root must be a JSONC object');
    const val = jsoncNodeToValue(node) as Record<string, unknown>;
    const authProviders = readOpenCodeAuthProviders(homeDir);
    const envPaths = [path.join(path.dirname(configPath), '.env')];
    if (homeDir) {
      envPaths.push(
        path.join(homeDir, '.config', 'opencode', '.env'),
        path.join(homeDir, '.env')
      );
    }
    const envKeys = readEnvVariableNamesOnly(envPaths);

    const providerModels = new Map<string, string[]>();
    const keyedProviders = new Set<string>();
    const defaultSlots = new Map<string, DefaultSlotEntry>();
    const providerMeta = new Map<string, ProviderMetaDigest>();
    const modelsNodes = new Map<
      string,
      { provNode: JsoncObjectNode; modelsNode?: JsoncObjectNode | undefined }
    >();

    for (const slotKey of ['model', 'small_model', 'default_model'] as const) {
      const sv = nonEmptyStr(val[slotKey]);
      if (sv) defaultSlots.set(slotKey, { rawValue: sv });
    }
    const agentVal = val['agent'];
    if (agentVal && typeof agentVal === 'object' && !Array.isArray(agentVal)) {
      for (const [agentName, rawCfg] of Object.entries(agentVal as Record<string, unknown>)) {
        if (rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg)) {
          const am = nonEmptyStr((rawCfg as Record<string, unknown>)['model']);
          if (am) defaultSlots.set(`agent.${agentName}.model`, { rawValue: am });
        }
      }
    }

    const provProp = findJsoncProperty(node, 'provider');
    if (provProp && provProp.value.kind === 'object') {
      for (const p of provProp.value.properties) {
        if (p.value.kind !== 'object') continue;
        const provId = p.key;
        const pVal = jsoncNodeToValue(p.value) as Record<string, unknown>;
        const optsVal =
          pVal['options'] && typeof pVal['options'] === 'object' && !Array.isArray(pVal['options'])
            ? (pVal['options'] as Record<string, unknown>)
            : {};

        const configuredEnvNames = [
          ...extractEnvNameList(pVal['env']),
          ...extractEnvNameList(optsVal['env']),
          ...extractEnvNameList(pVal['apiKeyEnv']),
          ...extractEnvNameList(optsVal['apiKeyEnv']),
        ];
        const hasEnvKey = configuredEnvNames.some((envName) => envKeys.has(envName));
        const baseUrl =
          nonEmptyStr(optsVal['baseURL']) ??
          nonEmptyStr(optsVal['base_url']) ??
          nonEmptyStr(optsVal['url']) ??
          nonEmptyStr(pVal['baseURL']);
        const hasKey =
          hasJsonSecretField(optsVal) ||
          hasJsonSecretField(pVal) ||
          hasEnvKey ||
          authProviders.has(provId) ||
          isLocalRouterPortUrl(baseUrl);

        const mProp = findJsoncProperty(p.value, 'models');
        const mNode = mProp && mProp.value.kind === 'object' ? mProp.value : undefined;
        providerModels.set(provId, mNode ? mNode.properties.map((mp) => mp.key) : []);
        modelsNodes.set(provId, { provNode: p.value, modelsNode: mNode });

        const optSecrets = Object.entries(optsVal)
          .filter(([k]) => isCanonicalSecretFieldName(k))
          .sort(([a], [b]) => a.localeCompare(b));
        const topSecrets = Object.entries(pVal)
          .filter(([k]) => isCanonicalSecretFieldName(k))
          .sort(([a], [b]) => a.localeCompare(b));

        providerMeta.set(provId, {
          endpointFingerprint: sha256Hex(
            JSON.stringify({
              optsBaseURL: optsVal['baseURL'] ?? null,
              optsBaseUrl: optsVal['base_url'] ?? null,
              optsUrl: optsVal['url'] ?? null,
              topBaseURL: pVal['baseURL'] ?? null,
            })
          ),
          authFingerprint: sha256Hex(
            JSON.stringify({
              optSecrets,
              topSecrets,
              env: pVal['env'] ?? null,
              optsEnv: optsVal['env'] ?? null,
              hasKey,
            })
          ),
          nonModelsFingerprint: sha256Hex(JSON.stringify(omitKeysSorted(pVal, ['models']))),
        });

        if (hasKey) keyedProviders.add(provId);
      }
    }

    const nonModelsDigest = sha256Hex(
      JSON.stringify({
        top: omitKeysSorted(val, ['provider']),
        ...serializeSlotsAndMeta(defaultSlots, providerMeta),
      })
    );

    return {
      providerModels,
      keyedProviders,
      defaultSlots,
      providerMeta,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        const nl = detectNewline(text);
        for (const [provId, ch] of changes.entries()) {
          if (ch.removeSet.size === 0 && ch.addIds.length === 0) continue;
          const target = modelsNodes.get(provId);
          if (!target) throw new Error(`Provider '${provId}' not found in opencode config`);
          const current = new Set(providerModels.get(provId) ?? []);
          const dedupedAdd = ch.addIds.filter((id) => !current.has(id));
          if (target.modelsNode) {
            const mObj = target.modelsNode;
            const closingIndent = getLineIndentAt(text, mObj.end - 1);
            const firstProp = mObj.properties[0];
            const itemIndent = firstProp ? getLineIndentAt(text, firstProp.keyStart) : `${closingIndent}  `;
            const keptProps: string[] = [];
            for (const prop of mObj.properties) {
              if (ch.removeSet.has(prop.key)) continue;
              keptProps.push(`${itemIndent}${text.slice(prop.start, prop.end)}`);
            }
            for (const addId of dedupedAdd) {
              keptProps.push(`${itemIndent}${JSON.stringify(addId)}: { "name": ${JSON.stringify(addId)} }`);
            }
            const replacement =
              keptProps.length === 0
                ? '{}'
                : `{${nl}${keptProps.join(`,${nl}`)}${nl}${closingIndent}}`;
            edits.push({ start: mObj.start, end: mObj.end, replacement });
          } else if (dedupedAdd.length > 0) {
            const closingIndent = getLineIndentAt(text, target.provNode.end - 1);
            const propIndent = target.provNode.properties[0]
              ? getLineIndentAt(text, target.provNode.properties[0].keyStart)
              : `${closingIndent}  `;
            const inner = dedupedAdd
              .map((id) => `${propIndent}  ${JSON.stringify(id)}: { "name": ${JSON.stringify(id)} }`)
              .join(`,${nl}`);
            const block = `"models": {${nl}${inner}${nl}${propIndent}}`;
            const last = target.provNode.properties[target.provNode.properties.length - 1];
            if (last) {
              edits.push({ start: last.end, end: last.end, replacement: `,${nl}${propIndent}${block}` });
            } else {
              edits.push({
                start: target.provNode.start,
                end: target.provNode.end,
                replacement: `{${nl}${propIndent}${block}${nl}${closingIndent}}`,
              });
            }
          }
        }
        const next = applySpanReplacements(text, edits);
        parseJsoncRoot(next);
        return next;
      },
    };
  }

  // -------------------------------------------------------------------------
  // 2. OpenMausBot (`config.json` -> `instances.<id>.config.managedModels`)
  // -------------------------------------------------------------------------
  if (harnessId === 'openmausbot') {
    const lexicalBase = path.basename(configPath).toLowerCase();
    const realBase = path.basename(resolveDeepCanonicalPath(configPath)).toLowerCase();
    if (
      lexicalBase === 'bots.json' ||
      lexicalBase === 'routines.json' ||
      realBase === 'bots.json' ||
      realBase === 'routines.json'
    ) {
      throw new Error('OpenMausBot safety guard: refusing to access bots.json or routines.json.');
    }

    const node = parseJsoncRoot(text);
    if (node.kind !== 'object') throw new Error('OpenMausBot config root must be an object');
    const val = jsoncNodeToValue(node) as Record<string, unknown>;
    const providerModels = new Map<string, string[]>();
    const keyedProviders = new Set<string>();
    const defaultSlots = new Map<string, DefaultSlotEntry>();
    const providerMeta = new Map<string, ProviderMetaDigest>();
    const cfgNodes = new Map<string, JsoncObjectNode>();

    const topDef = val['defaultModelSelection'];
    if (typeof topDef === 'string' && topDef.trim()) {
      defaultSlots.set('defaultModelSelection', { rawValue: topDef.trim() });
    } else if (topDef && typeof topDef === 'object' && !Array.isArray(topDef)) {
      const nestedModel = nonEmptyStr((topDef as Record<string, unknown>)['model']);
      if (nestedModel) {
        defaultSlots.set('defaultModelSelection', {
          rawValue: nestedModel,
          providerHint: nonEmptyStr((topDef as Record<string, unknown>)['provider']),
        });
      }
    }

    const autoRecovery = val['automaticRecovery'];
    if (autoRecovery && typeof autoRecovery === 'object' && !Array.isArray(autoRecovery)) {
      const backupRaw = (autoRecovery as Record<string, unknown>)['backup'];
      if (typeof backupRaw === 'string' && backupRaw.trim()) {
        defaultSlots.set('automaticRecovery.backup', { rawValue: backupRaw.trim() });
      } else if (backupRaw && typeof backupRaw === 'object' && !Array.isArray(backupRaw)) {
        const rec = backupRaw as Record<string, unknown>;
        const bm = nonEmptyStr(rec['model']);
        if (bm) {
          defaultSlots.set('automaticRecovery.backup', {
            rawValue: bm,
            providerHint: nonEmptyStr(rec['provider']) ?? nonEmptyStr(rec['instanceId']),
          });
        }
      } else if (Array.isArray(backupRaw)) {
        backupRaw.forEach((entry, idx) => {
          const slotKey = idx === 0 ? 'automaticRecovery.backup' : `automaticRecovery.backup[${idx}]`;
          if (typeof entry === 'string' && entry.trim()) {
            defaultSlots.set(slotKey, { rawValue: entry.trim() });
          } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const rec = entry as Record<string, unknown>;
            const bm = nonEmptyStr(rec['model']);
            if (bm) {
              defaultSlots.set(slotKey, {
                rawValue: bm,
                providerHint: nonEmptyStr(rec['provider']) ?? nonEmptyStr(rec['instanceId']),
              });
            }
          }
        });
      }
    }

    const decider = val['decider'];
    if (decider && typeof decider === 'object' && !Array.isArray(decider)) {
      const dm = nonEmptyStr((decider as Record<string, unknown>)['openrouterModel']);
      if (dm) defaultSlots.set('decider.openrouterModel', { rawValue: dm });
    }

    const instProp = findJsoncProperty(node, 'instances');
    if (instProp && instProp.value.kind === 'object') {
      for (const ip of instProp.value.properties) {
        if (ip.value.kind !== 'object') continue;
        const instId = ip.key;
        const iVal = jsoncNodeToValue(ip.value) as Record<string, unknown>;
        const instKind = nonEmptyStr(iVal['driver']) ?? nonEmptyStr(iVal['type']);
        const cProp = findJsoncProperty(ip.value, 'config');
        if (!cProp || cProp.value.kind !== 'object') continue;

        const cVal = jsoncNodeToValue(cProp.value) as Record<string, unknown>;
        const models = Array.isArray(cVal['managedModels'])
          ? (cVal['managedModels'] as unknown[])
              .map((x) => nonEmptyStr(x))
              .filter((x): x is string => Boolean(x))
          : [];
        providerModels.set(instId, models);
        cfgNodes.set(instId, cProp.value);

        const instModel = nonEmptyStr(cVal['model']);
        if (instModel) {
          defaultSlots.set(`instances.${instId}.config.model`, {
            rawValue: instModel,
            providerHint: instId,
          });
        }

        const isEditableDriver = instKind === 'openai-compat';
        const urlVal =
          nonEmptyStr(cVal['url']) ??
          nonEmptyStr(cVal['baseURL']) ??
          nonEmptyStr(cVal['baseUrl']);
        const hasSecret = hasJsonSecretField(cVal);
        const isKeyed = isEditableDriver && (hasSecret || isLocalRouterPortUrl(urlVal));

        const secretPairs = Object.entries(cVal)
          .filter(([k]) => isCanonicalSecretFieldName(k))
          .sort(([a], [b]) => a.localeCompare(b));

        providerMeta.set(instId, {
          endpointFingerprint: sha256Hex(
            JSON.stringify({
              url: cVal['url'] ?? null,
              baseURL: cVal['baseURL'] ?? null,
              baseUrl: cVal['baseUrl'] ?? null,
            })
          ),
          authFingerprint: sha256Hex(JSON.stringify({ secretPairs, isKeyed })),
          nonModelsFingerprint: sha256Hex(
            JSON.stringify({
              top: omitKeysSorted(iVal, ['config']),
              cfg: omitKeysSorted(cVal, ['managedModels']),
            })
          ),
        });

        if (isKeyed) keyedProviders.add(instId);
      }
    }

    const nonModelsDigest = sha256Hex(
      JSON.stringify({
        top: omitKeysSorted(val, ['instances']),
        ...serializeSlotsAndMeta(defaultSlots, providerMeta),
      })
    );

    return {
      providerModels,
      keyedProviders,
      defaultSlots,
      providerMeta,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        const nl = detectNewline(text);
        for (const [instId, ch] of changes.entries()) {
          if (ch.removeSet.size === 0 && ch.addIds.length === 0) continue;
          const cfgNode = cfgNodes.get(instId);
          if (!cfgNode) throw new Error(`Instance '${instId}' not found in openmausbot config`);
          const current = providerModels.get(instId) ?? [];
          const kept = current.filter((m) => !ch.removeSet.has(m));
          for (const addId of ch.addIds) {
            if (!kept.includes(addId)) kept.push(addId);
          }
          const mProp = findJsoncProperty(cfgNode, 'managedModels');
          if (mProp && mProp.value.kind === 'array') {
            const arr = mProp.value;
            const rawSlice = text.slice(arr.start, arr.end);
            let replacement: string;
            if (!rawSlice.includes('\n')) {
              replacement = `[${kept.map((v) => JSON.stringify(v)).join(', ')}]`;
            } else if (kept.length === 0) {
              replacement = '[]';
            } else {
              const closingIndent = getLineIndentAt(text, arr.end - 1);
              const elemIndent = arr.elements[0]
                ? getLineIndentAt(text, arr.elements[0].start)
                : `${closingIndent}  `;
              replacement = `[${nl}${kept.map((v) => `${elemIndent}${JSON.stringify(v)}`).join(`,${nl}`)}${nl}${closingIndent}]`;
            }
            edits.push({ start: arr.start, end: arr.end, replacement });
          } else if (kept.length > 0) {
            const closingIndent = getLineIndentAt(text, cfgNode.end - 1);
            const propIndent = cfgNode.properties[0]
              ? getLineIndentAt(text, cfgNode.properties[0].keyStart)
              : `${closingIndent}  `;
            const arrLiteral = `[${nl}${kept
              .map((m) => `${propIndent}  ${JSON.stringify(m)}`)
              .join(`,${nl}`)}${nl}${propIndent}]`;
            if (cfgNode.properties.length === 0) {
              edits.push({
                start: cfgNode.start,
                end: cfgNode.end,
                replacement: `{${nl}${propIndent}"managedModels": ${arrLiteral}${nl}${closingIndent}}`,
              });
            } else {
              const lastProp = cfgNode.properties[cfgNode.properties.length - 1]!;
              edits.push({
                start: lastProp.end,
                end: lastProp.end,
                replacement: `,${nl}${propIndent}"managedModels": ${arrLiteral}`,
              });
            }
          }
        }
        const next = applySpanReplacements(text, edits);
        JSON.parse(next);
        return next;
      },
    };
  }

  // -------------------------------------------------------------------------
  // 3. Hermes (`config.yaml` + sibling `.env`, `providers` & `custom_providers`)
  // -------------------------------------------------------------------------
  if (harnessId === 'hermes') {
    const doc = parseDocument(text, { logLevel: 'silent' });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      throw new Error(`Invalid Hermes YAML: ${doc.errors[0]?.message ?? 'root not map'}`);
    }
    const root = doc.contents;
    const envPaths = [path.join(path.dirname(configPath), '.env')];
    if (homeDir) {
      envPaths.push(path.join(homeDir, '.hermes', '.env'));
    }
    const envKeys = readEnvVariableNamesOnly(envPaths);

    const providerModels = new Map<string, string[]>();
    const keyedProviders = new Set<string>();
    const defaultSlots = new Map<string, DefaultSlotEntry>();
    const providerMeta = new Map<string, ProviderMetaDigest>();
    const providerTargets = new Map<string, { mapNode: YAMLMap; seqNode?: YAMLSeq | undefined }>();
    const excludedModelSpans: Array<[number, number]> = [];

    const modelMap = root.get('model', true);
    let mainProviderHint: string | undefined;
    if (isMap(modelMap)) {
      mainProviderHint = nonEmptyStr(modelMap.get('provider'));
      const defModel = nonEmptyStr(modelMap.get('default'));
      if (defModel) {
        defaultSlots.set('model.default', { rawValue: defModel, providerHint: mainProviderHint });
      }
    }

    const cronMap = root.get('cron', true);
    if (isMap(cronMap)) {
      const cronModel = nonEmptyStr(cronMap.get('model'));
      const cronProv = nonEmptyStr(cronMap.get('model_provider')) ?? mainProviderHint;
      if (cronModel) {
        defaultSlots.set('cron.model', { rawValue: cronModel, providerHint: cronProv });
      }
    }

    const registerHermesProviderMap = (pId: string, pMap: YAMLMap, slotPrefix?: string) => {
      const inlineKey =
        nonEmptyStr(pMap.get('api_key')) ??
        nonEmptyStr(pMap.get('apiKey')) ??
        nonEmptyStr(pMap.get('key'));
      const keyEnvName = nonEmptyStr(pMap.get('key_env')) ?? nonEmptyStr(pMap.get('api_key_env'));
      const hasEnvKey = Boolean(keyEnvName && envKeys.has(keyEnvName));
      const baseUrl =
        nonEmptyStr(pMap.get('base_url')) ??
        nonEmptyStr(pMap.get('baseURL')) ??
        nonEmptyStr(pMap.get('url'));
      const isKeyed = Boolean(inlineKey) || hasEnvKey || isLocalRouterPortUrl(baseUrl);

      if (slotPrefix) {
        const slotModel = nonEmptyStr(pMap.get('model'));
        if (slotModel) {
          defaultSlots.set(slotPrefix, { rawValue: slotModel, providerHint: pId });
        }
      }

      const mRaw = pMap.get('models', true);
      const seq = isSeq(mRaw) ? mRaw : undefined;
      if (seq?.range) excludedModelSpans.push([seq.range[0], seq.range[2]]);
      providerModels.set(pId, extractYamlSeqIds(seq));
      providerTargets.set(pId, { mapNode: pMap, seqNode: seq });

      const rawJs = (pMap.toJS(doc) ?? {}) as Record<string, unknown>;
      providerMeta.set(pId, {
        endpointFingerprint: sha256Hex(
          JSON.stringify({
            base_url: rawJs['base_url'] ?? null,
            baseURL: rawJs['baseURL'] ?? null,
            url: rawJs['url'] ?? null,
          })
        ),
        authFingerprint: sha256Hex(
          JSON.stringify({
            api_key: rawJs['api_key'] ?? null,
            apiKey: rawJs['apiKey'] ?? null,
            key: rawJs['key'] ?? null,
            key_env: rawJs['key_env'] ?? null,
            api_key_env: rawJs['api_key_env'] ?? null,
            isKeyed,
          })
        ),
        nonModelsFingerprint: sha256Hex(JSON.stringify(omitKeysSorted(rawJs, ['models']))),
      });

      if (isKeyed) keyedProviders.add(pId);
    };

    const providersNode = root.get('providers', true);
    if (isMap(providersNode)) {
      for (const pair of providersNode.items) {
        if (!isScalar(pair.key) || !isMap(pair.value)) continue;
        const pId = String(pair.key.value ?? '').trim();
        if (pId) registerHermesProviderMap(pId, pair.value);
      }
    }

    const customProvidersNode = root.get('custom_providers', true);
    if (isSeq(customProvidersNode)) {
      customProvidersNode.items.forEach((item, idx) => {
        if (!isMap(item)) return;
        const pId = nonEmptyStr(item.get('name')) ?? nonEmptyStr(item.get('id'));
        if (pId) registerHermesProviderMap(pId, item, `custom_providers[${idx}].model`);
      });
    } else if (isMap(customProvidersNode)) {
      for (const pair of customProvidersNode.items) {
        if (!isScalar(pair.key) || !isMap(pair.value)) continue;
        const pId = String(pair.key.value ?? '').trim();
        if (pId) registerHermesProviderMap(pId, pair.value, `custom_providers.${pId}.model`);
      }
    }

    const rootJs = (doc.toJS() ?? {}) as Record<string, unknown>;
    const nonModelsDigest = sha256Hex(
      JSON.stringify({
        top: omitKeysSorted(rootJs, ['providers', 'custom_providers']),
        comments: extractYamlCommentsOutsideSpans(text, excludedModelSpans),
        ...serializeSlotsAndMeta(defaultSlots, providerMeta),
      })
    );

    return {
      providerModels,
      keyedProviders,
      defaultSlots,
      providerMeta,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        for (const [pId, ch] of changes.entries()) {
          if (ch.removeSet.size === 0 && ch.addIds.length === 0) continue;
          const target = providerTargets.get(pId);
          if (!target) throw new Error(`Provider '${pId}' not found in Hermes YAML`);
          const keptAdd = ch.addIds.filter((id) => !(providerModels.get(pId) ?? []).includes(id));
          if (target.seqNode) {
            const edit = buildYamlModelsSeqEdit(text, target.seqNode, ch.removeSet, keptAdd);
            if (edit) edits.push(edit);
          } else {
            const insertEdit = buildYamlMissingModelsInsertionEdit(
              text,
              target.mapNode,
              keptAdd,
              '    '
            );
            if (insertEdit) edits.push(insertEdit);
          }
        }
        const next = applySpanReplacements(text, edits);
        const check = parseDocument(next, { logLevel: 'silent' });
        if (check.errors.length > 0 || !isMap(check.contents)) {
          throw new Error(`Hermes YAML invalid after edit: ${check.errors[0]?.message ?? 'invalid root'}`);
        }
        return next;
      },
    };
  }

  // -------------------------------------------------------------------------
  // 4. DSH (`cordis.patch.yml` -> `llm-pi-ai` `providers.<id>.models[]`)
  // -------------------------------------------------------------------------
  if (harnessId === 'dsh') {
    const doc = parseDocument(text, { logLevel: 'silent' });
    if (doc.errors.length > 0 || !isSeq(doc.contents)) {
      throw new Error(`Invalid DSH YAML: ${doc.errors[0]?.message ?? 'root not sequence'}`);
    }

    const providerModels = new Map<string, string[]>();
    const keyedProviders = new Set<string>();
    const defaultSlots = new Map<string, DefaultSlotEntry>();
    const providerMeta = new Map<string, ProviderMetaDigest>();
    const providerTargets = new Map<string, { mapNode: YAMLMap; seqNode?: YAMLSeq | undefined }>();
    const excludedModelSpans: Array<[number, number]> = [];

    const rows: YAMLMap[] = [];
    for (const item of doc.contents.items) {
      if (!isMap(item)) continue;
      const ins = item.get('insert', true);
      if (isSeq(ins)) {
        for (const nested of ins.items) if (isMap(nested)) rows.push(nested);
      } else {
        rows.push(item);
      }
    }

    for (const row of rows) {
      const id = nonEmptyStr(row.get('id'));
      const name = nonEmptyStr(row.get('name'));
      const cfg = row.get('config', true);
      if (!isMap(cfg)) continue;

      if (id === 'agent-default-model' || name === '@deepseek-ai/dsh-agent-default-model') {
        const defProv = nonEmptyStr(cfg.get('provider'));
        const defModel = nonEmptyStr(cfg.get('model'));
        if (defModel) {
          defaultSlots.set('agent-default-model.config.model', {
            rawValue: defModel,
            providerHint: defProv,
          });
        }
      }

      if (id === 'llm-pi-ai' || name === '@deepseek-ai/dsh-llm-pi-ai') {
        for (const slotKey of ['selectedDefault', 'default', 'model'] as const) {
          const val = nonEmptyStr(cfg.get(slotKey));
          if (val) {
            defaultSlots.set(`config.${slotKey}`, {
              rawValue: val,
              providerHint: nonEmptyStr(cfg.get('provider')),
            });
          }
        }

        const pMap = cfg.get('providers', true);
        if (isMap(pMap)) {
          for (const pair of pMap.items) {
            if (!isScalar(pair.key) || !isMap(pair.value)) continue;
            const pId = String(pair.key.value ?? '').trim();
            if (!pId) continue;
            const provMap = pair.value;
            const baseUrl =
              nonEmptyStr(provMap.get('baseURL')) ??
              nonEmptyStr(provMap.get('base_url')) ??
              nonEmptyStr(provMap.get('url'));
            const hasKey =
              Boolean(nonEmptyStr(provMap.get('apiKeyEnv'))) ||
              Boolean(nonEmptyStr(provMap.get('apiKey'))) ||
              isLocalRouterPortUrl(baseUrl);

            const mRaw = provMap.get('models', true);
            const seq = isSeq(mRaw) ? mRaw : undefined;
            if (seq?.range) excludedModelSpans.push([seq.range[0], seq.range[2]]);
            providerModels.set(pId, extractYamlSeqIds(seq));
            providerTargets.set(pId, { mapNode: provMap, seqNode: seq });

            const rawJs = (provMap.toJS(doc) ?? {}) as Record<string, unknown>;
            providerMeta.set(pId, {
              endpointFingerprint: sha256Hex(
                JSON.stringify({
                  baseURL: rawJs['baseURL'] ?? null,
                  base_url: rawJs['base_url'] ?? null,
                  url: rawJs['url'] ?? null,
                })
              ),
              authFingerprint: sha256Hex(
                JSON.stringify({
                  apiKey: rawJs['apiKey'] ?? null,
                  apiKeyEnv: rawJs['apiKeyEnv'] ?? null,
                  hasKey,
                })
              ),
              nonModelsFingerprint: sha256Hex(JSON.stringify(omitKeysSorted(rawJs, ['models']))),
            });

            if (hasKey) keyedProviders.add(pId);
          }
        }
      }
    }

    // Full Cordis structure digest (sibling rows, plugin order, llm-pi-ai non-provider config, comments)
    const scrubDshRow = (rawItem: unknown): unknown => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return rawItem;
      const obj = rawItem as Record<string, unknown>;
      if (Array.isArray(obj['insert'])) {
        return { ...omitKeysSorted(obj, ['insert']), insert: obj['insert'].map(scrubDshRow) };
      }
      const rowId = nonEmptyStr(obj['id']);
      const rowName = nonEmptyStr(obj['name']);
      if (
        (rowId === 'llm-pi-ai' || rowName === '@deepseek-ai/dsh-llm-pi-ai') &&
        obj['config'] &&
        typeof obj['config'] === 'object' &&
        !Array.isArray(obj['config'])
      ) {
        const cfgObj = obj['config'] as Record<string, unknown>;
        const provs = cfgObj['providers'];
        let scrubbedProviders: unknown = provs;
        if (provs && typeof provs === 'object' && !Array.isArray(provs)) {
          const outProvs: Record<string, unknown> = {};
          for (const k of Object.keys(provs as Record<string, unknown>).sort()) {
            const pv = (provs as Record<string, unknown>)[k];
            outProvs[k] =
              pv && typeof pv === 'object' && !Array.isArray(pv)
                ? omitKeysSorted(pv as Record<string, unknown>, ['models'])
                : pv;
          }
          scrubbedProviders = outProvs;
        }
        return {
          ...omitKeysSorted(obj, ['config']),
          config: {
            ...omitKeysSorted(cfgObj, ['providers']),
            ...(scrubbedProviders !== undefined ? { providers: scrubbedProviders } : {}),
          },
        };
      }
      return omitKeysSorted(obj, []);
    };

    const fullCordisJs = Array.isArray(doc.toJS())
      ? (doc.toJS() as unknown[]).map(scrubDshRow)
      : [];

    const nonModelsDigest = sha256Hex(
      JSON.stringify({
        cordisStructure: fullCordisJs,
        comments: extractYamlCommentsOutsideSpans(text, excludedModelSpans),
        ...serializeSlotsAndMeta(defaultSlots, providerMeta),
      })
    );

    return {
      providerModels,
      keyedProviders,
      defaultSlots,
      providerMeta,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        for (const [pId, ch] of changes.entries()) {
          if (ch.removeSet.size === 0 && ch.addIds.length === 0) continue;
          const target = providerTargets.get(pId);
          if (!target) throw new Error(`Provider '${pId}' not found in DSH YAML`);
          const keptAdd = ch.addIds.filter((id) => !(providerModels.get(pId) ?? []).includes(id));
          if (target.seqNode) {
            const edit = buildYamlModelsSeqEdit(text, target.seqNode, ch.removeSet, keptAdd);
            if (edit) edits.push(edit);
          } else {
            const insertEdit = buildYamlMissingModelsInsertionEdit(
              text,
              target.mapNode,
              keptAdd,
              '        '
            );
            if (insertEdit) edits.push(insertEdit);
          }
        }
        const next = applySpanReplacements(text, edits);
        const check = parseDocument(next, { logLevel: 'silent' });
        if (check.errors.length > 0 || !isSeq(check.contents)) {
          throw new Error(`DSH YAML invalid after edit: ${check.errors[0]?.message ?? 'invalid root'}`);
        }
        return next;
      },
    };
  }

  throw new Error(`Unsupported write-adapter harness '${harnessId}'.`);
}

function findProtectedDefaultSlotMatch(
  defaultSlots: Map<string, DefaultSlotEntry>,
  providerId: string,
  modelId: string
): string | null {
  for (const [slotName, info] of defaultSlots.entries()) {
    const raw = info.rawValue.trim();
    if (!raw) continue;
    if (raw === `${providerId}/${modelId}`) {
      return slotName;
    }
    const slashIdx = raw.indexOf('/');
    if (slashIdx > 0) {
      const slotProv = raw.slice(0, slashIdx);
      const slotModel = raw.slice(slashIdx + 1);
      if (slotProv === providerId && slotModel === modelId) {
        return slotName;
      }
    } else if (raw === modelId && (!info.providerHint || info.providerHint === providerId)) {
      return slotName;
    }
  }
  return null;
}

function evaluateHarnessViewPreFlight(
  harnessId: string,
  view: HarnessSnapshotView,
  actions: HarnessPlanActionInput[]
): HarnessPreFlightResult {
  if (actions.length === 0) {
    return {
      ok: false,
      errorCode: 'NO_PLANNED_CHANGES',
      message: `No harness actions provided for '${harnessId}'.`,
    };
  }

  const changesByProvider = new Map<string, { removeSet: Set<string>; addIds: string[] }>();
  for (const act of actions) {
    if (!view.providerModels.has(act.providerId)) {
      return {
        ok: false,
        errorCode: 'TARGET_NOT_FOUND',
        message: `Provider '${act.providerId}' was not found in '${harnessId}' configuration.`,
      };
    }
    if (!view.keyedProviders.has(act.providerId)) {
      return {
        ok: false,
        errorCode: 'UNKEYED_PROVIDER',
        message: `Refusing to mutate unkeyed or non-editable provider '${act.providerId}' in '${harnessId}'.`,
      };
    }
    if (act.action === 'REMOVE_MODEL') {
      const matchedSlot = findProtectedDefaultSlotMatch(
        view.defaultSlots,
        act.providerId,
        act.modelId
      );
      if (matchedSlot) {
        return {
          ok: false,
          errorCode: 'DEFAULT_SLOT_PROTECTED',
          message: `Refusing to remove model '${act.modelId}' on '${act.providerId}' because it is referenced by active default slot '${matchedSlot}'.`,
        };
      }
    }

    const entry = changesByProvider.get(act.providerId) ?? {
      removeSet: new Set<string>(),
      addIds: [],
    };
    if (act.action === 'REMOVE_MODEL') {
      entry.removeSet.add(act.modelId);
    } else if (act.action === 'ADD_MODEL') {
      if (!entry.addIds.includes(act.modelId)) entry.addIds.push(act.modelId);
    }
    changesByProvider.set(act.providerId, entry);
  }

  let effectiveDiffCount = 0;
  for (const [provId, ch] of changesByProvider.entries()) {
    const current = view.providerModels.get(provId) ?? [];
    const currentSet = new Set(current);
    for (const rem of ch.removeSet) {
      if (currentSet.has(rem)) effectiveDiffCount += 1;
    }
    for (const add of ch.addIds) {
      if (!currentSet.has(add)) effectiveDiffCount += 1;
    }
  }

  if (effectiveDiffCount === 0) {
    return {
      ok: false,
      errorCode: 'NO_PLANNED_CHANGES',
      message: `Planned harness actions for '${harnessId}' produce zero effective model changes.`,
    };
  }

  return { ok: true };
}

/**
 * Non-mutating Gate 5 pre-flight validation for MCP `apply_plan` harness targets.
 */
export function validateHarnessPlanActionsPreFlight(options: {
  harnessId: string;
  configPath: string;
  actions: HarnessPlanActionInput[];
}): HarnessPreFlightResult {
  const { harnessId, configPath, actions } = options;
  const cap = getHarnessCapability(harnessId);
  if (!cap || cap.directionAMode !== 'write-adapter') {
    return {
      ok: false,
      errorCode: 'TARGET_NOT_FOUND',
      message: `Harness '${harnessId}' is not a verified write-adapter target.`,
    };
  }

  assertControlledWriteSandbox(configPath, 'harness-config');
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      errorCode: 'TARGET_NOT_FOUND',
      message: `Harness config file not found for '${harnessId}'.`,
    };
  }

  try {
    const preText = fs.readFileSync(resolvedPath, 'utf8');
    const preView = parseHarnessSnapshot(harnessId, preText, resolvedPath);
    return evaluateHarnessViewPreFlight(harnessId, preView, actions);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INVALID_HARNESS_CONFIG',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function restoreHarnessBackupBytes(configPath: string, preBytes: Buffer): void {
  atomicWriteFileSync(configPath, preBytes);
}

/**
 * Executes lossless `backup -> atomic write -> read-back -> auto-rollback`
 * for a single Tier-A `write-adapter` harness target (`hermes`, `openmausbot`, `opencode`, `dsh`).
 */
export function applyHarnessPlanActionsSafe(options: {
  harnessId: string;
  configPath: string;
  actions: HarnessPlanActionInput[];
  injectReadBackFault?: boolean | undefined;
}): HarnessControlledApplyResult {
  const { harnessId, configPath, actions } = options;
  const cap = getHarnessCapability(harnessId);
  if (!cap || cap.directionAMode !== 'write-adapter') {
    throw new Error(`Harness '${harnessId}' is not a verified write-adapter target.`);
  }

  assertControlledWriteSandbox(configPath, 'harness-config');

  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Harness config file does not exist: ${resolvedPath}`);
  }

  const preBytes = fs.readFileSync(resolvedPath);
  const preDigest = sha256Hex(preBytes);
  const backupPath = `${resolvedPath}.routersync.bak`;
  const preText = preBytes.toString('utf8');
  const preView = parseHarnessSnapshot(harnessId, preText, resolvedPath);

  const preFlight = evaluateHarnessViewPreFlight(harnessId, preView, actions);
  if (!preFlight.ok) {
    return {
      success: false,
      harnessId,
      configPath: resolvedPath,
      backupPath,
      readBackVerified: false,
      rolledBack: false,
      preDigest,
      postDigest: preDigest,
      errorCode: preFlight.errorCode,
      error: preFlight.message,
    };
  }

  // 1. Persist byte-exact `.routersync.bak` backup BEFORE mutating target
  atomicWriteFileSync(backupPath, preBytes);

  const changesByProvider = new Map<string, { removeSet: Set<string>; addIds: string[] }>();
  for (const act of actions) {
    const entry = changesByProvider.get(act.providerId) ?? { removeSet: new Set<string>(), addIds: [] };
    if (act.action === 'REMOVE_MODEL') {
      entry.removeSet.add(act.modelId);
    } else if (act.action === 'ADD_MODEL') {
      if (!entry.addIds.includes(act.modelId)) entry.addIds.push(act.modelId);
    }
    changesByProvider.set(act.providerId, entry);
  }

  // 2. Compute lossless span update & write atomically
  let nextText: string;
  try {
    nextText = preView.applyChanges(changesByProvider);
    atomicWriteFileSync(resolvedPath, nextText);
  } catch (err) {
    restoreHarnessBackupBytes(resolvedPath, preBytes);
    return {
      success: false,
      harnessId,
      configPath: resolvedPath,
      backupPath,
      readBackVerified: false,
      rolledBack: true,
      preDigest,
      postDigest: sha256Hex(fs.readFileSync(resolvedPath)),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Read-back verification (models + untouched defaults/keys/endpoints/comments/rows)
  try {
    if (options.injectReadBackFault === true && process.env['VITEST'] === 'true') {
      throw new Error('Injected post-write read-back fault (VITEST)');
    }

    const postBytes = fs.readFileSync(resolvedPath);
    const postText = postBytes.toString('utf8');
    const postView = parseHarnessSnapshot(harnessId, postText, resolvedPath);

    if (postView.nonModelsDigest !== preView.nonModelsDigest) {
      throw new Error('Harness read-back failed: non-model fields/defaults/keys/comments digest changed');
    }

    for (const [provId, ch] of changesByProvider.entries()) {
      const postModels = new Set(postView.providerModels.get(provId) ?? []);
      for (const rem of ch.removeSet) {
        if (postModels.has(rem)) {
          throw new Error(`Harness read-back failed: removed model '${rem}' still present`);
        }
      }
      for (const add of ch.addIds) {
        if (!postModels.has(add)) {
          throw new Error(`Harness read-back failed: added model '${add}' missing`);
        }
      }
    }

    return {
      success: true,
      harnessId,
      configPath: resolvedPath,
      backupPath,
      readBackVerified: true,
      rolledBack: false,
      preDigest,
      postDigest: sha256Hex(postBytes),
    };
  } catch (err) {
    // 4. Automatic byte-exact rollback from preBytes (.routersync.bak) — C45-WP4 M5
    restoreHarnessBackupBytes(resolvedPath, preBytes);
    return {
      success: false,
      harnessId,
      configPath: resolvedPath,
      backupPath,
      readBackVerified: false,
      rolledBack: true,
      preDigest,
      postDigest: sha256Hex(fs.readFileSync(resolvedPath)),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
