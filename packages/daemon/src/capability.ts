/**
 * packages/daemon/src/capability.ts
 *
 * Capability registry for W4/C2: single source of truth for what each
 * surface (MCP / HTTP / GUI / CLI) is allowed to do. Pure data, no I/O.
 * GUI is not wired yet (C2) — every row reports 'chua noi' with a reason.
 */

export type CapabilityRisk = 'read' | 'propose' | 'write';

export interface Capability {
  id: string;
  inSchema: string;
  outSchema: string;
  risk: CapabilityRisk;
}

/** Automation levels allowed by W4. 'full' must never appear. */
export const AUTOMATION_LEVELS = ['observe', 'propose', 'auto-safe'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

export const CAPABILITIES: readonly Capability[] = [
  { id: 'scan', inSchema: '{ router?: 9router|omniroute|all }', outSchema: '{ views: ScanView[] }', risk: 'read' },
  { id: 'diff', inSchema: '{ router, combo }', outSchema: '{ added: string[], removed: string[] }', risk: 'read' },
  { id: 'plan', inSchema: '{ router, combo, autonomy }', outSchema: '{ changes: PlanChange[], planHash }', risk: 'read' },
  { id: 'remove', inSchema: '{ router, combo, modelId }', outSchema: '{ proposal: PlanChange }', risk: 'propose' },
  { id: 'add', inSchema: '{ router, combo, modelId }', outSchema: '{ proposal: PlanChange }', risk: 'propose' },
  { id: 'reorder', inSchema: '{ router, combo }', outSchema: '{ proposal: PlanChange }', risk: 'propose' },
  { id: 'health', inSchema: '{ router?, days? }', outSchema: '{ report: HealthReport }', risk: 'read' },
  { id: 'discover', inSchema: '{}', outSchema: '{ candidates: DiscoverEntry[] }', risk: 'read' },
  { id: 'research', inSchema: '{ query }', outSchema: '{ results: ResearchEntry[] }', risk: 'read' },
  { id: 'daemon', inSchema: '{ port? }', outSchema: '{ status: running, port }', risk: 'read' },
  { id: 'schedule', inSchema: '{ intervalMinutes?, autonomy? }', outSchema: '{ artifacts: ScheduleArtifacts }', risk: 'read' },
  { id: 'autoSafe', inSchema: '{ router, combo }', outSchema: '{ changes: PlanChange[] }', risk: 'propose' },
  { id: 'mcpRead', inSchema: '{ tool, args }', outSchema: '{ result: unknown }', risk: 'read' },
  { id: 'mcpPropose', inSchema: '{ tool, args, planHash }', outSchema: '{ plan: PlanChange }', risk: 'propose' },
];

export interface CapabilityMatrixRow {
  capability: string;
  mcp: string;
  http: string;
  gui: string;
  guiReason: string;
  cli: string;
}

const GUI_UNWIRED_REASON = 'C2: GUI chua noi, dung CLI/MCP/HTTP thay the';

export function generateCapabilityMatrix(): CapabilityMatrixRow[] {
  return CAPABILITIES.map((cap) => {
    switch (cap.risk) {
      case 'read':
        return { capability: cap.id, mcp: 'co', http: 'co', gui: 'chua noi', guiReason: GUI_UNWIRED_REASON, cli: 'co' };
      case 'propose':
        return { capability: cap.id, mcp: 'co', http: 'chua noi', gui: 'chua noi', guiReason: GUI_UNWIRED_REASON, cli: 'co' };
      case 'write':
        return { capability: cap.id, mcp: 'chua noi', http: 'chua noi', gui: 'chua noi', guiReason: GUI_UNWIRED_REASON, cli: 'co' };
    }
  });
}
