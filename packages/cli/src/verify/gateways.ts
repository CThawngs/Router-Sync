/**
 * packages/cli/src/verify/gateways.ts
 *
 * Reads registry/gateways.yaml: the list of providers that expose only a
 * full catalog endpoint (GET /models) and no per-model lookup. A model that
 * disappears from such a provider cannot be probed directly, so the
 * ABSENT-STABLE rule needs a wider evidence window.
 *
 * The registry is shared product data - no provider name is hardcoded here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GatewayEntry {
  id: string;
  name: string;
  hasSingleModelGet: boolean;
  reason: string;
}

/** Find registry/gateways.yaml by walking up from `cwd`. */
export function findGatewaysFile(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'registry', 'gateways.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Parse the flat gateway list from registry/gateways.yaml. */
export function loadGatewayRegistry(cwd: string = process.cwd()): GatewayEntry[] {
  const file = findGatewaysFile(cwd);
  if (!file) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: GatewayEntry[] = [];
  let cur: Partial<GatewayEntry> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const idMatch = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (idMatch) {
      if (cur?.id) out.push(cur as GatewayEntry);
      cur = { id: idMatch[1]!.trim(), hasSingleModelGet: true };
      continue;
    }
    if (!cur) continue;
    const field = line.match(/^\s+(name|hasSingleModelGet|reason):\s*(.*)$/);
    if (!field) continue;
    if (field[1] === 'hasSingleModelGet') cur.hasSingleModelGet = field[2]!.trim() === 'true';
    else if (field[1] === 'name') cur.name = field[2]!.trim();
    else if (field[1] === 'reason') cur.reason = field[2]!.trim();
  }
  if (cur?.id) out.push(cur as GatewayEntry);
  return out;
}

/**
 * True when the provider exposes only a full catalog endpoint, so a single
 * model cannot be probed and a missing model needs a wider absence window.
 */
export function providerHasSingleModelGet(providerPrefix: string, cwd: string = process.cwd()): boolean {
  const prefix = providerPrefix.trim().toLowerCase();
  if (prefix === '') return true;
  const entry = loadGatewayRegistry(cwd).find((g) => g.id.toLowerCase() === prefix);
  if (!entry) return true;
  return entry.hasSingleModelGet;
}
