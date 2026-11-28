/**
 * packages/cli/src/commands/field-report-secrets-context.ts
 *
 * Ticket C50-K1 (`Phục vụ: S9, S10, key không rời RAM`):
 * Read-only secret context extractor (env var values + `routersync.yaml` custom
 * prefixes / referenced env vars) and `tick.log` free-text diagnostic note parser.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { expandTilde } from '../config/loader.js';

export interface FieldReportSecretContext {
  extraSecretPrefixes: string[];
  secretLiterals: string[];
}

const ENV_SECRET_NAME_RE = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;
const TRIVIAL_SENTINEL_RE = /^(?:undefined|null|none|disabled|false|true)$/i;
const ENV_INTERPOLATION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function collectReferencedEnvVarNamesFromYamlObject(
  node: unknown,
  target: Set<string>,
  parentKey?: string
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (parentKey && /(?:^apiKeyEnv$|[A-Za-z0-9_]Env$)/.test(parentKey) && trimmed.length > 0) {
      target.add(trimmed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectReferencedEnvVarNamesFromYamlObject(item, target);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectReferencedEnvVarNamesFromYamlObject(v, target, k);
    }
  }
}

export function collectFieldReportSecretContextReadOnly(
  explicitConfigPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): FieldReportSecretContext {
  const extraSecretPrefixes: string[] = [];
  const referencedEnvNames = new Set<string>();

  let candidatePath: string | null = null;
  if (typeof explicitConfigPath === 'string' && explicitConfigPath.trim().length > 0) {
    candidatePath = path.resolve(expandTilde(explicitConfigPath.trim()));
  } else if (env['ROUTERSYNC_CONFIG']?.trim()) {
    candidatePath = path.resolve(expandTilde(env['ROUTERSYNC_CONFIG'].trim()));
  }

  if (candidatePath && fs.existsSync(candidatePath)) {
    try {
      const rawYaml = fs.readFileSync(candidatePath, 'utf8');
      let match: RegExpExecArray | null;
      ENV_INTERPOLATION_RE.lastIndex = 0;
      while ((match = ENV_INTERPOLATION_RE.exec(rawYaml)) !== null) {
        const varName = (match[1] ?? match[2] ?? '').trim();
        if (varName) referencedEnvNames.add(varName);
      }

      const parsed = parseYaml(rawYaml) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        collectReferencedEnvVarNamesFromYamlObject(parsed, referencedEnvNames);
        const frObj =
          parsed['fieldReport'] && typeof parsed['fieldReport'] === 'object'
            ? (parsed['fieldReport'] as Record<string, unknown>)
            : null;
        if (frObj) {
          if (Array.isArray(frObj['extraSecretPrefixes'])) {
            for (const p of frObj['extraSecretPrefixes']) {
              if (typeof p === 'string' && p.trim().length >= 2) {
                extraSecretPrefixes.push(p.trim());
              }
            }
          }
          if (Array.isArray(frObj['extraSecretEnvVars'])) {
            for (const v of frObj['extraSecretEnvVars']) {
              if (typeof v === 'string' && v.trim().length > 0) {
                referencedEnvNames.add(v.trim());
              }
            }
          }
        }
      }
    } catch {
      // Malformed config is ignored in read-only secret context extraction
    }
  }

  const secretSet = new Set<string>();
  for (const [envName, rawVal] of Object.entries(env)) {
    if (typeof rawVal !== 'string') continue;
    if (!ENV_SECRET_NAME_RE.test(envName) && !referencedEnvNames.has(envName)) {
      continue;
    }
    const clean = rawVal.trim();
    if (
      clean.length >= 8 &&
      !clean.startsWith('[REDACTED') &&
      !TRIVIAL_SENTINEL_RE.test(clean)
    ) {
      secretSet.add(clean);
    }
  }

  return {
    extraSecretPrefixes: Array.from(new Set(extraSecretPrefixes)),
    secretLiterals: Array.from(secretSet).sort((a, b) => b.length - a.length),
  };
}

const KNOWN_SCALAR_KEYS = new Set([
  'mode',
  'status',
  'combo',
  'requests',
  'changed',
  'unchanged',
  'backoff',
  'inbox_added',
  'paid-requests',
  'tokens',
  'llm-calls',
  'research_queue',
  'detection_latency_ms',
]);

export function extractTickFreeTextNote(
  restAfterTimestamp: string,
  telemetryObj: Record<string, unknown> | null
): string | null {
  const parts: string[] = [];

  // Strip shrink_blocks={...} before scanning KV pairs
  const withoutShrink = restAfterTimestamp.replace(/shrink_blocks=\{[^}]*\}/g, ' ');
  const kvNoteRe =
    /(?:^|\s)(note|error|reason|msg)=(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  let stripped = withoutShrink;
  while ((m = kvNoteRe.exec(withoutShrink)) !== null) {
    const rawVal = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : (m[3] ?? m[4] ?? '');
    if (rawVal.trim().length > 0) parts.push(rawVal.trim());
    stripped = stripped.replace(m[0], ' ');
  }

  // Remaining unconsumed non-scalar text
  const leftoverTokens = stripped
    .trim()
    .split(/\s+/)
    .filter((tok) => {
      if (!tok) return false;
      const eq = tok.indexOf('=');
      if (eq > 0 && KNOWN_SCALAR_KEYS.has(tok.slice(0, eq))) return false;
      return true;
    });
  if (leftoverTokens.length > 0) {
    parts.push(leftoverTokens.join(' '));
  }

  if (telemetryObj) {
    for (const key of ['note', 'error', 'reason'] as const) {
      const val = telemetryObj[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        parts.push(val.trim());
      }
    }
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}
