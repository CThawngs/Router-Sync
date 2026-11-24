/**
 * packages/mcp-server/src/harness-apply.ts
 *
 * Self-contained lossless harness config surgery + backup/read-back/byte-exact
 * automatic rollback for MCP `apply_plan` (C45-WP4, Phục vụ: S3, S4, S9).
 *
 * Dependency boundary: uses ONLY `yaml@2.9.1`, Node built-ins, and `@routersync/core`
 * (`getHarnessCapability`, `assertControlledWriteSandbox`, `atomicWriteFileSync`),
 * keeping `@routersync/mcp-server` 100% decoupled from `@routersync/cli`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import {
  assertControlledWriteSandbox,
  atomicWriteFileSync,
  getHarnessCapability,
} from '@routersync/core';

export interface HarnessPlanActionInput {
  harnessId: string;
  configPath: string;
  providerId: string;
  modelId: string;
  action: 'ADD_MODEL' | 'REMOVE_MODEL';
}

export interface HarnessControlledApplyResult {
  success: boolean;
  harnessId: string;
  configPath: string;
  backupPath: string;
  readBackVerified: boolean;
  rolledBack: boolean;
  preDigest: string;
  postDigest: string;
  error?: string | undefined;
}

interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function detectNewline(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
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

function omitKeysSorted(obj: Record<string, unknown>, omit: readonly string[]): Record<string, unknown> {
  const omitSet = new Set(omit);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (!omitSet.has(k)) out[k] = obj[k];
  }
  return out;
}

interface HarnessSnapshotView {
  providerModels: Map<string, string[]>;
  nonModelsDigest: string;
  applyChanges: (changes: Map<string, { removeSet: Set<string>; addIds: string[] }>) => string;
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

function parseHarnessSnapshot(harnessId: string, text: string): HarnessSnapshotView {
  if (harnessId === 'opencode') {
    const node = parseJsoncRoot(text);
    if (node.kind !== 'object') throw new Error('OpenCode root must be a JSONC object');
    const val = jsoncNodeToValue(node) as Record<string, unknown>;
    const providerModels = new Map<string, string[]>();
    const modelsNodes = new Map<string, { provNode: JsoncObjectNode; modelsNode?: JsoncObjectNode | undefined }>();
    const provSummary: Record<string, unknown> = {};

    const provProp = findJsoncProperty(node, 'provider');
    if (provProp && provProp.value.kind === 'object') {
      for (const p of provProp.value.properties) {
        if (p.value.kind !== 'object') continue;
        const pVal = jsoncNodeToValue(p.value) as Record<string, unknown>;
        const mProp = findJsoncProperty(p.value, 'models');
        const mNode = mProp && mProp.value.kind === 'object' ? mProp.value : undefined;
        providerModels.set(p.key, mNode ? mNode.properties.map((mp) => mp.key) : []);
        modelsNodes.set(p.key, { provNode: p.value, modelsNode: mNode });
        provSummary[p.key] = omitKeysSorted(pVal, ['models']);
      }
    }

    const nonModelsDigest = sha256Hex(
      JSON.stringify({ top: omitKeysSorted(val, ['provider']), provSummary })
    );

    return {
      providerModels,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        const nl = detectNewline(text);
        for (const [provId, ch] of changes.entries()) {
          const target = modelsNodes.get(provId);
          if (!target) throw new Error(`Provider '${provId}' not found in opencode config`);
          if (target.modelsNode) {
            const mObj = target.modelsNode;
            const closingIndent = getLineIndentAt(text, mObj.end - 1);
            const firstProp = mObj.properties[0];
            const itemIndent = firstProp ? getLineIndentAt(text, firstProp.keyStart) : `${closingIndent}  `;
            const keptProps: string[] = [];
            const existingKeys = new Set<string>();
            for (const prop of mObj.properties) {
              if (ch.removeSet.has(prop.key)) continue;
              existingKeys.add(prop.key);
              keptProps.push(`${itemIndent}${text.slice(prop.start, prop.end)}`);
            }
            for (const addId of ch.addIds) {
              if (existingKeys.has(addId)) continue;
              keptProps.push(`${itemIndent}${JSON.stringify(addId)}: { "name": ${JSON.stringify(addId)} }`);
            }
            const replacement =
              keptProps.length === 0
                ? '{}'
                : `{${nl}${keptProps.join(`,${nl}`)}${nl}${closingIndent}}`;
            edits.push({ start: mObj.start, end: mObj.end, replacement });
          } else if (ch.addIds.length > 0) {
            const closingIndent = getLineIndentAt(text, target.provNode.end - 1);
            const propIndent = target.provNode.properties[0]
              ? getLineIndentAt(text, target.provNode.properties[0].keyStart)
              : `${closingIndent}  `;
            const inner = ch.addIds
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

  if (harnessId === 'openmausbot') {
    const node = parseJsoncRoot(text);
    if (node.kind !== 'object') throw new Error('OpenMausBot config root must be an object');
    const val = jsoncNodeToValue(node) as Record<string, unknown>;
    const providerModels = new Map<string, string[]>();
    const cfgNodes = new Map<string, JsoncObjectNode>();
    const instSummary: Record<string, unknown> = {};

    const instProp = findJsoncProperty(node, 'instances');
    if (instProp && instProp.value.kind === 'object') {
      for (const ip of instProp.value.properties) {
        if (ip.value.kind !== 'object') continue;
        const iVal = jsoncNodeToValue(ip.value) as Record<string, unknown>;
        const cProp = findJsoncProperty(ip.value, 'config');
        if (!cProp || cProp.value.kind !== 'object') continue;
        const cVal = jsoncNodeToValue(cProp.value) as Record<string, unknown>;
        const models = Array.isArray(cVal['managedModels'])
          ? (cVal['managedModels'] as unknown[]).map((x) => String(x)).filter(Boolean)
          : [];
        providerModels.set(ip.key, models);
        cfgNodes.set(ip.key, cProp.value);
        instSummary[ip.key] = {
          top: omitKeysSorted(iVal, ['config']),
          cfg: omitKeysSorted(cVal, ['managedModels']),
        };
      }
    }

    const nonModelsDigest = sha256Hex(
      JSON.stringify({ top: omitKeysSorted(val, ['instances']), instSummary })
    );

    return {
      providerModels,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        const nl = detectNewline(text);
        for (const [instId, ch] of changes.entries()) {
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
          }
        }
        const next = applySpanReplacements(text, edits);
        JSON.parse(next);
        return next;
      },
    };
  }

  if (harnessId === 'hermes') {
    const doc = parseDocument(text, { logLevel: 'silent' });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      throw new Error(`Invalid Hermes YAML: ${doc.errors[0]?.message ?? 'root not map'}`);
    }
    const providerModels = new Map<string, string[]>();
    const seqNodes = new Map<string, YAMLSeq | undefined>();
    const metaSummary: Record<string, unknown> = {};

    const providersNode = doc.contents.get('providers', true);
    if (isMap(providersNode)) {
      for (const pair of providersNode.items) {
        if (!isScalar(pair.key) || !isMap(pair.value)) continue;
        const pId = String(pair.key.value ?? '').trim();
        const mRaw = pair.value.get('models', true);
        const seq = isSeq(mRaw) ? mRaw : undefined;
        providerModels.set(pId, extractYamlSeqIds(seq));
        seqNodes.set(pId, seq);
        metaSummary[pId] = omitKeysSorted((pair.value.toJS(doc) ?? {}) as Record<string, unknown>, ['models']);
      }
    }
    const rootJs = (doc.toJS() ?? {}) as Record<string, unknown>;
    const nonModelsDigest = sha256Hex(
      JSON.stringify({ top: omitKeysSorted(rootJs, ['providers']), metaSummary })
    );

    return {
      providerModels,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        for (const [pId, ch] of changes.entries()) {
          const seq = seqNodes.get(pId);
          if (!seq) throw new Error(`Provider '${pId}' models sequence not found in Hermes YAML`);
          const keptAdd = ch.addIds.filter((id) => !(providerModels.get(pId) ?? []).includes(id));
          const edit = buildYamlModelsSeqEdit(text, seq, ch.removeSet, keptAdd);
          if (edit) edits.push(edit);
        }
        const next = applySpanReplacements(text, edits);
        const check = parseDocument(next, { logLevel: 'silent' });
        if (check.errors.length > 0) throw new Error(`Hermes YAML invalid after edit`);
        return next;
      },
    };
  }

  if (harnessId === 'dsh') {
    const doc = parseDocument(text, { logLevel: 'silent' });
    if (doc.errors.length > 0 || !isSeq(doc.contents)) {
      throw new Error(`Invalid DSH YAML: ${doc.errors[0]?.message ?? 'root not sequence'}`);
    }
    const providerModels = new Map<string, string[]>();
    const seqNodes = new Map<string, YAMLSeq | undefined>();
    const metaSummary: Record<string, unknown> = {};

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
      const id = String(row.get('id') ?? '').trim();
      const name = String(row.get('name') ?? '').trim();
      const cfg = row.get('config', true);
      if (!isMap(cfg)) continue;
      if (id === 'llm-pi-ai' || name === '@deepseek-ai/dsh-llm-pi-ai') {
        const pMap = cfg.get('providers', true);
        if (isMap(pMap)) {
          for (const pair of pMap.items) {
            if (!isScalar(pair.key) || !isMap(pair.value)) continue;
            const pId = String(pair.key.value ?? '').trim();
            const mRaw = pair.value.get('models', true);
            const seq = isSeq(mRaw) ? mRaw : undefined;
            providerModels.set(pId, extractYamlSeqIds(seq));
            seqNodes.set(pId, seq);
            metaSummary[pId] = omitKeysSorted((pair.value.toJS(doc) ?? {}) as Record<string, unknown>, ['models']);
          }
        }
      }
    }

    const nonModelsDigest = sha256Hex(JSON.stringify(metaSummary));
    return {
      providerModels,
      nonModelsDigest,
      applyChanges(changes) {
        const edits: SpanEdit[] = [];
        for (const [pId, ch] of changes.entries()) {
          const seq = seqNodes.get(pId);
          if (!seq) throw new Error(`Provider '${pId}' models sequence not found in DSH YAML`);
          const keptAdd = ch.addIds.filter((id) => !(providerModels.get(pId) ?? []).includes(id));
          const edit = buildYamlModelsSeqEdit(text, seq, ch.removeSet, keptAdd);
          if (edit) edits.push(edit);
        }
        const next = applySpanReplacements(text, edits);
        const check = parseDocument(next, { logLevel: 'silent' });
        if (check.errors.length > 0) throw new Error(`DSH YAML invalid after edit`);
        return next;
      },
    };
  }

  throw new Error(`Unsupported write-adapter harness '${harnessId}'.`);
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

  // 1. Persist byte-exact `.routersync.bak` backup BEFORE mutating target
  atomicWriteFileSync(backupPath, preBytes);

  const preText = preBytes.toString('utf8');
  const preView = parseHarnessSnapshot(harnessId, preText);

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

  // 3. Read-back verification (models + untouched defaults/keys/endpoints)
  try {
    if (options.injectReadBackFault === true && process.env['VITEST'] === 'true') {
      throw new Error('Injected post-write read-back fault (VITEST)');
    }

    const postBytes = fs.readFileSync(resolvedPath);
    const postText = postBytes.toString('utf8');
    const postView = parseHarnessSnapshot(harnessId, postText);

    if (postView.nonModelsDigest !== preView.nonModelsDigest) {
      throw new Error('Harness read-back failed: non-model fields/defaults/keys digest changed');
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
