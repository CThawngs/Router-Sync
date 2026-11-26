/**
 * test/docs/c46-f3-doc-cli-sync.test.ts
 *
 * Ticket C46-F3 & C46-F6 (`Phục vụ: S9, I4, I5`) — Reusable Doc-CLI Sync Validator,
 * `docs/runbook/LIVE-E2E-v2.md` Contract Suite, and `docs/runbook/OWNER-CHECKLIST.md`
 * 1-Page Owner Checklist Contract Suite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliProgram } from '../../packages/cli/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export interface CliOptionLike {
  readonly short?: string;
  readonly long?: string;
  readonly required?: boolean;
  readonly optional?: boolean;
  readonly negate?: boolean;
}

export interface CliCommandLike {
  readonly parent: CliCommandLike | null;
  readonly options: readonly CliOptionLike[];
  readonly commands: readonly CliCommandLike[];
  readonly registeredArguments: readonly unknown[];
  name(): string;
  aliases(): readonly string[];
}

export interface ExtractedCliInvocation {
  kind: 'routersync' | 'node-tool';
  rawCommand: string;
  tokens: string[];
  blockIndex: number;
}

export interface DocCliSyncIssue {
  rawCommand: string;
  reason: string;
}

export interface DocCliSyncResult {
  invocations: ExtractedCliInvocation[];
  issues: DocCliSyncIssue[];
}

function tokenizeShellCommand(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        current += line[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') {
      // Unquoted comment trails to end of logical command
      break;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function extractFencedShellBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fenceRegex = /```(?:sh|bash|zsh|shell|powershell|ps1)?\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

function joinContinuedLines(block: string): string[] {
  const rawLines = block.split(/\r?\n/);
  const logicalLines: string[] = [];
  let buffer = '';

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (buffer) {
        logicalLines.push(buffer.trim());
        buffer = '';
      }
      continue;
    }
    if (!buffer && trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.endsWith('\\')) {
      buffer += `${trimmed.slice(0, -1)} `;
    } else {
      buffer += trimmed;
      logicalLines.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) {
    logicalLines.push(buffer.trim());
  }
  return logicalLines;
}

/**
 * Extracts all executable `routersync ...` and `node tools/...` invocations
 * from fenced shell/PowerShell code blocks in a markdown document.
 */
export function extractDocCliInvocations(markdown: string): ExtractedCliInvocation[] {
  const blocks = extractFencedShellBlocks(markdown);
  const invocations: ExtractedCliInvocation[] = [];

  blocks.forEach((block, blockIndex) => {
    for (const logicalLine of joinContinuedLines(block)) {
      const segments = logicalLine
        .split(/&&|;/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const segment of segments) {
        const tokens = tokenizeShellCommand(segment);
        if (tokens.length === 0) continue;

        // Strip leading POSIX VAR=val assignments if present
        let startIdx = 0;
        while (
          startIdx < tokens.length &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[startIdx]!)
        ) {
          startIdx += 1;
        }
        const cmdTokens = tokens.slice(startIdx);
        if (cmdTokens.length === 0) continue;

        if (cmdTokens[0] === 'routersync') {
          invocations.push({
            kind: 'routersync',
            rawCommand: segment,
            tokens: cmdTokens,
            blockIndex,
          });
        } else if (
          cmdTokens[0] === 'node' &&
          cmdTokens[1] &&
          cmdTokens[1].replace(/\\/g, '/').startsWith('tools/')
        ) {
          invocations.push({
            kind: 'node-tool',
            rawCommand: segment,
            tokens: cmdTokens,
            blockIndex,
          });
        }
      }
    }
  });

  return invocations;
}

function collectAllowedFlags(cmd: CliCommandLike): Map<string, boolean> {
  const map = new Map<string, boolean>();
  map.set('--help', false);
  map.set('-h', false);
  if (cmd.parent === null) {
    map.set('--version', false);
    map.set('-V', false);
  }
  for (const opt of cmd.options) {
    const takesArg = Boolean(opt.required || opt.optional);
    if (opt.short) map.set(opt.short, takesArg);
    if (opt.long) {
      map.set(opt.long, takesArg);
      if (opt.negate) {
        map.set(opt.long, false);
      }
    }
  }
  return map;
}

/**
 * Validates every extracted `routersync ...` subcommand/flag against `createCliProgram()`
 * and every `node tools/...` script path against `repoRoot`.
 */
