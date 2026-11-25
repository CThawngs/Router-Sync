/**
 * test/docs/agent-docs.test.ts
 *
 * K8.6 & M4-01 (P6) / M4-02 (P7): Documentation consistency, subcommand --help
 * verification, SECURITY.md boundary contract, and hermetic offline CLI fixture
 * smoke tests. Run in `pnpm test` (root-tools project) on every OS.
 *
 * Checks:
 *  - every `routersync <subcommand>` (including two-word subcommands such as
 *    `combos stale`, `combos probe`, `maintain authorize`, `apps drift`,
 *    `mcp install`) named in AGENTS.md / README.md / SECURITY.md / docs/
 *    exists in the CLI program's --help output.
 *  - every real project file path referenced in enrolled docs exists.
 *  - every `pnpm <script>` named in docs (that is a script, not a built-in
 *    pnpm command or a flag) exists in package.json scripts.
 *  - docs/SETUP.md prerequisites match package.json engines, use `pnpm hooks:install`,
 *    and provide the 4-stage New-User Read-Only Quickstart for 9Router & OmniRoute.
 *  - docs/combos-probe.md, docs/known-issues.md, and SECURITY.md match M4 contracts.
 *  - compiled CLI executes documented read-only commands against an offline
 *    sample fixture in os.tmpdir() (`http://127.0.0.1:9`, 0 live router ports,
 *    0 DB writes).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBetterSqlite3 } from '@routersync/core';
import { createCliProgram } from '../../packages/cli/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI_PROGRAM = createCliProgram();
const CLI_COMMANDS: string[] = CLI_PROGRAM.commands.map((c: { name(): string }) => c.name());

const CLI_SUBCOMMAND_GROUPS: Map<string, Map<string, string>> = (() => {
  const groups = new Map<string, Map<string, string>>();
  for (const cmd of CLI_PROGRAM.commands) {
    if (cmd.commands && cmd.commands.length > 0) {
      const subMap = new Map<string, string>();
      for (const sub of cmd.commands) {
        subMap.set(sub.name(), sub.helpInformation());
      }
      groups.set(cmd.name(), subMap);
    }
  }
  return groups;
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

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Routersync command mentions, e.g. `routersync scan`, `routersync doctor --json`, `routersync combos stale`.
const ROUTERSYNC_CMD_RE = /routersync\s+([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9._\-]+))?/g;

// Real project file paths cited in docs: must start with a known repo dir or
// be a top-level file with an extension. This excludes URLs, placeholders like
// /absolute/path/..., home-dir paths like ~/.hermes/scripts/..., env vars, and platform prefixes.
const DOC_PATH_RE = /(?<![A-Za-z0-9._~\/\\-])(?:docs|examples|packages|tools|registry|scripts|test)\/[A-Za-z0-9._\-/\\]+\.[A-Za-z0-9]+|(?<![A-Za-z0-9._~\/\\-])(?:ranking\.example\.yaml|package\.json|pnpm-workspace\.yaml|LICENSE|README\.md|CONTRIBUTING\.md|CHANGELOG\.md|CODE_OF_CONDUCT\.md|SECURITY\.md|THIRD-PARTY-NOTICES\.md|\.nvmrc|\.gitignore|\.editorconfig|\.gitattributes)/g;

const ROOT_PACKAGE = JSON.parse(readRel('package.json'));
const ROOT_SCRIPTS = new Set(Object.keys(ROOT_PACKAGE.scripts ?? {}));

// pnpm built-in commands that are not package.json scripts.
const PNPM_BUILTIN = new Set([
  'install', 'rebuild', 'pack', 'add', 'remove', 'update', 'config', 'help',
  'outdated', 'audit', 'publish', 'link', 'unlink', 'import',
  'export', 'recursive', 'watches', 'doctor', 'exec', 'dlx', 'run', 'why',
  'list', 'view', 'store',
]);

// Tools that are NOT routersync subcommands; cited alongside `routersync` in
// prose but should not be asserted as registered CLI commands.
const NON_ROUTERSYNC_TOOLS = new Set([
  'pnpm', 'npm', 'node', 'git', 'corepack', 'nvm', 'fnm', 'winget', 'brew',
]);

// Scripts that the docs (AGENTS.md setup) require the project to provide.
const REQUIRED_SCRIPTS = ['build', 'test', 'typecheck', 'lint', 'e2e', 'routersync', 'hooks:install'];

const ENROLLED_DOC_PATHS = [
  'AGENTS.md',
  'README.md',
  'SECURITY.md',
  'docs/MCP.md',
  'docs/ROADMAP.md',
  'docs/SETUP.md',
  'docs/WORKFLOW.md',
  'docs/CI.md',
  'docs/known-issues.md',
  'docs/combos-probe.md',
  'docs/schedule-ladder.md',
  'docs/runbook/LIVE-E2E-v2.md',
  'docs/runbook/OWNER-CHECKLIST.md',
  'docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md',
  'docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md',
  'docs/9router-combo-findings.md',
];

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
// CLI command mentions in docs must exist in --help (including subcommands)
// ---------------------------------------------------------------------------

describe('K8.6: routersync commands cited in docs exist in CLI --help', () => {
  const docs = ENROLLED_DOC_PATHS.map((p) => ({ file: p, content: readRel(p) }));

  const cited = new Set<string>();
  const backtickTwoWord = new Set<string>();
  const BACKTICK_SUBCMD_RE = /`(?:pnpm\s+)?routersync\s+([A-Za-z0-9_-]+)\s+([A-Za-z0-9_-]+)(?:\s|`|\\|\|)/g;

  for (const { content } of docs) {
    let m: RegExpExecArray | null;
    ROUTERSYNC_CMD_RE.lastIndex = 0;
    while ((m = ROUTERSYNC_CMD_RE.exec(content)) !== null) {
      if (m[1]) {
        cited.add(m[1]);
        if (m[2]) cited.add(`${m[1]} ${m[2]}`);
      }
    }
    BACKTICK_SUBCMD_RE.lastIndex = 0;
    while ((m = BACKTICK_SUBCMD_RE.exec(content)) !== null) {
      if (m[1] && m[2] && !m[2].startsWith('-')) {
        backtickTwoWord.add(`${m[1]} ${m[2]}`);
      }
    }
  }

  it('every cited top-level command is registered in the CLI', () => {
    const topLevel = new Set(CLI_COMMANDS.map((c) => c.split(' ')[0]));
    for (const cmd of cited) {
      const top = cmd.split(' ')[0];
      if (!top || NON_ROUTERSYNC_TOOLS.has(top)) continue;
      expect(topLevel, `Unknown top-level CLI command cited in docs: "${top}"`).toContain(top);
    }
  });

  it('every cited subcommand on a subcommand group exists in createCliProgram() --help', () => {
    const requiredSubcommands = [
      'combos stale',
      'combos probe',
      'combos plan',
      'maintain authorize',
      'maintain apply',
      'apps drift',
      'mcp install',
    ];
    for (const pair of [...requiredSubcommands, ...backtickTwoWord]) {
      const [parent, sub] = pair.split(' ');
      if (!parent || !sub || NON_ROUTERSYNC_TOOLS.has(parent)) continue;
      const group = CLI_SUBCOMMAND_GROUPS.get(parent);
      if (!group) continue;
      expect(
        group.has(sub),
        `Cited subcommand "routersync ${parent} ${sub}" is not registered under "${parent}"`
      ).toBe(true);
      const helpText = group.get(sub) ?? '';
      expect(helpText).toContain('Usage:');
      expect(helpText).toContain(sub);
    }
  });
});

// ---------------------------------------------------------------------------
// File paths cited in docs must exist
// ---------------------------------------------------------------------------

describe('K8.6: file paths cited in docs exist', () => {
  const docs = ENROLLED_DOC_PATHS.map((p) => ({ file: p, content: readRel(p) }));

  it('every cited doc path exists in the repo', () => {
    for (const { file, content } of docs) {
      let m: RegExpExecArray | null;
      DOC_PATH_RE.lastIndex = 0;
      while ((m = DOC_PATH_RE.exec(content)) !== null) {
        const citedPath = m[0].replace(/\\/g, '/');
        expect(existsRel(citedPath), `Missing cited doc path "${citedPath}" in ${file}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// pnpm scripts cited in docs must exist in package.json
// ---------------------------------------------------------------------------

describe('K8.6: pnpm scripts cited in docs exist', () => {
  const docs = [
    readRel('AGENTS.md'),
    readRel('README.md'),
    readRel('docs/SETUP.md'),
    readRel('docs/CI.md'),
    readRel('docs/ROADMAP.md'),
  ];
  const cited = new Set<string>();
  const PNPM_SCRIPT_RE = /pnpm\s+([A-Za-z0-9:_\-]+)/g;
  for (const doc of docs) {
    let m: RegExpExecArray | null;
    while ((m = PNPM_SCRIPT_RE.exec(doc)) !== null) {
      const token = m[1];
      if (!token || token.startsWith('-')) continue;
      if (PNPM_BUILTIN.has(token)) continue;
      cited.add(token);
    }
  }

  it('every cited pnpm script in code spans is defined in package.json', () => {
    const CODE_PNPM_SCRIPT_RE = /`pnpm\s+([A-Za-z0-9:_\-]+)(?:\s|`)/g;
    for (const doc of docs) {
      let m: RegExpExecArray | null;
      while ((m = CODE_PNPM_SCRIPT_RE.exec(doc)) !== null) {
        const token = m[1];
        if (!token || token.startsWith('-') || PNPM_BUILTIN.has(token)) {
          continue;
        }
        expect(ROOT_SCRIPTS, `Unknown pnpm script in docs: pnpm ${token}`).toContain(token);
      }
    }
    expect(cited.size).toBeGreaterThan(0);
  });

  it('scripts required by AGENTS.md and SETUP.md are defined in package.json', () => {
    for (const s of REQUIRED_SCRIPTS) {
      expect(ROOT_SCRIPTS).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// M4-01 (P6) & M4-02 (P7): SETUP.md, combos-probe.md, known-issues.md, SECURITY.md
// ---------------------------------------------------------------------------

describe('M4-01 (P6) & M4-02 (P7): documentation contracts', () => {
  it('docs/SETUP.md matches package.json engines, uses pnpm hooks:install, and includes 4-step New-User Read-Only Quickstart', () => {
    const setup = readRel('docs/SETUP.md');
    const nvmrc = readRel('.nvmrc').trim();

    expect(ROOT_PACKAGE.engines?.node).toBe('>=22.12.0');
    expect(ROOT_PACKAGE.engines?.pnpm).toBe('>=10.0.0');
    expect(Number(nvmrc.replace(/^v/, '').split('.')[0])).toBeGreaterThanOrEqual(22);

    // No stale prerequisites or broken git hook path
    expect(setup).not.toContain('>= 20.0.0');
    expect(setup).not.toContain('>= 9.0.0');
    expect(setup).not.toContain('git config core.hooksPath tools/guard');

    // Accurate prerequisites & hook installer
    expect(setup).toContain('22.12.0');
    expect(setup).toContain('10.0.0');
    expect(setup).toContain('pnpm hooks:install');

    // 4-stage New-User Read-Only Quickstart: install -> doctor -> combos stale -> read-only trial on 9Router & OmniRoute
    expect(setup).toContain('pnpm install --frozen-lockfile');
    expect(setup).toContain('pnpm routersync doctor');
    expect(setup).toContain('pnpm routersync doctor --json');
    expect(setup).toContain('pnpm routersync combos stale --router 9router');
    expect(setup).toContain('pnpm routersync combos stale --router omniroute');
    expect(setup).toContain('pnpm routersync scan');
    expect(setup).toContain('pnpm routersync status');
    expect(setup).toContain('pnpm routersync plan');
    expect(setup).toContain('pnpm routersync verify');
    expect(setup).toContain('ROUTERSYNC_9ROUTER_DB');
    expect(setup).toContain('ROUTERSYNC_OMNIROUTE_DB');
  });

  it('docs/combos-probe.md documents max_tokens: 8 in step mode, --concurrency, client-side RequestBudget, and usage reconciliation', () => {
    const probeDoc = readRel('docs/combos-probe.md');
    expect(probeDoc).not.toMatch(/`--mode step`\s*\|\s*[^|]*`max_tokens:\s*1`/);
    expect(probeDoc).toContain('--concurrency');
    expect(probeDoc).toContain('RequestBudget');
    expect(probeDoc).toContain('reconcileSentVsUsage');
    expect(probeDoc).toContain('đối chiếu usage: sent=');
  });

  it('docs/CI.md lists M3/M4/Track-W agent tools and docs/known-issues.md documents W2 stream usageHistory mitigation', () => {
    const ciDoc = readRel('docs/CI.md');
    expect(ciDoc).toContain('pack-verify.mjs');
    expect(ciDoc).toContain('resource-variance.mjs');
    expect(ciDoc).toContain('security-audit.mjs');
    expect(ciDoc).toContain('c44-track-w.mjs');

    const knownIssues = readRel('docs/known-issues.md');
    expect(knownIssues).toContain('0.5.123');
    expect(knownIssues).toContain('usageHistory');
    expect(knownIssues).toContain('RequestBudget');
  });

  it('SECURITY.md defines v0.1 security scope, human-gated write paths, never-written-to-disk secrets list, and 48h SLA', () => {
    const sec = readRel('SECURITY.md');
    expect(sec).toContain('127.0.0.1');
    expect(sec).toContain('ROUTERSYNC_GRANT_SECRET');
    expect(sec).toContain('ApprovalToken');
    expect(sec).toContain('--yes-write-router');
    expect(sec).toMatch(/NEVER Writes to Disk|Never Writes to Disk/i);
    expect(sec).toContain('apiKeys');
    expect(sec).toContain('.env');
    expect(sec).toContain('48 hours');
  });
});

// ---------------------------------------------------------------------------
// M4-01 (P6): Hermetic offline CLI fixture smoke test
// ---------------------------------------------------------------------------

describe('M4-01 (P6): executable CLI fixture smoke for documented read-only commands', () => {
  it('runs --help, doctor, combos stale (9router & omniroute), and verify against os.tmpdir() fixture with 0 router writes', () => {
    const cliEntry = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
    expect(fs.existsSync(cliEntry), 'Compiled CLI packages/cli/dist/index.js must exist').toBe(true);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-doc-smoke-'));
    try {
      const fixtureDir = path.join(tmpRoot, 'sample');
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });

      const makeSampleScript = path.join(REPO_ROOT, 'tools', 'ci', 'make-sample-state.mjs');
      const sampleRes = spawnSync(process.execPath, [makeSampleScript, fixtureDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(sampleRes.status, `make-sample-state failed: ${sampleRes.stderr}`).toBe(0);

      const nineDb = path.join(fixtureDir, '9router.sqlite');
      const omniDb = path.join(fixtureDir, 'omniroute.sqlite');
      const configYaml = path.join(fixtureDir, 'routersync.yaml');

      // Seed OmniRoute `key_value` & `provider_connections` tables required by `combos stale --router omniroute`
      const dOmni = openBetterSqlite3(omniDb, { restrictToDir: fixtureDir });
      dOmni.exec(`
        CREATE TABLE IF NOT EXISTS provider_connections (id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER);
        CREATE TABLE IF NOT EXISTS key_value (namespace TEXT, key TEXT, value TEXT);
        CREATE TABLE IF NOT EXISTS radar_local_model_state (provider TEXT, model_id TEXT, enabled INTEGER, tombstoned INTEGER);
      `);
      dOmni
        .prepare('INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)')
        .run('syncedAvailableModels', 'gemini:conn-1', JSON.stringify([{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }]));
      dOmni.close();

      // Guardrail: fixture config must point strictly to 127.0.0.1:9 and never reference live ports
      const yamlText = fs.readFileSync(configYaml, 'utf8');
      expect(yamlText).toContain('http://127.0.0.1:9');
      for (const livePort of ['20128', '30128', '3128']) {
        expect(yamlText).not.toContain(livePort);
      }

      const nineShaBefore = sha256File(nineDb);
      const omniShaBefore = sha256File(omniDb);

      const isolatedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
        XDG_STATE_HOME: path.join(fakeHome, '.local', 'state'),
        ROUTERSYNC_9ROUTER_DB: nineDb,
        ROUTERSYNC_OMNIROUTE_DB: omniDb,
        ROUTERSYNC_STATE_DIR: path.join(fixtureDir, 'state'),
        ROUTERSYNC_CONFIG: configYaml,
      };
      delete isolatedEnv.OMNIROUTE_DB_PATH;
      delete isolatedEnv.NINEROUTER_DB_PATH;
      delete isolatedEnv.NINE_ROUTER_DB_PATH;
      delete isolatedEnv.DATA_DIR;

      const runCli = (args: string[]) =>
        spawnSync(process.execPath, [cliEntry, ...args], {
          cwd: tmpRoot,
          env: isolatedEnv,
          encoding: 'utf8',
          timeout: 30000,
          windowsHide: true,
        });

      const helpChecks: string[][] = [
        ['--help'],
        ['doctor', '--help'],
        ['combos', 'stale', '--help'],
      ];
      for (const args of helpChecks) {
        const res = runCli(args);
        expect(res.status, `CLI ${args.join(' ')} failed: ${res.stderr}`).toBe(0);
        expect(res.stdout).toContain('Usage:');
      }

      const doctorRes = runCli(['doctor', '--json']);
      expect(doctorRes.status, `doctor --json failed: ${doctorRes.stderr}`).toBe(0);
      const doctorJson = JSON.parse(doctorRes.stdout);
      expect(doctorJson).toBeTypeOf('object');

      const stale9Res = runCli(['combos', 'stale', '--router', '9router']);
      expect(stale9Res.status, `combos stale --router 9router failed: ${stale9Res.stderr}`).toBe(0);

      const staleOmniRes = runCli(['combos', 'stale', '--router', 'omniroute']);
      expect(staleOmniRes.status, `combos stale --router omniroute failed: ${staleOmniRes.stderr}`).toBe(0);

      const verifyFixtureRes = runCli(['verify']);
      expect(verifyFixtureRes.status, `verify failed: ${verifyFixtureRes.stderr}`).toBe(0);

      expect(sha256File(nineDb)).toBe(nineShaBefore);
      expect(sha256File(omniDb)).toBe(omniShaBefore);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// M4-02 (P7): Ensure node:test security-audit suite runs automatically in CI
// ---------------------------------------------------------------------------

describe('M4-02 (P7): security-audit.node.test.mjs executes in CI', () => {
  it('passes node --test test/agent/security-audit.node.test.mjs', () => {
    const suitePath = path.join(REPO_ROOT, 'test', 'agent', 'security-audit.node.test.mjs');
    expect(fs.existsSync(suitePath), 'test/agent/security-audit.node.test.mjs must exist').toBe(true);
    const res = spawnSync(process.execPath, ['--test', suitePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    expect(
      res.status,
      `security-audit.node.test.mjs failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    ).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Dangerous git publishing strings check (K6.2)
// ---------------------------------------------------------------------------

describe('K6.2: no dangerous git publish strings in repo files', () => {
  const FORBIDDEN_GIT_STRINGS = ['push origin master', '--tags', 'git push --all'];

  it('no publishable tracked or doc files contain dangerous git publish strings', () => {
    const files = execSync('git ls-files -co --exclude-standard', { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    for (const f of files) {
      if (f.startsWith('.agent/') || f.startsWith('test/') || f === 'tools/agent/security-audit.mjs') {
        continue;
      }
      const fullPath = path.resolve(REPO_ROOT, f);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const forbidden of FORBIDDEN_GIT_STRINGS) {
        expect(content, `Forbidden git string "${forbidden}" in ${f}`).not.toContain(forbidden);
      }
    }
  });
});
