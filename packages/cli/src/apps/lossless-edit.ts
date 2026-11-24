/**
 * packages/cli/src/apps/lossless-edit.ts
 *
 * Pure TypeScript + `yaml@2.9.1` CST/AST range-based lossless config surgery
 * (Phục vụ: S2, S3 — C45 WP1 & WP2).
 *
 * Guarantees:
 *  - Zero new npm dependencies.
 *  - Preserves `#` YAML/TOML comments and `//` + `/* ... * /` JSONC comments.
 *  - Preserves UTF-8 BOM, CRLF vs LF line endings, and exact bytes outside
 *    the targeted AST span (`applySpanReplacements`).
 */

import { isMap, isScalar, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';

export interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
}

export function detectNewline(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function applySpanReplacements(text: string, edits: SpanEdit[]): string {
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

// ---------------------------------------------------------------------------
// Lossless JSON / JSONC Scanner & AST
// ---------------------------------------------------------------------------

export type JsoncNode =
  | JsoncObjectNode
  | JsoncArrayNode
  | JsoncStringNode
  | JsoncPrimitiveNode;

export interface JsoncPropertyNode {
  key: string;
  keyStart: number;
  keyEnd: number;
  colonIndex: number;
  value: JsoncNode;
  start: number;
  end: number;
}

export interface JsoncObjectNode {
  kind: 'object';
  start: number;
  end: number;
  properties: JsoncPropertyNode[];
}

export interface JsoncArrayNode {
  kind: 'array';
  start: number;
  end: number;
  elements: JsoncNode[];
}

export interface JsoncStringNode {
  kind: 'string';
  start: number;
  end: number;
  value: string;
}

export interface JsoncPrimitiveNode {
  kind: 'primitive';
  start: number;
  end: number;
  value: number | boolean | null;
}

export function parseJsoncRoot(text: string): JsoncNode {
  let pos = text.startsWith('\uFEFF') ? 1 : 0;
  const len = text.length;

  function skipTrivia(): void {
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      // Whitespace: space, tab, LF, CR
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        pos += 1;
        continue;
      }
      // Comments: // or /* */
      if (ch === 47 && pos + 1 < len) {
        const next = text.charCodeAt(pos + 1);
        if (next === 47) {
          pos += 2;
          while (pos < len && text.charCodeAt(pos) !== 10) {
            pos += 1;
          }
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
          if (!closed) {
            throw new SyntaxError('Unterminated JSONC block comment');
          }
          continue;
        }
      }
      break;
    }
  }

  function parseString(): JsoncStringNode {
    const start = pos;
    if (text.charCodeAt(pos) !== 34) {
      throw new SyntaxError(`Expected '"' at offset ${pos}`);
    }
    pos += 1;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 92) {
        pos += 2;
        continue;
      }
      if (ch === 34) {
        pos += 1;
        const rawLiteral = text.slice(start, pos);
        const value = JSON.parse(rawLiteral) as string;
        return { kind: 'string', start, end: pos, value };
      }
      if (ch < 32) {
        throw new SyntaxError(`Unescaped control character in JSONC string at offset ${pos}`);
      }
      pos += 1;
    }
    throw new SyntaxError('Unterminated JSONC string literal');
  }

  function parseObject(): JsoncObjectNode {
    const start = pos;
    pos += 1; // '{'
    const properties: JsoncPropertyNode[] = [];
    skipTrivia();
    if (pos < len && text.charCodeAt(pos) === 125) {
      pos += 1;
      return { kind: 'object', start, end: pos, properties };
    }
    while (pos < len) {
      skipTrivia();
      if (pos < len && text.charCodeAt(pos) === 125) {
        // Trailing comma before '}'
        pos += 1;
        return { kind: 'object', start, end: pos, properties };
      }
      const keyNode = parseString();
      skipTrivia();
      if (pos >= len || text.charCodeAt(pos) !== 58) {
        throw new SyntaxError(`Expected ':' after property "${keyNode.value}" at offset ${pos}`);
      }
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
      throw new SyntaxError(`Expected ',' or '}' in JSONC object at offset ${pos}`);
    }
    throw new SyntaxError('Unterminated JSONC object');
  }

  function parseArray(): JsoncArrayNode {
    const start = pos;
    pos += 1; // '['
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
      throw new SyntaxError(`Expected ',' or ']' in JSONC array at offset ${pos}`);
    }
    throw new SyntaxError('Unterminated JSONC array');
  }

  function parsePrimitive(): JsoncPrimitiveNode {
    const start = pos;
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (
        ch === 32 ||
        ch === 9 ||
        ch === 10 ||
        ch === 13 ||
        ch === 44 ||
        ch === 125 ||
        ch === 93 ||
        ch === 47
      ) {
        break;
      }
      pos += 1;
    }
    const token = text.slice(start, pos);
    if (!token) {
      throw new SyntaxError(`Unexpected token in JSONC at offset ${pos}`);
    }
    const val = JSON.parse(token) as number | boolean | null;
    return { kind: 'primitive', start, end: pos, value: val };
  }

  function parseValue(): JsoncNode {
    skipTrivia();
    if (pos >= len) {
      throw new SyntaxError('Unexpected end of JSONC input');
    }
    const ch = text.charCodeAt(pos);
    if (ch === 123) return parseObject();
    if (ch === 91) return parseArray();
    if (ch === 34) return parseString();
    return parsePrimitive();
  }

  const root = parseValue();
  skipTrivia();
  if (pos !== len) {
    throw new SyntaxError(`Trailing unexpected token in JSONC at offset ${pos}`);
  }
  return root;
}