export function verifyDocCliSync(
  markdown: string,
  options: { repoRoot?: string; program?: CliCommandLike } = {}
): DocCliSyncResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const program: CliCommandLike =
    options.program ?? (createCliProgram() as unknown as CliCommandLike);
  const invocations = extractDocCliInvocations(markdown);
  const issues: DocCliSyncIssue[] = [];

  for (const inv of invocations) {
    if (inv.kind === 'node-tool') {
      const relScript = inv.tokens[1]!.replace(/\\/g, '/');
      const absScript = path.join(repoRoot, relScript);
      if (!fs.existsSync(absScript) || !fs.statSync(absScript).isFile()) {
        issues.push({
          rawCommand: inv.rawCommand,
          reason: `Referenced tool script does not exist on disk: ${relScript}`,
        });
      }
      continue;
    }

    // Resolve deepest matching Commander subcommand chain
    let curCmd: CliCommandLike = program;
    let idx = 1;
    while (idx < inv.tokens.length) {
      const tok = inv.tokens[idx]!;
      if (tok.startsWith('-')) break;
      const sub = curCmd.commands.find(
        (c: CliCommandLike) => c.name() === tok || c.aliases().includes(tok)
      );
      if (!sub) break;
      curCmd = sub;
      idx += 1;
    }

    // If first token after `routersync` was non-option and matched no top-level command, fail!
    if (curCmd === program && idx < inv.tokens.length && !inv.tokens[idx]!.startsWith('-')) {
      issues.push({
        rawCommand: inv.rawCommand,
        reason: `Unknown routersync command '${inv.tokens[idx]}'`,
      });
      continue;
    }

    // If `curCmd` is a pure command group (has subcommands and no custom action handler) and next non-option token exists, fail!
    if (
      curCmd !== program &&
      curCmd.commands.length > 0 &&
      idx < inv.tokens.length &&
      !inv.tokens[idx]!.startsWith('-') &&
      curCmd.registeredArguments.length === 0
    ) {
      issues.push({
        rawCommand: inv.rawCommand,
        reason: `Unknown subcommand '${inv.tokens[idx]}' under 'routersync ${curCmd.name()}'`,
      });
      continue;
    }

    const allowedFlags = collectAllowedFlags(curCmd);
    for (let i = idx; i < inv.tokens.length; i += 1) {
      const tok = inv.tokens[i]!;
      if (!tok.startsWith('-') || tok === '--') continue;
      const eqIdx = tok.indexOf('=');
      const flagName = eqIdx > 0 ? tok.slice(0, eqIdx) : tok;

      if (!allowedFlags.has(flagName)) {
        issues.push({
          rawCommand: inv.rawCommand,
          reason: `Unknown CLI flag '${flagName}' on 'routersync ${curCmd === program ? '' : curCmd.name()}'`,
        });
        continue;
      }

      const takesValue = allowedFlags.get(flagName) ?? false;
      if (takesValue && eqIdx < 0) {
        const nextTok = inv.tokens[i + 1];
        if (nextTok && !nextTok.startsWith('-')) {
          i += 1;
        }
      }
    }
  }

  return { invocations, issues };
}

describe('C46-F3: docs/runbook/LIVE-E2E-v2.md Doc-CLI Sync & Complete Workflow Contract', () => {
  it('validates every routersync CLI command/flag and node tools/* script in LIVE-E2E-v2.md', () => {
    const runbookPath = path.join(REPO_ROOT, 'docs', 'runbook', 'LIVE-E2E-v2.md');
    const markdown = fs.readFileSync(runbookPath, 'utf8');
    const result = verifyDocCliSync(markdown);

    expect(result.invocations.length).toBeGreaterThanOrEqual(15);
    expect(result.issues).toEqual([]);
  });

  it('documents C46-F2 live_gate_hint + live env flags and C46-F3 harness plan/apply/auto-safe/rollback commands', () => {
    const runbookPath = path.join(REPO_ROOT, 'docs', 'runbook', 'LIVE-E2E-v2.md');
    const markdown = fs.readFileSync(runbookPath, 'utf8');
    const invocations = extractDocCliInvocations(markdown).map((i) => i.rawCommand);

    // C46-F2: 7th check `live_gate_hint` + explicit owner live write flags (POSIX + PowerShell)
    expect(markdown).toContain('live_gate_hint');
    expect(markdown).toContain('ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1');
    expect(markdown).toContain('ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1');
    expect(markdown).toContain('$env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE="1"');
    expect(markdown).toContain('$env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE="1"');

    // C46-F3: Executable (uncommented!) harness plan, apply --write, tick --mode auto-safe, and rollback commands
    expect(invocations.some((cmd) => cmd.startsWith('routersync apps plan'))).toBe(true);
    expect(
      invocations.some(
        (cmd) => cmd.startsWith('routersync apps apply') && cmd.includes('--write')
      )
    ).toBe(true);
    expect(
      invocations.some(
        (cmd) => cmd.startsWith('routersync tick') && cmd.includes('--mode auto-safe')
      )
    ).toBe(true);
    expect(invocations.some((cmd) => cmd.startsWith('routersync apps rollback'))).toBe(true);
  });

  it('catches unknown subcommands, unknown flags, and missing tools scripts in verifyDocCliSync (helper self-test for F6)', () => {
    const sampleBadDoc = [
      '```sh',
      'routersync live-check --nonexistent-flag',
      'routersync apps imaginary-subcommand --app hermes',
      'node tools/agent/does-not-exist.mjs',
      '```',
    ].join('\n');

    const check = verifyDocCliSync(sampleBadDoc);
    expect(check.issues).toHaveLength(3);
    expect(check.issues[0]!.reason).toContain('--nonexistent-flag');
    expect(check.issues[1]!.reason).toContain('imaginary-subcommand');
    expect(check.issues[2]!.reason).toContain('tools/agent/does-not-exist.mjs');
  });
});

