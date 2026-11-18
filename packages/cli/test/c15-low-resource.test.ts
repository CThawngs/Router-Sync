import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseVmStat,
  availableMemoryBytes,
  _printAutoNoticeOnce,
} from '../src/low-resource.js';

const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                1000.
Pages active:                              2000.
Pages inactive:                             500.
Pages speculative:                          250.
Pages purgeable:                            125.
Pages wired down:                          3000.
`;

describe('C15 Q1.3: availableMemoryBytes', () => {
  it('parses macOS vm_stat (free + inactive + speculative + purgeable)', () => {
    expect(parseVmStat(SAMPLE)).toBe((1000 + 500 + 250 + 125) * 16384);
  });

  it('returns null when page size is missing', () => {
    expect(parseVmStat('Pages free: 10.\n')).toBeNull();
  });

  it('returns a positive byte count on this platform', () => {
    expect(availableMemoryBytes()).toBeGreaterThan(0);
  });
});

describe('C15 Q1.4: one-time low-resource notice', () => {
  let tmp: string;
  const orig = { ...process.env };
  const origArgv = [...process.argv];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-c15-notice-'));
    process.env['ROUTERSYNC_STATE_DIR'] = tmp;
    process.argv = ['node', 'cli', 'doctor'];
  });

  afterEach(() => {
    process.env = { ...orig };
    process.argv = [...origArgv];
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints once in a 10-minute window', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _printAutoNoticeOnce('auto: test reason');
    _printAutoNoticeOnce('auto: test reason');
    const notices = err.mock.calls.filter((c) => String(c[0]).includes('low-resource mode:'));
    expect(notices.length).toBe(1);
    expect(fs.existsSync(path.join(tmp, 'low-resource-notice.json'))).toBe(true);
  });

  it('does not print when --json is present', () => {
    process.argv = ['node', 'cli', 'doctor', '--json'];
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _printAutoNoticeOnce('auto: test reason');
    const notices = err.mock.calls.filter((c) => String(c[0]).includes('low-resource mode:'));
    expect(notices.length).toBe(0);
  });
});
