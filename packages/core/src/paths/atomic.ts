/**
 * packages/core/src/paths/atomic.ts
 *
 * Atomic file writing and formatting preservation (SPEC §32 / X3, X4).
 * Ensures files are written via temporary file + fsync + atomic rename with backoff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AtomicWriteOptions {
  maxRetries?: number;
  backoffMs?: number;
  mode?: number;
}

export function detectFormatting(content: string): { eol: '\r\n' | '\n'; hasBom: boolean } {
  const hasBom = content.startsWith('\uFEFF');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return { eol, hasBom };
}

export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const maxRetries = options.maxRetries ?? 5;
  const backoffMs = options.backoffMs ?? 20;
  const dir = path.dirname(path.resolve(targetPath));

  await fs.promises.mkdir(dir, { recursive: true });

  const tempName = `${path.basename(targetPath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(dir, tempName);

  // Write content and fsync
  const handle = await fs.promises.open(tempPath, 'w', options.mode ?? (process.platform === 'win32' ? 0o666 : 0o600));
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Atomic rename with exponential backoff on Windows EPERM/EBUSY/EACCES
  let attempt = 0;
  while (true) {
    try {
      await fs.promises.rename(tempPath, targetPath);
      return;
    } catch (err: unknown) {
      attempt++;
      const code = (err as { code?: string }).code;
      const isRetryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';

      if (isRetryable && attempt <= maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
        continue;
      }

      // Cleanup temp file on final failure to maintain integrity of target
      await fs.promises.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Synchronous atomic file write with fsync and exponential backoff on Windows.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): void {
  const maxRetries = options.maxRetries ?? 5;
  const backoffMs = options.backoffMs ?? 20;
  const dir = path.dirname(path.resolve(targetPath));

  fs.mkdirSync(dir, { recursive: true });

  const tempName = `${path.basename(targetPath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tempPath = path.join(dir, tempName);

  const fd = fs.openSync(tempPath, 'w', options.mode ?? (process.platform === 'win32' ? 0o666 : 0o600));
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  let attempt = 0;
  while (true) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err: unknown) {
      attempt++;
      const code = (err as { code?: string }).code;
      const isRetryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';

      if (isRetryable && attempt <= maxRetries) {
        const start = Date.now();
        const waitTime = backoffMs * Math.pow(2, attempt - 1);
        while (Date.now() - start < waitTime) {
          // Synchronous spin wait
        }
        continue;
      }

      try {
        fs.unlinkSync(tempPath);
      } catch {}
      throw err;
    }
  }
}