export function jsoncNodeToValue(node: JsoncNode): unknown {
  switch (node.kind) {
    case 'string':
    case 'primitive':
      return node.value;
    case 'array':
      return node.elements.map(jsoncNodeToValue);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties) {
        out[prop.key] = jsoncNodeToValue(prop.value);
      }
      return out;
    }
  }
}

export function parseJsoncObject(text: string): {
  root: JsoncObjectNode;
  value: Record<string, unknown>;
} {
  const node = parseJsoncRoot(text);
  if (node.kind !== 'object') {
    throw new SyntaxError('JSONC root is not an object');
  }
  return { root: node, value: jsoncNodeToValue(node) as Record<string, unknown> };
}

export function findJsoncProperty(
  obj: JsoncObjectNode,
  key: string
): JsoncPropertyNode | undefined {
  return obj.properties.find((p) => p.key === key);
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
 * Surgically updates an OpenCode-style `models` object (`{ "<id>": { ... } }`)
 * inside `[modelsObj.start, modelsObj.end]`, leaving every byte outside that
 * object untouched and preserving existing kept model entries verbatim.
 */
export function buildJsoncModelsMapReplacement(
  text: string,
  modelsObj: JsoncObjectNode,
  removeSet: ReadonlySet<string>,
  addIds: readonly string[]
): string {
  const nl = detectNewline(text);
  const closingIndent = getLineIndentAt(text, modelsObj.end - 1);
  const firstProp = modelsObj.properties[0];
  const itemIndent = firstProp
    ? getLineIndentAt(text, firstProp.keyStart)
    : `${closingIndent}  `;

  const entries: string[] = [];
  for (const prop of modelsObj.properties) {
    if (removeSet.has(prop.key)) continue;
    entries.push(`${itemIndent}${text.slice(prop.start, prop.end)}`);
  }

  for (const id of addIds) {
    entries.push(
      `${itemIndent}${JSON.stringify(id)}: { "name": ${JSON.stringify(id)} }`
    );
  }

  if (entries.length === 0) {
    return '{}';
  }
  return `{${nl}${entries.join(`,${nl}`)}${nl}${closingIndent}}`;
}

/**
 * Surgically updates a string array node (`managedModels: [...]`) inside
 * `[arrNode.start, arrNode.end]`, preserving all bytes outside the array.
 */
export function buildJsoncStringArrayReplacement(
  text: string,
  arrNode: JsoncArrayNode,
  nextValues: readonly string[]
): string {
  const nl = detectNewline(text);
  const rawSlice = text.slice(arrNode.start, arrNode.end);
  const isMultiline = rawSlice.includes('\n');
  if (!isMultiline) {
    return `[${nextValues.map((v) => JSON.stringify(v)).join(', ')}]`;
  }
  if (nextValues.length === 0) {
    return '[]';
  }
  const closingIndent = getLineIndentAt(text, arrNode.end - 1);
  const firstElem = arrNode.elements[0];
  const elemIndent = firstElem
    ? getLineIndentAt(text, firstElem.start)
    : `${closingIndent}  `;
  const lines = nextValues.map((v) => `${elemIndent}${JSON.stringify(v)}`);
  return `[${nl}${lines.join(`,${nl}`)}${nl}${closingIndent}]`;
}

function formatJsonValueIndented(value: unknown, indent: string, nl: string): string {
  const raw = JSON.stringify(value, null, 2);
  const lines = raw.split('\n');
  return lines
    .map((line, idx) => (idx === 0 ? line : `${indent}${line}`))
    .join(nl);
}

/**
 * Non-destructively upserts `root[topKey][childKey] = childValue` in a JSON or
 * JSONC document while preserving all `//` and `/* * /` comments and unrelated keys.
 */
export function upsertJsoncNestedEntry(
  text: string,
  topKey: string,
  childKey: string,
  childValue: unknown
): string {
  const trimmed = text.trim();
  const nl = detectNewline(text);
  if (!trimmed) {
    return `${JSON.stringify({ [topKey]: { [childKey]: childValue } }, null, 2).replace(/\n/g, nl)}${nl}`;
  }

  const { root } = parseJsoncObject(text);
  const topProp = findJsoncProperty(root, topKey);

  if (topProp && topProp.value.kind === 'object') {
    const parentObj = topProp.value;
    const existingChild = findJsoncProperty(parentObj, childKey);
    if (existingChild) {
      const childIndent = getLineIndentAt(text, existingChild.keyStart);
      const formatted = formatJsonValueIndented(childValue, childIndent, nl);
      return applySpanReplacements(text, [
        {
          start: existingChild.value.start,
          end: existingChild.value.end,
          replacement: formatted,
        },
      ]);
    }

    const parentClosingIndent = getLineIndentAt(text, parentObj.end - 1);
    const childIndent = parentObj.properties[0]
      ? getLineIndentAt(text, parentObj.properties[0].keyStart)
      : `${parentClosingIndent}  `;
    const formatted = `${JSON.stringify(childKey)}: ${formatJsonValueIndented(childValue, childIndent, nl)}`;

    if (parentObj.properties.length === 0) {
      const replacement = `{${nl}${childIndent}${formatted}${nl}${parentClosingIndent}}`;
      return applySpanReplacements(text, [
        { start: parentObj.start, end: parentObj.end, replacement },
      ]);
    }

    const lastProp = parentObj.properties[parentObj.properties.length - 1]!;
    return applySpanReplacements(text, [
      {
        start: lastProp.end,
        end: lastProp.end,
        replacement: `,${nl}${childIndent}${formatted}`,
      },
    ]);
  }

  // Top-level key absent: insert into root object
  const rootClosingIndent = getLineIndentAt(text, root.end - 1);
  const propIndent = root.properties[0]
    ? getLineIndentAt(text, root.properties[0].keyStart)
    : `${rootClosingIndent}  `;
  const blockFormatted = `${JSON.stringify(topKey)}: ${formatJsonValueIndented(
    { [childKey]: childValue },
    propIndent,
    nl
  )}`;

  if (root.properties.length === 0) {
    return applySpanReplacements(text, [
      {
        start: root.start,
        end: root.end,
        replacement: `{${nl}${propIndent}${blockFormatted}${nl}${rootClosingIndent}}`,
      },
    ]);
  }

  const lastRootProp = root.properties[root.properties.length - 1]!;
  return applySpanReplacements(text, [
    {
      start: lastRootProp.end,
      end: lastRootProp.end,
      replacement: `,${nl}${propIndent}${blockFormatted}`,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Lossless YAML Sequence & Map Surgery (`yaml@2.9.1` CST/AST ranges)
// ---------------------------------------------------------------------------

export function formatYamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Surgically edits a YAML sequence of models (either block `- model-id` / `- id: ...`
 * or flow `["model-id", ...]`) using AST byte/char ranges so comments (including
 * inline `#` comments on surviving items and standalone `#` comments inside `models:`),
 * blank lines, sibling providers, keys, URLs, and defaults stay 100% byte-identical.
 */
export function buildYamlModelsSeqEdit(
  text: string,
  seqNode: YAMLSeq,
  removeSet: ReadonlySet<string>,
  addIds: readonly string[]
): SpanEdit | null {
  if (!seqNode.range) {
    throw new Error('YAML sequence node is missing range information');
  }
  const nl = detectNewline(text);
  const [seqStart, seqValueEnd] = seqNode.range;

  const firstItem = seqNode.items[0];
  const useMapItems = isMap(firstItem);
  const mapHasName =
    useMapItems &&
    (firstItem as YAMLMap).items.some(
      (pair) => isScalar(pair.key) && String(pair.key.value) === 'name'
    );

  // Flow sequence (`models: []` or `models: ["a", "b"]` or `models: [{ id: "a" }]`):
  // keep valid flow `[...]` inside `[seqStart, seqValueEnd]` so trailing `# comments`
  // after `]` (in `[seqValueEnd, seqNodeEnd]`) remain untouched.
  const rawSeq = text.slice(seqStart, seqValueEnd).trim();
  if (Boolean((seqNode as { flow?: boolean }).flow) || rawSeq.startsWith('[')) {
    if (seqNode.items.length === 0 && addIds.length === 0) {
      return null;
    }
    const firstRange = (firstItem as { range?: [number, number, number] } | undefined)?.range;
    const preferQuotedScalar =
      firstItem && isScalar(firstItem) && firstRange
        ? text.charCodeAt(firstRange[0]) === 34
        : true;

    const flowParts: string[] = [];
    for (const item of seqNode.items) {
      let modelId = '';
      if (isScalar(item)) {
        modelId = String(item.value ?? '').trim();
      } else if (isMap(item)) {
        const idVal = item.get('id');
        modelId = typeof idVal === 'string' ? idVal.trim() : String(idVal ?? '').trim();
      }
      if (modelId && removeSet.has(modelId)) {
        continue;
      }
      const itemRange = (item as { range?: [number, number, number] }).range;
      flowParts.push(
        itemRange ? text.slice(itemRange[0], itemRange[1]).trim() : formatYamlScalar(modelId)
      );
    }

    for (const id of addIds) {
      if (useMapItems) {
        flowParts.push(
          `{ id: ${JSON.stringify(id)}${mapHasName ? `, name: ${JSON.stringify(id)}` : ''} }`
        );
      } else {
        flowParts.push(preferQuotedScalar ? JSON.stringify(id) : formatYamlScalar(id));
      }
    }

    return {
      start: seqStart,
      end: seqValueEnd,
      replacement: `[${flowParts.join(', ')}]`,
    };
  }

  // Block sequence: preserve inline `# comments` (`itemRange[1]..itemRange[2]`) AND
  // standalone `#` comment lines between items (`prevItemEnd..itemLineStart`).
  const itemIndent = getLineIndentAt(text, seqStart);
  const indentedSegments: string[] = [];
  let keptItemCount = 0;
  let prevItemEnd = seqStart;

  for (let idx = 0; idx < seqNode.items.length; idx += 1) {
    const item = seqNode.items[idx];
    const itemRange = (item as { range?: [number, number, number] } | undefined)?.range;
    if (!itemRange) continue;

    let dashPos = itemRange[0];
    while (dashPos > seqStart && text.charCodeAt(dashPos - 1) !== 45) {
      dashPos -= 1;
    }
    if (dashPos > seqStart && text.charCodeAt(dashPos - 1) === 45) {
      dashPos -= 1;
    } else if (dashPos === seqStart && text.charCodeAt(dashPos) === 45) {
      // First item starts directly at seqStart
    } else if (dashPos > 0 && text.charCodeAt(dashPos - 1) === 45) {
      dashPos -= 1;
    }

    let itemLineStart = dashPos;
    if (idx > 0) {
      while (
        itemLineStart > prevItemEnd &&
        (text.charCodeAt(itemLineStart - 1) === 32 || text.charCodeAt(itemLineStart - 1) === 9)
      ) {
        itemLineStart -= 1;
      }
      if (itemLineStart > prevItemEnd) {
        const interTrivia = text.slice(prevItemEnd, itemLineStart);
        if (interTrivia.trim().length > 0) {
          indentedSegments.push(interTrivia.endsWith('\n') ? interTrivia : `${interTrivia}${nl}`);
        }
      }
    }
    prevItemEnd = itemRange[2];

    let modelId = '';
    if (isScalar(item)) {
      modelId = String(item.value ?? '').trim();
    } else if (isMap(item)) {
      const idVal = item.get('id');
      modelId = typeof idVal === 'string' ? idVal.trim() : String(idVal ?? '').trim();
    }
    if (modelId && removeSet.has(modelId)) {
      continue;
    }

    let itemSlice = text.slice(dashPos, itemRange[2]);
    if (!itemSlice.endsWith('\n')) {
      itemSlice += nl;
    }
    indentedSegments.push(`${itemIndent}${itemSlice}`);
    keptItemCount += 1;
  }

  for (const id of addIds) {
    if (useMapItems) {
      const safeId = formatYamlScalar(id);
      const nameLine = mapHasName ? `${nl}${itemIndent}  name: ${safeId}` : '';
      indentedSegments.push(`${itemIndent}- id: ${safeId}${nameLine}${nl}`);
    } else {
      indentedSegments.push(`${itemIndent}- ${formatYamlScalar(id)}${nl}`);
    }
    keptItemCount += 1;
  }

  if (keptItemCount === 0) {
    if (indentedSegments.length === 0) {
      return {
        start: seqStart,
        end: seqValueEnd,
        replacement: `[]${nl}`,
      };
    }
    indentedSegments.push(`${itemIndent}[]${nl}`);
  }

  const fullIndented = indentedSegments.join('');
  const replacement = fullIndented.startsWith(itemIndent)
    ? fullIndented.slice(itemIndent.length)
    : fullIndented;

  return {
    start: seqStart,
    end: seqValueEnd,
    replacement,
  };
}

/**
 * Comment-preserving YAML merge for `mcp_servers.<serverName>` (Hermes config.yaml),
 * supporting both block maps and flow maps (`mcp_servers: {}` or `mcp_servers: { ... }`).
 */
export function upsertYamlMcpServer(
  text: string,
  topKey: string,
  serverName: string,
  command: string,
  args: readonly string[]
): string {
  const nl = detectNewline(text);
  const argsBlock = args.map((a) => `      - ${JSON.stringify(a)}`).join(nl);
  const entryYaml = `  ${serverName}:${nl}    command: ${formatYamlScalar(command)}${nl}    args:${nl}${argsBlock}${nl}`;

  if (!text.trim()) {
    return `${topKey}:${nl}${entryYaml}`;
  }

  const doc = parseDocument(text, { logLevel: 'silent' });
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in config: ${doc.errors[0]?.message ?? 'parse error'}`);
  }

  if (!isMap(doc.contents)) {
    throw new Error('YAML root must be a mapping');
  }

  const rootMap = doc.contents;
  const mcpPair = rootMap.items.find(
    (pair) => isScalar(pair.key) && String(pair.key.value) === topKey
  );

  let nextText: string;

  if (mcpPair && isMap(mcpPair.value) && mcpPair.value.range) {
    const mcpMap = mcpPair.value;
    const pairKeyRange = (mcpPair.key as { range?: [number, number, number] }).range;
    const topIndent = pairKeyRange ? getLineIndentAt(text, pairKeyRange[0]) : '';
    const serverIndent = `${topIndent}  `;
    const indentedEntryYaml =
      `${serverIndent}${serverName}:${nl}` +
      `${serverIndent}  command: ${formatYamlScalar(command)}${nl}` +
      `${serverIndent}  args:${nl}` +
      args.map((a) => `${serverIndent}    - ${JSON.stringify(a)}`).join(nl) +
      nl;

    if (Boolean((mcpMap as { flow?: boolean }).flow)) {
      const [mapStart, mapValEnd] = mcpMap.range;
      if (mcpMap.items.length === 0) {
        let lineEnd = mapValEnd;
        while (lineEnd < text.length && text.charCodeAt(lineEnd) !== 10) {
          lineEnd += 1;
        }
        if (lineEnd < text.length && text.charCodeAt(lineEnd) === 10) {
          lineEnd += 1;
        }
        const sameLineTail = text.slice(mapValEnd, lineEnd);
        const headerSuffix =
          sameLineTail.length > 0
            ? sameLineTail.endsWith('\n')
              ? sameLineTail
              : `${sameLineTail}${nl}`
            : nl;
        nextText = applySpanReplacements(text, [
          {
            start: mapStart,
            end: lineEnd,
            replacement: `${headerSuffix}${indentedEntryYaml}`,
          },
        ]);
      } else {
        const flowServerEntry = `${serverName}: { command: ${JSON.stringify(command)}, args: [${args.map((a) => JSON.stringify(a)).join(', ')}] }`;
        const flowPairs: string[] = [];
        let replaced = false;
        for (const pair of mcpMap.items) {
          if (isScalar(pair.key) && String(pair.key.value) === serverName) {
            flowPairs.push(flowServerEntry);
            replaced = true;
          } else {
            const kRange = (pair.key as { range?: [number, number, number] }).range;
            const vRange = (pair.value as { range?: [number, number, number] } | null)?.range;
            if (kRange && vRange) {
              flowPairs.push(text.slice(kRange[0], vRange[1]).trim());
            }
          }
        }
        if (!replaced) {
          flowPairs.push(flowServerEntry);
        }
        nextText = applySpanReplacements(text, [
          {
            start: mapStart,
            end: mapValEnd,
            replacement: `{ ${flowPairs.join(', ')} }`,
          },
        ]);
      }
    } else {
      const existingServerPair = mcpMap.items.find(
        (pair) => isScalar(pair.key) && String(pair.key.value) === serverName
      );
      if (existingServerPair) {
        const keyRange = (existingServerPair.key as { range?: [number, number, number] }).range;
        const valRange = (existingServerPair.value as { range?: [number, number, number] } | null)?.range;
        if (keyRange && valRange) {
          const keyIndent = getLineIndentAt(text, keyRange[0]);
          const customEntry =
            `${serverName}:${nl}` +
            `${keyIndent}  command: ${formatYamlScalar(command)}${nl}` +
            `${keyIndent}  args:${nl}` +
            args.map((a) => `${keyIndent}    - ${JSON.stringify(a)}`).join(nl) +
            nl;
          nextText = applySpanReplacements(text, [
            { start: keyRange[0], end: valRange[1], replacement: customEntry },
          ]);
        } else {
          const insertPos = mcpMap.range[1];
          const prefix = insertPos > 0 && text.charCodeAt(insertPos - 1) !== 10 ? nl : '';
          nextText = applySpanReplacements(text, [
            { start: insertPos, end: insertPos, replacement: `${prefix}${indentedEntryYaml}` },
          ]);
        }
      } else {
        const insertPos = mcpMap.range[1];
        const prefix = insertPos > 0 && text.charCodeAt(insertPos - 1) !== 10 ? nl : '';
        nextText = applySpanReplacements(text, [
          { start: insertPos, end: insertPos, replacement: `${prefix}${indentedEntryYaml}` },
        ]);
      }
    }
  } else {
    const trailingNewline = text.endsWith('\n') ? '' : nl;
    nextText = `${text}${trailingNewline}${topKey}:${nl}${entryYaml}`;
  }

  const checkDoc = parseDocument(nextText, { logLevel: 'silent' });
  if (checkDoc.errors.length > 0 || !isMap(checkDoc.contents)) {
    throw new Error(
      `YAML validation failed after MCP upsert: ${checkDoc.errors[0]?.message ?? 'root must be a mapping'}`
    );
  }
  return nextText;
}

// ---------------------------------------------------------------------------
// Lossless TOML Table Upsert & Verifier (`[mcp_servers.<name>]` for Codex/Grok CLI)
// ---------------------------------------------------------------------------

/**
 * Appends or updates `[<tablePrefix>.<serverName>]` at the end of a TOML file,
 * strictly preserving top-level keys above the first `[table]` header and all
 * `#` comments.
 */
export function upsertTomlMcpServerTable(
  text: string,
  tablePrefix: string,
  serverName: string,
  command: string,
  args: readonly string[]
): string {
  const nl = detectNewline(text);
  const header = `[${tablePrefix}.${serverName}]`;
  const argsToml = `[${args.map((a) => JSON.stringify(a)).join(', ')}]`;
  const newBlock = `${header}${nl}command = ${JSON.stringify(command)}${nl}args = ${argsToml}${nl}`;

  const lines = text.split(/\r?\n/);
  let startLine = -1;
  let endLine = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === header) {
      startLine = i;
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextTrimmed = (lines[j] ?? '').trim();
        if (nextTrimmed.startsWith('[') && !nextTrimmed.startsWith(`[[${tablePrefix}.${serverName}`)) {
          endLine = j;
          break;
        }
      }
      break;
    }
  }

  if (startLine >= 0) {
    const before = lines.slice(0, startLine);
    const after = lines.slice(endLine);
    const rebuilt = [
      ...before,
      `${header}`,
      `command = ${JSON.stringify(command)}`,
      `args = ${argsToml}`,
      ...(after.length > 0 ? [''] : []),
      ...after,
    ].join(nl);
    return rebuilt.endsWith(nl) ? rebuilt : `${rebuilt}${nl}`;
  }

  if (!text.trim()) {
    return newBlock;
  }
  const sep = text.endsWith(`${nl}${nl}`) ? '' : text.endsWith(nl) ? nl : `${nl}${nl}`;
  return `${text}${sep}${newBlock}`;
}

/**
 * Lightweight deterministic verifier for `[<tablePrefix>.<serverName>]` in TOML,
 * checking both that top-level `key = val` lines before the first `[` remain valid
 * and that the target table declares `command = ...`.
 */
export function verifyTomlMcpServerTable(
  text: string,
  tablePrefix: string,
  serverName: string
): boolean {
  const header = `[${tablePrefix}.${serverName}]`;
  const lines = text.split(/\r?\n/);
  let inTarget = false;
  let foundHeader = false;
  let foundCommand = false;

  for (const rawLine of lines) {
    const stripped = rawLine.replace(/#.*$/, '').trim();
    if (!stripped) continue;
    if (stripped.startsWith('[')) {
      if (!stripped.endsWith(']')) return false;
      inTarget = stripped === header;
      if (inTarget) foundHeader = true;
      continue;
    }
    if (!stripped.includes('=')) {
      return false;
    }
    if (inTarget && /^command\s*=\s*".+"/.test(stripped)) {
      foundCommand = true;
    }
  }
  return foundHeader && foundCommand;
}
