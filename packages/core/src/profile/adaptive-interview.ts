/**
 * packages/core/src/profile/adaptive-interview.ts
 *
 * C45 WP5 + WP6 Shared Core Module (Phục vụ: S4, S5):
 *  1. Canonical Router Strategy Capabilities Matrix (`9router`, `omniroute`, `litellm`).
 *  2. Deterministic <= 12-Question Adaptive User Interview State Machine:
 *     - 8 everyday plain-language core questions covering all 7 required WP6 domains
 *     - 0..4 conditional power-user follow-up questions (strictly <= 12 total)
 *     - Explicit `assumptions[]` log for vague/uncertain inputs
 *     - Zero fabrication of factual inventory (`harnesses`, `routers`, `keyedProviders`,
 *       `favorites`, `allowList`, `blockList`)
 *     - Non-destructive merge over existing `profile.yaml` data.
 */

import { listHarnessCapabilities, type HarnessId } from '../harness/matrix.js';

export type RouterKind = '9router' | 'omniroute' | 'litellm';

export interface RouterStrategyCapability {
  routerKind: RouterKind;
  credentialPoolLevel: {
    supported: boolean;
    mechanism: string;
    strategies: readonly string[];
    summary: string;
  };
  comboRoutingLevel: {
    supported: boolean;
    canonicalStrategies: readonly string[];
    defaultRecommended: string;
    summary: string;
  };
}

export const ROUTER_STRATEGY_CAPABILITIES: readonly RouterStrategyCapability[] = [
  {
    routerKind: '9router',
    credentialPoolLevel: {
      supported: true,
      mechanism: 'provider_nodes multi-account credential pool rotation (OAuth & API-key pool per provider)',
      strategies: ['account-pool-rotation', 'quota-aware-failover'],
      summary: 'Rotates provider_nodes credentials per provider before exhausting provider quota.',
    },
    comboRoutingLevel: {
      supported: true,
      canonicalStrategies: ['fallback', 'round-robin'],
      defaultRecommended: 'fallback',
      summary: 'Sequential ordered failover across models[] (fallback); round-robin distributes load evenly across healthy peers.',
    },
  },
  {
    routerKind: 'omniroute',
    credentialPoolLevel: {
      supported: true,
      mechanism: 'provider_connections priority/health backoff across multiple keys/accounts for the same provider',
      strategies: ['priority-health-backoff', 'connection-pool-rotation'],
      summary: 'Rotates provider_connections with health and cooldown backoff across multiple accounts for the same provider.',
    },
    comboRoutingLevel: {
      supported: true,
      canonicalStrategies: ['priority', 'weighted', 'round-robin'],
      defaultRecommended: 'priority',
      summary: 'Policy §12 deterministic ordered failover across models[] (priority); weighted splits traffic by weight; round-robin cycles evenly.',
    },
  },
  {
    routerKind: 'litellm',
    credentialPoolLevel: {
      supported: true,
      mechanism: 'same-model_name multi-key deployment pool in model_list via router_settings.routing_strategy',
      strategies: ['simple-shuffle', 'least-busy', 'latency-based-routing', 'usage-based-routing'],
      summary: 'Pools multiple model_list deployments sharing the same model_name with distinct os.environ/<KEY_N> references.',
    },
    comboRoutingLevel: {
      supported: true,
      canonicalStrategies: ['fallbacks', 'simple-shuffle', 'least-busy'],
      defaultRecommended: 'fallbacks',
      summary: 'Ordered cross-provider failover via router_settings.fallbacks and context_window_fallbacks.',
    },
  },
] as const;

export const STRATEGY_SELECTION_GUIDELINES = {
  stepCeiling: {
    focusedDefault: 12,
    freeOnlyDefault: 15,
    minSteps: 2,
    hardMax: 15,
  },
  excludedReliabilityLabels: ['HANG', 'DEAD'] as const,
  interleaveRule: 'cross-provider-round-robin' as const,
} as const;

export function getRouterStrategyCapabilities(
  routerKind?: RouterKind
): RouterStrategyCapability[] {
  if (!routerKind) {
    return [...ROUTER_STRATEGY_CAPABILITIES];
  }
  return ROUTER_STRATEGY_CAPABILITIES.filter((cap) => cap.routerKind === routerKind);
}

