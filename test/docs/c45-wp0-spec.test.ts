/**
 * test/docs/c45-wp0-spec.test.ts
 *
 * C45-WP0 (Phục vụ: S10) — Automated contract tests for:
 *  - docs/SPEC.md (verbatim S1..S10, verified file:line gap table, C45 safety rules)
 *  - docs/ROADMAP.md (Phase 5 & auto-safe promoted to active 1.0.0 work; 0.1.0 unreleased diagnostic snapshot)
 *  - docs/RELEASE-CANDIDATE.md, CHANGELOG.md, tools/release/prepare-v1-release.mjs
 *  - docs/BACKLOG.md (WP0..WP9 with mandatory `Phục vụ: S#` and 7 standard fields)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readRel(...parts: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
}

function existsRel(...parts: string[]): boolean {
  return fs.existsSync(path.join(REPO_ROOT, ...parts));
}

describe('C45-WP0: docs/SPEC.md canonical specification & verified gap table', () => {
  const spec = readRel('docs', 'SPEC.md');

  it('preserves S1..S10 verbatim clauses from C45 §1', () => {
    const requiredVerbatimSnippets = [
      'S1.',
      'người dùng không còn tự cấu hình, tự cập nhật, tự tìm model bằng tay',
      'S2.',
      'một MCP server gắn vào các harness có sẵn',
      'S3.',
      'Hướng A, với harness:',
      'S4.',
      'Hướng B, với router (9Router, OmniRoute, LiteLLM và các router khác):',
      'S5.',
      'Agent phải hỏi kỹ người dùng để biết nhu cầu.',
      'S6.',
      'Tận dụng cron có sẵn của harness.',
      'S7.',
      'Gần như không tốn token. Tác vụ lặp lại chạy bằng mã xác định, 0 token.',
      'S8.',
      'Giao việc cho đội bot theo gói lớn, hoàn chỉnh, không sa vào từng tính năng nhỏ.',
      'S9.',
      'Giai đoạn cuối: kiểm thử end-to-end thật, dữ liệu thật, ghi database thật',
      'S10.',
      'Mỗi PR và mỗi vé ghi rõ phục vụ điều khoản nào (S1 đến S9); PM từ chối vé không ghi được.',
    ];

    for (const snippet of requiredVerbatimSnippets) {
      expect(spec, `Missing verbatim clause snippet in docs/SPEC.md: ${snippet}`).toContain(snippet);
    }
  });

  it('verifies every repo file cited in Section 2 exists and documents the 4-app inspect correction', () => {
    const sec2Start = spec.indexOf('## 2.');
    const sec3Start = spec.indexOf('## 3.');
    expect(sec2Start).toBeGreaterThan(-1);
    expect(sec3Start).toBeGreaterThan(sec2Start);
    const sec2 = spec.slice(sec2Start, sec3Start);

    // Every cited repo file path with line numbers in Section 2 must exist on disk
    const fileCitationRe = /`((?:packages|docs|tools|registry|test)\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]+)(?::[0-9,\-]+)?`/g;
    const citedFiles = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = fileCitationRe.exec(sec2)) !== null) {
      if (match[1]) citedFiles.add(match[1]);
    }
    expect(citedFiles.size).toBeGreaterThanOrEqual(15);
    for (const relFile of citedFiles) {
      expect(existsRel(relFile), `Cited file in docs/SPEC.md Section 2 does not exist: ${relFile}`).toBe(true);
    }

    // Verified correction: apps/inspect.ts inspects 4 apps (hermes, dsh, opencode, openmausbot)
    expect(sec2).toContain('packages/cli/src/apps/inspect.ts:35');
    expect(sec2).toContain('packages/cli/src/apps/openmausbot.ts');
    expect(sec2).toContain('hermes');
    expect(sec2).toContain('dsh');
    expect(sec2).toContain('opencode');
    expect(sec2).toContain('openmausbot');
    expect(sec2).toContain('packages/cli/src/apps/inspect.ts:5');
  });

  it('documents C45 §3 operational & safety invariants', () => {
    const sec3 = spec.slice(spec.indexOf('## 3.'));
    expect(sec3).toContain('Phục vụ: S#');
    expect(sec3).toContain('`propose`');
    expect(sec3).toContain('`auto-safe`');
    expect(sec3).toContain('`off`');
    expect(sec3).toMatch(/read-back/i);
    expect(sec3).toMatch(/backup/i);
    expect(sec3).toMatch(/atomic/i);
    expect(sec3).toMatch(/auto-rollback/i);
    expect(sec3).toContain('os.tmpdir()');
    expect(sec3).toMatch(/không gọi.*LLM/i);
  });
});

describe('C45-WP0: docs/ROADMAP.md promotion of Phase 5 & auto-safe to 1.0.0', () => {
  const roadmap = readRel('docs', 'ROADMAP.md');

  it('labels 0.1.0 as an unreleased read-only diagnostic snapshot', () => {
    expect(roadmap).toContain('bản chẩn đoán chỉ đọc');
    expect(roadmap).toMatch(/không phát hành/i);
  });

  it('promotes Phase 5 and auto-safe into active 1.0.0 work and removes auto-safe from deferred list', () => {
    expect(roadmap).toMatch(/Phase 5:.*1\.0\.0/);
    for (let i = 0; i <= 9; i += 1) {
      expect(roadmap).toContain(`WP${i}`);
    }

    const deferredStart = roadmap.indexOf('## Hoãn sau');
    expect(deferredStart).toBeGreaterThan(-1);
    const nextSection = roadmap.indexOf('\n---', deferredStart);
    const deferredBlock = roadmap.slice(deferredStart, nextSection > -1 ? nextSection : undefined);
    expect(deferredBlock).not.toMatch(/-\s*\*\*Chế độ auto-safe/i);
  });
});

describe('C45-WP0: docs/RELEASE-CANDIDATE.md, CHANGELOG.md & tools/release/prepare-v1-release.mjs', () => {
  const rcDoc = readRel('docs', 'RELEASE-CANDIDATE.md');
  const changelog = readRel('CHANGELOG.md');
  const scriptPath = path.join(REPO_ROOT, 'tools', 'release', 'prepare-v1-release.mjs');

  it('documents unreleased 0.1.0 diagnostic snapshot, straight-to-1.0.0 strategy, and 8 publishable packages', () => {
    expect(rcDoc).toContain('Bản chẩn đoán chỉ đọc');
    expect(rcDoc).toContain('1.0.0');
    expect(rcDoc).toContain('1.0.0-rc.1');
    expect(rcDoc).toContain('next');
    expect(rcDoc).toContain('git push origin v1.0.0');
    expect(rcDoc).toContain('tools/release/prepare-v1-release.mjs');

    const publishable = [
      '@routersync/adapter-sdk',
      '@routersync/core',
      '@routersync/sources',
      '@routersync/adapter-9router',
      '@routersync/adapter-omniroute',
      '@routersync/daemon',
      '@routersync/cli',
      '@routersync/mcp-server',
    ];
    for (const pkgName of publishable) {
      expect(rcDoc).toContain(pkgName);
    }

    expect(changelog).toContain('## [1.0.0]');
    expect(changelog).toContain('Read-only diagnostic snapshot');
  });

  it('runs prepare-v1-release.mjs in --dry-run mode cleanly without modifying workspace 0.1.0 versions', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);

    const res = spawnSync(
      process.execPath,
      [scriptPath, '--target', '1.0.0', '--dry-run', '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
    );
    expect(res.status, `dry-run failed: ${res.stderr}`).toBe(0);

    const report = JSON.parse(res.stdout) as {
      mode: string;
      target: string;
      distTag: string;
      explicitTagPushCommand: string;
      publishableCount: number;
      privateCount: number;
      entries: Array<{ relPath: string; previousVersion: string; written: boolean }>;
    };

    expect(report.mode).toBe('dry-run');
    expect(report.target).toBe('1.0.0');
    expect(report.distTag).toBe('latest');
    expect(report.explicitTagPushCommand).toBe('git push origin v1.0.0');
    expect(report.publishableCount).toBe(8);
    expect(report.privateCount).toBe(2);
    expect(report.entries.every((e) => e.written === false)).toBe(true);

    // Workspace packages must remain at 0.1.0 so AT-167 stays green until WP9 release cut
    const cliPkg = JSON.parse(readRel('packages', 'cli', 'package.json')) as { version: string };
    expect(cliPkg.version).toBe('0.1.0');
  });

  it('applies 1.0.0-rc.1 version bump cleanly on an isolated os.tmpdir() copy and rejects invalid targets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-wp0-release-'));
    try {
      const manifests = [
        { rel: 'package.json', name: 'routersync', private: true },
        { rel: 'packages/adapter-sdk/package.json', name: '@routersync/adapter-sdk', private: false },
        { rel: 'packages/core/package.json', name: '@routersync/core', private: false },
        { rel: 'packages/sources/package.json', name: '@routersync/sources', private: false },
        { rel: 'packages/adapter-9router/package.json', name: '@routersync/adapter-9router', private: false },
        { rel: 'packages/adapter-omniroute/package.json', name: '@routersync/adapter-omniroute', private: false },
        { rel: 'packages/daemon/package.json', name: '@routersync/daemon', private: false },
        { rel: 'packages/cli/package.json', name: '@routersync/cli', private: false },
        { rel: 'packages/mcp-server/package.json', name: '@routersync/mcp-server', private: false },
        { rel: 'packages/ui/package.json', name: '@routersync/ui', private: true },
      ];

      for (const m of manifests) {
        const dest = path.join(tmpDir, m.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(
          dest,
          `${JSON.stringify({ name: m.name, version: '0.1.0', private: m.private }, null, 2)}\n`,
          'utf8'
        );
      }

      const writeRes = spawnSync(
        process.execPath,
        [scriptPath, '--target', '1.0.0-rc.1', '--write', '--root', tmpDir, '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
      );
      expect(writeRes.status, `write on tmpDir failed: ${writeRes.stderr}`).toBe(0);

      const report = JSON.parse(writeRes.stdout) as {
        mode: string;
        target: string;
        distTag: string;
        explicitTagPushCommand: string;
        entries: Array<{ written: boolean }>;
      };
      expect(report.mode).toBe('write');
      expect(report.target).toBe('1.0.0-rc.1');
      expect(report.distTag).toBe('next');
      expect(report.explicitTagPushCommand).toBe('git push origin v1.0.0-rc.1');
      expect(report.entries.every((e) => e.written === true)).toBe(true);

      for (const m of manifests) {
        const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, m.rel), 'utf8')) as {
          version: string;
        };
        expect(updated.version).toBe('1.0.0-rc.1');
      }

      const badRes = spawnSync(
        process.execPath,
        [scriptPath, '--target', '0.2.0', '--dry-run', '--root', tmpDir],
        { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
      );
      expect(badRes.status).not.toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('C45-WP0: docs/BACKLOG.md WP0..WP9 traceability & 7-field completeness', () => {
  const backlog = readRel('docs', 'BACKLOG.md');

  it('enforces Rule S10 and defines WP0..WP9 with Phục vụ: S# and all 7 standard fields', () => {
    expect(backlog).toContain('## Chương trình C45 — Lộ trình 1.0.0 Đầy đủ Đặc tả S1–S10 (WP0–WP9)');
    expect(backlog).toContain('Phục vụ: S#');

    const expectedEvidence: Record<number, string> = {
      0: 'evidence/d1',
      1: 'evidence/d1',
      2: 'evidence/d1',
      3: 'evidence/d1',
      4: 'evidence/d2',
      5: 'evidence/d2',
      6: 'evidence/d2',
      7: 'evidence/d3',
      8: 'evidence/d3',
      9: 'evidence/d3',
    };

    const requiredFields = [
      '1. **Mục tiêu:**',
      '2. **Tiêu chí chấp nhận:**',
      '3. **Người làm:**',
      '4. **Người xác minh độc lập:**',
      '5. **Tệp dự kiến:**',
      '6. **Rủi ro:**',
      '7. **Lệnh kiểm chứng:**',
    ];

    for (let i = 0; i <= 9; i += 1) {
      const heading = `### Vé \`WP${i}\``;
      const startIdx = backlog.indexOf(heading);
      expect(startIdx, `Missing ticket heading ${heading} in docs/BACKLOG.md`).toBeGreaterThan(-1);

      const nextHeading = i < 9 ? `### Vé \`WP${i + 1}\`` : '## Lưu trữ lịch sử';
      const endIdx = backlog.indexOf(nextHeading, startIdx);
      expect(endIdx, `Missing boundary ${nextHeading} after ${heading}`).toBeGreaterThan(startIdx);

      const section = backlog.slice(startIdx, endIdx);
      expect(section, `WP${i} missing Phục vụ: S#`).toMatch(/Phục vụ:\s*S\d+/);
      expect(section, `WP${i} missing target evidence branch ${expectedEvidence[i]}`).toContain(
        expectedEvidence[i]
      );
      for (const field of requiredFields) {
        expect(section, `WP${i} missing standard field ${field}`).toContain(field);
      }
    }
  });
});
