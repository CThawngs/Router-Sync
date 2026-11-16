/**
 * R15/R16-1: type declaration for `import.meta.env`.
 *
 * Without this declaration `import.meta.env` does not typecheck. More
 * important: the `vite:define` plugin of Vite only replaces the EXACT
 * `import.meta.env` expression. An optional-chained `import.meta` does not
 * match that pattern, so the variable `VITE_API` never reaches the bundle
 * and the UI falls back to `MockApi` even while the S1 daemon is running and
 * serving real numbers. That was the root cause of the R15 "sample data"
 * surprise during RUN-S1.
 *
 * `/// <reference types="vite/client" />` is deliberately NOT used: vite/client
 * declares `ImportMetaEnv` with `BASE_URL` not readonly, which makes
 * TypeScript complain that the modifiers do not match.
 */
interface ImportMetaEnv {
  readonly VITE_API?: string;
  readonly VITE_DAEMON_URL?: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
