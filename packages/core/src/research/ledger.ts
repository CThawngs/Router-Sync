/**
 * packages/core/src/research/ledger.ts
 *
 * C45-WP3 Part 1.2: Sanitized Research Evidence Ledger & Queue Schemas
 * (Serves: S1, S3, S7).
 *
 * Enforces:
 *  - sanitizeUntrustedString applied BEFORE exact length clamping (snippet/quote <= 300, conclusion <= 120)
 *  - Literal untrusted: true on every ResearchEvidenceRecord
 *  - Idempotent deduplication for unconsumed records + max 1000 cap
 *  - Exclusive atomic persistence via atomicWriteFileSync in <stateDir>/research-evidence.json
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  containsSecretLikeContent,
  containsSecretLikeUrlContent,
  sanitizeUntrustedString,
} from '../domain/sanitize.js';
import { atomicWriteFileSync } from '../paths/atomic.js';
import {
  ResearchValidationError,
  canonicalizeResearchProvider,
  verifyProviderSourceDomain,
  type ResearchSourceTier,
} from './domain-registry.js';

export const RESEARCH_EVIDENCE_FILENAME = 'research-evidence.json';
export const RESEARCH_QUEUE_FILENAME = 'research-queue.json';
export const MAX_RESEARCH_EVIDENCE_RECORDS = 1000;

export const ResearchSourceTierSchema = z.enum(['official', 'secondary']);

export const ResearchVerdictSchema = z.enum([
  'active',
  'upcoming_deprecation',
  'deprecated',
  'pricing_confirmed',
  'id_resolved',
  'inconclusive',
]);
export type ResearchVerdict = z.infer<typeof ResearchVerdictSchema>;

export const ResearchQueueReasonSchema = z.enum([
  'NO_MODEL_LIST_API',
  'AMBIGUOUS_DEPRECATION',
  'UNKNOWN_PRICING_TIER',
  'CROSS_SOURCE_ID_CONFLICT',
]);
export type ResearchQueueReason = z.infer<typeof ResearchQueueReasonSchema>;

export const ResearchPricingTierSchema = z.enum(['free', 'paid', 'unknown']);
export type ResearchPricingTier = z.infer<typeof ResearchPricingTierSchema>;

export interface ResearchEvidenceRecord {
  recordId: string;
  id: string;
  provider: string;
  modelId: string;
  verdict: ResearchVerdict;
  conclusion: string;
  url: string;
  sourceTier: ResearchSourceTier;
  domainVerified: boolean;
  matchedOfficialDomain: string | null;
  snippet: string;
  quote: string;
  publishedAt: string | null;
  shutdownDate: string | null;
  replacementModelId: string | null;
  pricingTier: ResearchPricingTier | null;
  accessedAt: string;
  submittedAt: string;
  submittedVia: 'mcp' | 'cli';
  untrusted: true;
  consumedAt: string | null;
}

export const ResearchEvidenceRecordSchema = z.object({
  recordId: z.string().min(1),
  id: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  verdict: ResearchVerdictSchema,
  conclusion: z.string().max(120),
  url: z.string().url(),
  sourceTier: ResearchSourceTierSchema,
  domainVerified: z.boolean(),
  matchedOfficialDomain: z.string().nullable(),
  snippet: z.string().max(300),
  quote: z.string().max(300),
  publishedAt: z.string().nullable(),
  shutdownDate: z.string().nullable(),
  replacementModelId: z.string().max(120).nullable(),
  pricingTier: ResearchPricingTierSchema.nullable(),
  accessedAt: z.string().min(1),
  submittedAt: z.string().min(1),
  submittedVia: z.enum(['mcp', 'cli']),
  untrusted: z.literal(true),
  consumedAt: z.string().nullable(),
});

export interface ResearchQueueItem {
  queueId: string;
  id: string;
  prefix: string;
  modelId: string | null;
  label: string;
  reasons: ResearchQueueReason[];
  missing: string[];
  targetsAffected: string[];
  firstQueuedAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}

export const ResearchQueueItemSchema = z.object({
  queueId: z.string().min(1),
  id: z.string().min(1),
  prefix: z.string().min(1),
  modelId: z.string().nullable(),
  label: z.string().min(1),
  reasons: z.array(ResearchQueueReasonSchema).min(1).max(4),
  missing: z.array(z.string()),
  targetsAffected: z.array(z.string()),
  firstQueuedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  verifiedAt: z.string().nullable(),
});

export interface ResearchQueueFile {
  version: 1;
  updatedAt: string;
  items: ResearchQueueItem[];
}

export const ResearchQueueFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().min(1),
  items: z.array(ResearchQueueItemSchema),
});

export interface AppendResearchEvidenceInput {
  id?: string | undefined;
  provider?: string | undefined;
  modelId?: string | undefined;
  verdict?: ResearchVerdict | undefined;
  conclusion?: string | undefined;
  url: string;
  quote?: string | undefined;
  snippet?: string | undefined;
  publishedAt?: string | null | undefined;
  shutdownDate?: string | null | undefined;
  replacementModelId?: string | null | undefined;
  pricingTier?: ResearchPricingTier | null | undefined;
  claimedSourceTier?: ResearchSourceTier | undefined;
  accessedAt?: string | undefined;
  submittedAt?: string | undefined;
  submittedVia: 'mcp' | 'cli';
}

const ISO_OR_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function validateOptionalTimestamp(fieldName: string, raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!ISO_OR_DATE_RE.test(trimmed) || !Number.isFinite(Date.parse(trimmed))) {
    throw new ResearchValidationError(
      'SCHEMA_VALIDATION_ERROR',
      `Invalid ${fieldName} timestamp "${trimmed}"; expected YYYY-MM-DD or ISO-8601.`
    );
  }
  return trimmed;
}

function sanitizeAndClamp(raw: string, maxChars: number): string {
  // Pass generous maxLength to sanitizeUntrustedString so it redacts secrets,
  // neutralizes prompt injection tokens, and strips control chars WITHOUT
  // appending '... [TRUNCATED]', then clamp strictly to maxChars.
  const sanitized = sanitizeUntrustedString(raw, Math.max(4096, raw.length + 64));
  return sanitized.slice(0, maxChars);
}

export function mapConclusionToVerdict(conclusion: string): ResearchVerdict {
  const trimmed = conclusion.trim();
  const lower = trimmed.toLowerCase();
  const upper = trimmed.toUpperCase();

  if (
    lower === 'deprecated' ||
    upper.includes('ĐÃ-NGỪNG') ||
    upper.includes('ĐÃ-XÁC-NHẬN-NGỪNG') ||
    lower.includes('shut down') ||
    lower.includes('retired')
  ) {
    return 'deprecated';
  }
  if (
    lower === 'upcoming_deprecation' ||
    upper.includes('SẮP-NGỪNG') ||
    lower.includes('upcoming deprecation')
  ) {
    return 'upcoming_deprecation';
  }
  if (lower === 'active' || upper.includes('ĐÃ-XÁC-NHẬN-CÒN')) {
    return 'active';
  }
  if (lower === 'pricing_confirmed' || upper.includes('CONFIRMED-FREE')) {
    return 'pricing_confirmed';
  }
  if (lower === 'id_resolved') {
    return 'id_resolved';
  }
  return 'inconclusive';
}

export function defaultConclusionForVerdict(verdict: ResearchVerdict): string {
  switch (verdict) {
    case 'deprecated':
      return 'ĐÃ-XÁC-NHẬN-NGỪNG';
    case 'upcoming_deprecation':
      return 'SẮP-NGỪNG';
    case 'active':
      return 'ĐÃ-XÁC-NHẬN-CÒN';
    case 'pricing_confirmed':
      return 'ĐÃ-XÁC-NHẬN-GIÁ';
    case 'id_resolved':
      return 'ĐÃ-ĐỐI-CHIẾU-ID';
    case 'inconclusive':
      return 'CHƯA-KẾT-LUẬN';
  }
}

function resolveProviderAndModel(input: AppendResearchEvidenceInput): {
  rawProvider: string;
  canonicalProvider: string;
  cleanModelId: string;
  compositeId: string;
} {
  let rawProvider = (input.provider ?? '').trim();
  let rawModelId = (input.modelId ?? '').trim();

  if ((!rawProvider || !rawModelId) && input.id) {
    const trimmedId = input.id.trim();
    const slashIdx = trimmedId.indexOf('/');
    if (slashIdx > 0 && slashIdx < trimmedId.length - 1) {
      if (!rawProvider) rawProvider = trimmedId.slice(0, slashIdx).trim();
      if (!rawModelId) rawModelId = trimmedId.slice(slashIdx + 1).trim();
    } else if (!rawModelId) {
      rawModelId = trimmedId;
    }
  }

  if (!rawProvider) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', 'Missing or empty "provider" field.');
  }
  if (!rawModelId) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', 'Missing or empty "modelId" field.');
  }

  const canonicalProvider = canonicalizeResearchProvider(rawProvider);

  // Strip redundant "<provider>/" or "<canonicalProvider>/" prefix from modelId
  let cleanModelId = rawModelId;
  const rawPrefixLower = `${rawProvider.toLowerCase()}/`;
  const canonPrefixLower = `${canonicalProvider.toLowerCase()}/`;
  if (cleanModelId.toLowerCase().startsWith(rawPrefixLower)) {
    cleanModelId = cleanModelId.slice(rawPrefixLower.length).trim();
  } else if (cleanModelId.toLowerCase().startsWith(canonPrefixLower)) {
    cleanModelId = cleanModelId.slice(canonPrefixLower.length).trim();
  }

  if (!cleanModelId) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', 'Model ID cannot be empty after stripping prefix.');
  }

  return {
    rawProvider,
    canonicalProvider,
    cleanModelId,
    compositeId: `${canonicalProvider}/${cleanModelId}`,
  };
}

export function loadResearchEvidence(stateDir: string): ResearchEvidenceRecord[] {
  const filePath = path.join(stateDir, RESEARCH_EVIDENCE_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is ResearchEvidenceRecord =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>)['id'] === 'string' &&
        typeof (item as Record<string, unknown>)['url'] === 'string'
    );
  } catch {
    return [];
  }
}

export function saveResearchEvidence(stateDir: string, records: ResearchEvidenceRecord[]): void {
  const filePath = path.join(stateDir, RESEARCH_EVIDENCE_FILENAME);
  const capped = records.slice(0, MAX_RESEARCH_EVIDENCE_RECORDS);
  atomicWriteFileSync(filePath, JSON.stringify(capped, null, 2));
}

export function appendResearchEvidence(
  stateDir: string,
  input: AppendResearchEvidenceInput
): ResearchEvidenceRecord {
  if (
    containsSecretLikeContent(input.id) ||
    containsSecretLikeContent(input.provider) ||
    containsSecretLikeContent(input.modelId) ||
    containsSecretLikeUrlContent(input.url) ||
    containsSecretLikeContent(input.quote) ||
    containsSecretLikeContent(input.snippet) ||
    containsSecretLikeContent(input.conclusion) ||
    containsSecretLikeContent(input.replacementModelId)
  ) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research evidence contains secret or API-key-like material and was rejected.'
    );
  }

  const { rawProvider, canonicalProvider, cleanModelId, compositeId } = resolveProviderAndModel(input);
  if (
    containsSecretLikeContent(rawProvider) ||
    containsSecretLikeContent(canonicalProvider) ||
    containsSecretLikeContent(cleanModelId) ||
    containsSecretLikeContent(compositeId)
  ) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research evidence contains secret or API-key-like material and was rejected.'
    );
  }

  const domainCheck = verifyProviderSourceDomain(
    canonicalProvider,
    input.url,
    input.claimedSourceTier
  );
  if (containsSecretLikeUrlContent(domainCheck.normalizedUrl)) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research evidence contains secret or API-key-like material and was rejected.'
    );
  }

  const submittedAt =
    validateOptionalTimestamp('submittedAt', input.submittedAt) ?? new Date().toISOString();
  const accessedAt =
    validateOptionalTimestamp('accessedAt', input.accessedAt) ?? submittedAt.slice(0, 10);
  const publishedAt = validateOptionalTimestamp('publishedAt', input.publishedAt);
  const shutdownDate = validateOptionalTimestamp('shutdownDate', input.shutdownDate);

  const verdict: ResearchVerdict =
    input.verdict ??
    (input.conclusion ? mapConclusionToVerdict(input.conclusion) : 'inconclusive');
  const parsedVerdict = ResearchVerdictSchema.safeParse(verdict);
  if (!parsedVerdict.success) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', `Invalid verdict "${String(verdict)}".`);
  }

  if (
    containsSecretLikeContent(input.quote) ||
    containsSecretLikeContent(input.snippet) ||
    containsSecretLikeContent(input.conclusion) ||
    containsSecretLikeContent(input.replacementModelId)
  ) {
    throw new ResearchValidationError(
      'SECRET_DETECTED_IN_EVIDENCE',
      'Research evidence contains secret or API-key-like material and was rejected.'
    );
  }

  const rawQuote = input.quote ?? input.snippet ?? '';
  if (input.submittedVia === 'mcp' && rawQuote.trim().length === 0) {
    throw new ResearchValidationError('SCHEMA_VALIDATION_ERROR', 'Missing or empty "quote" field.');
  }

  const snippet = sanitizeAndClamp(rawQuote, 300);
  const rawConclusion =
    input.conclusion && input.conclusion.trim().length > 0
      ? input.conclusion
      : defaultConclusionForVerdict(parsedVerdict.data);
  const conclusion = sanitizeAndClamp(rawConclusion, 120);

  const replacementModelId =
    input.replacementModelId && input.replacementModelId.trim().length > 0
      ? sanitizeAndClamp(input.replacementModelId, 120)
      : null;

  let pricingTier: ResearchPricingTier | null = null;
  if (input.pricingTier !== undefined && input.pricingTier !== null) {
    const pt = ResearchPricingTierSchema.safeParse(input.pricingTier);
    if (!pt.success) {
      throw new ResearchValidationError(
        'SCHEMA_VALIDATION_ERROR',
        `Invalid pricingTier "${String(input.pricingTier)}".`
      );
    }
    pricingTier = pt.data;
  }

  const recordId = crypto
    .createHash('sha256')
    .update(
      `${canonicalProvider}|${cleanModelId}|${domainCheck.normalizedUrl}|${parsedVerdict.data}|${submittedAt}`
    )
    .digest('hex')
    .slice(0, 16);

  const nextRecord: ResearchEvidenceRecord = {
    recordId,
    id: compositeId,
    provider: canonicalProvider,
    modelId: cleanModelId,
    verdict: parsedVerdict.data,
    conclusion,
    url: domainCheck.normalizedUrl,
    sourceTier: domainCheck.sourceTier,
    domainVerified: domainCheck.domainVerified,
    matchedOfficialDomain: domainCheck.matchedOfficialDomain,
    snippet,
    quote: snippet,
    publishedAt,
    shutdownDate,
    replacementModelId,
    pricingTier,
    accessedAt,
    submittedAt,
    submittedVia: input.submittedVia,
    untrusted: true,
    consumedAt: null,
  };

  const existing = loadResearchEvidence(stateDir);
  const dupIdx = existing.findIndex(
    (entry) =>
      entry.consumedAt === null &&
      entry.provider === nextRecord.provider &&
      entry.modelId === nextRecord.modelId &&
      entry.url === nextRecord.url &&
      entry.verdict === nextRecord.verdict &&
      entry.shutdownDate === nextRecord.shutdownDate &&
      entry.pricingTier === nextRecord.pricingTier
  );

  if (dupIdx >= 0) {
    existing[dupIdx] = nextRecord;
  } else {
    existing.unshift(nextRecord);
  }

  saveResearchEvidence(stateDir, existing);
  return nextRecord;
}

export function loadResearchQueue(stateDir: string): ResearchQueueFile | null {
  const filePath = path.join(stateDir, RESEARCH_QUEUE_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const parsed = ResearchQueueFileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return null;
  } catch {
    return null;
  }
}

export function saveResearchQueue(stateDir: string, queue: ResearchQueueFile): void {
  const filePath = path.join(stateDir, RESEARCH_QUEUE_FILENAME);
  atomicWriteFileSync(filePath, JSON.stringify(queue, null, 2));
}
