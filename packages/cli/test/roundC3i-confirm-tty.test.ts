/**
 * packages/cli/test/roundC3i-confirm-tty.test.ts
 * C3i I1: confirm phai tu choi khi stdin khong phai TTY (pipe),
 * kem ca khi env ROUTERSYNC_SYNC_CONFIRM tu dien.
 */
import { describe, it, expect } from 'vitest';
import { confirm } from '../src/commands/sync/sync-state.js';

describe('I1 confirm isTTY gate', () => {
  it('rejects piped stdin (no TTY), no write, no sync', async () => {
    const prev = process.stdin.isTTY;
    const prevEnv = process.env['ROUTERSYNC_SYNC_CONFIRM'];
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    delete process.env['ROUTERSYNC_SYNC_CONFIRM'];
    try {
      await expect(confirm('chạy', 'msg')).rejects.toThrow('not a TTY');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
      if (prevEnv === undefined) delete process.env['ROUTERSYNC_SYNC_CONFIRM'];
      else process.env['ROUTERSYNC_SYNC_CONFIRM'] = prevEnv;
    }
  });
  it('rejects env auto-fill when piped', async () => {
    const prev = process.stdin.isTTY;
    const prevEnv = process.env['ROUTERSYNC_SYNC_CONFIRM'];
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    process.env['ROUTERSYNC_SYNC_CONFIRM'] = 'chạy';
    try {
      await expect(confirm('chạy', 'msg')).rejects.toThrow('auto-fill');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
      if (prevEnv === undefined) delete process.env['ROUTERSYNC_SYNC_CONFIRM'];
      else process.env['ROUTERSYNC_SYNC_CONFIRM'] = prevEnv;
    }
  });
});
