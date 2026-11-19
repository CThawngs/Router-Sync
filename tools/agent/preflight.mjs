#!/usr/bin/env node
/**
 * tools/agent/preflight.mjs
 *
 * C15 Q3.1: local-agent preflight. Prints available RAM, core count and whether
 * the repo sits under a cloud-sync folder (CÓ / KHÔNG). No product code changes.
 * Keep this script self-contained so it can run before the project is built.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const CLOUD_MARKERS = ['onedrive', 'dropbox', 'icloud', 'google drive', 'synology drive', 'megasync'];
const MiB = 1024 * 1024;
const GiB = 1024 ** 3;

function parseVmStat(text) {
  const match = text.match(/page size of\s+(\d+)\s+bytes/i);
  if (!match) return null;

  const pageSize = Number(match[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  let pages = 0;
  let found = false;
  for (const key of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(`${key}:`));
    if (!line) continue;

    const value = line.split(':')[1]?.replace(/[^\d]/g, '');
    if (value) {
      pages += Number(value);
      found = true;
    }
  }
  return found ? pages * pageSize : null;
}

function availableMemoryBytes() {
  if (process.platform !== 'darwin') return os.freemem();

  try {
    const result = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 1000 });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const parsed = parseVmStat(result.stdout);
      if (parsed !== null) return parsed;
    }
  } catch {
    // Fall back to the portable Node.js value.
  }
  return os.freemem();
}

const cwd = process.cwd();
const lower = cwd.toLowerCase();
const cloud = CLOUD_MARKERS.some((m) => lower.includes(m));

const fake = process.env['RS_FAKE_AVAILABLE_MB'];
const avail = fake !== undefined && Number.isFinite(Number(fake))
  ? Number(fake) * MiB
  : availableMemoryBytes();
console.log(`available RAM: ${(avail / GiB).toFixed(2)} GiB`);
console.log(`cores: ${os.availableParallelism?.() ?? os.cpus().length}`);
console.log(`cloud-sync folder: ${cloud ? 'CÓ' : 'KHÔNG'}`);
console.log(`mode: ${avail < 1.5 * GiB ? 'LIGHT-DEV' : 'FULL'}`);
if (cloud) console.log('hint: move the repo outside the cloud-synced folder to reduce I/O.');
