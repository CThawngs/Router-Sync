/**
 * packages/cli/src/commands/freeze.ts
 *
 * Implements `routersync freeze` & `routersync unfreeze` (C45-WP4 §3.3.2, Phục vụ: S3, S4, S9).
 *  - `freeze`: immediate emergency circuit breaker (`<stateDir>/freeze.json`, zero TTY prompt).
 *  - `unfreeze`: rejects `--yes` and non-TTY callers; requires interactive `'unfreeze'` confirmation.
 */

import * as readline from 'node:readline';
import {
  activateFreeze,
  deactivateFreeze,
  resolveControlStateDir,
} from '@routersync/core';

export interface FreezeCommandOptions {
  reason?: string | undefined;
  stateDir?: string | undefined;
  json?: boolean | undefined;
}

export interface UnfreezeCommandOptions {
  stateDir?: string | undefined;
  yes?: boolean | undefined;
  json?: boolean | undefined;
  /** Programmatic test seam only — never exposed as CLI flag in index.ts */
  isTTY?: boolean | undefined;
  promptFn?: ((promptText: string) => Promise<string>) | undefined;
}

function askPrompt(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runFreezeCommand(options: FreezeCommandOptions = {}): Promise<void> {
  const sDir = resolveControlStateDir(options.stateDir);
  const state = activateFreeze(sDir, options.reason);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          frozen: true,
          frozenAt: state.frozenAt,
          reason: state.reason,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    `FREEZE active=yes frozenAt=${state.frozenAt ?? ''} reason=${state.reason ?? 'manual-emergency-freeze'}`
  );
}

export async function runUnfreezeCommand(options: UnfreezeCommandOptions = {}): Promise<void> {
  if (options.yes) {
    console.error('unfreeze does not allow --yes');
    console.error('UNFREEZE_REFUSED reason=yes-flag');
    process.exit(1);
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    console.error('unfreeze requires an interactive TTY');
    console.error('UNFREEZE_REFUSED reason=no-tty');
    process.exit(1);
  }

  const prompt = options.promptFn ?? askPrompt;
  const answer = (
    await prompt("Emergency freeze is active. Type 'unfreeze' to resume controlled writes: ")
  ).trim();

  if (answer !== 'unfreeze') {
    console.error(`Confirmation rejected (received '${answer}', expected 'unfreeze').`);
    console.error('UNFREEZE_REFUSED reason=confirmation-mismatch');
    process.exit(1);
  }

  const sDir = resolveControlStateDir(options.stateDir);
  const state = deactivateFreeze(sDir);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          frozen: false,
          unfrozenAt: state.unfrozenAt ?? null,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`FREEZE active=no unfrozenAt=${state.unfrozenAt ?? ''}`);
}
