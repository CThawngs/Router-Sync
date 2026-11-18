import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/verify/verifier.js', () => ({
  runVerifyPhase: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      timestamp: new Date().toISOString(),
      modelsVerified: 0,
      labels: {},
      records: [],
      proposals: [],
      absentStableCandidates: [],
      accounting: { requests: 0, paidRequests: 0, tokens: 0, llmCalls: 0 },
    };
  }),
}));

import { runVerifyCommand } from '../src/commands/verify.js';

describe('C14 (b): verify deadline', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c14-dl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns incomplete=true when the deadline fires before the phase finishes', async () => {
    const summary = await runVerifyCommand({ stateDir: tmp, deadlineMs: 10 });
    expect(summary.incomplete).toBe(true);
    expect(summary.modelsVerified).toBe(0);
  });

  it('does not mark a fast phase incomplete', async () => {
    const summary = await runVerifyCommand({ stateDir: tmp, deadlineMs: 5000 });
    expect(summary.incomplete).toBeUndefined();
  });
});
