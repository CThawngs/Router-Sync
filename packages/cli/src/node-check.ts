/**
 * packages/cli/src/node-check.ts
 *
 * Startup Node.js engine verification (Condition A7, AT-100).
 * Rejects Node < 22 with structured, friendly error before any execution.
 */

export function checkNodeVersion(versionString: string = process.version): {
  ok: boolean;
  major: number;
  minor: number;
  message?: string;
} {
  const cleanVersion = versionString.startsWith('v') ? versionString.slice(1) : versionString;
  const parts = cleanVersion.split('.');
  const major = parseInt(parts[0] ?? '0', 10);
  const minor = parseInt(parts[1] ?? '0', 10);

  if (major < 22 || (major === 22 && minor < 12)) {
    return {
      ok: false,
      major,
      minor,
      message:
        `[routersync] Unsupported Node.js version ${versionString}.\n` +
        `  RouterSync requires Node.js >= 22.12.0 (Condition A7 / AT-100 / commander@15 requirement).\n` +
        `  Please upgrade your Node.js runtime (e.g. using nvm or fnm).`,
    };
  }

  return { ok: true, major, minor };
}

export function enforceNodeVersion(versionString: string = process.version): void {
  const result = checkNodeVersion(versionString);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
}
