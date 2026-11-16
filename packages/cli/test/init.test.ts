import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runInitCommand } from '../src/commands/init.js';

describe('routersync init command', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routersync-init-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates configuration file when target does not exist', async () => {
    const targetFile = path.join(tmpDir, 'config.yaml');
    expect(fs.existsSync(targetFile)).toBe(false);

    await runInitCommand({ path: targetFile });

    expect(fs.existsSync(targetFile)).toBe(true);
    const content = fs.readFileSync(targetFile, 'utf8');
    expect(content).toContain('routers:');
  });

  it('rejects without --force when target file already exists', async () => {
    const targetFile = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(targetFile, '# existing config', 'utf8');

    await expect(runInitCommand({ path: targetFile })).rejects.toThrow(
      /Configuration file already exists/
    );

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('# existing config');
  });

  it('overwrites with --force when target file already exists', async () => {
    const targetFile = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(targetFile, '# existing config', 'utf8');

    await runInitCommand({ path: targetFile, force: true });

    const content = fs.readFileSync(targetFile, 'utf8');
    expect(content).not.toBe('# existing config');
    expect(content).toContain('routers:');
  });

  it('outputs JSON error without throwing when --json flag is passed', async () => {
    const targetFile = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(targetFile, '# existing config', 'utf8');

    let output = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      output += msg + '\n';
    };

    try {
      await runInitCommand({ path: targetFile, json: true });
      const parsed = JSON.parse(output.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('already exists');
    } finally {
      console.log = origLog;
    }
  });
});
