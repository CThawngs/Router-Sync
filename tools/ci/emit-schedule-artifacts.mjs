// CI helper (C4q/Q1 + C45-WP7): write the generated scheduler artifacts to a directory so
// the OS-native linters and crontab marker checks can verify them. Installs nothing.
// Usage: node tools/ci/emit-schedule-artifacts.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] ?? 'schedule-artifacts');
mkdirSync(out, { recursive: true });
const mod = await import(pathToFileURL(resolve('packages/cli/dist/commands/schedule.js')).href);
const a = mod.buildTickScheduleArtifacts({ mode: 'propose', logDir: out });
writeFileSync(join(out, 'routersync-daemon.service'), a.systemdUnit + '\n');
writeFileSync(join(out, 'routersync-daemon.timer'), a.systemdTimer + '\n');
writeFileSync(join(out, 'com.routersync.daemon.plist'), a.launchdPlist + '\n');
writeFileSync(join(out, 'routersync-task.xml'), mod.encodeWindowsTaskXml(a.windowsXml));
writeFileSync(join(out, 'routersync-tick.cron'), a.linuxCron + '\n');
console.log('emitted to', out);
