/**
 * test/docs/9router-combo-findings.test.ts
 *
 * R1-5 & W4: Provenance, privacy, comparison-direction, non-extrapolation,
 * `chưa phân biệt` candidate labeling, and Track W empirical completeness
 * guards for `docs/9router-combo-findings.md` (C32–C44 / Track R & Track W).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FINDINGS_PATH = path.join(REPO_ROOT, 'docs', '9router-combo-findings.md');

const PROVENANCE_BULLET_RE =
  /^\s*- \*\*(?:đo được|suy luận|chưa biết|chưa đo)(?:\*\*|\s|\()/;
const ALLOWED_SECTION_6_OPERATIONAL_RE =
  /^- (?:Dùng combo ngắn,|Với combo có sẵn,|Không restart router,)/;

describe('R1-5 & W4: docs/9router-combo-findings.md provenance, Track R & Track W guards', () => {
  it('exists, is valid UTF-8 without replacement characters, and contains no personal paths or PII', () => {
    expect(fs.existsSync(FINDINGS_PATH)).toBe(true);
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(500);
    expect(content).not.toContain('\uFFFD');

    // Construct path patterns dynamically so this test file itself embeds zero literal personal prefixes.
    const winUsersRe = new RegExp('[A-Za-z]:[\\\\/ ]' + 'Users' + '[\\\\/]');
    const posixUsersRe = new RegExp('(?:^|[^A-Za-z0-9])/' + 'Users' + '/[A-Za-z0-9._-]+');
    const posixHomeRe = new RegExp('(?:^|[^A-Za-z0-9])/' + 'home' + '/[A-Za-z0-9._-]+');
    const cloudSyncRe = new RegExp('One' + 'Drive', 'i');

    expect(content).not.toMatch(winUsersRe);
    expect(content).not.toMatch(posixUsersRe);
    expect(content).not.toMatch(posixHomeRe);
    expect(content).not.toMatch(cloudSyncRe);

    const username = os.userInfo().username;
    if (username && username.length >= 3) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(content).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i'));
    }

    expect(content).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('enforces Vietnamese provenance labels on every findings bullet and every bold-prefixed bullet', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');
    const lines = content.split(/\r?\n/);

    let currentH2 = '';
    let inFence = false;
    let labeledBulletCount = 0;

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? '';
      if (/^```/.test(line.trim())) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      if (line.startsWith('## ')) {
        currentH2 = line.trim();
        continue;
      }

      // Every `- **` bullet anywhere in the document must start with one of the 4 allowed provenance labels.
      if (/^\s*- \*\*/.test(line)) {
        expect(
          PROVENANCE_BULLET_RE.test(line),
          `Line ${idx + 1} starts with '- **' without an allowed provenance label: ${line}`
        ).toBe(true);
        labeledBulletCount += 1;
        continue;
      }

      // Every `- ` bullet outside operational Section 6 must also carry an explicit provenance label.
      if (/^\s*- /.test(line)) {
        const isSection6 = currentH2 === '## 6. Cách dùng kết quả';
        if (isSection6) {
          expect(
            ALLOWED_SECTION_6_OPERATIONAL_RE.test(line),
            `Line ${idx + 1} in '${currentH2}' is an unlabeled non-operational bullet: ${line}`
          ).toBe(true);
        } else {
          expect(
            PROVENANCE_BULLET_RE.test(line),
            `Line ${idx + 1} in '${currentH2 || '(preamble)'}' is missing a provenance label (**đo được**, **suy luận**, **chưa biết**, **chưa đo**): ${line}`
          ).toBe(true);
        }
      }
    }

    expect(labeledBulletCount).toBeGreaterThanOrEqual(22);
  });

  it('updates summary range to C32–C44, clears stale R2 note, and preserves C32–C41 facts', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');

    expect(content).toContain('C32–C44');
    expect(content).not.toContain('C32–C40');
    expect(content).not.toContain('C32–C43.');
    expect(content).not.toContain('R2 chưa chạy');
    expect(content).toContain('**chưa đo**');

    // Historical C32–C41 anchors preserved intact
    expect(content).toContain('nvidia/z-ai/glm-5.3-flash');
    expect(content).toContain('cf/@cf/zai-org/glm-4.7-flash');
    expect(content).toContain('processStart=2026-11-22T15:29:07Z');
    expect(content).toContain('fileModified=2026-11-22T13:46:56Z');
    expect(content).toContain('evidence/c41');
    expect(content).toContain('324 MB');
    expect(content).toContain('tools/agent/x40-evidence.mjs');
    expect(content).toContain('SKIPPED-QUOTA');
  });

  it('documents R0 PATCH_V2 createHash ReferenceError + uncaughtException hang mechanism and PATCH_V3', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');

    expect(content).toContain('7170958');
    expect(content).toContain('test/agent/nine-router-patch.node.test.mjs');
    expect(content).toContain('tools/agent/nine-router-patch.mjs');
    expect(content).toContain('0.5.119');
    expect(content).toContain('0.5.123');
    expect(content).toContain('PATCH_V2');
    expect(content).toContain('createHash');
    expect(content).toContain('ReferenceError');
    expect(content).toContain('uncaughtException');
    expect(content).toContain('headersSent=false');
    expect(content).toContain('PATCH_V3');
    expect(content).toContain('C43 PATCH v3');
    expect(content).toContain('x-9r-models-cache');
    expect(content).toContain('patchV1=false');
    expect(content).toContain('patchV2=false');
    expect(content).toContain('patchV3=false');
    expect(content).toContain('tắt thủ công');
  });

  it('documents R2 offline LOW-SAMPLE recalculation on C38 + C40 and rs-fast stability', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');

    expect(content).toContain('f0e8534');
    expect(content).toContain('packages/cli/src/commands/combos-reliability.ts');
    expect(content).toContain('packages/cli/src/commands/combos-reorder.ts');
    expect(content).toContain('tools/agent/c43-track-r.mjs');
    expect(content).toContain('LOW-SAMPLE');
    expect(content).toContain('rsFastUnchanged=true');
    expect(content).toContain('openrouter/openrouter/free');
    expect(content).toContain('845');
    expect(content).toContain('openrouter/nvidia/nemotron-3.5-super-vl:free');
    expect(content).toContain('901');
    expect(content).toContain('openrouter/inclusionai/ling-3.2-flash:free');
    expect(content).toContain('DEAD');
    expect(content).toContain('RATE-LIMITED');
  });

  it('W4: fixes 826 < 2 900 comparison direction, deletes unrecorded extrapolations, and labels all 4 C44 §1.1 candidates chưa phân biệt', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');

    expect(content).toContain('checkR1Gate');
    expect(content).toContain('9Router-Agent-1');
    expect(content).toContain('1806245027');
    expect(content).toContain('18/18');
    expect(content).toContain('không tái hiện trong 18 mẫu');
    expect(content).not.toContain('đã sửa');
    expect(content).toContain('combo_not_in_db');
    expect(content).toContain('stream_on_c1');
    expect(content).toContain('stream_off_c1');
    expect(content).toContain('stream_on_c2');
    expect(content).toContain('stream_off_c2');
    expect(content).toContain('cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(content).toContain('ponytailEnabled');

    // Exact comparison direction & two empirical measurements across router versions
    expect(content).toContain('826');
    expect(content).toContain('7 434');
    expect(content).toContain('2 900');
    expect(content).toMatch(/`?826`?\s+nhỏ hơn\s+`?2 900`?/);

    // Zero unrecorded extrapolations
    expect(content).not.toContain('14 868');
    expect(content).not.toContain('14,868');
    expect(content).not.toContain('15 000');
    expect(content).not.toContain('15,000');

    // All 4 candidate explanations explicitly labeled `chưa phân biệt`
    const chuaPhanBietMatches = content.match(/chưa phân biệt/g) ?? [];
    expect(chuaPhanBietMatches.length).toBeGreaterThanOrEqual(4);
    expect(content).toContain('0.5.119');
    expect(content).toContain('0.5.123');
    expect(content).toContain('tiến trình');
    expect(content).toContain('quota');
    expect(content).toContain('RAM');
  });

  it('W4: includes Section 8 with empirical Track W (W1, W2, W3, W5) measurements on 9Router 0.5.123', () => {
    const content = fs.readFileSync(FINDINGS_PATH, 'utf-8');

    expect(content).toContain('## 8.');
    expect(content).toContain('tools/agent/c44-track-w.mjs');
    expect(content).toContain('packages/cli/src/commands/combos-budget.ts');
    expect(content).toContain('evidence/c44');

    // W1 contention probe results
    expect(content).toContain('còn nghẽn');
    expect(content).toMatch(/426[ ,]?861/);
    expect(content).toContain('chờ chủ dự án');

    // W2 client-side budget & reconciliation
    expect(content).toContain('RequestBudget');
    expect(content).toContain('reconcileSentVsUsage');

    // W3 process-age sample (14.11h measured, 24h & 48h chưa đo) + W5 rs-fast chưa đo
    expect(content).toContain('14.11');
    expect(content).toContain('freeMemMB=1940');
    expect(content).toContain('24');
    expect(content).toContain('48');
    expect(content).toContain('W5_RS_FAST=chưa đo');
  });
});
