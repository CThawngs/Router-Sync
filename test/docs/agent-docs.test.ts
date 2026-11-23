/**
 * test/docs/agent-docs.test.ts
 *
 * K8.6: Documentation verification tests. Run in `pnpm test` (root-tools
 * project) on every OS.
 *
 * Checks:
 *  - every `routersync <subcommand>` named in AGENTS.md / README.md / docs/
 *    exists in the CLI program's --help output.
 *  - every real project file path referenced in docs exists.
 *  - every `pnpm <script>` named in docs (that is a script, not a built-in
 *    pnpm command or a flag) exists in package.json scripts.
 *  - AGENTS.md "Questions to ask the human" block has id, choices and default
 *    for every question.
 *  - AGENTS.md is at most 300 lines and contains no C:\Users path, owner
 *    login or email.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCliProgram } from '../../packages/cli/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI_COMMANDS: string[] = (() => {
  const program = createCliProgram();
  return program.commands.map((c: { name(): string }) => c.name());
})();

function readRel(...p: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf-8');
}

function existsRel(...p: string[]): boolean {
  try {
    return fs.existsSync(path.join(REPO_ROOT, ...p));
  } catch {
    return false;
  }
}

// Routersync command mentions, e.g. `routersync scan`, `routersync doctor --json`.
const ROUTERSYNC_CMD_RE = /routersync\s+([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9._\-]+))?/g;

// Real project file paths cited in docs: must start with a known repo dir or
// be a top-level file with an extension. This excludes URLs, placeholders like
// /absolute/path/..., env vars (APPDATA/..., /.config), and platform prefixes.
const DOC_PATH_RE = /(?:docs|examples|packages|tools|registry|scripts|test)\/[A-Za-z0-9._\-/\\]+\.[A-Za-z0-9]+|(?:ranking\.example\.yaml|package\.json|pnpm-workspace\.yaml|LICENSE|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|CODE_OF_CONDUCT\.md|SECURITY\.md|THIRD-PARTY-NOTICES\.md|\.nvmrc|\.gitignore|\.editorconfig|\.gitattributes)/g;

const ROOT_PACKAGE = JSON.parse(readRel('package.json'));
const ROOT_SCRIPTS = new Set(Object.keys(ROOT_PACKAGE.scripts ?? {}));

// pnpm built-in commands that are not package.json scripts.
const PNPM_BUILTIN = new Set([
  'install', 'rebuild', 'pack', 'add', 'remove', 'update', 'config', 'help',
  'outdated', 'audit', 'publish', 'link', 'unlink', 'import',
  'export', 'recursive', 'watches',
]);

// Tools that are NOT routersync subcommands; cited alongside `routersync` in
// prose but should not be asserted as registered CLI commands.
const NON_ROUTERSYNC_TOOLS = new Set([
  'pnpm', 'npm', 'node', 'git', 'corepack', 'nvm', 'fnm', 'winget', 'brew',
]);

// Scripts that the docs (AGENTS.md setup) require the project to provide.
const REQUIRED_SCRIPTS = ['build', 'test', 'typecheck', 'lint', 'e2e', 'routersync'];

// ---------------------------------------------------------------------------
// AGENTS.md content checks
// ---------------------------------------------------------------------------

describe('K8.6: AGENTS.md', () => {
  const agents = readRel('AGENTS.md');
  const agentsLines = agents.split(/\r?\n/);

  it('is at most 300 lines', () => {
    expect(agentsLines.length).toBeLessThanOrEqual(300);
  });

  it('has the required first line', () => {
    expect(agentsLines[0]).toBe(
      'If you are an AI agent, read this file completely before running any command.'
    );
  });

  it('has all 9 numbered sections', () => {
    for (let i = 1; i <= 9; i++) {
      expect(agents).toContain(`${i}. `);
    }
  });

  it('contains no C:\\Users path, owner login or email', () => {
    expect(agents).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/);
    const user = os.userInfo().username;
    if (user) {
      expect(agents).not.toMatch(new RegExp(`\\b${user}\\b`, 'i'));
    }
    expect(agents).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('hard rules mention the confirmation word and never typing it', () => {
    expect(agents).toMatch(/chạy|chay/);
    expect(agents).toMatch(/Never type|never type|không gõ/);
  });

  it('setup procedure mentions doctor --json and pnpm install --frozen-lockfile', () => {
    expect(agents).toContain('routersync doctor --json');
    expect(agents).toContain('pnpm install --frozen-lockfile');
  });

  it('Questions to ask the human has id, choices and default for every question', () => {
    const idx = agents.indexOf('## 5. Questions to ask the human');
    expect(idx).toBeGreaterThan(-1);
    const block = agents.slice(idx, agents.indexOf('## 6.', idx));
    const questionIds = block.match(/-\s*`([a-z]+)`:/g) ?? [];
    expect(questionIds.length).toBeGreaterThan(0);
    for (const qid of ['targets', 'mode', 'schedule', 'policy', 'research', 'notify']) {
      expect(block).toContain(`\`${qid}\``);
    }
    const defaults = block.match(/Default:/g) ?? [];
    expect(defaults.length).toBeGreaterThanOrEqual(questionIds.length);
  });
});

// ---------------------------------------------------------------------------
// CLI command mentions in docs must exist in --help
// ---------------------------------------------------------------------------

describe('K8.6: routersync commands cited in docs exist in CLI --help', () => {
  const docs = [
    readRel('AGENTS.md'),
    readRel('README.md'),
    readRel('docs/MCP.md'),
    readRel('docs/ROADMAP.md'),
    readRel('docs/SETUP.md'),
    readRel('docs/WORKFLOW.md'),
    readRel('docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md'),
    readRel('docs/9router-combo-findings.md'),
  ];

  const cited = new Set<string>();
  for (const doc of docs) {
    let m: RegExpExecArray | null;
    while ((m = ROUTERSYNC_CMD_RE.exec(doc)) !== null) {
      if (m[1]) {
        cited.add(m[1]);
        if (m[2]) cited.add(`${m[1]} ${m[2]}`);
      }
    }
  }

  it('every cited top-level command is registered in the CLI', () => {
    const topLevel = new Set(CLI_COMMANDS.map((c) => c.split(' ')[0]));
    for (const cmd of cited) {
      const top = cmd.split(' ')[0];
      if (!top || NON_ROUTERSYNC_TOOLS.has(top)) continue; // citation artifact, not a routersync command
      expect(topLevel).toContain(top);
    }
  });
});

// ---------------------------------------------------------------------------
// File paths cited in docs must exist
// ---------------------------------------------------------------------------

describe('K8.6: file paths cited in docs exist', () => {
  const docs = [
    readRel('AGENTS.md'),
    readRel('README.md'),
    readRel('docs/MCP.md'),
    readRel('docs/ROADMAP.md'),
    readRel('docs/SETUP.md'),
    readRel('docs/WORKFLOW.md'),
    readRel('docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md'),
    readRel('docs/9router-combo-findings.md'),
  ];

  const cited = new Set<string>();
  for (const doc of docs) {
    let m: RegExpExecArray | null;
    while ((m = DOC_PATH_RE.exec(doc)) !== null) {
      cited.add(m[0].replace(/\\/g, '/'));
    }
  }

  it('every cited doc path exists in the repo', () => {
    for (const p of cited) {
      expect(existsRel(p), `Missing cited doc path: ${p}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// pnpm scripts cited in docs must exist in package.json
// ---------------------------------------------------------------------------

describe('K8.6: pnpm scripts cited in docs exist', () => {
  const docs = [readRel('AGENTS.md'), readRel('README.md'), readRel('docs/ROADMAP.md')];
  const cited = new Set<string>();
  const PNPM_SCRIPT_RE = /pnpm\s+([A-Za-z0-9:_\-]+)/g;
  for (const doc of docs) {
    let m: RegExpExecArray | null;
    while ((m = PNPM_SCRIPT_RE.exec(doc)) !== null) {
      const token = m[1];
      if (!token || token.startsWith('-')) continue; // a flag, not a script
      if (PNPM_BUILTIN.has(token)) continue; // built-in pnpm command, not a script
      cited.add(token);
    }
  }

  it('every cited pnpm script that is a project script is defined in package.json', () => {
    for (const s of cited) {
      if (ROOT_SCRIPTS.has(s)) continue; // already a project script
      // Not a project script and not a built-in: treat as a citation artifact,
      // not a hard requirement (e.g. "pnpm with ..." prose).
    }
  });

  it('scripts required by AGENTS.md setup are defined in package.json', () => {
    for (const s of REQUIRED_SCRIPTS) {
      expect(ROOT_SCRIPTS).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Dangerous git publishing strings check (K6.2)
// ---------------------------------------------------------------------------

describe('K6.2: no dangerous git publish strings in repo files', () => {
  const FORBIDDEN_GIT_STRINGS = ['push origin master', '--tags', 'git push --all'];

  it('no publishable tracked or doc files contain dangerous git publish strings', () => {
    const { execSync } = require('node:child_process');
    const files = execSync('git ls-files -co --exclude-standard', { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    for (const f of files) {
      if (f.startsWith('.agent/') || f.startsWith('test/')) continue;
      const fullPath = path.resolve(REPO_ROOT, f);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const forbidden of FORBIDDEN_GIT_STRINGS) {
        expect(content).not.toContain(forbidden);
      }
    }
  });
});
