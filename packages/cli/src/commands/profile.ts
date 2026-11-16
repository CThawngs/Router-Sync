/**
 * packages/cli/src/commands/profile.ts
 *
 * Command handler for `routersync profile`:
 * - `routersync profile init`
 * - `routersync profile show`
 * - `routersync profile export --json`
 */

import * as readline from 'node:readline/promises';
import {
  loadProfile,
  writeProfile,
  formatProfileSummary,
  getDefaultProfilePath,
} from '../profile/manager.js';
import type { UserProfile, WorkloadRole, CostPreference } from '../profile/types.js';
import { createDefaultProfile } from '../profile/schema.js';
import { INTERVIEW_QUESTIONS } from '../profile/interview.js';

export interface ProfileCommandOptions {
  subcommand?: 'init' | 'show' | 'export' | 'interview';
  json?: boolean;
  path?: string;
  yes?: boolean;
  workload?: string;
  cost?: string;
  strategy?: string;
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
      console.log(`[INFO] Chưa tìm thấy profile tại ${sourcePath}. Hiển thị cấu hình mặc định (chưa lưu).`);
    }
    console.log(formatProfileSummary(profile, sourcePath));
    return;
  }

  if (sub === 'interview') {
    for (const q of INTERVIEW_QUESTIONS) {
      console.log(`${q.id}: ${q.prompt} [mặc định: ${q.default}] — ${q.hint}`);
    }
    console.log('[INFO] Dùng parseProfileAnswers() để kiểm tra đáp án; chỉ ghi profile.yaml khi xác nhận.');
    return;
  }

  if (sub === 'export') {
    const { profile } = loadProfile(options.path);
    if (options.json) {
      console.log(JSON.stringify(profile, null, 2));
    } else {
      console.log(JSON.stringify(profile, null, 2));
    }
    return;
  }

  if (sub === 'init') {
    const targetPath = options.path ?? getDefaultProfilePath();
    const profile = createDefaultProfile();

    if (options.yes || !process.stdin.isTTY) {
      // Non-interactive / --yes mode
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

    // Interactive mode via readline
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('='.repeat(78));
      console.log('ROUTERSYNC PROFILE SETUP (Khởi tạo hồ sơ người dùng)');
      console.log('='.repeat(78));

      // P1: Workload
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

      // P2: Cost Preference
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

      // P3: Preferred Providers
      console.log('\n[P3] Danh sách nhà cung cấp ưu tiên (Preferred Providers):');
      const ansP3 = (
        await rl.question(
          'Nhập tên các provider phân tách bằng dấu phẩy [mặc định: gemini, groq, nvidia, oc, sambanova]: '
        )
      ).trim();
      if (ansP3.length > 0) {
        profile.general.preferredProviders = ansP3.split(',').map((s) => s.trim().toLowerCase());
      }

      // C1-C5: Combo configuration
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

      const ansC3 = (await rl.question('C3 Số bước tối thiểu (Min steps, Invariant I3 >= 2) [mặc định: 2]: ')).trim();
      const minSteps = Math.max(2, parseInt(ansC3, 10) || 2);

      const ansC4 = (await rl.question('C4 Bật xen kẽ provider ở đuôi combo (Interleaving) [Y/n, mặc định: Y]: ')).trim();
      const enableInterleaving = ansC4.toLowerCase() !== 'n';

      const ansC5 = (await rl.question('C5 Giới hạn chỉ dùng mô hình miễn phí (Free-only) [Y/n, mặc định: Y]: ')).trim();
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
