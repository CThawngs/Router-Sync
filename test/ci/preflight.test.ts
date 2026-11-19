import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('C17 T6: preflight contract', () => {
  it('runs without build artifacts and always exits successfully', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-preflight-'));
    try {
      const scriptPath = path.join(temporaryDirectory, 'preflight.mjs');
      fs.copyFileSync('tools/agent/preflight.mjs', scriptPath);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: temporaryDirectory,
        encoding: 'utf8',
        env: {
          ...process.env,
          RS_FAKE_AVAILABLE_MB: '512',
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('available RAM: 0.50 GiB');
      expect(result.stdout).toContain('mode: LIGHT-DEV');
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