// ---------------------------------------------------------------------------
// WP6 Adaptive Interview Types & Constants
// ---------------------------------------------------------------------------

export const ADAPTIVE_INTERVIEW_MAX_QUESTIONS = 12;

export const C45_AUTO_SAFE_CONSENT_NOTE =
  "Target starts in 'propose' until at least 1 'propose' apply completes with verified read-back (C45 §3.2).";

export type AdaptiveQuestionDomain =
  | 'purpose'
  | 'harnesses'
  | 'routers'
  | 'keyedProviders'
  | 'budget'
  | 'priority'
  | 'automationLevel'
  | 'scanCycle'
  | 'routerMode'
  | 'limits'
  | 'favorites'
  | 'blockList';

export interface AdaptiveInterviewQuestion {
  id: AdaptiveQuestionDomain;
  domain: AdaptiveQuestionDomain;
  tier: 'core' | 'power-followup';
  prompt: string;
  examples: readonly string[];
  default: string;
  hint: string;
  branchCondition?: string;
}

export interface ProfileAssumption {
  field: string;
  assumedValue: unknown;
  userInput: string;
  reason: string;
}

export type CanonicalPriorityItem = 'quality' | 'speed' | 'cost' | 'price' | 'context' | 'reliability';

export interface AdaptiveProfileData {
  purpose: string;
  budget: 'free-only' | 'paid';
  freeOnly: boolean;
  priority: CanonicalPriorityItem[];
  harnesses: string[];
  routers: RouterKind[];
  keyedProviders: string[];
  preferredProviders: string[];
  dislikedProviders: string[];
  favorites: string[];
  keepHead: number;
  allowList: string[];
  denyList: string[];
  blockList: string[];
  routerMode: 'merge' | 'overwrite';
  automationLevel: 'observe' | 'propose' | 'auto-safe' | 'off';
  quotaLimit: string | number;
  scanCycle: 'hourly' | 'daily' | 'weekly' | 'manual';
  timezone: string;
  schedule: string | Record<string, unknown>;
  assumptions: ProfileAssumption[];
  consentNote?: string;
}

export interface AdaptiveInterviewPlan {
  maxQuestions: number;
  coreQuestions: AdaptiveInterviewQuestion[];
  activeFollowUps: AdaptiveInterviewQuestion[];
  questionsToAsk: AdaptiveInterviewQuestion[];
  totalPlanned: number;
  powerUserDetected: boolean;
}

export interface AdaptiveProfileResult {
  valid: boolean;
  questionCountAsked: number;
  questionsAsked: string[];
  powerUserTrack: boolean;
  profile: AdaptiveProfileData;
  assumptions: ProfileAssumption[];
  consentNote?: string;
  errors?: string[];
}

