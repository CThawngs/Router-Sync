#!/usr/bin/env node
// C15 Q1.3: report both os.freemem() and availableMemoryBytes() on every runner.
import os from 'node:os';
import { availableMemoryBytes } from '../../packages/cli/dist/low-resource.js';
const MiB = 1024 * 1024;
console.log(`MEM-REPORT platform=${process.platform}`);
console.log(`MEM-REPORT os.freemem=${Math.round(os.freemem() / MiB)} MiB`);
console.log(`MEM-REPORT availableMemoryBytes=${Math.round(availableMemoryBytes() / MiB)} MiB`);
