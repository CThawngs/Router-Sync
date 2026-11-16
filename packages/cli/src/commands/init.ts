/**
 * packages/cli/src/commands/init.ts
 *
 * Implements `routersync init` command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaultConfigPath, getSampleConfigYaml } from '../config/loader.js';

export interface InitCommandOptions {
  path?: string;
  force?: boolean;
  json?: boolean;
}

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  const targetPath = options.path ? path.resolve(options.path) : getDefaultConfigPath();

  if (fs.existsSync(targetPath) && !options.force) {
    const msg = `Configuration file already exists at ${targetPath}. Use --force to overwrite.`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg, path: targetPath }));
      process.exitCode = 1;
      return;
    }
    throw new Error(msg);
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = getSampleConfigYaml();
  fs.writeFileSync(targetPath, content, 'utf-8');

  if (options.json) {
    console.log(JSON.stringify({ ok: true, path: targetPath, action: 'created' }, null, 2));
  } else {
    console.log(`[routersync] Initialized configuration file at: ${targetPath}`);
    console.log(`Edit this file or run \`routersync scan\` to verify your routers.`);
  }
}