const CORE_ADAPTIVE_QUESTIONS: readonly AdaptiveInterviewQuestion[] = [
  {
    id: 'purpose',
    domain: 'purpose',
    tier: 'core',
    prompt:
      'What do you mainly want AI help with? (e.g. everyday coding, debugging tough bugs, chatting/writing, research, or a bit of everything)',
    examples: ['everyday coding', 'debugging tough bugs', 'chatting and writing', 'research'],
    default: 'general',
    hint: 'Plain everyday description works; say "not sure" for balanced general defaults.',
  },
  {
    id: 'harnesses',
    domain: 'harnesses',
    tier: 'core',
    prompt:
      "Which coding apps or bots do you use right now? (e.g. Claude Code, Cursor, OpenCode, Codex, Antigravity, Hermes, OpenMausBot, Grok Bot, DSH — or say 'not sure' / 'none')",
    examples: ['Claude Code, OpenCode', 'Hermes, OpenMausBot', 'not sure', 'none'],
    default: '',
    hint: 'Never guessed: left empty [] if you are unsure until local read-only discovery runs.',
  },
  {
    id: 'routers',
    domain: 'routers',
    tier: 'core',
    prompt:
      "Which local AI router do you run, if any? (9Router, OmniRoute, LiteLLM, or 'not sure' / 'none')",
    examples: ['9Router', 'OmniRoute', 'LiteLLM', 'not sure'],
    default: '',
    hint: 'Never guessed: left empty [] if unstated.',
  },
  {
    id: 'keyedProviders',
    domain: 'keyedProviders',
    tier: 'core',
    prompt:
      "Which AI providers do you already have accounts or API keys for? (e.g. OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Mistral — or 'none' / 'not sure')",
    examples: ['Gemini, Groq', 'OpenAI, Anthropic, Gemini', 'not sure'],
    default: '',
    hint: 'Only names of providers (never paste API keys!). Left empty [] if unsure.',
  },
  {
    id: 'budget',
    domain: 'budget',
    tier: 'core',
    prompt:
      'Should RouterSync stick strictly to free models (free-only), or can it also include paid API models (paid)?',
    examples: ['free-only', 'paid'],
    default: 'free-only',
    hint: 'Defaults safely to free-only so zero paid requests happen unexpectedly.',
  },
  {
    id: 'priority',
    domain: 'priority',
    tier: 'core',
    prompt:
      'What matters most when picking models: fast replies (speed), strongest reasoning (quality), or handling huge files/conversations (long-context)?',
    examples: ['quality, speed', 'speed, long-context', 'free and reliable'],
    default: 'reliability, quality, speed, cost, context',
    hint: 'Comma-separated or plain words like "fast", "smartest", or "huge files".',
  },
  {
    id: 'automationLevel',
    domain: 'automationLevel',
    tier: 'core',
    prompt:
      'How should updates work: ask before every change (propose, recommended), automatic safe updates after first verified run (auto-safe), or manual only (off)?',
    examples: ['propose', 'auto-safe', 'off'],
    default: 'propose',
    hint: 'auto-safe still starts in propose until 1 verified read-back apply succeeds (C45 §3.2).',
  },
  {
    id: 'scanCycle',
    domain: 'scanCycle',
    tier: 'core',
    prompt:
      'How often should RouterSync check model health & rankings (daily, weekly, or manual)?',
    examples: ['daily', 'weekly', 'manual'],
    default: 'daily',
    hint: 'Timezone is auto-detected locally without taking an extra question.',
  },
] as const;

const FOLLOW_UP_ADAPTIVE_QUESTIONS: readonly AdaptiveInterviewQuestion[] = [
  {
    id: 'routerMode',
    domain: 'routerMode',
    tier: 'power-followup',
    prompt:
      'When syncing router combos, should RouterSync merge alongside existing unmanaged combos (merge, recommended) or overwrite managed slots (overwrite)?',
    examples: ['merge', 'overwrite'],
    default: 'merge',
    hint: 'Asked only on power-user multi-router/custom tracks.',
    branchCondition: 'powerUserDetected === true',
  },
  {
    id: 'limits',
    domain: 'limits',
    tier: 'power-followup',
    prompt:
      'Optional step-change safety caps (remove% per combo, add per combo+day, move% — default "10, 5+20, 25")?',
    examples: ['10, 5+20, 25', '10, 3+10, 20'],
    default: '10, 5+20, 25',
    hint: 'Caps shrink per tick to <= 10% by default.',
    branchCondition: 'powerUserDetected === true',
  },
  {
    id: 'favorites',
    domain: 'favorites',
    tier: 'power-followup',
    prompt:
      'Any specific favorite models you want prioritized when healthy (comma-separated, or leave blank)?',
    examples: ['anthropic/claude-sonnet-4-5, gemini/gemini-2.5-pro'],
    default: '',
    hint: 'HANG or DEAD models are still excluded with a warning even if listed here.',
    branchCondition: 'powerUserDetected === true',
  },
  {
    id: 'blockList',
    domain: 'blockList',
    tier: 'power-followup',
    prompt:
      'Any models or providers you want RouterSync to block completely (comma-separated, or leave blank)?',
    examples: ['openai/gpt-4o-mini-tts'],
    default: '',
    hint: 'Mapped into denyList/blockList without touching existing entries unless specified.',
    branchCondition: 'powerUserDetected === true',
  },
] as const;

export const ADAPTIVE_INTERVIEW_FLOW = {
  maxQuestions: ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
  coreQuestions: CORE_ADAPTIVE_QUESTIONS,
  followUpQuestions: FOLLOW_UP_ADAPTIVE_QUESTIONS,
  get allQuestions(): readonly AdaptiveInterviewQuestion[] {
    return [...this.coreQuestions, ...this.followUpQuestions];
  },
};

// ---------------------------------------------------------------------------
// Parsing & Vague-Input Helpers
// ---------------------------------------------------------------------------

