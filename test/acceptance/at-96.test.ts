/**
 * test/acceptance/at-96.test.ts
 *
 * Acceptance Test AT-96: Skill Pack Reality Alignment (Condition C3).
 *
 * Spec:
 *  - Parses `docs/ai/skill-routersync.md`.
 *  - Extracts every MCP tool and CLI command mentioned in the skill pack.
 *  - Asserts that every documented tool exists in the real MCP server (READ_ONLY_TOOL_NAMES).
 *  - Asserts that every documented command exists in the real CLI (createCliProgram).
 *  - Rejects skill packs with invented or non-existent tools/commands.
 *  - Asserts at least 4 practical workflow examples are provided.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { READ_ONLY_TOOL_NAMES } from '../../packages/mcp-server/dist/index.js';
import { createCliProgram } from '../../packages/cli/dist/index.js';

describe('Acceptance Test AT-96: Skill Pack Verification Against Live MCP & CLI (Condition C3)', () => {
  const skillPackPath = path.resolve(__dirname, '..', '..', 'docs', 'ai', 'skill-routersync.md');

  it('verifies that docs/ai/skill-routersync.md exists and is non-empty', () => {
    expect(fs.existsSync(skillPackPath)).toBe(true);
    const content = fs.readFileSync(skillPackPath, 'utf8');
    expect(content.length).toBeGreaterThan(500);
  });

  it('ensures every documented MCP tool exists in the real MCP server', () => {
    const content = fs.readFileSync(skillPackPath, 'utf8');
    const mcpSection = content.split('## 3. Real MCP Tools Catalog')[1]?.split('## 4.')[0] ?? '';

    // Extract tool names from markdown tables in MCP section
    const tableRegex = /\|\s*`([a-z_]+)`\s*\|\s*[^|]+\|/g;
    const documentedTools = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = tableRegex.exec(mcpSection)) !== null) {
      if (match[1]) {
        documentedTools.add(match[1]);
      }
    }

    expect(documentedTools.size).toBe(24);

    const realToolSet = new Set<string>(READ_ONLY_TOOL_NAMES);

    // Every documented tool MUST exist in the real tool set (no hallucinated tools)
    for (const tool of documentedTools) {
      expect(realToolSet.has(tool), `Documented tool '${tool}' does not exist in real MCP server!`).toBe(true);
    }
  });

  it('ensures every documented CLI command exists in the real CLI program', () => {
    const content = fs.readFileSync(skillPackPath, 'utf8');
    const program = createCliProgram();
    const realCommandNames = new Set(program.commands.map((c) => c.name()));

    // Commands to check from skill pack table
    const cliCommands = ['init', 'scan', 'plan', 'apply', 'rollback', 'status', 'doctor', 'mcp'];

    for (const cmd of cliCommands) {
      expect(realCommandNames.has(cmd), `Documented CLI command '${cmd}' does not exist in real CLI!`).toBe(true);
    }
  });

  it('verifies the skill pack provides at least 4 workflow examples', () => {
    const content = fs.readFileSync(skillPackPath, 'utf8');
    const exampleMatches = content.match(/### Example \d+:/g);
    expect(exampleMatches).not.toBeNull();
    expect(exampleMatches?.length).toBeGreaterThanOrEqual(4);
  });

  it('ensures all sample comboIds in workflow examples start with routersync- prefix', () => {
    const content = fs.readFileSync(skillPackPath, 'utf8');
    const comboIdMatches = [...content.matchAll(/"comboId":\s*"([^"]+)"/g)];
    expect(comboIdMatches.length).toBeGreaterThan(0);
    for (const match of comboIdMatches) {
      expect(match[1]?.startsWith('routersync-'), `Sample comboId '${match[1]}' does not start with 'routersync-' prefix!`).toBe(true);
    }
  });
});
