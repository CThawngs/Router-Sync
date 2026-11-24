/**
 * packages/cli/src/commands/profile.ts
 *
 * Command handler for `routersync profile`:
 * - `routersync profile init`
 * - `routersync profile show`
 * - `routersync profile export --json`
 * - `routersync profile interview [--adaptive] [--answers <jsonOrFile>] [--write] [--json]`
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { parse as parseYaml } from 'yaml';
import {
  loadProfile,
  writeProfile,
  formatProfileSummary,
  getDefaultProfilePath,
} from '../profile/manager.js';
import type { UserProfile, WorkloadRole, CostPreference } from '../profile/types.js';
import { createDefaultProfile, validateProfile } from '../profile/schema.js';
import {
  ADAPTIVE_INTERVIEW_FLOW,
  createAdaptiveInterviewPlan,
  finalizeAdaptiveProfile,
  INTERVIEW_QUESTIONS,
  mergeProfileNonDestructive,
  saveAdaptiveProfileYaml,
  serializeAdaptiveProfileToYaml,
} from '../profile/interview.js';

export interface ProfileCommandOptions {
  subcommand?: 'init' | 'show' | 'export' | 'interview';
  json?: boolean;
  path?: string;
  yes?: boolean;
  workload?: string;
  cost?: string;
  strategy?: string;
  adaptive?: boolean;
  answers?: string;
  write?: boolean;
}

function parseAnswersInput(rawAnswers: string): Record<string, unknown> {
  const trimmed = rawAnswers.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  if (fs.existsSync(trimmed)) {
    return JSON.parse(fs.readFileSync(trimmed, 'utf8')) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export async function runProfileCommand(options: ProfileCommandOptions): Promise<void> {
  const sub = options.subcommand || 'show';

  if (sub === 'show') {
    const { profile, sourcePath, isNew } = loadProfile(options.path);
    if (options.json) {
      console.log(JSON.stringify(profile, null, 2));
      return;
    }
    if (isNew) {
      console.log(
        `[INFO] Chưa tìm thấy profile tại ${sourcePath}. Hiển thị cấu hình mặc định (chưa lưu).`
      );
    }
    console.log(formatProfileSummary(profile, sourcePath));
    return;
  }

  if (sub === 'interview') {
    if (options.adaptive || options.answers !== undefined) {
      if (options.answers !== undefined) {
        const parsedAnswers = parseAnswersInput(options.answers);
        const targetPath = options.path ?? getDefaultProfilePath();

        if (options.write) {
          const saved = saveAdaptiveProfileYaml(targetPath, parsedAnswers, {
            mergeExisting: true,
          });
          if (options.json) {
            console.log(JSON.stringify(saved, null, 2));
          } else {
            console.log(`[OK] Saved adaptive profile (${saved.questionCountAsked} questions) to ${saved.savedPath}`);
          }
          return;
        }

        let existing: Record<string, unknown> | undefined;
        if (options.path && fs.existsSync(options.path)) {
          const rawExisting = parseYaml(fs.readFileSync(options.path, 'utf8'));
          if (rawExisting && typeof rawExisting === 'object' && !Array.isArray(rawExisting)) {
            existing = rawExisting as Record<string, unknown>;
          }
        }
        const session = existing
          ? mergeProfileNonDestructive(existing, parsedAnswers)
          : finalizeAdaptiveProfile(parsedAnswers);
        const validated = validateProfile(session.profile);
        const payload = {
          ...session,
          profile: validated,
          profileYaml: serializeAdaptiveProfileToYaml(validated),
        };
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(payload.profileYaml);
        }
        return;
      }

      const plan = createAdaptiveInterviewPlan({});
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              maxQuestions: ADAPTIVE_INTERVIEW_FLOW.maxQuestions,
              coreQuestions: plan.coreQuestions,
              followUpQuestions: ADAPTIVE_INTERVIEW_FLOW.followUpQuestions,
            },
            null,
            2
          )
        );
        return;
      }
      for (const q of plan.coreQuestions) {
        console.log(`${q.id}: ${q.prompt} [default: ${q.default || '[]'}] — ${q.hint}`);
      }
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({ questionCount: INTERVIEW_QUESTIONS.length, questions: INTERVIEW_QUESTIONS }, null, 2));
      return;
    }
    for (const q of INTERVIEW_QUESTIONS) {
      console.log(`${q.id}: ${q.prompt} [mặc định: ${q.default}] — ${q.hint}`);
    }
    console.log('[INFO] Dùng parseProfileAnswers() để kiểm tra đáp án; chỉ ghi profile.yaml khi xác nhận.');
    return;
  }

  if (sub === 'export') {
    const { profile } = loadProfile(options.path);
    console.log(JSON.stringify(profile, null, 2));
    return;
  }

  if (sub === 'init') {
    const targetPath = options.path ?? getDefaultProfilePath();
    const profile = createDefaultProfile();

    if (options.yes || !process.stdin.isTTY) {
      if (options.workload && ['coding', 'reasoning', 'general-chat', 'agent'].includes(options.workload)) {
        profile.general.workload = options.workload as WorkloadRole;
      }
      if (options.cost && ['free-only', 'budget', 'performance-first'].includes(options.cost)) {
        profile.general.costPreference = options.cost as CostPreference;
      }
      if (options.strategy && ['fallback', 'round-robin', 'priority-matrix'].includes(options.strategy)) {
        profile.combos[0]!.strategy = options.strategy as 'fallback' | 'round-robin' | 'priority-matrix';
      }

      const savedPath = writeProfile(profile, targetPath);
      console.log(`[OK] Khởi tạo hồ sơ người dùng thành công tại: ${savedPath}`);
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('='.repeat(78));
      console.log('ROUTERSYNC PROFILE SETUP (Khởi tạo hồ sơ người dùng)');
      console.log('='.repeat(78));

      console.log('\n[P1] Chọn tác vụ chính (Workload):');
      console.log('  1. coding        (Lập trình, sửa lỗi & refactoring)');
      console.log('  2. reasoning     (Suy luận toán học, khoa học & logic phức tạp)');
      console.log('  3. general-chat  (Trò chuyện thường thức & tóm tắt)');
      console.log('  4. agent         (Tool-use, agentic loops & multi-step execution)');
      const ansP1 = (await rl.question('Lựa chọn [1-4, mặc định: 1]: ')).trim();
      const workloadMap: Record<string, WorkloadRole> = {
        '1': 'coding',
        '2': 'reasoning',
        '3': 'general-chat',
        '4': 'agent',
      };
      profile.general.workload = workloadMap[ansP1] ?? 'coding';

      console.log('\n[P2] Tùy chọn chi phí (Cost Preference):');
      console.log('  1. free-only          (Chỉ dùng mô hình 100% miễn phí)');
      console.log('  2. budget             (Ưu tiên miễn phí, cho phép gói rẻ nếu cần)');
      console.log('  3. performance-first  (Ưu tiên hiệu năng cao nhất, không giới hạn giá)');
      const ansP2 = (await rl.question('Lựa chọn [1-3, mặc định: 1]: ')).trim();
      const costMap: Record<string, CostPreference> = {
        '1': 'free-only',
        '2': 'budget',
        '3': 'performance-first',
      };
      profile.general.costPreference = costMap[ansP2] ?? 'free-only';

      console.log('\n[P3] Danh sách nhà cung cấp ưu tiên (Preferred Providers):');
      const ansP3 = (
        await rl.question(
          'Nhập tên các provider phân tách bằng dấu phẩy [mặc định: gemini, groq, nvidia, oc, sambanova]: '
        )
      ).trim();
      if (ansP3.length > 0) {
        profile.general.preferredProviders = ansP3.split(',').map((s) => s.trim().toLowerCase());
      }

      console.log('\n[C1-C5] Cấu hình Combo:');
      const ansC1 = (await rl.question('C1 Target Combo [mặc định: all]: ')).trim() || 'all';
      console.log('C2 Chiến lược định tuyến (Routing Strategy):');
      console.log('  1. fallback        (Tuần tự: 9Router fallback / OmniRoute priority)');
      console.log('  2. round-robin     (Xoay vòng: 9Router round-robin / OmniRoute round-robin)');
      console.log('  3. priority-matrix (Ma trận ưu tiên Policy §12)');
      const ansC2 = (await rl.question('Lựa chọn [1-3, mặc định: 1]: ')).trim();
      const stratMap: Record<string, 'fallback' | 'round-robin' | 'priority-matrix'> = {
        '1': 'fallback',
        '2': 'round-robin',
        '3': 'priority-matrix',
      };
      const strategy = stratMap[ansC2] ?? 'fallback';

      const ansC3 = (
        await rl.question('C3 Số bước tối thiểu (Min steps, Invariant I3 >= 2) [mặc định: 2]: ')
      ).trim();
      const minSteps = Math.max(2, parseInt(ansC3, 10) || 2);

      const ansC4 = (
        await rl.question('C4 Bật xen kẽ provider ở đuôi combo (Interleaving) [Y/n, mặc định: Y]: ')
      ).trim();
      const enableInterleaving = ansC4.toLowerCase() !== 'n';

      const ansC5 = (
        await rl.question('C5 Giới hạn chỉ dùng mô hình miễn phí (Free-only) [Y/n, mặc định: Y]: ')
      ).trim();
      const freeOnly = ansC5.toLowerCase() !== 'n';

      profile.combos = [
        {
          targetCombo: ansC1,
          strategy,
          minSteps,
          enableInterleaving,
          freeOnly,
        },
      ];

      const savedPath = writeProfile(profile, targetPath);
      console.log(`\n[OK] Hồ sơ đã được lưu thành công vào: ${savedPath}`);
      console.log(formatProfileSummary(profile, savedPath));
    } finally {
      rl.close();
    }
  }
}
