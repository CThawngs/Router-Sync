/**
 * packages/cli/src/commands/inbox.ts
 *
 * Implements `routersync inbox list | ack | snooze <id> --days <n>` (Round C4c A8):
 * Manages inbox proposals and alerts in .routersync/inbox.json.
 * Zero router writes, local status state only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveTickStateDir } from './tick.js';

export interface InboxItem {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  body: string;
  provider?: string | undefined;
  label?: string | undefined;
  status?: 'pending' | 'acknowledged' | 'snoozed' | undefined;
  acknowledgedAt?: string | undefined;
  snoozeUntil?: string | undefined;
  proposed_by?: { kind: string; source: string } | undefined;
}

export interface InboxState {
  updatedAt: string;
  items: InboxItem[];
}

export interface InboxCommandOptions {
  action: 'list' | 'ack' | 'snooze';
  id?: string | undefined;
  days?: number | undefined;
  stateDir?: string | undefined;
}

export function loadInboxState(inboxPath: string): InboxState {
  if (!fs.existsSync(inboxPath)) {
    return { updatedAt: new Date(0).toISOString(), items: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)) {
      return raw as InboxState;
    }
    if (Array.isArray(raw)) {
      return { updatedAt: new Date().toISOString(), items: raw as InboxItem[] };
    }
  } catch {
    // fallback
  }
  return { updatedAt: new Date().toISOString(), items: [] };
}

export function saveInboxState(inboxPath: string, state: InboxState): void {
  const dir = path.dirname(inboxPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(inboxPath, JSON.stringify(state, null, 2), 'utf8');
}

export async function runInboxCommand(options: InboxCommandOptions): Promise<void> {
  const sDir = resolveTickStateDir(options.stateDir);
  const inboxPath = path.join(sDir, 'inbox.json');
  const state = loadInboxState(inboxPath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (options.action === 'list') {
    // Filter active items: not acknowledged, and snoozeUntil has elapsed
    const active = state.items.filter((item) => {
      if (item.status === 'acknowledged') return false;
      if (item.status === 'snoozed' && item.snoozeUntil) {
        const snoozeMs = Date.parse(item.snoozeUntil);
        if (Number.isFinite(snoozeMs) && snoozeMs > nowMs) return false;
      }
      return true;
    });

    console.log(`INBOX items=${active.length} total_stored=${state.items.length}`);
    for (const it of active) {
      console.log(`  [${it.type.toUpperCase()}] id=${it.id} label=${it.label ?? '-'} date=${it.timestamp}`);
      console.log(`    title: ${it.title}`);
      if (it.body) console.log(`    body: ${it.body.slice(0, 120)}${it.body.length > 120 ? '...' : ''}`);
    }
    return;
  }

  if (options.action === 'ack') {
    if (!options.id) {
      throw new Error('Missing item id for inbox ack');
    }
    const item = state.items.find((i) => i.id === options.id);
    if (!item) {
      console.log(`INBOX-ACK id=${options.id} status=NOT_FOUND`);
      return;
    }
    item.status = 'acknowledged';
    item.acknowledgedAt = nowIso;
    saveInboxState(inboxPath, state);
    console.log(`INBOX-ACK id=${options.id} status=ACKNOWLEDGED at=${nowIso}`);
    return;
  }

  if (options.action === 'snooze') {
    if (!options.id) {
      throw new Error('Missing item id for inbox snooze');
    }
    const days = Math.max(1, options.days ?? 7);
    const snoozeUntil = new Date(nowMs + days * 24 * 3600 * 1000).toISOString();
    const item = state.items.find((i) => i.id === options.id);
    if (!item) {
      console.log(`INBOX-SNOOZE id=${options.id} status=NOT_FOUND`);
      return;
    }
    item.status = 'snoozed';
    item.snoozeUntil = snoozeUntil;
    saveInboxState(inboxPath, state);
    console.log(`INBOX-SNOOZE id=${options.id} days=${days} snoozeUntil=${snoozeUntil} status=SNOOZED`);
    return;
  }
}
