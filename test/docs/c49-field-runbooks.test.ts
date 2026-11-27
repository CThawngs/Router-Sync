/**
 * test/docs/c49-field-runbooks.test.ts
 *
 * Tickets C49-T3 & C49-T4 (`Phục vụ: S9, S10`):
 *  - T3: `docs/runbook/FIELD-TEST-LADDER.md` <= 100 lines, Vietnamese, valid PowerShell + Bash
 *        CLI invocations verified via `verifyDocCliSync`, covering Rungs 0–3 with measurable
 *        promotion criteria, exported data, stop signals, and rollback to previous rung.
 *  - T4: `docs/runbook/FIELD-FINDINGS.md` concise Vietnamese triage workflow (`Owner` -> `Data-AI`
 *        3 buckets -> Red-First ticket reproduction from exact `field-report` row -> RACI + summary table).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDocCliInvocations, verifyDocCliSync } from './c46-f3-doc-cli-sync.test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('C49-T3: docs/runbook/FIELD-TEST-LADDER.md Contract & Doc-CLI Sync', () => {
  const ladderPath = path.join(REPO_ROOT, 'docs', 'runbook', 'FIELD-TEST-LADDER.md');

  it('exists, stays strictly <= 100 lines, and passes verifyDocCliSync with PowerShell and Bash blocks', () => {
    expect(fs.existsSync(ladderPath), 'docs/runbook/FIELD-TEST-LADDER.md must exist').toBe(true);
    const markdown = fs.readFileSync(ladderPath, 'utf8');
    const lines = markdown.replace(/\n$/, '').split(/\r?\n/);

    expect(lines.length).toBeLessThanOrEqual(100);
    expect(markdown).toMatch(/```powershell\r?\n/);
    expect(markdown).toMatch(/```bash\r?\n/);

    const syncRes = verifyDocCliSync(markdown);
    expect(syncRes.issues).toEqual([]);
    expect(syncRes.invocations.length).toBeGreaterThanOrEqual(6);

    const rawCmds = extractDocCliInvocations(markdown).map((i) => i.rawCommand);
    expect(rawCmds.some((c) => c.startsWith('routersync tick') && c.includes('--mode observe'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync field-report') && c.includes('--out'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync apply') && c.includes('--write'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync freeze'))).toBe(true);
  });

  it('documents all 4 rungs (Bậc 0..3) with all 5 mandatory operational criteria per rung', () => {
    const markdown = fs.readFileSync(ladderPath, 'utf8');

    expect(markdown).toContain('Bậc 0');
    expect(markdown).toContain('Bậc 1');
    expect(markdown).toContain('Bậc 2');
    expect(markdown).toContain('Bậc 3');
    expect(markdown).toContain('docs/runbook/OWNER-CHECKLIST.md');
    expect(markdown).toContain('rs-pilot');
    expect(markdown).toContain('chay');
    expect(markdown).toContain('auto-safe');

    const rungSections = markdown.split(/^##\s+Bậc\s+[0-3]/m).slice(1);
    expect(rungSections).toHaveLength(4);

    for (let idx = 0; idx < rungSections.length; idx += 1) {
      const sec = rungSections[idx]!;
      expect(sec, `Bậc ${idx} missing Việc cần làm`).toContain('Việc cần làm');
      expect(sec, `Bậc ${idx} missing Dữ liệu cần xuất`).toContain('Dữ liệu cần xuất');
      expect(sec, `Bậc ${idx} missing Điều kiện lên bậc`).toContain('Điều kiện lên bậc');
      expect(sec, `Bậc ${idx} missing Dấu hiệu dừng`).toContain('Dấu hiệu dừng');
      expect(sec, `Bậc ${idx} missing Quay lại bậc trước`).toContain('Quay lại bậc trước');
    }
  });
});

describe('C49-T4: docs/runbook/FIELD-FINDINGS.md Triage Workflow, Templates & Doc-CLI Sync', () => {
  const findingsPath = path.join(REPO_ROOT, 'docs', 'runbook', 'FIELD-FINDINGS.md');

  it('exists, passes verifyDocCliSync, and defines the 3 Data-AI classification buckets + RACI + templates', () => {
    expect(fs.existsSync(findingsPath), 'docs/runbook/FIELD-FINDINGS.md must exist').toBe(true);
    const markdown = fs.readFileSync(findingsPath, 'utf8');

    const syncRes = verifyDocCliSync(markdown);
    expect(syncRes.issues).toEqual([]);

    expect(markdown).toContain('Data-AI');
    expect(markdown).toContain('ROUTERSYNC_BUG');
    expect(markdown).toContain('UPSTREAM_PROVIDER_OR_ROUTER');
    expect(markdown).toContain('UNDOCUMENTED_VALID_BEHAVIOR');
    expect(markdown).toContain('Red-First');
    expect(markdown).toContain('timeline.jsonl');
    expect(markdown).toContain('anomalies.json');
    expect(markdown).toContain('Engineer');
    expect(markdown).toContain('QA');
    expect(markdown).toContain('Ops');

    // Must contain both a Ticket Markdown template and a Findings Summary Table
    expect(markdown).toMatch(/```markdown\r?\n[\s\S]*Red-First[\s\S]*```/);
    expect(markdown).toMatch(/\|.*Mã bất thường.*\|.*Phân loại.*\|/);
  });
});
