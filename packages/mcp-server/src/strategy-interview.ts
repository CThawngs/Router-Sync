/**
 * packages/mcp-server/src/strategy-interview.ts
 *
 * C45 WP5 + WP6 Read-Only MCP Helpers & Prompt Registration (Phục vụ: S4, S5):
 *  - `buildListStrategiesPayload`: upgrades `list_strategies` with canonical
 *    `9router`, `omniroute`, and `litellm` capability metadata while preserving
 *    100% backward compatibility with `strategies[]`.
 *  - `buildProfileInterviewPayload`: upgrades `profile_interview` with the
 *    `<= 12`-question adaptive interview state machine & in-memory YAML synthesis
 *    with ZERO disk writes (`READ_ONLY_TOOL_NAMES` invariant).
 *  - `registerAdaptiveInterviewPrompt`: registers `routersync_adaptive_interview`
 *    on `McpServer`.
 */

import * as fs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADAPTIVE_INTERVIEW_FLOW,
  ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
  createAdaptiveInterviewPlan,
  finalizeAdaptiveProfile,
  getRouterStrategyCapabilities,
  INTERVIEW_QUESTIONS,
  mergeProfileNonDestructive,
  STRATEGY_SELECTION_GUIDELINES,
  type ComboDefinition,
  type RouterKind,
} from '@routersync/core';
import { resolveStatePaths, statFile } from './state.js';

export function buildListStrategiesPayload(
  combos: readonly ComboDefinition[],
  routerKind?: RouterKind
): Record<string, unknown> {
  const byStrategy = new Map<string, { strategy: string; combos: string[] }>();

  for (const combo of combos) {
    const strategy = combo.strategy ?? 'unspecified';
    const entry = byStrategy.get(strategy) ?? { strategy, combos: [] };
    entry.combos.push(combo.name);
    byStrategy.set(strategy, entry);
  }

  const strategies = [...byStrategy.values()]
    .map((entry) => ({ ...entry, comboCount: entry.combos.length }))
    .sort((a, b) => b.comboCount - a.comboCount);

  return {
    source: 'strategy field of each readable combo + canonical router capability matrix',
    comboCount: combos.length,
    strategies,
    routerCapabilities: getRouterStrategyCapabilities(routerKind),
    selectionGuidelines: STRATEGY_SELECTION_GUIDELINES,
  };
}

export interface ProfileInterviewToolArgs {
  mode?: 'questions' | 'evaluate' | undefined;
  answers?: Record<string, unknown> | undefined;
  existingProfile?: Record<string, unknown> | undefined;
}

