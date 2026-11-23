/**
 * packages/core/src/notify/webhook.ts
 *
 * Shared, timeout-bounded, URL-validated, zero-secret/zero-PII outbound webhook
 * notifier for actionable RouterSync alerts (M2-02 / Slice P3.2).
 *
 * Safe to re-export from both `@routersync/core` and `@routersync/core/readonly`:
 * contains zero database write primitives and zero router mutation capabilities.
 */

import * as os from 'node:os';

export type WebhookUrlRejectionReason =
  | 'invalid_syntax'
  | 'unsupported_protocol'
  | 'embedded_credentials_forbidden'
  | 'forbidden_router_port';

export type WebhookUrlValidationResult =
  | {
      valid: true;
      normalizedOriginPath: string;
      url: string;
    }
  | {
      valid: false;
      status: 'skipped';
      reason: 'unconfigured';
    }
  | {
      valid: false;
      status: 'rejected_url';
      reason: WebhookUrlRejectionReason;
    };

export interface ActionableWebhookAlert {
  kind: 'inbox_item' | 'router_drift' | 'degraded_target';
  providerOrRouter: string;
  code: string;
  message: string;
}

export interface ActionableWebhookPayload {
  schemaVersion: '1.0';
  event: 'routersync.actionable_alert';
  source: 'cli.tick' | 'daemon.fast_loop';
  timestamp: string;
  summary: {
    alertCount: number;
    inboxAdded?: number;
    driftCount?: number;
    changedProviders: string[];
  };
  alerts: ActionableWebhookAlert[];
}

export type WebhookDeliveryStatus = 'sent' | 'skipped' | 'rejected_url' | 'failed';

export interface WebhookDeliveryResult {
  status: WebhookDeliveryStatus;
  ok: boolean;
  statusCode?: number | undefined;
  reason?: string | undefined;
  durationMs: number;
}

export interface RedactWebhookOptions {
  privateTokens?: string[] | undefined;
}

