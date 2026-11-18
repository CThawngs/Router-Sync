#!/usr/bin/env node
// C15 Q2.4: cross-platform check of low-priority scheduler artifact keys.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
function read(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return b.toString('utf16le').split('').reverse().join('');
  return b.toString('utf8');
}
const win = read(path.join(dir, 'routersync-task.xml'));
const srv = read(path.join(dir, 'routersync-daemon.service'));
const plist = read(path.join(dir, 'com.routersync.daemon.plist'));

const checks = [
  [win, '<Priority>7</Priority>', 'Windows Priority'],
  [win, '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', 'Windows IgnoreNew'],
  [win, '<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>', 'Windows ExecutionTimeLimit'],
  [srv, 'Nice=10', 'systemd Nice'],
  [srv, 'IOSchedulingClass=idle', 'systemd IO'],
  [srv, 'CPUWeight=20', 'systemd CPUWeight'],
  [srv, 'MemoryHigh=512M', 'systemd MemoryHigh'],
  [plist, '<key>ProcessType</key><string>Background</string>', 'launchd ProcessType'],
  [plist, '<key>LowPriorityIO</key><true/>', 'launchd LowPriorityIO'],
  [plist, '<key>Nice</key><integer>10</integer>', 'launchd Nice'],
];
const missing = checks.filter(([text, needle]) => !text.includes(needle)).map(([, , label]) => label);
if (missing.length) {
  console.error('SCHEDULE PRIORITY KEYS MISSING: ' + missing.join(', '));
  process.exit(1);
}
console.log('SCHEDULE PRIORITY KEYS OK');