const VAGUE_PATTERNS: readonly RegExp[] = [
  /^$/,
  /^(?:idk|i\s*don'?t\s*know|not\s*sure|unsure|no\s*idea|dunno)$/i,
  /^(?:whatever|anything(?:\s+good)?|default|defaults|up\s*to\s*you|you\s*decide|skip)$/i,
  /^(?:khong\s*biet|không\s*biết|tuy(?:\s*ban)?|tùy(?:\s*bạn)?|mac\s*dinh|mặc\s*định|sao\s*cung\s*duoc|sao\s*cũng\s*được)$/i,
];

const EXPLICIT_NONE_RE = /^(?:none|no|nothing|n\/a|na|zero|khong|không|chua\s*co|chưa\s*có)$/i;

export function isVagueOrUncertainInput(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  return VAGUE_PATTERNS.some((re) => re.test(trimmed));
}

function isExplicitNoneInput(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return EXPLICIT_NONE_RE.test(raw.trim());
}

function splitTokens(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed || isVagueOrUncertainInput(trimmed) || isExplicitNoneInput(trimmed)) {
    return [];
  }
  return trimmed
    .split(/[,;\n]+|\s+and\s+|\s+\/\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HARNESS_ALIAS_MAP: Readonly<Record<string, HarnessId>> = {
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  'hermes agent': 'hermes',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'claude code': 'claude-code',
  codex: 'codex',
  'openai codex': 'codex',
  antigravity: 'antigravity',
  'google antigravity': 'antigravity',
  agy: 'antigravity',
  opencode: 'opencode',
  'open-code': 'opencode',
  'open code': 'opencode',
  cursor: 'cursor',
  'cursor ide': 'cursor',
  grok: 'grok-bot',
  'grok-bot': 'grok-bot',
  'grok bot': 'grok-bot',
  'grok-build': 'grok-bot',
  'grok build': 'grok-bot',
  openmausbot: 'openmausbot',
  'open-maus-bot': 'openmausbot',
  omb: 'openmausbot',
  dsh: 'dsh',
  'deepseek harness': 'dsh',
  'deepseek-harness': 'dsh',
};

function parseHarnessesList(raw: unknown): string[] {
  const knownIds = new Set<string>(listHarnessCapabilities().map((h) => h.id));
  const out: string[] = [];
  for (const token of splitTokens(raw)) {
    const key = token.toLowerCase();
    const mapped = HARNESS_ALIAS_MAP[key] ?? (knownIds.has(key) ? key : undefined);
    if (mapped && !out.includes(mapped)) {
      out.push(mapped);
    }
  }
  return out;
}

const ROUTER_ALIAS_MAP: Readonly<Record<string, RouterKind>> = {
  '9router': '9router',
  '9-router': '9router',
  ninerouter: '9router',
  omniroute: 'omniroute',
  'omni-route': 'omniroute',
  litellm: 'litellm',
  'lite-llm': 'litellm',
  'litellm proxy': 'litellm',
};

function parseRoutersList(raw: unknown): RouterKind[] {
  const out: RouterKind[] = [];
  for (const token of splitTokens(raw)) {
    const key = token.toLowerCase();
    const mapped = ROUTER_ALIAS_MAP[key];
    if (mapped && !out.includes(mapped)) {
      out.push(mapped);
    }
  }
  return out;
}

function parseProviderNames(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitTokens(raw)) {
    const normalized = token
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]/g, '');
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function parseUniqueStringList(raw: unknown): string[] {
  const out: string[] = [];
  for (const token of splitTokens(raw)) {
    if (!out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

function detectPowerUserSignals(partialAnswers: Record<string, unknown>): boolean {
  const followUpKeys: readonly AdaptiveQuestionDomain[] = [
    'routerMode',
    'limits',
    'favorites',
    'blockList',
  ];
  for (const key of followUpKeys) {
    const val = partialAnswers[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return true;
    }
  }

  const routers = parseRoutersList(partialAnswers['routers']);
  const harnesses = parseHarnessesList(partialAnswers['harnesses']);
  const providers = parseProviderNames(partialAnswers['keyedProviders']);
  const purposeStr = typeof partialAnswers['purpose'] === 'string' ? partialAnswers['purpose'] : '';

  if (routers.length >= 2) return true;
  if (harnesses.length >= 3) return true;
  if (providers.length >= 4) return true;
  if (/\b(?:custom|limit|limits|favorite|favorites|merge|overwrite|power|advanced)\b/i.test(purposeStr)) {
    return true;
  }
  return false;
}

export function createAdaptiveInterviewPlan(
  partialAnswers: Record<string, unknown> = {}
): AdaptiveInterviewPlan {
  const coreQuestions = [...ADAPTIVE_INTERVIEW_FLOW.coreQuestions];
  const powerUserDetected = detectPowerUserSignals(partialAnswers);
  const activeFollowUps = powerUserDetected ? [...ADAPTIVE_INTERVIEW_FLOW.followUpQuestions] : [];
  const questionsToAsk = [...coreQuestions, ...activeFollowUps];

  return {
    maxQuestions: ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
    coreQuestions,
    activeFollowUps,
    questionsToAsk,
    totalPlanned: questionsToAsk.length,
    powerUserDetected,
  };
}

export function evaluateAdaptiveAnswer(
  questionId: AdaptiveQuestionDomain,
  rawInput: unknown
): {
  questionId: AdaptiveQuestionDomain;
  isVague: boolean;
  normalized: unknown;
  assumption?: ProfileAssumption;
} {
  const rawDisplay = rawInput === undefined || rawInput === null ? '' : String(rawInput).trim();
  const vague = isVagueOrUncertainInput(rawInput);

  switch (questionId) {
    case 'purpose': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: 'general',
          assumption: {
            field: 'purpose',
            assumedValue: 'general',
            userInput: rawDisplay,
            reason: 'User left purpose vague/open; defaulted to balanced general coding & assistant usage.',
          },
        };
      }
      const lower = rawDisplay.toLowerCase();
      let normalized = rawDisplay;
      if (/\b(?:code|coding|bug|debug|repo|program|dev)\b/.test(lower)) {
        normalized = 'coding';
      } else if (/\b(?:reason|math|logic|proof)\b/.test(lower)) {
        normalized = 'reasoning';
      } else if (/\b(?:research|search|study|paper)\b/.test(lower)) {
        normalized = 'research';
      } else if (/\b(?:chat|write|writing|draft)\b/.test(lower)) {
        normalized = 'chat';
      }
      return { questionId, isVague: false, normalized };
    }

    case 'harnesses': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: [],
          assumption: {
            field: 'harnesses',
            assumedValue: [],
            userInput: rawDisplay,
            reason: 'Factual harness inventory was uncertain; kept [] (never fabricated) pending read-only `routersync apps inspect`.',
          },
        };
      }
      return { questionId, isVague: false, normalized: parseHarnessesList(rawInput) };
    }

    case 'routers': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: [],
          assumption: {
            field: 'routers',
            assumedValue: [],
            userInput: rawDisplay,
            reason: 'Factual router inventory was uncertain; kept [] (never fabricated) pending read-only `routersync status`.',
          },
        };
      }
      return { questionId, isVague: false, normalized: parseRoutersList(rawInput) };
    }

    case 'keyedProviders': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: [],
          assumption: {
            field: 'keyedProviders',
            assumedValue: [],
            userInput: rawDisplay,
            reason: 'Keyed provider inventory was uncertain; kept [] (never fabricated) pending read-only local discovery.',
          },
        };
      }
      return { questionId, isVague: false, normalized: parseProviderNames(rawInput) };
    }

    case 'budget': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: 'free-only',
          assumption: {
            field: 'budget',
            assumedValue: 'free-only',
            userInput: rawDisplay,
            reason: 'Budget preference was uncertain; defaulted conservatively to free-only (0 paid model exposure).',
          },
        };
      }
      const lower = rawDisplay.toLowerCase();
      const budget: 'free-only' | 'paid' =
        /\b(?:paid|pro|pay|both|commercial|tra\s*phi|trả\s*phí)\b/.test(lower) &&
        !/\bfree[- ]only\b/.test(lower)
          ? 'paid'
          : 'free-only';
      return { questionId, isVague: false, normalized: budget };
    }

    case 'priority': {
      const defaultOrder: CanonicalPriorityItem[] = [
        'reliability',
        'quality',
        'speed',
        'cost',
        'context',
      ];
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: defaultOrder,
          assumption: {
            field: 'priority',
            assumedValue: defaultOrder,
            userInput: rawDisplay,
            reason: 'Priority order was uncertain; defaulted to reliability -> quality -> speed -> cost -> context.',
          },
        };
      }
      const out: CanonicalPriorityItem[] = [];
      for (const tok of splitTokens(rawInput)) {
        const lower = tok.toLowerCase();
        let mapped: CanonicalPriorityItem | undefined;
        if (lower === 'long-context' || lower === 'context' || /huge|large|window|file/.test(lower)) {
          mapped = 'context';
        } else if (lower === 'speed' || /fast|quick|latency/.test(lower)) {
          mapped = 'speed';
        } else if (lower === 'quality' || /smart|reason|accurate|best/.test(lower)) {
          mapped = 'quality';
        } else if (lower === 'cost' || lower === 'price' || /free|cheap|budget/.test(lower)) {
          mapped = 'cost';
        } else if (lower === 'reliability' || /stable|reliable|uptime/.test(lower)) {
          mapped = 'reliability';
        }
        if (mapped && !out.includes(mapped)) {
          out.push(mapped);
        }
      }
      if (out.length === 0) {
        return {
          questionId,
          isVague: true,
          normalized: defaultOrder,
          assumption: {
            field: 'priority',
            assumedValue: defaultOrder,
            userInput: rawDisplay,
            reason: 'Unrecognized priority phrasing; defaulted to reliability -> quality -> speed -> cost -> context.',
          },
        };
      }
      return { questionId, isVague: false, normalized: out };
    }

    case 'automationLevel': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: 'propose',
          assumption: {
            field: 'automationLevel',
            assumedValue: 'propose',
            userInput: rawDisplay,
            reason: 'Automation level was uncertain; defaulted safely to propose (human review before writes).',
          },
        };
      }
      const lower = rawDisplay.toLowerCase();
      let level: 'observe' | 'propose' | 'auto-safe' | 'off' = 'propose';
      if (lower === 'auto-safe' || /auto[- ]safe|automatic\s+safe/.test(lower)) {
        level = 'auto-safe';
      } else if (lower === 'off' || lower === 'manual' || /manual\s+only|disable/.test(lower)) {
        level = 'off';
      } else if (lower === 'observe' || /read[- ]only|observe/.test(lower)) {
        level = 'observe';
      } else if (lower === 'propose' || /ask|review/.test(lower)) {
        level = 'propose';
      } else {
        return {
          questionId,
          isVague: true,
          normalized: 'propose',
          assumption: {
            field: 'automationLevel',
            assumedValue: 'propose',
            userInput: rawDisplay,
            reason: 'Ambiguous automation preference; defaulted safely to propose.',
          },
        };
      }
      return { questionId, isVague: false, normalized: level };
    }

    case 'scanCycle': {
      if (vague) {
        return {
          questionId,
          isVague: true,
          normalized: 'daily',
          assumption: {
            field: 'scanCycle',
            assumedValue: 'daily',
            userInput: rawDisplay,
            reason: 'Scan schedule was uncertain; defaulted to daily 0-token health check.',
          },
        };
      }
      const lower = rawDisplay.toLowerCase();
      const cycle: 'hourly' | 'daily' | 'weekly' | 'manual' =
        lower === 'hourly'
          ? 'hourly'
          : lower === 'weekly'
            ? 'weekly'
            : lower === 'manual'
              ? 'manual'
              : 'daily';
      return { questionId, isVague: false, normalized: cycle };
    }

    case 'routerMode': {
      const lower = rawDisplay.toLowerCase();
      return {
        questionId,
        isVague: vague,
        normalized: lower === 'overwrite' ? 'overwrite' : 'merge',
      };
    }

    case 'limits': {
      return {
        questionId,
        isVague: vague,
        normalized: vague || !rawDisplay ? '10, 5+20, 25' : rawDisplay,
      };
    }

    case 'favorites':
    case 'blockList': {
      return {
        questionId,
        isVague: vague,
        normalized: vague ? [] : parseUniqueStringList(rawInput),
      };
    }
  }
}

