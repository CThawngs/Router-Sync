/**
 * packages/cli/src/profile/interview.ts
 *
 * W2 interview questions (VI, 12 items) + C45 WP6 Adaptive User Interview
 * session & non-destructive sandbox `profile.yaml` writer (Phục vụ: S5).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  ADAPTIVE_INTERVIEW_FLOW,
  ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
  assertControlledWriteSandbox,
  C45_AUTO_SAFE_CONSENT_NOTE,
  createAdaptiveInterviewPlan,
  evaluateAdaptiveAnswer,
  finalizeAdaptiveProfile,
  INTERVIEW_QUESTIONS,
  isVagueOrUncertainInput,
  mergeProfileNonDestructive,
  runAdaptiveInterviewSession,
  type AdaptiveInterviewPlan,
  type AdaptiveInterviewQuestion,
  type AdaptiveProfileData,
  type AdaptiveProfileResult,
  type InterviewQuestion,
  type ProfileAssumption,
} from '@routersync/core';
import {
  assertHarnessWriteSandboxAllowed,
  assertOpenMausBotSafeFile,
} from '../apps/write-adapter.js';
import { validateProfile, type Profile } from './schema.js';

export {
  INTERVIEW_QUESTIONS,
  ADAPTIVE_INTERVIEW_FLOW,
  ADAPTIVE_INTERVIEW_MAX_QUESTIONS,
  C45_AUTO_SAFE_CONSENT_NOTE,
  createAdaptiveInterviewPlan,
  evaluateAdaptiveAnswer,
  finalizeAdaptiveProfile,
  isVagueOrUncertainInput,
  mergeProfileNonDestructive,
  runAdaptiveInterviewSession,
};
export type {
  InterviewQuestion,
  AdaptiveInterviewPlan,
  AdaptiveInterviewQuestion,
  AdaptiveProfileData,
  AdaptiveProfileResult,
  ProfileAssumption,
};

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseProfileAnswers(
  answers: Record<string, string>
): { ok: true; profile: Profile } | { ok: false; errors: string[] } {
  const pick = (id: string, fallback: string): string => {
    const v = answers[id];
    return v === undefined || v.trim() === '' ? fallback : v.trim();
  };
  const freeOnlyBool = pick('freeOnly', 'Y').toLowerCase() !== 'n';
  const raw: Record<string, unknown> = {
    purpose: pick('purpose', 'general coding'),
    priority: splitList(pick('priority', 'quality, speed, price, context')),
    budget: freeOnlyBool ? 'free-only' : 'paid',
    freeOnly: freeOnlyBool,
    preferredProviders: splitList(pick('preferredProviders', '')),
    dislikedProviders: splitList(pick('dislikedProviders', '')),
    favorites: splitList(pick('favorites', '')),
    keepHead: Number(pick('keepHead', '0')),
    allowList: splitList(pick('allowList', '')),
    denyList: splitList(pick('denyList', '')),
    automationLevel: pick('automationLevel', 'observe'),
    quotaLimit: (() => {
      const v = pick('limits', '10, 5+20, 25');
      return v;
    })(),
    scanCycle: pick('scanCycle', 'daily'),
    timezone: pick(
      'timezone',
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Ho_Chi_Minh'
    ),
  };
  try {
    const profile = validateProfile(raw);
    return { ok: true, profile };
  } catch (e) {
    // D7: một câu tiếng Việt mỗi lỗi, dạng `field: message (bạn nhập <giá trị>)`.
    if (e instanceof ZodError) {
      const errors = e.issues.map((issue) => {
        const field = issue.path.join('.') || 'profile';
        let msg = issue.message;
        if (msg.startsWith(field + ':')) msg = msg.slice(field.length + 1).trim();
        const entered = raw[field];
        const enteredStr =
          entered !== undefined ? ` (bạn nhập ${JSON.stringify(entered)})` : '';
        const extra =
          field === 'automationLevel'
            ? ' Lưu ý: chọn auto-safe chỉ có hiệu lực khi chủ gõ "bật tự động".'
            : '';
        return `${field}: ${msg}${enteredStr}.${extra}`;
      });
      return { ok: false, errors };
    }
    return { ok: false, errors: [(e as Error).message] };
  }
}

export function serializeAdaptiveProfileToYaml(profile: AdaptiveProfileData | Profile): string {
  return `# RouterSync Adaptive Profile (C45 WP6)\n${stringifyYaml(profile)}`;
}

export function saveAdaptiveProfileYaml(
  targetPath: string,
  answers: Record<string, unknown>,
  options: { mergeExisting?: boolean | undefined; timezone?: string | undefined } = {}
): AdaptiveProfileResult & { savedPath: string; profileYaml: string } {
  const resolvedPath = path.resolve(targetPath);
  assertOpenMausBotSafeFile(resolvedPath);
  if (process.env['ROUTERSYNC_ALLOW_UNSAFE_LIVE_HARNESS_WRITE'] !== '1') {
    assertControlledWriteSandbox(resolvedPath, 'harness-config');
    assertHarnessWriteSandboxAllowed(resolvedPath);
  }

  let existing: Record<string, unknown> | undefined;
  if (options.mergeExisting !== false && fs.existsSync(resolvedPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(resolvedPath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = undefined;
    }
  }

  const session = existing
    ? mergeProfileNonDestructive(existing, answers, { timezone: options.timezone })
    : finalizeAdaptiveProfile(answers, { timezone: options.timezone });

  const validated = validateProfile(session.profile);
  const profileYaml = serializeAdaptiveProfileToYaml(validated);

  const lstat = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (lstat?.isSymbolicLink()) {
    throw new Error(`Refusing atomic profile write over symbolic link target: ${resolvedPath}`);
  }
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${resolvedPath}.routersync-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, Buffer.from(profileYaml, 'utf8'), { mode: 0o600 });
  fs.renameSync(tmpPath, resolvedPath);

  return {
    ...session,
    profile: validated as unknown as AdaptiveProfileData,
    savedPath: resolvedPath,
    profileYaml,
  };
}
