/**
 * packages/cli/src/verify/types.ts
 *
 * Types for the multi-layer web verification ladder (L1 -> L2 -> L3),
 * 6 canonical verification labels (Round C4b F3b), ABSENT-STABLE classification (F4),
 * NEW-CANDIDATE proposals (F5), and optional BYOK LLM batch with hard token budget.
 */

export type VerificationLabel =
  | 'ĐÃ-XÁC-NHẬN-CÒN'
  | 'ĐÃ-XÁC-NHẬN-NGỪNG'
  | 'SẮP-NGỪNG'
  | 'NGHI-NGỪNG'
  | 'CHƯA-XÁC-MINH'
  | 'QUOTA'
  | 'CHƯA-QUÉT'
  | 'QUOTA-NO-LIST';

export interface L2ModelEntry {
  id: string;
  provider?: string | undefined;
  price: number | null;
  isZeroPriceHidden: boolean; // Flag `ẨN-GIÁ-0`: price is 0 but model id lacks -free/:free suffix
  contextLength?: number | undefined;
  source: 'openrouter' | 'models.dev' | 'both';
  rawPricing?: Record<string, unknown> | undefined;
  expirationDate?: string | undefined;
}

export interface L2ScanState {
  version: 1;
  updatedAt: string;
  etagOpenRouter?: string | null | undefined;
  etagModelsDev?: string | null | undefined;
  hashOpenRouter?: string | undefined;
  hashModelsDev?: string | undefined;
  models: Record<string, L2ModelEntry>;
}

export interface L3NoticeItem {
  sourceId: string;
  url: string;
  title: string;
  date: string | null;
  modelMatches: string[];
  noticeType: 'deprecated' | 'upcoming_deprecation' | 'release' | 'info';
  snippet?: string | undefined;
}

export interface L3ScanState {
  version: 1;
  updatedAt: string;
  sourceHashes: Record<string, string>;
  notices: L3NoticeItem[];
}

export interface ModelVerificationRecord {
  id: string;
  prefix: string;
  fullStep: string;
  label: VerificationLabel;
  unscannedReason?: string | undefined;
  l1: {
    exists: boolean;
    status: number;
    absenceCount: number;
    lastSeenAt?: string | undefined;
  };
  l2: {
    exists: boolean;
    price: number | null;
    isZeroPriceHidden: boolean;
    source?: string | undefined;
    url?: string | undefined;
  };
  l3: {
    hasNotice: boolean;
    noticeType?: 'deprecated' | 'upcoming_deprecation' | 'release' | 'info' | undefined;
    noticeDate?: string | null | undefined;
    noticeTitle?: string | undefined;
    url?: string | undefined;
  };
  flags: string[]; // e.g. ['ẨN-GIÁ-0', 'CÒN-Ở-NGUỒN-NGOÀI']
  verifiedAt: string;
}

export interface AbsentStableCheckInput {
  id: string;
  prefix: string;
  absenceCount: number;
  firstAbsentAtMs: number;
  nowMs: number;
  lastLabel: string;
  l2ExternalExists: boolean;
  providerCoveredByExternal: boolean;
  comboStepCount: number;
  dropCount: number;
}

export interface AbsentStableResult {
  isAbsentStable: boolean;
  reasons: string[];
  canAutoRemove: boolean;
}

export interface NewCandidateProposal {
  id: string;
  prefix: string;
  fullStep: string;
  discoveredAt: string;
  targetCombos: Array<{ comboName: string; router: string; proposedRankIndex: number }>;
  targetAgents: Array<{ agentName: string; client: string; proposedAction: 'add' }>;
  pricing?: {
    prompt?: number | undefined;
    completion?: number | undefined;
    free?: boolean | undefined;
    isZeroPriceHidden?: boolean | undefined;
  };
  evidenceUrl?: string | null | undefined;
}

export interface VerifyAccounting {
  requests: number;
  paidRequests: 0;
  tokens: 0;
  llmCalls: 0;
}

export interface VerifyPhaseSummary {
  timestamp: string;
  modelsVerified: number;
  labels: Record<VerificationLabel, number>;
  records: ModelVerificationRecord[];
  proposals: NewCandidateProposal[];
  absentStableCandidates: string[];
  accounting: VerifyAccounting;
  /** C14 (b): true when the 60 s deadline fired before verification finished. */
  incomplete?: boolean;
}