export function buildProfileInterviewPayload(
  args: ProfileInterviewToolArgs = {}
): Record<string, unknown> {
  const paths = resolveStatePaths();
  const exists = fs.existsSync(paths.profile);

  let diskAnswers: Record<string, unknown> | null = null;
  let profileError: string | null = null;
  if (exists) {
    try {
      const parsed = parseYaml(fs.readFileSync(paths.profile, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        diskAnswers = parsed as Record<string, unknown>;
      }
    } catch (error) {
      profileError = error instanceof Error ? error.message : String(error);
    }
  }

  if (args.answers !== undefined) {
    const baseExisting = args.existingProfile ?? diskAnswers ?? undefined;
    const session = baseExisting
      ? mergeProfileNonDestructive(baseExisting, args.answers)
      : finalizeAdaptiveProfile(args.answers);

    const profileYaml = `# RouterSync Adaptive Profile (C45 WP6)\n${stringifyYaml(session.profile)}`;
    return {
      valid: session.valid,
      maxQuestions: ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
      questionCountAsked: session.questionCountAsked,
      questionsAsked: session.questionsAsked,
      powerUserTrack: session.powerUserTrack,
      profile: session.profile,
      assumptions: session.assumptions,
      c45ConsentNote: session.consentNote ?? null,
      profileYaml,
      diskWrites: 0,
      nextActionCliCommand:
        'routersync profile interview --adaptive --answers <answers-json> --write',
    };
  }

  const answeredIds = diskAnswers === null ? [] : Object.keys(diskAnswers);
  const pendingLegacy = INTERVIEW_QUESTIONS.filter(
    (question) => !answeredIds.includes(question.id)
  );
  const adaptivePlan = createAdaptiveInterviewPlan(diskAnswers ?? {});
  const pendingAdaptive = adaptivePlan.questionsToAsk.filter(
    (question) => !answeredIds.includes(question.id)
  );

  const adaptiveQuestionsFormatted = adaptivePlan.questionsToAsk.map((q) => ({
    id: q.id,
    domain: q.domain,
    tier: q.tier,
    prompt: q.prompt,
    examples: [...q.examples],
    default: q.default,
    hint: q.hint,
    ...(q.branchCondition ? { branchCondition: q.branchCondition } : {}),
  }));

  const legacyQuestionsFormatted = INTERVIEW_QUESTIONS.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    default: question.default,
    hint: question.hint,
  }));

  return {
    maxQuestions: ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
    questionCount: INTERVIEW_QUESTIONS.length,
    adaptiveQuestionCount: adaptiveQuestionsFormatted.length,
    questions: adaptiveQuestionsFormatted,
    adaptiveQuestions: adaptiveQuestionsFormatted,
    optionalFollowUpQuestions: ADAPTIVE_INTERVIEW_FLOW.followUpQuestions.map((q) => ({
      id: q.id,
      domain: q.domain,
      tier: q.tier,
      prompt: q.prompt,
      examples: [...q.examples],
      default: q.default,
      hint: q.hint,
      ...(q.branchCondition ? { branchCondition: q.branchCondition } : {}),
    })),
    legacyQuestions: legacyQuestionsFormatted,
    profilePath: paths.profile,
    profilePresent: exists,
    profileBytes: exists ? (statFile(paths.profile).bytes ?? null) : null,
    answers: diskAnswers,
    pendingQuestionIds: pendingLegacy.map((question) => question.id),
    pendingAdaptiveQuestionIds: pendingAdaptive.map((question) => question.id),
    profileError,
  };
}

export function registerAdaptiveInterviewPrompt(server: McpServer): void {
  server.prompt(
    'routersync_adaptive_interview',
    'Conducts a friendly <= 12-question adaptive RouterSync setup interview with explicit assumptions and zero inventory fabrication',
    {
      harness: z
        .string()
        .optional()
        .describe('Optional active harness ID (e.g. hermes, claude-code, openmausbot, opencode)'),
    },
    async (args) => {
      const harnessContext = args.harness ? `Active harness context: ${args.harness}.\n` : '';
      const coreLines = ADAPTIVE_INTERVIEW_FLOW.coreQuestions
        .map((q, idx) => `${idx + 1}. [${q.id}] ${q.prompt}`)
        .join('\n');

      const instructions = [
        'You are running the RouterSync C45 WP6 Adaptive User Interview (strictly <= 12 questions total).',
        harnessContext,
        'Mandatory Interview Rules:',
        '1. Ask plain everyday questions (7..8 core questions for everyday users; up to 4 optional follow-ups ONLY for power users, never exceeding 12 questions total).',
        '2. NEVER ask the user to paste API keys or secrets into chat.',
        '3. NEVER fabricate or guess factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`). If unstated or "not sure", keep `[]` and record an assumption.',
        '4. For vague preference answers ("idk", "whatever"), apply conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and list every assumption explicitly.',
        '5. Remind the user that `auto-safe` starts in `propose` until at least 1 `propose` apply completes with verified read-back (C45 §3.2), and `routersync freeze` stops all writes immediately.',
        '',
        'Core Everyday Questions:',
        coreLines,
        '',
        'After collecting answers, call the read-only `profile_interview` MCP tool with `{ "answers": { ... } }` to validate in memory and show the resulting `profile.yaml` and `assumptions[]`.',
      ].join('\n');

      return {
        description: 'RouterSync <= 12-Question Adaptive User Interview Protocol',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: instructions,
            },
          },
        ],
      };
    }
  );
}
