/**
 * test/docs/c45-wp1-harness-docs.test.ts
 *
 * C45-WP1 documentation & schema consistency checks (Phục vụ: S2, S3, S6).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliProgram } from '../../packages/cli/src/index.js';
import { loadHarnessMatrix } from '@routersync/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_HARNESS_IDS = [
  'hermes',
  'claude-code',
  'codex',
  'antigravity',
  'opencode',
  'cursor',
  'grok-bot',
  'openmausbot',
  'dsh',
] as const;

describe('C45-WP1: docs/harness-matrix.md & harness-matrix.json contract', () => {
  it('places docs/harness-matrix.md and root harness-matrix.json with all 9 harnesses and S2/S3/S6 tags', () => {
    const docPath = path.join(REPO_ROOT, 'docs', 'harness-matrix.md');
    const rootJsonPath = path.join(REPO_ROOT, 'harness-matrix.json');
    expect(fs.existsSync(docPath)).toBe(true);
    expect(fs.existsSync(rootJsonPath)).toBe(true);

    const md = fs.readFileSync(docPath, 'utf8');
    expect(md).toContain('S2');
    expect(md).toContain('S3');
    expect(md).toContain('S6');

    const matrix = loadHarnessMatrix();
    expect(matrix.serves).toEqual(['S2', 'S3', 'S6']);
    expect(matrix.harnesses.map((h) => h.id)).toEqual([...EXPECTED_HARNESS_IDS]);

    for (const id of EXPECTED_HARNESS_IDS) {
      expect(md).toContain(`\`${id}\``);
    }
  });

  it('contains zero K6.2 forbidden git publish strings and only cites registered routersync CLI commands', () => {
    const docPath = path.join(REPO_ROOT, 'docs', 'harness-matrix.md');
    const md = fs.readFileSync(docPath, 'utf8');

    for (const forbidden of ['push origin master', '--tags', 'git push --all']) {
      expect(md).not.toContain(forbidden);
    }

    const program = createCliProgram();
    const topCommands = new Map<string, Set<string>>();
    for (const cmd of program.commands) {
      const subs = new Set<string>(cmd.commands.map((sub) => sub.name()));
      topCommands.set(cmd.name(), subs);
    }

    const cmdRe = /`routersync\s+([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9_-]+))?/g;
    let match: RegExpExecArray | null;
    while ((match = cmdRe.exec(md)) !== null) {
      const top = match[1];
      const sub = match[2];
      if (!top) continue;
      expect(topCommands.has(top), `Unregistered top-level command: routersync ${top}`).toBe(true);
      const subSet = topCommands.get(top);
      if (sub && !sub.startsWith('-') && subSet && subSet.size > 0) {
        expect(subSet.has(sub), `Unregistered subcommand: routersync ${top} ${sub}`).toBe(true);
      }
    }
  });
});