describe('C46-F6: docs/runbook/OWNER-CHECKLIST.md 1-Page Checklist & Doc-CLI Sync Contract', () => {
  const checklistPath = path.join(REPO_ROOT, 'docs', 'runbook', 'OWNER-CHECKLIST.md');

  it('stays within 130 lines and documents the owner-only S9 pilot', () => {
    expect(fs.existsSync(checklistPath), 'docs/runbook/OWNER-CHECKLIST.md must exist').toBe(true);
    const markdown = fs.readFileSync(checklistPath, 'utf8');
    const lines = markdown.split(/\r?\n/);

    expect(lines.length).toBeLessThanOrEqual(130);
    expect(markdown).toContain('- **Phục vụ: S9**');
    expect(markdown).toContain('READY_FOR_OWNER_LIVE_PILOT');

    // Pre-flight Rules Box requirements
    const step1Idx = markdown.search(/^1\.\s+/m);
    expect(step1Idx).toBeGreaterThan(0);
    const preflightSection = markdown.slice(0, step1Idx);
    expect(preflightSection).toContain('rs-pilot');
    expect(preflightSection).toContain('rs-fast');
    expect(preflightSection).toContain('<ID_ROUTER>');
    expect(preflightSection).toContain('routers[].id');
    expect(preflightSection).toContain('Hermes');
    expect(preflightSection).toContain('OpenCode');
    expect(preflightSection).toContain('OpenMausBot');
    expect(preflightSection).toContain('routines.json');
    expect(preflightSection).toContain('bots.json');
    expect(preflightSection).toMatch(/20[–-]31/);
    expect(preflightSection).toContain('detectionLatencyMs');
    expect(preflightSection).toContain('ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1');
    expect(preflightSection).toContain('ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1');

    // D1 & D2 runbook invariants: router:<ID_ROUTER>/rs-pilot (never hardcoded router:omniroute/rs-pilot) & steady-state measuredCount = 0 note
    expect(markdown).not.toContain('router:omniroute/rs-pilot');
    expect(markdown).toContain('router:<ID_ROUTER>/rs-pilot');
    expect(markdown).toContain('measuredCount');
    expect(preflightSection).toMatch(/^0\. .*rs-pilot.*10 model/m);
    expect(markdown).toContain('ít nhất 15 phút');
    expect(markdown).toContain('ít nhất 24 giờ');
    expect(markdown).toContain('`INCOMPLETE`');
  });

  it('provides shared commands or paired shell commands and checks each step result', () => {
    const markdown = fs.readFileSync(checklistPath, 'utf8');
    const syncRes = verifyDocCliSync(markdown);
    expect(syncRes.issues).toEqual([]);

    const stepHeadingMatches = [...markdown.matchAll(/^([1-9]\d*)\.\s+.+$/gm)];
    expect(stepHeadingMatches.length).toBeGreaterThanOrEqual(12);

    for (let i = 0; i < stepHeadingMatches.length; i += 1) {
      const current = stepHeadingMatches[i]!;
      const next = stepHeadingMatches[i + 1];
      const start = current.index!;
      const end = next ? next.index! : markdown.length;
      const stepChunk = markdown.slice(start, end);
      const stepNum = Number(current[1]);
      expect(stepNum).toBe(i + 1);

      const blocks = extractFencedShellBlocks(stepChunk);
      const powerShell = [...stepChunk.matchAll(/^\s*PowerShell `([^`]+)`\s*$/gm)];
      const bash = [...stepChunk.matchAll(/^\s*Bash `([^`]+)`\s*$/gm)];
      expect(
        powerShell.length,
        `Step ${stepNum} must provide the same command coverage in both shells`
      ).toBe(bash.length);
      if (powerShell.length > 0) {
        expect(powerShell).toHaveLength(1);
        expect(powerShell[0]![1]).not.toMatch(/&&|sha256sum/);
      }
      if (blocks.length > 0) {
        expect(blocks).toHaveLength(1);
        expect(joinContinuedLines(blocks[0]!)).toHaveLength(1);
      } else {
        expect(powerShell).toHaveLength(1);
      }

      const expectedLines = stepChunk
        .split(/\r?\n/)
        .filter((l) => l.includes('Kết quả đúng:'));
      expect(
        expectedLines.length,
        `Step ${stepNum} must have exactly 1 "Kết quả đúng:" line`
      ).toBe(1);
    }

    const rawCmds = syncRes.invocations.map((inv) => inv.rawCommand);
    expect(rawCmds.some((c) => c.startsWith('routersync doctor --json'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync live-check'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync consent grant'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync plan --json'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync apps plan'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync apply --write'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync apps apply'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync tick --mode auto-safe'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync freeze'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync unfreeze'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync rollback'))).toBe(true);
    expect(rawCmds.some((c) => c.startsWith('routersync apps rollback'))).toBe(true);
    expect(
      rawCmds.some(
        (c) =>
          c.startsWith('routersync pilot-report') &&
          c.includes('-c ') &&
          c.includes('router:<ID_ROUTER>/rs-pilot')
      )
    ).toBe(true);
  });
});