export interface SendActionableWebhookInput {
  url?: string | undefined;
  source: 'cli.tick' | 'daemon.fast_loop';
  timestamp?: string | undefined;
  inboxAdded?: number | undefined;
  driftCount?: number | undefined;
  changedProviders?: string[] | undefined;
  alerts: ActionableWebhookAlert[];
  timeoutMs?: number | undefined;
  privateTokens?: string[] | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const FORBIDDEN_ROUTER_PORTS = new Set(['20128', '30128', '3128']);

const BENIGN_SCHEMA_KEYS = new Set([
  'schemaVersion',
  'changedProviders',
  'routerId',
  'alertCount',
]);

const SENSITIVE_KEY_RE = /key|secret|token|password|passwd|auth|cookie|credential|private/i;

const SECRET_STRING_PATTERNS: readonly RegExp[] = [
  /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY-----[\s\S]*?(?:-----END\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bghp_[A-Za-z0-9]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
];

const USER_PATH_PATTERNS: readonly RegExp[] = [
  /file:\/\/[^\s"'<>)\],;|]+/gi,
  /[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>)\],;|]+/gi,
  /(?<![A-Za-z0-9._-])\/(?:Users|home)\/[^\s"'<>)\],;|]+/g,
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const EXAMPLE_EMAIL_DOMAIN_RE = /^example\.(?:com|org|net)$/i;
const REDACTED_PLACEHOLDER_SPLIT_RE = /(\[REDACTED\]|<USER_PATH>|<REDACTED_EMAIL>|<REDACTED_ID>)/g;

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 15_000;

/**
 * Validates an outbound webhook URL before opening any network socket.
 * Never returns query parameters in `normalizedOriginPath`.
 */
export function validateWebhookUrl(rawUrl: string | undefined): WebhookUrlValidationResult {
  if (rawUrl === undefined || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valid: false, status: 'skipped', reason: 'unconfigured' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, status: 'rejected_url', reason: 'invalid_syntax' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { valid: false, status: 'rejected_url', reason: 'unsupported_protocol' };
  }

  if (!parsed.hostname) {
    return { valid: false, status: 'rejected_url', reason: 'invalid_syntax' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { valid: false, status: 'rejected_url', reason: 'embedded_credentials_forbidden' };
  }

  const normalizedHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const effectivePort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (LOOPBACK_HOSTS.has(normalizedHost) && FORBIDDEN_ROUTER_PORTS.has(effectivePort)) {
    return { valid: false, status: 'rejected_url', reason: 'forbidden_router_port' };
  }

  return {
    valid: true,
    normalizedOriginPath: `${parsed.origin}${parsed.pathname}`,
    url: parsed.toString(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIdentifierRegexes(extraTokens?: readonly string[]): RegExp[] {
  const rawTokens: string[] = [];

  try {
    const username = os.userInfo().username;
    if (typeof username === 'string' && username.trim().length >= 3) {
      rawTokens.push(username.trim());
    }
  } catch {
    // ignore OS user lookup failures in restricted sandboxes
  }

  try {
    const host = os.hostname();
    if (typeof host === 'string' && host.trim().length >= 3) {
      rawTokens.push(host.trim());
    }
  } catch {
    // ignore hostname lookup failures
  }

  if (Array.isArray(extraTokens)) {
    for (const token of extraTokens) {
      if (typeof token === 'string' && token.trim().length > 0) {
        rawTokens.push(token.trim());
      }
    }
  }

  const seenLower = new Set<string>();
  const uniqueSorted = rawTokens
    .filter((token) => {
      const lower = token.toLowerCase();
      if (seenLower.has(lower)) return false;
      seenLower.add(lower);
      return true;
    })
    .sort((a, b) => b.length - a.length);

  return uniqueSorted.map((token) => new RegExp(escapeRegExp(token), 'gi'));
}

function scrubStringValue(input: string, idRegexes: readonly RegExp[]): string {
  let out = input;

  for (const secretPattern of SECRET_STRING_PATTERNS) {
    out = out.replace(secretPattern, '[REDACTED]');
  }

  for (const pathPattern of USER_PATH_PATTERNS) {
    out = out.replace(pathPattern, '<USER_PATH>');
  }

  out = out.replace(EMAIL_RE, (fullMatch, domain: string) =>
    EXAMPLE_EMAIL_DOMAIN_RE.test(domain) ? fullMatch : '<REDACTED_EMAIL>'
  );

  if (idRegexes.length > 0) {
    const parts = out.split(REDACTED_PLACEHOLDER_SPLIT_RE);
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      if (
        segment === '[REDACTED]' ||
        segment === '<USER_PATH>' ||
        segment === '<REDACTED_EMAIL>' ||
        segment === '<REDACTED_ID>'
      ) {
        continue;
      }
      let scrubbedSegment = segment;
      for (const idRe of idRegexes) {
        scrubbedSegment = scrubbedSegment.replace(idRe, '<REDACTED_ID>');
      }
      parts[i] = scrubbedSegment;
    }
    out = parts.join('');
  }

  return out;
}

function redactRecursive(
  value: unknown,
  idRegexes: readonly RegExp[],
  seen: WeakSet<object>
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubStringValue(value, idRegexes);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[REDACTED]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactRecursive(entry, idRegexes, seen));
  }

  const record = value as Record<string, unknown>;
  const cloned: Record<string, unknown> = {};
  for (const [key, entryVal] of Object.entries(record)) {
    if (!BENIGN_SCHEMA_KEYS.has(key) && SENSITIVE_KEY_RE.test(key)) {
      cloned[key] = '[REDACTED]';
    } else {
      cloned[key] = redactRecursive(entryVal, idRegexes, seen);
    }
  }
  return cloned;
}

/**
 * Deep-clones and scrubs secrets, personal paths, non-example emails, and
 * machine/user identifiers before JSON serialization.
 */
export function redactWebhookPayload<T>(value: T, options?: RedactWebhookOptions): T {
  const idRegexes = buildIdentifierRegexes(options?.privateTokens);
  return redactRecursive(value, idRegexes, new WeakSet<object>()) as T;
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeoutMs)));
}

function scrubUrlQueryFromMessage(raw: string): string {
  return raw.replace(/https?:\/\/[^\s"'<>]+/gi, (matchedUrl) => {
    const qIdx = matchedUrl.indexOf('?');
    return qIdx >= 0 ? `${matchedUrl.slice(0, qIdx)}?[REDACTED_QUERY]` : matchedUrl;
  });
}

function isTimeoutAbortError(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (err && typeof err === 'object' && 'cause' in err) {
    candidates.push((err as { cause?: unknown }).cause);
  }

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const name = 'name' in item ? String((item as { name?: unknown }).name) : '';
    const code = 'code' in item ? String((item as { code?: unknown }).code) : '';
    const msg =
      'message' in item
        ? scrubUrlQueryFromMessage(String((item as { message?: unknown }).message))
        : '';

    if (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT' ||
      /\b(?:timed?\s*out|TimeoutError|aborted due to timeout)\b/i.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sends a bounded, redacted HTTP POST JSON notification when actionable alerts exist.
 * Never throws; returns structured delivery metadata with zero URL/token leakage.
 */
export async function sendActionableWebhook(
  input: SendActionableWebhookInput
): Promise<WebhookDeliveryResult> {
  // Zero-noise gate: skip immediately before URL validation or socket creation
  if (!input.alerts || input.alerts.length === 0) {
    return {
      status: 'skipped',
      ok: true,
      reason: 'no_actionable_alerts',
      durationMs: 0,
    };
  }

  if (!input.url || input.url.trim() === '') {
    return {
      status: 'skipped',
      ok: true,
      reason: 'unconfigured',
      durationMs: 0,
    };
  }

  const validation = validateWebhookUrl(input.url);
  if (!validation.valid) {
    if (validation.status === 'skipped') {
      return {
        status: 'skipped',
        ok: true,
        reason: validation.reason,
        durationMs: 0,
      };
    }
    return {
      status: 'rejected_url',
      ok: false,
      reason: validation.reason,
      durationMs: 0,
    };
  }

  const envelope: ActionableWebhookPayload = {
    schemaVersion: '1.0',
    event: 'routersync.actionable_alert',
    source: input.source,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: {
      alertCount: input.alerts.length,
      ...(input.inboxAdded !== undefined ? { inboxAdded: input.inboxAdded } : {}),
      ...(input.driftCount !== undefined ? { driftCount: input.driftCount } : {}),
      changedProviders: [...(input.changedProviders ?? [])],
    },
    alerts: input.alerts.map((alert) => ({
      kind: alert.kind,
      providerOrRouter: alert.providerOrRouter,
      code: alert.code,
      message: alert.message,
    })),
  };

  const redactedEnvelope = redactWebhookPayload(
    envelope,
    input.privateTokens ? { privateTokens: input.privateTokens } : undefined
  );
  // Restore fixed protocol discriminator literals in case OS username/hostname ever matched a substring
  redactedEnvelope.schemaVersion = '1.0';
  redactedEnvelope.event = 'routersync.actionable_alert';
  redactedEnvelope.source = input.source;

  const clampedTimeoutMs = clampTimeoutMs(input.timeoutMs);
  const fetchFn = input.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();

  try {
    const res = await fetchFn(validation.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'routersync-webhook/1.0',
      },
      body: JSON.stringify(redactedEnvelope),
      redirect: 'error',
      signal: AbortSignal.timeout(clampedTimeoutMs),
    });

    const durationMs = Math.max(0, Date.now() - startedAt);
    try {
      if (res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel();
      }
    } catch {
      // ignore response stream cancel failure
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        status: 'sent',
        ok: true,
        statusCode: res.status,
        durationMs,
      };
    }

    return {
      status: 'failed',
      ok: false,
      statusCode: res.status,
      reason: `http_${res.status}`,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const isTimeout = isTimeoutAbortError(err);
    return {
      status: 'failed',
      ok: false,
      reason: isTimeout ? 'timeout' : 'network_error',
      durationMs,
    };
  }
}
