#!/usr/bin/env node
/**
 * tools/agent/preflight.mjs
 *
 * C15 Q3.1: local-agent preflight. Prints available RAM, core count and whether
 * the repo sits under a cloud-sync folder (CÓ / KHÔNG). No product code changes.
 */
import os from 'node:os';
import path from 'node:path';
import { availableMemoryBytes } from '../../packages/cli/dist/low-resource.js';

const CLOUD_MARKERS = ['onedrive', 'dropbox', 'icloud', 'google drive', 'synology drive', 'megasync'];
const GiB = 1024 ** 3;
const cwd = process.cwd();
const lower = cwd.toLowerCase();
const cloud = CLOUD_MARKERS.some((m) => lower.includes(m));

const avail = availableMemoryBytes();
console.log(`available RAM: ${(avail / GiB).toFixed(2)} GiB`);
console.log(`cores: ${os.availableParallelism?.() ?? os.cpus().length}`);
console.log(`cloud-sync folder: ${cloud ? 'CÓ' : 'KHÔNG'}`);
console.log(`mode: ${avail < 1.5 * GiB ? 'LIGHT-DEV' : 'FULL'}`);
if (cloud) console.log('hint: move the repo outside the cloud-synced folder to reduce I/O.');