export interface FinalizeAdaptiveProfileOptions {
  existingProfile?: Record<string, unknown> | undefined;
  detectedEnvironment?: {
    harnesses?: readonly string[] | undefined;
    routers?: readonly RouterKind[] | undefined;
    keyedProviders?: readonly string[] | undefined;
  } | undefined;
  timezone?: string | undefined;
}

export function finalizeAdaptiveProfile(
  answers: Record<string, unknown>,
  options: FinalizeAdaptiveProfileOptions = {}
): AdaptiveProfileResult {
  const plan = createAdaptiveInterviewPlan(answers);
  const assumptions: ProfileAssumption[] = [];

  const evalMap = new Map<AdaptiveQuestionDomain, ReturnType<typeof evaluateAdaptiveAnswer>>();
  for (const q of plan.questionsToAsk) {
    const res = evaluateAdaptiveAnswer(q.domain, answers[q.domain]);
    evalMap.set(q.domain, res);
    if (res.assumption) {
      assumptions.push(res.assumption);
    }
  }

  const detectedHarnesses = options.detectedEnvironment?.harnesses
    ? parseHarnessesList([...options.detectedEnvironment.harnesses])
    : [];
  const detectedRouters = options.detectedEnvironment?.routers
    ? parseRoutersList([...options.detectedEnvironment.routers])
    : [];
  const detectedProviders = options.detectedEnvironment?.keyedProviders
    ? parseProviderNames([...options.detectedEnvironment.keyedProviders])
    : [];

  const harnessesEval = evalMap.get('harnesses')!;
  const routersEval = evalMap.get('routers')!;
  const providersEval = evalMap.get('keyedProviders')!;

  const harnesses =
    (harnessesEval.normalized as string[]).length > 0
      ? (harnessesEval.normalized as string[])
      : harnessesEval.isVague
        ? detectedHarnesses
        : [];

  const routers =
    (routersEval.normalized as RouterKind[]).length > 0
      ? (routersEval.normalized as RouterKind[])
      : routersEval.isVague
        ? detectedRouters
        : [];

  const keyedProviders =
    (providersEval.normalized as string[]).length > 0
      ? (providersEval.normalized as string[])
      : providersEval.isVague
        ? detectedProviders
        : [];

  const budget = (evalMap.get('budget')?.normalized as 'free-only' | 'paid') ?? 'free-only';
  const automationLevel =
    (evalMap.get('automationLevel')?.normalized as 'observe' | 'propose' | 'auto-safe' | 'off') ??
    'propose';
  const scanCycle =
    (evalMap.get('scanCycle')?.normalized as 'hourly' | 'daily' | 'weekly' | 'manual') ?? 'daily';
  const priority =
    (evalMap.get('priority')?.normalized as CanonicalPriorityItem[]) ?? [
      'reliability',
      'quality',
      'speed',
      'cost',
      'context',
    ];

  const favorites = answers['favorites'] !== undefined
    ? parseUniqueStringList(answers['favorites'])
    : [];
  const blockInput = answers['blockList'] ?? answers['denyList'];
  const blockList = blockInput !== undefined ? parseUniqueStringList(blockInput) : [];
  const allowList = answers['allowList'] !== undefined
    ? parseUniqueStringList(answers['allowList'])
    : [];

  const routerMode: 'merge' | 'overwrite' =
    String(answers['routerMode'] ?? 'merge').trim().toLowerCase() === 'overwrite'
      ? 'overwrite'
      : 'merge';

  const quotaLimit =
    answers['limits'] !== undefined && String(answers['limits']).trim() !== ''
      ? String(answers['limits']).trim()
      : answers['quotaLimit'] !== undefined
        ? (answers['quotaLimit'] as string | number)
        : '10, 5+20, 25';

  const resolvedTz =
    options.timezone ??
    (typeof answers['timezone'] === 'string' && answers['timezone'].trim() !== ''
      ? answers['timezone'].trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');

  const consentNote = automationLevel === 'auto-safe' ? C45_AUTO_SAFE_CONSENT_NOTE : undefined;

  const profile: AdaptiveProfileData = {
    purpose: String(evalMap.get('purpose')?.normalized ?? 'general'),
    budget,
    freeOnly: budget === 'free-only',
    priority,
    harnesses,
    routers,
    keyedProviders,
    preferredProviders: [...keyedProviders],
    dislikedProviders: [],
    favorites,
    keepHead: typeof answers['keepHead'] === 'number' ? Math.max(0, Math.trunc(answers['keepHead'])) : 0,
    allowList,
    denyList: [...blockList],
    blockList: [...blockList],
    routerMode,
    automationLevel,
    quotaLimit,
    scanCycle,
    timezone: resolvedTz,
    schedule: scanCycle === 'manual' ? 'manual' : scanCycle,
    assumptions,
    ...(consentNote ? { consentNote } : {}),
  };

  if (options.existingProfile) {
    return mergeProfileNonDestructive(options.existingProfile, answers, {
      timezone: options.timezone,
    });
  }

  return {
    valid: plan.questionsToAsk.length <= ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
    questionCountAsked: plan.questionsToAsk.length,
    questionsAsked: plan.questionsToAsk.map((q) => q.id),
    powerUserTrack: plan.powerUserDetected,
    profile,
    assumptions,
    ...(consentNote ? { consentNote } : {}),
  };
}

function isBlankKeepExisting(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  return false;
}

export function mergeProfileNonDestructive(
  existing: Record<string, unknown>,
  incomingAnswers: Record<string, unknown>,
  options: { timezone?: string | undefined } = {}
): AdaptiveProfileResult {
  const combined: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    combined[k] = v;
  }

  const preserveKeysOnBlank = [
    'purpose',
    'budget',
    'priority',
    'harnesses',
    'routers',
    'keyedProviders',
    'preferredProviders',
    'dislikedProviders',
    'favorites',
    'allowList',
    'denyList',
    'blockList',
    'routerMode',
    'automationLevel',
    'limits',
    'quotaLimit',
    'scanCycle',
    'timezone',
    'keepHead',
  ] as const;

  for (const [k, v] of Object.entries(incomingAnswers)) {
    if (preserveKeysOnBlank.includes(k as (typeof preserveKeysOnBlank)[number]) && isBlankKeepExisting(v)) {
      continue;
    }
    combined[k] = v;
  }

  const base = finalizeAdaptiveProfile(combined, { timezone: options.timezone });

  // Explicitly preserve existing arrays when incoming answer was blank
  const preserveArrayField = <T>(
    incomingKey: string,
    existingVal: unknown,
    fallback: T[]
  ): T[] => {
    if (isBlankKeepExisting(incomingAnswers[incomingKey]) && Array.isArray(existingVal)) {
      return [...(existingVal as T[])];
    }
    return fallback;
  };

  base.profile.harnesses = preserveArrayField('harnesses', existing['harnesses'], base.profile.harnesses);
  base.profile.routers = preserveArrayField('routers', existing['routers'], base.profile.routers);
  base.profile.keyedProviders = preserveArrayField(
    'keyedProviders',
    existing['keyedProviders'],
    base.profile.keyedProviders
  );
  base.profile.preferredProviders = preserveArrayField(
    'preferredProviders',
    existing['preferredProviders'] ?? existing['keyedProviders'],
    base.profile.preferredProviders
  );
  base.profile.dislikedProviders = preserveArrayField(
    'dislikedProviders',
    existing['dislikedProviders'],
    base.profile.dislikedProviders
  );
  base.profile.favorites = preserveArrayField('favorites', existing['favorites'], base.profile.favorites);
  base.profile.allowList = preserveArrayField('allowList', existing['allowList'], base.profile.allowList);

  const existingDeny = existing['blockList'] ?? existing['denyList'];
  if (isBlankKeepExisting(incomingAnswers['blockList']) && isBlankKeepExisting(incomingAnswers['denyList']) && Array.isArray(existingDeny)) {
    base.profile.denyList = [...(existingDeny as string[])];
    base.profile.blockList = [...(existingDeny as string[])];
  }

  if (isBlankKeepExisting(incomingAnswers['routerMode']) && (existing['routerMode'] === 'merge' || existing['routerMode'] === 'overwrite')) {
    base.profile.routerMode = existing['routerMode'];
  }
  if (isBlankKeepExisting(incomingAnswers['limits']) && existing['quotaLimit'] !== undefined) {
    base.profile.quotaLimit = existing['quotaLimit'] as string | number;
  }

  // Filter out assumptions for fields that were already present in `existing` and merely kept
  base.assumptions = base.assumptions.filter(
    (a) => !(isBlankKeepExisting(incomingAnswers[a.field]) && existing[a.field] !== undefined)
  );
  base.profile.assumptions = base.assumptions;

  return base;
}

export const runAdaptiveInterviewSession = finalizeAdaptiveProfile;
