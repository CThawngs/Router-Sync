#!/usr/bin/env node
// CI helper: check one command's perf line against budgets.json.
// Usage: node tools/ci/check-perf.mjs <stderr-file> <command-name>
import fs from 'node:fs';

const [, , file, name] = process.argv;
if (!file || !name) { console.error('usage: check-perf.mjs <stderr-file> <command>'); process.exit(2); }

const text = fs.readFileSync(file, 'utf8');
const matches = [...text.matchAll(/\[routersync-perf\]\s+(\{.*\})/g)];
if (matches.length === 0) { console.error(`NO PERF LINE: ${name}`); process.exit(1); }
const perf = JSON.parse(matches[matches.length - 1][1]);
const budgets = JSON.parse(fs.readFileSync('budgets.json', 'utf8'));
const perOs = budgets.os[process.platform]?.[name];
const limitMs = perOs?.budgetMs ?? budgets.hardCaps.maxMs;
const limitRss = perOs?.budgetRssMB ?? budgets.hardCaps.maxRssMB;

const problems = [];
if (!(perf.durationMs <= limitMs)) problems.push(`durationMs ${perf.durationMs} > ${limitMs}`);
if (!(perf.maxRssMB <= limitRss)) problems.push(`maxRssMB ${perf.maxRssMB} > ${limitRss}`);
if (problems.length) {
  console.error(`BUDGET FAIL ${name} (${process.platform}): ${problems.join(', ')}`);
  process.exit(1);
}
console.log(`BUDGET OK ${name} (${process.platform}): ${perf.durationMs} ms / ${perf.maxRssMB} MB`);
